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
  setDefaultLlmProviderId,
  setEmbeddingProviderId,
  setDefaultImageProviderId,
  setDefaultSearchProviderId,
  setDefaultTtsProviderId,
  setDefaultSttProviderId,
} from '@/server/services/app-settings'
import { PROVIDER_META } from '@/shared/provider-metadata'
import { PROVIDER_API_KEY_URLS, PROVIDERS_WITHOUT_API_KEY } from '@/shared/constants'
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
        'Read the current global avatar art-style directive applied to every newly generated Kin avatar (empty = the default cute Pixar-robot look).',
      inputSchema: z.object({}),
      execute: async () => {
        const style = await getAvatarStylePrompt()
        return { avatarStyle: style ?? '' }
      },
    }),
}

export const setAvatarStyleTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  create: (ctx) =>
    tool({
      description:
        'Set the GLOBAL avatar art style applied to every Kin avatar generated from now on (e.g. "heroic fantasy", "cyberpunk cyborg", "watercolor"). ' +
        'Tip: agree on it empirically first — call generate_image to show the user an example avatar, iterate, then lock it in here. Pass an empty string to revert to the default Pixar-robot style. Does not change existing avatars.',
      inputSchema: z.object({
        style: z.string().describe('Short art-style directive (a few words to a sentence). Empty string resets to default.'),
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
