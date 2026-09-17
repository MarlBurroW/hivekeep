import type { AgentThinkingEffort } from '@/shared/types'
import { Hono } from 'hono'
import { eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents, tasks } from '@/server/db/schema'
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
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:crons')

export const cronRoutes = new Hono<{ Variables: AppVariables }>()

// Reads stay member-accessible (pickers, list views); mutations are platform
// configuration and admin-only.
cronRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

function agentAvatarUrl(agentId: string, avatarPath: string | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  return `/api/uploads/agents/${agentId}/avatar.${ext}`
}

interface AgentInfo { name: string; avatarPath: string | null }

/** Count how many tasks each cron has spawned (one task per execution). Returns
 *  a cronId → count map; missing crons mean zero. Uses the idx_tasks_cron index. */
async function countTasksByCron(cronIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (cronIds.length === 0) return map
  const rows = await db
    .select({ cronId: tasks.cronId, count: sql<number>`count(*)` })
    .from(tasks)
    .where(inArray(tasks.cronId, cronIds))
    .groupBy(tasks.cronId)
    .all()
  for (const r of rows) {
    if (r.cronId) map.set(r.cronId, Number(r.count))
  }
  return map
}

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

function serializeCron(cron: any, agentInfo?: AgentInfo, targetAgentInfo?: AgentInfo, executionCount = 0) {
  return {
    executionCount,
    id: cron.id,
    agentId: cron.agentId,
    agentName: agentInfo?.name ?? 'Unknown',
    agentAvatarUrl: agentInfo ? agentAvatarUrl(cron.agentId, agentInfo.avatarPath) : null,
    name: cron.name,
    schedule: cron.schedule,
    taskDescription: cron.taskDescription,
    targetAgentId: cron.targetAgentId,
    targetAgentName: targetAgentInfo?.name ?? null,
    targetAgentAvatarUrl: cron.targetAgentId && targetAgentInfo ? agentAvatarUrl(cron.targetAgentId, targetAgentInfo.avatarPath) : null,
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

// GET /api/crons — list crons with optional agentId filter
cronRoutes.get('/', async (c) => {
  const agentId = c.req.query('agentId')
  const allCrons = await listCrons(agentId ?? undefined)

  // Fetch agent info (name + avatar) for owners and targets
  const agentIds = [...new Set([
    ...allCrons.map((cr) => cr.agentId),
    ...allCrons.map((cr) => cr.targetAgentId).filter(Boolean) as string[],
  ])]
  const agentMap = new Map<string, AgentInfo>()
  for (const id of agentIds) {
    const agent = await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, id)).get()
    if (agent) agentMap.set(id, agent)
  }

  const execCounts = await countTasksByCron(allCrons.map((cr) => cr.id))

  return c.json({
    crons: allCrons.map((cr) => serializeCron(
      cr,
      agentMap.get(cr.agentId),
      cr.targetAgentId ? agentMap.get(cr.targetAgentId) : undefined,
      execCounts.get(cr.id) ?? 0,
    )),
  })
})

// POST /api/crons — create a cron (user-created, no approval needed)
cronRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    agentId: string
    name: string
    schedule: string
    taskDescription: string
    targetAgentId?: string
    model?: string
    providerId?: string
    runOnce?: boolean
    triggerParentTurn?: boolean
    thinkingEnabled?: boolean
    thinkingEffort?: AgentThinkingEffort | null
    toolboxIds?: string[]
  }>()

  if (!body.agentId || !body.name || !body.schedule || !body.taskDescription) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'agentId, name, schedule, and taskDescription are required' } },
      400,
    )
  }

  try {
    let thinkingConfig: { enabled: boolean; effort: AgentThinkingEffort | null } | undefined
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
      agentId: body.agentId,
      name: body.name,
      schedule: body.schedule,
      taskDescription: body.taskDescription,
      targetAgentId: body.targetAgentId,
      model: body.model,
      providerId: body.providerId,
      runOnce: body.runOnce,
      triggerParentTurn: body.triggerParentTurn,
      thinkingConfig,
      toolboxIds: body.toolboxIds,
      createdBy: 'user',
    })

    log.info({ cronId: cron.id, agentId: cron.agentId, name: cron.name, schedule: cron.schedule }, 'Cron created')

    const agent = await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, cron.agentId)).get()
    const targetAgent = cron.targetAgentId ? await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, cron.targetAgentId)).get() : undefined
    return c.json({ cron: serializeCron(cron, agent ?? undefined, targetAgent ?? undefined) }, 201)
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
    targetAgentId?: string | null
    model?: string | null
    providerId?: string | null
    isActive?: boolean
    runOnce?: boolean
    triggerParentTurn?: boolean
    thinkingEnabled?: boolean
    thinkingEffort?: AgentThinkingEffort | null
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

    const agent = await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, updated.agentId)).get()
    const targetAgent = updated.targetAgentId ? await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, updated.targetAgentId)).get() : undefined
    const execCount = (await countTasksByCron([updated.id])).get(updated.id) ?? 0
    return c.json({ cron: serializeCron(updated, agent ?? undefined, targetAgent ?? undefined, execCount) })
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
    log.info({ cronId, agentId: existing.agentId, name: existing.name }, 'Cron deleted')
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: { code: 'CRON_DELETE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      500,
    )
  }
})

// POST /api/crons/:id/approve — approve an Agent-created cron
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

  log.info({ cronId, agentId: approved.agentId, name: approved.name }, 'Cron approved')

  const agent = await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, approved.agentId)).get()
  const targetAgent = approved.targetAgentId ? await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, approved.targetAgentId)).get() : undefined
  const approvedExecCount = (await countTasksByCron([approved.id])).get(approved.id) ?? 0
  return c.json({ cron: serializeCron(approved, agent ?? undefined, targetAgent ?? undefined, approvedExecCount) })
})
