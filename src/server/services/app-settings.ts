import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { appSettings } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'

const log = createLogger('app-settings')

// In-memory cache (single-process, invalidated on write)
const cache = new Map<string, string>()

// ─── OAuth app credentials (operator-level, keyed by provider type) ──────────
// The client id is non-secret (app_settings); the client secret is sensitive
// and goes to the vault. Used by the generic OAuth2 flow for email providers.

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export async function getOAuthClient(providerType: string): Promise<OAuthClient | null> {
  const clientId = await getSetting(`oauth_client:${providerType}:client_id`)
  if (!clientId) return null
  const { getSecretValue } = await import('@/server/services/vault')
  const clientSecret = await getSecretValue(`oauth_client:${providerType}:secret`)
  if (!clientSecret) return null
  return { clientId, clientSecret }
}

export async function setOAuthClient(providerType: string, client: OAuthClient): Promise<void> {
  await setSetting(`oauth_client:${providerType}:client_id`, client.clientId)
  const vault = await import('@/server/services/vault')
  const key = `oauth_client:${providerType}:secret`
  const updated = await vault.updateSecretValueByKey(key, client.clientSecret)
  if (!updated) {
    await vault.createSecret(key, client.clientSecret, undefined, `OAuth client secret for ${providerType}`)
  }
}

/** Update only the client id, keeping the stored secret. Used when editing an
 *  already-configured OAuth app without re-entering the (write-only) secret. */
export async function setOAuthClientId(providerType: string, clientId: string): Promise<void> {
  await setSetting(`oauth_client:${providerType}:client_id`, clientId)
}

export async function clearOAuthClient(providerType: string): Promise<void> {
  await deleteSetting(`oauth_client:${providerType}:client_id`)
  const vault = await import('@/server/services/vault')
  const existing = await vault.getSecretByKey(`oauth_client:${providerType}:secret`)
  if (existing) await vault.deleteSecret(existing.id)
}

export async function getDefaultEmailProviderId(): Promise<string | null> {
  return getSetting('default_email_provider_id')
}

export async function setDefaultEmailProviderId(id: string | null): Promise<void> {
  if (id == null) return deleteSetting('default_email_provider_id')
  return setSetting('default_email_provider_id', id)
}

export async function getSetting(key: string): Promise<string | null> {
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .get()

  if (row) {
    cache.set(key, row.value)
    return row.value
  }

  return null
}

export async function setSetting(key: string, value: string): Promise<void> {
  const now = Date.now()

  db.insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: now },
    })
    .run()

  cache.set(key, value)
  log.info({ key }, 'Setting updated')
}

export async function deleteSetting(key: string): Promise<void> {
  db.delete(appSettings).where(eq(appSettings.key, key)).run()
  cache.delete(key)
  log.info({ key }, 'Setting deleted')
}

export async function getGlobalPrompt(): Promise<string | null> {
  return getSetting('global_prompt')
}

export async function setGlobalPrompt(value: string): Promise<void> {
  return setSetting('global_prompt', value)
}

/** Optional global art-style directive applied to every generated Kin avatar
 *  (e.g. "heroic fantasy", "cyberpunk cyborg"). Empty/null → the built-in
 *  Pixar-robot baseline. Editable by the user (Settings) and the configurator
 *  Kin (set_avatar_style). See sherpa.md §9. */
export async function getAvatarStylePrompt(): Promise<string | null> {
  return getSetting('avatar_style_prompt')
}

export async function setAvatarStylePrompt(value: string): Promise<void> {
  if (value.trim() === '') return deleteSetting('avatar_style_prompt')
  return setSetting('avatar_style_prompt', value)
}

export async function getExtractionModel(): Promise<string | null> {
  return getSetting('extraction_model')
}

export async function setExtractionModel(model: string): Promise<void> {
  return setSetting('extraction_model', model)
}

export async function getEmbeddingModel(): Promise<string | null> {
  return getSetting('embedding_model')
}

export async function setEmbeddingModel(model: string): Promise<void> {
  return setSetting('embedding_model', model)
}

export async function getExtractionProviderId(): Promise<string | null> {
  return getSetting('extraction_provider_id')
}

export async function setExtractionProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('extraction_provider_id')
  return setSetting('extraction_provider_id', providerId)
}

export async function getEmbeddingProviderId(): Promise<string | null> {
  return getSetting('embedding_provider_id')
}

export async function setEmbeddingProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('embedding_provider_id')
  return setSetting('embedding_provider_id', providerId)
}

// ─── Default LLM (for new kins) ──────────────────────────────────────────────

export async function getDefaultLlmModel(): Promise<string | null> {
  return getSetting('default_llm_model')
}

export async function setDefaultLlmModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_llm_model')
  return setSetting('default_llm_model', model)
}

export async function getDefaultLlmProviderId(): Promise<string | null> {
  return getSetting('default_llm_provider_id')
}

export async function setDefaultLlmProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_llm_provider_id')
  return setSetting('default_llm_provider_id', providerId)
}

// ─── Default Scout Model (cheap delegation for the `scout` tool) ─────────────
//
// Global fallback for the scout model resolved by resolveScoutModel(). Sits
// near the end of the chain: per-spawn override → Kin scout → project scout →
// THIS global default → Kin's own main model. Mirrors getDefaultLlmModel /
// setDefaultLlmModel exactly (k/v, no dedicated column). A scout-less install
// leaves both null and every scout falls back to the main model.

export async function getDefaultScoutModel(): Promise<string | null> {
  return getSetting('default_scout_model')
}

export async function setDefaultScoutModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_scout_model')
  return setSetting('default_scout_model', model)
}

export async function getDefaultScoutProviderId(): Promise<string | null> {
  return getSetting('default_scout_provider_id')
}

export async function setDefaultScoutProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_scout_provider_id')
  return setSetting('default_scout_provider_id', providerId)
}

// ─── Default Image Model ─────────────────────────────────────────────────────

export async function getDefaultImageModel(): Promise<string | null> {
  return getSetting('default_image_model')
}

export async function setDefaultImageModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_image_model')
  return setSetting('default_image_model', model)
}

export async function getDefaultImageProviderId(): Promise<string | null> {
  return getSetting('default_image_provider_id')
}

export async function setDefaultImageProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_image_provider_id')
  return setSetting('default_image_provider_id', providerId)
}

// ─── Setup checklist (dismissed items) ──────────────────────────────────────

/**
 * Persisted per-instance list of setup-checklist item ids the user has
 * dismissed ("Skip" on the dashboard checklist). Stored as a JSON
 * array under a single app_settings row so we don't need a schema
 * migration for the feature.
 *
 * Multi-user note: KinBot is "individual or small group" with shared
 * configuration — this list is NOT per-user. A dismissed item stays
 * dismissed for every admin viewing the dashboard. Reactivation
 * happens from Settings → General → 'Show setup checklist'.
 */
export async function getDismissedSetupItems(): Promise<string[]> {
  const raw = await getSetting('dismissed_setup_items')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string') : []
  } catch {
    return []
  }
}

export async function setDismissedSetupItems(items: string[]): Promise<void> {
  // De-duplicate defensively so a sloppy client can't bloat the row.
  const unique = [...new Set(items)]
  if (unique.length === 0) return deleteSetting('dismissed_setup_items')
  return setSetting('dismissed_setup_items', JSON.stringify(unique))
}

export async function dismissSetupItem(itemId: string): Promise<void> {
  const items = await getDismissedSetupItems()
  if (items.includes(itemId)) return
  return setDismissedSetupItems([...items, itemId])
}

export async function restoreSetupItem(itemId: string): Promise<void> {
  const items = await getDismissedSetupItems()
  if (!items.includes(itemId)) return
  return setDismissedSetupItems(items.filter((i) => i !== itemId))
}

// ─── Default Search Provider ─────────────────────────────────────────────────

/**
 * Default search provider used by `web_search` when the LLM doesn't
 * pass an explicit `providerSlug`. Stored as the provider's UUID (same
 * convention as default_llm_provider_id). The `web_search` tool resolves
 * the row at call time and exposes it to the LLM as a slug for
 * human-readable tool input.
 *
 * No `default_search_model` companion: search providers have no model
 * selection (one provider == one search endpoint).
 */
export async function getDefaultSearchProviderId(): Promise<string | null> {
  return getSetting('default_search_provider_id')
}

export async function setDefaultSearchProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_search_provider_id')
  return setSetting('default_search_provider_id', providerId)
}

// ─── Default TTS Provider ────────────────────────────────────────────────────

/**
 * Default TTS provider used by `text_to_speech` when the LLM doesn't
 * pass an explicit provider slug. Voice selection is independent — the
 * tool always takes an explicit `voice_id` (and `provider_slug` when
 * cross-provider).
 *
 * No `default_tts_voice` companion: voices are per-tool-call (or per
 * channel config later), not per global default.
 */
export async function getDefaultTtsProviderId(): Promise<string | null> {
  return getSetting('default_tts_provider_id')
}

export async function setDefaultTtsProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_tts_provider_id')
  return setSetting('default_tts_provider_id', providerId)
}

// ─── Default STT Provider ────────────────────────────────────────────────────

/**
 * Default STT provider used by `transcribe_audio` when the LLM doesn't
 * pass an explicit provider slug. The transcription model is picked at
 * call time (provider default unless the LLM overrides via model_id).
 */
export async function getDefaultSttProviderId(): Promise<string | null> {
  return getSetting('default_stt_provider_id')
}

export async function setDefaultSttProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_stt_provider_id')
  return setSetting('default_stt_provider_id', providerId)
}

// ─── Default Compacting Model ────────────────────────────────────────────────

export async function getDefaultCompactingModel(): Promise<string | null> {
  return getSetting('default_compacting_model')
}

export async function setDefaultCompactingModel(model: string | null): Promise<void> {
  if (model === null) return deleteSetting('default_compacting_model')
  return setSetting('default_compacting_model', model)
}

export async function getDefaultCompactingProviderId(): Promise<string | null> {
  return getSetting('default_compacting_provider_id')
}

export async function setDefaultCompactingProviderId(providerId: string | null): Promise<void> {
  if (providerId === null) return deleteSetting('default_compacting_provider_id')
  return setSetting('default_compacting_provider_id', providerId)
}

// ─── Global task execution-slot limits ───────────────────────────────────────
//
// Two runtime-configurable knobs for the GLOBAL execution-slot task queue
// (composes with the per-group no-overlap queue, which stays as-is):
//
//   tasks_max_concurrent — how many tasks may be EXECUTING (status in
//     {pending,in_progress}) at once. Suspended tasks (awaiting_*/paused) are
//     idle and don't occupy a slot. When full, new/resuming tasks go 'queued'
//     and are promoted as slots free.
//   tasks_max_queue — anti-runaway guard: the max number of 'queued' tasks
//     allowed to pile up. spawnTask throws TASK_QUEUE_FULL above this.
//
// Both are k/v rows (mirroring getDefaultLlmModel/getDefaultScoutModel). The
// config / env values (config.tasks.maxConcurrent) act only as the seed
// DEFAULT when the app_settings row is unset — the DB value, once written from
// the Settings UI, wins and is read LIVE at each spawn/resume/promote decision.

/** Default seed for tasks_max_concurrent when the DB row is unset. */
const DEFAULT_MAX_CONCURRENT_TASKS = config.tasks.maxConcurrent
/** Default seed for tasks_max_queue when the DB row is unset. */
const DEFAULT_MAX_QUEUED_TASKS = 100

/** Parse a stored integer setting, returning the fallback for null/NaN/<1. */
function parsePositiveIntSetting(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback
  return n
}

/**
 * Like parsePositiveIntSetting but accepts 0 — used for tasks_max_queue, where 0
 * is a LEGITIMATE setting ("never queue: reject with TASK_QUEUE_FULL the moment
 * the global slots are full"). A negative / NaN / non-integer value still falls
 * back to the seed default. Without this, a stored 0 would be silently bumped to
 * the default by the >= 1 floor, and the Settings UI (which re-reads the getter)
 * would show 100 after the admin saved 0.
 */
function parseNonNegativeIntSetting(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback
  return n
}

export async function getMaxConcurrentTasks(): Promise<number> {
  return parsePositiveIntSetting(await getSetting('tasks_max_concurrent'), DEFAULT_MAX_CONCURRENT_TASKS)
}

export async function setMaxConcurrentTasks(value: number | null): Promise<void> {
  // Snapshot the live value BEFORE writing so we can tell a RAISE from a lower.
  const previous = await getMaxConcurrentTasks()

  if (value === null) {
    await deleteSetting('tasks_max_concurrent')
  } else {
    await setSetting('tasks_max_concurrent', String(value))
  }

  // Read the now-effective value (handles null→default and clamping in the
  // getter). RAISING the cap frees slots immediately — drive the global queue so
  // waiting tasks fill them without waiting for the next natural release.
  // LOWERING is soft: nothing to do — promotion naturally stops while the
  // executing count is >= the new cap, and running tasks are never cancelled.
  const next = await getMaxConcurrentTasks()
  if (next > previous) {
    // Dynamic import avoids an app-settings ↔ tasks circular import at load time.
    import('@/server/services/tasks')
      .then(({ promoteGlobalQueue }) =>
        promoteGlobalQueue().catch((err) =>
          log.error({ err }, 'Failed to promote global queue after raising maxConcurrent'),
        ),
      )
      .catch((err) => log.error({ err }, 'Failed to load tasks for maxConcurrent-raise promote'))
  }
}

export async function getMaxQueuedTasks(): Promise<number> {
  // 0 is valid here (disable queueing) — use the non-negative parser so a stored
  // 0 survives instead of being floored back up to the default.
  return parseNonNegativeIntSetting(await getSetting('tasks_max_queue'), DEFAULT_MAX_QUEUED_TASKS)
}

export async function setMaxQueuedTasks(value: number | null): Promise<void> {
  if (value === null) return deleteSetting('tasks_max_queue')
  return setSetting('tasks_max_queue', String(value))
}

