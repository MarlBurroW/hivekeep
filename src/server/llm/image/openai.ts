/**
 * OpenAI image generation provider.
 *
 * Talks to the official `openai` SDK. Supports the two model families OpenAI
 * exposes today: `gpt-image-*` (default modern family, accepts image input
 * for editing) and `dall-e-3` (text-to-image only, needs the explicit
 * `response_format: 'b64_json'` flag to return base64 rather than a URL).
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
import type { ImageModelParamsSchema, ImageParamSpec } from '@gezy/sdk'
import { createLogger } from '@/server/logger'

const log = createLogger('openai-image')

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'sk-…',
    description: 'OpenAI API key used for image generation.',
  },
]

/** Image model families known to OpenAI today. Anything not matched falls
 *  through with conservative defaults. */
const KNOWN_MODELS: ImageModel[] = [
  {
    id: 'gpt-image-1',
    name: 'GPT Image 1',
    maxImageInputs: 1,
    supportedSizes: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
  },
  {
    id: 'dall-e-3',
    name: 'DALL·E 3',
    maxImageInputs: 0,
    supportedSizes: ['1024x1024', '1024x1792', '1792x1024'],
  },
  {
    id: 'dall-e-2',
    name: 'DALL·E 2',
    maxImageInputs: 1,
    supportedSizes: ['256x256', '512x512', '1024x1024'],
  },
]

/**
 * Per-family parameter schemas surfaced through `describe_image_model`.
 * OpenAI has no discovery endpoint for these — the docs list them,
 * and they're stable per family. We hand-author them here so the LLM
 * can populate `generate_image`'s `params` field deliberately.
 *
 * `n` is intentionally omitted: the host always asks for 1 (the tool
 * returns a single file). Adding `n` would let the LLM ask for more
 * and the host would silently drop the extras.
 */
const PARAM_SCHEMAS: Record<string, Record<string, ImageParamSpec>> = {
  'gpt-image-1': {
    quality: {
      type: 'string',
      enum: ['auto', 'low', 'medium', 'high'],
      description: 'Rendering effort vs latency. "auto" lets OpenAI decide; "high" costs more and takes longer but produces a crisper result.',
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

function createClient(config: ProviderConfig): OpenAI {
  const apiKey = config['apiKey']
  if (!apiKey) throw new AuthError('Missing OpenAI API key')
  return new OpenAI({ apiKey })
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

/** Filter the raw `/v1/models` listing to entries we recognise as image
 *  models. OpenAI's listing mixes every model the account can touch, so
 *  it's safest to match against our known set. */
function isImageModelId(id: string): boolean {
  if (id.startsWith('gpt-image')) return true
  if (id.startsWith('dall-e')) return true
  return false
}

export const openaiImageProvider: ImageProvider = {
  type: 'openai',
  displayName: 'OpenAI (Images)',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const client = createClient(config)
      await client.models.list()
      return { valid: true }
    } catch (err) {
      return { valid: false, error: mapApiError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<ImageModel[]> {
    const client = createClient(config)
    try {
      const page = await client.models.list()
      const seen = new Set<string>()
      const out: ImageModel[] = []
      for (const m of page.data) {
        if (!isImageModelId(m.id)) continue
        if (seen.has(m.id)) continue
        seen.add(m.id)
        const known = KNOWN_MODELS.find((k) => k.id === m.id)
        out.push(known ?? { id: m.id, name: m.id })
      }
      // Surface known models even when the listing is empty (some accounts
      // restrict /v1/models). Skip duplicates already added above.
      for (const k of KNOWN_MODELS) {
        if (!seen.has(k.id)) out.push(k)
      }
      return out
    } catch (err) {
      throw mapApiError(err)
    }
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

    // OpenAI's edit endpoint takes a single `image` (gpt-image-1, dall-e-2).
    // If the LLM passed more than one we warn and use the first — the
    // model's `maxImageInputs: 1` was the contract advertised through
    // list_image_models so this is a caller bug, not a provider one.
    const firstInput = request.imageInputs?.[0]
    if (request.imageInputs && request.imageInputs.length > 1) {
      log.warn(
        { modelId: model.id, given: request.imageInputs.length },
        'OpenAI image models accept a single input — dropping extras',
      )
    }

    // Free-form per-model params merged on top of our minimal envelope.
    // `n` is intentionally not exposed — host always wants 1.
    const extraParams = request.params ?? {}

    let response
    try {
      if (firstInput) {
        const file = await toFile(firstInput.data, 'input.png', {
          type: firstInput.mediaType,
        })
        response = await client.images.edit({
          model: model.id,
          image: file,
          prompt: request.prompt,
          size,
          ...extraParams,
        }, { signal: request.signal })
      } else {
        const isDallE = model.id.startsWith('dall-e')
        response = await client.images.generate({
          model: model.id,
          prompt: request.prompt,
          size,
          ...(isDallE ? { response_format: 'b64_json' as const } : {}),
          ...extraParams,
        }, { signal: request.signal })
      }
    } catch (err) {
      throw mapApiError(err)
    }

    const item = response.data?.[0]
    const base64 = item?.b64_json
    if (!base64) {
      throw new ProviderServerError('OpenAI image API returned no image data')
    }
    const bytes = base64ToUint8Array(base64)
    return { data: bytes, mediaType: 'image/png' }
  },
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = globalThis.atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
