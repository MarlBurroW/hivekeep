/**
 * Cheaper Inference LLM provider.
 *
 * Cheaper Inference is an OpenAI-compatible LLM gateway at:
 *   https://api.cheaperinference.com/v1
 * Chat goes to `/chat/completions` there. `/v1/models` needs a valid key, so
 * the setup check uses it. The model list with metadata (type, context window,
 * max output, vision, tools, caching, prices) comes from the public catalog at
 * `https://api.cheaperinference.com/public/models`.
 *
 * This adapter registers the LLM capability only, the same as the Kilo
 * Gateway adapter.
 */

import OpenAI, { APIError } from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionUserMessageParam,
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
} from '@/server/llm/llm/types'
import { parseToolArguments } from '@/server/llm/core/parse-tool-args'

const API_BASE_URL = 'https://api.cheaperinference.com/v1'
const CATALOG_URL = 'https://api.cheaperinference.com/public/models'

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'ci_live_…',
    description: 'Cheaper Inference API key. Create one from your Cheaper Inference dashboard.',
  },
]

/** @internal exported for tests. One entry of the public `/public/models` catalog. */
export interface CheaperInferenceModel {
  id: string
  model_type?: string | null
  supported_endpoints?: string[] | null
  supports_streaming?: boolean | null
  supports_vision?: boolean | null
  is_visible?: boolean | null
  context_length?: number | null
  max_output_tokens?: number | null
  features?: string[] | null
  input_per_million?: string | null
  output_per_million?: string | null
  cache_read_per_million?: string | null
  cache_write_per_million?: string | null
}

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']?.trim()
  if (!apiKey) throw new AuthError('Missing Cheaper Inference API key')
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
    baseURL: API_BASE_URL,
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

function hasFeature(model: CheaperInferenceModel, feature: string): boolean {
  return (model.features ?? []).includes(feature)
}

function isStreamingChatModel(model: CheaperInferenceModel): boolean {
  if (model.model_type != null && model.model_type !== 'text') return false
  if (model.supported_endpoints && !model.supported_endpoints.includes('/v1/chat/completions')) return false
  if (model.supports_streaming === false) return false
  if (model.is_visible === false) return false
  return true
}

function inferMaxTools(model: CheaperInferenceModel): number | undefined {
  if (model.features && !model.features.includes('tool-use')) return 0
  return undefined
}

function convertPricing(model: CheaperInferenceModel): LLMModel['pricing'] | undefined {
  const perMillion = (raw: string | null | undefined): number | undefined => {
    if (raw == null || raw === '') return undefined
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return undefined
    return n
  }
  const input = perMillion(model.input_per_million)
  const output = perMillion(model.output_per_million)
  if (input == null && output == null) return undefined
  const pricing: NonNullable<LLMModel['pricing']> = { input: input ?? 0, output: output ?? 0 }
  const cacheRead = perMillion(model.cache_read_per_million)
  if (cacheRead != null) pricing.cacheRead = cacheRead
  const cacheWrite = perMillion(model.cache_write_per_million)
  if (cacheWrite != null) pricing.cacheWrite = cacheWrite
  return pricing
}

/** @internal exported for tests. */
export function mapModel(model: CheaperInferenceModel): LLMModel | null {
  if (!model.id) return null
  if (!isStreamingChatModel(model)) return null

  const out: LLMModel = {
    id: model.id,
    name: model.id,
  }
  if (model.context_length != null) out.contextWindow = model.context_length
  if (model.max_output_tokens != null) out.maxOutput = model.max_output_tokens
  if (model.supports_vision || hasFeature(model, 'image-input')) out.supportsImageInput = true
  if (hasFeature(model, 'implicit-caching') || hasFeature(model, 'explicit-caching')) {
    out.supportsPromptCaching = true
  }
  const maxTools = inferMaxTools(model)
  if (maxTools != null) out.maxTools = maxTools
  else out.supportsParallelTools = true
  // `thinking` is left undefined on purpose: the catalog says which models
  // reason, not which accept a `reasoning_effort` parameter.
  const pricing = convertPricing(model)
  if (pricing) out.pricing = pricing
  return out
}

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
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

  for (const [idx, state] of toolsByIndex) {
    if (!state.name) continue
    yield {
      type: 'tool-use',
      id: state.id || `call_${idx}`,
      name: state.name,
      args: parseToolArguments(state.args),
    }
  }
  yield { type: 'finish', reason: mapFinishReason(finishReason), usage }
}

export const cheaperInferenceProvider: LLMProvider = {
  type: 'cheaperinference',
  displayName: 'Cheaper Inference',
  configSchema: CONFIG_SCHEMA,
  defaultMaxTools: 128,
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      // GET /v1/models needs a valid key on Cheaper Inference (no key or a bad
      // key gets 401), so it validates credentials without spending tokens.
      const res = await fetch(`${API_BASE_URL}/models`, { headers: authHeaders(apiKey) })
      if (res.status === 401 || res.status === 403) {
        const snippet = await responseSnippet(res)
        return { valid: false, error: withHttpSnippet('Invalid Cheaper Inference API key', res.status, snippet) }
      }
      if (!res.ok) {
        const snippet = await responseSnippet(res)
        return { valid: false, error: withHttpSnippet('Cheaper Inference /models returned an unexpected response', res.status, snippet) }
      }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(_config: ProviderConfig): Promise<LLMModel[]> {
    let payload: { models?: CheaperInferenceModel[] }
    try {
      const res = await fetch(CATALOG_URL)
      if (!res.ok) {
        const snippet = await responseSnippet(res)
        throw new ProviderServerError(withHttpSnippet('Cheaper Inference /public/models returned an unexpected response', res.status, snippet), res.status)
      }
      payload = (await res.json()) as { models?: CheaperInferenceModel[] }
    } catch (err) {
      throw mapApiError(err)
    }

    const models: LLMModel[] = []
    for (const raw of payload.models ?? []) {
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
    if (request.metadata?.userId) params.user = request.metadata.userId
    return streamChat(client, params, request.signal)
  },
}
