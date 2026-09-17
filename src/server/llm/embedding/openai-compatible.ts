/**
 * Generic OpenAI-compatible embeddings provider: a BYO-endpoint connector.
 *
 * The companion of the `openai-compatible` LLM (and image) providers
 * (`src/server/llm/llm/openai-compatible.ts`): same `type`, so a single
 * provider row can serve `llm`, `embedding`, and `image` (capabilities are
 * auto-detected from the registries). Takes the base URL from config instead
 * of hardcoding OpenAI's, so embeddings can run against Ollama, llama.cpp,
 * LM Studio, vLLM, LiteLLM, NewAPI, and similar via `/v1/embeddings`.
 *
 * Design choices (vs the branded `openai` embedding provider):
 *  - Base URL is configurable; the API key is OPTIONAL (local servers need
 *    none). When absent, no Authorization header is sent and the SDK gets a
 *    harmless placeholder key (it refuses to construct with an empty string).
 *  - `listModels` returns the endpoint's `/models` verbatim, with NO
 *    `text-embedding-*` name filter (a generic endpoint can't be assumed to
 *    follow OpenAI's naming, and Ollama lists ids like `qwen3-embedding:0.6b`).
 *    Vector dimension is left undefined and inferred by the host from the
 *    first embed call (see `EmbeddingModel.dimensions`).
 */

import OpenAI, { APIError } from 'openai'
import type {
  ConfigField,
  ProviderConfig,
  AuthResult,
} from '@/server/llm/core/types'
import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  NetworkError,
  ProviderServerError,
  HivekeepProviderError,
} from '@/server/llm/core/types'
import type {
  EmbeddingProvider,
  EmbeddingModel,
  EmbedRequest,
  EmbedResult,
} from '@/server/llm/embedding/types'

// ─── Config schema (mirrors the openai-compatible LLM provider) ──────────────

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'baseUrl',
    type: 'url',
    label: 'Base URL',
    required: true,
    placeholder: 'http://localhost:11434/v1',
    description:
      'OpenAI-compatible endpoint base, including the version path (e.g. `…/v1`). The provider appends `/embeddings` and `/models`. Works with Ollama, llama.cpp, LM Studio, vLLM, LiteLLM, NewAPI, and similar.',
  },
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: false,
    placeholder: 'sk-… (leave empty if your server needs no key)',
    description: 'Optional. Local servers like Ollama or llama.cpp usually need none.',
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

/** @internal exported for tests. */
export interface OpenAICompatibleEmbeddingModel {
  id: string
  object?: string
  owned_by?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read + normalise the user-supplied base URL (trailing slash stripped). */
function getBaseUrl(config: ProviderConfig): string {
  const raw = config['baseUrl']?.trim()
  if (!raw) throw new InvalidRequestError('Missing base URL for OpenAI-compatible embeddings')
  return raw.replace(/\/+$/, '')
}

/** The API key is optional (returns '' when none is configured). */
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

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof APIError) {
    const status = err.status
    const message = err.message
    if (status === 401 || status === 403) return new AuthError(message, err)
    if (status === 429) return new RateLimitError(message, undefined, err)
    if (status && status >= 400 && status < 500) return new InvalidRequestError(message, err)
    if (status && status >= 500) return new ProviderServerError(message, status, err)
    return new ProviderServerError(message, status, err)
  }
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

/**
 * Map a catalogue entry to an `EmbeddingModel`, or null if it has no id.
 * No name filter and no hardcoded dimensions: a generic endpoint exposes only
 * ids, so dimension/maxInput are inferred by the host from the first embed.
 *
 * @internal exported for tests.
 */
export function mapModel(model: OpenAICompatibleEmbeddingModel): EmbeddingModel | null {
  if (!model.id) return null
  return { id: model.id, name: model.id }
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const openaiCompatibleEmbeddingProvider: EmbeddingProvider = {
  type: 'openai-compatible',
  displayName: 'OpenAI-compatible (Embeddings)',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    let baseUrl: string
    try {
      baseUrl = getBaseUrl(config)
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
    try {
      const apiKey = getApiKey(config)
      // GET /models doubles as a reachability + credential probe.
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
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<EmbeddingModel[]> {
    const baseUrl = getBaseUrl(config)
    const apiKey = getApiKey(config)
    let payload: { data?: OpenAICompatibleEmbeddingModel[] }
    try {
      const res = await fetch(`${baseUrl}/models`, { headers: authHeaders(apiKey) })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Endpoint rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(`/models returned HTTP ${res.status}`, res.status)
      }
      payload = (await res.json()) as { data?: OpenAICompatibleEmbeddingModel[] }
    } catch (err) {
      throw mapApiError(err)
    }

    // No name filter: a generic endpoint may not follow OpenAI's
    // `text-embedding-*` convention (Ollama: `qwen3-embedding:0.6b`,
    // `nomic-embed-text`, …). The user picks their embedding model.
    const models: EmbeddingModel[] = []
    for (const raw of payload.data ?? []) {
      const mapped = mapModel(raw)
      if (mapped) models.push(mapped)
    }
    return models
  },

  async embed(
    model: EmbeddingModel,
    request: EmbedRequest,
    config: ProviderConfig,
  ): Promise<EmbedResult> {
    const client = createClient(config)
    try {
      const result = await client.embeddings.create(
        // Force `float`: the OpenAI SDK otherwise defaults to `base64` and
        // decodes the response as base64, but generic endpoints (Ollama,
        // llama.cpp, …) return a plain float array and don't honor base64,
        // which would silently yield a corrupted vector. `float` is the
        // universally supported format (OpenAI included).
        { model: model.id, input: request.text, encoding_format: 'float' },
        { signal: request.signal },
      )
      const vector = result.data[0]?.embedding
      if (!vector) {
        throw new ProviderServerError('The embeddings endpoint returned no vector')
      }
      return { vector, inputTokens: result.usage?.prompt_tokens }
    } catch (err) {
      throw mapApiError(err)
    }
  },
}
