import type { ModelMessage } from '@/server/tools/tool-helper'
import type { Tool } from '@/server/tools/tool-helper'
import { eq, and, desc, asc, inArray, like, or, sql, gte, lte, isNull, isNotNull } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { tasks, kins, messages, tickets, projects } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { buildSystemPrompt } from '@/server/services/prompt-builder'
import { getSystemContext } from '@/server/services/system-context'
import { buildSegmentedMessages } from '@/server/services/llm-cache-hints'
import { stringifyToolResultValue } from '@/server/llm/core/vercel-bridge'
import type { KinbotMessage, KinbotMessageBlock } from '@/server/llm/llm/types'
import { resolveThinkingConfig, isContextTooLargeError, sanitizePersistedToolCalls, getActiveKinStreamSnapshot } from '@/server/services/kin-engine'
import { toolRegistry } from '@/server/tools/index'
import { resolveMCPTools } from '@/server/services/mcp'
import { resolveCustomTools } from '@/server/services/custom-tools'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { getGlobalPrompt } from '@/server/services/app-settings'
import { wrapToolsWithSpill } from '@/server/services/tool-output-spill'
import { executeToolBatch } from '@/server/services/tool-executor'
import { recordUsage, aggregateUsages, getTaskTotals } from '@/server/services/token-usage'
import { runStreamStep } from '@/server/services/stream-runner'
import type { TaskStatus, TaskMode, KinToolConfig, KinThinkingConfig } from '@/shared/types'

const log = createLogger('tasks')

/**
 * Strip execute functions from tools so the SDK only collects tool call intents
 * without executing them. This allows our custom loop to execute tools
 * sequentially between LLM steps, preventing hallucinated tool results.
 */
function stripToolExecute(tools: Record<string, Tool>): Record<string, Tool> {
  const schemas: Record<string, Tool> = {}
  for (const [name, t] of Object.entries(tools)) {
    const { execute: _execute, ...rest } = t
    schemas[name] = rest
  }
  return schemas
}

// AbortController registry — one per actively-streaming task
const activeTaskAbortControllers = new Map<string, AbortController>()

/** Abort a running task stream. Returns true if a stream was actually aborted. */
export function abortTaskStream(taskId: string): boolean {
  const controller = activeTaskAbortControllers.get(taskId)
  if (!controller) return false
  controller.abort()
  activeTaskAbortControllers.delete(taskId)
  return true
}

/** Check whether a task currently has an active LLM stream. */
export function isTaskStreaming(taskId: string): boolean {
  return activeTaskAbortControllers.has(taskId)
}

// Live in-memory snapshot of the currently-streaming assistant message per task.
// The DB is only checkpointed every 500ms of text + at each tool-batch boundary,
// so a client reconnecting mid-stream would otherwise miss any text emitted
// between the last checkpoint and connect time, breaking tool-call offset
// alignment in the UI. Reading this map gives the route handler the live values.
export interface ActiveTaskStreamSnapshot {
  messageId: string
  content: string
  toolCalls: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }>
  reasoning: Array<{ offset: number; text: string }>
}

const activeTaskStreams = new Map<string, ActiveTaskStreamSnapshot>()

/** Read-only access to an in-flight task's accumulated content/tool-calls/reasoning.
 *  The returned arrays are live references held by `executeSubKin` — callers must not mutate them. */
export function getActiveTaskSnapshot(taskId: string): ActiveTaskStreamSnapshot | undefined {
  return activeTaskStreams.get(taskId)
}

/** Build a public avatar URL from a Kin's stored avatar path */
function kinAvatarUrl(kinId: string, avatarPath: string | null, updatedAt?: Date | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  const v = updatedAt ? updatedAt.getTime() : Date.now()
  return `/api/uploads/kins/${kinId}/avatar.${ext}?v=${v}`
}

// ─── Startup Recovery ────────────────────────────────────────────────────────

/**
 * Recover orphaned tasks stuck in 'pending' or 'in_progress' status.
 * This can happen after a crash or restart. Called once at worker startup.
 * Marks them as 'failed' so they don't block concurrent limits or spin forever.
 */
export function recoverStaleTasks() {
  // Note: 'awaiting_human_input' is NOT recovered — the human can still respond after restart
  // Note: 'awaiting_kin_response' IS recovered — the timeout timer is lost on restart
  // Note: 'queued' IS recovered — the promotion mechanism is lost on restart
  // Note: 'paused' IS recovered — the user context is lost on restart
  const result = sqlite.run(
    `UPDATE tasks SET status = 'failed', error = 'Interrupted by server restart', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status IN ('queued', 'pending', 'in_progress', 'paused', 'awaiting_kin_response')`,
    [Date.now(), Date.now()],
  )
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'Recovered stale tasks → marked as failed')
  }
}

// ─── Concurrency Group Helpers ───────────────────────────────────────────────

const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'paused', 'awaiting_human_input', 'awaiting_kin_response']

async function countActiveTasksInGroup(group: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.concurrencyGroup, group), inArray(tasks.status, ACTIVE_STATUSES)))
    .all()
  return result[0]?.count ?? 0
}

export async function promoteNextQueuedTask(group: string, maxConcurrent: number) {
  const activeCount = await countActiveTasksInGroup(group)
  if (activeCount >= maxConcurrent) return

  // Get oldest queued task in this group
  const next = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.concurrencyGroup, group), eq(tasks.status, 'queued')))
    .orderBy(asc(tasks.queuedAt))
    .limit(1)
    .get()

  if (!next) return

  // Promote: queued → pending
  await db
    .update(tasks)
    .set({ status: 'pending', queuedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, next.id))

  // Resolve executing Kin info for SSE
  const executingKinId = next.sourceKinId ?? next.parentKinId
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  sseManager.sendToKin(next.parentKinId, {
    type: 'task:status',
    kinId: next.parentKinId,
    data: {
      taskId: next.id,
      kinId: next.parentKinId,
      status: 'pending',
      title: next.title ?? next.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
    },
  })

  log.info({ taskId: next.id, group }, 'Queued task promoted to pending')

  // Notify source Kin (for spawn_type = 'other')
  if (next.spawnType === 'other' && next.sourceKinId) {
    const taskLabel = next.title ?? next.description
    const briefDesc = next.description.length > 200
      ? next.description.slice(0, 200) + '...'
      : next.description
    notifySourceKin(next.sourceKinId, next.parentKinId, `[Task assigned: ${taskLabel}] ${briefDesc}`, next.id)
      .catch((err) => log.warn({ taskId: next.id, sourceKinId: next.sourceKinId, err }, 'Failed to notify source Kin on promote'))
  }

  // Execute the sub-Kin
  executeSubKin(next.id).catch((err) =>
    log.error({ taskId: next.id, err }, 'Sub-Kin execution error after promotion'),
  )
}

export async function forcePromoteTask(taskId: string): Promise<boolean> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'queued') return false

  await db
    .update(tasks)
    .set({ status: 'pending', queuedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  const executingKinId = task.sourceKinId ?? task.parentKinId
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId: task.id,
      kinId: task.parentKinId,
      status: 'pending',
      title: task.title ?? task.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
    },
  })

  log.info({ taskId, group: task.concurrencyGroup }, 'Task force-promoted')

  if (task.spawnType === 'other' && task.sourceKinId) {
    const taskLabel = task.title ?? task.description
    const briefDesc = task.description.length > 200 ? task.description.slice(0, 200) + '...' : task.description
    notifySourceKin(task.sourceKinId, task.parentKinId, `[Task assigned: ${taskLabel}] ${briefDesc}`, task.id)
      .catch((err) => log.warn({ taskId, sourceKinId: task.sourceKinId, err }, 'Failed to notify source Kin on force-promote'))
  }

  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin execution error after force-promote'),
  )

  return true
}

// ─── Source Kin Notification ─────────────────────────────────────────────────

/**
 * Deposit an informational message in the source Kin's main session.
 * No queue entry → no LLM turn triggered.
 * Follows the same pattern as inter-kin 'inform' messages.
 * Only used for spawn_type = 'other' tasks.
 */
async function notifySourceKin(
  sourceKinId: string,
  parentKinId: string,
  content: string,
  taskId: string,
) {
  // Guard: source Kin must still exist
  const sourceKin = await db.select({ id: kins.id }).from(kins).where(eq(kins.id, sourceKinId)).get()
  if (!sourceKin) return

  const parentKin = await db
    .select({ name: kins.name })
    .from(kins)
    .where(eq(kins.id, parentKinId))
    .get()

  const msgId = uuid()
  await db.insert(messages).values({
    id: msgId,
    kinId: sourceKinId,
    role: 'user',
    content,
    sourceType: 'task',
    sourceId: parentKinId,
    metadata: JSON.stringify({ relatedTaskId: taskId, fromParentKinId: parentKinId }),
    createdAt: new Date(),
  })

  sseManager.sendToKin(sourceKinId, {
    type: 'chat:message',
    kinId: sourceKinId,
    data: {
      id: msgId,
      role: 'user',
      content,
      sourceType: 'task',
      sourceId: parentKinId,
      sourceName: parentKin?.name ?? null,
      resolvedTaskId: taskId,
      createdAt: Date.now(),
    },
  })
}

// ─── Spawn ───────────────────────────────────────────────────────────────────

interface SpawnParams {
  parentKinId: string
  title?: string
  description: string
  mode: TaskMode
  spawnType: 'self' | 'other'
  sourceKinId?: string
  model?: string
  providerId?: string
  parentTaskId?: string
  cronId?: string
  depth?: number
  allowHumanPrompt?: boolean
  channelOriginId?: string
  webhookId?: string
  ticketId?: string
  /** Specialized task variant — see schema. Defaults to 'execute'. */
  kind?: 'execute' | 'enrich'
  thinkingConfig?: KinThinkingConfig
  concurrencyGroup?: string
  concurrencyMax?: number
  /** Optional sub-Kin tool preset override. When set, replaces the
   *  auto-picked preset (ticket → 'code', else full surface). Use 'all' to
   *  explicitly disable filtering on a ticket task. */
  toolPreset?: 'code' | 'research' | 'ops' | 'all'
  /** Optional run-specific sur-prompt persisted on the task row and injected
   *  into the ticket-assignment block at prompt-build time. Ticket tasks only. */
  runPrompt?: string | null
  /** When true, insert the task row but do NOT kick off `executeSubKin`. The
   *  caller is responsible for starting execution (e.g. after seeding cloned
   *  messages). Used by `retryTask`. */
  skipExecute?: boolean
}

/**
 * Frozen-at-spawn snapshot of every piece of stable prompt context for a task.
 * Together with `tasks.ticket_assignment_snapshot`, this captures *all* the
 * sources of the sub-Kin's stable system prefix so that re-entries (request_input
 * replies, sub-sub-task completions, human_prompt answers, parent replies,
 * nudges) reuse a byte-identical prefix → the Anthropic prompt cache stays
 * warm across the entire lifetime of the task. External DB edits made during
 * execution (renaming the Kin, editing its character, adding cron learnings,
 * tweaking the global prompt, registering a new Kin) deliberately do NOT reach
 * a running task — they will only take effect on subsequent spawns.
 *
 * Dates are serialized as ISO strings so the JSON survives a round-trip through
 * the TEXT column; readers convert them back to `Date` where the prompt-builder
 * expects them.
 */
export interface TaskPromptContextSnapshot {
  kin: {
    name: string
    slug: string | null
    role: string
    character: string
    expertise: string
    workspacePath: string
    model: string
    providerId: string | null
    thinkingConfig: string | null
    toolConfig: string | null
  }
  globalPrompt: string | null
  kinDirectory: Array<{ id: string; slug: string | null; name: string; role: string }>
  previousCronRuns?: Array<{
    status: string
    result: string | null
    createdAt: string
    updatedAt: string
  }>
  cronLearnings?: Array<{
    id: string
    content: string
    category: string | null
    createdAt: string
  }>
}

/** Build the prompt-context snapshot at spawn time. Resolves the identity Kin
 *  using the same rule as `executeSubKin` (parent unless `spawn_type='other'`
 *  with a `sourceKinId`). Throws if the identity Kin is missing. */
async function captureTaskPromptContextSnapshot(params: {
  parentKinId: string
  sourceKinId?: string | null
  spawnType: 'self' | 'other'
  cronId?: string | null
}): Promise<TaskPromptContextSnapshot> {
  const identityKinId = params.spawnType === 'other' && params.sourceKinId
    ? params.sourceKinId
    : params.parentKinId
  const identityKin = await db.select().from(kins).where(eq(kins.id, identityKinId)).get()
  if (!identityKin) throw new Error('IDENTITY_KIN_NOT_FOUND')

  const [globalPrompt, kinDirectory] = await Promise.all([
    getGlobalPrompt(),
    (await import('@/server/services/inter-kin')).listAvailableKins(identityKin.id),
  ])

  const snapshot: TaskPromptContextSnapshot = {
    kin: {
      name: identityKin.name,
      slug: identityKin.slug,
      role: identityKin.role,
      character: identityKin.character,
      expertise: identityKin.expertise,
      workspacePath: identityKin.workspacePath,
      model: identityKin.model,
      providerId: identityKin.providerId,
      thinkingConfig: identityKin.thinkingConfig,
      toolConfig: identityKin.toolConfig,
    },
    globalPrompt,
    kinDirectory,
  }

  if (params.cronId) {
    const runs = await fetchPreviousCronRuns(params.cronId, 5)
    snapshot.previousCronRuns = runs.map((r) => ({
      status: r.status,
      result: r.result,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }))
    const learnings = (await import('@/server/services/cron-learnings')).fetchCronLearnings(params.cronId)
    snapshot.cronLearnings = learnings.map((l) => ({
      id: l.id,
      content: l.content,
      category: l.category,
      createdAt: l.createdAt.toISOString(),
    }))
  }

  return snapshot
}

export async function spawnTask(params: SpawnParams) {
  const depth = params.depth ?? 1

  // Check max depth
  if (depth > config.tasks.maxDepth) {
    throw new Error(`Max task depth (${config.tasks.maxDepth}) exceeded`)
  }

  // Check max concurrent
  const activeTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['pending', 'in_progress']))
    .all()

  if (activeTasks.length >= config.tasks.maxConcurrent) {
    throw new Error(`Max concurrent tasks (${config.tasks.maxConcurrent}) reached`)
  }

  const taskId = uuid()
  const now = new Date()

  // Determine initial status — if concurrency group is full, start as 'queued'
  const concurrencyGroup = params.concurrencyGroup ?? null
  const concurrencyMax = params.concurrencyMax ?? null
  let initialStatus: 'pending' | 'queued' = 'pending'

  if (concurrencyGroup && concurrencyMax) {
    const activeCount = await countActiveTasksInGroup(concurrencyGroup)
    if (activeCount >= concurrencyMax) {
      initialStatus = 'queued'
    }
  }

  // Safety net: ticket-linked tasks must run in await mode (Phase 26 — projects.md § 5)
  if (params.ticketId && params.mode === 'async') {
    throw new Error('TICKET_TASK_REQUIRES_AWAIT')
  }

  // Freeze the ticket assignment context at spawn time so the sub-Kin's stable
  // system prefix doesn't change for the lifetime of this task. Without the
  // freeze, every re-entry (request_input reply, sub-sub-task completion,
  // human_prompt answer, nudge) rebuilt the block live — and any change to
  // ticket fields, tags, or comments invalidated the Anthropic prompt cache,
  // forcing a full prefix recompute on each re-entry.
  let ticketAssignmentSnapshot: string | null = null
  if (params.ticketId) {
    const { buildTicketAssignmentInfo } = await import('@/server/services/tickets')
    // Pass the spawn-time runPrompt so the per-run sur-prompt block is baked
    // into the frozen snapshot. Without this, the sub-Kin would see the run
    // prompt only on the first turn (via the live-fetch path that no longer
    // runs once the snapshot is present).
    const info = await buildTicketAssignmentInfo(params.ticketId, {
      runPrompt: params.runPrompt ?? null,
      currentTaskId: taskId,
    })
    if (info) ticketAssignmentSnapshot = JSON.stringify(info)
  }

  // Freeze the rest of the stable system context (Kin identity, global prompt,
  // Kin directory, cron context). Same motivation as the ticket snapshot above:
  // make the sub-Kin's stable prefix byte-identical across re-entries so the
  // Anthropic prompt cache survives.
  const promptContextSnapshot = JSON.stringify(
    await captureTaskPromptContextSnapshot({
      parentKinId: params.parentKinId,
      sourceKinId: params.sourceKinId ?? null,
      spawnType: params.spawnType,
      cronId: params.cronId ?? null,
    }),
  )

  // Project-level defaults: if the task is ticket-bound and no explicit task
  // override is set, inherit the project's defaults (model + thinking).
  // Frozen at spawn so the task keeps the same config across all re-entries
  // (same motivation as the ticket assignment snapshot above — keep Anthropic
  // prompt cache warm).
  // Priority chain (per field): params > project > kin (kin fallback happens
  // at execution time when the task column stays null).
  let effectiveModel = params.model ?? null
  let effectiveProviderId = params.providerId ?? null
  let effectiveThinkingConfig: KinThinkingConfig | null = params.thinkingConfig ?? null
  if ((!effectiveModel || !effectiveThinkingConfig) && params.ticketId) {
    const projectRow = db
      .select({
        model: projects.model,
        providerId: projects.providerId,
        thinkingConfig: projects.thinkingConfig,
      })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .where(eq(tickets.id, params.ticketId))
      .get()
    if (!effectiveModel && projectRow?.model) {
      effectiveModel = projectRow.model
      effectiveProviderId = projectRow.providerId
    }
    if (!effectiveThinkingConfig && projectRow?.thinkingConfig) {
      try {
        effectiveThinkingConfig = JSON.parse(projectRow.thinkingConfig) as KinThinkingConfig
      } catch {
        // Malformed JSON on the project row — ignore and fall back to the Kin.
        effectiveThinkingConfig = null
      }
    }
  }

  await db.insert(tasks).values({
    id: taskId,
    parentKinId: params.parentKinId,
    sourceKinId: params.sourceKinId ?? null,
    spawnType: params.spawnType,
    kind: params.kind ?? 'execute',
    mode: params.mode,
    model: effectiveModel,
    providerId: effectiveProviderId,
    title: params.title ?? null,
    description: params.description,
    status: initialStatus,
    depth,
    parentTaskId: params.parentTaskId ?? null,
    cronId: params.cronId ?? null,
    channelOriginId: params.channelOriginId ?? null,
    webhookId: params.webhookId ?? null,
    ticketId: params.ticketId ?? null,
    ticketAssignmentSnapshot,
    promptContextSnapshot,
    allowHumanPrompt: params.allowHumanPrompt ?? true,
    thinkingConfig: effectiveThinkingConfig ? JSON.stringify(effectiveThinkingConfig) : null,
    toolPreset: params.toolPreset ?? null,
    runPrompt: params.runPrompt ?? null,
    concurrencyGroup,
    concurrencyMax,
    queuedAt: initialStatus === 'queued' ? now : null,
    createdAt: now,
    updatedAt: now,
  })

  // Resolve executing Kin info for SSE metadata
  const executingKinId = params.sourceKinId ?? params.parentKinId
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  // Anchor the live task card to the assistant message that triggered the
  // spawn. When spawn_self / spawn_kin fire mid-turn, the parent Kin still has
  // an in-flight main-thread stream whose messageId IS the spawning assistant
  // message (the same id is reused as the persisted DB row at chat:done). The
  // client uses this to render the card directly under that message instead of
  // sorting it by createdAt (which lands before the message, since the row is
  // only persisted at end-of-turn). Null for tasks spawned outside a main-thread
  // turn (webhooks, crons, retries, sub-Kin spawns) — those fall back to the
  // createdAt-based placement.
  const triggerMessageId = getActiveKinStreamSnapshot(params.parentKinId)?.messageId ?? null

  // Emit SSE event with metadata for live task card
  sseManager.sendToKin(params.parentKinId, {
    type: 'task:status',
    kinId: params.parentKinId,
    data: {
      taskId,
      kinId: params.parentKinId,
      status: initialStatus,
      title: params.title ?? params.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
      concurrencyGroup,
      triggerMessageId,
    },
  })

  log.info({ taskId, parentKinId: params.parentKinId, mode: params.mode, spawnType: params.spawnType, depth, queued: initialStatus === 'queued' }, 'Task spawned')

  // If queued, don't execute yet — will be promoted when a slot opens
  if (initialStatus === 'queued') {
    return { taskId, queued: true }
  }

  // Notify source Kin about being spawned (only for spawn_type = 'other')
  if (params.spawnType === 'other' && params.sourceKinId) {
    const taskLabel = params.title ?? params.description
    // Truncate description to avoid leaking raw prompts into the conversation UI
    const briefDesc = params.description.length > 200
      ? params.description.slice(0, 200) + '...'
      : params.description
    notifySourceKin(
      params.sourceKinId,
      params.parentKinId,
      `[Task assigned: ${taskLabel}] ${briefDesc}`,
      taskId,
    ).catch((err) => log.warn({ taskId, sourceKinId: params.sourceKinId, err }, 'Failed to notify source Kin on spawn'))
  }

  // Execute the sub-Kin in the background (unless the caller wants to seed
  // state first — see `skipExecute`, used by `retryTask`).
  if (!params.skipExecute) {
    executeSubKin(taskId).catch((err) =>
      log.error({ taskId, err }, 'Sub-Kin execution error'),
    )
  }

  return { taskId, queued: false }
}

// ─── Sub-Kin Execution ───────────────────────────────────────────────────────

/**
 * Re-trigger sub-Kin execution after pause (e.g., human prompt response).
 * Reads accumulated message history from DB and starts a new LLM stream.
 */
export const resumeSubKin = executeSubKin

async function executeSubKin(taskId: string, isNudge = false) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return

  const parentKin = await db.select().from(kins).where(eq(kins.id, task.parentKinId)).get()
  if (!parentKin) return

  // Determine which Kin's identity to use. The DB row gives us the still-live
  // fields we need outside the prompt (id, avatarPath/updatedAt for SSE). The
  // prompt-affecting fields are overlaid from the frozen snapshot below so
  // mid-task edits to the Kin don't reach a running task.
  let kinIdentity = parentKin
  if (task.spawnType === 'other' && task.sourceKinId) {
    const sourceKin = await db.select().from(kins).where(eq(kins.id, task.sourceKinId)).get()
    if (sourceKin) kinIdentity = sourceKin
  }

  // Parse the spawn-time prompt-context snapshot. Legacy tasks (rows created
  // before this column existed) carry no snapshot and fall back to live DB
  // reads — those will keep behaving as before until they finish.
  let promptSnapshot: TaskPromptContextSnapshot | null = null
  if (task.promptContextSnapshot) {
    try {
      promptSnapshot = JSON.parse(task.promptContextSnapshot) as TaskPromptContextSnapshot
    } catch (err) {
      log.warn({ taskId, err }, 'Failed to parse prompt_context_snapshot — falling back to live reads')
    }
  }
  if (promptSnapshot) {
    // Overlay frozen identity fields onto the live row. Spread keeps the live
    // id, avatarPath, updatedAt (used for SSE) while the prompt-facing and
    // model-selection fields come from the snapshot.
    kinIdentity = { ...kinIdentity, ...promptSnapshot.kin }
  }

  // Update status to in_progress. `started_at` is set once via COALESCE so
  // re-entries (resume, request_input replies, inter-Kin replies, nudges)
  // never reset the original execution start used for the run duration.
  sqlite.run(
    `UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
    [Date.now(), Date.now(), taskId],
  )
  const startedRow = sqlite
    .query(`SELECT started_at AS startedAt FROM tasks WHERE id = ?`)
    .get(taskId) as { startedAt: number | null } | null

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'in_progress',
      title: task.title ?? task.description,
      startedAt: startedRow?.startedAt ?? null,
      senderName: kinIdentity.name,
      senderAvatarUrl: kinAvatarUrl(kinIdentity.id, kinIdentity.avatarPath, kinIdentity.updatedAt),
    },
  })

  try {
    // ─── Sub-task worktree setup ──────────────────────────────────────────
    // For ticket tasks against a project with a ready GitHub clone, give the
    // sub-Kin its own git worktree so concurrent sub-tasks can edit/commit/
    // push without trampling each other (see worktree.ts). `effective*` are
    // the values the rest of executeSubKin uses — they fall through to the
    // Kin's static workspace when there's no clone (legacy / non-code work).
    let workspaceOverride: { path: string; env?: Record<string, string> } | undefined
    let effectiveWorkspacePath: string | null = kinIdentity.workspacePath
    if (task.ticketId) {
      const ticketRow = await db
        .select()
        .from(tickets)
        .where(eq(tickets.id, task.ticketId))
        .get()
      if (ticketRow?.projectId) {
        const projectRow = await db
          .select()
          .from(projects)
          .where(eq(projects.id, ticketRow.projectId))
          .get()
        if (
          projectRow?.githubRepo
          && projectRow.cloneStatus === 'ready'
          && typeof ticketRow.number === 'number'
        ) {
          const { createWorktree } = await import('@/server/services/worktree')
          const wt = await createWorktree({
            projectId: projectRow.id,
            ticketNumber: ticketRow.number,
            taskId: task.id,
          })
          workspaceOverride = {
            path: wt.path,
            env: { KINBOT_GH_TOKEN: wt.pat },
          }
          effectiveWorkspacePath = wt.path
          log.info(
            { taskId, projectId: projectRow.id, wtPath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch },
            'Sub-task worktree ready',
          )
        }
      }
    }

    // Cron context — prefer the frozen snapshot, fall back to live for legacy
    // tasks. We revive ISO timestamp strings back into Date objects because
    // `buildSystemPrompt`/`buildTaskTodosBlock` expect real Date values.
    const previousCronRuns = task.cronId
      ? (promptSnapshot?.previousCronRuns
          ? promptSnapshot.previousCronRuns.map((r) => ({
              status: r.status,
              result: r.result,
              createdAt: new Date(r.createdAt),
              updatedAt: new Date(r.updatedAt),
            }))
          : await fetchPreviousCronRuns(task.cronId, 5))
      : undefined

    const cronLearnings = task.cronId
      ? (promptSnapshot?.cronLearnings
          ? promptSnapshot.cronLearnings.map((l) => ({
              id: l.id,
              content: l.content,
              category: l.category,
              createdAt: new Date(l.createdAt),
            }))
          : (await import('@/server/services/cron-learnings')).fetchCronLearnings(task.cronId))
      : undefined

    // Global prompt + Kin directory — frozen snapshot or live fallback.
    const globalPrompt = promptSnapshot?.globalPrompt !== undefined
      ? promptSnapshot.globalPrompt
      : await getGlobalPrompt()
    const kinDirectory = promptSnapshot?.kinDirectory
      ? promptSnapshot.kinDirectory
      : await (await import('@/server/services/inter-kin')).listAvailableKins(kinIdentity.id)

    // Ticket assignment context — read the snapshot frozen at spawn time so
    // the sub-Kin's stable system prefix doesn't change across re-entries
    // (which would bust the Anthropic prompt cache). Legacy ticket tasks
    // without a snapshot fall back to a live fetch.
    let ticketAssignment: import('@/server/services/prompt-builder').TicketAssignmentInfo | null = null
    if (task.ticketId) {
      if (task.ticketAssignmentSnapshot) {
        try {
          ticketAssignment = JSON.parse(task.ticketAssignmentSnapshot) as import('@/server/services/prompt-builder').TicketAssignmentInfo
        } catch (err) {
          log.warn({ taskId, err }, 'Failed to parse ticket_assignment_snapshot, falling back to live fetch')
        }
      }
      if (!ticketAssignment) {
        const { buildTicketAssignmentInfo } = await import('@/server/services/tickets')
        ticketAssignment = await buildTicketAssignmentInfo(task.ticketId, {
          runPrompt: task.runPrompt ?? null,
          currentTaskId: task.id,
        })
      }
    }

    const { getTodosForTask } = await import('@/server/services/task-todos')
    const systemSegments = buildSystemPrompt({
      kin: {
        name: kinIdentity.name,
        slug: kinIdentity.slug,
        role: kinIdentity.role,
        character: kinIdentity.character,
        expertise: kinIdentity.expertise,
      },
      contacts: [],
      relevantMemories: [],
      kinDirectory,
      isSubKin: true,
      taskDescription: task.description,
      previousCronRuns,
      cronLearnings,
      globalPrompt,
      userLanguage: 'en',
      workspacePath: effectiveWorkspacePath,
      ticketAssignment: ticketAssignment ?? undefined,
      systemContext: getSystemContext(),
      taskTodos: getTodosForTask(taskId),
    })

    // Resolve LLM — use task's provider if stored, else Kin's provider when using Kin's own model
    const modelId = task.model ?? kinIdentity.model
    const preferredProvider = task.providerId ?? (task.model ? null : kinIdentity.providerId)
    const { resolveLLM } = await import('@/server/llm/core/resolve')
    let taskResolved
    try {
      taskResolved = await resolveLLM({ modelId, providerId: preferredProvider })
    } catch (err) {
      throw new Error(`No LLM provider available for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Resolve thinking config: task-level override takes precedence over parent Kin.
    // Defaults to enabled (interleaved thinking reduces tool-result hallucinations).
    const taskThinkingConfig = resolveThinkingConfig(
      (task.thinkingConfig as string | null) ?? (kinIdentity.thinkingConfig as string | null),
    )
    const taskProviderType = taskResolved.providerRow.type

    // Resolve tools: spawned Kin's full toolset (minus excluded) + sub-Kin communication tools
    const kinToolConfig: KinToolConfig | null = kinIdentity.toolConfig
      ? JSON.parse(kinIdentity.toolConfig)
      : null

    // Native tools resolved as the spawned Kin (same as a main Kin).
    // `workspaceOverride` (set above for ticket-on-a-cloned-project tasks)
    // scopes every filesystem + shell tool to the per-task worktree and
    // injects KINBOT_GH_TOKEN into spawned subprocesses for git auth.
    const nativeTools = toolRegistry.resolve({
      kinId: kinIdentity.id,
      taskId,
      taskDepth: task.depth,
      isSubKin: false,
      channelOriginId: task.channelOriginId ?? undefined,
      cronId: task.cronId ?? undefined,
      ticketId: task.ticketId ?? undefined,
      toolConfig: kinToolConfig,
      workspaceOverride,
    })

    // Filter disabled native tools per Kin config (deny-list)
    if (kinToolConfig?.disabledNativeTools?.length) {
      for (const name of kinToolConfig.disabledNativeTools) {
        delete nativeTools[name]
      }
    }

    // Filter out defaultDisabled tools not explicitly opted-in
    const allRegistered = toolRegistry.list()
    const optInSet = new Set(kinToolConfig?.enabledOptInTools ?? [])
    for (const reg of allRegistered) {
      if (reg.defaultDisabled && !optInSet.has(reg.name)) {
        delete nativeTools[reg.name]
      }
    }

    // Remove tools not appropriate for sub-Kins
    const SUB_KIN_EXCLUDED_TOOLS = [
      'spawn_self', 'spawn_kin',
      'respond_to_task', 'cancel_task', 'list_tasks',
      'reply',
      'create_cron', 'update_cron', 'delete_cron', 'list_crons',
      'add_mcp_server', 'update_mcp_server', 'remove_mcp_server', 'list_mcp_servers',
      'register_tool', 'list_custom_tools',
      'create_kin', 'update_kin', 'delete_kin', 'get_kin_details',
    ]
    for (const name of SUB_KIN_EXCLUDED_TOOLS) {
      delete nativeTools[name]
    }

    // Sub-Kin-specific tools (scoped to parent for communication back).
    // Same workspace override applies — these tools are mostly comms-only
    // but `record_findings` and friends still write into the worktree.
    const subKinTools = toolRegistry.resolve({
      kinId: task.parentKinId,
      taskId,
      taskDepth: task.depth,
      isSubKin: true,
      channelOriginId: task.channelOriginId ?? undefined,
      cronId: task.cronId ?? undefined,
      toolConfig: kinToolConfig,
      workspaceOverride,
    })

    // On ticket sub-Kins the parent Kin has nothing actionable to do with
    // intermediate progress reports — the user reads the ticket UI instead.
    // Remove `report_to_parent` so the sub-Kin doesn't waste calls on it.
    if (task.ticketId) {
      delete subKinTools['report_to_parent']
    }

    // MCP + custom tools for the spawned Kin
    const mcpTools = await resolveMCPTools(kinIdentity.id, kinToolConfig)
    const customToolDefs = await resolveCustomTools(kinIdentity.id)

    // Right-size the native-tool surface via a preset (mandatory core +
    // task-flavored extras). Explicit `toolPreset` on the task row wins;
    // otherwise the auto-picker (ticket → 'code', else full surface) takes
    // over. MCP and per-Kin custom tools are intentionally excluded from
    // the preset filter — those have already been curated at the Kin level.
    const { applyPreset, defaultPresetForTask } = await import('@/server/services/tool-presets')
    const explicitPreset = task.toolPreset as 'code' | 'research' | 'ops' | 'all' | null
    const preset = explicitPreset ?? defaultPresetForTask({
      ticketId: task.ticketId ?? null,
      cronId: task.cronId ?? null,
    })
    const filteredNative = applyPreset(nativeTools, preset)
    const filteredSubKin = applyPreset(subKinTools, preset)

    const tools = wrapToolsWithSpill(
      { ...filteredNative, ...filteredSubKin, ...mcpTools, ...customToolDefs },
      effectiveWorkspacePath,
    )

    if (preset) {
      log.info(
        {
          taskId,
          preset,
          nativeCount: Object.keys(filteredNative).length,
          subKinCount: Object.keys(filteredSubKin).length,
          mcpCount: Object.keys(mcpTools).length,
          customCount: Object.keys(customToolDefs).length,
        },
        'Sub-Kin tool preset applied',
      )
    }

    // Build task message history (only messages for this task)
    const taskMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.kinId, task.parentKinId), eq(messages.taskId, taskId)))
      .orderBy(asc(messages.createdAt))
      .all()

    // Reconstruct KinbotMessage[] from persisted rows. Mirrors the
    // quick-session path in kin-engine.ts (~L2150): assistant rows with
    // persisted tool calls are expanded into an assistant message carrying
    // tool-use blocks plus a paired user-role message with the tool-result
    // blocks, so the LLM sees the same shape on resume that it saw
    // mid-turn. We also skip empty-content rows so they don't reach
    // `buildSegmentedMessages` and get picked as a cache anchor (Anthropic
    // rejects `cache_control` on empty text blocks). Observed when a
    // sub-Kin called `request_input` (only a tool call, no text) and the
    // response message arrived: the in-between assistant row had empty
    // content and was picked as the cross-turn cache anchor.
    const messageHistory: KinbotMessage[] = []
    for (const msg of taskMessages) {
      if (msg.role === 'user') {
        const text = msg.content ?? ''
        if (!text.trim()) continue
        messageHistory.push({ role: 'user', content: [{ type: 'text', text }] })
      } else if (msg.role === 'assistant') {
        let parsedToolCalls: Array<{ id: string; name: string; args: unknown; result?: unknown }> | null = null
        if (msg.toolCalls) {
          try { parsedToolCalls = JSON.parse(msg.toolCalls as string) } catch { parsedToolCalls = null }
        }
        const validToolCalls = parsedToolCalls ? sanitizePersistedToolCalls(parsedToolCalls, task.parentKinId) : []
        if (validToolCalls.length > 0) {
          const assistantBlocks: KinbotMessageBlock[] = []
          if (msg.content) assistantBlocks.push({ type: 'text', text: msg.content })
          for (const tc of validToolCalls) {
            assistantBlocks.push({ type: 'tool-use', id: tc.id, name: tc.name, args: tc.args })
          }
          messageHistory.push({ role: 'assistant', content: assistantBlocks })
          messageHistory.push({
            role: 'user',
            content: validToolCalls.map((tc) => ({
              type: 'tool-result',
              toolUseId: tc.id,
              content: stringifyToolResultValue(tc.result),
            })),
          })
        } else {
          const text = msg.content ?? ''
          if (text.trim()) {
            messageHistory.push({ role: 'assistant', content: [{ type: 'text', text }] })
          }
        }
      }
    }

    // Add initial task instruction as user message if no history yet
    if (messageHistory.length === 0) {
      messageHistory.push({
        role: 'user',
        content: [{ type: 'text', text: task.description }],
      })

      // Save to DB
      const initialMsgId = uuid()
      const initialMsgCreatedAt = new Date()
      await db.insert(messages).values({
        id: initialMsgId,
        kinId: task.parentKinId,
        taskId,
        role: 'user',
        content: task.description,
        sourceType: 'system',
        createdAt: initialMsgCreatedAt,
      })

      // Notify the frontend so the task detail modal can show this message
      // immediately instead of waiting for the next fetchDetail() call.
      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:message',
        kinId: task.parentKinId,
        data: {
          id: initialMsgId,
          taskId,
          role: 'user',
          content: task.description,
          sourceType: 'system',
          createdAt: initialMsgCreatedAt.getTime(),
        },
      })
    }

    const hasTools = Object.keys(tools).length > 0

    // Execute LLM with streaming (same pattern as kin-engine)
    const assistantMessageId = uuid()
    let fullContent = ''
    const reasoningSegments: Array<{ offset: number; text: string }> = []
    const toolCallsLog: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }> = []
    let streamError: Error | null = null

    // In-memory snapshot for clients that connect mid-stream — see activeTaskStreams above.
    // Arrays are shared by reference so server-side mutations are visible immediately.
    const streamSnapshot: ActiveTaskStreamSnapshot = {
      messageId: assistantMessageId,
      content: '',
      toolCalls: toolCallsLog,
      reasoning: reasoningSegments,
    }
    activeTaskStreams.set(taskId, streamSnapshot)

    // Pre-insert assistant message so it's visible in fetchDetail() during streaming.
    // Content and tool calls will be updated when the stream completes.
    const assistantMsgCreatedAt = new Date()
    await db.insert(messages).values({
      id: assistantMessageId,
      kinId: task.parentKinId,
      taskId,
      role: 'assistant',
      content: '',
      sourceType: 'kin',
      sourceId: kinIdentity.id,
      createdAt: assistantMsgCreatedAt,
    })

    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:message',
      kinId: task.parentKinId,
      data: {
        id: assistantMessageId,
        taskId,
        role: 'assistant',
        content: '',
        sourceType: 'kin',
        sourceId: kinIdentity.id,
        createdAt: assistantMsgCreatedAt.getTime(),
      },
    })

    // Create an AbortController so the stream can be cancelled from outside
    const abortController = new AbortController()
    activeTaskAbortControllers.set(taskId, abortController)

    // Convert tools to kinbot shape once.
    const { vercelToolsToKinbot: taskVercelToolsToKinbot, markLastKinbotToolCacheable: taskMarkLastKinbotToolCacheable } =
      await import('@/server/llm/core/vercel-bridge')
    const taskKinbotTools = hasTools
      ? taskMarkLastKinbotToolCacheable(await taskVercelToolsToKinbot(stripToolExecute(tools)))
      : undefined

    const maxSteps = hasTools ? (config.tools.maxSteps > 0 ? config.tools.maxSteps : Infinity) : 1
    const stepUsages: Array<{
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
      reasoningTokens?: number
    }> = []
    let silentStopAfterTools = false
    // See processNextMessage in kin-engine.ts for rationale.
    const stepFinishReasons: string[] = []

    const taskThinkingEffort = taskThinkingConfig?.enabled ? taskThinkingConfig.effort ?? undefined : undefined

    let step = 0
    for (; step < maxSteps; step++) {
      if (abortController.signal.aborted) break

      const { system: taskSystem, messages: taskMessages } =
        buildSegmentedMessages(systemSegments, messageHistory)
      const stream = taskResolved.provider.chat(
        taskResolved.model,
        {
          messages: taskMessages,
          ...(taskSystem ? { system: taskSystem } : {}),
          ...(taskKinbotTools ? { tools: taskKinbotTools } : {}),
          ...(taskThinkingEffort ? { thinkingEffort: taskThinkingEffort } : {}),
          signal: abortController.signal,
        },
        taskResolved.config,
      )

      // Buffer text per step until finishReason is known — see stream-runner.ts.
      // The 500ms DB checkpoint that used to live inline in `text-delta` is
      // now driven by `ctx.checkpoint` and persists only *committed* content
      // (the in-flight buffer is never written to DB).
      const outcome = await runStreamStep(stream, {
        kinId: task.parentKinId,
        assistantMessageId,
        abortController,
        extraSseFields: { taskId },
        reasoningSegments,
        contentSnapshot: streamSnapshot,
        onCommittedText: (delta) => { fullContent += delta },
        onDroppedText: (txt, idx) => log.debug(
          { taskId, kinId: task.parentKinId, assistantMessageId, step: idx, droppedChars: txt.length, preview: txt.slice(0, 200) },
          'Dropped pre-narration from intermediate step (sub-Kin)',
        ),
        checkpoint: {
          intervalMs: 500,
          persist: () => {
            db.update(messages)
              .set({
                content: fullContent,
                toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
              })
              .where(eq(messages.id, assistantMessageId))
              .then(() => {}, () => {})
          },
        },
      }, step)
      if (outcome.usage) stepUsages.push(outcome.usage)

      if (outcome.error) {
        streamError = outcome.error
      } else if (outcome.wasAborted) {
        log.info({ taskId }, 'Sub-Kin stream aborted by cancellation')
      }
      if (outcome.finishReason !== undefined) stepFinishReasons.push(outcome.finishReason)
      const stepText = outcome.stepText
      const stepToolCalls = outcome.stepToolCalls

      // No tool calls this step or error/abort → exit loop.
      // Silent-stop detection: provider closed the stream with no text and no
      // tool calls at this step, AFTER at least one prior tool batch executed
      // and the overall turn produced no text either. Surface a fallback below
      // so the task doesn't end with an empty assistant row.
      if (stepToolCalls.length === 0 || streamError || abortController.signal.aborted) {
        if (
          !streamError &&
          !abortController.signal.aborted &&
          toolCallsLog.length > 0 &&
          fullContent.length === 0
        ) {
          silentStopAfterTools = true
        }
        break
      }

      // Build assistant content for history
      const assistantBlocks: KinbotMessageBlock[] = []
      if (stepText) assistantBlocks.push({ type: 'text', text: stepText })
      for (const tc of stepToolCalls) {
        assistantBlocks.push({ type: 'tool-use', id: tc.id, name: tc.name, args: tc.args })
      }

      // Execute tool calls (concurrently if all read-only, sequentially otherwise)
      const batch = await executeToolBatch({
        stepToolCalls,
        tools,
        abortController,
        kinId: task.parentKinId,
        assistantMessageId,
        sseExtra: { taskId },
      })
      toolCallsLog.push(...batch.toolCallsLog)

      // Checkpoint: persist partial content + tool calls so a page refresh
      // can show progress instead of an empty message.
      if (batch.toolCallsLog.length > 0) {
        await db.update(messages)
          .set({
            content: fullContent,
            toolCalls: JSON.stringify(toolCallsLog),
          })
          .where(eq(messages.id, assistantMessageId))
      }

      if (batch.wasAborted) break

      // Suspension check: a tool in this batch may have transitioned the
      // task into an awaiting state (request_input → awaiting_human_input,
      // send_message request → awaiting_kin_response). Stop the multi-step
      // loop NOW so the LLM doesn't run another step on a task that's
      // logically paused. The sub-Kin resumes via resumeSubKin() once the
      // response arrives (respondToHumanPrompt / respondToInterKinRequest).
      // Without this, the LLM happily emits more tool calls — observed on
      // prod task `4e4f1760` (ticket #22) where the agent kept going for 40+
      // calls after request_input, including a `git commit --no-verify` that
      // only stopped because the hook-bypass guard refused it.
      const suspendedCheck = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      if (suspendedCheck?.status === 'awaiting_human_input' || suspendedCheck?.status === 'awaiting_kin_response') {
        log.info(
          { taskId, status: suspendedCheck.status },
          'Sub-Kin step suspended task — breaking multi-step loop',
        )
        break
      }

      // Nudge: if this is a cron task and a tool returned an error, hint about save_run_learning
      if (task.cronId) {
        for (const tr of batch.toolResults) {
          const val = tr.output.value as Record<string, unknown> | null
          if (val && typeof val === 'object' && 'error' in val) {
            (val as Record<string, unknown>)._hint = 'If this error reveals something useful for future runs, use save_run_learning() to record it.'
          }
        }
      }

      // Append assistant message (with tool calls) + tool results to history
      // for next step. Tool results live as a user-role message in kinbot's
      // shape (Anthropic-style).
      messageHistory.push({ role: 'assistant', content: assistantBlocks })
      messageHistory.push({
        role: 'user',
        content: batch.toolResults.map((tr) => ({
          type: 'tool-result',
          toolUseId: tr.toolCallId,
          content: stringifyToolResultValue(tr.output.value),
        })),
      })

      // Text accumulates across steps so tool call offsets remain valid
    }

    activeTaskAbortControllers.delete(taskId)
    activeTaskStreams.delete(taskId)

    log.info({
      taskId,
      messageId: assistantMessageId,
      stepCount: step + 1,
      finishReasons: stepFinishReasons,
      contentLength: fullContent.length,
      toolCalls: toolCallsLog.length,
      wasAborted: abortController.signal.aborted,
      streamError: streamError ? streamError.message : null,
      silentStopAfterTools,
    }, 'Sub-Kin LLM turn completed')

    // Aggregate token usage (synchronous: already collected from each step).
    const tokenUsage = aggregateUsages(stepUsages)

    // Fire-and-forget: record to llm_usage table for analytics
    if (tokenUsage) {
      recordUsage({
        callSite: 'task',
        callType: 'stream-text',
        providerType: taskResolved.providerRow.type,
        providerId: taskResolved.providerRow.id,
        modelId: taskResolved.model.id,
        kinId: task.parentKinId,
        taskId,
        cronId: task.cronId ?? null,
        usage: {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
          inputTokenDetails: { cacheReadTokens: tokenUsage.cacheReadTokens ?? 0, cacheWriteTokens: tokenUsage.cacheWriteTokens ?? 0 },
          outputTokenDetails: { reasoningTokens: tokenUsage.reasoningTokens ?? 0 },
        },
        stepCount: stepUsages.length,
      })

      // Persist the provider-reported peak input as the task's "real" context
      // size. Surfaces as the green "✓ real" bar on the task panel (vs the
      // local BPE estimate from buildTaskContextPreview).
      if (tokenUsage.peakStepInputTokens && tokenUsage.peakStepInputTokens > 0) {
        await db.update(tasks)
          .set({ lastApiContextTokens: tokenUsage.peakStepInputTokens, updatedAt: new Date() })
          .where(eq(tasks.id, taskId))
      }

      // Push the fresh task-level total over SSE so the panel can update its
      // running counter without polling. Read AFTER recordUsage so the new row
      // is included in the roll-up.
      const totals = getTaskTotals(taskId)
      if (totals) {
        sseManager.sendToKin(task.parentKinId, {
          type: 'task:token-usage',
          kinId: task.parentKinId,
          data: { taskId, tokenUsage: totals },
        })
      }
    }

    // If the stream was aborted (cancel/pause), persist partial content and stop
    if (abortController.signal.aborted) {
      if (fullContent || toolCallsLog.length > 0) {
        // Save the partial response so it's visible in the task history
        await db.update(messages)
          .set({
            content: fullContent || '',
            toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
          })
          .where(eq(messages.id, assistantMessageId))
      } else {
        // No content was generated — delete the pre-inserted empty assistant message
        // to avoid polluting the message history on resume
        await db.delete(messages).where(eq(messages.id, assistantMessageId))
      }

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:done',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, content: fullContent, taskId },
      })
      return
    }

    // If the stream errored, fail the task immediately
    if (streamError) {
      log.error({ taskId, error: streamError.message }, 'Sub-Kin stream error')

      // Update pre-inserted assistant message with partial content from the error
      await db.update(messages)
        .set({
          content: fullContent || '',
          toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        })
        .where(eq(messages.id, assistantMessageId))

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:done',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, content: fullContent, taskId },
      })

      const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (currentTask && currentTask.status === 'in_progress') {
        await resolveTask(taskId, 'failed', undefined, streamError.message)
      }
      return
    }

    // Surface silent-stop: provider closed the stream with no text after
    // tool execution. Produce a fallback so the task row is not persisted
    // as empty (Anthropic also rejects empty text content blocks on the
    // next turn, which would block the conversation entirely).
    if (silentStopAfterTools) {
      log.warn(
        { taskId, messageId: assistantMessageId, toolCalls: toolCallsLog.length, step },
        'Sub-Kin: LLM closed stream with no text after tool execution (silent stop)',
      )
      fullContent = `*(This task executed ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} but the model did not produce a final response. This can happen on very large contexts. Retry with a tighter scope or ask the Kin to continue.)*`
      streamSnapshot.content = fullContent
      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:token',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, token: fullContent, taskId, contentLength: fullContent.length },
      })
    }

    // Detect silent provider failures: stream completed but produced no output at all
    if (!fullContent && toolCallsLog.length === 0) {
      log.warn({ taskId }, 'Sub-Kin stream produced no output — treating as failure')

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:done',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, content: '', taskId },
      })

      const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (currentTask && currentTask.status === 'in_progress') {
        await resolveTask(taskId, 'failed', undefined, 'LLM returned empty response')
      }
      return
    }

    const responseText = fullContent

    // Update the pre-inserted assistant message with final content, tool calls, and token usage
    await db.update(messages)
      .set({
        content: responseText,
        toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        reasoning: reasoningSegments.length > 0 ? JSON.stringify(reasoningSegments) : null,
        ...(tokenUsage ? { metadata: JSON.stringify({ tokenUsage }) } : {}),
      })
      .where(eq(messages.id, assistantMessageId))

    // Emit chat:done so the frontend knows streaming is over
    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:done',
      kinId: task.parentKinId,
      data: { messageId: assistantMessageId, content: responseText, taskId, ...(tokenUsage ? { tokenUsage } : {}) },
    })

    // If the task was suspended for an inter-Kin response or a human prompt,
    // don't nudge — just return. The runner resumes via resumeSubKin() when
    // the response arrives (respondToHumanPrompt / interKin reply handler).
    const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (currentTask && (currentTask.status === 'awaiting_kin_response' || currentTask.status === 'awaiting_human_input')) {
      log.info({ taskId, status: currentTask.status }, 'Sub-Kin suspended — exiting without nudge')
      return
    }

    // If the Kin didn't explicitly resolve the task via update_task_status(),
    // give it one more chance (nudge turn) before marking as failed.
    if (currentTask && currentTask.status === 'in_progress') {
      if (!isNudge) {
        // First attempt — inject a reminder and re-run one more LLM turn
        log.info({ taskId }, 'Sub-Kin finished without calling update_task_status — sending nudge turn')

        await db.insert(messages).values({
          id: uuid(),
          kinId: task.parentKinId,
          taskId,
          role: 'user',
          content:
            '[System] You have not called update_task_status() yet. ' +
            'You MUST finalize this task now:\n' +
            '- Call update_task_status("completed", "<summary of what you accomplished>") if the task is done.\n' +
            '- Call update_task_status("failed", undefined, "<reason>") if you could not complete it.\n' +
            'Do this immediately.',
          sourceType: 'system',
          createdAt: new Date(),
        })

        await executeSubKin(taskId, true)
      } else {
        // Already nudged once — now fail for real
        log.warn({ taskId }, 'Sub-Kin still did not call update_task_status after nudge — marking as failed')
        await resolveTask(taskId, 'failed', undefined, 'Task did not explicitly report completion')
      }
    }
  } catch (err) {
    activeTaskStreams.delete(taskId)
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    log.error({ taskId, error: errorMsg }, 'Sub-Kin execution failed')
    // Sub-Kins / tasks have their own ephemeral message stream and don't
    // share the parent's compacting summaries — there's no automatic
    // recovery path here, so override the generic "compaction triggered"
    // friendly message (which would lie) with task-specific guidance.
    const displayError = isContextTooLargeError(errorMsg)
      ? `This task got too long for the model's context window. Retry with a tighter scope or split into smaller sub-tasks.`
      : errorMsg
    await resolveTask(taskId, 'failed', undefined, displayError)
  }
}

// ─── Task Resolution ─────────────────────────────────────────────────────────

/** Build the inline reminder appended to ticket-linked task_result messages.
 *  Returns null if the linked ticket has been deleted (graceful fallback). */
async function buildTicketLinkedReminder(ticketId: string): Promise<string | null> {
  const ticketRow = await db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticketRow) return null
  const projectRow = await db.select().from(projects).where(eq(projects.id, ticketRow.projectId)).get()
  if (!projectRow) return null

  const idShort = ticketRow.id.slice(0, 8)
  return `\n\n---\nLinked ticket: #${idShort} "${ticketRow.title}" (project: ${projectRow.title}, current status: ${ticketRow.status}). Review the result above and update the ticket via update_ticket() if needed — status, description, tags. The kanban does not move automatically.`
}

export async function resolveTask(
  taskId: string,
  status: 'completed' | 'failed',
  result?: string,
  error?: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return

  // The Kin that actually executed the task (target Kin for 'other', parent for 'self')
  const executingKinId = task.sourceKinId ?? task.parentKinId

  log.info({ taskId, status, mode: task.mode }, 'Task resolved')

  // Snapshot guard-fire telemetry before we drop tracker state. Surfaces
  // whether the runtime guards (bash-wrapper refusal, banned commands,
  // read-before-edit, duplicate reads, think / task_todos usage) fired on
  // this task. Useful for validating whether agent behaviour shifted vs
  // the baseline (task #32) — grep `Task guard telemetry` in the logs.
  const { forgetTask, getTaskStats } = await import('@/server/services/tool-call-tracker')
  const guardStats = getTaskStats(taskId)
  if (guardStats) {
    log.info({ taskId, status, ...guardStats }, 'Task guard telemetry')
  }
  forgetTask(taskId)

  // Drop per-task structured todo list (TodoWrite-equivalent).
  const { forgetTaskTodos } = await import('@/server/services/task-todos')
  forgetTaskTodos(taskId)

  // Close any browser sessions opened by this task (best-effort, non-blocking)
  import('@/server/services/playwright-manager')
    .then(({ playwrightManager }) => playwrightManager.closeSessionsForTask(taskId))
    .catch((err) => log.warn({ taskId, err }, 'Failed to close browser sessions for task'))

  const endedAt = new Date()
  await db
    .update(tasks)
    .set({
      status,
      result: result ?? null,
      error: error ?? null,
      endedAt,
      updatedAt: endedAt,
    })
    .where(eq(tasks.id, taskId))

  // Resolve executing Kin info for SSE metadata
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  // Auto-comment on the linked ticket (if any) so the ticket UI shows the
  // final report or failure reason without the sub-Kin having to post it
  // manually. We do this best-effort so a comment service hiccup never blocks
  // task resolution.
  if (task.ticketId) {
    try {
      // Finalize the per-task git worktree (push branch, optional rebase,
      // cleanup) for ticket sub-tasks that ran against a cloned project.
      // The outcome enriches the auto-comment with the branch URL + any
      // "needs manual merge" / "worktree kept for debug" notes.
      const { finalizeTicketSubTaskWorktree, maybeRemoveFinalizedWorktree } = await import(
        '@/server/services/worktree-finalize'
      )
      let suffix = ''
      try {
        const outcome = await finalizeTicketSubTaskWorktree({
          taskId,
          ticketId: task.ticketId,
          status,
        })
        suffix = outcome.contentSuffix
        // Fire-and-forget removal — a slow `git worktree remove` shouldn't
        // hold up the comment / SSE flow.
        void maybeRemoveFinalizedWorktree(taskId, task.ticketId, outcome).catch((err) => {
          log.warn({ taskId, err }, 'Worktree removal after finalize failed')
        })
      } catch (err) {
        log.warn({ taskId, err }, 'Worktree finalize threw — comment posted without git suffix')
      }

      const { createTicketComment } = await import('@/server/services/ticket-comments')
      const base = status === 'completed'
        ? (result ?? '_Task completed without a result message._')
        : `**Task failed.**\n\n${error ?? 'Unknown error'}`
      await createTicketComment({
        ticketId: task.ticketId,
        author: { type: 'kin', id: executingKinId },
        content: `${base}${suffix}`,
        metadata: { fromTaskId: taskId, autoGenerated: true },
      })
    } catch (err) {
      log.warn({ taskId, ticketId: task.ticketId, err }, 'Failed to auto-comment on ticket')
    }
  }

  // Emit SSE
  sseManager.sendToKin(task.parentKinId, {
    type: 'task:done',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status,
      result: result ?? null,
      error: error ?? null,
      title: task.title ?? task.description,
      startedAt: task.startedAt ? task.startedAt.getTime() : null,
      endedAt: endedAt.getTime(),
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
    },
  })

  // Use title for UI display, fall back to description
  const taskLabel = task.title ?? task.description

  // Notify source Kin about task completion/failure (only for spawn_type = 'other')
  if (task.spawnType === 'other' && task.sourceKinId) {
    const sourceMsg = status === 'completed'
      ? `[Task completed: ${taskLabel}] ${result ?? ''}`
      : `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`
    notifySourceKin(task.sourceKinId, task.parentKinId, sourceMsg, taskId)
      .catch((err) => log.warn({ taskId, sourceKinId: task.sourceKinId, err }, 'Failed to notify source Kin on resolve'))
  }

  const taskMetadata = JSON.stringify({ resolvedTaskId: taskId })

  // Build optional ticket-linked reminder appended after the result.
  // The reminder nudges the Kin to update the ticket status via update_ticket()
  // since ticket statuses are not auto-managed on task lifecycle (projects.md § 5).
  const ticketReminder = task.ticketId ? (await buildTicketLinkedReminder(task.ticketId)) ?? '' : ''

  // If await mode, deposit result (or failure) in parent's queue
  if (task.mode === 'await' && status === 'completed' && result) {
    await enqueueMessage({
      kinId: task.parentKinId,
      messageType: 'task_result',
      content: `[Task: ${taskLabel}] Result: ${result}${ticketReminder}`,
      sourceType: 'task',
      sourceId: executingKinId,
      priority: config.queue.taskPriority,
      taskId, // Used by kin-engine to set metadata.resolvedTaskId on the message
      channelOriginId: task.channelOriginId ?? undefined,
    })
  } else if (task.mode === 'await' && status === 'failed') {
    await enqueueMessage({
      kinId: task.parentKinId,
      messageType: 'task_result',
      content: `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}${ticketReminder}`,
      sourceType: 'task',
      sourceId: executingKinId,
      priority: config.queue.taskPriority,
      taskId,
      channelOriginId: task.channelOriginId ?? undefined,
    })
  } else if (task.mode === 'async' && status === 'completed' && result) {
    // Async mode: deposit as informational message (no queue entry)
    const msgId = uuid()
    await db.insert(messages).values({
      id: msgId,
      kinId: task.parentKinId,
      role: 'user',
      content: `[Task completed: ${taskLabel}] ${result}`,
      sourceType: 'task',
      sourceId: executingKinId,
      metadata: taskMetadata,
      createdAt: new Date(),
    })

    // Notify via SSE
    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:message',
      kinId: task.parentKinId,
      data: {
        id: msgId,
        role: 'user',
        content: `[Task completed: ${taskLabel}] ${result}`,
        sourceType: 'task',
        sourceId: executingKinId,
        resolvedTaskId: taskId,
        createdAt: Date.now(),
      },
    })
  } else if (task.mode === 'async' && status === 'failed') {
    const failureContent = `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`

    if (task.cronId) {
      // Cron-triggered failures are actionable — enqueue so the owner Kin reacts
      await enqueueMessage({
        kinId: task.parentKinId,
        messageType: 'task_result',
        content: failureContent,
        sourceType: 'task',
        sourceId: executingKinId,
        priority: config.queue.taskPriority,
        taskId,
        channelOriginId: task.channelOriginId ?? undefined,
      })
    } else {
      // Non-cron async failure: deposit as informational message (no turn)
      const msgId = uuid()
      await db.insert(messages).values({
        id: msgId,
        kinId: task.parentKinId,
        role: 'user',
        content: failureContent,
        sourceType: 'task',
        sourceId: executingKinId,
        metadata: taskMetadata,
        createdAt: new Date(),
      })

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:message',
        kinId: task.parentKinId,
        data: {
          id: msgId,
          role: 'user',
          content: failureContent,
          sourceType: 'task',
          sourceId: executingKinId,
          resolvedTaskId: taskId,
          createdAt: Date.now(),
        },
      })
    }
  }

  // Promote next queued task in the same concurrency group
  if (task.concurrencyGroup && task.concurrencyMax) {
    promoteNextQueuedTask(task.concurrencyGroup, task.concurrencyMax).catch((err) =>
      log.error({ taskId, group: task.concurrencyGroup, err }, 'Failed to promote next queued task'),
    )
  }
}

// ─── Task Operations ─────────────────────────────────────────────────────────

export async function cancelTask(taskId: string, kinId: string) {
  const task = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.parentKinId, kinId)))
    .get()

  if (!task) return false
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
    return false
  }

  // Abort the running LLM stream if any
  const controller = activeTaskAbortControllers.get(taskId)
  if (controller) {
    controller.abort()
    activeTaskAbortControllers.delete(taskId)
  }

  // Cancel any pending human prompts for this task
  const { cancelPendingPromptsForTask } = await import('@/server/services/human-prompts')
  await cancelPendingPromptsForTask(taskId)

  // Drop per-task tool-call tracker state.
  const { forgetTask: forgetTaskCancel } = await import('@/server/services/tool-call-tracker')
  forgetTaskCancel(taskId)

  // Drop per-task todo list.
  const { forgetTaskTodos: forgetTodosCancel } = await import('@/server/services/task-todos')
  forgetTodosCancel(taskId)

  // Clear any pending inter-Kin timeout timer
  const interKinTimer = interKinTimeouts.get(taskId)
  if (interKinTimer) {
    clearTimeout(interKinTimer)
    interKinTimeouts.delete(taskId)
  }

  const cancelledAt = new Date()
  await db
    .update(tasks)
    .set({ status: 'cancelled', pendingRequestId: null, endedAt: cancelledAt, updatedAt: cancelledAt })
    .where(eq(tasks.id, taskId))

  sseManager.sendToKin(kinId, {
    type: 'task:status',
    kinId,
    data: {
      taskId,
      kinId,
      status: 'cancelled',
      title: task.title ?? task.description,
      startedAt: task.startedAt ? task.startedAt.getTime() : null,
      endedAt: cancelledAt.getTime(),
    },
  })

  // Notify source Kin about cancellation (only for spawn_type = 'other')
  if (task.spawnType === 'other' && task.sourceKinId) {
    const taskLabel = task.title ?? task.description
    notifySourceKin(
      task.sourceKinId,
      kinId,
      `[Task cancelled: ${taskLabel}]`,
      task.id,
    ).catch((err) => log.warn({ taskId: task.id, sourceKinId: task.sourceKinId, err }, 'Failed to notify source Kin on cancel'))
  }

  // Promote next queued task in the same concurrency group
  if (task.concurrencyGroup && task.concurrencyMax) {
    promoteNextQueuedTask(task.concurrencyGroup, task.concurrencyMax).catch((err) =>
      log.error({ taskId, group: task.concurrencyGroup, err }, 'Failed to promote next queued task after cancel'),
    )
  }

  return true
}

export async function getTask(taskId: string) {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).get()
}

export class TaskNotRetryableError extends Error {
  constructor(public readonly status: string) {
    super(`Task status "${status}" is not retryable (must be failed or cancelled)`)
    this.name = 'TaskNotRetryableError'
  }
}

/**
 * Spawn a new task derived from a previously failed or cancelled one.
 *
 * Two modes:
 *   - `preserveHistory: false` — clean retry. The new task starts from the
 *     same description with no message history; the runner inserts the
 *     initial user message as usual.
 *   - `preserveHistory: true` — fork. All messages from the original task
 *     are cloned onto the new task (new message ids, same content). The
 *     model picks up whatever context was preserved in DB (note: tool
 *     results are NOT reconstructed into ModelMessage blocks by the current
 *     sub-Kin runner — only text content survives across reload).
 *
 * The original failed task is left intact for audit. The new task carries
 * the same parent/source/ticket/cron/webhook/concurrency wiring as the
 * original. The "retry of" relationship is not persisted yet — callers
 * should hold the original id client-side if they want to surface it.
 */
export async function retryTask(
  failedTaskId: string,
  opts: { preserveHistory: boolean },
): Promise<{ taskId: string; queued: boolean }> {
  const original = await db.select().from(tasks).where(eq(tasks.id, failedTaskId)).get()
  if (!original) throw new TaskNotFoundError(failedTaskId)
  if (original.status !== 'failed' && original.status !== 'cancelled') {
    throw new TaskNotRetryableError(original.status)
  }

  let thinkingConfig: KinThinkingConfig | undefined
  if (original.thinkingConfig) {
    try {
      thinkingConfig = JSON.parse(original.thinkingConfig) as KinThinkingConfig
    } catch {
      thinkingConfig = undefined
    }
  }

  const spawned = await spawnTask({
    parentKinId: original.parentKinId,
    sourceKinId: original.sourceKinId ?? undefined,
    spawnType: original.spawnType as 'self' | 'other',
    mode: original.mode as 'await' | 'async',
    title: original.title ?? undefined,
    description: original.description,
    depth: original.depth,
    parentTaskId: original.parentTaskId ?? undefined,
    cronId: original.cronId ?? undefined,
    channelOriginId: original.channelOriginId ?? undefined,
    webhookId: original.webhookId ?? undefined,
    ticketId: original.ticketId ?? undefined,
    kind: (original.kind ?? 'execute') as 'execute' | 'enrich',
    model: original.model ?? undefined,
    providerId: original.providerId ?? undefined,
    allowHumanPrompt: original.allowHumanPrompt,
    thinkingConfig,
    concurrencyGroup: original.concurrencyGroup ?? undefined,
    concurrencyMax: original.concurrencyMax ?? undefined,
    toolPreset: (original.toolPreset ?? undefined) as 'code' | 'research' | 'ops' | 'all' | undefined,
    // Hold off on the runner so we can seed cloned messages (if asked)
    // before the first stream reads from the DB.
    skipExecute: true,
  })

  if (opts.preserveHistory) {
    const originalMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.taskId, failedTaskId))
      .orderBy(asc(messages.createdAt))
      .all()

    for (const m of originalMessages) {
      await db.insert(messages).values({
        ...m,
        id: uuid(),
        taskId: spawned.taskId,
        // `in_reply_to` and `request_id` point at ids from the previous run;
        // cloning them as-is would create dangling references in the new
        // task's view. Drop both — the LLM never sees these columns.
        inReplyTo: null,
        requestId: null,
      })
    }
  }

  log.info(
    { originalTaskId: failedTaskId, newTaskId: spawned.taskId, preserveHistory: opts.preserveHistory, queued: spawned.queued },
    'Task retried',
  )

  // Kick the runner now that any seeded history is in place. Queued tasks
  // wait for promotion — the promoter will call executeSubKin when a slot
  // opens, same as a normal spawn.
  if (!spawned.queued) {
    executeSubKin(spawned.taskId).catch((err) =>
      log.error({ taskId: spawned.taskId, err }, 'Sub-Kin retry execution error'),
    )
  }

  return spawned
}

export async function listKinTasks(kinId: string, statusFilter?: TaskStatus) {
  const conditions = [eq(tasks.parentKinId, kinId)]
  if (statusFilter) conditions.push(eq(tasks.status, statusFilter))

  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .all()
}

/** List tasks where this Kin was the executing source (spawned by another Kin). */
export async function listSourceKinTasks(kinId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.sourceKinId, kinId), eq(tasks.spawnType, 'other')))
    .orderBy(desc(tasks.createdAt))
    .all()
}

export async function listAllTasks(statusFilter?: TaskStatus) {
  const conditions = statusFilter ? [eq(tasks.status, statusFilter)] : []

  return db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.createdAt))
    .all()
}

interface ListTasksPaginatedParams {
  status?: TaskStatus
  kinId?: string
  cronId?: string
  search?: string
  limit: number
  offset: number
}

export async function listTasksPaginated(params: ListTasksPaginatedParams) {
  const { status, kinId, cronId, search, limit, offset } = params
  const conditions: ReturnType<typeof eq>[] = []

  if (status) conditions.push(eq(tasks.status, status))
  if (kinId) conditions.push(eq(tasks.parentKinId, kinId))
  if (cronId) conditions.push(eq(tasks.cronId, cronId))
  if (search) {
    const pattern = `%${search}%`
    conditions.push(or(like(tasks.title, pattern), like(tasks.description, pattern))!)
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(whereClause)
    .all()

  const total = countResult[0]?.count ?? 0

  const rows = await db
    .select()
    .from(tasks)
    .where(whereClause)
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .offset(offset)
    .all()

  return { tasks: rows, total }
}

// ─── Filtered + paginated listing (for tools) ────────────────────────────────

export type TaskKind = 'spawn_self' | 'spawn_kin' | 'webhook' | 'cron' | 'unknown'

export interface ListTasksFilters {
  status?: TaskStatus | 'all'
  parentKinSlug?: string
  childKinSlug?: string
  kind?: TaskKind | 'all'
  since?: number
  until?: number
  relatedToKinId?: string
  limit?: number
  offset?: number
}

export interface ListTasksRow {
  id: string
  title: string | null
  status: string
  kind: TaskKind
  parentKinSlug: string | null
  childKinSlug: string | null
  depth: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
}

export interface ListTasksResult {
  tasks: ListTasksRow[]
  total: number
}

const LIST_TASKS_DEFAULT_LIMIT = 20
const LIST_TASKS_MAX_LIMIT = 100
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function computeTaskKind(row: {
  spawnType: string
  webhookId: string | null
  cronId: string | null
}): TaskKind {
  if (row.cronId) return 'cron'
  if (row.webhookId) return 'webhook'
  if (row.spawnType === 'self') return 'spawn_self'
  if (row.spawnType === 'other') return 'spawn_kin'
  return 'unknown'
}

export function computeTaskDurationMs(row: {
  status: string
  createdAt: Date
  updatedAt: Date
  startedAt?: Date | null
  endedAt?: Date | null
}): number | null {
  if (!TERMINAL_STATUSES.has(row.status)) return null
  // Prefer the explicit execution window (started → ended). Fall back to the
  // legacy created → updated span for rows predating those columns (the 0078
  // migration backfills both, so this fallback only matters for in-flight
  // upgrades and defensive safety).
  const start = row.startedAt ?? row.createdAt
  const end = row.endedAt ?? row.updatedAt
  return end.getTime() - start.getTime()
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return LIST_TASKS_DEFAULT_LIMIT
  if (limit < 1) return 1
  if (limit > LIST_TASKS_MAX_LIMIT) return LIST_TASKS_MAX_LIMIT
  return Math.floor(limit)
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || offset < 0) return 0
  return Math.floor(offset)
}

async function resolveKinIdBySlug(slug: string): Promise<string | null> {
  const row = await db
    .select({ id: kins.id })
    .from(kins)
    .where(eq(kins.slug, slug))
    .get()
  return row?.id ?? null
}

export async function listTasksFiltered(filters: ListTasksFilters): Promise<ListTasksResult> {
  const limit = clampLimit(filters.limit)
  const offset = clampOffset(filters.offset)

  let parentKinId: string | undefined
  let childKinId: string | undefined
  if (filters.parentKinSlug) {
    const resolved = await resolveKinIdBySlug(filters.parentKinSlug)
    if (!resolved) return { tasks: [], total: 0 }
    parentKinId = resolved
  }
  if (filters.childKinSlug) {
    const resolved = await resolveKinIdBySlug(filters.childKinSlug)
    if (!resolved) return { tasks: [], total: 0 }
    childKinId = resolved
  }

  const conditions: ReturnType<typeof eq>[] = []

  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(tasks.status, filters.status))
  }
  if (parentKinId) conditions.push(eq(tasks.parentKinId, parentKinId))
  if (childKinId) conditions.push(eq(tasks.sourceKinId, childKinId))

  if (filters.kind && filters.kind !== 'all') {
    switch (filters.kind) {
      case 'spawn_self':
        conditions.push(eq(tasks.spawnType, 'self'))
        conditions.push(isNull(tasks.webhookId))
        conditions.push(isNull(tasks.cronId))
        break
      case 'spawn_kin':
        conditions.push(eq(tasks.spawnType, 'other'))
        conditions.push(isNull(tasks.webhookId))
        conditions.push(isNull(tasks.cronId))
        break
      case 'webhook':
        conditions.push(isNotNull(tasks.webhookId))
        break
      case 'cron':
        conditions.push(isNotNull(tasks.cronId))
        break
    }
  }

  if (typeof filters.since === 'number') {
    conditions.push(gte(tasks.createdAt, new Date(filters.since)))
  }
  if (typeof filters.until === 'number') {
    conditions.push(lte(tasks.createdAt, new Date(filters.until)))
  }

  if (filters.relatedToKinId) {
    conditions.push(
      or(
        eq(tasks.parentKinId, filters.relatedToKinId),
        eq(tasks.sourceKinId, filters.relatedToKinId),
      )!,
    )
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(whereClause)
    .all()
  const total = countResult[0]?.count ?? 0

  if (total === 0) return { tasks: [], total: 0 }

  const rows = await db
    .select()
    .from(tasks)
    .where(whereClause)
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .offset(offset)
    .all()

  const relatedKinIds = Array.from(
    new Set(
      rows.flatMap((r) => [r.parentKinId, r.sourceKinId].filter((id): id is string => !!id)),
    ),
  )
  const slugMap = new Map<string, string>()
  if (relatedKinIds.length > 0) {
    const kinRows = await db
      .select({ id: kins.id, slug: kins.slug, name: kins.name })
      .from(kins)
      .where(inArray(kins.id, relatedKinIds))
      .all()
    for (const k of kinRows) slugMap.set(k.id, k.slug ?? k.name)
  }

  return {
    total,
    tasks: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      kind: computeTaskKind(r),
      parentKinSlug: slugMap.get(r.parentKinId) ?? null,
      childKinSlug: r.sourceKinId ? slugMap.get(r.sourceKinId) ?? null : null,
      depth: r.depth,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      startedAt: r.startedAt ? r.startedAt.getTime() : null,
      endedAt: r.endedAt ? r.endedAt.getTime() : null,
      durationMs: computeTaskDurationMs(r),
    })),
  }
}

// ─── Task messages (paginated previews) ──────────────────────────────────────

const TASK_MESSAGES_DEFAULT_LIMIT = 20
const TASK_MESSAGES_MAX_LIMIT = 50
const MESSAGE_PREVIEW_MAX_CHARS = 200

export interface TaskMessageRow {
  id: string
  role: string
  sourceType: string
  createdAt: number
  contentPreview: string
  contentLength: number
  hasToolCalls: boolean
  toolCallCount: number
}

export interface GetTaskMessagesResult {
  taskId: string
  taskTitle: string | null
  taskStatus: string
  total: number
  messages: TaskMessageRow[]
}

export function buildMessagePreview(content: string | null): {
  preview: string
  length: number
} {
  if (!content) return { preview: '', length: 0 }
  const length = content.length
  if (length <= MESSAGE_PREVIEW_MAX_CHARS) return { preview: content, length }
  return { preview: content.slice(0, MESSAGE_PREVIEW_MAX_CHARS) + '...', length }
}

function countToolCalls(toolCallsJson: string | null): number {
  if (!toolCallsJson) return 0
  try {
    const parsed = JSON.parse(toolCallsJson)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`)
    this.name = 'TaskNotFoundError'
  }
}

export async function getTaskMessages(
  taskId: string,
  rawLimit: number | undefined,
  rawOffset: number | undefined,
  order: 'asc' | 'desc' = 'desc',
): Promise<GetTaskMessagesResult> {
  const task = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, parentKinId: tasks.parentKinId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
  if (!task) throw new TaskNotFoundError(taskId)

  const limit = Math.min(
    Math.max(1, Math.floor(rawLimit ?? TASK_MESSAGES_DEFAULT_LIMIT)),
    TASK_MESSAGES_MAX_LIMIT,
  )

  const totalResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .all()
  const total = totalResult[0]?.count ?? 0

  if (total === 0) {
    return { taskId, taskTitle: task.title, taskStatus: task.status, total: 0, messages: [] }
  }

  if (typeof rawOffset === 'number' && rawOffset < 0) {
    const tail = Math.min(Math.abs(Math.floor(rawOffset)), total)
    const fetchCount = Math.min(tail, limit)
    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.taskId, taskId))
      .orderBy(desc(messages.createdAt))
      .limit(fetchCount)
      .all()
    const mapped = rows.map(rowToMessagePreview)
    if (order === 'asc') mapped.reverse()
    return {
      taskId,
      taskTitle: task.title,
      taskStatus: task.status,
      total,
      messages: mapped,
    }
  }

  const effectiveOffset = clampOffset(rawOffset)
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.taskId, taskId))
    .orderBy(order === 'asc' ? asc(messages.createdAt) : desc(messages.createdAt))
    .limit(limit)
    .offset(effectiveOffset)
    .all()

  return {
    taskId,
    taskTitle: task.title,
    taskStatus: task.status,
    total,
    messages: rows.map(rowToMessagePreview),
  }
}

function rowToMessagePreview(row: {
  id: string
  role: string
  content: string | null
  sourceType: string
  toolCalls: string | null
  createdAt: Date
}): TaskMessageRow {
  const { preview, length } = buildMessagePreview(row.content)
  const toolCallCount = countToolCalls(row.toolCalls)
  return {
    id: row.id,
    role: row.role,
    sourceType: row.sourceType,
    createdAt: row.createdAt.getTime(),
    contentPreview: preview,
    contentLength: length,
    hasToolCalls: toolCallCount > 0,
    toolCallCount,
  }
}

// ─── Cron Journal ────────────────────────────────────────────────────────────

export async function fetchPreviousCronRuns(cronId: string, limit = 5) {
  return db
    .select({
      status: tasks.status,
      result: tasks.result,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(
      eq(tasks.cronId, cronId),
      inArray(tasks.status, ['completed', 'failed']),
    ))
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .all()
}

// ─── Sub-Kin Operations ──────────────────────────────────────────────────────

export async function reportToParent(taskId: string, message: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return false

  // Save the report as a message in the task's message history
  await db.insert(messages).values({
    id: uuid(),
    kinId: task.parentKinId,
    taskId,
    role: 'assistant',
    content: message,
    sourceType: 'task',
    sourceId: taskId,
    createdAt: new Date(),
  })

  return true
}

export async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'completed' | 'failed',
  result?: string,
  error?: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  if (status === 'completed' || status === 'failed') {
    await resolveTask(taskId, status, result, error)
  } else {
    await db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))

    sseManager.sendToKin(task.parentKinId, {
      type: 'task:status',
      kinId: task.parentKinId,
      data: { taskId, kinId: task.parentKinId, status },
    })
  }

  return true
}

export async function requestInput(taskId: string, question: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return { success: false, error: 'Task not active' }

  if (task.requestInputCount >= config.tasks.maxRequestInput) {
    return {
      success: false,
      error: `Max request_input limit (${config.tasks.maxRequestInput}) reached`,
    }
  }

  await db
    .update(tasks)
    .set({ requestInputCount: task.requestInputCount + 1, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  // Ticket sub-Kins ask the user directly: route through the human-prompt
  // pipeline so the task is suspended with `awaiting_human_input`, a
  // notification is created, and the answer resumes the sub-Kin. Without this
  // routing the question would be silently enqueued into the parent Kin's
  // queue, which has no visible effect on the ticket and frustrated users.
  if (task.ticketId) {
    const { createHumanPrompt } = await import('@/server/services/human-prompts')
    await createHumanPrompt({
      kinId: task.parentKinId,
      taskId,
      promptType: 'text',
      question,
      options: [],
    })
    return { success: true }
  }

  // Non-ticket sub-Kins ask their parent Kin: deposit the question in the
  // parent's queue, where it's processed as a normal task_input message.
  await enqueueMessage({
    kinId: task.parentKinId,
    messageType: 'task_input',
    content: `[Task "${task.description}" asks]: ${question}`,
    sourceType: 'task',
    sourceId: taskId,
    priority: config.queue.taskPriority,
    taskId,
  })

  return { success: true }
}

export async function respondToTask(taskId: string, answer: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return false

  // Inject answer into sub-Kin's message history
  await db.insert(messages).values({
    id: uuid(),
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: `[Parent response]: ${answer}`,
    sourceType: 'system',
    createdAt: new Date(),
  })

  // Re-trigger sub-Kin execution
  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin re-execution error'),
  )

  return true
}

// ─── Inter-Kin Request Suspension ───────────────────────────────────────────

/**
 * Suspend a sub-Kin task while it waits for another Kin to reply.
 * Called from the `send_message` tool when `type === 'request'` in sub-Kin context.
 */
export async function suspendTaskForKinResponse(
  taskId: string,
  requestId: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') {
    return { success: false as const, error: 'Task not active' }
  }

  if (task.interKinRequestCount >= config.tasks.maxInterKinRequests) {
    return {
      success: false as const,
      error: `Max inter-Kin request limit (${config.tasks.maxInterKinRequests}) reached for this task`,
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'awaiting_kin_response',
      pendingRequestId: requestId,
      interKinRequestCount: task.interKinRequestCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'awaiting_kin_response',
      title: task.title ?? task.description,
    },
  })

  scheduleInterKinTimeout(taskId, requestId)

  return { success: true as const }
}

/** Active timeout timers for inter-Kin requests, keyed by taskId */
const interKinTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule a timeout that resumes the task if no inter-Kin reply arrives in time.
 */
function scheduleInterKinTimeout(taskId: string, requestId: string) {
  const timer = setTimeout(async () => {
    interKinTimeouts.delete(taskId)
    try {
      // Atomic claim: only one path (timeout or reply) can transition the task
      const result = sqlite.run(
        `UPDATE tasks SET status = 'in_progress', pending_request_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_kin_response' AND pending_request_id = ?`,
        [Date.now(), taskId, requestId],
      )
      if (result.changes === 0) return // Already resumed, cancelled, or different request

      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!task) return

      log.info({ taskId, requestId }, 'Inter-Kin response timeout — resuming task')

      await db.insert(messages).values({
        id: uuid(),
        kinId: task.parentKinId,
        taskId,
        role: 'user',
        content: '[System] The inter-Kin request timed out — no response was received. Continue your task without this information or try an alternative approach.',
        sourceType: 'system',
        createdAt: new Date(),
      })

      sseManager.sendToKin(task.parentKinId, {
        type: 'task:status',
        kinId: task.parentKinId,
        data: {
          taskId,
          kinId: task.parentKinId,
          status: 'in_progress',
          title: task.title ?? task.description,
        },
      })

      executeSubKin(taskId).catch((err) =>
        log.error({ taskId, err }, 'Sub-Kin resume error after inter-Kin timeout'),
      )
    } catch (err) {
      log.error({ taskId, err }, 'Inter-Kin timeout handler error')
    }
  }, config.tasks.interKinResponseTimeoutMs)
  interKinTimeouts.set(taskId, timer)
}

/**
 * Resume a sub-Kin task after receiving an inter-Kin reply.
 * Called from the inter-Kin service when a reply matches a suspended task.
 */
export async function resumeTaskFromKinResponse(
  taskId: string,
  senderKinId: string,
  senderName: string,
  replyMessage: string,
) {
  // Atomic claim: only one path (timeout or reply) can transition the task
  const result = sqlite.run(
    `UPDATE tasks SET status = 'in_progress', pending_request_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_kin_response'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  // Clear the timeout timer since we got the reply
  const timer = interKinTimeouts.get(taskId)
  if (timer) {
    clearTimeout(timer)
    interKinTimeouts.delete(taskId)
  }

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  // Inject reply into task's message history
  await db.insert(messages).values({
    id: uuid(),
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: `[Inter-Kin response from ${senderName}]: ${replyMessage}`,
    sourceType: 'kin',
    sourceId: senderKinId,
    createdAt: new Date(),
  })

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'in_progress',
      title: task.title ?? task.description,
    },
  })

  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin resume error after inter-Kin reply'),
  )

  return true
}

// ─── User Task Control (Pause / Resume / Inject) ────────────────────────────

/**
 * Pause a running task: abort the LLM stream and set status to 'paused'.
 * Only works on tasks with status 'in_progress'.
 */
export async function pauseTask(taskId: string): Promise<boolean> {
  // Atomically check and update status
  const result = sqlite.run(
    `UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'in_progress'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  // Abort the running LLM stream
  abortTaskStream(taskId)

  // Fetch task for SSE notification
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (task) {
    sseManager.sendToKin(task.parentKinId, {
      type: 'task:status',
      kinId: task.parentKinId,
      data: {
        taskId,
        kinId: task.parentKinId,
        status: 'paused',
        title: task.title ?? task.description,
      },
    })
  }

  log.info({ taskId }, 'Task paused by user')
  return true
}

/**
 * Resume a paused task, optionally injecting a user message before restarting.
 * Only works on tasks with status 'paused'.
 */
export async function resumeTask(taskId: string, message?: string): Promise<boolean> {
  // Atomically check and update status
  const result = sqlite.run(
    `UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'paused'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  // Insert a user message so the LLM history doesn't end with the partial assistant response.
  // Without this, the LLM sees the last message as an assistant message and returns empty.
  const msgId = uuid()
  const userContent = message?.trim()
    ? message.trim() + '\n\n[The user sent this message while the task was paused. Take it into account and continue.]'
    : '[System] The task was paused by the user and has now been resumed. Continue where you left off.'
  const displayContent = message?.trim() || undefined

  await db.insert(messages).values({
    id: msgId,
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: userContent,
    sourceType: message?.trim() ? 'user' : 'system',
    createdAt: new Date(),
  })

  if (displayContent) {
    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:message',
      kinId: task.parentKinId,
      data: {
        id: msgId,
        role: 'user',
        content: displayContent,
        sourceType: 'user',
        taskId,
        createdAt: new Date().toISOString(),
      },
    })
  }

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'in_progress',
      title: task.title ?? task.description,
    },
  })

  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin resume error after user resume'),
  )

  log.info({ taskId, withMessage: !!message?.trim() }, 'Task resumed by user')
  return true
}

/**
 * Inject a message into a running task: abort the stream, insert the user message,
 * and restart execution. Like /btw but for tasks.
 * Only works on tasks with status 'in_progress'.
 */
export async function injectIntoTask(taskId: string, content: string): Promise<{ success: boolean; wasStreaming: boolean; error?: string }> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return { success: false, wasStreaming: false, error: 'Task not found' }
  if (task.status !== 'in_progress') return { success: false, wasStreaming: false, error: 'Task is not running' }

  // Abort the running LLM stream
  const wasStreaming = abortTaskStream(taskId)

  // Insert the user message into the task's message history
  const msgId = uuid()
  await db.insert(messages).values({
    id: msgId,
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: content + '\n\n[The user sent this additional context while you were in the middle of working. Take it into account and continue.]',
    sourceType: 'user',
    createdAt: new Date(),
  })

  sseManager.sendToKin(task.parentKinId, {
    type: 'chat:message',
    kinId: task.parentKinId,
    data: {
      id: msgId,
      role: 'user',
      content,
      sourceType: 'user',
      taskId,
      createdAt: new Date().toISOString(),
    },
  })

  // Restart execution with the new context
  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin resume error after inject'),
  )

  log.info({ taskId, wasStreaming }, 'Message injected into task by user')
  return { success: true, wasStreaming }
}
