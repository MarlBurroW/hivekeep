/**
 * OpenRouter embeddings provider.
 *
 * OpenRouter exposes a first-class OpenAI-compatible `/embeddings` endpoint
 * at https://openrouter.ai/api/v1/embeddings and lists embedding models via
 * the dedicated `GET /embeddings/models` endpoint. Do not use the general
 * `/models` endpoint here: it defaults to text-output models unless queried
 * with output modality filters, so live embedding listings can silently vanish.
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

const BASE_URL = 'https://openrouter.ai/api/v1'

const ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://hivekeep.marlburrow.io',
  'X-Title': 'Hivekeep',
}

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-or-…',
    description: 'OpenRouter API key used for embeddings. Get one at https://openrouter.ai/keys',
  },
]

/** @internal exported for tests. */
export interface OpenRouterEmbeddingModel {
  id: string
  name?: string
  context_length?: number | null
  architecture?: {
    output_modalities?: string[]
  }
  pricing?: {
    prompt?: string
  }
}

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']?.trim()
  if (!apiKey) throw new AuthError('Missing OpenRouter API key')
  return apiKey
}

function createClient(config: ProviderConfig): OpenAI {
  return new OpenAI({
    apiKey: getApiKey(config),
    baseURL: BASE_URL,
    defaultHeaders: ATTRIBUTION_HEADERS,
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

function isEmbeddingModel(model: OpenRouterEmbeddingModel): boolean {
  const out = model.architecture?.output_modalities
  if (!out || out.length === 0) return false
  return out.some((m) => m === 'embedding' || m === 'embeddings')
}

function convertInputPricing(model: OpenRouterEmbeddingModel): EmbeddingModel['pricing'] | undefined {
  const raw = model.pricing?.prompt
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return undefined
  return { input: n * 1_000_000 }
}

/** @internal exported for tests. */
export function mapModel(model: OpenRouterEmbeddingModel): EmbeddingModel | null {
  if (!model.id) return null
  if (!isEmbeddingModel(model)) return null

  const out: EmbeddingModel = {
    id: model.id,
    name: model.name ?? model.id,
  }
  const maxInputTokens = model.context_length ?? undefined
  if (maxInputTokens != null) out.maxInputTokens = maxInputTokens
  const pricing = convertInputPricing(model)
  if (pricing) out.pricing = pricing
  return out
}

export const openrouterEmbeddingProvider: EmbeddingProvider = {
  type: 'openrouter',
  displayName: 'OpenRouter (Embeddings)',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const apiKey = getApiKey(config)
      const res = await fetch(`${BASE_URL}/key`, {
        headers: { Authorization: `Bearer ${apiKey}`, ...ATTRIBUTION_HEADERS },
      })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'Invalid OpenRouter API key' }
      }
      return { valid: false, error: `OpenRouter returned HTTP ${res.status}` }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<EmbeddingModel[]> {
    const apiKey = getApiKey(config)
    let payload: { data?: OpenRouterEmbeddingModel[] }
    try {
      const res = await fetch(`${BASE_URL}/embeddings/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, ...ATTRIBUTION_HEADERS },
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`OpenRouter rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(`OpenRouter /embeddings/models returned HTTP ${res.status}`, res.status)
      }
      payload = (await res.json()) as { data?: OpenRouterEmbeddingModel[] }
    } catch (err) {
      throw mapApiError(err)
    }

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
        { model: model.id, input: request.text, encoding_format: 'float' },
        { signal: request.signal },
      )
      const vector = result.data[0]?.embedding
      if (!vector) throw new ProviderServerError('OpenRouter embeddings endpoint returned no vector')
      return { vector, inputTokens: result.usage?.prompt_tokens }
    } catch (err) {
      throw mapApiError(err)
    }
  },
}
