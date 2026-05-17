/**
 * Conversion helpers between the Vercel AI SDK shapes still used at the
 * boundary of kin-engine (tool definitions, message history) and the kinbot
 * `LLMProvider` abstraction.
 *
 * These helpers exist because:
 *   - Tool definitions (`tool({...})` from 'ai') live in ~37 files across
 *     `src/server/tools/*` and migrating them all to a kinbot-native shape
 *     would be a separate, much larger refactor.
 *   - Message history in kin-engine / tasks is accumulated as `ModelMessage[]`
 *     (the Vercel shape) because that's how the chat persistence + history
 *     reconstruction code reads/writes it. Same logic — migrate later.
 *
 * For now: at the very last moment before calling `provider.chat()`, we
 * convert Vercel tools/messages into kinbot's own shapes. Both translations
 * are pure data — no behavior is moved here.
 */

import type { ModelMessage } from 'ai'
import type { Tool } from '@ai-sdk/provider-utils'
import type {
  KinbotMessage,
  KinbotMessageBlock,
  KinbotTool,
} from '@/server/llm/llm/types'

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Convert a Vercel `Record<string, Tool>` into the kinbot tool shape.
 * The `inputSchema` field of a Vercel `Tool` is a `Schema` wrapper around a
 * JSON Schema (or a zod schema converted to JSON Schema by the SDK on
 * registration). Either way it exposes a `.jsonSchema` property that we
 * lift straight into `KinbotTool.inputSchema`.
 */
export function vercelToolsToKinbot(tools: Record<string, Tool>): KinbotTool[] {
  const out: KinbotTool[] = []
  for (const [name, tool] of Object.entries(tools)) {
    const description = (tool as { description?: string }).description ?? ''
    const schema = (tool as { inputSchema?: unknown }).inputSchema
    const json = extractJsonSchema(schema)
    out.push({ name, description, inputSchema: json })
  }
  return out
}

/**
 * A Vercel `Schema` is `{ _type: 'schema'; jsonSchema: JSONSchema7; validate?: ... }`.
 * Older versions exposed it as `{ jsonSchema, validate }`. Some tools may
 * pass a raw JSON Schema object directly. Handle all three shapes.
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }
  const s = schema as { jsonSchema?: unknown }
  if (s.jsonSchema && typeof s.jsonSchema === 'object') {
    return s.jsonSchema as Record<string, unknown>
  }
  return schema as Record<string, unknown>
}

// ─── Messages ────────────────────────────────────────────────────────────────

/**
 * Convert a Vercel `ModelMessage[]` history into kinbot `KinbotMessage[]`.
 *
 * The Vercel shape:
 *   - `{ role: 'user', content: string | Array<TextPart|ImagePart|FilePart|ToolResultPart> }`
 *   - `{ role: 'assistant', content: string | Array<TextPart|ReasoningPart|ToolCallPart> }`
 *   - `{ role: 'tool', content: Array<ToolResultPart> }`  ← OpenAI-style tool messages
 *   - `{ role: 'system', content: string }`  ← rare in history, usually in system param
 *
 * kinbot collapses `role: 'tool'` messages into `role: 'user'` messages whose
 * content is a list of `tool-result` blocks (Anthropic-style). Providers that
 * need OpenAI-style separate tool messages (openai-key) re-split internally.
 *
 * `providerOptions.anthropic.cacheControl` on a message is lifted to the
 * `cacheControl` of its first/last text block (where it lands on Anthropic's
 * wire anyway).
 */
export function modelMessagesToKinbot(messages: ModelMessage[]): KinbotMessage[] {
  const out: KinbotMessage[] = []
  for (const m of messages) {
    const role = m.role
    if (role === 'system') {
      // System messages in the history (rare — usually live in `system` param).
      // Skip rather than guess where they should go.
      continue
    }
    if (role === 'user') {
      out.push({ role: 'user', content: userContentToBlocks(m.content, hasMessageCacheHint(m)) })
      continue
    }
    if (role === 'assistant') {
      out.push({ role: 'assistant', content: assistantContentToBlocks(m.content, hasMessageCacheHint(m)) })
      continue
    }
    if (role === 'tool') {
      // OpenAI-style tool message → kinbot user message of tool-result blocks.
      const blocks: KinbotMessageBlock[] = []
      const content = m.content
      if (Array.isArray(content)) {
        for (const p of content) {
          const part = p as { type?: string; toolCallId?: string; toolName?: string; output?: unknown; result?: unknown }
          if (part?.type === 'tool-result') {
            blocks.push({
              type: 'tool-result',
              toolUseId: part.toolCallId ?? '',
              content: stringifyToolResult(part.output ?? part.result),
            })
          }
        }
      }
      if (blocks.length > 0) out.push({ role: 'user', content: blocks })
      continue
    }
  }
  return out
}

function hasMessageCacheHint(m: ModelMessage): boolean {
  const opts = (m as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions
  return !!opts?.anthropic?.cacheControl
}

function stringifyToolResult(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  // OpenAI tool result outputs are sometimes wrapped: { type: 'json', value: ... } or
  // { type: 'text', value: '...' }. Unwrap when recognized, else JSON-stringify.
  if (typeof output === 'object') {
    const o = output as { type?: string; value?: unknown; text?: string }
    if (o.type === 'text' && typeof o.value === 'string') return o.value
    if (o.type === 'text' && typeof o.text === 'string') return o.text
    if (o.type === 'json') return JSON.stringify(o.value)
  }
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

function userContentToBlocks(content: unknown, applyCacheHintToLast: boolean): KinbotMessageBlock[] {
  if (typeof content === 'string') {
    const blocks: KinbotMessageBlock[] = content ? [{ type: 'text', text: content }] : []
    if (applyCacheHintToLast && blocks.length > 0) {
      const last = blocks[blocks.length - 1]!
      if (last.type === 'text') (last as { cacheControl?: { type: 'ephemeral' } }).cacheControl = { type: 'ephemeral' }
    }
    return blocks
  }
  if (!Array.isArray(content)) return []
  const blocks: KinbotMessageBlock[] = []
  for (const p of content) {
    const part = p as { type?: string; text?: string; image?: unknown; data?: unknown; mediaType?: string; mimeType?: string; toolCallId?: string; output?: unknown; result?: unknown }
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
    } else if (part?.type === 'image') {
      const data = coerceImageBytes(part.image ?? part.data)
      if (data) {
        blocks.push({ type: 'image', data, mediaType: part.mediaType ?? part.mimeType ?? 'image/png' })
      }
    } else if (part?.type === 'tool-result') {
      blocks.push({
        type: 'tool-result',
        toolUseId: part.toolCallId ?? '',
        content: stringifyToolResult(part.output ?? part.result),
      })
    }
  }
  if (applyCacheHintToLast && blocks.length > 0) {
    const last = blocks[blocks.length - 1]!
    if (last.type === 'text') (last as { cacheControl?: { type: 'ephemeral' } }).cacheControl = { type: 'ephemeral' }
  }
  return blocks
}

function assistantContentToBlocks(content: unknown, applyCacheHintToLast: boolean): KinbotMessageBlock[] {
  if (typeof content === 'string') {
    const blocks: KinbotMessageBlock[] = content ? [{ type: 'text', text: content }] : []
    if (applyCacheHintToLast && blocks.length > 0) {
      const last = blocks[blocks.length - 1]!
      if (last.type === 'text') (last as { cacheControl?: { type: 'ephemeral' } }).cacheControl = { type: 'ephemeral' }
    }
    return blocks
  }
  if (!Array.isArray(content)) return []
  const blocks: KinbotMessageBlock[] = []
  for (const p of content) {
    const part = p as {
      type?: string
      text?: string
      toolCallId?: string
      toolName?: string
      input?: unknown
      signature?: string
    }
    if (part?.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
    } else if (part?.type === 'reasoning' && typeof part.text === 'string') {
      blocks.push({ type: 'thinking', text: part.text, signature: part.signature })
    } else if (part?.type === 'tool-call' && part.toolCallId && part.toolName) {
      blocks.push({ type: 'tool-use', id: part.toolCallId, name: part.toolName, args: part.input })
    }
  }
  if (applyCacheHintToLast && blocks.length > 0) {
    const last = blocks[blocks.length - 1]!
    if (last.type === 'text') (last as { cacheControl?: { type: 'ephemeral' } }).cacheControl = { type: 'ephemeral' }
  }
  return blocks
}

function coerceImageBytes(value: unknown): Uint8Array | null {
  if (!value) return null
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === 'string') {
    // Data URL or raw base64
    const base64 = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value
    try {
      const binary = globalThis.atob(base64)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
      return out
    } catch {
      return null
    }
  }
  return null
}
