/**
 * Platform configuration tools — used mainly by the configurator Kin (Sherpa)
 * to set up the platform through chat: discover provider types + their config
 * schema, re-test providers, enable extra capabilities on an existing provider
 * (key reuse), set capability defaults, and edit the global prompt.
 *
 * Mutating tools are admin-only (global resources). Secret-bearing provider /
 * channel CREATION goes through the secure-input flow (request_provider_setup),
 * not these tools — nothing here ever receives a raw API key as an argument.
 */

import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { or, eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers, userProfiles } from '@/server/db/schema'
import {
  getConfigSchemaForType,
  getSecretFieldKeys,
  getCapabilitiesForType,
  getPluginProviderMeta,
  testProviderConnection,
} from '@/server/providers/index'
import { loadProviderConfig } from '@/server/services/provider-config'
import {
  getGlobalPrompt,
  setGlobalPrompt,
  getAvatarStylePrompt,
  setAvatarStylePrompt,
  getAvatarSubject,
  setAvatarSubject,
  isAvatarBaseEnabled,
  setAvatarBaseEnabled,
  setDefaultLlmProviderId,
  setEmbeddingProviderId,
  setDefaultImageProviderId,
  setDefaultSearchProviderId,
  setDefaultTtsProviderId,
  setDefaultSttProviderId,
  // Model defaults (model + provider pairs).
  setDefaultLlmModel,
  setEmbeddingModel,
  setDefaultImageModel,
  setDefaultScoutModel,
  setDefaultScoutProviderId,
  setDefaultCompactingModel,
  setDefaultCompactingProviderId,
  setExtractionModel,
  setExtractionProviderId,
  // Getters for get_default_models.
  getDefaultLlmModel,
  getDefaultLlmProviderId,
  getEmbeddingModel,
  getEmbeddingProviderId,
  getDefaultImageModel,
  getDefaultImageProviderId,
  getDefaultScoutModel,
  getDefaultScoutProviderId,
  getDefaultCompactingModel,
  getDefaultCompactingProviderId,
  getExtractionModel,
  getExtractionProviderId,
  getDefaultSearchProviderId,
  getDefaultTtsProviderId,
  getDefaultSttProviderId,
} from '@/server/services/app-settings'
import { PROVIDER_META } from '@/shared/provider-metadata'
import { PROVIDER_API_KEY_URLS, PROVIDERS_WITHOUT_API_KEY, AVATAR_STYLE_PRESETS, AVATAR_SUBJECT_PRESETS } from '@/shared/constants'
import { generateNeutralAvatarBase, hasCustomBaseAvatar, clearCustomBaseAvatar } from '@/server/services/image-generation'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'
import type { ToolExecutionContext } from '@/server/tools/types'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:config')

// ─── Admin guard ─────────────────────────────────────────────────────────────

/**
 * Global platform configuration is admin-only. Returns an error object when the
 * acting user isn't an admin (or the turn has no user — e.g. an automated
 * kickoff), else null. Read-only discovery tools are NOT gated.
 */
export async function requireAdmin(ctx: ToolExecutionContext): Promise<{ error: string } | null> {
  if (!ctx.userId) {
    return { error: 'This action changes global platform configuration and can only run on behalf of an admin user.' }
  }
  const profile = await db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, ctx.userId))
    .get()
  if (profile?.role !== 'admin') {
    return { error: 'Only an admin can change global platform configuration (providers, defaults, global prompt).' }
  }
  return null
}

async function findProvider(ref: string) {
  return db.select().from(providers).where(or(eq(providers.id, ref), eq(providers.slug, ref))).get()
}

type DefaultableCapability = 'llm' | 'embedding' | 'image' | 'search' | 'tts' | 'stt'

const CAPABILITY_DEFAULT_SETTERS: Record<DefaultableCapability, (id: string | null) => Promise<void>> = {
  llm: setDefaultLlmProviderId,
  embedding: setEmbeddingProviderId,
  image: setDefaultImageProviderId,
  search: setDefaultSearchProviderId,
  tts: setDefaultTtsProviderId,
  stt: setDefaultSttProviderId,
}

// Model-bearing services: the default is a (model + provider) pair.
type ModelService = 'llm' | 'embedding' | 'image' | 'scout' | 'compacting' | 'extraction'
const MODEL_DEFAULT_SETTERS: Record<ModelService, { setModel: (m: string) => Promise<void>; setProvider: (id: string | null) => Promise<void> }> = {
  llm: { setModel: setDefaultLlmModel, setProvider: setDefaultLlmProviderId },
  embedding: { setModel: setEmbeddingModel, setProvider: setEmbeddingProviderId },
  image: { setModel: setDefaultImageModel, setProvider: setDefaultImageProviderId },
  scout: { setModel: setDefaultScoutModel, setProvider: setDefaultScoutProviderId },
  compacting: { setModel: setDefaultCompactingModel, setProvider: setDefaultCompactingProviderId },
  extraction: { setModel: setExtractionModel, setProvider: setExtractionProviderId },
}

// ─── describe_provider_config ────────────────────────────────────────────────

export const describeProviderConfigTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'Describe the configuration fields a provider type needs (e.g. "openai", "gemini", "brave-search"). ' +
        'Returns each field with its key, type, label, and whether it is a SECRET (api key / token). ' +
        'Call this BEFORE request_provider_setup so you know which secret field(s) the user must paste and where to get the key.',
      inputSchema: z.object({
        type: z.string().describe('Provider type slug. Discover available types with list_provider_types.'),
      }),
      execute: async ({ type }) => {
        const capabilities = getCapabilitiesForType(type)
        const schema = getConfigSchemaForType(type)
        if (capabilities.length === 0 && schema.length === 0) {
          return { error: `Unknown provider type: "${type}". Use list_provider_types to see valid types.` }
        }
        return {
          type,
          capabilities,
          apiKeyUrl: PROVIDER_API_KEY_URLS[type] ?? null,
          noApiKey: (PROVIDERS_WITHOUT_API_KEY as readonly string[]).includes(type),
          fields: schema.map((f) => {
            const def = (f as { default?: string }).default
            return {
              key: f.key,
              type: f.type,
              label: f.label,
              required: f.required ?? false,
              secret: f.type === 'secret',
              ...(f.description ? { description: f.description } : {}),
              ...(f.placeholder ? { placeholder: f.placeholder } : {}),
              ...(def ? { default: def } : {}),
            }
          }),
          secretFields: getSecretFieldKeys(type),
        }
      },
    }),
}

// ─── list_provider_types ─────────────────────────────────────────────────────

export const listProviderTypesTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List every provider TYPE that can be configured (built-in + plugin), with its capabilities and where to get an API key. ' +
        'Optionally filter by capability (llm/embedding/image/search/tts/stt). Use this to propose providers to the user, then ' +
        'describe_provider_config + request_provider_setup to actually connect one.',
      inputSchema: z.object({
        capability: z
          .enum(['llm', 'embedding', 'image', 'search', 'tts', 'stt'])
          .optional()
          .describe('Only return types that support this capability.'),
      }),
      execute: async ({ capability }) => {
        const builtins = Object.entries(PROVIDER_META).map(([type, meta]) => ({
          type,
          displayName: meta.displayName,
          capabilities: [...meta.capabilities],
          apiKeyUrl: PROVIDER_API_KEY_URLS[type] ?? null,
          noApiKey: (PROVIDERS_WITHOUT_API_KEY as readonly string[]).includes(type),
          source: 'builtin' as const,
        }))
        const plugins = Object.entries(getPluginProviderMeta()).map(([type, meta]) => ({
          type,
          displayName: meta.displayName,
          capabilities: [...meta.capabilities],
          apiKeyUrl: meta.apiKeyUrl ?? null,
          noApiKey: meta.noApiKey ?? false,
          source: 'plugin' as const,
        }))
        const all = [...builtins, ...plugins]
        const filtered = capability ? all.filter((t) => t.capabilities.includes(capability)) : all
        return { types: filtered }
      },
    }),
}

// ─── test_provider ───────────────────────────────────────────────────────────

export const testProviderTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Re-test an already-configured provider\'s credentials and update its validity status. ' +
        'Pass the provider id or slug. (To connect a NEW provider, use request_provider_setup instead.)',
      inputSchema: z.object({
        provider_id: z.string().describe('Provider id or slug (from list_providers).'),
      }),
      execute: async ({ provider_id }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        const provider = await findProvider(provider_id)
        if (!provider) return { error: `Provider not found: "${provider_id}".` }
        const config = await loadProviderConfig(provider)
        const result = await testProviderConnection(provider.type, config)
        await db
          .update(providers)
          .set({ isValid: result.valid, lastError: result.valid ? null : (result.error ?? null), updatedAt: new Date() })
          .where(eq(providers.id, provider.id))
        sseManager.broadcast({
          type: 'provider:updated',
          data: {
            providerId: provider.id,
            slug: provider.slug,
            name: provider.name,
            providerType: provider.type,
            capabilities: JSON.parse(provider.capabilities),
            isValid: result.valid,
            lastError: result.valid ? null : (result.error ?? null),
          },
        })
        return { valid: result.valid, capabilities: result.capabilities, ...(result.error ? { error: result.error } : {}) }
      },
    }),
}

// ─── enable_provider_capability ──────────────────────────────────────────────

export const enableProviderCapabilityTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Enable an additional capability on an EXISTING provider — e.g. turn on `embedding` for an OpenAI provider you already added for `llm`, ' +
        'so the same API key powers the memory system without asking the user for a new key. The capability must be one the provider type supports.',
      inputSchema: z.object({
        provider_id: z.string().describe('Provider id or slug.'),
        capability: z.enum(['llm', 'embedding', 'image', 'search', 'tts', 'stt']),
      }),
      execute: async ({ provider_id, capability }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        const provider = await findProvider(provider_id)
        if (!provider) return { error: `Provider not found: "${provider_id}".` }
        const supported = getCapabilitiesForType(provider.type)
        if (!supported.includes(capability)) {
          return { error: `Provider type "${provider.type}" does not support the "${capability}" capability. It supports: ${supported.join(', ') || 'none'}.` }
        }
        let caps: string[] = []
        try { caps = JSON.parse(provider.capabilities) as string[] } catch { /* ignore */ }
        if (caps.includes(capability)) {
          return { capabilities: caps, note: `Capability "${capability}" was already enabled.` }
        }
        caps.push(capability)
        await db.update(providers).set({ capabilities: JSON.stringify(caps), updatedAt: new Date() }).where(eq(providers.id, provider.id))
        sseManager.broadcast({
          type: 'provider:updated',
          data: {
            providerId: provider.id,
            slug: provider.slug,
            name: provider.name,
            providerType: provider.type,
            capabilities: caps,
            isValid: provider.isValid,
            lastError: provider.lastError ?? null,
          },
        })
        log.info({ providerId: provider.id, capability }, 'Enabled provider capability')
        return { capabilities: caps }
      },
    }),
}

// ─── set_default_provider ────────────────────────────────────────────────────

export const setDefaultProviderTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Set the default provider used for a capability (llm / embedding / image / search / tts / stt). ' +
        'For example, after connecting an embedding provider, make it the default so the memory system uses it.',
      inputSchema: z.object({
        capability: z.enum(['llm', 'embedding', 'image', 'search', 'tts', 'stt']),
        provider_id: z.string().describe('Provider id or slug to make the default for this capability.'),
      }),
      execute: async ({ capability, provider_id }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        const provider = await findProvider(provider_id)
        if (!provider) return { error: `Provider not found: "${provider_id}".` }
        let caps: string[] = []
        try { caps = JSON.parse(provider.capabilities) as string[] } catch { /* ignore */ }
        if (!caps.includes(capability)) {
          return { error: `Provider "${provider.name}" does not have the "${capability}" capability enabled. Enable it first with enable_provider_capability.` }
        }
        const setter = CAPABILITY_DEFAULT_SETTERS[capability]
        if (!setter) return { error: `No default setting exists for capability "${capability}".` }
        await setter(provider.id)
        log.info({ providerId: provider.id, capability }, 'Set default provider for capability')
        return { ok: true, capability, providerId: provider.id, providerName: provider.name }
      },
    }),
}

// ─── set_default_model / get_default_models ──────────────────────────────────

export const setDefaultModelTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Set the default MODEL (and its provider) for a model-bearing service: llm (chat), embedding (memory indexing), image (avatars/images), scout (cheap exploration), compacting (history summarization), extraction (memory extraction). ' +
        'For example: after connecting an embedding provider, set the default embedding model so the memory system uses it. ' +
        'For search/tts/stt (no model selection) use set_default_provider instead. Use list_models to find a valid model id + its providerSlug.',
      inputSchema: z.object({
        service: z.enum(['llm', 'embedding', 'image', 'scout', 'compacting', 'extraction']),
        model: z.string().describe('Model id (from list_models).'),
        provider_id: z
          .string()
          .optional()
          .describe('Provider id or slug that serves the model (recommended — use the providerSlug from list_models).'),
      }),
      execute: async ({ service, model, provider_id }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        const setters = MODEL_DEFAULT_SETTERS[service]
        let providerId: string | null = null
        if (provider_id) {
          const provider = await findProvider(provider_id)
          if (!provider) return { error: `Provider not found: "${provider_id}".` }
          providerId = provider.id
        }
        await setters.setModel(model)
        await setters.setProvider(providerId)
        sseManager.broadcast({ type: 'settings:defaults-updated', data: {} })
        log.info({ service, model, providerId }, 'Set default model')
        return { ok: true, service, model, providerId }
      },
    }),
}

export const getDefaultModelsTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'Read the current platform DEFAULTS — the default model (and provider) for each model-bearing service (llm/embedding/image/scout/compacting/extraction) and the default provider for search/tts/stt. Use this to see what is already configured before changing anything.',
      inputSchema: z.object({}),
      execute: async () => {
        const [
          llmModel, llmProviderId,
          embeddingModel, embeddingProviderId,
          imageModel, imageProviderId,
          scoutModel, scoutProviderId,
          compactingModel, compactingProviderId,
          extractionModel, extractionProviderId,
          searchProviderId, ttsProviderId, sttProviderId,
        ] = await Promise.all([
          getDefaultLlmModel(), getDefaultLlmProviderId(),
          getEmbeddingModel(), getEmbeddingProviderId(),
          getDefaultImageModel(), getDefaultImageProviderId(),
          getDefaultScoutModel(), getDefaultScoutProviderId(),
          getDefaultCompactingModel(), getDefaultCompactingProviderId(),
          getExtractionModel(), getExtractionProviderId(),
          getDefaultSearchProviderId(), getDefaultTtsProviderId(), getDefaultSttProviderId(),
        ])
        return {
          models: {
            llm: { model: llmModel, providerId: llmProviderId },
            embedding: { model: embeddingModel, providerId: embeddingProviderId },
            image: { model: imageModel, providerId: imageProviderId },
            scout: { model: scoutModel, providerId: scoutProviderId },
            compacting: { model: compactingModel, providerId: compactingProviderId },
            extraction: { model: extractionModel, providerId: extractionProviderId },
          },
          providers: {
            search: searchProviderId,
            tts: ttsProviderId,
            stt: sttProviderId,
          },
        }
      },
    }),
}

// ─── get_global_prompt / set_global_prompt ───────────────────────────────────

export const getGlobalPromptTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'Read the current GLOBAL PROMPT — shared conduct rules / directives injected into EVERY Kin\'s system prompt. ' +
        'Always read this before set_global_prompt so you can append rather than overwrite.',
      inputSchema: z.object({}),
      execute: async () => {
        const prompt = await getGlobalPrompt()
        return { globalPrompt: prompt ?? '' }
      },
    }),
}

export const setGlobalPromptTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Set the GLOBAL PROMPT — conduct rules / preferences that ALL Kins must follow (injected into every Kin\'s system prompt). ' +
        'This REPLACES the whole value, so first call get_global_prompt and merge: keep existing rules and add the new ones. ' +
        'Use this when the user states cross-cutting preferences (tone, languages, do/don\'t rules).',
      inputSchema: z.object({
        prompt: z.string().describe('The full new global prompt (merge of existing + additions). Pass an empty string to clear it.'),
      }),
      execute: async ({ prompt }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        await setGlobalPrompt(prompt)
        log.info({ length: prompt.length }, 'Global prompt updated')
        return { ok: true, length: prompt.length }
      },
    }),
}

// ─── get_avatar_style / set_avatar_style ─────────────────────────────────────

export const getAvatarStyleTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'Read the current global avatar appearance: the SUBJECT/type (axis B — robot/human/dragon/…), the art STYLE (axis A — Pixar 3D/anime/watercolor/…), and whether the img2img base reference is enabled (and customized). Empty values mean defaults (a friendly robot, Pixar 3D style).',
      inputSchema: z.object({}),
      execute: async () => {
        const [style, subject, baseEnabled, customBase] = await Promise.all([
          getAvatarStylePrompt(), getAvatarSubject(), isAvatarBaseEnabled(), hasCustomBaseAvatar(),
        ])
        return {
          avatarSubject: subject ?? '',
          avatarStyle: style ?? '',
          img2imgBaseEnabled: baseEnabled,
          hasCustomBaseImage: customBase,
        }
      },
    }),
}

export const listAvatarPresetsTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'List the suggested avatar STYLE presets (axis A) and SUBJECT/type presets (axis B) you can offer the user. The user can also pick "Other" and type their own. Apply a choice with set_avatar_style / set_avatar_subject (pass the preset\'s `prompt` text, or the user\'s free text).',
      inputSchema: z.object({}),
      execute: async () => ({
        stylePresets: AVATAR_STYLE_PRESETS.map((p) => ({ label: p.label, prompt: p.prompt })),
        subjectPresets: AVATAR_SUBJECT_PRESETS.map((p) => ({ label: p.label, prompt: p.prompt })),
      }),
    }),
}

export const setAvatarBaseEnabledTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Enable or disable the img2img BASE reference for avatar generation. Enabled (default): avatars derive from a neutral base image for visual consistency (when the image model supports image-to-image). Disabled: avatars are always generated text-to-image.',
      inputSchema: z.object({ enabled: z.boolean() }),
      execute: async ({ enabled }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        await setAvatarBaseEnabled(enabled)
        return { ok: true, img2imgBaseEnabled: enabled }
      },
    }),
}

export const generateAvatarBaseTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Generate a NEUTRAL base avatar in the current (or given) style + subject and lock it in as the img2img base reference — so every Kin avatar derives from it and they all share a consistent look. Requires an image provider. Returns a URL to show the user. Tip: do this after the user has chosen a style + type.',
      inputSchema: z.object({
        style: z.string().optional().describe('Override the art style for this base (else uses the global setting).'),
        subject: z.string().optional().describe('Override the subject/type for this base (else uses the global setting).'),
      }),
      execute: async ({ style, subject }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        try {
          const result = await generateNeutralAvatarBase({
            ...(style ? { style } : {}),
            ...(subject ? { subject } : {}),
          })
          const ext = result.mediaType.includes('webp') ? 'webp' : 'png'
          return { ok: true, baseImageUrl: `/api/uploads/avatar-base/base.${ext}?v=${Date.now()}` }
        } catch (err) {
          log.error({ err }, 'Failed to generate neutral avatar base')
          return { error: 'Could not generate the base avatar — make sure an image provider is configured.' }
        }
      },
    }),
}

export const resetAvatarBaseTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description: 'Reset the img2img base reference back to the bundled default (a neutral robot). Use if the user wants to undo a custom/generated base.',
      inputSchema: z.object({}),
      execute: async () => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        clearCustomBaseAvatar()
        return { ok: true }
      },
    }),
}

export const setAvatarStyleTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Set the GLOBAL avatar ART STYLE — how avatars are drawn (e.g. "Pixar 3D", "anime", "watercolor", "heroic-fantasy oil painting", "pixel art"). This is the rendering style, NOT what the avatar depicts (for that use set_avatar_subject). ' +
        'Tip: agree empirically — call generate_image to show an example, iterate, then lock it in. Empty string = default Pixar 3D style. Does not change existing avatars.',
      inputSchema: z.object({
        style: z.string().describe('Short art-style directive. Empty string resets to default.'),
      }),
      execute: async ({ style }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        await setAvatarStylePrompt(style)
        log.info({ style }, 'Avatar style updated')
        return { ok: true, avatarStyle: style.trim() }
      },
    }),
}

export const setAvatarSubjectTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Set the GLOBAL avatar SUBJECT — what every Kin avatar depicts (e.g. "a human character", "a dragon", "a cyborg", "an alien", "a cute animal"). This is the subject, NOT the art style (for that use set_avatar_style). ' +
        'Note: a non-default subject forces text-to-image generation (the built-in image-to-image base is a robot, so it can only be tweaked, not turned into another creature). Empty string = the default friendly robot. Does not change existing avatars.',
      inputSchema: z.object({
        subject: z.string().describe('What the avatar depicts. Empty string resets to the default robot.'),
      }),
      execute: async ({ subject }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        await setAvatarSubject(subject)
        log.info({ subject }, 'Avatar subject updated')
        return { ok: true, avatarSubject: subject.trim() }
      },
    }),
}

// ─── test_channel ────────────────────────────────────────────────────────────

export const testChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Test a configured messaging channel by (re)activating it and reporting whether it connects. Pass the channel id (from list_channels).',
      inputSchema: z.object({
        channel_id: z.string().describe('Channel id to test.'),
      }),
      execute: async ({ channel_id }) => {
        const denied = await requireAdmin(ctx)
        if (denied) return denied
        const { getChannel, deactivateChannel, activateChannel } = await import('@/server/services/channels')
        const channel = await getChannel(channel_id)
        if (!channel) return { error: `Channel not found: "${channel_id}".` }
        await deactivateChannel(channel_id)
        const result = await activateChannel(channel_id)
        const ok = result?.status === 'active'
        return ok
          ? { ok: true, status: 'active' }
          : { ok: false, status: result?.status ?? 'error', error: result?.statusMessage ?? 'Activation failed' }
      },
    }),
}
