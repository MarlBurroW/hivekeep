/**
 * Generic OpenAI-compatible image generation provider — a BYO-endpoint
 * companion of the `openai-compatible` LLM / embedding providers
 * (`src/server/llm/llm/openai-compatible.ts`). Same `type`, so a single
 * provider row can serve chat, embeddings, and images (capabilities are
 * auto-detected from the registries).
 *
 * Reuses the official OpenAI Images API shape against the user-supplied
 * base URL + optional API key:
 *   POST {baseUrl}/images/generations   (text-to-image)
 *   POST {baseUrl}/images/edits         (img2img, when imageInputs is set)
 *
 * This is the same wire protocol the branded `openai` image provider
 * talks to — no private dialect. Gateways that implement it (LiteLLM,
 * NewAPI, LocalAI, and similar) work; chat-only servers (stock Ollama,
 * llama.cpp) will 404 on `/images/generations`.
 *
 * Design choices (vs the branded `openai` image provider):
 *  - Base URL is configurable; the API key is OPTIONAL (local shims
 *    need none).
 *  - `listModels` filters the endpoint's `/models` with a name
 *    heuristic — a generic catalogue mixes chat, embed, and image
 *    ids, and dumping every chat model into `list_image_models` would
 *    confuse Agents. An optional `imageModels` config field lets the
 *    user advertise ids the heuristic misses.
 *  - No static fallback catalogue (unlike OpenAI, we cannot assume
 *    dall-e / gpt-image exist on a random endpoint).
 *  - Response accepts both `b64_json` and `url` (some shims default
 *    to a hosted URL and ignore `response_format`).
 */

import OpenAI, { APIError, toFile } from 'openai'
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
import { createLogger } from '@/server/logger'

const log = createLogger('openai-compatible-image')

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'baseUrl',
    type: 'url',
    label: 'Base URL',
    required: true,
    placeholder: 'http://localhost:11434/v1',
    description:
      'OpenAI-compatible endpoint base, including the version path (e.g. `…/v1`). The provider appends `/images/generations`, `/images/edits`, and `/models`. Works with LiteLLM, NewAPI, LocalAI, and similar Images-API shims.',
  },
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: false,
    placeholder: 'sk-… (leave empty if your server needs no key)',
    description: 'Optional. Local servers usually need none.',
  },
  {
    key: 'imageModels',
    type: 'text',
    label: 'Image model IDs',
    required: false,
    placeholder: 'dall-e-3, flux-schnell (optional)',
    description:
      'Optional. Comma-separated model IDs to treat as image models, in addition to ids the catalogue heuristic already recognizes (dall-e, gpt-image, flux, sdxl, imagen, …). Use this when your /models listing uses names Hivekeep does not recognize.',
  },
]

/** Per-family parameter schemas for well-known OpenAI image families
 *  when they appear on a compatible endpoint. Unknown ids get `{}` —
 *  a generic catalogue has no discovery endpoint for knobs. */
const PARAM_SCHEMAS: Record<string, Record<string, ImageParamSpec>> = {
  'gpt-image-1': {
    quality: {
      type: 'string',
      enum: ['auto', 'low', 'medium', 'high'],
      description: 'Rendering effort vs latency. "auto" lets the model decide; "high" costs more and takes longer but produces a crisper result.',
    },
    background: {
      type: 'string',
      enum: ['transparent', 'opaque', 'auto'],
      description: '`transparent` requires output_format png or webp. `auto` defers to the model.',
    },
    output_format: {
      type: 'string',
      enum: ['png', 'jpeg', 'webp'],
      default: 'png',
    },
    output_compression: {
      type: 'integer',
      minimum: 0,
      maximum: 100,
      description: 'Only effective when output_format is jpeg or webp. 0 = max compression, 100 = best quality.',
    },
    moderation: {
      type: 'string',
      enum: ['low', 'auto'],
      description: '`low` relaxes moderation; `auto` is the default.',
    },
  },
  'dall-e-3': {
    quality: {
      type: 'string',
      enum: ['standard', 'hd'],
      default: 'standard',
      description: '`hd` is finer-grained but costs roughly 2x and takes longer.',
    },
    style: {
      type: 'string',
      enum: ['vivid', 'natural'],
      default: 'vivid',
      description: '`vivid` is hyper-real / cinematic. `natural` is more documentary / understated.',
    },
  },
  'dall-e-2': {},
}

const KNOWN_SIZES: Record<string, string[]> = {
  'gpt-image-1': ['1024x1024', '1024x1536', '1536x1024', 'auto'],
  'dall-e-3': ['1024x1024', '1024x1792', '1792x1024'],
  'dall-e-2': ['256x256', '512x512', '1024x1024'],
}

/** @internal exported for tests. */
export interface OpenAICompatibleImageModel {
  id: string
  object?: string
  owned_by?: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getBaseUrl(config: ProviderConfig): string {
  const raw = config['baseUrl']?.trim()
  if (!raw) throw new InvalidRequestError('Missing base URL for OpenAI-compatible images')
  return raw.replace(/\/+$/, '')
}

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
    if (status === 404) {
      return new InvalidRequestError(
        'This endpoint does not expose the OpenAI Images API (`/images/generations`). Point the connector at a gateway that implements it (LiteLLM, NewAPI, LocalAI, …), or use the built-in OpenAI / Gemini image providers.',
        err,
      )
    }
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
 * Parse the optional `imageModels` config field (comma / newline /
 * whitespace separated ids). Empty / missing → [].
 *
 * @internal exported for tests.
 */
export function parseImageModelIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\s,;]+/)) {
    const id = part.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Whether a `/models` id looks like an *image generation* model rather
 * than chat, embeddings, STT, or vision-language. Conservative: vision
 * LLMs (llava, qwen-vl, gpt-4o, …) must not land in `list_image_models`.
 *
 * @internal exported for tests.
 */
export function isLikelyImageModelId(id: string): boolean {
  if (!id) return false
  const n = id.toLowerCase()

  // Vision / multimodal chat — not image generation.
  if (
    n.includes('vision')
    || n.includes('llava')
    || n.includes('moondream')
    || n.includes('pixtral')
    || n.includes('internvl')
    || /(^|[-_./:])vl([-_./:]|$)/.test(n)
  ) {
    return false
  }

  if (n.includes('dall-e') || n.includes('dalle') || n.includes('gpt-image')) return true

  const tokens = [
    'flux',
    'sdxl',
    'stable-diffusion',
    'stable_diffusion',
    'sd-3',
    'sd3',
    'sd-xl',
    'sd-turbo',
    'imagen',
    'midjourney',
    'ideogram',
    'recraft',
    'kandinsky',
    'playground',
    'lumina',
    'hidream',
    'seedream',
    'seededit',
    'kolors',
    'cogview',
    'hunyuan-image',
    'hunyuan-dit',
    'aura-flow',
    'auraflow',
    'pixart',
    'kontext',
    'txt2img',
    'text-to-image',
    'image-gen',
    'imagegen',
  ]
  for (const token of tokens) {
    if (n.includes(token)) return true
  }

  // `image` as a path/id segment (`gemini-2.5-flash-image`, `qwen-image`).
  if (/(^|[-_./])image([-_./]|$)/.test(n)) return true
  return false
}

/**
 * Infer `maxImageInputs` from the id. Conservative default is 0
 * (text-to-image only) — claiming edit support on a generate-only
 * model would send Agents down a 400 path.
 *
 * @internal exported for tests.
 */
export function inferMaxImageInputs(id: string): number {
  const n = id.toLowerCase()
  if (n.includes('dall-e-3') || n.includes('dalle-3') || n.includes('dalle3')) return 0
  if (n.includes('dall-e-2') || n.includes('dalle-2') || n.includes('dalle2')) return 1
  if (n.includes('gpt-image')) return 1
  if (
    n.includes('kontext')
    || n.includes('img2img')
    || n.includes('image-edit')
    || n.includes('seededit')
    || /(?:^|[-_./])edit(?:[-_./]|$)/.test(n)
  ) {
    return 1
  }
  return 0
}

/**
 * Map a catalogue entry to an `ImageModel`, or null if it has no id.
 * Applies the image-name heuristic unless `force` is set (configured
 * allowlist ids skip the filter).
 *
 * @internal exported for tests.
 */
export function mapModel(
  model: OpenAICompatibleImageModel,
  opts?: { force?: boolean },
): ImageModel | null {
  if (!model.id) return null
  if (!opts?.force && !isLikelyImageModelId(model.id)) return null
  const knownSizes = KNOWN_SIZES[model.id]
  return {
    id: model.id,
    name: model.id,
    maxImageInputs: inferMaxImageInputs(model.id),
    ...(knownSizes ? { supportedSizes: knownSizes } : {}),
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  const payload = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64
  const binary = globalThis.atob(payload)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function mediaTypeFromParams(params: Record<string, unknown> | undefined): string {
  const format = params?.['output_format']
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

function mediaTypeFromContentType(header: string | null): string {
  if (!header) return 'image/png'
  const mime = header.split(';')[0]?.trim().toLowerCase()
  if (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/webp' || mime === 'image/png') {
    return mime === 'image/jpg' ? 'image/jpeg' : mime
  }
  return 'image/png'
}

async function decodeImageItem(
  item: { b64_json?: string | null; url?: string | null } | undefined,
  params: Record<string, unknown> | undefined,
): Promise<ImageResult> {
  if (item?.b64_json) {
    return { data: base64ToUint8Array(item.b64_json), mediaType: mediaTypeFromParams(params) }
  }
  if (item?.url) {
    if (item.url.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,(.+)$/i.exec(item.url)
      if (!match?.[2]) {
        throw new ProviderServerError('OpenAI-compatible image API returned a malformed data URL')
      }
      return {
        data: base64ToUint8Array(match[2]),
        mediaType: mediaTypeFromContentType(match[1] ?? null),
      }
    }
    let imageUrl: URL
    try {
      imageUrl = new URL(item.url)
    } catch {
      throw new ProviderServerError('OpenAI-compatible image API returned an invalid image URL')
    }
    // Bun can fetch file: URLs too. Only download remote HTTP(S) images.
    if (imageUrl.protocol !== 'http:' && imageUrl.protocol !== 'https:') {
      throw new ProviderServerError('OpenAI-compatible image API returned a non-HTTP(S) image URL')
    }
    let res: Response
    try {
      res = await fetch(imageUrl)
    } catch (err) {
      throw new NetworkError(
        `Failed to fetch image URL returned by the endpoint: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined,
      )
    }
    if (!res.ok) {
      throw new ProviderServerError(`Image URL returned HTTP ${res.status}`, res.status)
    }
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mediaType: mediaTypeFromContentType(res.headers.get('content-type')),
    }
  }
  throw new ProviderServerError('OpenAI-compatible image API returned no image data')
}

function isDallEFamily(id: string): boolean {
  const n = id.toLowerCase()
  return n.includes('dall-e') || n.includes('dalle')
}

function isGptImageFamily(id: string): boolean {
  return id.toLowerCase().includes('gpt-image')
}

// ─── Provider implementation ─────────────────────────────────────────────────

export const openaiCompatibleImageProvider: ImageProvider = {
  type: 'openai-compatible',
  displayName: 'OpenAI-compatible (Images)',
  optionalApiKey: true,
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
      // GET /models doubles as a reachability + credential probe — same
      // as the LLM / embedding companions. We do not POST a dummy
      // generation just to verify the Images route exists.
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

  async listModels(config: ProviderConfig): Promise<ImageModel[]> {
    const extraIds = parseImageModelIds(config['imageModels'])
    const extraSet = new Set(extraIds)

    const baseUrl = getBaseUrl(config)
    const apiKey = getApiKey(config)
    let payload: { data?: OpenAICompatibleImageModel[] }
    try {
      const res = await fetch(`${baseUrl}/models`, { headers: authHeaders(apiKey) })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new AuthError(`Endpoint rejected the API key (HTTP ${res.status})`)
        }
        throw new ProviderServerError(`/models returned HTTP ${res.status}`, res.status)
      }
      payload = (await res.json()) as { data?: OpenAICompatibleImageModel[] }
    } catch (err) {
      throw mapApiError(err)
    }

    const seen = new Set<string>()
    const out: ImageModel[] = []
    for (const raw of payload.data ?? []) {
      const mapped = mapModel(raw, { force: extraSet.has(raw.id) })
      if (!mapped) continue
      if (seen.has(mapped.id)) continue
      seen.add(mapped.id)
      out.push(mapped)
    }
    // Configured ids that the listing omitted (or that failed the
    // heuristic) still need to surface so the user can pick them.
    for (const id of extraIds) {
      if (seen.has(id)) continue
      const mapped = mapModel({ id }, { force: true })
      if (mapped) {
        seen.add(id)
        out.push(mapped)
      }
    }
    return out
  },

  async describeModel(model: ImageModel): Promise<ImageModelParamsSchema> {
    return { params: PARAM_SCHEMAS[model.id] ?? {} }
  },

  async generate(
    model: ImageModel,
    request: ImageRequest,
    config: ProviderConfig,
  ): Promise<ImageResult> {
    const client = createClient(config)
    const size = (request.size ?? '1024x1024') as '1024x1024'
    const extraParams = request.params ?? {}

    const firstInput = request.imageInputs?.[0]
    if (request.imageInputs && request.imageInputs.length > 1) {
      log.warn(
        { modelId: model.id, given: request.imageInputs.length },
        'OpenAI Images API accepts a single input — dropping extras',
      )
    }

    let response: { data?: Array<{ b64_json?: string | null; url?: string | null }> }
    try {
      if (firstInput) {
        const file = await toFile(firstInput.data, 'input.png', {
          type: firstInput.mediaType,
        })
        response = await client.images.edit({
          size,
          ...extraParams,
          model: model.id,
          image: file,
          prompt: request.prompt,
          n: 1,
        }, { signal: request.signal })
      } else {
        // dall-e (official OpenAI) defaults to a hosted URL unless we
        // ask for b64. gpt-image rejects `response_format`. Unknown
        // families: omit the flag (some shims 400 on it) and accept
        // either b64_json or url below.
        const wantsB64 = isDallEFamily(model.id) && !isGptImageFamily(model.id)
        response = await client.images.generate({
          size,
          ...extraParams,
          model: model.id,
          prompt: request.prompt,
          n: 1,
          ...(wantsB64 ? { response_format: 'b64_json' as const } : {}),
        }, { signal: request.signal })
      }
    } catch (err) {
      throw mapApiError(err)
    }

    return decodeImageItem(response.data?.[0], extraParams)
  },
}
