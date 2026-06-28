/**
 * OpenRouter image generation provider.
 *
 * OpenRouter's dedicated image API is documented at:
 *   GET  https://openrouter.ai/api/v1/images/models
 *   GET  https://openrouter.ai/api/v1/images/models/:author/:slug/endpoints
 *   POST https://openrouter.ai/api/v1/images
 *
 * The model listing exposes typed `supported_parameters` descriptors and an
 * `input_references` range when image inputs are accepted. Hivekeep maps the
 * top-level descriptor conservatively, and `describeModel()` fetches the
 * endpoint-specific descriptors on demand when available. Generation uses the
 * normalized request shape and asks for one image; streaming is intentionally
 * not used because Hivekeep's ImageProvider contract returns one final byte
 * payload.
 */

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
  ImageProvider,
  ImageModel,
  ImageRequest,
  ImageResult,
} from '@/server/llm/image/types'
import type { ImageModelParamsSchema, ImageParamSpec } from '@hivekeep/sdk'

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
    description: 'OpenRouter API key used for image generation. Get one at https://openrouter.ai/keys',
  },
]

type CapabilityDescriptor =
  | { type: 'boolean' }
  | { type: 'enum'; values?: string[] }
  | { type: 'range'; min?: number; max?: number }

/** @internal exported for tests. */
export interface OpenRouterImageModel {
  id: string
  name?: string
  architecture?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
  supported_parameters?: Record<string, CapabilityDescriptor>
  supports_streaming?: boolean
  endpoints?: string
}

interface OpenRouterImageEndpoint {
  supported_parameters?: Record<string, CapabilityDescriptor>
  pricing?: Array<{ billable?: string; unit?: string; cost_usd?: number }>
}

interface OpenRouterImageResponseItem {
  b64_json?: string
  image_b64?: string
  data?: string
  url?: string
  media_type?: string
  mediaType?: string
  mime_type?: string
}

interface OpenRouterImageResponse {
  data?: OpenRouterImageResponseItem[]
  images?: OpenRouterImageResponseItem[]
  b64_json?: string
  image_b64?: string
  url?: string
  media_type?: string
  mediaType?: string
  mime_type?: string
}

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']?.trim()
  if (!apiKey) throw new AuthError('Missing OpenRouter API key')
  return apiKey
}

function headers(config: ProviderConfig): Record<string, string> {
  return { Authorization: `Bearer ${getApiKey(config)}`, ...ATTRIBUTION_HEADERS }
}

function mapHttpError(status: number, message: string, cause?: unknown): HivekeepProviderError {
  if (status === 401 || status === 403) return new AuthError(message, cause)
  if (status === 429) return new RateLimitError(message, undefined, cause)
  if (status >= 400 && status < 500) return new InvalidRequestError(message, cause)
  if (status >= 500) return new ProviderServerError(message, status, cause)
  return new ProviderServerError(message, status, cause)
}

async function parseErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `OpenRouter returned HTTP ${res.status}`
  try {
    const json = JSON.parse(text) as { error?: { message?: string } }
    return json.error?.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

function mapApiError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

function isImageOutputModel(model: OpenRouterImageModel): boolean {
  const out = model.architecture?.output_modalities
  if (!out || out.length === 0) return false
  return out.includes('image')
}

/** @internal exported for tests. */
export function imageModelEndpointsPath(modelId: string): string {
  return `${BASE_URL}/images/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`
}

function maxImageInputsFrom(params: Record<string, CapabilityDescriptor> | undefined): number | undefined {
  const inputRefs = params?.['input_references']
  if (inputRefs?.type === 'range' && typeof inputRefs.max === 'number') return Math.max(0, Math.floor(inputRefs.max))
  return undefined
}

function pricingFrom(endpoints?: OpenRouterImageEndpoint[]): ImageModel['pricing'] | undefined {
  const perImage = endpoints
    ?.flatMap((e) => e.pricing ?? [])
    .find((p) => p.billable === 'output_image' && p.unit === 'image' && typeof p.cost_usd === 'number')
    ?.cost_usd
  return perImage == null ? undefined : { perImage }
}

/** @internal exported for tests. */
export function mapParamSpec(desc: CapabilityDescriptor): ImageParamSpec | null {
  if (desc.type === 'boolean') return { type: 'boolean' }
  if (desc.type === 'enum') return { type: 'string', enum: desc.values ?? [] }
  if (desc.type === 'range') {
    const integerish = Number.isInteger(desc.min) && Number.isInteger(desc.max)
    return {
      type: integerish ? 'integer' : 'number',
      ...(typeof desc.min === 'number' ? { minimum: desc.min } : {}),
      ...(typeof desc.max === 'number' ? { maximum: desc.max } : {}),
    }
  }
  return null
}

function paramsSchemaFrom(params: Record<string, CapabilityDescriptor> | undefined): ImageModelParamsSchema {
  const out: Record<string, ImageParamSpec> = {}
  for (const [key, desc] of Object.entries(params ?? {})) {
    // Hivekeep always requests one image and provides references via imageInputs.
    if (key === 'n' || key === 'input_references') continue
    const mapped = mapParamSpec(desc)
    if (mapped) out[key] = mapped
  }
  return { params: out }
}

/** @internal exported for tests. */
export function mapModel(model: OpenRouterImageModel, endpoints?: OpenRouterImageEndpoint[]): ImageModel | null {
  if (!model.id) return null
  if (!isImageOutputModel(model)) return null
  const out: ImageModel = {
    id: model.id,
    name: model.name ?? model.id,
    maxImageInputs: maxImageInputsFrom(model.supported_parameters) ?? 0,
  }
  const pricing = pricingFrom(endpoints)
  if (pricing) out.pricing = pricing
  return out
}

function dataUrlFor(input: { data: Uint8Array; mediaType: string }): string {
  let binary = ''
  for (let i = 0; i < input.data.length; i++) binary += String.fromCharCode(input.data[i]!)
  return `data:${input.mediaType};base64,${globalThis.btoa(binary)}`
}

function base64ToUint8Array(b64: string): Uint8Array {
  const stripped = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
  const binary = globalThis.atob(stripped)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function firstImage(payload: OpenRouterImageResponse): OpenRouterImageResponseItem | undefined {
  const listed = payload.data?.[0] ?? payload.images?.[0]
  if (listed) return listed
  if (payload.b64_json || payload.image_b64 || payload.url || typeof payload.data === 'string') {
    return {
      b64_json: payload.b64_json,
      image_b64: payload.image_b64,
      data: typeof payload.data === 'string' ? payload.data : undefined,
      url: payload.url,
      media_type: payload.media_type,
      mediaType: payload.mediaType,
      mime_type: payload.mime_type,
    }
  }
  return undefined
}

function mediaTypeFrom(item: OpenRouterImageResponseItem): string {
  const explicit = item.media_type ?? item.mediaType ?? item.mime_type
  if (explicit) return explicit
  const raw = item.b64_json ?? item.image_b64 ?? item.data
  const match = typeof raw === 'string' ? /^data:([^;,]+)/.exec(raw) : null
  return match?.[1] ?? 'image/png'
}

async function imageResultFrom(payload: OpenRouterImageResponse, signal?: AbortSignal): Promise<ImageResult> {
  const item = firstImage(payload)
  if (!item) throw new ProviderServerError('OpenRouter image API returned no image data')
  const base64 = item.b64_json ?? item.image_b64 ?? item.data
  if (base64) return { data: base64ToUint8Array(base64), mediaType: mediaTypeFrom(item) }
  if (item.url) {
    const res = await fetch(item.url, { signal })
    if (!res.ok) throw new ProviderServerError(`OpenRouter image URL returned HTTP ${res.status}`, res.status)
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { data: bytes, mediaType: res.headers.get('content-type') ?? 'image/png' }
  }
  throw new ProviderServerError('OpenRouter image API returned no image bytes or URL')
}

export const openrouterImageProvider: ImageProvider = {
  type: 'openrouter',
  displayName: 'OpenRouter (Images)',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const res = await fetch(`${BASE_URL}/key`, { headers: headers(config) })
      if (res.ok) return { valid: true }
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid OpenRouter API key' }
      return { valid: false, error: `OpenRouter returned HTTP ${res.status}` }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<ImageModel[]> {
    try {
      const res = await fetch(`${BASE_URL}/images/models`, { headers: headers(config) })
      if (!res.ok) throw mapHttpError(res.status, await parseErrorBody(res))
      const payload = (await res.json()) as { data?: OpenRouterImageModel[] }
      return (payload.data ?? []).map((raw) => mapModel(raw)).filter((m): m is ImageModel => Boolean(m))
    } catch (err) {
      throw mapApiError(err)
    }
  },

  async describeModel(model: ImageModel, config: ProviderConfig): Promise<ImageModelParamsSchema> {
    try {
      const res = await fetch(imageModelEndpointsPath(model.id), { headers: headers(config) })
      if (!res.ok) return { params: {} }
      const payload = (await res.json()) as { endpoints?: OpenRouterImageEndpoint[] }
      // Use the first endpoint as the default router target. Endpoint-specific
      // provider selection remains available through request.params.provider.
      return paramsSchemaFrom(payload.endpoints?.[0]?.supported_parameters)
    } catch {
      return { params: {} }
    }
  },

  async generate(model: ImageModel, request: ImageRequest, config: ProviderConfig): Promise<ImageResult> {
    const maxRefs = model.maxImageInputs ?? 0
    const inputReferences = (request.imageInputs ?? []).slice(0, Math.max(0, maxRefs)).map(dataUrlFor)
    const body: Record<string, unknown> = {
      model: model.id,
      prompt: request.prompt,
      n: 1,
      ...request.params,
    }
    if (request.size) body['size'] = request.size
    if (inputReferences.length > 0) body['input_references'] = inputReferences

    try {
      const res = await fetch(`${BASE_URL}/images`, {
        method: 'POST',
        headers: { ...headers(config), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      })
      if (!res.ok) throw mapHttpError(res.status, await parseErrorBody(res))
      const payload = (await res.json()) as OpenRouterImageResponse
      return imageResultFrom(payload, request.signal)
    } catch (err) {
      throw mapApiError(err)
    }
  },
}
