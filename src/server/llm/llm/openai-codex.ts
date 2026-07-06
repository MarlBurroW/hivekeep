/**
 * OpenAI Codex CLI provider (ChatGPT Plus/Pro subscription).
 *
 * Talks directly to the Codex backend (`chatgpt.com/backend-api/codex`),
 * which exposes a Responses-style API billed against the user's ChatGPT
 * subscription. Auth is via OAuth tokens read from `~/.codex/auth.json`
 * (refreshed automatically); the model catalog is read from
 * `~/.codex/models_cache.json`, kept in sync by the Codex CLI itself.
 *
 * Uses raw fetch + a hand-rolled SSE parser rather than the official `openai`
 * SDK because the Codex backend's wire shape (proprietary URL, custom auth
 * headers, slightly different stream events) diverges from the standard
 * Responses API enough that pulling the SDK in would buy us nothing.
 *
 * Auth helpers live next door in `_codex-auth.ts` (underscore-prefixed so
 * the registry's `import.meta.glob` skips them).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { REAL_HOME, normalizeAbsoluteHome } from '@/server/llm/llm/_home-paths'
import {
  getCodexOAuthCredentials,
  CODEX_BASE_URL,
  CODEX_PKCE_CLIENT,
  codexAccountIdFromTokens,
} from '@/server/llm/llm/_codex-auth'

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
import type {
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  ThinkingEffort,
} from '@/server/llm/llm/types'
import { downgradeEffort, THINKING_EFFORT_ORDER } from '@/server/llm/llm/types'

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    // 'signin' = tokens obtained via the in-app PKCE flow, stored in the vault;
    // 'cli' (default for existing setups) = read ~/.codex/auth.json. Set by the
    // sign-in route; toggled by the UI. Non-secret, stored inline.
    key: 'authMode',
    type: 'text',
    label: 'Authentication mode',
    placeholder: 'cli',
    description: "Either 'signin' (in-app ChatGPT login) or 'cli' (read the Codex CLI auth file).",
  },
  {
    key: 'authFilePath',
    type: 'path',
    label: 'Codex auth file (optional)',
    placeholder: '~/.codex/auth.json',
    description:
      'Leave empty to auto-detect the Codex CLI credentials. Override only when running in a non-standard environment.',
  },
]

// ─── Model discovery ─────────────────────────────────────────────────────────

/**
 * Candidate cache paths, tried in order. The Codex CLI writes
 * `~/.codex/models_cache.json`, but the plain env HOME and the snap-adjusted
 * REAL_HOME can differ (macOS and nonstandard Linux homes), so try the env HOME
 * first and fall back to REAL_HOME rather than missing a valid cache.
 * @internal exported for tests.
 */
export function modelsCacheCandidates(envHome: string | undefined, realHome: string | undefined): string[] {
  const candidates: string[] = []
  for (const home of [envHome, realHome]) {
    const normalized = normalizeAbsoluteHome(home)
    if (!normalized) continue
    const p = join(normalized, '.codex', 'models_cache.json')
    if (!candidates.includes(p)) candidates.push(p)
  }
  return candidates
}
const MODELS_CACHE_CANDIDATES = modelsCacheCandidates(process.env.HOME, REAL_HOME)

interface CodexModelCacheEntry {
  slug: string
  display_name?: string
  visibility?: 'list' | 'hide' | string
  supported_in_api?: boolean
  priority?: number
  context_window?: number
  max_output_tokens?: number
  input_modalities?: string[]
  supports_parallel_tool_calls?: boolean
  supported_reasoning_levels?: Array<{ effort?: string }>
  upgrade?: unknown
}

interface CodexModelsCacheFile {
  models?: CodexModelCacheEntry[]
}

/**
 * The Codex backend gates its catalog by client version: too old a value
 * returns an empty `models` array. Kept reasonably current and sent as the
 * required `client_version` query param when fetching the live catalog.
 * (Verified empirically: 0.39.0 → [], 0.142.2 → full catalog.)
 */
const CODEX_CLIENT_VERSION = '0.142.2'

/** Keep only API-listable models, drop superseded ones, order by priority. */
function selectCodexEntries(models: CodexModelCacheEntry[] | undefined): CodexModelCacheEntry[] {
  if (!models || !Array.isArray(models)) return []
  const filtered = models.filter(
    (m) =>
      typeof m.slug === 'string' &&
      m.slug.length > 0 &&
      m.supported_in_api === true &&
      m.visibility === 'list' &&
      m.upgrade == null,
  )
  filtered.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
  return filtered
}

/**
 * Fetch the live, per-account Codex catalog from the backend. This is the
 * authoritative source: the available model slugs (gpt-5.4, gpt-5.5, …) change
 * over time and vary by plan, so they must never be hardcoded. Returns null on
 * any failure or an empty catalog so the caller can fall back.
 */
async function fetchCodexModelsFromApi(config: ProviderConfig): Promise<CodexModelCacheEntry[] | null> {
  try {
    const { accessToken, accountId } = await getCodexOAuthCredentials(config)
    const res = await fetch(`${CODEX_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'ChatGPT-Account-ID': accountId,
      },
    })
    if (!res.ok) return null
    const parsed = (await res.json()) as CodexModelsCacheFile
    const selected = selectCodexEntries(parsed.models)
    return selected.length > 0 ? selected : null
  } catch {
    return null
  }
}

/**
 * Read the Codex catalog from the on-disk cache maintained by the Codex CLI.
 * Returns null when the cache is missing or unreadable (so the caller can
 * decide whether to error out or fall back).
 */
function readCodexModelsFromCache(): CodexModelCacheEntry[] | null {
  for (const path of MODELS_CACHE_CANDIDATES) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as CodexModelsCacheFile
      const selected = selectCodexEntries(parsed.models)
      if (selected.length > 0) return selected
    } catch {
      // try the next candidate path
    }
  }
  return null
}

/**
 * Last-resort catalog for when both the live API and the CLI cache are
 * unavailable (e.g. a transient network failure during onboarding). These
 * slugs go stale (the API is the real source), so this only exists so the
 * provider degrades to something rather than listing zero models.
 */
export const STATIC_CODEX_MODELS: CodexModelCacheEntry[] = [
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, supported_in_api: true, visibility: 'list' },
]

/**
 * Resolve the Codex catalog: live API (authoritative) → CLI cache → static
 * floor. The API path works in every mode (in-app sign-in and CLI), which is
 * why a stale hardcoded list is no longer the primary source.
 */
async function resolveCodexModels(config: ProviderConfig): Promise<CodexModelCacheEntry[]> {
  return (await fetchCodexModelsFromApi(config)) ?? readCodexModelsFromCache() ?? STATIC_CODEX_MODELS
}

/**
 * Map a catalog entry to an LLMModel. Reasoning levels, image support and the
 * context window come straight from the backend metadata when present, with
 * conservative GPT-5-family defaults as a fallback.
 */
export function mapCodexModel(entry: CodexModelCacheEntry): LLMModel {
  const efforts = (entry.supported_reasoning_levels ?? [])
    .map((r) => r.effort)
    .filter((e): e is ThinkingEffort => (THINKING_EFFORT_ORDER as readonly string[]).includes(e ?? ''))
  const model: LLMModel = {
    id: entry.slug,
    name: entry.display_name && entry.display_name.length > 0 ? entry.display_name : entry.slug,
    contextWindow: entry.context_window ?? 0,
    supportsImageInput: entry.input_modalities ? entry.input_modalities.includes('image') : true,
    supportsPromptCaching: true,
    supportsParallelTools: entry.supports_parallel_tool_calls ?? true,
    thinking: { efforts: efforts.length > 0 ? efforts : ['low', 'medium', 'high'] },
  }
  if (entry.max_output_tokens != null) model.maxOutput = entry.max_output_tokens
  return model
}

// ─── Effort downgrade ────────────────────────────────────────────────────────


// ─── Error mapping ───────────────────────────────────────────────────────────

function errorFromResponse(status: number, body: string): HivekeepProviderError {
  if (status === 401 || status === 403) return new AuthError(`Codex auth failed: ${body.slice(0, 200)}`)
  if (status === 429) {
    return new RateLimitError(`Codex rate limit: ${body.slice(0, 200)}`)
  }
  // Context-overflow detection: match the actual OpenAI/Codex phrasings only
  // ("maximum context length", "context_length_exceeded", "input is too long"),
  // not any occurrence of the bare word "context" — schema-validation errors
  // routinely include strings like "In context=()" and used to be misclassified.
  if (
    status === 400 &&
    /(maximum (context|input) length|context[_ -]length[_ -]exceeded|input is too long|prompt is too long)/i.test(body)
  ) {
    return new ContextOverflowError(`Codex context overflow: ${body.slice(0, 200)}`)
  }
  if (status >= 400 && status < 500) {
    return new InvalidRequestError(`Codex bad request (${status}): ${body.slice(0, 200)}`)
  }
  return new ProviderServerError(`Codex server error (${status}): ${body.slice(0, 200)}`, status)
}

function wrapError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

// ─── Message conversion (hivekeep → Codex Responses format) ────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

interface ResponseInputItem {
  type: string
  [key: string]: unknown
}

/**
 * Convert hivekeep messages to the Codex `input` array.
 *
 * The Codex Responses API expects a flat array where:
 *   - User text/image content → `{ type: 'message', role: 'user', content: [...] }`
 *   - Assistant text content → `{ type: 'message', role: 'assistant', content: [...] }`
 *   - Tool calls emitted by the assistant → `{ type: 'function_call', name, call_id, arguments }`
 *   - Tool results fed back in → `{ type: 'function_call_output', call_id, output }`
 *   - Thinking blocks → dropped (the backend round-trips its own reasoning
 *     via opaque encrypted blocks; we don't replay them).
 */
function messagesToCodexInput(messages: HivekeepMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const textParts: Array<{ type: 'output_text'; text: string }> = []
      for (const b of m.content) {
        if (b.type === 'text' && b.text) {
          textParts.push({ type: 'output_text', text: b.text })
        } else if (b.type === 'tool-use') {
          items.push({
            type: 'function_call',
            name: b.name,
            call_id: b.id,
            arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args),
          })
        }
        // thinking blocks: dropped intentionally
      }
      if (textParts.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: textParts,
        })
      }
      continue
    }
    // user role
    const userParts: Array<Record<string, unknown>> = []
    for (const b of m.content) {
      if (b.type === 'text' && b.text) {
        userParts.push({ type: 'input_text', text: b.text })
      } else if (b.type === 'image') {
        const dataUrl = `data:${b.mediaType};base64,${uint8ToBase64(b.data)}`
        userParts.push({ type: 'input_image', image_url: dataUrl })
      } else if (b.type === 'tool-result') {
        items.push({
          type: 'function_call_output',
          call_id: b.toolUseId,
          output: b.content,
        })
      }
    }
    if (userParts.length > 0) {
      items.push({
        type: 'message',
        role: 'user',
        content: userParts,
      })
    }
  }
  return items
}

function systemToInstructions(system: ChatRequest['system']): string | undefined {
  if (!system || system.length === 0) return undefined
  const joined = system.map((b) => b.text).join('\n\n')
  return joined.length > 0 ? joined : undefined
}

interface ResponsesTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

function toolsToCodex(tools: ChatRequest['tools']): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }))
}

// ─── SSE parser ──────────────────────────────────────────────────────────────

/**
 * Parse a Server-Sent Events stream from a Response into a flow of decoded
 * `data:` JSON payloads. Skips empty lines, comment lines, and lone `event:`
 * lines (we only care about the JSON payloads).
 */
async function* parseSSE(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new ProviderServerError('Codex returned an empty body', response.status)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      // SSE message boundary is a blank line (\n\n).
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawMessage = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines = rawMessage
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        const payload = dataLines.join('\n')
        if (payload === '[DONE]') return
        try {
          yield JSON.parse(payload)
        } catch {
          // Malformed event — skip rather than abort the whole stream.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ─── Stream → ChatChunk ──────────────────────────────────────────────────────

interface CodexUsage {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens_details?: { reasoning_tokens?: number }
}

interface FunctionCallState {
  id: string
  name: string
  args: string
}

async function* streamCodex(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw wrapError(err)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw errorFromResponse(response.status, text)
  }

  const functionCalls = new Map<number, FunctionCallState>()
  let usage: Usage = {}
  let finishReason: FinishReason = 'unknown'

  try {
    for await (const raw of parseSSE(response)) {
      const event = raw as { type?: string; [key: string]: unknown }
      switch (event.type) {
        case 'response.output_item.added': {
          const item = event.item as { type?: string; name?: string; call_id?: string; output_index?: number } | undefined
          const outputIndex = (event.output_index as number | undefined) ?? 0
          if (item?.type === 'function_call' && item.name && item.call_id) {
            functionCalls.set(outputIndex, { id: item.call_id, name: item.name, args: '' })
          }
          break
        }
        case 'response.function_call_arguments.delta': {
          const outputIndex = (event.output_index as number | undefined) ?? 0
          const delta = (event.delta as string | undefined) ?? ''
          const state = functionCalls.get(outputIndex)
          if (state) state.args += delta
          break
        }
        case 'response.function_call_arguments.done': {
          const outputIndex = (event.output_index as number | undefined) ?? 0
          const args = (event.arguments as string | undefined) ?? ''
          const state = functionCalls.get(outputIndex)
          if (state) state.args = args
          break
        }
        case 'response.output_text.delta': {
          const delta = (event.delta as string | undefined) ?? ''
          if (delta) yield { type: 'text-delta', text: delta }
          break
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const delta = (event.delta as string | undefined) ?? ''
          if (delta) yield { type: 'thinking-delta', text: delta }
          break
        }
        case 'response.completed': {
          const resp = event.response as { usage?: CodexUsage; status?: string } | undefined
          const u = resp?.usage
          usage = {
            inputTokens: u?.input_tokens,
            outputTokens: u?.output_tokens,
            cacheReadTokens: u?.input_tokens_details?.cached_tokens,
            reasoningTokens: u?.output_tokens_details?.reasoning_tokens,
          }
          finishReason = functionCalls.size > 0 ? 'tool-calls' : 'stop'
          break
        }
        case 'response.failed':
        case 'response.error': {
          const resp = event.response as { error?: { message?: string } } | undefined
          const msg = resp?.error?.message ?? 'Codex stream failed'
          throw new ProviderServerError(msg)
        }
      }
    }
  } catch (err) {
    throw wrapError(err)
  }

  // Flush accumulated tool calls before the finish chunk.
  for (const [outputIndex, state] of functionCalls) {
    if (!state.name) continue
    yield {
      type: 'tool-use',
      id: state.id || `call_${outputIndex}`,
      name: state.name,
      args: parseToolArguments(state.args),
    }
  }

  yield { type: 'finish', reason: finishReason, usage }
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const openaiCodexProvider: LLMProvider = {
  type: 'openai-codex',
  displayName: 'OpenAI (Codex CLI)',
  configSchema: CONFIG_SCHEMA,
  // Same upstream as openaiKeyProvider — OpenAI's 128-tool cap applies.
  defaultMaxTools: 128,
  // ChatGPT Plus / Codex CLI is a subscription — auto-resolution
  // prefers it over a metered openai-key when both serve the same model.
  billing: 'subscription',
  // Declares the in-app sign-in (PKCE). OpenAI redirects to a loopback URL the
  // user copies; buildExtra captures the ChatGPT account id from the id_token.
  oauth: { client: CODEX_PKCE_CLIENT, buildExtra: codexAccountIdFromTokens, redirectStyle: 'loopback' },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const { accessToken, accountId } = await getCodexOAuthCredentials(config)
      const testModel = (await resolveCodexModels(config))[0]?.slug
      if (!testModel) {
        return { valid: false, error: 'No Codex models available to test against.' }
      }
      // Lightweight ping with a short instruction; consumed and discarded.
      const response = await fetch(`${CODEX_BASE_URL}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'ChatGPT-Account-ID': accountId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: testModel,
          instructions: 'Reply with exactly one word.',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hi' }] }],
          store: false,
          stream: true,
        }),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { valid: false, error: errorFromResponse(response.status, text).message }
      }
      // Drain to avoid connection leak.
      if (response.body) {
        const reader = response.body.getReader()
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
      return { valid: true }
    } catch (err) {
      const mapped = wrapError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    // Live per-account catalog from the backend (works in both sign-in and CLI
    // modes), falling back to the CLI cache then the static floor.
    return (await resolveCodexModels(config)).map(mapCodexModel)
  },

  chat(model, request, config) {
    const body: Record<string, unknown> = {
      model: model.id,
      input: messagesToCodexInput(request.messages),
      stream: true,
      store: false,
    }
    const instructions = systemToInstructions(request.system)
    if (instructions) body.instructions = instructions
    const tools = toolsToCodex(request.tools)
    if (tools) body.tools = tools
    if (request.thinkingEffort) {
      const chosen = downgradeEffort(request.thinkingEffort, model.thinking?.efforts ?? [])
      if (chosen) body.reasoning = { effort: chosen }
    }
    // Codex rejects max_output_tokens; max_completion_tokens is the Responses
    // equivalent, but the Codex backend caps it itself per-model — only set it
    // when the caller explicitly asked.
    if (request.maxOutputTokens != null) {
      body.max_output_tokens = request.maxOutputTokens
    }

    // Resolve credentials and stream. We do this inside the generator so a
    // token refresh happens lazily at first iteration rather than at the
    // (possibly long-lived) call site that constructed the iterator.
    return (async function* () {
      const { accessToken, accountId } = await getCodexOAuthCredentials(config)
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'ChatGPT-Account-ID': accountId,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      }
      yield* streamCodex(`${CODEX_BASE_URL}/responses`, headers, body, request.signal)
    })()
  },
}
