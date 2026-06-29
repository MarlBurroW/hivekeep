/**
 * Google Gemini image generation provider (AI Studio API key).
 *
 * AI Studio exposes two image families that share the same API key
 * but use different endpoints:
 *
 * - **Nano Banana** (`gemini-2.5-flash-image-preview` and future
 *   `*-image-*` variants): hits the regular `:generateContent`
 *   endpoint — the model returns the image inline as a
 *   `{ inlineData: { mimeType, data } }` part in the response. Can
 *   accept input images via the same shape, enabling edit /
 *   compose / multi-reference flows.
 *
 * - **Imagen** (`imagen-3.0-generate-002`, `imagen-3.0-fast-generate-001`,
 *   future `imagen-*-generate-*` variants): hits the `:predict`
 *   endpoint with a Vertex-style `{ instances, parameters }` body
 *   and gets back `{ predictions: [{ bytesBase64Encoded, mimeType }] }`.
 *   Text-to-image only, no image input. Exposes structured
 *   parameters (aspectRatio, negativePrompt, personGeneration,
 *   safetyFilterLevel).
 *
 * Family detection is schema-driven: `supportedGenerationMethods`
 * picks the endpoint, name pattern catches the family. No hardcoded
 * model-id allowlist — a future `gemini-4-flash-image-edit` or
 * `imagen-5-fast` slots in automatically.
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
import type { ImageModelParamsSchema, ImageParamSpec } from '@gezy/sdk'
import { createLogger } from '@/server/logger'

const log = createLogger('gemini-image')

const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'AIza…',
    description: 'Same key as the Gemini LLM provider. Get one at https://aistudio.google.com/apikey',
  },
]

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ─── Family detection ──────────────────────────────────────────────────────
//
// Google's /v1beta/models listing exposes image-gen models under two
// dispatch styles. We tag each model in listModels() and let
// generate() branch on the tag. Name patterns are structural
// (modality markers in the id), not specific-id allowlists.

type Family = 'generate-content' | 'predict'

interface FamilyTag {
  family: Family
}

const NANO_BANANA_PATTERN = /(^|[-_])image([-_]|$)/i
// Nano Banana Pro family: `gemini-3-pro-image`, future `gemini-N-pro-image`.
// Higher reference-image budget than the standard Flash image variant.
const NANO_BANANA_PRO_PATTERN = /^gemini-\d+-pro-image/i
const IMAGEN_PATTERN = /^imagen-/i

// Reference-image budgets are not exposed by `/v1beta/models` — Google
// publishes them in docs only. Per Vertex AI docs:
//   - Nano Banana (gemini-2.5-flash-image / -preview): "works best with up
//     to 3 images" (technical cap is far higher but quality degrades).
//   - Nano Banana Pro (gemini-3-pro-image): up to 14 reference images,
//     character consistency on up to 5 people.
const NANO_BANANA_MAX_INPUTS = 3
const NANO_BANANA_PRO_MAX_INPUTS = 14

function familyForModel(
  id: string,
  methods: ReadonlyArray<string>,
): Family | null {
  if (methods.includes('generateContent') && NANO_BANANA_PATTERN.test(id)) {
    return 'generate-content'
  }
  if (methods.includes('predict') && IMAGEN_PATTERN.test(id)) {
    return 'predict'
  }
  return null
}

// ─── Per-model params surfaced through describe_image_model ─────────────────
//
// Nano Banana has no structured per-request knobs — everything is
// prompt-driven. Imagen has a small set of well-documented parameters.
// Both schemas are static; Google doesn't expose them in the model
// listing.

const IMAGEN_PARAMS: Record<string, ImageParamSpec> = {
  aspectRatio: {
    type: 'string',
    enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
    default: '1:1',
    description: 'Output image aspect ratio.',
  },
  negativePrompt: {
    type: 'string',
    description: 'Tell the model what to AVOID generating (e.g. "blurry, low quality, text overlays").',
  },
  personGeneration: {
    type: 'string',
    enum: ['allow_all', 'allow_adult', 'dont_allow'],
    default: 'allow_adult',
    description: 'Restrict person generation. `dont_allow` blocks any person; `allow_adult` blocks minors; `allow_all` is permissive.',
  },
  safetyFilterLevel: {
    type: 'string',
    enum: ['block_low_and_above', 'block_medium_and_above', 'block_only_high', 'block_none'],
    default: 'block_medium_and_above',
    description: 'Safety filter strictness. `block_none` disables filtering; `block_low_and_above` is the most restrictive.',
  },
}

// ─── Auth + error mapping ────────────────────────────────────────────────────

function requireApiKey(config: ProviderConfig): string {
  const k = config['apiKey']
  if (!k) throw new AuthError('Missing Google AI Studio API key')
  return k
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-goog-api-key': apiKey,
    'Content-Type': 'application/json',
  }
}

function errorFromResponse(status: number, body: string): HivekeepProviderError {
  let message = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) message = parsed.error.message
  } catch { /* keep raw body */ }
  if (status === 401 || status === 403) return new AuthError(message)
  if (status === 429) return new RateLimitError(message)
  if (status >= 400 && status < 500) return new InvalidRequestError(message)
  return new ProviderServerError(message, status)
}

function wrapError(err: unknown): HivekeepProviderError {
  if (err instanceof HivekeepProviderError) return err
  if (err instanceof Error) return new NetworkError(err.message, err)
  return new NetworkError(String(err))
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = globalThis.atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Map a `WxH` size string to the closest Imagen aspectRatio enum
 * value. Imagen doesn't accept arbitrary pixel sizes — its only
 * size control is one of 5 aspect ratios. Reduced via GCD; falls
 * back to '1:1' when the ratio isn't in the supported set.
 */
function aspectRatioFor(size: string | undefined): string | undefined {
  if (!size) return undefined
  const [wStr, hStr] = size.split('x')
  const w = Number(wStr)
  const h = Number(hStr)
  if (!w || !h) return undefined
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(w, h)
  const ratio = `${w / g}:${h / g}`
  const allowed = new Set(['1:1', '3:4', '4:3', '9:16', '16:9'])
  return allowed.has(ratio) ? ratio : undefined
}

// ─── Wire types ─────────────────────────────────────────────────────────────

interface GeminiModelListing {
  models?: Array<{
    name: string
    displayName?: string
    description?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
    supportedGenerationMethods?: string[]
  }>
  nextPageToken?: string
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        inlineData?: { mimeType?: string; data?: string }
      }>
    }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

interface PredictResponse {
  predictions?: Array<{
    bytesBase64Encoded?: string
    mimeType?: string
  }>
}

// ─── Public surface ────────────────────────────────────────────────────────

// Each ImageModel surfaced here carries its family tag in a private
// symbol on the object so `generate()` can branch without re-running
// the heuristic. Plugin SDK doesn't expose extra fields on ImageModel
// — the symbol keeps it transparent to the host but readable here.
const FAMILY_KEY = Symbol.for('hivekeep.gemini.imageFamily')

function tagFamily(model: ImageModel, family: Family): ImageModel & FamilyTag {
  return Object.assign(model, { [FAMILY_KEY]: family, family })
}

function readFamily(model: ImageModel): Family | null {
  const tagged = model as ImageModel & { [FAMILY_KEY]?: Family; family?: Family }
  return tagged[FAMILY_KEY] ?? tagged.family ?? null
}

export const geminiImageProvider: ImageProvider = {
  type: 'gemini',
  displayName: 'Google Gemini (Images)',
  apiKeyUrl: 'https://aistudio.google.com/apikey',
  configSchema: CONFIG_SCHEMA,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    const apiKey = config['apiKey']
    if (!apiKey) return { valid: false, error: 'Missing Google AI Studio API key' }
    try {
      // Reuse the LLM provider's probe — list one model. Same key
      // works for both endpoints, so a successful probe here is
      // proof of valid credentials.
      const url = new URL(`${API_BASE}/models`)
      url.searchParams.set('pageSize', '1')
      const res = await fetch(url.toString(), { headers: authHeaders(apiKey) })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        return { valid: false, error: errorFromResponse(res.status, text).message }
      }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: wrapError(err).message }
    }
  },

  async listModels(config: ProviderConfig): Promise<ImageModel[]> {
    const apiKey = requireApiKey(config)
    const out: ImageModel[] = []
    let pageToken: string | undefined
    do {
      const url = new URL(`${API_BASE}/models`)
      url.searchParams.set('pageSize', '100')
      if (pageToken) url.searchParams.set('pageToken', pageToken)
      let res: Response
      try {
        res = await fetch(url.toString(), { headers: authHeaders(apiKey) })
      } catch (err) {
        throw wrapError(err)
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw errorFromResponse(res.status, text)
      }
      const payload = (await res.json()) as GeminiModelListing
      for (const m of payload.models ?? []) {
        const id = m.name.replace(/^models\//, '')
        const methods = m.supportedGenerationMethods ?? []
        const family = familyForModel(id, methods)
        if (!family) continue

        const base: ImageModel = {
          id,
          name: m.displayName ?? id,
          // Nano Banana accepts reference images (single or multi for
          // compositional editing); Pro has a much higher budget than
          // the standard Flash variant. Imagen is text-to-image only.
          ...(family === 'generate-content'
            ? {
                maxImageInputs: NANO_BANANA_PRO_PATTERN.test(id)
                  ? NANO_BANANA_PRO_MAX_INPUTS
                  : NANO_BANANA_MAX_INPUTS,
              }
            : { maxImageInputs: 0 }),
          // Imagen output sizes are controlled by aspectRatio (not
          // pixel dimensions). Nano Banana picks its own. Either
          // way Hivekeep's `size: WxH` input maps internally — we
          // don't advertise a discrete supportedSizes list.
        }
        out.push(tagFamily(base, family))
      }
      pageToken = payload.nextPageToken
    } while (pageToken)
    return out
  },

  async describeModel(model: ImageModel): Promise<ImageModelParamsSchema> {
    const family = readFamily(model)
    if (family === 'predict') {
      return { params: IMAGEN_PARAMS }
    }
    // Nano Banana is prompt-driven, no structured per-call knobs.
    return { params: {} }
  },

  async generate(
    model: ImageModel,
    request: ImageRequest,
    config: ProviderConfig,
  ): Promise<ImageResult> {
    const apiKey = requireApiKey(config)
    const family = readFamily(model)
    if (family === 'predict') {
      return generateImagen(apiKey, model, request)
    }
    // Default to generateContent for Nano Banana (and any future
    // *-image-* variant that comes through). When the model came
    // from our own listModels it always has the tag; an unknown
    // model id passed in by mistake falls back here too.
    return generateNanoBanana(apiKey, model, request)
  },
}

// ─── Nano Banana (generateContent + inlineData) ─────────────────────────────

async function generateNanoBanana(
  apiKey: string,
  model: ImageModel,
  request: ImageRequest,
): Promise<ImageResult> {
  // Build the user turn: text prompt + optional reference images.
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: request.prompt },
  ]
  for (const input of request.imageInputs ?? []) {
    parts.push({
      inlineData: {
        mimeType: input.mediaType,
        data: uint8ToBase64(input.data),
      },
    })
  }

  // `responseModalities: ['IMAGE']` is the official knob (preview-era
  // image models default to image-only; including TEXT lets the model
  // also emit captioning text). We ask for image-only.
  const body = {
    contents: [{ role: 'user' as const, parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      // Caller may pass anything via `params` — Nano Banana ignores
      // most knobs, but we pass them through anyway in case future
      // previews add useful parameters (responseMimeType, etc.).
      ...(request.params ?? {}),
    },
  }

  const url = `${API_BASE}/models/${encodeURIComponent(model.id)}:generateContent`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (err) {
    throw wrapError(err)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw errorFromResponse(res.status, text)
  }

  const payload = (await res.json()) as GenerateContentResponse
  if (payload.promptFeedback?.blockReason) {
    throw new InvalidRequestError(
      `Gemini blocked the request: ${payload.promptFeedback.blockReason}`,
    )
  }
  const candidate = payload.candidates?.[0]
  if (!candidate) {
    throw new ProviderServerError('Gemini returned no candidate')
  }
  const imagePart = (candidate.content?.parts ?? []).find(
    (p): p is { inlineData: { mimeType?: string; data?: string } } =>
      'inlineData' in p && !!p.inlineData?.data,
  )
  if (!imagePart) {
    // Sometimes the model returns text instead of an image (safety,
    // refusal, "I can't generate that"). Surface the text for the
    // caller to see in the error message.
    const textParts = (candidate.content?.parts ?? [])
      .map((p) => ('text' in p ? p.text : ''))
      .filter(Boolean)
      .join(' ')
    throw new ProviderServerError(
      textParts
        ? `Gemini returned text instead of an image: "${textParts.slice(0, 200)}"`
        : 'Gemini returned no image data',
    )
  }
  const mediaType = imagePart.inlineData.mimeType ?? 'image/png'
  return { data: base64ToUint8Array(imagePart.inlineData.data!), mediaType }
}

// ─── Imagen (predict + bytesBase64Encoded) ──────────────────────────────────

async function generateImagen(
  apiKey: string,
  model: ImageModel,
  request: ImageRequest,
): Promise<ImageResult> {
  if (request.imageInputs && request.imageInputs.length > 0) {
    log.warn(
      { modelId: model.id, given: request.imageInputs.length },
      'Imagen models are text-to-image only — dropping provided imageInputs.',
    )
  }

  const params = (request.params ?? {}) as Record<string, unknown>
  // `size` flows through aspectRatioFor when params didn't already
  // specify aspectRatio — the LLM may have used either path.
  const derivedAspect = aspectRatioFor(request.size)
  const aspectRatio = params['aspectRatio'] ?? derivedAspect

  const body = {
    instances: [{ prompt: request.prompt }],
    parameters: {
      sampleCount: 1,
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(typeof params['negativePrompt'] === 'string' ? { negativePrompt: params['negativePrompt'] } : {}),
      ...(typeof params['personGeneration'] === 'string' ? { personGeneration: params['personGeneration'] } : {}),
      ...(typeof params['safetyFilterLevel'] === 'string' ? { safetyFilterLevel: params['safetyFilterLevel'] } : {}),
    },
  }

  const url = `${API_BASE}/models/${encodeURIComponent(model.id)}:predict`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: request.signal,
    })
  } catch (err) {
    throw wrapError(err)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw errorFromResponse(res.status, text)
  }

  const payload = (await res.json()) as PredictResponse
  const prediction = payload.predictions?.[0]
  if (!prediction?.bytesBase64Encoded) {
    throw new ProviderServerError('Imagen returned no image data (likely blocked by safety filter)')
  }
  return {
    data: base64ToUint8Array(prediction.bytesBase64Encoded),
    mediaType: prediction.mimeType ?? 'image/png',
  }
}
