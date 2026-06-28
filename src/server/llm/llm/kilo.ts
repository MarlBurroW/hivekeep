/**
 * Kilo AI Gateway LLM provider.
 *
 * Kilo documents a unified OpenAI-compatible chat gateway at:
 *   https://api.kilo.ai/api/gateway
 * with `/chat/completions` and `/models` endpoints. The public docs do not
 * currently document embeddings, image generation, TTS, or STT endpoints, so
 * this adapter honestly registers the LLM capability only.
 */

import OpenAI, { APIError } from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionContentPart,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions'
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

const DEFAULT_BASE_URL = 'https://api.kilo.ai/api/gateway'

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'kilo_…',
    description: 'Kilo Gateway API key. Create one from your Kilo account dashboard.',
  },
  {
    key: 'baseUrl',
    type: 'url',
    label: 'Base URL',
    required: false,
    default: DEFAULT_BASE_URL,
    placeholder: DEFAULT_BASE_URL,
    description: 'Optional override for Kilo Gateway-compatible deployments. Defaults to https://api.kilo.ai/api/gateway.',
  },
]

/** @internal exported for tests. */
export interface KiloModel {
  id: string
  name?: string
  context_length?: number | null
  supported_parameters?: string[]
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  input_modalities?: string[]
  output_modalities?: string[]
  top_provider?: {
    context_length?: number | null
    max_completion_tokens?: number | null
  }
  features?: string[]
  capabilities?: string[]
  reasoning?: {
    mandatory?: boolean
    default_enabled?: boolean
    supported_efforts?: string[]
    default_effort?: string
  }
  pricing?: {
    prompt?: string
    completion?: string
    input_cache_read?: string
    input_cache_write?: string
  }
}

function getBaseUrl(config: ProviderConfig): string {
  const raw = config['baseUrl']?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']?.trim()
  if (!apiKey) throw new AuthError('Missing Kilo Gateway API key')
  return apiKey
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

function truncateForError(raw: string, max = 500): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}…`
}

async function responseSnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text()
    if (!text) return undefined
    return truncateForError(text)
  } catch {
    return undefined
  }
}

function withHttpSnippet(prefix: string, status: number, snippet: string | undefined): string {
  return snippet ? `${prefix} (HTTP ${status}): ${snippet}` : `${prefix} (HTTP ${status})`
}

function createClient(config: ProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: getApiKey(config),
    baseURL: getBaseUrl(config),
  })
}

function mapFinishReason(reason: ChatCompletionChunk.Choice['finish_reason']): FinishReason {
  switch (reason) {
    case 'stop': return 'stop'
    case 'length': return 'length'
    case 'tool_calls':
    case 'function_call': return 'tool-calls'
    case 'content_filter': return 'content-filter'
    case null: return 'unknown'
    default: return 'unknown'
  }
}

function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined
  const value = Array.isArray(header) ? header[0] : header
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) return new RateLimitError(message, parseRetryAfter(err.headers?.['retry-after']), err)
    if (status === 400 && /context.length|context window|maximum context|too long/i.test(message)) {
      return new ContextOverflowError(message, undefined, undefined, err)
    }
    if (status && status >= 400 && status < 500) return new InvalidRequestError(message, err)
    if (status && status >= 500) return new ProviderServerError(message, status, err)
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

function modalities(model: KiloModel, key: 'input_modalities' | 'output_modalities'): string[] {
  const direct = model[key]
  const arch = model.architecture?.[key]
  return [...(direct ?? []), ...(arch ?? [])]
}

function hasFeature(model: KiloModel, feature: string): boolean {
  return [
    ...(model.features ?? []),
    ...(model.capabilities ?? []),
    ...(model.supported_parameters ?? []),
  ].some((f) => f.toLowerCase() === feature)
}

function isTextOutputModel(model: KiloModel): boolean {
  const out = modalities(model, 'output_modalities')
  if (out.length === 0) return true
  return out.includes('text')
}

function inferImageInput(model: KiloModel): boolean {
  const input = modalities(model, 'input_modalities')
  return input.includes('image') || hasFeature(model, 'vision')
}

function inferPdfInput(model: KiloModel): boolean {
  const input = modalities(model, 'input_modalities')
  return input.includes('pdf') || input.includes('file')
}

function inferThinking(model: KiloModel): LLMModel['thinking'] | undefined {
  const documented = model.reasoning?.supported_efforts
    ?.filter((e): e is ThinkingEffort =>
      e === 'minimal' || e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max',
    )
  if (documented?.length) return { efforts: documented }
  if (!hasFeature(model, 'reasoning') && !hasFeature(model, 'reasoning_effort')) return undefined
  return { efforts: ['low', 'medium', 'high'] }
}

function inferMaxTools(model: KiloModel): number | undefined {
  if (model.supported_parameters && !model.supported_parameters.includes('tools')) return 0
  return undefined
}

function convertPricing(model: KiloModel): LLMModel['pricing'] | undefined {
  const p = model.pricing
  if (!p) return undefined
  const perMillion = (raw: string | undefined): number | undefined => {
    if (raw == null || raw === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return undefined
    return n * 1_000_000
  }
  const input = perMillion(p.prompt)
  const output = perMillion(p.completion)
  if (input == null && output == null) return undefined
  const pricing: NonNullable<LLMModel['pricing']> = { input: input ?? 0, output: output ?? 0 }
  const cacheRead = perMillion(p.input_cache_read)
  if (cacheRead != null) pricing.cacheRead = cacheRead
  const cacheWrite = perMillion(p.input_cache_write)
  if (cacheWrite != null) pricing.cacheWrite = cacheWrite
  return pricing
}

/** @internal exported for tests. */
export function mapModel(model: KiloModel): LLMModel | null {
  if (!model.id) return null
  if (!isTextOutputModel(model)) return null

  const out: LLMModel = {
    id: model.id,
    name: model.name ?? model.id,
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  const contextWindow = model.context_length ?? model.top_provider?.context_length ?? undefined
  if (contextWindow != null) out.contextWindow = contextWindow
  const maxOutput = model.top_provider?.max_completion_tokens ?? undefined
  if (maxOutput != null) out.maxOutput = maxOutput
  if (inferImageInput(model)) out.supportsImageInput = true
  if (inferPdfInput(model)) out.supportsPdfInput = true
  const thinking = inferThinking(model)
  if (thinking) out.thinking = thinking
  const maxTools = inferMaxTools(model)
  if (maxTools != null) out.maxTools = maxTools
  const pricing = convertPricing(model)
  if (pricing) out.pricing = pricing
  return out
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

function systemPromptToMessage(system: ChatRequest['system']): ChatCompletionSystemMessageParam | undefined {
  if (!system || system.length === 0) return undefined
  const text = system.map((b) => b.text).join('\n\n')
  if (!text) return undefined
  return { role: 'system', content: text }
}

function userBlocksToContent(blocks: HivekeepMessage['content']): ChatCompletionUserMessageParam['content'] | null {
  const parts: ChatCompletionContentPart[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push({ type: 'text', text: b.text })
    } else if (b.type === 'image') {
      parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${uint8ToBase64(b.data)}` } })
    }
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0]!.type === 'text') return parts[0]!.text
  return parts
}

function assistantMessage(blocks: HivekeepMessage['content']): ChatCompletionAssistantMessageParam {
  let text = ''
  const toolCalls: ChatCompletionMessageToolCall[] = []
  for (const b of blocks) {
    if (b.type === 'text') {
      text += b.text
    } else if (b.type === 'tool-use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args),
        },
      })
    }
  }
  const msg: ChatCompletionAssistantMessageParam = { role: 'assistant' }
  if (text) msg.content = text
  if (toolCalls.length > 0) msg.tool_calls = toolCalls
  return msg
}

function messagesToOpenAI(messages: HivekeepMessage[], system: ChatCompletionSystemMessageParam | undefined): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  if (system) out.push(system)
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push(assistantMessage(m.content))
      continue
    }
    const userContent = userBlocksToContent(m.content)
    if (userContent !== null) out.push({ role: 'user', content: userContent })
    for (const b of m.content) {
      if (b.type === 'tool-result') {
        out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content })
      }
    }
  }
  return out
}

function toolsToOpenAI(tools: ChatRequest['tools']): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }))
}

interface ToolCallState { id: string; name: string; args: string }

async function* streamChat(client: OpenAI, params: ChatCompletionCreateParamsStreaming, signal: AbortSignal | undefined): AsyncIterable<ChatChunk> {
  let stream
  try {
    stream = await client.chat.completions.create(params, { signal })
  } catch (err) {
    throw mapApiError(err)
  }

  const toolsByIndex = new Map<number, ToolCallState>()
  let finishReason: ChatCompletionChunk.Choice['finish_reason'] = null
  let usage: Usage = {}

  try {
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
        }
      }
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta as (ChatCompletionChunk.Choice['delta'] & { reasoning?: string | null; reasoning_content?: string | null }) | undefined
      const reasoning = delta?.reasoning ?? delta?.reasoning_content
      if (reasoning) yield { type: 'thinking-delta', text: reasoning }
      if (delta?.content) yield { type: 'text-delta', text: delta.content }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          let state = toolsByIndex.get(idx)
          if (!state) {
            state = { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }
            toolsByIndex.set(idx, state)
          }
          if (tc.id) state.id = tc.id
          if (tc.function?.name) state.name = tc.function.name
          if (tc.function?.arguments) state.args += tc.function.arguments
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  } catch (err) {
    throw mapApiError(err)
  }

  for (const state of toolsByIndex.values()) {
    if (!state.id || !state.name) continue
    let args: unknown = {}
    if (state.args.length > 0) {
      try { args = JSON.parse(state.args) } catch { args = { _raw: state.args } }
    }
    yield { type: 'tool-use', id: state.id, name: state.name, args }
  }
  yield { type: 'finish', reason: mapFinishReason(finishReason), usage }
}

export const kiloProvider: LLMProvider = {
  type: 'kilo',
  displayName: 'Kilo Gateway',
  configSchema: CONFIG_SCHEMA,
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // Kilo documents GET /models as the canonical model catalogue endpoint
      // and explicitly says it requires no authentication. Use it as the
      // lowest-cost setup probe: if Kilo ever rejects the bearer token here,
      // surface that as invalid credentials; otherwise accept the key format
      // without spending tokens on an arbitrary paid chat model. A chat probe
      // tied to one model ID is brittle because Kilo's catalogue changes and
      // anonymous/free-model behavior means auth cannot be reliably
      // distinguished without a real generation request.
      const res = await fetch(`${getBaseUrl(config)}/models`, {
        headers: authHeaders(apiKey),
      })
      if (res.ok) return { valid: true }
      const snippet = await responseSnippet(res)
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: withHttpSnippet('Invalid Kilo Gateway API key', res.status, snippet) }
      }
      return { valid: false, error: withHttpSnippet('Kilo Gateway /models returned an unexpected response', res.status, snippet) }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const baseUrl = getBaseUrl(config)
    const apiKey = getApiKey(config)
    let payload: { data?: KiloModel[] }
    try {
      const res = await fetch(`${baseUrl}/models`, { headers: authHeaders(apiKey) })
      if (!res.ok) {
        const snippet = await responseSnippet(res)
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(withHttpSnippet('Kilo Gateway rejected the API key', res.status, snippet))
        }
        throw new ProviderServerError(withHttpSnippet('Kilo Gateway /models returned an unexpected response', res.status, snippet), res.status)
      }
      payload = (await res.json()) as { data?: KiloModel[] }
    } catch (err) {
      throw mapApiError(err)
    }

    const models: LLMModel[] = []
    for (const raw of payload.data ?? []) {
      const mapped = mapModel(raw)
      if (mapped) models.push(mapped)
    }
    return models
  },

  chat(model, request, config) {
    const client = createClient(config)
    const params: ChatCompletionCreateParamsStreaming = {
      model: model.id,
      messages: messagesToOpenAI(request.messages, systemPromptToMessage(request.system)),
      stream: true,
      stream_options: { include_usage: true },
    }
    const tools = toolsToOpenAI(request.tools)
    if (tools) params.tools = tools
    if (request.maxOutputTokens != null) params.max_tokens = request.maxOutputTokens
    if (request.temperature != null) params.temperature = request.temperature
    if (request.thinkingEffort && model.thinking?.efforts?.length) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts)
      if (chosen) {
        const effort = chosen === 'max' ? 'high' : chosen
        ;(params as unknown as Record<string, unknown>)['reasoning'] = { effort }
      }
    }
    if (request.metadata?.userId) params.user = request.metadata.userId
    return streamChat(client, params, request.signal)
  },
}
