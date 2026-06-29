/**
 * Hivekeep's internal tool definition helper + legacy message-shape types.
 *
 * The public surface (`tool`, `asSchema`, `Tool`, `JSONValue`) lives in
 * `@gezy/sdk` — this file simply re-exports from there so internal
 * imports (`from '@/server/tools/tool-helper'`) keep working without
 * touching the ~45 native tool files. Plugins should import directly
 * from `@gezy/sdk` instead.
 *
 * The `ModelMessage` / `UserContent` types and their part definitions
 * are NOT exported from the SDK — they're internal to Hivekeep, used only
 * by `agent-engine.buildMessageHistory`'s mask + size-cap pipeline while it
 * is being progressively migrated to `HivekeepMessage`. They live here so
 * the rest of the codebase can keep its current import path.
 */
export { tool, asSchema } from '@gezy/sdk'
export type { Tool, JSONValue, NormalizedSchema } from '@gezy/sdk'

// ─── Message shapes (legacy parity, used by buildMessageHistory) ─────────────

/**
 * Discriminated union mirroring the Vercel `ModelMessage` shape Hivekeep used
 * to consume. Kept here only because `agent-engine.buildMessageHistory` and
 * its tributaries (`maskOldToolResults`, the SIZE/ARGS/CONTENT/USER caps)
 * still operate on this shape. When that pipeline is migrated to
 * `HivekeepMessage`, this type and the parts below can be deleted.
 */
export type ModelMessage =
  | { role: 'system'; content: string; providerOptions?: ProviderOptions }
  | { role: 'user'; content: UserContent; providerOptions?: ProviderOptions }
  | { role: 'assistant'; content: AssistantContent; providerOptions?: ProviderOptions }
  | { role: 'tool'; content: ToolResultPart[]; providerOptions?: ProviderOptions }

/** Free-form provider hints (Anthropic `cacheControl`, OpenAI `reasoningEffort`, …). */
export type ProviderOptions = Record<string, Record<string, unknown>>

export type UserContent = string | Array<TextPart | ImagePart | FilePart>
export type AssistantContent = string | Array<TextPart | ReasoningPart | ToolCallPart>

export interface TextPart {
  type: 'text'
  text: string
  providerOptions?: ProviderOptions
}

export interface ImagePart {
  type: 'image'
  /** Raw bytes, base64 string, or data URL. */
  image: Uint8Array | string
  mediaType?: string
  mimeType?: string
}

export interface FilePart {
  type: 'file'
  data: Uint8Array | string
  filename?: string
  mediaType: string
}

export interface ReasoningPart {
  type: 'reasoning'
  text: string
  signature?: string
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

import type { JSONValue } from '@gezy/sdk'

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName?: string
  output:
    | { type: 'json'; value: JSONValue }
    | { type: 'text'; value: string }
}
