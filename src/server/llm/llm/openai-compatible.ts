/**
 * Generic OpenAI-compatible LLM provider — a BYO-endpoint connector.
 *
 * Unlike the branded OpenAI-compatible providers (`deepseek`, `openrouter`,
 * `xai`, …) which hardcode a vendor `BASE_URL`, this one takes the base URL
 * from the user's config. It targets the long tail of gateways and local
 * servers that expose an OpenAI-style `/chat/completions` + `/models`
 * (and, when the endpoint implements it, `/images/generations` via the
 * image companion): NewAPI, LiteLLM, llama.cpp (`llama-server`),
 * LM Studio, vLLM, Ollama's OpenAI shim, and similar.
 *
 * We reuse the official `openai` SDK with a `baseURL` override for the chat
 * stream (message conversion, streaming tool calls, error mapping, usage all
 * behave like OpenAI), and a direct fetch for `GET /models` to discover ids.
 *
 * Design choices for a *generic* connector (vs the branded clones):
 *  - No vendor quirks. We do NOT force DeepSeek's `reasoning_content` replay
 *    (vanilla servers 400 on it) — `assistantMessage` is plain.
 *  - Vision passthrough. Image blocks are sent as `image_url` (the OpenAI
 *    multimodal shape); a text-only model upstream will reject them, which is
 *    the user's responsibility, not ours to pre-empt.
 *  - Bare model discovery. A generic `/models` returns only ids
 *    (`{object:'list', data:[{id}]}`), so `mapModel` returns the bare model.
 *    Context window / vision / reasoning / pricing are filled by the model
 *    registry (models.dev) when an id matches; otherwise left unknown.
 *  - Reasoning is the OpenAI-standard `reasoning_effort`, sent only when the
 *    model advertises thinking (so it never reaches a model that 400s on it).
 *  - The API key is OPTIONAL: local servers (llama.cpp, LM Studio) need none.
 *    When absent, no Authorization header is sent and the SDK gets a harmless
 *    placeholder key (it refuses to construct with an empty string).
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
import type { ReasoningEffort } from 'openai/resources/shared'

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
import { parseToolArguments } from '@/server/llm/core/parse-tool-args'
import {
  buildToolProtocolPrompt,
  renderToolCall,
  renderToolResult,
  parseToolCallsFromText,
} from '@/server/llm/core/prompt-tool-protocol'
import { createLogger } from '@/server/logger'
import type {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  HivekeepTool,
  ThinkingEffort,
} from '@/server/llm/llm/types'
import { downgradeEffort } from '@/server/llm/llm/types'

const log = createLogger('openai-compatible')

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'baseUrl',
    type: 'url',
    label: 'Base URL',
    required: true,
    placeholder: 'http://localhost:1234/v1',
    description:
      'OpenAI-compatible endpoint base, including the version path (e.g. `…/v1`). The provider appends `/chat/completions`, `/embeddings`, `/images/generations`, and `/models`. Works with NewAPI, LiteLLM, llama.cpp, LM Studio, vLLM, and similar.',
  },
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: false,
    placeholder: 'sk-… (leave empty if your server needs no key)',
    description: 'Optional. Local servers like llama.cpp or LM Studio usually need none.',
  },
  {
    key: 'imageModels',
    type: 'text',
    label: 'Image model IDs',
    required: false,
    placeholder: 'dall-e-3, flux-schnell (optional)',
    description:
      'Optional. Comma-separated model IDs to advertise as image models, in addition to ids the catalogue heuristic already recognizes (dall-e, gpt-image, flux, sdxl, imagen, …). Leave empty unless your /models listing uses names Hivekeep does not recognize. The endpoint must implement the OpenAI Images API (`/images/generations`).',
  },
]

// ─── /models payload (subset we read) ────────────────────────────────────────

/**
 * Entry from `GET /models`. A generic OpenAI-compatible endpoint returns the
 * bare OpenAI shape — only an `id` is meaningful. No modality, pricing, or
 * context-window fields are guaranteed (see `mapModel`).
 *
 * @internal exported for tests.
 */
export interface OpenAICompatibleModel {
  id: string
  object?: string
  owned_by?: string
}

// ─── Model classification ────────────────────────────────────────────────────

/**
 * Map a catalogue entry to a Hivekeep `LLMModel`, or null if it has no id.
 * A generic `/models` exposes ONLY ids, so we return the bare model — context
 * window, reasoning (efforts), vision and pricing are filled by the model
 * registry from models.dev (see `model-metadata.md`) when the id matches.
 * No name-based heuristics here.
 *
 * @internal exported for tests.
 */
export function mapModel(model: OpenAICompatibleModel): LLMModel | null {
  if (!model.id) return null

  const out: LLMModel = {
    id: model.id,
    name: model.id,
    // OpenAI-compatible upstreams cache prompts transparently and forward
    // cache hits in usage. No per-block cache control to send.
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  return out
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read + normalise the user-supplied base URL (trailing slash stripped). */
function getBaseUrl(config: ProviderConfig): string {
  const raw = config['baseUrl']?.trim()
  if (!raw) throw new InvalidRequestError('Missing base URL for OpenAI-compatible provider')
  return raw.replace(/\/+$/, '')
}

/** The API key is optional — returns '' when none is configured. */
function getApiKey(config: ProviderConfig): string {
  return config['apiKey']?.trim() ?? ''
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

function createClient(config: ProviderConfig): OpenAI {
  return new OpenAI({
    // The SDK refuses to construct with an empty apiKey; a placeholder is
    // harmless because key-less servers ignore the Authorization header.
    apiKey: getApiKey(config) || 'sk-no-key',
    baseURL: getBaseUrl(config),
  })
}

function mapFinishReason(
  reason: ChatCompletionChunk.Choice['finish_reason'],
): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    case null:
      return 'unknown'
    default:
      return 'unknown'
  }
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) {
      const retryAfter = parseRetryAfter(err.headers?.['retry-after'])
      return new RateLimitError(message, retryAfter, err)
    }
    if (status === 400 && /context.length|maximum context|too long/i.test(message)) {
      return new ContextOverflowError(message, undefined, undefined, err)
    }
    if (status && status >= 400 && status < 500) {
      return new InvalidRequestError(message, err)
    }
    if (status && status >= 500) {
      return new ProviderServerError(message, status, err)
    }
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) {
    return new NetworkError(err.message, err)
  }
  return new NetworkError(String(err))
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

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

// ─── Message conversion (hivekeep → OpenAI-compatible) ─────────────────────────

function systemPromptToMessage(
  system: ChatRequest['system'],
): ChatCompletionSystemMessageParam | undefined {
  if (!system || system.length === 0) return undefined
  const text = system.map((b) => b.text).join('\n\n')
  if (!text) return undefined
  return { role: 'system', content: text }
}

function userBlocksToContent(
  blocks: HivekeepMessage['content'],
): ChatCompletionUserMessageParam['content'] | null {
  const parts: ChatCompletionContentPart[] = []
  for (const b of blocks) {
    if (b.type === 'text' && b.text) {
      parts.push({ type: 'text', text: b.text })
    } else if (b.type === 'image') {
      // Pass images through as the OpenAI multimodal `image_url` shape. A
      // text-only model upstream will reject them; that's the endpoint's call.
      const dataUrl = `data:${b.mediaType};base64,${uint8ToBase64(b.data)}`
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    }
  }
  if (parts.length === 0) return null
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text
  }
  return parts
}

/**
 * Build an OpenAI-compatible assistant message from hivekeep content blocks.
 * Plain by design: no vendor-specific `reasoning_content` replay (that is a
 * DeepSeek requirement that vanilla servers 400 on).
 *
 * @internal exported for tests.
 */
export function assistantMessage(
  blocks: HivekeepMessage['content'],
): ChatCompletionAssistantMessageParam {
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

function messagesToOpenAI(
  messages: HivekeepMessage[],
  system: ChatCompletionSystemMessageParam | undefined,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  if (system) out.push(system)

  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push(assistantMessage(m.content))
      continue
    }
    const userContent = userBlocksToContent(m.content)
    if (userContent !== null) {
      out.push({ role: 'user', content: userContent })
    }
    for (const b of m.content) {
      if (b.type === 'tool-result') {
        const toolMsg: ChatCompletionToolMessageParam = {
          role: 'tool',
          tool_call_id: b.toolUseId,
          content: b.content,
        }
        out.push(toolMsg)
      }
    }
  }
  return out
}

function toolsToOpenAI(tools: ChatRequest['tools']): ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}

// ─── Streaming (OpenAI-compatible chunks → ChatChunk) ────────────────────────

interface ToolCallState {
  id: string
  name: string
  args: string
}

async function* streamChat(
  client: OpenAI,
  params: ChatCompletionCreateParamsStreaming,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
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

      const delta = choice.delta as
        | (ChatCompletionChunk.Choice['delta'] & {
            reasoning_content?: string | null
            reasoning?: string | null
          })
        | undefined
      // Reasoning summaries arrive under different keys depending on the
      // upstream: DeepSeek-style servers use `reasoning_content`, OpenRouter
      // -style use `reasoning`. Tolerate both.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) {
        yield { type: 'thinking-delta', text: reasoning }
      }
      if (delta?.content) {
        yield { type: 'text-delta', text: delta.content }
      }
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
      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
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

  yield {
    type: 'finish',
    reason: mapFinishReason(finishReason),
    usage,
  }
}

// ─── Prompt-based tool protocol (backends without native tool support) ────────

// Remembered per (endpoint, model): a backend that 400s on native `tools` once
// (e.g. Ollama's "does not support tools") goes straight to the text protocol on
// later turns. Process-local; a restart re-detects via a single 400.
const promptProtocolModels = new Set<string>()

function promptKey(config: ProviderConfig, model: LLMModel): string {
  return `${getBaseUrl(config)}::${model.id}`
}

function isNativeToolsUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /does not support tool|tools?\s+(?:are|is)\s+not\s+supported|function calling is not supported|tool use is not supported|no endpoints found that support tool use/i.test(
    message,
  )
}

function toUsage(u: ChatCompletionChunk['usage'] | undefined | null): Usage {
  if (!u) return {}
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: u.completion_tokens,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
  }
}

function protocolSystemMessage(
  system: ChatCompletionSystemMessageParam | undefined,
  tools: HivekeepTool[],
): ChatCompletionSystemMessageParam {
  const protocol = buildToolProtocolPrompt(tools)
  const base = typeof system?.content === 'string' ? system.content : ''
  return { role: 'system', content: base ? `${base}\n\n${protocol}` : protocol }
}

/**
 * Like `messagesToOpenAI`, but prior tool calls and tool results are rendered as
 * text (`<tool_call>` / `<tool_response>`) instead of native `tool_calls` / `role:
 * tool` messages, so a backend that rejects native tools still sees the full tool
 * conversation on replay.
 */
function messagesToOpenAIPrompt(
  messages: HivekeepMessage[],
  system: ChatCompletionSystemMessageParam,
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [system]

  // Tool results carry only a tool-use id; map it back to the tool name so the
  // <tool_response> can be labelled for the model.
  const nameById = new Map<string, string>()
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool-use') nameById.set(b.id, b.name)
    }
  }

  for (const m of messages) {
    if (m.role === 'assistant') {
      let text = ''
      for (const b of m.content) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool-use') text += (text ? '\n' : '') + renderToolCall(b.name, b.args)
      }
      if (text) out.push({ role: 'assistant', content: text })
      continue
    }
    const userContent = userBlocksToContent(m.content)
    if (userContent !== null) out.push({ role: 'user', content: userContent })
    const responses: string[] = []
    for (const b of m.content) {
      if (b.type === 'tool-result') responses.push(renderToolResult(b.content, nameById.get(b.toolUseId)))
    }
    if (responses.length > 0) out.push({ role: 'user', content: responses.join('\n\n') })
  }
  return out
}

// Globally-unique ids for prompt-protocol calls so cross-step history replay never
// collides on the tool-use id (the text protocol has no id of its own).
let promptCallSeq = 0

async function* streamChatPromptProtocol(
  client: OpenAI,
  model: LLMModel,
  request: ChatRequest,
  system: ChatCompletionSystemMessageParam | undefined,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  const params: ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages: messagesToOpenAIPrompt(
      request.messages,
      protocolSystemMessage(system, request.tools ?? []),
    ),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (request.maxOutputTokens != null) params.max_tokens = request.maxOutputTokens
  if (request.temperature != null) params.temperature = request.temperature
  if (request.metadata?.userId) params.user = request.metadata.userId

  let stream
  try {
    stream = await client.chat.completions.create(params, { signal })
  } catch (err) {
    throw mapApiError(err)
  }

  let content = ''
  let finishReason: ChatCompletionChunk.Choice['finish_reason'] = null
  let usage: Usage = {}
  try {
    for await (const chunk of stream) {
      if (chunk.usage) usage = toUsage(chunk.usage)
      const choice = chunk.choices[0]
      if (!choice) continue
      const delta = choice.delta as
        | (ChatCompletionChunk.Choice['delta'] & {
            reasoning_content?: string | null
            reasoning?: string | null
          })
        | undefined
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) yield { type: 'thinking-delta', text: reasoning }
      if (delta?.content) content += delta.content
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  } catch (err) {
    throw mapApiError(err)
  }

  const { text, calls } = parseToolCallsFromText(content)
  if (text) yield { type: 'text-delta', text }
  for (const call of calls) {
    yield { type: 'tool-use', id: `call_${promptCallSeq++}`, name: call.name, args: call.args }
  }
  yield {
    type: 'finish',
    reason: calls.length > 0 ? 'tool-calls' : mapFinishReason(finishReason),
    usage,
  }
}

/**
 * Native tool calling, falling back to the prompt protocol the first time a backend
 * reports it does not support tools. The fallback only fires before any chunk has
 * been emitted, so a mid-stream failure is never mistaken for "no tool support".
 */
async function* streamChatNativeOrProtocol(
  client: OpenAI,
  model: LLMModel,
  request: ChatRequest,
  system: ChatCompletionSystemMessageParam | undefined,
  params: ChatCompletionCreateParamsStreaming,
  key: string,
): AsyncIterable<ChatChunk> {
  let started = false
  try {
    for await (const chunk of streamChat(client, params, request.signal)) {
      started = true
      yield chunk
    }
    return
  } catch (err) {
    if (started || !isNativeToolsUnsupported(err)) throw err
  }
  log.info(
    { model: model.id },
    'Backend does not support native tools; switching to the prompt-based tool protocol',
  )
  promptProtocolModels.add(key)
  yield* streamChatPromptProtocol(client, model, request, system, request.signal)
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const openaiCompatibleProvider: LLMProvider = {
  type: 'openai-compatible',
  displayName: 'OpenAI-compatible',
  configSchema: CONFIG_SCHEMA,
  // OpenAI's documented 128-tool cap is the safe assumption for the family.
  defaultMaxTools: 128,
  // Conservative: a generic endpoint may front a metered upstream (NewAPI,
  // LiteLLM), so don't claim 'local' (which would win flat-rate tie-breaks).
  billing: 'per-token',

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    let baseUrl: string
    try {
      baseUrl = getBaseUrl(config)
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
    try {
      const apiKey = getApiKey(config)
      // GET /models doubles as a reachability + credential probe — 200 with a
      // list means the URL is right (and the key, if any, is accepted);
      // 401/403 means the key is wrong.
      const res = await fetch(`${baseUrl}/models`, { headers: authHeaders(apiKey) })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return {
          valid: false,
          error: apiKey
            ? 'The API key was rejected by the endpoint'
            : 'The endpoint requires an API key',
        }
      }
      return { valid: false, error: `Endpoint returned HTTP ${res.status}` }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const baseUrl = getBaseUrl(config)
    const apiKey = getApiKey(config)
    let payload: { data?: OpenAICompatibleModel[] }
    try {
      const res = await fetch(`${baseUrl}/models`, { headers: authHeaders(apiKey) })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Endpoint rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(`/models returned HTTP ${res.status}`, res.status)
      }
      payload = (await res.json()) as { data?: OpenAICompatibleModel[] }
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
    const system = systemPromptToMessage(request.system)
    const hasTools = !!(request.tools && request.tools.length > 0)

    // A backend already known to reject native tools for this model skips the
    // wasted 400 and goes straight to the prompt protocol.
    if (hasTools && promptProtocolModels.has(promptKey(config, model))) {
      return streamChatPromptProtocol(client, model, request, system, request.signal)
    }

    const params: ChatCompletionCreateParamsStreaming = {
      model: model.id,
      messages: messagesToOpenAI(request.messages, system),
      stream: true,
      stream_options: { include_usage: true },
    }

    const tools = toolsToOpenAI(request.tools)
    if (tools) params.tools = tools

    if (request.maxOutputTokens != null) {
      params.max_tokens = request.maxOutputTokens
    }
    if (request.temperature != null) {
      params.temperature = request.temperature
    }

    // Reasoning: forward the OpenAI-standard `reasoning_effort` ONLY when the
    // model advertises thinking efforts (filled by the registry). Sending it
    // to a model that doesn't accept it is a 400, so the gate matters.
    if (request.thinkingEffort && model.thinking?.efforts?.length) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking.efforts)
      if (chosen) {
        params.reasoning_effort = chosen as ReasoningEffort
      }
    }

    if (request.metadata?.userId) {
      params.user = request.metadata.userId
    }

    // No tools → plain native streaming. With tools → native, falling back to the
    // prompt protocol if the backend reports it does not support tools.
    if (!hasTools) {
      return streamChat(client, params, request.signal)
    }
    return streamChatNativeOrProtocol(client, model, request, system, params, promptKey(config, model))
  },
}
