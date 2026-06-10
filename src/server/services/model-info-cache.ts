/**
 * In-memory cache for per-model metadata (context window, max output tokens).
 *
 * Populated whenever the server fetches a provider's model list (e.g. via the
 * `/api/providers/models` route or the startup pre-warm). Read by
 * `getModelContextWindow()` in `@/shared/model-context-windows`, which falls
 * back to a small static safety net for models the cache hasn't seen yet.
 *
 * The source of truth is each provider's API: Anthropic's `/v1/models` exposes
 * `max_input_tokens`, Gemini's `/v1beta/models` exposes `inputTokenLimit`,
 * Cohere's `/v2/models` exposes `context_length`, etc.
 */
import { Cron } from 'croner'
import { db } from '@/server/db/index'
import { providers as providersTable } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { listModelsForProvider, getCapabilitiesForType } from '@/server/providers/index'
import { createLogger } from '@/server/logger'
import { setModelInfoLookup } from '@/shared/model-context-windows'
import { reconcileAllProviders, listRegistry } from '@/server/services/model-registry'
import { config } from '@/server/config'

const log = createLogger('model-info-cache')

export interface ModelInfo {
  contextWindow?: number
  maxOutput?: number
}

const cache = new Map<string, ModelInfo>()

// Wire the cache lookup into the shared context-window resolver. This runs
// once at module load so any code path that imports model-info-cache (or
// imports something that imports it — like the providers index) automatically
// activates the dynamic resolution.
setModelInfoLookup((modelId) => cache.get(modelId))

/**
 * Set or update cached info for a model. Only the fields actually populated
 * by the provider are stored — undefined values don't overwrite existing
 * entries, so providers that don't expose context_window won't blank out
 * info that another provider (or the static fallback) already filled in.
 */
export function setModelInfo(modelId: string, info: ModelInfo): void {
  if (!modelId) return
  const existing = cache.get(modelId) ?? {}
  const merged: ModelInfo = { ...existing }
  if (info.contextWindow != null) merged.contextWindow = info.contextWindow
  if (info.maxOutput != null) merged.maxOutput = info.maxOutput
  cache.set(modelId, merged)
}

/**
 * Look up cached info for a model. Returns undefined if the cache hasn't
 * seen this model yet — callers should fall back to a static default.
 */
export function getModelInfo(modelId: string): ModelInfo | undefined {
  return cache.get(modelId)
}

/**
 * Clear the cache. Mainly useful in tests; production code shouldn't need
 * to call this — entries get refreshed naturally as the app fetches model
 * lists.
 */
export function clearModelInfoCache(): void {
  cache.clear()
}

/** Number of cached entries — observability helper. */
export function getModelInfoCacheSize(): number {
  return cache.size
}

/**
 * Bulk-populate the cache from a list of provider models. Used by the
 * `listModelsForProvider` wrapper and the startup pre-warm.
 */
export function populateFromProviderModels(
  models: Array<{ id: string; contextWindow?: number; maxOutput?: number }>,
): void {
  let updated = 0
  for (const m of models) {
    if (m.contextWindow != null || m.maxOutput != null) {
      setModelInfo(m.id, { contextWindow: m.contextWindow, maxOutput: m.maxOutput })
      updated++
    }
  }
  if (updated > 0) {
    log.info({ updated, totalCached: cache.size }, 'Model info cache populated')
  }
}

/**
 * Refresh the cache by listing models from every valid provider. Used both
 * for the startup pre-warm and the periodic refresh cron.
 *
 * Errors per-provider are caught and logged — one bad provider doesn't kill
 * the whole refresh.
 */
export async function refreshAllProviderModels(): Promise<void> {
  try {
    const allProviders = await db.select().from(providersTable).all()
    const tasks = allProviders
      .filter((p) => p.isValid)
      .filter((p) => {
        // Skip orphaned plugin providers — the row points at a
        // `plugin:<name>:<type>` namespace whose plugin is currently
        // disabled or uninstalled. Hitting listModels would just log
        // a warn per family per tick; the row is effectively dead
        // until the user reinstalls the plugin or deletes the row.
        if (!p.type.startsWith('plugin:')) return true
        if (getCapabilitiesForType(p.type).length > 0) return true
        log.debug({ providerId: p.id, name: p.name, type: p.type }, 'Skipping orphaned plugin provider')
        return false
      })
      .map(async (p) => {
        try {
          const cfg = await loadProviderConfig(p)
          const caps = JSON.parse(p.capabilities) as string[]
          // Hit listModels once per family the row serves so the cache
          // is populated for every model surface (not just LLM). Search
          // is excluded — search providers have no model selection.
          for (const family of caps) {
            if (family !== 'llm' && family !== 'embedding' && family !== 'image') continue
            await listModelsForProvider(p.type, cfg, family)
          }
        } catch (err) {
          log.warn(
            { providerId: p.id, name: p.name, type: p.type, err },
            'Model-info refresh failed for provider',
          )
        }
      })
    await Promise.allSettled(tasks)

    // Reconcile every provider's models into the registry (source of truth).
    // This runs ALWAYS (even with the flag off) so the Models view is populated
    // and admins can review/edit before enabling consumption — it only writes a
    // data table, no behavior change. The CONTEXT-CACHE OVERLAY below is what
    // changes behavior, so it stays flag-gated. (Phase 1: a no-op overlay since
    // apiSeed wins; once heuristics are removed in phase 3 the registry keeps
    // the cache correct.)
    try {
      await reconcileAllProviders()
      if (config.modelRegistry.enabled) {
        for (const row of listRegistry()) {
          if (row.stale) continue
          setModelInfo(row.modelId, {
            contextWindow: row.contextWindow ?? undefined,
            maxOutput: row.maxOutput ?? undefined,
          })
        }
      }
    } catch (err) {
      log.warn({ err }, 'Model registry reconcile failed')
    }

    log.info({ providerCount: tasks.length, totalCached: cache.size }, 'Model-info cache refresh complete')
  } catch (err) {
    log.warn({ err }, 'Model-info cache refresh failed')
  }
}

let refreshCron: Cron | null = null

/**
 * Schedule a recurring cache refresh. Runs once immediately, then on the
 * configured cron schedule. Default: every 6 hours.
 */
export function startModelInfoRefreshCron(): void {
  // Initial pre-warm — runs in the background so server startup isn't blocked.
  refreshAllProviderModels().catch(() => {})

  if (refreshCron) {
    refreshCron.stop()
  }
  refreshCron = new Cron(config.modelInfoRefreshCron, async () => {
    log.debug('Triggered scheduled model-info cache refresh')
    await refreshAllProviderModels()
  })
  log.info({ schedule: config.modelInfoRefreshCron }, 'Model-info cache refresh cron started')
}
