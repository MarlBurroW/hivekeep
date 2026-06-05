import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { userProfiles, kins } from '@/server/db/schema'
import {
  getGlobalPrompt,
  setGlobalPrompt,
  getAvatarStylePrompt,
  setAvatarStylePrompt,
  deleteSetting,
  getExtractionModel,
  setExtractionModel,
  getEmbeddingModel,
  setEmbeddingModel,
  getExtractionProviderId,
  setExtractionProviderId,
  getEmbeddingProviderId,
  setEmbeddingProviderId,
  getDefaultLlmModel,
  setDefaultLlmModel,
  getDefaultLlmProviderId,
  setDefaultLlmProviderId,
  getDefaultImageModel,
  setDefaultImageModel,
  getDefaultImageProviderId,
  setDefaultImageProviderId,
  getDefaultCompactingModel,
  setDefaultCompactingModel,
  getDefaultCompactingProviderId,
  setDefaultCompactingProviderId,
  getDefaultScoutModel,
  setDefaultScoutModel,
  getDefaultScoutProviderId,
  setDefaultScoutProviderId,
  getDefaultSearchProviderId,
  setDefaultSearchProviderId,
  getDefaultTtsProviderId,
  setDefaultTtsProviderId,
  getDefaultSttProviderId,
  setDefaultSttProviderId,
  getDismissedSetupItems,
  dismissSetupItem,
  restoreSetupItem,
  getMaxConcurrentTasks,
  setMaxConcurrentTasks,
  getMaxQueuedTasks,
  setMaxQueuedTasks,
} from '@/server/services/app-settings'
import { sseManager } from '@/server/sse/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:settings')
const settingsRoutes = new Hono<{ Variables: AppVariables }>()

/**
 * Notify clients that a default-model setting changed.
 *
 * The setup checklist + KinFormModal pre-fill rely on
 * `/settings/default-models`, but there was no event to invalidate
 * them — adding a default LLM updated the navbar popover (popovers
 * remount fresh on open) but left the inline checklist stale. One
 * coarse event keeps the wiring trivial: clients refetch the
 * defaults payload, recompute, done.
 */
function broadcastDefaultsUpdated() {
  sseManager.broadcast({ type: 'settings:defaults-updated', data: {} })
}

// Admin guard
settingsRoutes.use('*', async (c, next) => {
  const currentUser = c.get('user')
  const profile = db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, currentUser.id))
    .get()

  if (!profile || profile.role !== 'admin') {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Admin access required' } },
      403,
    )
  }
  return next()
})

// GET /api/settings/global-prompt
settingsRoutes.get('/global-prompt', async (c) => {
  const value = await getGlobalPrompt()
  return c.json({ globalPrompt: value ?? '' })
})

// PUT /api/settings/global-prompt
settingsRoutes.put('/global-prompt', async (c) => {
  const body = await c.req.json()
  const { globalPrompt } = body as { globalPrompt: string }

  if (typeof globalPrompt !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'globalPrompt must be a string' } },
      400,
    )
  }

  const trimmed = globalPrompt.trim()

  if (trimmed.length > 10000) {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'Global prompt must be under 10,000 characters' } },
      400,
    )
  }

  if (trimmed === '') {
    await deleteSetting('global_prompt')
  } else {
    await setGlobalPrompt(trimmed)
  }

  log.info('Global prompt updated')
  return c.json({ globalPrompt: trimmed })
})

// GET /api/settings/avatar-style
settingsRoutes.get('/avatar-style', async (c) => {
  const value = await getAvatarStylePrompt()
  return c.json({ avatarStyle: value ?? '' })
})

// PUT /api/settings/avatar-style
settingsRoutes.put('/avatar-style', async (c) => {
  const body = await c.req.json()
  const { avatarStyle } = body as { avatarStyle: string }
  if (typeof avatarStyle !== 'string') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'avatarStyle must be a string' } }, 400)
  }
  const trimmed = avatarStyle.trim()
  if (trimmed.length > 2000) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Avatar style must be under 2,000 characters' } }, 400)
  }
  await setAvatarStylePrompt(trimmed)
  log.info('Avatar style updated')
  return c.json({ avatarStyle: trimmed })
})

// GET /api/settings/models — legacy endpoint (extraction + embedding only)
settingsRoutes.get('/models', async (c) => {
  const [extractionModel, embeddingModel, extractionProviderId, embeddingProviderId] = await Promise.all([
    getExtractionModel(),
    getEmbeddingModel(),
    getExtractionProviderId(),
    getEmbeddingProviderId(),
  ])
  return c.json({ extractionModel, embeddingModel, extractionProviderId, embeddingProviderId })
})

// GET /api/settings/default-models — all model/service defaults in one payload
settingsRoutes.get('/default-models', async (c) => {
  const [
    defaultLlmModel, defaultLlmProviderId,
    defaultImageModel, defaultImageProviderId,
    defaultCompactingModel, defaultCompactingProviderId,
    defaultScoutModel, defaultScoutProviderId,
    extractionModel, extractionProviderId,
    embeddingModel, embeddingProviderId,
    defaultSearchProviderId,
    defaultTtsProviderId,
    defaultSttProviderId,
  ] = await Promise.all([
    getDefaultLlmModel(), getDefaultLlmProviderId(),
    getDefaultImageModel(), getDefaultImageProviderId(),
    getDefaultCompactingModel(), getDefaultCompactingProviderId(),
    getDefaultScoutModel(), getDefaultScoutProviderId(),
    getExtractionModel(), getExtractionProviderId(),
    getEmbeddingModel(), getEmbeddingProviderId(),
    getDefaultSearchProviderId(),
    getDefaultTtsProviderId(),
    getDefaultSttProviderId(),
  ])
  return c.json({
    defaultLlmModel, defaultLlmProviderId,
    defaultImageModel, defaultImageProviderId,
    defaultCompactingModel, defaultCompactingProviderId,
    defaultScoutModel, defaultScoutProviderId,
    extractionModel, extractionProviderId,
    embeddingModel, embeddingProviderId,
    defaultSearchProviderId,
    defaultTtsProviderId,
    defaultSttProviderId,
  })
})

// PUT /api/settings/default-llm
settingsRoutes.put('/default-llm', async (c) => {
  const body = await c.req.json()
  const { model, providerId } = body as { model: string | null; providerId?: string | null }

  if (model !== null && typeof model !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'model must be a string or null' } },
      400,
    )
  }

  if (!model || model.trim() === '') {
    await setDefaultLlmModel(null)
    await setDefaultLlmProviderId(null)
    log.info('Default LLM model cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultLlmModel: null, defaultLlmProviderId: null })
  }

  await setDefaultLlmModel(model.trim())
  await setDefaultLlmProviderId(providerId ?? null)
  log.info({ model: model.trim(), providerId }, 'Default LLM model updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultLlmModel: model.trim(), defaultLlmProviderId: providerId ?? null })
})

// PUT /api/settings/default-image
settingsRoutes.put('/default-image', async (c) => {
  const body = await c.req.json()
  const { model, providerId } = body as { model: string | null; providerId?: string | null }

  if (model !== null && typeof model !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'model must be a string or null' } },
      400,
    )
  }

  if (!model || model.trim() === '') {
    await setDefaultImageModel(null)
    await setDefaultImageProviderId(null)
    log.info('Default image model cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultImageModel: null, defaultImageProviderId: null })
  }

  await setDefaultImageModel(model.trim())
  await setDefaultImageProviderId(providerId ?? null)
  log.info({ model: model.trim(), providerId }, 'Default image model updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultImageModel: model.trim(), defaultImageProviderId: providerId ?? null })
})

// PUT /api/settings/default-compacting
settingsRoutes.put('/default-compacting', async (c) => {
  const body = await c.req.json()
  const { model, providerId } = body as { model: string | null; providerId?: string | null }

  if (model !== null && typeof model !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'model must be a string or null' } },
      400,
    )
  }

  if (!model || model.trim() === '') {
    await setDefaultCompactingModel(null)
    await setDefaultCompactingProviderId(null)
    log.info('Default compacting model cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultCompactingModel: null, defaultCompactingProviderId: null })
  }

  await setDefaultCompactingModel(model.trim())
  await setDefaultCompactingProviderId(providerId ?? null)
  log.info({ model: model.trim(), providerId }, 'Default compacting model updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultCompactingModel: model.trim(), defaultCompactingProviderId: providerId ?? null })
})

// PUT /api/settings/default-scout
//
// Global fallback for the cheap "scout" model resolved by resolveScoutModel().
// Same body/clearing semantics as /default-llm and /default-compacting.
settingsRoutes.put('/default-scout', async (c) => {
  const body = await c.req.json()
  const { model, providerId } = body as { model: string | null; providerId?: string | null }

  if (model !== null && typeof model !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'model must be a string or null' } },
      400,
    )
  }

  if (!model || model.trim() === '') {
    await setDefaultScoutModel(null)
    await setDefaultScoutProviderId(null)
    log.info('Default scout model cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultScoutModel: null, defaultScoutProviderId: null })
  }

  await setDefaultScoutModel(model.trim())
  await setDefaultScoutProviderId(providerId ?? null)
  log.info({ model: model.trim(), providerId }, 'Default scout model updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultScoutModel: model.trim(), defaultScoutProviderId: providerId ?? null })
})

// PUT /api/settings/default-search
//
// Search providers have no "model" — the body is provider-only.
settingsRoutes.put('/default-search', async (c) => {
  const body = await c.req.json()
  const { providerId } = body as { providerId: string | null }

  if (providerId !== null && typeof providerId !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'providerId must be a string or null' } },
      400,
    )
  }

  if (!providerId || providerId.trim() === '') {
    await setDefaultSearchProviderId(null)
    log.info('Default search provider cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultSearchProviderId: null })
  }

  await setDefaultSearchProviderId(providerId.trim())
  log.info({ providerId: providerId.trim() }, 'Default search provider updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultSearchProviderId: providerId.trim() })
})

// PUT /api/settings/default-tts
//
// TTS defaults to a provider — voice is per-call (or per channel later),
// never a global default.
settingsRoutes.put('/default-tts', async (c) => {
  const body = await c.req.json()
  const { providerId } = body as { providerId: string | null }

  if (providerId !== null && typeof providerId !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'providerId must be a string or null' } },
      400,
    )
  }

  if (!providerId || providerId.trim() === '') {
    await setDefaultTtsProviderId(null)
    log.info('Default TTS provider cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultTtsProviderId: null })
  }

  await setDefaultTtsProviderId(providerId.trim())
  log.info({ providerId: providerId.trim() }, 'Default TTS provider updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultTtsProviderId: providerId.trim() })
})

// PUT /api/settings/default-stt
//
// STT defaults to a provider — the transcription model is picked at
// call time (provider default unless the tool overrides via model_id).
settingsRoutes.put('/default-stt', async (c) => {
  const body = await c.req.json()
  const { providerId } = body as { providerId: string | null }

  if (providerId !== null && typeof providerId !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'providerId must be a string or null' } },
      400,
    )
  }

  if (!providerId || providerId.trim() === '') {
    await setDefaultSttProviderId(null)
    log.info('Default STT provider cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultSttProviderId: null })
  }

  await setDefaultSttProviderId(providerId.trim())
  log.info({ providerId: providerId.trim() }, 'Default STT provider updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultSttProviderId: providerId.trim() })
})

// PUT /api/settings/extraction-model
settingsRoutes.put('/extraction-model', async (c) => {
  const body = await c.req.json()
  const { model, providerId } = body as { model: string | null; providerId?: string | null }

  if (model !== null && typeof model !== 'string') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'model must be a string or null' } },
      400,
    )
  }

  if (!model || model.trim() === '') {
    await deleteSetting('extraction_model')
    await setExtractionProviderId(null)
    log.info('Extraction model cleared')
    broadcastDefaultsUpdated()
    return c.json({ extractionModel: null, extractionProviderId: null })
  }

  await setExtractionModel(model.trim())
  await setExtractionProviderId(providerId ?? null)
  log.info({ model: model.trim(), providerId }, 'Extraction model updated')
  broadcastDefaultsUpdated()
  return c.json({ extractionModel: model.trim(), extractionProviderId: providerId ?? null })
})

// PUT /api/settings/embedding-model
settingsRoutes.put('/embedding-model', async (c) => {
  const body = await c.req.json()
  const { model, providerId } = body as { model: string; providerId?: string | null }

  if (!model || typeof model !== 'string' || model.trim() === '') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'model must be a non-empty string' } },
      400,
    )
  }

  await setEmbeddingModel(model.trim())
  await setEmbeddingProviderId(providerId ?? null)
  log.info({ model: model.trim(), providerId }, 'Embedding model updated')
  broadcastDefaultsUpdated()
  return c.json({ embeddingModel: model.trim(), embeddingProviderId: providerId ?? null })
})

// ─── Global task execution-slot limits ───────────────────────────────────────
//
// Runtime knobs for the GLOBAL execution-slot task queue (composes with the
// per-group no-overlap queue, which stays as-is):
//   maxConcurrent — how many tasks may be EXECUTING ({pending,in_progress}) at
//     once. Suspended tasks (awaiting_*/paused) release their slot. When full,
//     new/resuming tasks go 'queued' and are promoted as slots free.
//   maxQueue — anti-runaway guard: max number of 'queued' tasks allowed to
//     pile up before spawnTask rejects with TASK_QUEUE_FULL.
//
// The DB values (app_settings k/v) win over the config/env seed default and are
// read LIVE at each spawn/resume/promote decision.

/** Validation bounds (sane caps to stop a fat-finger from melting the box). */
const MAX_CONCURRENT_UPPER_BOUND = 1000
const MAX_QUEUE_UPPER_BOUND = 100_000

// GET /api/settings/task-limits
settingsRoutes.get('/task-limits', async (c) => {
  const [maxConcurrent, maxQueue] = await Promise.all([
    getMaxConcurrentTasks(),
    getMaxQueuedTasks(),
  ])
  return c.json({ maxConcurrent, maxQueue })
})

// PUT /api/settings/task-limits
//
// Sets either/both limits. Calling setMaxConcurrentTasks() is what triggers an
// immediate promoteGlobalQueue() when the cap is RAISED (lowering is a soft
// no-op — running tasks are never cancelled). Validation:
//   maxConcurrent: integer in [1, MAX_CONCURRENT_UPPER_BOUND]
//   maxQueue:      integer in [0, MAX_QUEUE_UPPER_BOUND]
settingsRoutes.put('/task-limits', async (c) => {
  const body = await c.req.json()
  const { maxConcurrent, maxQueue } = body as {
    maxConcurrent?: unknown
    maxQueue?: unknown
  }

  if (maxConcurrent !== undefined) {
    if (
      typeof maxConcurrent !== 'number' ||
      !Number.isInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      maxConcurrent > MAX_CONCURRENT_UPPER_BOUND
    ) {
      return c.json(
        {
          error: {
            code: 'INVALID_BODY',
            message: `maxConcurrent must be an integer between 1 and ${MAX_CONCURRENT_UPPER_BOUND}`,
          },
        },
        400,
      )
    }
  }

  if (maxQueue !== undefined) {
    if (
      typeof maxQueue !== 'number' ||
      !Number.isInteger(maxQueue) ||
      maxQueue < 0 ||
      maxQueue > MAX_QUEUE_UPPER_BOUND
    ) {
      return c.json(
        {
          error: {
            code: 'INVALID_BODY',
            message: `maxQueue must be an integer between 0 and ${MAX_QUEUE_UPPER_BOUND}`,
          },
        },
        400,
      )
    }
  }

  // setMaxConcurrentTasks() snapshots the previous value and triggers
  // promoteGlobalQueue() on a RAISE (see app-settings.ts). Apply it first so the
  // queue starts filling before we report back.
  if (maxConcurrent !== undefined) {
    await setMaxConcurrentTasks(maxConcurrent)
  }
  if (maxQueue !== undefined) {
    await setMaxQueuedTasks(maxQueue)
  }

  const [nextConcurrent, nextQueue] = await Promise.all([
    getMaxConcurrentTasks(),
    getMaxQueuedTasks(),
  ])
  log.info({ maxConcurrent: nextConcurrent, maxQueue: nextQueue }, 'Task limits updated')
  return c.json({ maxConcurrent: nextConcurrent, maxQueue: nextQueue })
})

// ─── Setup checklist (dismissed items) ──────────────────────────────────────
//
// The dashboard checklist tracks which items the user has dismissed
// ('Skip' button) so the UI doesn't keep nagging about features the
// instance owner has consciously opted out of. Storage is global
// app_settings (single shared state across all admins — KinBot is a
// small-group product, not multi-tenant per-user).

// GET /api/settings/dismissed-setup-items
settingsRoutes.get('/dismissed-setup-items', async (c) => {
  const items = await getDismissedSetupItems()
  return c.json({ items })
})

// POST /api/settings/dismissed-setup-items/:itemId — dismiss (skip) an item
settingsRoutes.post('/dismissed-setup-items/:itemId', async (c) => {
  const itemId = c.req.param('itemId')
  if (!itemId || typeof itemId !== 'string' || itemId.length > 64) {
    return c.json(
      { error: { code: 'INVALID_ITEM_ID', message: 'itemId must be a non-empty string under 64 chars' } },
      400,
    )
  }
  await dismissSetupItem(itemId)
  const items = await getDismissedSetupItems()
  log.info({ itemId }, 'Setup checklist item dismissed')
  return c.json({ items })
})

// DELETE /api/settings/dismissed-setup-items/:itemId — un-dismiss (restore) an item
settingsRoutes.delete('/dismissed-setup-items/:itemId', async (c) => {
  const itemId = c.req.param('itemId')
  if (!itemId || typeof itemId !== 'string') {
    return c.json(
      { error: { code: 'INVALID_ITEM_ID', message: 'itemId is required' } },
      400,
    )
  }
  await restoreSetupItem(itemId)
  const items = await getDismissedSetupItems()
  log.info({ itemId }, 'Setup checklist item restored')
  return c.json({ items })
})

export { settingsRoutes }
