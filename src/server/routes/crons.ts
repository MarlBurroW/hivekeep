import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { kins } from '@/server/db/schema'
import {
  createCron,
  updateCron,
  deleteCron,
  getCron,
  listCrons,
  approveCron,
  triggerCronManually,
} from '@/server/services/crons'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:crons')

export const cronRoutes = new Hono<{ Variables: AppVariables }>()

function kinAvatarUrl(kinId: string, avatarPath: string | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  return `/api/uploads/kins/${kinId}/avatar.${ext}`
}

interface KinInfo { name: string; avatarPath: string | null }

// Serialize cron for API response
function parseThinkingConfig(raw: string | null | undefined): { enabled: boolean; effort: string | null } {
  if (!raw) return { enabled: false, effort: null }
  try {
    const parsed = JSON.parse(raw) as { enabled?: boolean; effort?: string | null }
    return { enabled: parsed?.enabled === true, effort: parsed?.effort ?? null }
  } catch {
    return { enabled: false, effort: null }
  }
}

/** Parse the stored `toolbox_ids` JSON into a string[] of toolbox ids ([] when
 *  absent/malformed) for the API response. */
function parseToolboxIds(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function serializeCron(cron: any, kinInfo?: KinInfo, targetKinInfo?: KinInfo) {
  return {
    id: cron.id,
    kinId: cron.kinId,
    kinName: kinInfo?.name ?? 'Unknown',
    kinAvatarUrl: kinInfo ? kinAvatarUrl(cron.kinId, kinInfo.avatarPath) : null,
    name: cron.name,
    schedule: cron.schedule,
    taskDescription: cron.taskDescription,
    targetKinId: cron.targetKinId,
    targetKinName: targetKinInfo?.name ?? null,
    targetKinAvatarUrl: cron.targetKinId && targetKinInfo ? kinAvatarUrl(cron.targetKinId, targetKinInfo.avatarPath) : null,
    model: cron.model,
    providerId: cron.providerId ?? null,
    thinkingEnabled: parseThinkingConfig(cron.thinkingConfig).enabled,
    thinkingEffort: parseThinkingConfig(cron.thinkingConfig).effort,
    toolboxIds: parseToolboxIds(cron.toolboxIds),
    runOnce: cron.runOnce,
    triggerParentTurn: cron.triggerParentTurn,
    isActive: cron.isActive,
    requiresApproval: cron.requiresApproval,
    lastTriggeredAt: cron.lastTriggeredAt ? new Date(cron.lastTriggeredAt).getTime() : null,
    createdBy: cron.createdBy,
    createdAt: new Date(cron.createdAt).getTime(),
  }
}

// GET /api/crons — list crons with optional kinId filter
cronRoutes.get('/', async (c) => {
  const kinId = c.req.query('kinId')
  const allCrons = await listCrons(kinId ?? undefined)

  // Fetch kin info (name + avatar) for owners and targets
  const kinIds = [...new Set([
    ...allCrons.map((cr) => cr.kinId),
    ...allCrons.map((cr) => cr.targetKinId).filter(Boolean) as string[],
  ])]
  const kinMap = new Map<string, KinInfo>()
  for (const id of kinIds) {
    const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, id)).get()
    if (kin) kinMap.set(id, kin)
  }

  return c.json({
    crons: allCrons.map((cr) => serializeCron(cr, kinMap.get(cr.kinId), cr.targetKinId ? kinMap.get(cr.targetKinId) : undefined)),
  })
})

// POST /api/crons — create a cron (user-created, no approval needed)
cronRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    kinId: string
    name: string
    schedule: string
    taskDescription: string
    targetKinId?: string
    model?: string
    providerId?: string
    runOnce?: boolean
    triggerParentTurn?: boolean
    thinkingEnabled?: boolean
    thinkingEffort?: 'low' | 'medium' | 'high' | 'max' | null
    toolboxIds?: string[]
  }>()

  if (!body.kinId || !body.name || !body.schedule || !body.taskDescription) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'kinId, name, schedule, and taskDescription are required' } },
      400,
    )
  }

  try {
    let thinkingConfig: { enabled: boolean; effort: 'low' | 'medium' | 'high' | 'max' | null } | undefined
    if (body.thinkingEffort !== undefined) {
      thinkingConfig = body.thinkingEffort === null
        ? { enabled: false, effort: null }
        : { enabled: true, effort: body.thinkingEffort }
    } else if (body.thinkingEnabled !== undefined) {
      thinkingConfig = { enabled: body.thinkingEnabled, effort: body.thinkingEnabled ? 'medium' : null }
    } else {
      thinkingConfig = { enabled: true, effort: 'medium' }
    }

    const cron = await createCron({
      kinId: body.kinId,
      name: body.name,
      schedule: body.schedule,
      taskDescription: body.taskDescription,
      targetKinId: body.targetKinId,
      model: body.model,
      providerId: body.providerId,
      runOnce: body.runOnce,
      triggerParentTurn: body.triggerParentTurn,
      thinkingConfig,
      toolboxIds: body.toolboxIds,
      createdBy: 'user',
    })

    log.info({ cronId: cron.id, kinId: cron.kinId, name: cron.name, schedule: cron.schedule }, 'Cron created')

    const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, cron.kinId)).get()
    const targetKin = cron.targetKinId ? await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, cron.targetKinId)).get() : undefined
    return c.json({ cron: serializeCron(cron, kin ?? undefined, targetKin ?? undefined) }, 201)
  } catch (err) {
    return c.json(
      { error: { code: 'CRON_CREATE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      400,
    )
  }
})

// PATCH /api/crons/:id — update a cron
cronRoutes.patch('/:id', async (c) => {
  const cronId = c.req.param('id')
  const existing = await getCron(cronId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Cron not found' } }, 404)
  }

  const body = await c.req.json<{
    name?: string
    schedule?: string
    taskDescription?: string
    targetKinId?: string | null
    model?: string | null
    providerId?: string | null
    isActive?: boolean
    runOnce?: boolean
    triggerParentTurn?: boolean
    thinkingEnabled?: boolean
    thinkingEffort?: 'low' | 'medium' | 'high' | 'max' | null
    toolboxIds?: string[] | null
  }>()

  try {
    const updates: Record<string, unknown> = { ...body }
    // Toolbox ids are stored as a JSON string (or null to clear → default 'all').
    if (body.toolboxIds !== undefined) {
      updates.toolboxIds = Array.isArray(body.toolboxIds) && body.toolboxIds.length > 0
        ? JSON.stringify(body.toolboxIds)
        : null
    }
    if (body.thinkingEffort !== undefined) {
      updates.thinkingConfig = body.thinkingEffort === null
        ? JSON.stringify({ enabled: false, effort: null })
        : JSON.stringify({ enabled: true, effort: body.thinkingEffort })
      delete updates.thinkingEffort
      delete updates.thinkingEnabled
    } else if (body.thinkingEnabled !== undefined) {
      updates.thinkingConfig = JSON.stringify({
        enabled: body.thinkingEnabled,
        effort: body.thinkingEnabled ? 'medium' : null,
      })
      delete updates.thinkingEnabled
    }
    const updated = await updateCron(cronId, updates)
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Cron not found' } }, 404)
    }

    const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, updated.kinId)).get()
    const targetKin = updated.targetKinId ? await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, updated.targetKinId)).get() : undefined
    return c.json({ cron: serializeCron(updated, kin ?? undefined, targetKin ?? undefined) })
  } catch (err) {
    return c.json(
      { error: { code: 'CRON_UPDATE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      400,
    )
  }
})

// POST /api/crons/:id/trigger — manually trigger a cron
cronRoutes.post('/:id/trigger', async (c) => {
  const cronId = c.req.param('id')
  const existing = await getCron(cronId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Cron not found' } }, 404)
  }

  try {
    const { taskId } = await triggerCronManually(cronId)
    log.info({ cronId, taskId, name: existing.name }, 'Cron manually triggered')
    return c.json({ taskId })
  } catch (err) {
    return c.json(
      { error: { code: 'CRON_TRIGGER_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      400,
    )
  }
})

// DELETE /api/crons/:id — delete a cron
cronRoutes.delete('/:id', async (c) => {
  const cronId = c.req.param('id')
  const existing = await getCron(cronId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Cron not found' } }, 404)
  }

  try {
    await deleteCron(cronId)
    log.info({ cronId, kinId: existing.kinId, name: existing.name }, 'Cron deleted')
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: { code: 'CRON_DELETE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      500,
    )
  }
})

// POST /api/crons/:id/approve — approve a Kin-created cron
cronRoutes.post('/:id/approve', async (c) => {
  const cronId = c.req.param('id')
  const existing = await getCron(cronId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Cron not found' } }, 404)
  }

  if (!existing.requiresApproval) {
    return c.json(
      { error: { code: 'ALREADY_APPROVED', message: 'This cron does not require approval' } },
      409,
    )
  }

  const approved = await approveCron(cronId)
  if (!approved) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Cron not found' } }, 404)
  }

  log.info({ cronId, kinId: approved.kinId, name: approved.name }, 'Cron approved')

  const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, approved.kinId)).get()
  const targetKin = approved.targetKinId ? await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, approved.targetKinId)).get() : undefined
  return c.json({ cron: serializeCron(approved, kin ?? undefined, targetKin ?? undefined) })
})
