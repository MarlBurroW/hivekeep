/**
 * Anthropic OAuth provider (Claude Max subscription).
 *
 * Reuses the Anthropic SDK's wire format but routes every request through a
 * custom fetch wrapper that:
 *   1. Swaps the API-key header for a Bearer token from ~/.claude/.credentials.json
 *      (refreshed automatically on expiry).
 *   2. Rewrites `/v1/messages` → `/v1/messages?beta=true` to match the
 *      official Claude Code CLI's request shape.
 *   3. Injects the signed billing tag + REQUIRED_SYSTEM_BLOCK at the head
 *      of the system array (required for OAuth requests to bill against the
 *      plan pool rather than the "extra usage" pool).
 *   4. Adds the CLI fingerprint headers (anthropic-beta, user-agent, Stainless,
 *      x-app) and `metadata.user_id`.
 *
 * Auth/refresh/header logic lives next door in `_anthropic-oauth-auth.ts`
 * (underscore-prefixed so the registry's `import.meta.glob` skips it).
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk'
import { createLogger } from '@/server/logger'
import type {
  MessageCreateParamsStreaming,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages'
import {
  getOAuthAccessToken,
  OAUTH_HEADERS,
  LONG_CONTEXT_BETA,
  REQUIRED_SYSTEM_BLOCK,
  buildBillingHeaderText,
  getOAuthUserId,
  ANTHROPIC_PKCE_CLIENT,
} from '@/server/llm/llm/_anthropic-oauth-auth'

import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
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
  ThinkingEffort,
} from '@/server/llm/llm/types'

// Pull shared helpers from the key provider — same Anthropic API, only the
// auth flavour differs. Avoids duplicating message / stream / error code.
import {
  messagesToAnthropic,
  systemToAnthropic,
  toolsToAnthropic,
  buildThinkingParams,
  streamChat as anthropicStreamChat,
  mapAnthropicApiError,
} from '@/server/llm/llm/_anthropic-shared'

// ─── Config schema ───────────────────────────────────────────────────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    // 'signin' = tokens obtained via the in-app PKCE flow and stored in the
    // vault; 'cli' (default for existing setups) = read the CLI creds file.
    // Set by the sign-in route; the UI toggles it. Non-secret, stored inline.
    key: 'authMode',
    type: 'text',
    label: 'Authentication mode',
    placeholder: 'cli',
    description: "Either 'signin' (in-app Claude login) or 'cli' (read the Claude Code credentials file).",
  },
  {
    key: 'authFilePath',
    type: 'path',
    label: 'Credentials file (optional)',
    placeholder: '~/.claude/.credentials.json',
    description:
      'Leave empty to auto-detect the Claude Code CLI credentials. Override only when running in a non-standard environment.',
  },
]

// ─── Models discovery (OAuth-authenticated /v1/models call) ─────────────────

interface AnthropicOAuthModel {
  id: string
  display_name: string
  type: string
  max_input_tokens?: number
  max_tokens?: number
  capabilities?: {
    thinking?: { supported: boolean }
    effort?: Partial<Record<string, { supported: boolean }>>
    image_input?: { supported: boolean }
  }
}

// Effort levels the Anthropic API can advertise (capabilities.effort).
// 'minimal' is not an Anthropic level; 'xhigh' exists from Opus 4.7 onward.
const ALL_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const MODEL_NOTES: Record<string, string> = {
  'claude-opus-4-7': 'Opus 4.7 reasons internally — this setting may have no visible effect.',
  'claude-opus-4-7[1m]': 'Opus 4.7 reasons internally — this setting may have no visible effect.',
}

async function fetchOAuthModels(config: ProviderConfig): Promise<AnthropicOAuthModel[]> {
  const accessToken = await getOAuthAccessToken(config)
  const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01',
      ...OAUTH_HEADERS,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ProviderServerError(
      `Anthropic OAuth models endpoint returned ${response.status}: ${text.slice(0, 200)}`,
      response.status,
    )
  }
  const data = (await response.json()) as { data?: AnthropicOAuthModel[] }
  return data.data ?? []
}

function mapModel(raw: AnthropicOAuthModel): LLMModel {
  const caps = raw.capabilities
  const thinkingSupported = caps?.thinking?.supported ?? false
  const efforts: ThinkingEffort[] = thinkingSupported && caps?.effort
    ? ALL_EFFORTS.filter((e) => caps.effort![e]?.supported ?? false)
    : []
  const note = MODEL_NOTES[raw.id]
  const thinking: LLMModel['thinking'] | undefined = efforts.length > 0
    ? { efforts, ...(note ? { note } : {}) }
    : undefined

  const model: LLMModel = {
    id: raw.id,
    name: raw.display_name,
    contextWindow: raw.max_input_tokens ?? 0,
    supportsImageInput: caps?.image_input?.supported ?? true,
    supportsPromptCaching: true,
    supportsParallelTools: true,
  }
  if (raw.max_tokens != null) model.maxOutput = raw.max_tokens
  if (thinking) model.thinking = thinking
  return model
}

// ─── Custom fetch wrapper (the OAuth glue) ───────────────────────────────────

const log = createLogger('anthropic-oauth')

function buildOAuthFetch(config: ProviderConfig): typeof fetch {
  return (async (url: URL | RequestInfo, init: RequestInit | undefined) => {
    const accessToken = await getOAuthAccessToken(config)

    const headers = new Headers(init?.headers)
    headers.delete('x-api-key')
    headers.set('authorization', `Bearer ${accessToken}`)
    if (!headers.has('x-stainless-retry-count')) headers.set('x-stainless-retry-count', '0')
    if (!headers.has('x-stainless-timeout')) headers.set('x-stainless-timeout', '600')

    // Rewrite /v1/messages → /v1/messages?beta=true to match the CLI shape.
    let target: URL | RequestInfo = url
    const urlString = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.toString()
        : url instanceof Request
          ? url.url
          : String(url)
    if (urlString.includes('/v1/messages') && !urlString.includes('beta=true')) {
      const sep = urlString.includes('?') ? '&' : '?'
      const rewritten = `${urlString}${sep}beta=true`
      target = typeof url === 'string'
        ? rewritten
        : url instanceof URL
          ? new URL(rewritten)
          : url instanceof Request
            ? new Request(rewritten, url)
            : rewritten
    }

    // Body rewrites: prepend signed billing block + identity block, inject user_id.
    let finalInit = init
    if (init?.body && typeof init.body === 'string') {
      try {
        const body = JSON.parse(init.body)
        const billingBlock = {
          type: 'text' as const,
          text: buildBillingHeaderText(body.messages),
        }
        if (body.system === undefined) {
          body.system = [billingBlock, REQUIRED_SYSTEM_BLOCK]
        } else if (typeof body.system === 'string') {
          body.system = [
            billingBlock,
            REQUIRED_SYSTEM_BLOCK,
            { type: 'text', text: body.system },
          ]
        } else if (Array.isArray(body.system)) {
          body.system = [billingBlock, REQUIRED_SYSTEM_BLOCK, ...body.system]
        }
        if (!body.metadata || typeof body.metadata !== 'object') {
          body.metadata = {}
        }
        if (!body.metadata.user_id) {
          body.metadata.user_id = getOAuthUserId()
        }
        finalInit = { ...init, body: JSON.stringify(body) }
      } catch {
        // Body wasn't JSON — pass through as-is.
      }
    }

    const response = await globalThis.fetch(target, { ...finalInit, headers })

    // Some models are not entitled to the 1M-context beta on a subscription
    // plan (Haiku is the one that bites here), and the API rejects the whole
    // request rather than ignoring the header. The beta is sent unconditionally
    // to match the Claude Code fingerprint, so rather than dropping it for
    // everyone — which would change that fingerprint for the requests it does
    // work on — retry once without it.
    if (response.status === 400 && headers.get('anthropic-beta')?.includes(LONG_CONTEXT_BETA)) {
      const body = await response.clone().text().catch(() => '')
      if (/long context beta is not/i.test(body)) {
        const retryHeaders = new Headers(headers)
        retryHeaders.set(
          'anthropic-beta',
          (headers.get('anthropic-beta') ?? '')
            .split(',')
            .filter((b) => b.trim() !== LONG_CONTEXT_BETA)
            .join(','),
        )
        log.debug('Anthropic rejected the 1M-context beta for this model — retrying without it')
        return globalThis.fetch(target, { ...finalInit, headers: retryHeaders })
      }
    }

    return response
  }) as unknown as typeof fetch
}

function createClient(config: ProviderConfig): Anthropic {
  return new Anthropic({
    apiKey: 'oauth-placeholder', // overridden by the custom fetch
    fetch: buildOAuthFetch(config),
    defaultHeaders: { ...OAUTH_HEADERS },
  })
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) return mapAnthropicApiError(err)
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const anthropicOAuthProvider: LLMProvider = {
  type: 'anthropic-oauth',
  displayName: 'Anthropic (Claude Max)',
  configSchema: CONFIG_SCHEMA,
  // Same upstream as anthropicKeyProvider.
  defaultMaxTools: 512,
  // Claude Max is a subscription — auto-resolution prefers it over a
  // metered anthropic-key when both serve the same model.
  billing: 'subscription',
  // Declares the in-app sign-in (PKCE). The card/route layer keys off this,
  // not the provider type. Anthropic's redirect shows the code on a page.
  oauth: { client: ANTHROPIC_PKCE_CLIENT, redirectStyle: 'page' },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const models = await fetchOAuthModels(config)
      return { valid: models.length > 0 }
    } catch (err) {
      const mapped = mapApiError(err)
      return { valid: false, error: mapped.message }
    }
  },

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    try {
      const raw = await fetchOAuthModels(config)
      return raw.filter((m) => m.type === 'model').map(mapModel)
    } catch (err) {
      throw mapApiError(err)
    }
  },

  chat(model, request, config) {
    const client = createClient(config)
    const params: MessageCreateParamsStreaming = {
      model: model.id,
      max_tokens: request.maxOutputTokens ?? model.maxOutput ?? 4096,
      messages: messagesToAnthropic(request.messages),
      stream: true,
    }
    const system: TextBlockParam[] | undefined = systemToAnthropic(request.system)
    if (system) params.system = system
    const tools = toolsToAnthropic(request.tools)
    if (tools) params.tools = tools
    if (request.temperature != null) params.temperature = request.temperature
    const { thinking, outputConfig } = buildThinkingParams(model, request.thinkingEffort)
    if (thinking) params.thinking = thinking
    if (outputConfig) params.output_config = outputConfig
    // Note: metadata.user_id is injected by the fetch wrapper.

    return anthropicStreamChat(client, params, request.signal)
  },
}
