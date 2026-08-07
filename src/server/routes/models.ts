/**
 * Model registry routes — the admin "Models" view (Réglages). Lists every model
 * from every configured provider with its metadata (context, modalities,
 * reasoning, pricing) and lets the admin edit/override, remap to a models.dev
 * entry, switch a row to manual, unpin a field, or trigger a resync.
 *
 * Source of truth is the `model_registry` table (seeded from models.dev). See
 * `model-metadata.md`. Behind the `HIVEKEEP_MODEL_REGISTRY` flag at the consume
 * side; these routes always read/write the table so the view works regardless.
 */
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { modelRegistry, providers } from '@/server/db/schema'
import {
  updateRegistryModel,
  setMappingMode,
  remapModel,
  unpinField,
  resetModelToAuto,
  bulkSetEnabled,
  bulkConfirmReview,
  getRegistryRowById,
  type RegistryEditPatch,
  type RegistryField,
} from '@/server/services/model-registry'
import { listModelsDevKeys, listAllModelsDevKeys } from '@/server/llm/metadata/models-dev'
import { refreshAllProviderModels } from '@/server/services/model-info-cache'
import { refreshModelsDevSnapshot } from '@/server/services/models-dev-snapshot'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:models')

export const modelRoutes = new Hono<{ Variables: AppVariables }>()

// Reads stay member-accessible (pickers, list views); mutations are platform
// configuration and admin-only.
modelRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

type Row = typeof modelRegistry.$inferSelect

function serialize(row: Row, provider?: { name: string; slug: string; type: string }) {
  let reasoning: { enabled: boolean; efforts: string[] } | null = null
  try {
    reasoning = row.reasoning ? JSON.parse(row.reasoning) : null
  } catch { /* ignore */ }
  let pricing: Record<string, number> | null = null
  try {
    pricing = row.pricing ? JSON.parse(row.pricing) : null
  } catch { /* ignore */ }
  let overriddenFields: string[] = []
  try {
    overriddenFields = row.overriddenFields ? JSON.parse(row.overriddenFields) : []
  } catch { /* ignore */ }
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: provider?.name ?? null,
    providerSlug: provider?.slug ?? null,
    providerType: provider?.type ?? null,
    modelId: row.modelId,
    displayName: row.displayName,
    mappingMode: row.mappingMode,
    modelsDevKey: row.modelsDevKey,
    matchConfidence: row.matchConfidence,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    supportsToolCall: row.supportsToolCall,
    supportsImageInput: row.supportsImageInput,
    supportsPdfInput: row.supportsPdfInput,
    reasoning,
    pricing,
    overriddenFields,
    enabled: row.enabled,
    needsReview: row.needsReview,
    stale: row.stale,
    updatedAt: row.updatedAt,
  }
}

/** List every registry row, joined with its provider's name/slug/type. */
modelRoutes.get('/', (c) => {
  const rows = db.select().from(modelRegistry).all()
  const provs = db.select().from(providers).all()
  const byId = new Map(provs.map((p) => [p.id, p]))
  return c.json({
    models: rows.map((r) => serialize(r, byId.get(r.providerId))),
  })
})

/** models.dev candidate keys for the remap combobox. Returns the SAME provider's
 *  entries first (most likely), then the entire catalogue (searchable) — a
 *  subscription/plugin provider may legitimately map to another provider's id. */
modelRoutes.get('/:id/candidates', (c) => {
  const row = getRegistryRowById(c.req.param('id'))
  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Model not found' } }, 404)
  const prov = db.select().from(providers).where(eq(providers.id, row.providerId)).get()
  const same = prov ? listModelsDevKeys(prov.type) : []
  const sameSet = new Set(same)
  const rest = listAllModelsDevKeys().filter((k) => !sameSet.has(k))
  return c.json({ candidates: [...same, ...rest] })
})

/** Admin edit — each metadata field present is pinned (survives resync). */
modelRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  if (!getRegistryRowById(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Model not found' } }, 404)
  const body = (await c.req.json().catch(() => ({}))) as RegistryEditPatch
  updateRegistryModel(id, body)
  const updated = getRegistryRowById(id)!
  const prov = db.select().from(providers).where(eq(providers.id, updated.providerId)).get()
  return c.json({ model: serialize(updated, prov ?? undefined) })
})

/** Switch a row's mapping mode (auto | manual). */
modelRoutes.post('/:id/mode', async (c) => {
  const id = c.req.param('id')
  if (!getRegistryRowById(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Model not found' } }, 404)
  const { mode } = (await c.req.json().catch(() => ({}))) as { mode?: string }
  if (mode !== 'auto' && mode !== 'manual') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: "mode must be 'auto' or 'manual'" } }, 400)
  }
  setMappingMode(id, mode)
  const updated = getRegistryRowById(id)!
  const prov = db.select().from(providers).where(eq(providers.id, updated.providerId)).get()
  return c.json({ model: serialize(updated, prov ?? undefined) })
})

/** Re-point a row at a specific models.dev entry (or clear it with null). */
modelRoutes.post('/:id/remap', async (c) => {
  const id = c.req.param('id')
  if (!getRegistryRowById(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Model not found' } }, 404)
  const { modelsDevKey } = (await c.req.json().catch(() => ({}))) as { modelsDevKey?: string | null }
  remapModel(id, modelsDevKey ?? null)
  const updated = getRegistryRowById(id)!
  const prov = db.select().from(providers).where(eq(providers.id, updated.providerId)).get()
  return c.json({ model: serialize(updated, prov ?? undefined) })
})

/** Unpin a single field (revert it to auto on next resync). */
modelRoutes.post('/:id/unpin', async (c) => {
  const id = c.req.param('id')
  if (!getRegistryRowById(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Model not found' } }, 404)
  const { field } = (await c.req.json().catch(() => ({}))) as { field?: string }
  if (!field) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'field is required' } }, 400)
  unpinField(id, field as RegistryField)
  const updated = getRegistryRowById(id)!
  const prov = db.select().from(providers).where(eq(providers.id, updated.providerId)).get()
  return c.json({ model: serialize(updated, prov ?? undefined) })
})

/** Bulk action over a set of rows: enable / disable / confirm-review. */
modelRoutes.post('/bulk', async (c) => {
  const { ids, action } = (await c.req.json().catch(() => ({}))) as { ids?: string[]; action?: string }
  if (!Array.isArray(ids) || ids.length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ids must be a non-empty array' } }, 400)
  }
  let count = 0
  if (action === 'enable') count = bulkSetEnabled(ids, true)
  else if (action === 'disable') count = bulkSetEnabled(ids, false)
  else if (action === 'confirm') count = bulkConfirmReview(ids)
  else return c.json({ error: { code: 'VALIDATION_ERROR', message: "action must be 'enable', 'disable' or 'confirm'" } }, 400)
  return c.json({ ok: true, count })
})

/** Reset a row to fully automatic — drop every pin/manual override. */
modelRoutes.post('/:id/reset', async (c) => {
  const id = c.req.param('id')
  if (!getRegistryRowById(id)) return c.json({ error: { code: 'NOT_FOUND', message: 'Model not found' } }, 404)
  resetModelToAuto(id)
  const updated = getRegistryRowById(id)!
  const prov = db.select().from(providers).where(eq(providers.id, updated.providerId)).get()
  return c.json({ model: serialize(updated, prov ?? undefined) })
})

/** Trigger a resync (reconcile every provider against models.dev). */
modelRoutes.post('/resync', async (c) => {
  refreshAllProviderModels().catch((err) => log.warn({ err }, 'Manual resync failed'))
  return c.json({ ok: true })
})

/** Pull the latest models.dev catalogue (persisted to the data dir), then resync
 *  so the new metadata/matches take effect. Returns the catalogue size. */
modelRoutes.post('/refresh-snapshot', async (c) => {
  try {
    const { providerCount, modelCount } = await refreshModelsDevSnapshot()
    // Re-match every provider against the fresh snapshot (background).
    refreshAllProviderModels().catch((err) => log.warn({ err }, 'Resync after snapshot refresh failed'))
    return c.json({ ok: true, providerCount, modelCount })
  } catch (err) {
    log.warn({ err }, 'models.dev snapshot refresh failed')
    return c.json({ error: { code: 'REFRESH_FAILED', message: 'Could not fetch models.dev' } }, 502)
  }
})
