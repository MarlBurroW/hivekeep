import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { db } from '@/server/db/index'
import { files, providers } from '@/server/db/schema'
import { generateImage, hasImageCapability } from '@/server/services/image-generation'
import { listModelsForProvider, describeImageModel } from '@/server/providers/index'
import { loadProviderConfig } from '@/server/services/provider-config'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:image')

/**
 * list_image_models — list available image generation models.
 * Available to main agents and sub-agents. Lean payload on purpose:
 * id, name, providerName, and maxImageInputs — no per-model param
 * schemas (those go through describe_image_model on demand so the
 * system prompt token cost stays bounded as the model catalogue grows).
 */
export const listImageModelsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List image generation models available to Hivekeep, with how many source images each can accept (`maxImageInputs`: 0 = text-to-image only, 1 = single-image edit/inpainting, N>1 = multi-reference like Nano Banana Pro). Call describe_image_model to discover the per-model parameters before generate_image.',
      inputSchema: z.object({}),
      execute: async () => {
        const allProviders = await db.select().from(providers).all()
        const models: Array<{
          id: string
          name: string
          providerId: string
          providerName: string
          providerType: string
          maxImageInputs: number
        }> = []

        for (const p of allProviders) {
          if (!p.isValid) continue
          const caps = JSON.parse(p.capabilities) as string[]
          if (!caps.includes('image')) continue
          try {
            const providerConfig = await loadProviderConfig(p)
            const providerModels = await listModelsForProvider(
              p.type,
              providerConfig,
              'image',
            )

            for (const model of providerModels) {
              if (model.capability !== 'image') continue
              models.push({
                id: model.id,
                name: model.name,
                providerId: p.id,
                providerName: p.name,
                providerType: p.type,
                maxImageInputs: model.maxImageInputs ?? 0,
              })
            }
          } catch (err) {
            log.error({ providerId: p.id, err }, 'Failed to list image models for provider')
          }
        }

        if (models.length === 0) {
          return { models: [], note: 'No image models available. Ask the user to configure a provider with image capability.' }
        }

        return { models }
      },
    }),
}

/**
 * describe_image_model — fetch the per-model parameter schema so the
 * LLM can fill `generate_image`'s `params` field with the right knobs.
 * Lazy on purpose: list_image_models stays lean, the LLM only pays the
 * extra round-trip for the 1-2 models it's actually considering.
 *
 * The schema is a thin slice of JSON Schema (type + description +
 * default + enum / min / max). The LLM produces a value, the provider
 * passes it through to the upstream API. Validation isn't strict here
 * — if the LLM sends garbage the upstream API returns a 422 which
 * round-trips back as a tool error, triggering self-correction.
 */
export const describeImageModelTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'Describe an image model\'s tunable parameters (seed, guidance, style, …). Call this before generate_image for any model whose knobs you want to control beyond the prompt. Image-input fields are intentionally excluded — those are piloted by generate_image\'s `imageUrls`, not `params`.',
      inputSchema: z.object({
        providerId: z.string(),
        modelId: z.string(),
      }),
      execute: async ({ providerId, modelId }) => {
        const p = await db.select().from(providers).where(eq(providers.id, providerId)).get()
        if (!p) return { error: `Provider ${providerId} not found.` }
        if (!p.isValid) return { error: `Provider ${providerId} is currently marked invalid — ask the user to re-test it.` }
        const caps = JSON.parse(p.capabilities) as string[]
        if (!caps.includes('image')) {
          return { error: `Provider ${providerId} doesn't expose image generation.` }
        }

        try {
          const providerConfig = await loadProviderConfig(p)
          const schema = await describeImageModel(p.type, modelId, providerConfig)
          if (!schema) {
            return { error: `Provider type ${p.type} doesn't support image-model description.` }
          }
          const paramNames = Object.keys(schema.params)
          return {
            modelId,
            providerId,
            params: schema.params,
            note: paramNames.length === 0
              ? 'This model exposes no documented parameters. Pass only the prompt (and imageUrls if applicable) to generate_image.'
              : `Pass any subset of these as generate_image's \`params\` field. Unknown / mistyped values surface as upstream 422 errors.`,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'describe_image_model failed' }
        }
      },
    }),
}

/**
 * generate_image — generate an image from a text prompt, optionally
 * with one or more source images (img2img / inpainting / multi-ref).
 * Saves the result to disk and returns a URL. Available to main
 * agents only.
 *
 * Note: The tool always registers, but returns an error at runtime
 * if no image provider is configured. This keeps the tool visible
 * in the system prompt so the Agent knows the capability exists.
 */
export const generateImageTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Generate an image from a text prompt, or edit/extend one or more source images. Use list_image_models to discover models and describe_image_model to learn each model\'s tunable parameters before populating `params`.',
      inputSchema: z.object({
        prompt: z
          .string(),
        modelId: z
          .string()
          .optional()
          .describe('From list_image_models. Auto-selects if omitted.'),
        providerId: z
          .string()
          .optional()
          .describe('Auto-selects if omitted'),
        imageUrls: z
          .array(z.string())
          .optional()
          .describe('Source images for img2img / inpainting / multi-reference. Each URL is internal (/api/uploads/...) or external (https://...). The model\'s maxImageInputs (from list_image_models) caps how many it will actually use — extras are dropped with a warning by the provider.'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Per-model tunables (seed, guidance_scale, style, lora_scale, …). Call describe_image_model first to discover what this model accepts.'),
        filename: z
          .string()
          .optional(),
      }),
      execute: async ({ prompt, modelId, providerId, imageUrls, params, filename }) => {
        log.debug({ agentId: ctx.agentId, modelId, providerId, imageCount: imageUrls?.length ?? 0, hasParams: !!params }, 'Image generation requested')

        // Check if image generation is available
        const available = await hasImageCapability()
        if (!available) {
          return {
            error: 'No image provider configured. Ask the user to configure a provider with image capability.',
          }
        }

        try {
          const result = await generateImage(prompt, { providerId, modelId, imageUrls, params })

          // Determine file extension from media type
          const ext = result.mediaType === 'image/jpeg' ? 'jpg'
            : result.mediaType === 'image/webp' ? 'webp'
            : 'png'

          const fileId = uuid()
          const storedName = filename
            ? `${fileId}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
            : `${fileId}-generated.${ext}`
          const dir = join(config.upload.dir, 'messages', ctx.agentId)
          const storedPath = join(dir, storedName)

          // Ensure directory exists
          await mkdir(dir, { recursive: true })

          // Write base64 to disk
          const buffer = Buffer.from(result.base64, 'base64')
          await Bun.write(storedPath, buffer)

          // Save to files table
          await db.insert(files).values({
            id: fileId,
            agentId: ctx.agentId,
            sessionId: ctx.sessionId ?? null,
            originalName: filename ?? `generated.${ext}`,
            storedPath,
            mimeType: result.mediaType,
            size: buffer.length,
            createdAt: new Date(),
          })

          const url = `/api/uploads/messages/${ctx.agentId}/${storedName}`

          return {
            success: true,
            fileId,
            url,
            mimeType: result.mediaType,
            size: buffer.length,
          }
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : 'Image generation failed',
          }
        }
      },
    }),
}
