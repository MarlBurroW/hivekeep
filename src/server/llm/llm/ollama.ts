/**
 * Ollama Cloud LLM provider.
 *
 * Ollama documents direct cloud API access at https://ollama.com/api with
 * bearer-token authentication. This adapter intentionally uses the native
 * `/api/tags` and `/api/chat` endpoints (not a custom endpoint setup) so the
 * admin only needs an Ollama API key. A base URL override is available for
 * testing or future compatible deployments, but defaults to Ollama Cloud.
 */

import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
  Usage,
  FinishReason,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  ContextOverflowError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  HivekeepProviderError,
} from '@/server/llm/core/types'
import type {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  ThinkingEffort,
} from '@/server/llm/llm/types'
import { downgradeEffort } from '@/server/llm/llm/types'

const DEFAULT_BASE_URL = 'https://ollama.com/api'

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    description: 'Ollama API key for direct access to ollama.com. Create one at https://ollama.com/settings/keys',
  },
  {
    key: 'baseUrl',
    type: 'url',
    label: 'Base URL',
    required: false,
    default: DEFAULT_BASE_URL,
    placeholder: DEFAULT_BASE_URL,
    description: 'Optional override. Defaults to Ollama Cloud at https://ollama.com/api.',
  },
]

/** @internal exported for tests. */
export interface OllamaTagModel {
  name?: string
  model?: string
  details?: { parameter_size?: string }
}

interface OllamaChatChunk {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown; args?: unknown } }>
  }
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

function getBaseUrl(config: ProviderConfig): string {
  return (config['baseUrl']?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']?.trim()
  if (!apiKey) throw new AuthError('Missing Ollama Cloud API key')
  return apiKey
}

function authHeaders(config: ProviderConfig): Record<string, string> {
  return { Authorization: `Bearer ${getApiKey(config)}` }
}

function mapHttpError(status: number, message: string, cause?: unknown): HivekeepProviderError {
  if (status === 401 || status === 403) return new AuthError(message, cause)
  if (status === 429) return new RateLimitError(message, undefined, cause)
  if (status === 400 && /context|too long/i.test(message)) return new ContextOverflowError(message, undefined, undefined, cause)
  if (status >= 400 && status < 500) return new InvalidRequestError(message, cause)
  if (status >= 500) return new ProviderServerError(message, status, cause)
  return new ProviderServerError(message, status, cause)
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `Ollama Cloud returned HTTP ${res.status}`
  try {
    const json = JSON.parse(text) as { error?: string | { message?: string } }
    return typeof json.error === 'string' ? json.error : json.error?.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

/** @internal exported for tests. */
export function mapModel(model: OllamaTagModel): LLMModel | null {
  const id = model.model ?? model.name
  if (!id) return null
  const out: LLMModel = {
    id,
    name: id,
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  // Ollama's native `/api/tags` response does not expose a reliable context
  // window or modality descriptor. Registry enrichment can fill known ids.
  return out
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

function systemPrompt(system: ChatRequest['system']): string | undefined {
  const text = system?.map((b) => b.text).filter(Boolean).join('\n\n')
  return text || undefined
}

function userMessage(blocks: HivekeepMessage['content']): Record<string, unknown> | null {
  let content = ''
  const images: string[] = []
  for (const b of blocks) {
    if (b.type === 'text') content += b.text
    if (b.type === 'image') images.push(uint8ToBase64(b.data))
  }
  if (!content && images.length === 0) return null
  return { role: 'user', content, ...(images.length ? { images } : {}) }
}

function assistantMessage(blocks: HivekeepMessage['content']): Record<string, unknown> {
  let content = ''
  const toolCalls: unknown[] = []
  for (const b of blocks) {
    if (b.type === 'text') content += b.text
    if (b.type === 'tool-use') toolCalls.push({ function: { name: b.name, arguments: b.args } })
  }
  return { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
}

function messagesToOllama(messages: HivekeepMessage[], system?: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push(assistantMessage(m.content))
      continue
    }
    const user = userMessage(m.content)
    if (user) out.push(user)
    for (const b of m.content) {
      if (b.type === 'tool-result') out.push({ role: 'tool', content: b.content, tool_name: b.toolUseId })
    }
  }
  return out
}

function toolsToOllama(tools: ChatRequest['tools']): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

function finishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop': return 'stop'
    case 'length': return 'length'
    default: return 'unknown'
  }
}

function parseJsonLines(buffer: string): { values: OllamaChatChunk[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const values: OllamaChatChunk[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    values.push(JSON.parse(trimmed) as OllamaChatChunk)
  }
  return { values, rest }
}

async function* streamChat(url: string, body: Record<string, unknown>, config: ProviderConfig, signal?: AbortSignal): AsyncIterable<ChatChunk> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw mapApiError(err)
  }
  if (!res.ok) throw mapHttpError(res.status, await errorText(res))
  if (!res.body) throw new ProviderServerError('Ollama Cloud returned no response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage: Usage = {}
  let doneReason: string | undefined

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseJsonLines(buffer)
      buffer = parsed.rest
      for (const chunk of parsed.values) {
        if (chunk.message?.thinking) yield { type: 'thinking-delta', text: chunk.message.thinking }
        if (chunk.message?.content) yield { type: 'text-delta', text: chunk.message.content }
        for (const tc of chunk.message?.tool_calls ?? []) {
          const fn = tc.function
          if (!fn?.name) continue
          yield { type: 'tool-use', id: fn.name, name: fn.name, args: fn.arguments ?? fn.args ?? {} }
        }
        if (chunk.done) {
          doneReason = chunk.done_reason
          usage = { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count }
        }
      }
    }
  } catch (err) {
    throw mapApiError(err)
  }

  if (buffer.trim()) {
    const chunk = JSON.parse(buffer) as OllamaChatChunk
    if (chunk.message?.content) yield { type: 'text-delta', text: chunk.message.content }
    if (chunk.done) usage = { inputTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count }
  }
  yield { type: 'finish', reason: finishReason(doneReason), usage }
}

export const ollamaProvider: LLMProvider = {
  type: 'ollama',
  displayName: 'Ollama Cloud',
  configSchema: CONFIG_SCHEMA,
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const res = await fetch(`${getBaseUrl(config)}/tags`, { headers: authHeaders(config) })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid Ollama Cloud API key' }
      return { valid: false, error: `Ollama Cloud returned HTTP ${res.status}` }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    try {
      const res = await fetch(`${getBaseUrl(config)}/tags`, { headers: authHeaders(config) })
      if (!res.ok) throw mapHttpError(res.status, await errorText(res))
      const payload = (await res.json()) as { models?: OllamaTagModel[] }
      return (payload.models ?? []).map(mapModel).filter((m): m is LLMModel => Boolean(m))
    } catch (err) {
      throw mapApiError(err)
    }
  },

  chat(model, request, config) {
    const body: Record<string, unknown> = {
      model: model.id,
      messages: messagesToOllama(request.messages, systemPrompt(request.system)),
      stream: true,
    }
    const tools = toolsToOllama(request.tools)
    if (tools) body['tools'] = tools
    const options: Record<string, unknown> = {}
    if (request.maxOutputTokens != null) options['num_predict'] = request.maxOutputTokens
    if (request.temperature != null) options['temperature'] = request.temperature
    if (Object.keys(options).length) body['options'] = options
    if (request.thinkingEffort && model.thinking?.efforts?.length) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts) as ThinkingEffort | undefined
      if (chosen) body['think'] = chosen === 'minimal' ? false : chosen
    }
    return streamChat(`${getBaseUrl(config)}/chat`, body, config, request.signal)
  },
}
