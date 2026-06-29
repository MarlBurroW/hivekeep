/**
 * Provider dispatcher — single front-door over the six native registries
 * (`llm`, `embedding`, `image`, `search`, `tts`, `stt`). Built-in
 * providers (Anthropic, OpenAI, Brave, …) and plugin-contributed
 * providers register identically into these registries; nothing here
 * knows or cares about the difference.
 *
 * Callers (routes/providers, tools/provider-tools, image-tools,
 * model-info-cache, image-generation, routes/agents, llm/core/resolve) get a
 * uniform `ProviderModel` shape regardless of which family answers, which
 * keeps the per-model UI generic.
 *
 * Notes on the model-bearing concept:
 *   - `listModelsForProvider` is a no-op for `search` and `tts` —
 *     search providers have no model selection (one provider == one
 *     endpoint), and TTS's user-facing unit is the Voice, not a model.
 *     The dispatcher returns an empty list rather than failing so the
 *     model-info-cache refresh loop can ignore these rows without
 *     special-casing.
 *   - TTS providers expose their voice catalogue via the dedicated
 *     `listVoicesForProvider` dispatcher below.
 */

import type { ProviderConfig as HivekeepProviderConfig } from '@/server/llm/core/types'
import type { ProviderCapability } from '@/shared/types'
import type { ConfigField } from '@gezy/sdk'
import { PROVIDER_META, type ProviderType, type ProviderMeta } from '@/shared/provider-metadata'
import { createLogger } from '@/server/logger'
import { getLLMProvider, listLLMProviders } from '@/server/llm/llm/registry'
import { getEmbeddingProvider, listEmbeddingProviders } from '@/server/llm/embedding/registry'
import { getImageProvider, listImageProviders } from '@/server/llm/image/registry'
import { getSearchProvider, listSearchProviders } from '@/server/llm/search/registry'
import { getTTSProvider, listTTSProviders } from '@/server/llm/tts/registry'
import { getSTTProvider, listSTTProviders } from '@/server/llm/stt/registry'
import { getEmailProvider, listEmailProviders } from '@/server/email/registry'
import type { Voice } from '@/server/llm/tts/types'

const log = createLogger('providers')

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * The "lowest common denominator" model shape returned by the dispatcher.
 * Used by the UI / tools / routes that just need {id, name, capability,
 * contextWindow}. Family-specific fields (LLMModel.thinking, ImageModel
 * .supportedSizes, …) are intentionally squashed here — callers that need
 * them must reach into the native registry.
 */
export interface ProviderModel {
  id: string
  name: string
  capability: 'llm' | 'embedding' | 'image' | 'stt' | 'rerank'
  /** LLM models only — true when the chat can receive image blocks in
   *  user messages (vision-capable). Unrelated to image-generation. */
  supportsImageInput?: boolean
  /** Image-generation models only — how many source images this model
   *  accepts (0 = text-to-image, 1 = img2img / inpainting, N>1 = multi-
   *  reference like Nano Banana Pro or Flux-Kontext multi). Absent =
   *  unknown, treat as 0. */
  maxImageInputs?: number
  /** Maximum input/context tokens (LLM/embedding) or maximum audio
   *  duration in seconds (STT — encoded as contextWindow for shape
   *  parity). Populated when the provider's API exposes it. */
  contextWindow?: number
  /** Maximum output tokens. Populated when the provider's API exposes it. */
  maxOutput?: number
}

// ─── Metadata helpers ───────────────────────────────────────────────────────

/**
 * Derive a `ProviderMeta` for any provider type (built-in or plugin-
 * contributed). Built-ins go through the hardcoded `PROVIDER_META` table;
 * plugin-contributed providers (type prefix `plugin:`) get their meta
 * built from their entry in the native registries.
 */
function metaForType(type: string): ProviderMeta | undefined {
  const builtIn = PROVIDER_META[type as ProviderType]
  if (builtIn) return builtIn

  const capabilities: ProviderCapability[] = []
  const llm = getLLMProvider(type)
  if (llm) capabilities.push('llm')
  const emb = getEmbeddingProvider(type)
  if (emb) capabilities.push('embedding')
  const img = getImageProvider(type)
  if (img) capabilities.push('image')
  const search = getSearchProvider(type)
  if (search) capabilities.push('search')
  const tts = getTTSProvider(type)
  if (tts) capabilities.push('tts')
  const stt = getSTTProvider(type)
  if (stt) capabilities.push('stt')
  const email = getEmailProvider(type)
  if (email) capabilities.push('email')

  if (capabilities.length === 0) return undefined

  const first = llm ?? emb ?? img ?? search ?? tts ?? stt ?? email
  return {
    capabilities,
    displayName: first?.displayName ?? type,
    ...(first?.noApiKey ? { noApiKey: true } : {}),
    ...(first?.optionalApiKey ? { optionalApiKey: true } : {}),
    ...(first?.apiKeyUrl ? { apiKeyUrl: first.apiKeyUrl } : {}),
    ...(first?.lobehubIcon ? { lobehubIcon: first.lobehubIcon } : {}),
    ...(first?.reactIcon ? { reactIcon: first.reactIcon } : {}),
    ...(first?.brandColor ? { brandColor: first.brandColor } : {}),
  }
}

/**
 * Listing of every plugin-contributed provider's metadata (keyed by type).
 * Built-ins are NOT included — `PROVIDER_META` is the source for those.
 * Used by the UI's "add provider" picker to surface plugin providers
 * alongside built-ins.
 */
export function getPluginProviderMeta(): Record<string, ProviderMeta> {
  const out: Record<string, ProviderMeta> = {}
  for (const p of [
    ...listLLMProviders(),
    ...listEmbeddingProviders(),
    ...listImageProviders(),
    ...listSearchProviders(),
    ...listTTSProviders(),
    ...listSTTProviders(),
    ...listEmailProviders(),
  ]) {
    if (!p.type.startsWith('plugin:')) continue
    if (out[p.type]) {
      // Same type registered in multiple families (e.g. a single plugin
      // provider that implements both llm and embedding) — merge capabilities.
      const existing = out[p.type]!
      out[p.type] = {
        ...existing,
        capabilities: [...new Set([...existing.capabilities, ...metaForType(p.type)!.capabilities])],
      }
    } else {
      const meta = metaForType(p.type)
      if (meta) out[p.type] = meta
    }
  }
  return out
}

export function getCapabilitiesForType(type: string): ProviderCapability[] {
  return [...(metaForType(type)?.capabilities ?? [])]
}

/**
 * The `configSchema` (config field descriptors) for a provider type, read from
 * whichever native registry holds it. Drives the dynamic config form and,
 * crucially, secret-field detection for vaulting (see provider-config.ts).
 * Empty when the type is unknown / a plugin is not loaded.
 */
export function getConfigSchemaForType(type: string): readonly ConfigField[] {
  const provider =
    getLLMProvider(type) ??
    getEmbeddingProvider(type) ??
    getImageProvider(type) ??
    getSearchProvider(type) ??
    getTTSProvider(type) ??
    getSTTProvider(type)
  return provider?.configSchema ?? []
}

/** Keys of every `secret`-typed config field for a provider type. Used to
 *  decide which fields move into the vault. */
export function getSecretFieldKeys(type: string): string[] {
  return getConfigSchemaForType(type)
    .filter((f) => f.type === 'secret')
    .map((f) => f.key)
}

// ─── Dispatcher helpers ──────────────────────────────────────────────────────

/** Provider family hint passed to the dispatcher to route the call to a
 *  specific native registry. Each `providers.capabilities[]` entry
 *  matches one of these values. */
export type ProviderFamily = 'llm' | 'embedding' | 'image' | 'search' | 'tts' | 'stt'

/**
 * Look up a provider across the six native registries and run `fn`
 * against the matching one. Returns null when the type isn't registered
 * in the requested family (or in any family when `family` is omitted).
 *
 * The `family` hint is required for any call that dispatches a
 * family-specific operation (listModels, image generate, embed, search,
 * speak, transcribe). It routes to the right registry when a single
 * provider type registers in multiple registries (OpenAI
 * llm+embedding+image+tts+stt, Replicate, …).
 *
 * `family` is omitted only by `testProviderConnection` — `authenticate`
 * is family-invariant (same credentials across families), so we don't
 * care which family's registry answers as long as one of them does.
 * The "try LLM → embedding → image → search → tts → stt" fallback
 * below handles that case.
 */
async function tryDispatch<T>(
  type: string,
  _config: HivekeepProviderConfig,
  fn: {
    llm: (p: NonNullable<ReturnType<typeof getLLMProvider>>) => Promise<T>
    embedding: (p: NonNullable<ReturnType<typeof getEmbeddingProvider>>) => Promise<T>
    image: (p: NonNullable<ReturnType<typeof getImageProvider>>) => Promise<T>
    search: (p: NonNullable<ReturnType<typeof getSearchProvider>>) => Promise<T>
    tts: (p: NonNullable<ReturnType<typeof getTTSProvider>>) => Promise<T>
    stt: (p: NonNullable<ReturnType<typeof getSTTProvider>>) => Promise<T>
  },
  family?: ProviderFamily,
): Promise<T | null> {
  if (family === 'llm') {
    const llm = getLLMProvider(type)
    return llm ? fn.llm(llm) : null
  }
  if (family === 'embedding') {
    const emb = getEmbeddingProvider(type)
    return emb ? fn.embedding(emb) : null
  }
  if (family === 'image') {
    const img = getImageProvider(type)
    return img ? fn.image(img) : null
  }
  if (family === 'search') {
    const search = getSearchProvider(type)
    return search ? fn.search(search) : null
  }
  if (family === 'tts') {
    const tts = getTTSProvider(type)
    return tts ? fn.tts(tts) : null
  }
  if (family === 'stt') {
    const stt = getSTTProvider(type)
    return stt ? fn.stt(stt) : null
  }
  // No family hint — try in order.
  const llm = getLLMProvider(type)
  if (llm) return fn.llm(llm)
  const emb = getEmbeddingProvider(type)
  if (emb) return fn.embedding(emb)
  const img = getImageProvider(type)
  if (img) return fn.image(img)
  const search = getSearchProvider(type)
  if (search) return fn.search(search)
  const tts = getTTSProvider(type)
  if (tts) return fn.tts(tts)
  const stt = getSTTProvider(type)
  if (stt) return fn.stt(stt)
  return null
}

// ─── Public API used by the rest of the codebase ─────────────────────────────

export async function testProviderConnection(
  type: string,
  config: HivekeepProviderConfig,
  family?: ProviderFamily,
): Promise<{ valid: boolean; capabilities: string[]; error?: string }> {
  // In E2E test mode, skip real provider connection tests
  if (process.env.E2E_SKIP_PROVIDER_TEST === 'true') {
    const capabilities = getCapabilitiesForType(type)
    log.info({ type, capabilities }, 'E2E mode: skipping real provider test')
    return { valid: true, capabilities }
  }

  const result = await tryDispatch<{ valid: boolean; error?: string }>(
    type,
    config,
    {
      llm: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      embedding: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      image: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      search: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      tts: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
      stt: (p) => p.authenticate(config).then((r) => ({ valid: r.valid, error: r.error })),
    },
    family,
  )

  if (!result) {
    // A `plugin:` type that no longer resolves means the contributing
    // plugin is disabled or uninstalled (typical after a package rename
    // or local→npm reinstall — the old prefix is orphaned). Surface it
    // as a soft warn so the user can act, but don't pollute the error
    // channel with a recoverable state.
    const isOrphanPlugin = type.startsWith('plugin:')
    if (isOrphanPlugin) {
      log.warn({ type }, 'Provider type belongs to a plugin that is not currently loaded')
      return { valid: false, capabilities: [], error: `Plugin not loaded: ${type}` }
    }
    log.error({ type }, 'Unknown provider type')
    return { valid: false, capabilities: [], error: `Unknown provider type: ${type}` }
  }

  log.info({ type, valid: result.valid, error: result.error }, 'Provider connection tested')
  return {
    valid: result.valid,
    capabilities: result.valid ? getCapabilitiesForType(type) : [],
    error: result.error,
  }
}

export async function listModelsForProvider(
  type: string,
  config: HivekeepProviderConfig,
  family?: ProviderFamily,
): Promise<ProviderModel[]> {
  log.debug({ type, family }, 'Listing models for provider')

  const models = await tryDispatch<ProviderModel[]>(
    type,
    config,
    {
      llm: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'llm',
          ...(m.supportsImageInput ? { supportsImageInput: true } : {}),
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxOutput != null ? { maxOutput: m.maxOutput } : {}),
        }))
      },
      embedding: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'embedding',
          ...(m.maxInputTokens ? { contextWindow: m.maxInputTokens } : {}),
        }))
      },
      image: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'image',
          ...(m.maxImageInputs != null ? { maxImageInputs: m.maxImageInputs } : {}),
        }))
      },
      // Search providers have no model selection — one provider == one
      // search endpoint. Return an empty list so the model-info cache
      // refresh loop ignores them without special-casing.
      search: async () => [],
      // TTS providers' user-facing unit is the Voice, not a model.
      // Voices are fetched via the dedicated `listVoicesForProvider`
      // dispatcher; this generic helper returns an empty model list.
      tts: async () => [],
      stt: async (p) => {
        const list = await p.listModels(config)
        return list.map((m): ProviderModel => ({
          id: m.id,
          name: m.name,
          capability: 'stt',
          ...(m.maxAudioSeconds ? { contextWindow: m.maxAudioSeconds } : {}),
        }))
      },
    },
    family,
  )

  if (!models) {
    // Orphaned plugin type (plugin disabled/uninstalled while a provider
    // row still points at its namespace). Stay at debug — refresh loops
    // hit this on every tick and we don't want it in the error stream.
    if (type.startsWith('plugin:')) {
      log.debug({ type, family }, 'Skipping listModels — plugin not loaded')
      return []
    }
    log.error({ type }, 'Cannot list models for unknown provider type')
    return []
  }

  if (models.length > 0) {
    // Auto-populate the model-info cache so callers of
    // getModelContextWindow() get accurate values straight from the
    // provider's API. Lazy import to avoid a circular dependency.
    const { populateFromProviderModels } = await import('@/server/services/model-info-cache')
    populateFromProviderModels(models)
  }
  return models
}

// Image-model lookup + describe dispatchers live in a sibling module
// so they have a stable import path that isn't poisoned by the
// `mock.module('@/server/providers/index', ...)` calls in
// image-tools.test.ts. Re-exported here for callers that already
// reach for them via the dispatcher index.
export {
  lookupImageModel,
  describeImageModel,
  _resetImageModelCaches,
} from '@/server/providers/image-cache'

/** For diagnostics — listing of providers in each native registry. */
export function getRegistryStats() {
  return {
    llm: listLLMProviders().map((p) => p.type),
    embedding: listEmbeddingProviders().map((p) => p.type),
    image: listImageProviders().map((p) => p.type),
    search: listSearchProviders().map((p) => p.type),
    tts: listTTSProviders().map((p) => p.type),
    stt: listSTTProviders().map((p) => p.type),
  }
}

/**
 * Dedicated dispatcher for TTS voice listing — separate from
 * `listModelsForProvider` because the user-facing unit for TTS is a
 * Voice (with optional `model` binding) rather than a model.
 *
 * Returns an empty array when the type isn't a registered TTS
 * provider — orphaned plugin rows are silently skipped (same
 * convention as the model-info path), so the caller can iterate
 * without special-casing missing plugins.
 */
export async function listVoicesForProvider(
  type: string,
  config: HivekeepProviderConfig,
): Promise<Voice[]> {
  const provider = getTTSProvider(type)
  if (!provider) {
    if (type.startsWith('plugin:')) {
      log.debug({ type }, 'Skipping listVoices — plugin not loaded')
      return []
    }
    log.error({ type }, 'Cannot list voices for unknown TTS provider type')
    return []
  }
  return provider.listVoices(config)
}
