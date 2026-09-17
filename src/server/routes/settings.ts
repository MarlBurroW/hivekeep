import { THINKING_EFFORTS } from '@/shared/constants'
import type { AgentThinkingEffort } from '@/shared/types'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { userProfiles, agents } from '@/server/db/schema'
import {
  getGlobalPrompt,
  setGlobalPrompt,
  getAvatarStylePrompt,
  setAvatarStylePrompt,
  getAvatarSubject,
  setAvatarSubject,
  isAvatarBaseEnabled,
  setAvatarBaseEnabled,
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
  getDefaultScoutThinking,
  setDefaultScoutThinking,
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
import {
  generateNeutralAvatarBase,
  setCustomBaseAvatar,
  clearCustomBaseAvatar,
  ImageGenerationError,
} from '@/server/services/image-generation'
import { startBulkAvatarRegen, getBulkAvatarJob } from '@/server/services/avatar-regeneration'
import { sseManager } from '@/server/sse/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import { getBackupStatus } from '@/server/services/backup-status'

const log = createLogger('routes:settings')
const settingsRoutes = new Hono<{ Variables: AppVariables }>()

/**
 * Notify clients that a default-model setting changed.
 *
 * The setup checklist + AgentFormModal pre-fill rely on
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

// Verification is performed by the offline CLI; this endpoint exposes dates only.
settingsRoutes.get('/backup-status', async (c) => c.json(await getBackupStatus(config.dataDir)))

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

// PUT /api/settings/avatar-subject — global avatar SUBJECT/type (axis B)
settingsRoutes.put('/avatar-subject', async (c) => {
  const body = await c.req.json()
  const { avatarSubject } = body as { avatarSubject: string }
  if (typeof avatarSubject !== 'string') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'avatarSubject must be a string' } }, 400)
  }
  const trimmed = avatarSubject.trim()
  if (trimmed.length > 2000) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Avatar subject must be under 2,000 characters' } }, 400)
  }
  await setAvatarSubject(trimmed)
  log.info('Avatar subject updated')
  return c.json({ avatarSubject: trimmed })
})

// PUT /api/settings/avatar-base-enabled — toggle the img2img base reference
settingsRoutes.put('/avatar-base-enabled', async (c) => {
  const body = await c.req.json()
  const { enabled } = body as { enabled: boolean }
  if (typeof enabled !== 'boolean') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'enabled must be a boolean' } }, 400)
  }
  await setAvatarBaseEnabled(enabled)
  log.info({ enabled }, 'Avatar base reference toggled')
  return c.json({ baseEnabled: enabled })
})

// POST /api/settings/avatar-base/generate — generate a neutral base image in the
// current (or given) style + subject and lock it in as the img2img reference.
settingsRoutes.post('/avatar-base/generate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { providerId, modelId } = body as { providerId?: string; modelId?: string }
  try {
    const result = await generateNeutralAvatarBase({
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
    })
    const ext = result.mediaType.includes('webp') ? 'webp' : 'png'
    log.info('Neutral avatar base generated')
    return c.json({ baseImageUrl: `/api/agents/avatar-base/image?v=${Date.now()}`, ext })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Base avatar generation failed'
    log.error({ err }, 'Failed to generate neutral avatar base')
    return c.json({ error: { code: 'BASE_GENERATION_FAILED', message } }, 502)
  }
})

// POST /api/settings/avatar-base/upload — upload a custom base reference image.
settingsRoutes.post('/avatar-base/upload', async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file')
  if (!file || !(file instanceof File)) {
    return c.json({ error: { code: 'INVALID_FILE', message: 'No file provided' } }, 400)
  }
  const MAX_BASE_SIZE = 10 * 1024 * 1024
  if (file.size > MAX_BASE_SIZE) {
    return c.json({ error: { code: 'FILE_TOO_LARGE', message: 'Base image must be under 10MB' } }, 400)
  }
  const rawExt = (file.name.split('.').pop() ?? 'png').toLowerCase()
  const ext = ['png', 'webp', 'jpg', 'jpeg'].includes(rawExt) ? rawExt : 'png'
  const bytes = Buffer.from(await file.arrayBuffer())
  await setCustomBaseAvatar(bytes, ext)
  log.info({ ext }, 'Custom avatar base uploaded')
  return c.json({ baseImageUrl: `/api/agents/avatar-base/image?v=${Date.now()}`, hasCustomBase: true })
})

// DELETE /api/settings/avatar-base — drop the custom base, fall back to bundled.
settingsRoutes.delete('/avatar-base', async (c) => {
  clearCustomBaseAvatar()
  log.info('Custom avatar base cleared')
  return c.json({ baseImageUrl: `/api/agents/avatar-base/image?v=${Date.now()}`, hasCustomBase: false })
})

// GET /api/settings/avatars/bulk-regenerate — current/last bulk job snapshot,
// so the modal can hydrate live progress when reopened mid-run.
settingsRoutes.get('/avatars/bulk-regenerate', async (c) => {
  return c.json({ job: getBulkAvatarJob() })
})

// POST /api/settings/avatars/bulk-regenerate — kick off a background bulk
// regeneration of the selected agents' avatars through the normal "auto" flow.
// Returns immediately; progress streams over SSE (avatar-bulk:progress/done).
settingsRoutes.post('/avatars/bulk-regenerate', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { agentIds, imageProviderId, imageModel } = body as {
    agentIds?: unknown
    imageProviderId?: string
    imageModel?: string
  }

  if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((id) => typeof id === 'string')) {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'agentIds must be a non-empty array of agent ids' } },
      400,
    )
  }

  // Keep only ids that actually exist, preserving the caller's order.
  const existing = db.select({ id: agents.id }).from(agents).all()
  const existingIds = new Set(existing.map((a) => a.id))
  const validIds = (agentIds as string[]).filter((id) => existingIds.has(id))
  if (validIds.length === 0) {
    return c.json(
      { error: { code: 'NO_VALID_AGENTS', message: 'None of the given agents exist' } },
      400,
    )
  }

  if (getBulkAvatarJob()?.status === 'running') {
    return c.json(
      { error: { code: 'JOB_RUNNING', message: 'A bulk avatar regeneration is already running' } },
      409,
    )
  }

  try {
    const job = await startBulkAvatarRegen(validIds, {
      ...(imageProviderId ? { providerId: imageProviderId } : {}),
      ...(imageModel ? { modelId: imageModel } : {}),
    })
    log.info({ jobId: job.id, total: job.total }, 'Bulk avatar regeneration started')
    return c.json({ jobId: job.id, total: job.total })
  } catch (err) {
    if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
      return c.json({ error: { code: 'NO_IMAGE_PROVIDER', message: err.message } }, 422)
    }
    const message = err instanceof Error ? err.message : 'Bulk avatar regeneration failed'
    log.error({ err }, 'Failed to start bulk avatar regeneration')
    return c.json({ error: { code: 'BULK_REGEN_FAILED', message } }, 502)
  }
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
    defaultScoutThinking,
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
    getDefaultScoutThinking(),
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
    defaultScoutThinking,
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

// PUT /api/settings/default-scout-thinking
//
// Global default reasoning config for scouts (one tier of
// resolveScoutThinking()'s chain). Body: { thinking: AgentThinkingConfig | null }
// — null clears (scouts then fall back to the calling Agent's own config).
settingsRoutes.put('/default-scout-thinking', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const thinking = (body as { thinking?: unknown }).thinking

  if (thinking === null || thinking === undefined) {
    await setDefaultScoutThinking(null)
    log.info('Default scout thinking cleared')
    broadcastDefaultsUpdated()
    return c.json({ defaultScoutThinking: null })
  }
  if (typeof thinking !== 'object') {
    return c.json(
      { error: { code: 'INVALID_BODY', message: 'thinking must be an object or null' } },
      400,
    )
  }
  const cfg = thinking as Record<string, unknown>
  const enabled = cfg.enabled === true
  const effort = typeof cfg.effort === 'string' && (THINKING_EFFORTS as readonly string[]).includes(cfg.effort)
    ? (cfg.effort as AgentThinkingEffort)
    : null
  const sanitized = { enabled, ...(effort !== null ? { effort } : {}) }
  await setDefaultScoutThinking(sanitized)
  log.info({ thinking: sanitized }, 'Default scout thinking updated')
  broadcastDefaultsUpdated()
  return c.json({ defaultScoutThinking: sanitized })
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
// app_settings (single shared state across all admins — Hivekeep is a
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
