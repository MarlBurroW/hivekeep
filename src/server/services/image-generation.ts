import { eq } from 'drizzle-orm'
import { join } from 'path'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { providers } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getDefaultImageModel, getDefaultImageProviderId } from '@/server/services/app-settings'
import { listModelsForProvider, lookupImageModel } from '@/server/providers/index'
import { getImageProvider } from '@/server/llm/image/registry'
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
  return loadBaseAvatar()
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
 * System prompt used when the target image model supports image-to-image editing.
 * Asks the LLM to produce *transformation instructions* applied to the base robot.
 */
const AVATAR_EDIT_SYSTEM = `You are an image prompt writer. The user will give you the identity of a character (name, role, personality, expertise).

You are NOT writing a description from scratch. You are writing instructions to transform a base reference image: a small, friendly Pixar-style 3D robot in a neutral pose, neutral colors, against a plain background. The image model will receive this base image plus your instructions.

Write a short prompt (2-3 sentences) telling the image model how to transform that base robot so it visually represents the character. You should ask it to:
- Repaint the robot with a color palette that fits the character's domain or personality
- Add small props, accessories, or markings that hint at the character's expertise (e.g. headphones, monocle, tool belt, miniature instruments)
- Replace the plain background with a simple scene related to the character's domain
- Keep the friendly Pixar / 3D-rendered cartoon aesthetic, the proportions, and the cute robot identity intact

HOW TO USE THE CHARACTER DESCRIPTION (read carefully):
The character description is INSPIRATION ONLY for COLOR, MOOD, and small head-area accessories. It is NOT a literal brief. You MUST silently FILTER OUT and IGNORE every element of the description that would require zooming out the camera, including:
- Body parts below the upper chest (legs, feet, waist, hips, hands, arms below the shoulders)
- Standing poses, full-body poses, action poses, "stands tall", "wields", "carries", "holds"
- Equipment worn on the back, hip, or legs (swords on back, quivers, holsters, capes flowing down, tool belts at the waist, boots, leg armor)
- Long flowing hair or robes that extend below the chest
- Large weapons or props that wouldn't fit beside a head
- Any wide-environment description (battlefield, forest clearing seen wide, etc.)
Only keep elements that can plausibly appear in an extreme head-and-shoulders crop: helmets, hats, glasses, headphones, monocles, masks, face paint, ear-level accessories, collars, neckwear (scarf, stethoscope, necklace, tie, lab coat collar), shoulder pads, small badges/insignia on the chest, eye color/shape, and the head's color/material/texture. If the description gives you a sword, give the robot a tiny pin-shaped sword emblem on its chest, not an actual sword. Translate big concepts into head-area equivalents.

CRITICAL FRAMING (this is the most important constraint, mention it EARLY and AGAIN at the end):
The output must be an extreme close-up headshot / bust portrait — only the robot's head and the very top of its shoulders/chest are visible, the head fills the frame, the camera is zoomed in tight on the face. No legs, no arms, no waist, no full body, no wide shot. Think profile picture or social media avatar crop.

Rules:
- Output ONLY the transformation prompt, nothing else
- Never include the character's name
- Never mention any body part below the upper chest, never mention any pose, never mention any prop that doesn't fit in a head-area crop
- Never ask for text, letters, words, logos, frames, borders, or UI elements in the image
- Start the prompt with a verb like "Repaint", "Transform", or "Customize this base robot", IMMEDIATELY followed by the framing constraint (e.g. "...as an extreme close-up headshot avatar showing only the head and top of the shoulders")
- End the prompt with this exact sentence: "Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. Keep the friendly Pixar 3D robot style. No text, no letters, no words, no UI elements."`

/**
 * System prompt used when the target image model is text-to-image only.
 * Best-effort fallback: describe a small robot in the same spirit, from scratch.
 */
const AVATAR_GENERATE_SYSTEM = `You are an image prompt writer. The user will give you the identity of a character (name, role, personality, expertise). You must write a short image generation prompt (2-3 sentences) describing an extreme close-up headshot avatar of a small, friendly Pixar-style 3D robot that visually represents this character.

Style guidelines:
- A small, cute, friendly cartoon robot in Pixar / 3D-animation style — round shapes, large expressive eyes, soft materials
- The robot's color palette, accessories, props, and background should reflect the character's role and expertise (e.g. lab coat for a doctor, tiny chef hat for a cook, headphones for a musician)
- Soft studio lighting, slight depth of field, plain or simple thematic background

HOW TO USE THE CHARACTER DESCRIPTION (read carefully):
The character description is INSPIRATION ONLY for COLOR, MOOD, and small head-area accessories. It is NOT a literal brief. You MUST silently FILTER OUT and IGNORE every element of the description that would require zooming out the camera, including:
- Body parts below the upper chest (legs, feet, waist, hips, hands, arms below the shoulders)
- Standing poses, full-body poses, action poses, "stands tall", "wields", "carries", "holds"
- Equipment worn on the back, hip, or legs (swords on back, quivers, holsters, capes flowing down, tool belts at the waist, boots, leg armor)
- Long flowing hair or robes that extend below the chest
- Large weapons or props that wouldn't fit beside a head
- Any wide-environment description (battlefield, forest clearing seen wide, etc.)
Only keep elements that can plausibly appear in an extreme head-and-shoulders crop: helmets, hats, glasses, headphones, monocles, masks, face paint, ear-level accessories, collars, neckwear (scarf, stethoscope, necklace, tie, lab coat collar), shoulder pads, small badges/insignia on the chest, eye color/shape, and the head's color/material/texture. If the description gives you a sword, give the robot a tiny pin-shaped sword emblem on its chest, not an actual sword. Translate big concepts into head-area equivalents.

CRITICAL FRAMING (this is the most important constraint, mention it EARLY and AGAIN at the end):
The image must be an extreme close-up headshot / bust portrait — only the robot's head and the very top of its shoulders/chest are visible, the head fills the frame, the camera is zoomed in tight on the face. No legs, no arms, no waist, no full body, no wide shot. Think profile picture or social media avatar crop.

Rules:
- Output ONLY the image prompt, nothing else
- Never include the character's name
- Never describe the robot's full body, legs, arms, or anything below the upper chest
- Never mention any pose or any prop that doesn't fit in a head-area crop
- Never ask for text, letters, words, logos, or UI elements in the image
- Start the prompt with the framing constraint (e.g. "Extreme close-up headshot of a small Pixar-style robot...")
- End the prompt with this exact sentence: "Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. Pixar 3D animation style, soft lighting. No text, no letters, no words, no UI elements."`

/**
 * No-LLM fallback: produce a serviceable robot prompt straight from kin metadata.
 * Used when no LLM provider is configured or the configured one isn't supported here.
 */
function fallbackAvatarPrompt(
  kin: { role: string; expertise: string },
  mode: 'edit' | 'generate',
  styleDirective?: string | null,
): string {
  const domain = (kin.expertise || kin.role || 'a generalist assistant').slice(0, 120)
  const style = styleDirective?.trim()
  if (mode === 'edit') {
    const styleClause = style ? ` Render it in this overall art style: ${style}.` : ' Keep the friendly Pixar 3D robot style.'
    return `Reframe this base robot as an extreme close-up headshot avatar (head and top of shoulders only, head fills the frame), repaint it with a color palette that fits ${domain}, add small props or accessories that hint at this domain, and replace the plain background with a simple thematic scene.${styleClause} Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. No text, no letters, no words, no UI elements.`
  }
  const styleClause = style ? `${style} art style` : 'Pixar 3D animation style, soft lighting'
  return `Extreme close-up headshot avatar of a small, friendly character that visually represents ${domain}, head fills the frame, with a fitting color palette, small thematic props, and a simple matching background. Extreme close-up headshot, head and top of shoulders only, no legs, no full body, no wide shot — tight avatar crop. ${styleClause}. No text, no letters, no words, no UI elements.`
}

/**
 * Use an LLM to generate an image prompt from Kin metadata.
 * The prompt style depends on whether the target image model supports image-to-image:
 * - 'edit'     → transformation instructions applied to the base robot reference image
 * - 'generate' → full description of a robot in the same spirit (text-to-image fallback)
 */
export async function buildAvatarPrompt(
  kin: {
    name: string
    role: string
    character: string
    expertise: string
  },
  mode: 'edit' | 'generate' = 'generate',
): Promise<string> {
  const { pickAnyLLMModel } = await import('@/server/llm/core/resolve')
  const { runOneShot } = await import('@/server/llm/core/run-oneshot')
  const { getAvatarStylePrompt } = await import('@/server/services/app-settings')
  const styleDirective = await getAvatarStylePrompt()
  const resolved = await pickAnyLLMModel()
  if (!resolved) return fallbackAvatarPrompt(kin, mode, styleDirective)

  const charSnippet = kin.character.slice(0, 300)
  const expertSnippet = kin.expertise.slice(0, 300)

  // User-defined global art style overrides the default Pixar-robot baseline
  // while the framing / no-text rules still apply.
  const baseSystem = mode === 'edit' ? AVATAR_EDIT_SYSTEM : AVATAR_GENERATE_SYSTEM
  const systemText = styleDirective?.trim()
    ? `${baseSystem}\n\nGLOBAL ART STYLE OVERRIDE (apply this overall aesthetic to the whole avatar, replacing the default cute-Pixar-robot look, but KEEP every framing/headshot/no-text rule above): ${styleDirective.trim()}`
    : baseSystem

  const avatarResult = await runOneShot(resolved, {
    system: [{ type: 'text', text: systemText }],
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: `Name: ${kin.name}\nRole: ${kin.role}\nPersonality: ${charSnippet}\nExpertise: ${expertSnippet}`,
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
