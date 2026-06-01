import { Cron } from 'croner'
import { eq, and } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { crons, kins, messages, tasks } from '@/server/db/schema'
import { spawnTask } from '@/server/services/tasks'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'

const log = createLogger('crons')

// ─── In-memory scheduler map ─────────────────────────────────────────────────

const scheduledJobs = new Map<string, Cron>()

// ─── CRUD ────────────────────────────────────────────────────────────────────

interface CreateCronParams {
  kinId: string
  name: string
  schedule: string
  taskDescription: string
  targetKinId?: string
  model?: string
  providerId?: string
  createdBy: 'user' | 'kin'
  runOnce?: boolean
  triggerParentTurn?: boolean
  thinkingConfig?: { enabled: boolean; budgetTokens?: number | null }
  /** Toolbox ids defining the native toolset of tasks spawned by this cron.
   *  Omitted/empty → spawn default ('all' for crons). */
  toolboxIds?: string[]
}

/** Safely parse the stored `toolbox_ids` JSON into a string[] for spawnTask.
 *  Returns undefined when absent or malformed so spawnTask applies its default. */
function parseToolboxIds(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const ids = parsed.filter((x): x is string => typeof x === 'string')
      return ids.length > 0 ? ids : undefined
    }
  } catch {
    // fall through
  }
  return undefined
}

export async function createCron(params: CreateCronParams) {
  // Check max active limit
  const activeCrons = await db
    .select()
    .from(crons)
    .where(eq(crons.isActive, true))
    .all()

  if (activeCrons.length >= config.crons.maxActive) {
    throw new Error(`Max active crons (${config.crons.maxActive}) reached`)
  }

  // Validate schedule (cron expression or ISO datetime for one-shot)
  try {
    const arg = _parseCronArg(params.schedule)
    if (arg instanceof Date) {
      if (arg <= new Date()) throw new Error('Datetime must be in the future')
    } else {
      new Cron(arg, { paused: true, timezone: config.timezone })
    }
  } catch (err) {
    throw new Error(
      `Invalid schedule: "${params.schedule}" — ${err instanceof Error ? err.message : err}`,
    )
  }

  const id = uuid()
  const now = new Date()

  // Kin-created crons require approval before activation
  const isKinCreated = params.createdBy === 'kin'

  await db.insert(crons).values({
    id,
    kinId: params.kinId,
    name: params.name,
    schedule: params.schedule,
    taskDescription: params.taskDescription,
    targetKinId: params.targetKinId ?? null,
    model: params.model ?? null,
    providerId: params.providerId ?? null,
    thinkingConfig: params.thinkingConfig ? JSON.stringify(params.thinkingConfig) : null,
    toolboxIds: params.toolboxIds && params.toolboxIds.length > 0 ? JSON.stringify(params.toolboxIds) : null,
    isActive: !isKinCreated,
    requiresApproval: isKinCreated,
    runOnce: params.runOnce ?? false,
    triggerParentTurn: params.triggerParentTurn ?? false,
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
  })

  const created = await db.select().from(crons).where(eq(crons.id, id)).get()

  // Schedule immediately if active
  if (created && created.isActive) {
    scheduleJob(created)
  }

  // Emit SSE so sidebar picks up kin-created crons in real-time
  if (created) {
    sseManager.broadcast({
      type: 'cron:created',
      kinId: created.kinId,
      data: { cronId: created.id, kinId: created.kinId },
    })

    // Persistent notification for Kin-created crons requiring approval
    if (isKinCreated) {
      const { createNotification } = await import('@/server/services/notifications')
      createNotification({
        type: 'cron:pending-approval',
        title: 'Cron needs approval',
        body: params.name,
        kinId: params.kinId,
        relatedId: id,
        relatedType: 'cron',
      }).catch(() => {})
    }
  }

  return created!
}

export async function updateCron(
  cronId: string,
  updates: Partial<{
    name: string
    schedule: string
    taskDescription: string
    targetKinId: string | null
    model: string | null
    providerId: string | null
    thinkingConfig: string | null
    toolboxIds: string | null
    isActive: boolean
    runOnce: boolean
    triggerParentTurn: boolean
  }>,
) {
  // Validate new schedule if provided
  if (updates.schedule) {
    try {
      const arg = _parseCronArg(updates.schedule)
      if (arg instanceof Date) {
        if (arg <= new Date()) throw new Error('Datetime must be in the future')
      } else {
        new Cron(arg, { paused: true, timezone: config.timezone })
      }
    } catch (err) {
      throw new Error(
        `Invalid schedule: "${updates.schedule}" — ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  await db
    .update(crons)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(crons.id, cronId))

  const updated = await db.select().from(crons).where(eq(crons.id, cronId)).get()
  if (!updated) return null

  // Reschedule or stop the job
  stopJob(cronId)
  if (updated.isActive) {
    scheduleJob(updated)
  }

  sseManager.broadcast({
    type: 'cron:updated',
    kinId: updated.kinId,
    data: { cronId: updated.id, kinId: updated.kinId },
  })

  return updated
}

export async function deleteCron(cronId: string) {
  stopJob(cronId)

  // Nullify FK references on tasks before deleting the cron
  await db
    .update(tasks)
    .set({ cronId: null })
    .where(eq(tasks.cronId, cronId))

  const existing = await db.select().from(crons).where(eq(crons.id, cronId)).get()
  await db.delete(crons).where(eq(crons.id, cronId))

  if (existing) {
    sseManager.broadcast({
      type: 'cron:deleted',
      kinId: existing.kinId,
      data: { cronId, kinId: existing.kinId },
    })
  }
}

export async function getCron(cronId: string) {
  return db.select().from(crons).where(eq(crons.id, cronId)).get()
}

export async function listCrons(kinId?: string) {
  if (kinId) {
    return db.select().from(crons).where(eq(crons.kinId, kinId)).all()
  }
  return db.select().from(crons).all()
}

export async function approveCron(cronId: string) {
  await db
    .update(crons)
    .set({ requiresApproval: false, isActive: true, updatedAt: new Date() })
    .where(eq(crons.id, cronId))

  const approved = await db.select().from(crons).where(eq(crons.id, cronId)).get()
  if (approved) {
    scheduleJob(approved)
    sseManager.broadcast({
      type: 'cron:updated',
      kinId: approved.kinId,
      data: { cronId: approved.id, kinId: approved.kinId },
    })
  }

  return approved
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/** Parse a wall-clock datetime string ("2026-05-11T14:00[:00]") in the given
 *  IANA timezone and return the corresponding absolute Date. */
function _parseWallClockInTz(s: string, timezone: string): Date {
  // Treat the bare string as UTC to extract its calendar fields safely.
  const padded = /T\d{2}:\d{2}(:\d{2})?/.test(s) ? s : s + 'T00:00:00'
  const asUtc = new Date(padded + 'Z')
  if (isNaN(asUtc.getTime())) return new Date(NaN)

  // Compute the offset of `timezone` at that moment by formatting `asUtc`
  // in the target zone and comparing the wall-clock fields it produces
  // to the UTC fields we just parsed.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(
    fmt.formatToParts(asUtc).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>
  const hour = parts.hour === '24' ? '00' : parts.hour
  const wallInTz = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second),
  )
  const offsetMs = wallInTz - asUtc.getTime()
  return new Date(asUtc.getTime() - offsetMs)
}

/**
 * Detect whether a schedule string is an ISO 8601 datetime or a cron expression.
 * Returns a Date for datetime strings, or the original string for cron expressions.
 *
 * Datetimes with an explicit offset (Z or ±HH:MM) are parsed natively; bare
 * wall-clock datetimes are interpreted in the configured server timezone.
 */
function _parseCronArg(schedule: string): string | Date {
  if (/^\d{4}-\d{2}-\d{2}/.test(schedule)) {
    const hasOffset = /([Zz]|[+\-]\d{2}:?\d{2})$/.test(schedule)
    const d = hasOffset ? new Date(schedule) : _parseWallClockInTz(schedule, config.timezone)
    if (!isNaN(d.getTime())) return d
  }
  return schedule
}

function scheduleJob(cron: typeof crons.$inferSelect) {
  // Don't schedule if already scheduled
  if (scheduledJobs.has(cron.id)) return

  const cronArg = _parseCronArg(cron.schedule)
  // Absolute Dates fire at a fixed UTC instant — passing timezone would be
  // meaningless. For cron expressions, anchor wall-clock semantics in
  // config.timezone so "0 14 * * *" means 14:00 server-time, not 14:00 UTC.
  const cronOpts = cronArg instanceof Date ? undefined : { timezone: config.timezone }

  const job = new Cron(cronArg, cronOpts ?? {}, async () => {
    try {
      await triggerCron(cron.id)
      // Auto-deactivate after first fire for one-shot crons
      if (cron.runOnce) {
        await db
          .update(crons)
          .set({ isActive: false, updatedAt: new Date() })
          .where(eq(crons.id, cron.id))
        stopJob(cron.id)
        sseManager.broadcast({
          type: 'cron:updated',
          kinId: cron.kinId,
          data: { cronId: cron.id, kinId: cron.kinId },
        })
        log.info({ cronId: cron.id, name: cron.name }, 'One-shot cron fired and deactivated')
      }
    } catch (err) {
      log.error({ cronId: cron.id, err }, 'Cron trigger error')
    }
  })

  scheduledJobs.set(cron.id, job)
  log.info(
    { cronId: cron.id, name: cron.name, schedule: cron.schedule, runOnce: cron.runOnce },
    'Cron scheduled',
  )
}

export function stopJob(cronId: string) {
  const job = scheduledJobs.get(cronId)
  if (job) {
    job.stop()
    scheduledJobs.delete(cronId)
  }
}

export async function triggerCronManually(cronId: string): Promise<{ taskId: string }> {
  const cron = await db.select().from(crons).where(eq(crons.id, cronId)).get()
  if (!cron) throw new Error('Cron not found')
  if (cron.requiresApproval) throw new Error('Cron is pending approval and cannot be triggered')

  // Update last triggered
  await db
    .update(crons)
    .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
    .where(eq(crons.id, cronId))

  // 'await' wakes the parent Kin for an LLM turn when the task ends; 'async' is
  // silent (report injected, no turn). Controlled by the triggerParentTurn flag.
  const { taskId } = await spawnTask({
    parentKinId: cron.kinId,
    title: cron.name,
    description: cron.taskDescription,
    mode: cron.triggerParentTurn ? 'await' : 'async',
    spawnType: cron.targetKinId ? 'other' : 'self',
    sourceKinId: cron.targetKinId ?? undefined,
    model: cron.model ?? undefined,
    providerId: cron.providerId ?? undefined,
    cronId: cron.id,
    thinkingConfig: cron.thinkingConfig ? JSON.parse(cron.thinkingConfig) : undefined,
    toolboxIds: parseToolboxIds(cron.toolboxIds),
  })

  sseManager.sendToKin(cron.kinId, {
    type: 'cron:triggered',
    kinId: cron.kinId,
    data: { cronId: cron.id, kinId: cron.kinId, taskId },
  })

  log.info({ cronId: cron.id, cronName: cron.name, taskId }, 'Cron triggered manually')
  return { taskId }
}

async function triggerCron(cronId: string) {
  const cron = await db.select().from(crons).where(eq(crons.id, cronId)).get()
  if (!cron || !cron.isActive || cron.requiresApproval) return

  // Update last triggered
  await db
    .update(crons)
    .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
    .where(eq(crons.id, cronId))

  // Spawn sub-Kin task. Default 'async' mode is silent (report injected, no LLM
  // turn). When triggerParentTurn is set, use 'await' so the final report wakes
  // the parent Kin for a turn (enables auto-calibration / conditional actions).
  // Uses concurrency groups to queue tasks instead of dropping when max is reached
  const { taskId } = await spawnTask({
    parentKinId: cron.kinId,
    title: cron.name,
    description: cron.taskDescription,
    mode: cron.triggerParentTurn ? 'await' : 'async',
    spawnType: cron.targetKinId ? 'other' : 'self',
    sourceKinId: cron.targetKinId ?? undefined,
    model: cron.model ?? undefined,
    providerId: cron.providerId ?? undefined,
    cronId: cron.id,
    thinkingConfig: cron.thinkingConfig ? JSON.parse(cron.thinkingConfig) : undefined,
    toolboxIds: parseToolboxIds(cron.toolboxIds),
    concurrencyGroup: `cron:${cron.id}`,
    concurrencyMax: config.crons.maxConcurrentExecutions,
  })

  // Emit SSE event
  sseManager.sendToKin(cron.kinId, {
    type: 'cron:triggered',
    kinId: cron.kinId,
    data: { cronId: cron.id, kinId: cron.kinId, taskId },
  })

  log.info({ cronId: cron.id, cronName: cron.name, taskId }, 'Cron triggered')
}

// ─── Boot: restore all active crons ─────────────────────────────────────────

export async function initCronScheduler() {
  const activeCrons = await db
    .select()
    .from(crons)
    .where(and(eq(crons.isActive, true), eq(crons.requiresApproval, false)))
    .all()

  for (const cron of activeCrons) {
    scheduleJob(cron)
  }

  log.info({ count: activeCrons.length }, 'Restored active crons')
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

export function stopAllCrons() {
  for (const [id, job] of scheduledJobs) {
    job.stop()
  }
  scheduledJobs.clear()
}
