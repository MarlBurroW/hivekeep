import { eq } from 'drizzle-orm'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { providers } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getDefaultImageModel, getDefaultImageProviderId } from '@/server/services/app-settings'
import { listModelsForProvider, lookupImageModel } from '@/server/providers/index'
import { getImageProvider } from '@/server/llm/image/registry'
import { DEFAULT_AVATAR_STYLE, DEFAULT_AVATAR_SUBJECT } from '@/shared/constants'
import type { ProviderConfig } from '@/server/llm/core/types'

const BASE_AVATAR_PATH = join(import.meta.dir, '..', 'assets', 'base-avatar.png')

let cachedBaseAvatar: Uint8Array | null = null
async function loadBaseAvatar(): Promise<Uint8Array> {
  if (cachedBaseAvatar) return cachedBaseAvatar
  const file = Bun.file(BASE_AVATAR_PATH)
  if (!(await file.exists())) {
    throw new ImageGenerationError(
      'BASE_AVATAR_MISSING',
      `Base avatar asset not found at ${BASE_AVATAR_PATH}`,
    )
  }
  cachedBaseAvatar = new Uint8Array(await file.arrayBuffer())
  return cachedBaseAvatar
}

/**
 * Whether a given (providerId, modelId) pair accepts image input —
 * resolved by asking the provider's own `listModels()` for the model
 * and reading its `maxImageInputs` field. Provider-agnostic: zero
 * hardcoded type names here, no special cases.
 *
 * Returns 0 when the model isn't found, the provider isn't registered,
 * or the model is text-to-image only. > 0 means the upstream API
 * accepts at least that many source images.
 *
 * Cached by the dispatcher (5 min TTL) so a hot UI path doesn't pay a
 * round-trip per render.
 */
export async function getMaxImageInputs(
  providerId: string,
  modelId?: string | null,
): Promise<number> {
  if (!modelId) return 0
  const p = await db.select().from(providers).where(eq(providers.id, providerId)).get()
  if (!p || !p.isValid) return 0
  const cfg = await loadProviderConfig(p)
  const model = await lookupImageModel(p.type, modelId, cfg)
  return model?.maxImageInputs ?? 0
}

import { config } from '@/server/config'
import { recordUsage } from '@/server/services/token-usage'

const log = createLogger('image-gen')

interface GenerateImageResult {
  base64: string
  mediaType: string
}

interface GenerateImageOptions {
  providerId?: string
  modelId?: string
  /** Source image URLs (internal /api/uploads/... or external https://...).
   *  Each is resolved to bytes before going to the provider. The provider
   *  decides how many to actually use based on its model's maxImageInputs. */
  imageUrls?: string[]
  /** Raw image bytes used as input. Takes precedence over imageUrls when
   *  both are set. Plural — for multi-image models. */
  imageDatas?: Uint8Array[]
  /** Free-form per-model params surfaced by `describe_image_model`. The
   *  provider merges this over its own defaults before hitting the
   *  upstream API. */
  params?: Record<string, unknown>
}

/**
 * Resolve which image provider + model will be used given the caller's options.
 * Mirrors the resolution rules used by generateImage:
 *   explicit option > app_setting default > first available image provider
 * Throws ImageGenerationError if no usable provider exists.
 */
export async function resolveImageTarget(
  options?: { providerId?: string; modelId?: string },
): Promise<{ providerId: string; providerType: string; modelId: string }> {
  let provider
  let effectiveModelId = options?.modelId
  if (options?.providerId) {
    const p = await db.select().from(providers).where(eq(providers.id, options.providerId)).get()
    if (!p || !p.isValid) {
      throw new ImageGenerationError('PROVIDER_NOT_FOUND', 'Specified image provider not found or invalid')
    }
    provider = p
  } else {
    const defaultProviderId = await getDefaultImageProviderId()
    const defaultModelId = await getDefaultImageModel()
    if (defaultProviderId) {
      const p = await db.select().from(providers).where(eq(providers.id, defaultProviderId)).get()
      if (p && p.isValid) {
        provider = p
        if (!effectiveModelId && defaultModelId) effectiveModelId = defaultModelId
      } else {
        provider = await findImageProvider()
      }
    } else {
      provider = await findImageProvider()
    }
  }

  if (!provider) {
    throw new ImageGenerationError('NO_IMAGE_PROVIDER', 'No image provider configured')
  }

  if (!effectiveModelId) {
    const providerConfig = await loadProviderConfig(provider)
    try {
      const models = await listModelsForProvider(provider.type, providerConfig, 'image')
      const first = models.find((m) => m.capability === 'image')
      if (first) effectiveModelId = first.id
    } catch {
      // Fall through to error below
    }
  }

  if (!effectiveModelId) {
    throw new ImageGenerationError(
      'NO_IMAGE_MODEL',
      'No image model available — specify a modelId or configure a default',
    )
  }

  return { providerId: provider.id, providerType: provider.type, modelId: effectiveModelId }
}

/**
 * Load the base avatar reference image (small Pixar-style robot) used for
 * image-to-image avatar generation. Cached after the first read.
 */
export async function getBaseAvatarBytes(): Promise<Uint8Array> {
  const custom = await findCustomBasePath()
  if (custom) return new Uint8Array(await Bun.file(custom).arrayBuffer())
  return loadBaseAvatar()
}

// ─── Custom img2img base image ───────────────────────────────────────────────
// The img2img reference image (default = bundled robot). A custom one — uploaded
// or auto-generated as a neutral avatar in the chosen (subject, style) — gives
// the model a consistent reference so every Kin avatar shares the same look.

const CUSTOM_BASE_DIR = `${config.upload.dir}/avatar-base`
const CUSTOM_BASE_EXTS = ['png', 'webp', 'jpg', 'jpeg'] as const

async function findCustomBasePath(): Promise<string | null> {
  for (const ext of CUSTOM_BASE_EXTS) {
    const p = `${CUSTOM_BASE_DIR}/base.${ext}`
    if (await Bun.file(p).exists()) return p
  }
  return null
}

export async function hasCustomBaseAvatar(): Promise<boolean> {
  return (await findCustomBasePath()) !== null
}

/** Persist a custom base image, replacing any existing one. */
export async function setCustomBaseAvatar(bytes: Uint8Array | Buffer, ext = 'png'): Promise<void> {
  if (!existsSync(CUSTOM_BASE_DIR)) mkdirSync(CUSTOM_BASE_DIR, { recursive: true })
  for (const e of CUSTOM_BASE_EXTS) rmSync(`${CUSTOM_BASE_DIR}/base.${e}`, { force: true })
  await Bun.write(`${CUSTOM_BASE_DIR}/base.${ext}`, bytes)
}

/** Remove the custom base image → fall back to the bundled default. */
export function clearCustomBaseAvatar(): void {
  for (const e of CUSTOM_BASE_EXTS) rmSync(`${CUSTOM_BASE_DIR}/base.${e}`, { force: true })
}

/**
 * Whether image-to-image (edit) mode is enabled for avatar generation. Reads the
 * `avatar_base_enabled` setting (default true). When false, avatars are always
 * generated text-to-image (no base reference).
 */
export async function isImg2imgEnabled(): Promise<boolean> {
  const { getSetting } = await import('@/server/services/app-settings')
  const v = await getSetting('avatar_base_enabled')
  return v !== 'false'
}

/**
 * Generate an image using a specific or the first available image provider.
 * Supports optional image input for editing/inpainting.
 * Returns base64-encoded image data.
 */
export async function generateImage(
  prompt: string,
  options?: GenerateImageOptions,
): Promise<GenerateImageResult> {
  let target
  try {
    target = await resolveImageTarget({ providerId: options?.providerId, modelId: options?.modelId })
  } catch (err) {
    if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
      log.warn('No image provider configured')
    }
    throw err
  }

  const provider = db.select().from(providers).where(eq(providers.id, target.providerId)).get()
  if (!provider) {
    throw new ImageGenerationError('PROVIDER_NOT_FOUND', 'Image provider disappeared between resolution and use')
  }
  const effectiveModelId = target.modelId

  const providerConfig = await loadProviderConfig(provider)

  // Resolve image inputs if provided. Caller can pass either pre-decoded
  // bytes or URLs (internal or external) — URLs are fetched / read here
  // so the provider always sees raw bytes.
  let imageInputs: Array<{ data: Uint8Array; mediaType: string }> | undefined
  if (options?.imageDatas && options.imageDatas.length > 0) {
    imageInputs = options.imageDatas.map((data) => ({ data, mediaType: 'image/png' }))
  } else if (options?.imageUrls && options.imageUrls.length > 0) {
    const resolved = await Promise.all(options.imageUrls.map(resolveImageInput))
    imageInputs = resolved.map((data) => ({ data, mediaType: 'image/png' }))
  }

  const imageProvider = getImageProvider(provider.type)
  if (!imageProvider) {
    throw new ImageGenerationError(
      'UNSUPPORTED_PROVIDER',
      `Provider type ${provider.type} does not support image generation`,
    )
  }

  // Pass the model object the provider itself returned from listModels()
  // (with its real maxImageInputs / supportedSizes / pricing) when we
  // can find it. Fall back to a stub for providers whose listing doesn't
  // surface the id we were asked to use — the provider then makes do
  // with id+name and its own internal knowledge.
  const resolvedModel =
    (await lookupImageModel(provider.type, effectiveModelId, providerConfig as ProviderConfig))
    ?? { id: effectiveModelId, name: effectiveModelId }

  const result = await imageProvider.generate(
    resolvedModel,
    {
      prompt,
      ...(imageInputs ? { imageInputs } : {}),
      ...(options?.params ? { params: options.params } : {}),
    },
    providerConfig as ProviderConfig,
  )

  recordUsage({
    callSite: 'image-gen',
    callType: 'generate-image',
    providerType: provider.type,
    providerId: provider.id,
    modelId: effectiveModelId,
  })

  return {
    base64: uint8ToBase64(result.data),
    mediaType: result.mediaType,
  }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return globalThis.btoa(binary)
}

/**
 * Legacy alias — used by avatar generation routes.
 */
export const generateAvatarImage = generateImage

/**
 * Resolve an image URL to binary data.
 * - Internal URLs (/api/uploads/..., /api/file-storage/...) are read from disk
 * - External URLs (https://...) are fetched
 */
async function resolveImageInput(imageUrl: string): Promise<Uint8Array> {
  if (imageUrl.startsWith('/api/uploads/')) {
    // Internal upload: /api/uploads/messages/{kinId}/{filename} → data/uploads/messages/{kinId}/{filename}
    const relativePath = imageUrl.replace('/api/uploads/', '')
    const filePath = join(config.upload.dir, relativePath)
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      throw new ImageGenerationError('IMAGE_NOT_FOUND', `Source image not found: ${imageUrl}`)
    }
    return new Uint8Array(await file.arrayBuffer())
  }

  if (imageUrl.startsWith('/api/file-storage/')) {
    // Internal file-storage: /api/file-storage/d/{slug}/{filename} → data/file-storage/{slug}/{filename}
    const relativePath = imageUrl.replace('/api/file-storage/d/', '')
    const filePath = join(config.upload.dir, '..', 'file-storage', relativePath)
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      throw new ImageGenerationError('IMAGE_NOT_FOUND', `Source image not found: ${imageUrl}`)
    }
    return new Uint8Array(await file.arrayBuffer())
  }

  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    // External URL
    const response = await fetch(imageUrl)
    if (!response.ok) {
      throw new ImageGenerationError('IMAGE_FETCH_FAILED', `Failed to fetch source image from ${imageUrl}: ${response.status}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  throw new ImageGenerationError('INVALID_IMAGE_URL', `Invalid image URL: ${imageUrl}. Must be an internal /api/ path or an external https:// URL.`)
}

async function findImageProvider() {
  const allProviders = await db.select().from(providers).all()

  for (const p of allProviders) {
    try {
      const capabilities = JSON.parse(p.capabilities) as string[]
      if (capabilities.includes('image') && p.isValid) {
        return p
      }
    } catch {
      // Skip
    }
  }

  return null
}

export async function findLLMProvider() {
  const allProviders = await db.select().from(providers).all()

  for (const p of allProviders) {
    try {
      const capabilities = JSON.parse(p.capabilities) as string[]
      if (capabilities.includes('llm') && p.isValid) {
        return p
      }
    } catch {
      // Skip
    }
  }

  return null
}

/**
 * Check if image generation is possible (needs both image + LLM providers).
 */
export async function hasImageCapability(): Promise<boolean> {
  const [imageProvider, llmProvider] = await Promise.all([findImageProvider(), findLLMProvider()])
  return imageProvider !== null && llmProvider !== null
}

/**
 * System prompt for image-to-image (edit) mode, parameterized by the avatar
 * SUBJECT and STYLE. The image model receives a neutral base reference image
 * (which depicts ${subject} in ${style}) plus these transformation instructions.
 */
function buildEditSystem(subject: string, style: string): string {
  return `You are an image prompt writer. The user will give you the identity of a character (name, role, personality, expertise).

You are NOT writing a description from scratch. You are writing instructions to transform a base reference image: a neutral ${subject}, in ${style}, neutral colors, against a plain background. The image model will receive this base image plus your instructions.

Write a short prompt (2-3 sentences) telling the image model how to transform that base ${subject} so it visually represents the character. You should ask it to:
- Adjust the color palette to fit the character's domain or personality
- Add small props, accessories, or markings that hint at the character's expertise (e.g. headphones, monocle, glasses, badges)
- Replace the plain background with a simple scene related to the character's domain
- Keep the ${style} aesthetic, the proportions, and the ${subject} identity intact

HOW TO USE THE CHARACTER DESCRIPTION (read carefully):
The character description is INSPIRATION ONLY for COLOR, MOOD, and small head-area accessories. It is NOT a literal brief. You MUST silently FILTER OUT and IGNORE every element of the description that would require zooming out the camera, including:
- Body parts below the upper chest (legs, feet, waist, hips, hands, arms below the shoulders)
- Standing poses, full-body poses, action poses, "stands tall", "wields", "carries", "holds"
- Equipment worn on the back, hip, or legs (swords on back, quivers, holsters, capes flowing down, tool belts at the waist, boots, leg armor)
- Long flowing hair or robes that extend below the chest
- Large weapons or props that wouldn't fit beside a head
- Any wide-environment description (battlefield, forest clearing seen wide, etc.)
Only keep elements that can plausibly appear in an extreme head-and-shoulders crop: helmets, hats, glasses, headphones, monocles, masks, face paint, ear-level accessories, collars, neckwear (scarf, stethoscope, necklace, tie, lab coat collar), shoulder pads, small badges/insignia on the chest, eye color/shape, and the head's color/material/texture. If the description gives you a sword, render a tiny pin-shaped sword emblem on the chest, not an actual sword. Translate big concepts into head-area equivalents.

CRITICAL FRAMING (this is the most important constraint, mention it EARLY and AGAIN at the end):
The output must be an extreme close-up headshot / bust portrait — only the head and the very top of the shoulders/chest are visible, the head fills the frame, the camera is zoomed in tight on the face. No legs, no arms, no waist, no full body, no wide shot. Think profile picture or social media avatar crop.

Rules:
- Output ONLY the transformation prompt, nothing else
- Never include the character's name
- Never mention any body part below the upper chest, never mention any pose, never mention any prop that doesn't fit in a head-area crop
- Never ask for text, letters, words, logos, frames, borders, or UI elements in the image
- Start the prompt with a verb like "Repaint", "Transform", or "Customize this base ${subject}", IMMEDIATELY followed by the framing constraint (e.g. "...as an extreme close-up headshot avatar showing only the head and top of the shoulders")
- End the prompt with this exact sentence: "Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. ${style}. No text, no letters, no words, no UI elements."`
}

/**
 * System prompt for text-to-image (generate) mode, parameterized by the avatar
 * SUBJECT (robot / human / dragon / cyborg / …) and the art STYLE (Pixar 3D /
 * anime / watercolor / …). These are two independent axes. Used from scratch
 * (no base image) — so it's also the path for any non-default subject, since
 * the img2img base is a robot and can't be transformed into another subject.
 */
function buildGenerateSystem(subject: string, style: string): string {
  return `You are an image prompt writer. The user will give you the identity of a character (name, role, personality, expertise). You must write a short image generation prompt (2-3 sentences) describing an extreme close-up headshot avatar of ${subject}, rendered in ${style}, that visually represents this character.

Style guidelines:
- The avatar depicts ${subject}, rendered in ${style} — appealing, expressive, with a clear focal face
- The color palette, accessories, props, and background should reflect the character's role and expertise (e.g. lab coat for a doctor, tiny chef hat for a cook, headphones for a musician)
- Soft lighting, slight depth of field, plain or simple thematic background

HOW TO USE THE CHARACTER DESCRIPTION (read carefully):
The character description is INSPIRATION ONLY for COLOR, MOOD, and small head-area accessories. It is NOT a literal brief. You MUST silently FILTER OUT and IGNORE every element of the description that would require zooming out the camera, including:
- Body parts below the upper chest (legs, feet, waist, hips, hands, arms below the shoulders)
- Standing poses, full-body poses, action poses, "stands tall", "wields", "carries", "holds"
- Equipment worn on the back, hip, or legs (swords on back, quivers, holsters, capes flowing down, tool belts at the waist, boots, leg armor)
- Long flowing hair or robes that extend below the chest
- Large weapons or props that wouldn't fit beside a head
- Any wide-environment description (battlefield, forest clearing seen wide, etc.)
Only keep elements that can plausibly appear in an extreme head-and-shoulders crop: helmets, hats, glasses, headphones, monocles, masks, face paint, ear-level accessories, collars, neckwear (scarf, stethoscope, necklace, tie, lab coat collar), shoulder pads, small badges/insignia on the chest, eye color/shape, and the head's color/material/texture. If the description gives you a sword, render a tiny pin-shaped sword emblem on the chest, not an actual sword. Translate big concepts into head-area equivalents.

CRITICAL FRAMING (this is the most important constraint, mention it EARLY and AGAIN at the end):
The image must be an extreme close-up headshot / bust portrait — only the head and the very top of the shoulders/chest are visible, the head fills the frame, the camera is zoomed in tight on the face. No legs, no arms, no waist, no full body, no wide shot. Think profile picture or social media avatar crop.

Rules:
- Output ONLY the image prompt, nothing else
- Never include the character's name
- Never describe the full body, legs, arms, or anything below the upper chest
- Never mention any pose or any prop that doesn't fit in a head-area crop
- Never ask for text, letters, words, logos, or UI elements in the image
- Start the prompt with the framing constraint and the subject (e.g. "Extreme close-up headshot of ${subject}...")
- End the prompt with this exact sentence: "Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. ${style}. No text, no letters, no words, no UI elements."`
}

/**
 * No-LLM fallback: produce a serviceable prompt straight from kin metadata.
 * Used when no LLM provider is configured or the configured one isn't supported here.
 */
function fallbackAvatarPrompt(
  kin: { role: string; expertise: string },
  mode: 'edit' | 'generate',
  subject: string,
  style: string,
): string {
  const domain = (kin.expertise || kin.role || 'a generalist assistant').slice(0, 120)
  if (mode === 'edit') {
    // Edit transforms the base robot — only used for the default robot subject.
    return `Reframe this base robot as an extreme close-up headshot avatar (head and top of shoulders only, head fills the frame), repaint it with a color palette that fits ${domain}, add small props or accessories that hint at this domain, and replace the plain background with a simple thematic scene. Render it in this overall art style: ${style}. Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. No text, no letters, no words, no UI elements.`
  }
  return `Extreme close-up headshot avatar of ${subject} that visually represents ${domain}, head fills the frame, with a fitting color palette, small thematic props, and a simple matching background. Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. ${style}. No text, no letters, no words, no UI elements.`
}

export interface BuildAvatarPromptOptions {
  /** Override the global avatar subject (axis B) — used for one-shot manual gen. */
  subject?: string | null
  /** Override the global art style (axis A) — used for one-shot manual gen. */
  style?: string | null
  /** The image model that will render the result — given to the prompt-writer
   *  so it can tailor the prompt to that model's strengths. */
  targetModelId?: string
  /** Whether the target model accepts image inputs (img2img). */
  maxImageInputs?: number
}

/**
 * Ephemeral prompt-writer: an LLM rewrites the FULL image-generation prompt from
 * the Kin's identity, GUIDED by the two global axes — SUBJECT (axis B, what it
 * depicts) and STYLE (axis A, how it's drawn) — producing the per-Kin character
 * (axis C). A full rewrite (not block concatenation) keeps the prompt coherent.
 * The writer is also told which image model will render it.
 * - 'edit'     → transformation instructions applied to the neutral base image
 * - 'generate' → full description from scratch (text-to-image)
 */
export async function buildAvatarPrompt(
  kin: {
    name: string
    role: string
    character: string
    expertise: string
  },
  mode: 'edit' | 'generate' = 'generate',
  opts?: BuildAvatarPromptOptions,
): Promise<string> {
  const { pickAnyLLMModel } = await import('@/server/llm/core/resolve')
  const { runOneShot } = await import('@/server/llm/core/run-oneshot')
  const { getAvatarStylePrompt, getAvatarSubject } = await import('@/server/services/app-settings')
  const [styleDirective, subjectDirective] = await Promise.all([
    opts?.style !== undefined ? Promise.resolve(opts.style) : getAvatarStylePrompt(),
    opts?.subject !== undefined ? Promise.resolve(opts.subject) : getAvatarSubject(),
  ])
  const subject = subjectDirective?.trim() || DEFAULT_AVATAR_SUBJECT
  const style = styleDirective?.trim() || DEFAULT_AVATAR_STYLE
  const resolved = await pickAnyLLMModel()
  if (!resolved) return fallbackAvatarPrompt(kin, mode, subject, style)

  const charSnippet = kin.character.slice(0, 300)
  const expertSnippet = kin.expertise.slice(0, 300)

  // SUBJECT (axis B) + STYLE (axis A) are baked into the system template; the
  // writer fills axis C (the per-Kin character) coherently.
  const systemText = mode === 'edit'
    ? buildEditSystem(subject, style)
    : buildGenerateSystem(subject, style)

  const modelHint = opts?.targetModelId
    ? `\n\nThe generated prompt will be rendered by the image model "${opts.targetModelId}"${typeof opts.maxImageInputs === 'number' ? ` (${opts.maxImageInputs > 0 ? 'supports image-to-image' : 'text-to-image only'})` : ''}. Write the prompt to play to that model's strengths.`
    : ''

  const avatarResult = await runOneShot(resolved, {
    system: [{ type: 'text', text: systemText }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Name: ${kin.name}\nRole: ${kin.role}\nPersonality: ${charSnippet}\nExpertise: ${expertSnippet}${modelHint}`,
      }],
    }],
    maxOutputTokens: 200,
  })

  recordUsage({
    callSite: 'avatar-prompt',
    callType: 'generate-text',
    providerType: resolved.providerRow.type,
    providerId: resolved.providerRow.id,
    modelId: resolved.model.id,
    usage: {
      inputTokens: avatarResult.usage.inputTokens,
      outputTokens: avatarResult.usage.outputTokens,
      inputTokenDetails: { cacheReadTokens: avatarResult.usage.cacheReadTokens, cacheWriteTokens: avatarResult.usage.cacheWriteTokens },
      outputTokenDetails: { reasoningTokens: avatarResult.usage.reasoningTokens },
    },
  })

  return avatarResult.text.trim()
}

/** A generic, character-less headshot prompt for the neutral base image. */
function buildNeutralBasePrompt(subject: string, style: string): string {
  return `Extreme close-up headshot avatar of ${subject}, rendered in ${style}. A neutral, generic, friendly base character: neutral colors, calm neutral expression, no specific accessories, props, or markings, plain simple background. Head fills the frame, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. ${style}. No text, no letters, no words, no UI elements.`
}

/**
 * Generate a NEUTRAL base avatar in the given (or current) subject + style and
 * store it as the img2img base reference, so every Kin avatar derives from it
 * for visual consistency. Returns the generated image (base64 + mediaType).
 */
export async function generateNeutralAvatarBase(opts?: {
  providerId?: string
  modelId?: string
  subject?: string
  style?: string
}): Promise<{ base64: string; mediaType: string }> {
  const { getAvatarStylePrompt, getAvatarSubject } = await import('@/server/services/app-settings')
  const [styleD, subjectD] = await Promise.all([getAvatarStylePrompt(), getAvatarSubject()])
  const subject = opts?.subject?.trim() || subjectD?.trim() || DEFAULT_AVATAR_SUBJECT
  const style = opts?.style?.trim() || styleD?.trim() || DEFAULT_AVATAR_STYLE
  const prompt = buildNeutralBasePrompt(subject, style)
  const result = await generateImage(prompt, {
    ...(opts?.providerId ? { providerId: opts.providerId } : {}),
    ...(opts?.modelId ? { modelId: opts.modelId } : {}),
  })
  const ext = result.mediaType.includes('webp') ? 'webp' : 'png'
  await setCustomBaseAvatar(Buffer.from(result.base64, 'base64'), ext)
  return result
}

// ─── Mini-App Icon Prompt ────────────────────────────────────────────────────

const MINI_APP_ICON_STYLE_SYSTEM = `You are an icon design prompt writer. The user will give you the name, description, and emoji of a mini web application. You must write a short image generation prompt (2-3 sentences max) describing a flat app icon for this application.

Style guidelines:
- Flat design app icon, clean and minimal, single centered symbol or object
- Solid or subtle gradient background that reflects the app's theme
- Like a modern iOS/Android app icon or macOS Dock icon
- Simple geometric shapes, clean lines, soft shadows
- The icon should clearly convey the app's purpose at a glance

Rules:
- Output ONLY the image prompt, nothing else
- Never include text, letters, words, or UI elements in the image
- End the prompt with: "No text, no letters, no words, no UI elements. Flat design app icon, square with rounded corners."`

/**
 * Use an LLM to generate an image prompt from mini-app metadata,
 * then use it to generate the app icon image.
 */
export async function buildMiniAppIconPrompt(app: {
  name: string
  description: string | null
  icon: string | null
}): Promise<string> {
  const staticFallback = `Flat design app icon for "${app.name}". Clean, minimal, single centered symbol. Soft gradient background. No text, no letters, no words, no UI elements. Flat design app icon, square with rounded corners.`

  const { pickAnyLLMModel } = await import('@/server/llm/core/resolve')
  const { runOneShot } = await import('@/server/llm/core/run-oneshot')
  const resolved = await pickAnyLLMModel()
  if (!resolved) return staticFallback

  const desc = app.description?.slice(0, 300) ?? ''
  const emoji = app.icon ?? ''

  const iconResult = await runOneShot(resolved, {
    system: [{ type: 'text', text: MINI_APP_ICON_STYLE_SYSTEM }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `App name: ${app.name}\nDescription: ${desc}\nEmoji hint: ${emoji}`,
      }],
    }],
    maxOutputTokens: 200,
  })

  recordUsage({
    callSite: 'icon-prompt',
    callType: 'generate-text',
    providerType: resolved.providerRow.type,
    providerId: resolved.providerRow.id,
    modelId: resolved.model.id,
    usage: {
      inputTokens: iconResult.usage.inputTokens,
      outputTokens: iconResult.usage.outputTokens,
      inputTokenDetails: { cacheReadTokens: iconResult.usage.cacheReadTokens, cacheWriteTokens: iconResult.usage.cacheWriteTokens },
      outputTokenDetails: { reasoningTokens: iconResult.usage.reasoningTokens },
    },
  })

  return iconResult.text.trim()
}

/**
 * Custom error class for image generation failures.
 */
export class ImageGenerationError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}
