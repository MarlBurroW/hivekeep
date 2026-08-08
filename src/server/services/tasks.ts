import type { ModelMessage } from '@/server/tools/tool-helper'
import type { Tool } from '@/server/tools/tool-helper'
import { eq, and, desc, asc, inArray, like, or, sql, gte, lte, isNull, isNotNull } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { tasks, agents, messages } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { buildSystemPrompt } from '@/server/services/prompt-builder'
import { getSystemContext } from '@/server/services/system-context'
import { buildSegmentedMessages } from '@/server/services/llm-cache-hints'
import { stringifyToolResultValue } from '@/server/llm/core/vercel-bridge'
import type { HivekeepMessage, HivekeepMessageBlock } from '@/server/llm/llm/types'
import { resolveThinkingConfig, isContextTooLargeError, sanitizePersistedToolCalls, getActiveAgentStreamSnapshot } from '@/server/services/agent-engine'
import { toolRegistry } from '@/server/tools/index'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { getGlobalPrompt, getMaxConcurrentTasks, getMaxQueuedTasks } from '@/server/services/app-settings'
import { wrapToolsWithSpill, capToolResultText } from '@/server/services/tool-output-spill'
import { executeToolBatch } from '@/server/services/tool-executor'
import { recordUsage, aggregateUsages, getTaskTotals } from '@/server/services/token-usage'
import { runStreamStep, type ReasoningSegment } from '@/server/services/stream-runner'
import { toolTurnSampling } from '@/server/services/tool-sampling'
import type { TaskStatus, TaskMode, AgentThinkingConfig } from '@/shared/types'

const log = createLogger('tasks')

/**
 * Minimal safety floor of native tools that genuinely cannot run inside a
 * sub-Agent, regardless of the toolboxes a task references. These are removed
 * AFTER the toolbox allow-list is computed, so even a toolbox that lists one
 * of them (e.g. the built-in 'all') cannot smuggle it into a task.
 *
 * The list is deliberately minimal — it only covers tools that require the
 * main session (cron admin, MCP admin, Agent management, custom-tool admin, and
 * the task-control tools that operate on the parent's task list). Note that
 * `spawn_self` and `spawn_agent` are intentionally NOT here: they become
 * includable via a toolbox, unlocking sub-task delegation.
 */
export const HARD_EXCLUDED_FROM_SUBKIN: readonly string[] = [
  // Task control that needs the main session.
  'respond_to_task',
  'cancel_task',
  'list_tasks',
  // Inter-Agent reply protocol (main-session only).
  'reply',
  // Cron admin.
  'create_cron',
  'update_cron',
  'delete_cron',
  'list_crons',
  // MCP admin.
  'add_mcp_server',
  'update_mcp_server',
  'remove_mcp_server',
  'list_mcp_servers',
  // Custom-tool & tool-domain admin (the resulting custom_<slug> tools stay
  // callable in sub-Agents when a toolbox grants them).
  'create_custom_tool',
  'write_custom_tool_file',
  'run_custom_tool_setup',
  'test_custom_tool',
  'update_custom_tool',
  'delete_custom_tool',
  'list_custom_tools',
  'create_tool_domain',
  'update_tool_domain',
  'delete_tool_domain',
  // Agent management.
  'create_agent',
  'update_agent',
  'delete_agent',
  'get_agent_details',
]

/** Parse a `tasks.toolbox_ids` JSON column into a clean string[] (or undefined
 *  when null/malformed/empty). Used to forward a task's frozen toolbox
 *  selection on retry. */
function parseTaskToolboxIds(raw: string | null): string[] | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const ids = parsed.filter((x): x is string => typeof x === 'string')
      return ids.length > 0 ? ids : undefined
    }
  } catch {
    // Malformed — treat as absent.
  }
  return undefined
}

/**
 * Resolve the toolbox ids that define a task's native toolset.
 *
 * Priority:
 *   1. Explicit `tasks.toolbox_ids` (JSON string[]) frozen at spawn.
 *   2. Back-compat: map the legacy `tasks.tool_preset` to the built-in
 *      toolbox of the same name.
 *   3. Default: the 'all' built-in.
 *
 * Returns an array of toolbox **ids** (resolving built-in names to ids via the
 * toolboxes service). The empty array is returned only when a referenced
 * built-in cannot be found (should not happen once seeding has run).
 */
export async function resolveTaskToolboxIds(task: {
  toolboxIds: string | null
  toolPreset: string | null
}): Promise<string[]> {
  // 1. Explicit toolbox ids on the task row.
  if (task.toolboxIds) {
    try {
      const parsed = JSON.parse(task.toolboxIds)
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((x): x is string => typeof x === 'string')
        if (ids.length > 0) return ids
      }
    } catch {
      // Malformed JSON — fall through to the legacy / default path.
    }
  }

  const { getToolboxByName } = await import('@/server/services/toolboxes')

  // 2. Legacy tool_preset → built-in toolbox of the same name.
  const presetName = task.toolPreset?.trim()
  if (presetName) {
    const box = getToolboxByName(presetName)
    if (box) return [box.id]
  }

  // 3. Default: the 'all' built-in.
  const box = getToolboxByName('all')
  return box ? [box.id] : []
}

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
  /** In-flight provisional text of the current step, mirrored delta-by-delta
   *  by the stream runner. Served appended to `content` for mid-stream
   *  rehydration; cleared when the step commits or retracts. */
  provisional: string
  toolCalls: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }>
  reasoning: ReasoningSegment[]
  /** Running sum of output tokens reported so far this turn (one increment per
   *  completed step). Drives the live token counter in the thinking bubble,
   *  mirroring ActiveAgentStreamSnapshot.outputTokens on the main thread. */
  outputTokens: number
  /** Epoch (ms) when this streaming turn started. Lets a client mounting
   *  mid-stream resume the thinking-bubble chrono from the real start instead
   *  of restarting it at mount time. */
  startedAt: number
}

const activeTaskStreams = new Map<string, ActiveTaskStreamSnapshot>()

/** Read-only access to an in-flight task's accumulated content/tool-calls/reasoning.
 *  The returned arrays are live references held by `executeSubAgent` — callers must not mutate them. */
export function getActiveTaskSnapshot(taskId: string): ActiveTaskStreamSnapshot | undefined {
  return activeTaskStreams.get(taskId)
}

/** Build a public avatar URL from an Agent's stored avatar path */
function agentAvatarUrl(agentId: string, avatarPath: string | null, updatedAt?: Date | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  const v = updatedAt ? updatedAt.getTime() : Date.now()
  return `/api/uploads/agents/${agentId}/avatar.${ext}?v=${v}`
}

// ─── Startup Recovery ────────────────────────────────────────────────────────

/**
 * Recover orphaned tasks stuck in 'pending' or 'in_progress' status.
 * This can happen after a crash or restart. Called once at worker startup.
 * Marks them as 'failed' so they don't block concurrent limits or spin forever.
 */
export function recoverStaleTasks() {
  // Note: 'awaiting_human_input' is NOT recovered — the human can still respond after restart
  // Note: 'awaiting_agent_response' IS recovered — the timeout timer is lost on restart
  // Note: 'awaiting_subtask' IS recovered — the in-memory resume linkage is lost on restart
  //       (a parent waiting on a child that's also force-failed here is acceptable for v1)
  // Note: 'queued' is NOT recovered — global-queue tasks survive a restart and are
  //       re-driven by promoteGlobalQueue() at startup (see startQueueWorker). A
  //       fresh-start queued task runs from scratch; a resuming queued task already
  //       has its reply/digest injected in history, so executeSubAgent picks up cleanly.
  // Note: 'paused' IS recovered — the user context is lost on restart
  const result = sqlite.run(
    `UPDATE tasks SET status = 'failed', error = 'Interrupted by server restart', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE status IN ('pending', 'in_progress', 'paused', 'awaiting_agent_response', 'awaiting_subtask')`,
    [Date.now(), Date.now()],
  )
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'Recovered stale tasks → marked as failed')
  }
}

// ─── Concurrency Group Helpers ───────────────────────────────────────────────

const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'paused', 'awaiting_human_input', 'awaiting_agent_response', 'awaiting_subtask']

async function countActiveTasksInGroup(group: string, excludeTaskId?: string): Promise<number> {
  const base = and(eq(tasks.concurrencyGroup, group), inArray(tasks.status, ACTIVE_STATUSES))
  const where = excludeTaskId ? and(base, sql`${tasks.id} != ${excludeTaskId}`) : base
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(where)
    .all()
  return result[0]?.count ?? 0
}

// ─── Global Execution-Slot Queue ─────────────────────────────────────────────
//
// The GLOBAL queue caps how many tasks are *executing* at once (memory/CPU
// pressure), independent of the per-group no-overlap queue above. It uses a
// DIFFERENT, deliberately narrower slot definition than ACTIVE_STATUSES:
//
//   EXECUTING_STATUSES = {pending, in_progress}
//
// A task occupies a global slot ONLY while it is scheduled-to-run or actively
// in an LLM turn / running a tool. The suspended states (awaiting_human_input,
// awaiting_agent_response, awaiting_subtask, paused) are IDLE — they release the
// global slot so a waiting task can run while another sits blocked on a human,
// a sibling Agent, a child sub-task, or a manual pause. (This is the opposite of
// the per-group constraint, where a suspended run still blocks its group.)
const EXECUTING_STATUSES: TaskStatus[] = ['pending', 'in_progress']

/** Count tasks currently occupying a GLOBAL execution slot ({pending,
 *  in_progress}). Distinct from countActiveTasksInGroup (per-group, counts the
 *  broader ACTIVE_STATUSES set).
 *
 *  `excludeTaskId` lets a RESUMING task ask "is there room for me?" without
 *  counting itself: at the resume gate the row has already been claimed to
 *  'in_progress' (the atomic race-winner flip), so it would otherwise occupy a
 *  slot in this count and mis-report the cap. */
async function countExecutingTasks(excludeTaskId?: string): Promise<number> {
  const where = excludeTaskId
    ? and(inArray(tasks.status, EXECUTING_STATUSES), sql`${tasks.id} != ${excludeTaskId}`)
    : inArray(tasks.status, EXECUTING_STATUSES)
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(where)
    .all()
  return result[0]?.count ?? 0
}

/**
 * Gate a task that has just been resumed (its reply/digest already injected and
 * the row atomically claimed to 'in_progress'). Decides whether it may keep its
 * global slot and run NOW, or must yield it and go back to 'queued'.
 *
 * Composition (same rule as spawnTask): the task may run only when BOTH
 *   - global exec-slots have room (countExecutingTasks EXCLUDING this task <
 *     maxConcurrent — exclude self because the resume race-claim already flipped
 *     it to in_progress), AND
 *   - its group is under cap (no group, or countActiveTasksInGroup < max).
 *
 * If both hold → run executeSubAgent (the row is already in_progress, so this is a
 * direct re-entry). Otherwise → demote to 'queued' (queued_at = now) WITHOUT
 * running; promoteGlobalQueue() will start it later off the already-injected
 * history. Returns true when the task was actually (re-)entered into execution.
 *
 * The demotion is an atomic conditional UPDATE (in_progress → queued WHERE the
 * row is still the one we claimed) so a racing promote/cancel can't be undone.
 */
export async function runOrQueueResumedTask(taskId: string): Promise<boolean> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  // If something already moved the task off in_progress (cancel, pause, a racing
  // resolve), don't interfere — just don't run.
  if (!task || task.status !== 'in_progress') return false

  const maxConcurrent = await getMaxConcurrentTasks()
  const globalHasSlot = (await countExecutingTasks(taskId)) < maxConcurrent

  let groupHasSlot = true
  if (task.concurrencyGroup && task.concurrencyMax) {
    // Exclude this task's own in_progress row from the group count: it's the
    // resuming run, not a *second* concurrent run, so it must not block itself.
    const groupActive = await countActiveTasksInGroup(task.concurrencyGroup, taskId)
    groupHasSlot = groupActive < task.concurrencyMax
  }

  if (globalHasSlot && groupHasSlot) {
    executeSubAgent(taskId).catch((err) =>
      log.error({ taskId, err }, 'Sub-Agent resume execution error'),
    )
    return true
  }

  // No slot — demote to queued. The injected reply/digest stays in history, so
  // promoteGlobalQueue() runs it verbatim once a slot frees.
  const demote = sqlite.run(
    `UPDATE tasks SET status = 'queued', queued_at = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`,
    [Date.now(), Date.now(), taskId],
  )
  if (demote.changes === 0) {
    // Lost the row to a concurrent transition — leave it be.
    return false
  }

  const executingAgentId = task.sourceAgentId ?? task.parentAgentId
  const executingAgent = await db.select().from(agents).where(eq(agents.id, executingAgentId)).get()
  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:status',
    agentId: task.parentAgentId,
    data: {
      taskId,
      agentId: task.parentAgentId,
      status: 'queued',
      title: task.title ?? task.description,
      senderName: executingAgent?.name ?? null,
      senderAvatarUrl: agentAvatarUrl(executingAgentId, executingAgent?.avatarPath ?? null, executingAgent?.updatedAt),
      concurrencyGroup: task.concurrencyGroup,
    },
  })
  log.info({ taskId, group: task.concurrencyGroup }, 'Resuming task re-queued — no free slot')
  return false
}

/**
 * Promote queued tasks into execution as global slots free up.
 *
 * Called on EVERY global-slot release (suspend or resolve), on a maxConcurrent
 * raise, and at startup. Loops while there's a free global slot, picking the
 * OLDEST 'queued' task (by queued_at) whose group is ALSO under its
 * concurrencyMax — composition: a task may run only when BOTH the global slots
 * AND its group have room. A candidate whose group is still full is SKIPPED and
 * we try the next-oldest queued task (the global slot stays free for a
 * group-clear candidate behind it).
 *
 * Promotion = set 'pending' + kick off executeSubAgent in the background, exactly
 * like spawnTask's fresh-start path. For resumes, the reply/agent-response/
 * scout-digest was already injected into the task history before the task was
 * queued, so "promote = run executeSubAgent" works uniformly (executeSubAgent reads
 * the full history on (re-)entry).
 *
 * Concurrency-safe: each promotion claims the row with an atomic conditional
 * UPDATE (status = 'pending' WHERE id = ? AND status = 'queued'). If two
 * releases race, only one claim sees changes > 0 and runs executeSubAgent; the
 * loser skips that row. The claimed id is also tracked in-process so the same
 * invocation never re-counts a just-promoted row before the DB write lands.
 */
export async function promoteGlobalQueue(): Promise<void> {
  // Guard against an unbounded loop if executeSubAgent's status flip lags: cap
  // the number of promotions per call to the number of currently-queued tasks.
  const queuedTotal = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.status, 'queued'))
    .all()
  let budget = queuedTotal[0]?.count ?? 0

  // Ids we've already inspected this pass and found un-promotable (group full)
  // — skip them so the "oldest queued" query keeps advancing instead of
  // re-selecting the same blocked head row forever.
  const skipped = new Set<string>()

  while (budget-- > 0) {
    const maxConcurrent = await getMaxConcurrentTasks()
    if ((await countExecutingTasks()) >= maxConcurrent) break

    // Oldest queued task not already skipped this pass.
    const candidates = await db
      .select()
      .from(tasks)
      .where(eq(tasks.status, 'queued'))
      .orderBy(asc(tasks.queuedAt))
      .all()
    const next = candidates.find((t) => !skipped.has(t.id))
    if (!next) break

    // Composition: a grouped task can only run when its group is under cap.
    // If the group is full, skip this candidate and try the next-oldest — the
    // global slot stays open for a runnable task behind it.
    if (next.concurrencyGroup && next.concurrencyMax) {
      const groupActive = await countActiveTasksInGroup(next.concurrencyGroup)
      if (groupActive >= next.concurrencyMax) {
        skipped.add(next.id)
        continue
      }
    }

    // Atomic claim: flip queued → pending only if still queued. Loses gracefully
    // if a racing release already promoted this row.
    const claim = sqlite.run(
      `UPDATE tasks SET status = 'pending', queued_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`,
      [Date.now(), next.id],
    )
    if (claim.changes === 0) {
      skipped.add(next.id)
      continue
    }

    // Resolve executing Agent info for SSE.
    const executingAgentId = next.sourceAgentId ?? next.parentAgentId
    const executingAgent = await db.select().from(agents).where(eq(agents.id, executingAgentId)).get()

    sseManager.sendToAgent(next.parentAgentId, {
      type: 'task:status',
      agentId: next.parentAgentId,
      data: {
        taskId: next.id,
        agentId: next.parentAgentId,
        status: 'pending',
        title: next.title ?? next.description,
        senderName: executingAgent?.name ?? null,
        senderAvatarUrl: agentAvatarUrl(executingAgentId, executingAgent?.avatarPath ?? null, executingAgent?.updatedAt),
        concurrencyGroup: next.concurrencyGroup,
      },
    })

    log.info({ taskId: next.id, group: next.concurrencyGroup }, 'Queued task promoted to pending (global queue)')

    // Notify source Agent (for spawn_type = 'other'), mirroring spawnTask.
    if (next.spawnType === 'other' && next.sourceAgentId) {
      const taskLabel = next.title ?? next.description
      const briefDesc = next.description.length > 200
        ? next.description.slice(0, 200) + '...'
        : next.description
      notifySourceAgent(next.sourceAgentId, next.parentAgentId, `[Task assigned: ${taskLabel}] ${briefDesc}`, next.id)
        .catch((err) => log.warn({ taskId: next.id, sourceAgentId: next.sourceAgentId, err }, 'Failed to notify source Agent on global promote'))
    }

    // Promote = actually run the sub-Agent (fresh start OR resume — executeSubAgent
    // reads the full history either way).
    executeSubAgent(next.id).catch((err) =>
      log.error({ taskId: next.id, err }, 'Sub-Agent execution error after global promotion'),
    )
  }
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

  // Resolve executing Agent info for SSE
  const executingAgentId = next.sourceAgentId ?? next.parentAgentId
  const executingAgent = await db.select().from(agents).where(eq(agents.id, executingAgentId)).get()

  sseManager.sendToAgent(next.parentAgentId, {
    type: 'task:status',
    agentId: next.parentAgentId,
    data: {
      taskId: next.id,
      agentId: next.parentAgentId,
      status: 'pending',
      title: next.title ?? next.description,
      senderName: executingAgent?.name ?? null,
      senderAvatarUrl: agentAvatarUrl(executingAgentId, executingAgent?.avatarPath ?? null, executingAgent?.updatedAt),
    },
  })

  log.info({ taskId: next.id, group }, 'Queued task promoted to pending')

  // Notify source Agent (for spawn_type = 'other')
  if (next.spawnType === 'other' && next.sourceAgentId) {
    const taskLabel = next.title ?? next.description
    const briefDesc = next.description.length > 200
      ? next.description.slice(0, 200) + '...'
      : next.description
    notifySourceAgent(next.sourceAgentId, next.parentAgentId, `[Task assigned: ${taskLabel}] ${briefDesc}`, next.id)
      .catch((err) => log.warn({ taskId: next.id, sourceAgentId: next.sourceAgentId, err }, 'Failed to notify source Agent on promote'))
  }

  // Execute the sub-Agent
  executeSubAgent(next.id).catch((err) =>
    log.error({ taskId: next.id, err }, 'Sub-Agent execution error after promotion'),
  )
}

export async function forcePromoteTask(taskId: string): Promise<boolean> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'queued') return false

  await db
    .update(tasks)
    .set({ status: 'pending', queuedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  const executingAgentId = task.sourceAgentId ?? task.parentAgentId
  const executingAgent = await db.select().from(agents).where(eq(agents.id, executingAgentId)).get()

  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:status',
    agentId: task.parentAgentId,
    data: {
      taskId: task.id,
      agentId: task.parentAgentId,
      status: 'pending',
      title: task.title ?? task.description,
      senderName: executingAgent?.name ?? null,
      senderAvatarUrl: agentAvatarUrl(executingAgentId, executingAgent?.avatarPath ?? null, executingAgent?.updatedAt),
    },
  })

  log.info({ taskId, group: task.concurrencyGroup }, 'Task force-promoted')

  if (task.spawnType === 'other' && task.sourceAgentId) {
    const taskLabel = task.title ?? task.description
    const briefDesc = task.description.length > 200 ? task.description.slice(0, 200) + '...' : task.description
    notifySourceAgent(task.sourceAgentId, task.parentAgentId, `[Task assigned: ${taskLabel}] ${briefDesc}`, task.id)
      .catch((err) => log.warn({ taskId, sourceAgentId: task.sourceAgentId, err }, 'Failed to notify source Agent on force-promote'))
  }

  executeSubAgent(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Agent execution error after force-promote'),
  )

  return true
}

// ─── Source Agent Notification ─────────────────────────────────────────────────

/**
 * Deposit an informational message in the source Agent's main session.
 * No queue entry → no LLM turn triggered.
 * Follows the same pattern as inter-agent 'inform' messages.
 * Only used for spawn_type = 'other' tasks.
 */
async function notifySourceAgent(
  sourceAgentId: string,
  parentAgentId: string,
  content: string,
  taskId: string,
) {
  // Guard: source Agent must still exist
  const sourceAgent = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, sourceAgentId)).get()
  if (!sourceAgent) return

  const parentAgent = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, parentAgentId))
    .get()

  const msgId = uuid()
  await db.insert(messages).values({
    id: msgId,
    agentId: sourceAgentId,
    role: 'user',
    content,
    sourceType: 'task',
    sourceId: parentAgentId,
    metadata: JSON.stringify({ relatedTaskId: taskId, fromParentAgentId: parentAgentId }),
    createdAt: new Date(),
  })

  sseManager.sendToAgent(sourceAgentId, {
    type: 'chat:message',
    agentId: sourceAgentId,
    data: {
      id: msgId,
      role: 'user',
      content,
      sourceType: 'task',
      sourceId: parentAgentId,
      sourceName: parentAgent?.name ?? null,
      resolvedTaskId: taskId,
      createdAt: Date.now(),
    },
  })
}

// ─── Spawn ───────────────────────────────────────────────────────────────────

interface SpawnParams {
  parentAgentId: string
  title?: string
  description: string
  mode: TaskMode
  spawnType: 'self' | 'other'
  sourceAgentId?: string
  model?: string
  providerId?: string
  parentTaskId?: string
  cronId?: string
  depth?: number
  allowHumanPrompt?: boolean
  channelOriginId?: string
  webhookId?: string
  thinkingConfig?: AgentThinkingConfig
  concurrencyGroup?: string
  concurrencyMax?: number
  /** Optional sub-Agent tool preset override (DEPRECATED — superseded by
   *  `toolboxIds`). When set and `toolboxIds` is absent, it is mapped to the
   *  built-in toolbox of the same name at execution time. */
  toolPreset?: 'code' | 'research' | 'ops' | 'all'
  /** Optional array of toolbox ids defining the task's native toolset. Frozen
   *  onto the task row at spawn. When set, the resolved native allow-list is
   *  CORE_TOOLS unioned with every referenced toolbox's tool names ("*"
   *  expands to all native tools). When absent, falls back to the built-in
   *  matching `toolPreset`, then to 'all'. */
  toolboxIds?: string[]
  /** When true, insert the task row but do NOT kick off `executeSubAgent`. The
   *  caller is responsible for starting execution (e.g. after seeding cloned
   *  messages). Used by `retryTask`. */
  skipExecute?: boolean
}

/**
 * Frozen-at-spawn snapshot of every piece of stable prompt context for a task.
 * This captures *all* the sources of the sub-Agent's stable system prefix so
 * that re-entries (request_input
 * replies, sub-sub-task completions, human_prompt answers, parent replies,
 * nudges) reuse a byte-identical prefix → the Anthropic prompt cache stays
 * warm across the entire lifetime of the task. External DB edits made during
 * execution (renaming the Agent, editing its character, adding cron learnings,
 * tweaking the global prompt, registering a new Agent) deliberately do NOT reach
 * a running task — they will only take effect on subsequent spawns.
 *
 * Dates are serialized as ISO strings so the JSON survives a round-trip through
 * the TEXT column; readers convert them back to `Date` where the prompt-builder
 * expects them.
 */
export interface TaskPromptContextSnapshot {
  agent: {
    name: string
    slug: string | null
    role: string
    character: string
    expertise: string
    workspacePath: string
    model: string
    providerId: string | null
    thinkingConfig: string | null
  }
  globalPrompt: string | null
  agentDirectory: Array<{ id: string; slug: string | null; name: string; role: string }>
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

/** Build the prompt-context snapshot at spawn time. Resolves the identity Agent
 *  using the same rule as `executeSubAgent` (parent unless `spawn_type='other'`
 *  with a `sourceAgentId`). Throws if the identity Agent is missing. */
async function captureTaskPromptContextSnapshot(params: {
  parentAgentId: string
  sourceAgentId?: string | null
  spawnType: 'self' | 'other'
  cronId?: string | null
}): Promise<TaskPromptContextSnapshot> {
  const identityAgentId = params.spawnType === 'other' && params.sourceAgentId
    ? params.sourceAgentId
    : params.parentAgentId
  const identityAgent = await db.select().from(agents).where(eq(agents.id, identityAgentId)).get()
  if (!identityAgent) throw new Error('IDENTITY_AGENT_NOT_FOUND')

  const [globalPrompt, agentDirectory] = await Promise.all([
    getGlobalPrompt(),
    (await import('@/server/services/inter-agent')).listAvailableAgents(identityAgent.id),
  ])

  const snapshot: TaskPromptContextSnapshot = {
    agent: {
      name: identityAgent.name,
      slug: identityAgent.slug,
      role: identityAgent.role,
      character: identityAgent.character,
      expertise: identityAgent.expertise,
      workspacePath: identityAgent.workspacePath,
      model: identityAgent.model,
      providerId: identityAgent.providerId,
      thinkingConfig: identityAgent.thinkingConfig,
    },
    globalPrompt,
    agentDirectory,
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

  const taskId = uuid()
  const now = new Date()

  // ─── Composed concurrency gate (global exec slots × per-group no-overlap) ──
  //
  // The task may START NOW only when BOTH constraints have room:
  //   1. GLOBAL: countExecutingTasks() < maxConcurrent (resource cap, read live
  //      from app_settings so the Settings UI takes effect without a restart).
  //   2. PER-GROUP: no group, OR countActiveTasksInGroup(group) < concurrencyMax
  //      (the existing no-overlap serialization — unchanged).
  //
  // If either is full, the task is QUEUED (status 'queued', queued_at=now) and
  // promoteGlobalQueue() will start it once a slot frees — UNLESS the queue is
  // already saturated (>= maxQueue 'queued' tasks), in which case we THROW
  // TASK_QUEUE_FULL. This throw preserves the anti-runaway protection the old
  // unconditional "max concurrent reached" throw used to give.
  const concurrencyGroup = params.concurrencyGroup ?? null
  const concurrencyMax = params.concurrencyMax ?? null

  const maxConcurrent = await getMaxConcurrentTasks()
  const globalHasSlot = (await countExecutingTasks()) < maxConcurrent

  let groupHasSlot = true
  if (concurrencyGroup && concurrencyMax) {
    const activeCount = await countActiveTasksInGroup(concurrencyGroup)
    groupHasSlot = activeCount < concurrencyMax
  }

  const canRun = globalHasSlot && groupHasSlot
  let initialStatus: 'pending' | 'queued' = canRun ? 'pending' : 'queued'

  if (initialStatus === 'queued') {
    // Anti-runaway guard: reject (throw) instead of queueing once the queue is
    // already at capacity, so a misbehaving spawner can't pile up unbounded.
    const maxQueue = await getMaxQueuedTasks()
    const queuedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(eq(tasks.status, 'queued'))
      .all()
    if ((queuedCount[0]?.count ?? 0) >= maxQueue) {
      throw new Error(`TASK_QUEUE_FULL: task queue is full (${maxQueue} queued)`)
    }
  }

  // Freeze the stable system context (Agent identity, global prompt,
  // Agent directory, cron context). Freezing keeps the sub-Agent's stable
  // prefix byte-identical across re-entries so the
  // Anthropic prompt cache survives.
  const promptContextSnapshot = JSON.stringify(
    await captureTaskPromptContextSnapshot({
      parentAgentId: params.parentAgentId,
      sourceAgentId: params.sourceAgentId ?? null,
      spawnType: params.spawnType,
      cronId: params.cronId ?? null,
    }),
  )

  // Per-field config: an explicit spawn param, otherwise null so the Agent's
  // own setting applies at execution time.
  const effectiveModel = params.model ?? null
  const effectiveProviderId = params.providerId ?? null
  const effectiveThinkingConfig: AgentThinkingConfig | null = params.thinkingConfig ?? null
  const effectiveToolboxIds: string[] | null =
    params.toolboxIds && params.toolboxIds.length > 0 ? params.toolboxIds : null

  await db.insert(tasks).values({
    id: taskId,
    parentAgentId: params.parentAgentId,
    sourceAgentId: params.sourceAgentId ?? null,
    spawnType: params.spawnType,
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
    promptContextSnapshot,
    allowHumanPrompt: params.allowHumanPrompt ?? true,
    thinkingConfig: effectiveThinkingConfig ? JSON.stringify(effectiveThinkingConfig) : null,
    toolPreset: params.toolPreset ?? null,
    toolboxIds: effectiveToolboxIds ? JSON.stringify(effectiveToolboxIds) : null,
    concurrencyGroup,
    concurrencyMax,
    queuedAt: initialStatus === 'queued' ? now : null,
    createdAt: now,
    updatedAt: now,
  })

  // Resolve executing Agent info for SSE metadata
  const executingAgentId = params.sourceAgentId ?? params.parentAgentId
  const executingAgent = await db.select().from(agents).where(eq(agents.id, executingAgentId)).get()

  // Anchor the live task card to the assistant message that triggered the
  // spawn. When spawn_self / spawn_agent fire mid-turn, the parent Agent still has
  // an in-flight main-thread stream whose messageId IS the spawning assistant
  // message (the same id is reused as the persisted DB row at chat:done). The
  // client uses this to render the card directly under that message instead of
  // sorting it by createdAt (which lands before the message, since the row is
  // only persisted at end-of-turn). Null for tasks spawned outside a main-thread
  // turn (webhooks, crons, retries, sub-Agent spawns) — those fall back to the
  // createdAt-based placement.
  const triggerMessageId = getActiveAgentStreamSnapshot(params.parentAgentId)?.messageId ?? null

  // Emit SSE event with metadata for live task card
  sseManager.sendToAgent(params.parentAgentId, {
    type: 'task:status',
    agentId: params.parentAgentId,
    data: {
      taskId,
      agentId: params.parentAgentId,
      status: initialStatus,
      title: params.title ?? params.description,
      senderName: executingAgent?.name ?? null,
      senderAvatarUrl: agentAvatarUrl(executingAgentId, executingAgent?.avatarPath ?? null, executingAgent?.updatedAt),
      concurrencyGroup,
      triggerMessageId,
    },
  })

  log.info({ taskId, parentAgentId: params.parentAgentId, mode: params.mode, spawnType: params.spawnType, depth, queued: initialStatus === 'queued' }, 'Task spawned')

  // If queued, don't execute yet — will be promoted when a slot opens
  if (initialStatus === 'queued') {
    return { taskId, queued: true }
  }

  // Notify source Agent about being spawned (only for spawn_type = 'other')
  if (params.spawnType === 'other' && params.sourceAgentId) {
    const taskLabel = params.title ?? params.description
    // Truncate description to avoid leaking raw prompts into the conversation UI
    const briefDesc = params.description.length > 200
      ? params.description.slice(0, 200) + '...'
      : params.description
    notifySourceAgent(
      params.sourceAgentId,
      params.parentAgentId,
      `[Task assigned: ${taskLabel}] ${briefDesc}`,
      taskId,
    ).catch((err) => log.warn({ taskId, sourceAgentId: params.sourceAgentId, err }, 'Failed to notify source Agent on spawn'))
  }

  // Execute the sub-Agent in the background (unless the caller wants to seed
  // state first — see `skipExecute`, used by `retryTask`).
  if (!params.skipExecute) {
    executeSubAgent(taskId).catch((err) =>
      log.error({ taskId, err }, 'Sub-Agent execution error'),
    )
  }

  return { taskId, queued: false }
}

// ─── Orphan (standalone) tasks ─────────────────────────────────────────────────

export interface StartOrphanTaskResult {
  taskId: string
  parentAgentId: string
  status: string
  mode: TaskMode
  queued: boolean
  createdAt: number
}

/**
 * Spawn a human-initiated standalone task on an Agent. The Agent runs the
 * given prompt in an ephemeral sub-Agent and its result is deposited back as an
 * informational message in the Agent's main session (async mode — same shape as
 * cron/webhook orphan tasks).
 *
 * Resolution chains (all "inherit when unset"):
 *   - model/provider: explicit override → Agent's own model. Coupled.
 *   - thinking/effort: explicit override → Agent's own config.
 *   - toolboxes: explicit selection → runtime default 'all' via
 *     resolveTaskToolboxIds when left null.
 *
 * Throws 'AGENT_NOT_FOUND' / 'MODEL_AND_PROVIDER_MUST_BOTH_BE_SET' / 'EMPTY_PROMPT'.
 */
export async function startOrphanTask(
  parentAgentId: string,
  input: {
    prompt: string
    title?: string | null
    model?: string | null
    providerId?: string | null
    thinkingConfig?: AgentThinkingConfig | null
    toolboxIds?: string[] | null
  },
): Promise<StartOrphanTaskResult> {
  const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.id, parentAgentId)).get()
  if (!agent) throw new Error('AGENT_NOT_FOUND')

  const prompt = input.prompt?.trim() ?? ''
  if (!prompt) throw new Error('EMPTY_PROMPT')

  // model + providerId are coupled — both set or both absent (inherit from Agent).
  const modelSet = !!(input.model && input.model.trim())
  const providerSet = !!(input.providerId && input.providerId.trim())
  if (modelSet !== providerSet) throw new Error('MODEL_AND_PROVIDER_MUST_BOTH_BE_SET')

  const title = input.title?.trim() || null

  const result = await spawnTask({
    parentAgentId,
    description: prompt,
    title: title ?? undefined,
    // No parent queue to re-enter → async, like crons.
    mode: 'async',
    spawnType: 'self',
    model: modelSet ? input.model!.trim() : undefined,
    providerId: providerSet ? input.providerId!.trim() : undefined,
    thinkingConfig: input.thinkingConfig ?? undefined,
    toolboxIds: input.toolboxIds && input.toolboxIds.length > 0 ? input.toolboxIds : undefined,
  })

  const row = db.select().from(tasks).where(eq(tasks.id, result.taskId)).get()
  if (!row) throw new Error('TASK_NOT_FOUND_AFTER_SPAWN')

  return {
    taskId: row.id,
    parentAgentId,
    status: row.status,
    mode: row.mode as TaskMode,
    queued: result.queued === true,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
  }
}

// ─── Sub-Agent Execution ───────────────────────────────────────────────────────

/**
 * Re-trigger sub-Agent execution after pause (e.g., human prompt response).
 * Reads accumulated message history from DB and starts a new LLM stream.
 */
export const resumeSubAgent = executeSubAgent

async function executeSubAgent(taskId: string, isNudge = false) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return

  const parentAgent = await db.select().from(agents).where(eq(agents.id, task.parentAgentId)).get()
  if (!parentAgent) return

  // Determine which Agent's identity to use. The DB row gives us the still-live
  // fields we need outside the prompt (id, avatarPath/updatedAt for SSE). The
  // prompt-affecting fields are overlaid from the frozen snapshot below so
  // mid-task edits to the Agent don't reach a running task.
  let agentIdentity = parentAgent
  if (task.spawnType === 'other' && task.sourceAgentId) {
    const sourceAgent = await db.select().from(agents).where(eq(agents.id, task.sourceAgentId)).get()
    if (sourceAgent) agentIdentity = sourceAgent
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
    agentIdentity = { ...agentIdentity, ...promptSnapshot.agent }
  }

  // Update status to in_progress. `started_at` is set once via COALESCE so
  // re-entries (resume, request_input replies, inter-Agent replies, nudges)
  // never reset the original execution start used for the run duration.
  sqlite.run(
    `UPDATE tasks SET status = 'in_progress', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`,
    [Date.now(), Date.now(), taskId],
  )
  const startedRow = sqlite
    .query(`SELECT started_at AS startedAt FROM tasks WHERE id = ?`)
    .get(taskId) as { startedAt: number | null } | null

  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:status',
    agentId: task.parentAgentId,
    data: {
      taskId,
      agentId: task.parentAgentId,
      status: 'in_progress',
      title: task.title ?? task.description,
      startedAt: startedRow?.startedAt ?? null,
      senderName: agentIdentity.name,
      senderAvatarUrl: agentAvatarUrl(agentIdentity.id, agentIdentity.avatarPath, agentIdentity.updatedAt),
    },
  })

  try {
    const effectiveWorkspacePath: string | null = agentIdentity.workspacePath

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

    // Global prompt + Agent directory — frozen snapshot or live fallback.
    const globalPrompt = promptSnapshot?.globalPrompt !== undefined
      ? promptSnapshot.globalPrompt
      : await getGlobalPrompt()
    const agentDirectory = promptSnapshot?.agentDirectory
      ? promptSnapshot.agentDirectory
      : await (await import('@/server/services/inter-agent')).listAvailableAgents(agentIdentity.id)

    const { getTodosForTask } = await import('@/server/services/task-todos')
    const systemSegments = buildSystemPrompt({
      agent: {
        name: agentIdentity.name,
        slug: agentIdentity.slug,
        role: agentIdentity.role,
        character: agentIdentity.character,
        expertise: agentIdentity.expertise,
      },
      contacts: [],
      agentDirectory,
      isSubAgent: true,
      taskDescription: task.description,
      previousCronRuns,
      cronLearnings,
      globalPrompt,
      userLanguage: 'en',
      workspacePath: effectiveWorkspacePath,
      systemContext: getSystemContext(),
      taskTodos: getTodosForTask(taskId),
    })

    // Resolve LLM — use task's provider if stored, else Agent's provider when using Agent's own model
    const modelId = task.model ?? agentIdentity.model
    const preferredProvider = task.providerId ?? (task.model ? null : agentIdentity.providerId)
    const { resolveLLM } = await import('@/server/llm/core/resolve')
    let taskResolved
    try {
      taskResolved = await resolveLLM({ modelId, providerId: preferredProvider })
    } catch (err) {
      throw new Error(`No LLM provider available for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Resolve thinking config: task-level override takes precedence over parent Agent.
    // Defaults to enabled (interleaved thinking reduces tool-result hallucinations).
    const taskThinkingConfig = resolveThinkingConfig(
      (task.thinkingConfig as string | null) ?? (agentIdentity.thinkingConfig as string | null),
    )
    const taskProviderType = taskResolved.providerRow.type

    // Unified toolset resolution. The toolbox is the sole tool-grant primitive
    // across native + plugin + MCP + custom for the spawned Agent. We resolve the
    // spawned Agent's MAIN surface (isSubAgent: false) intersected with the task's
    // toolboxes, then subtract the hard sub-Agent floor, then layer on the
    // sub-Agent-only comms tools (which are infrastructure, never toolbox-gated).
    const taskToolboxIds = await resolveTaskToolboxIds({
      toolboxIds: task.toolboxIds as string | null,
      toolPreset: task.toolPreset as string | null,
    })

    const { resolveToolset } = await import('@/server/services/toolset-resolver')
    const mainSurface = await resolveToolset({
      agentId: agentIdentity.id,
      toolboxIds: taskToolboxIds,
      // isSubAgent:false → resolve the spawned Agent's MAIN tool surface. The hard
      // sub-Agent floor is subtracted explicitly below (so an 'all' toolbox can't
      // smuggle a main-session-only tool through).
      isSubAgent: false,
      taskId,
      taskDepth: task.depth,
      channelOriginId: task.channelOriginId ?? undefined,
      cronId: task.cronId ?? undefined,
    })

    // Hard sub-Agent floor: removed AFTER the toolbox allow-list.
    for (const name of HARD_EXCLUDED_FROM_SUBKIN) {
      delete mainSurface[name]
    }

    // Sub-Agent-specific tools (scoped to parent for communication back).
    // NOT toolbox-filtered (infrastructure for the task protocol).
    const subAgentTools = toolRegistry.resolve({
      agentId: task.parentAgentId,
      taskId,
      taskDepth: task.depth,
      isSubAgent: true,
      channelOriginId: task.channelOriginId ?? undefined,
      cronId: task.cronId ?? undefined,
    })

    const tools = wrapToolsWithSpill(
      { ...mainSurface, ...subAgentTools },
      effectiveWorkspacePath,
    )

    log.info(
      {
        taskId,
        toolboxIds: taskToolboxIds,
        mainSurfaceCount: Object.keys(mainSurface).length,
        subAgentCount: Object.keys(subAgentTools).length,
      },
      'Sub-Agent toolbox surface resolved',
    )

    // Build task message history (only messages for this task)
    const taskMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.agentId, task.parentAgentId), eq(messages.taskId, taskId)))
      .orderBy(asc(messages.createdAt))
      .all()

    // Reconstruct HivekeepMessage[] from persisted rows. Mirrors the
    // quick-session path in agent-engine.ts (~L2150): assistant rows with
    // persisted tool calls are expanded into an assistant message carrying
    // tool-use blocks plus a paired user-role message with the tool-result
    // blocks, so the LLM sees the same shape on resume that it saw
    // mid-turn. We also skip empty-content rows so they don't reach
    // `buildSegmentedMessages` and get picked as a cache anchor (Anthropic
    // rejects `cache_control` on empty text blocks). Observed when a
    // sub-Agent called `request_input` (only a tool call, no text) and the
    // response message arrived: the in-between assistant row had empty
    // content and was picked as the cross-turn cache anchor.
    const messageHistory: HivekeepMessage[] = []
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
        const validToolCalls = parsedToolCalls ? sanitizePersistedToolCalls(parsedToolCalls, task.parentAgentId) : []
        if (validToolCalls.length > 0) {
          const assistantBlocks: HivekeepMessageBlock[] = []
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
        agentId: task.parentAgentId,
        taskId,
        role: 'user',
        content: task.description,
        sourceType: 'system',
        createdAt: initialMsgCreatedAt,
      })

      // Notify the frontend so the task detail modal can show this message
      // immediately instead of waiting for the next fetchDetail() call.
      sseManager.sendToAgent(task.parentAgentId, {
        type: 'chat:message',
        agentId: task.parentAgentId,
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

    // Execute LLM with streaming (same pattern as agent-engine)
    const assistantMessageId = uuid()
    let fullContent = ''
    const reasoningSegments: ReasoningSegment[] = []
    const toolCallsLog: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }> = []
    let streamError: Error | null = null

    // In-memory snapshot for clients that connect mid-stream — see activeTaskStreams above.
    // Arrays are shared by reference so server-side mutations are visible immediately.
    const streamSnapshot: ActiveTaskStreamSnapshot = {
      messageId: assistantMessageId,
      content: '',
      provisional: '',
      toolCalls: toolCallsLog,
      reasoning: reasoningSegments,
      outputTokens: 0,
      startedAt: Date.now(),
    }
    activeTaskStreams.set(taskId, streamSnapshot)

    // Pre-insert assistant message so it's visible in fetchDetail() during streaming.
    // Content and tool calls will be updated when the stream completes.
    const assistantMsgCreatedAt = new Date()
    await db.insert(messages).values({
      id: assistantMessageId,
      agentId: task.parentAgentId,
      taskId,
      role: 'assistant',
      content: '',
      sourceType: 'agent',
      sourceId: agentIdentity.id,
      createdAt: assistantMsgCreatedAt,
    })

    sseManager.sendToAgent(task.parentAgentId, {
      type: 'chat:message',
      agentId: task.parentAgentId,
      data: {
        id: assistantMessageId,
        taskId,
        role: 'assistant',
        content: '',
        sourceType: 'agent',
        sourceId: agentIdentity.id,
        createdAt: assistantMsgCreatedAt.getTime(),
      },
    })

    // Create an AbortController so the stream can be cancelled from outside
    const abortController = new AbortController()
    activeTaskAbortControllers.set(taskId, abortController)

    // Convert tools to hivekeep shape once.
    const { vercelToolsToHivekeep: taskVercelToolsToHivekeep, markLastHivekeepToolCacheable: taskMarkLastHivekeepToolCacheable } =
      await import('@/server/llm/core/vercel-bridge')
    const taskHivekeepTools = hasTools
      ? taskMarkLastHivekeepToolCacheable(await taskVercelToolsToHivekeep(stripToolExecute(tools)))
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
    // See processNextMessage in agent-engine.ts for rationale.
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
          ...(taskHivekeepTools ? { tools: taskHivekeepTools } : {}),
          ...(taskThinkingEffort ? { thinkingEffort: taskThinkingEffort } : {}),
          ...toolTurnSampling(taskResolved.model, !!taskHivekeepTools),
          signal: abortController.signal,
        },
        taskResolved.config,
      )

      // Text streams live as provisional tokens (see stream-runner.ts).
      // The 500ms DB checkpoint is driven by `ctx.checkpoint` and persists
      // only *committed* content (provisional text is never written to DB).
      const outcome = await runStreamStep(stream, {
        agentId: task.parentAgentId,
        assistantMessageId,
        abortController,
        extraSseFields: { taskId },
        reasoningSegments,
        contentSnapshot: streamSnapshot,
        onCommittedText: (delta) => { fullContent += delta },
        onDroppedText: (txt, idx) => log.debug(
          { taskId, agentId: task.parentAgentId, assistantMessageId, step: idx, droppedChars: txt.length, preview: txt.slice(0, 200) },
          'Dropped in-flight step text (step died: error/abort/stall, sub-Agent)',
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
      if (outcome.usage) {
        stepUsages.push(outcome.usage)
        // Push the running output-token total over SSE so the task panel's
        // thinking bubble shows real tokens accumulating across steps, exactly
        // like the main thread (see agent-engine.ts). Usage is only known at each
        // step's `finish` chunk, so this increments per step (not per token).
        if (outcome.usage.outputTokens) {
          streamSnapshot.outputTokens += outcome.usage.outputTokens
          sseManager.sendToAgent(task.parentAgentId, {
            type: 'chat:token-usage',
            agentId: task.parentAgentId,
            data: { taskId, messageId: assistantMessageId, outputTokens: streamSnapshot.outputTokens },
          })
        }
      }

      if (outcome.error) {
        streamError = outcome.error
      } else if (outcome.wasAborted) {
        log.info({ taskId }, 'Sub-Agent stream aborted by cancellation')
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

      // Build assistant content for history. Thinking blocks come FIRST
      // (Anthropic requires them to lead the assistant turn) so the model's
      // signed reasoning carries across steps — the core of why autonomous
      // tasks kept re-deriving context every step. Prepending ALL thinking
      // before ALL tool_use preserves true stream order because one step = one
      // provider.chat() = one Anthropic response, in which thinking always
      // precedes tool_use (tool results are external — the model can't reason
      // past a tool_use until the next step). Unsigned blocks are skipped: the
      // API drops them anyway, and non-Anthropic providers ignore them.
      const assistantBlocks: HivekeepMessageBlock[] = []
      for (const tb of outcome.stepThinking) {
        if (tb.signature) assistantBlocks.push({ type: 'thinking', text: tb.text, signature: tb.signature })
      }
      if (stepText) assistantBlocks.push({ type: 'text', text: stepText })
      for (const tc of stepToolCalls) {
        assistantBlocks.push({ type: 'tool-use', id: tc.id, name: tc.name, args: tc.args })
      }

      // Execute tool calls (concurrently if all read-only, sequentially otherwise)
      const batch = await executeToolBatch({
        stepToolCalls,
        tools,
        abortController,
        agentId: task.parentAgentId,
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

      // Status check: a tool in this batch may have transitioned the task into
      // a terminal or awaiting state. Stop the multi-step loop NOW so the LLM
      // doesn't run another step on a task that's already done or paused.
      //   - awaiting_* (request_input → awaiting_human_input, send_message
      //     request → awaiting_agent_response, scout → awaiting_subtask): the
      //     sub-Agent resumes via resumeSubAgent() once the response arrives.
      //     Without this the LLM kept emitting tool calls — observed on prod
      //     task `4e4f1760`: 40+ calls after request_input,
      //     incl. a `git commit --no-verify` only stopped by the hook guard.
      //   - completed/failed (update_task_status): resolveTask already ran
      //     inside the batch and does NOT abort the stream, so without this
      //     break the loop issued one more FULL provider.chat() round-trip on
      //     an already-resolved task (the wasted step that produced the
      //     silent-stop fallback). Breaking here drops that round-trip.
      const statusCheck = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      if (
        statusCheck?.status === 'awaiting_human_input' ||
        statusCheck?.status === 'awaiting_agent_response' ||
        statusCheck?.status === 'awaiting_subtask' ||
        statusCheck?.status === 'completed' ||
        statusCheck?.status === 'failed' ||
        statusCheck?.status === 'cancelled'
      ) {
        log.info(
          { taskId, status: statusCheck.status },
          'Sub-Agent step reached terminal/awaiting status — breaking multi-step loop',
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
      // for next step. Tool results live as a user-role message in hivekeep's
      // shape (Anthropic-style).
      messageHistory.push({ role: 'assistant', content: assistantBlocks })
      messageHistory.push({
        role: 'user',
        content: batch.toolResults.map((tr) => ({
          type: 'tool-result',
          toolUseId: tr.toolCallId,
          // Capped here too: within a turn these are re-sent at every later
          // step, so an oversized result is paid for again and again. The
          // history rebuild applies the same cap on the next turn.
          content: capToolResultText(
            stringifyToolResultValue(tr.output.value),
            tr.toolName ?? 'unknown',
            config.toolResultSizeCapTokens,
          ),
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
    }, 'Sub-Agent LLM turn completed')

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
        agentId: task.parentAgentId,
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
        sseManager.sendToAgent(task.parentAgentId, {
          type: 'task:token-usage',
          agentId: task.parentAgentId,
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

      sseManager.sendToAgent(task.parentAgentId, {
        type: 'chat:done',
        agentId: task.parentAgentId,
        data: { messageId: assistantMessageId, content: fullContent, taskId },
      })
      return
    }

    // If the stream errored, fail the task immediately
    if (streamError) {
      log.error({ taskId, error: streamError.message }, 'Sub-Agent stream error')

      // Update pre-inserted assistant message with partial content from the error
      await db.update(messages)
        .set({
          content: fullContent || '',
          toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        })
        .where(eq(messages.id, assistantMessageId))

      sseManager.sendToAgent(task.parentAgentId, {
        type: 'chat:done',
        agentId: task.parentAgentId,
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
        'Sub-Agent: LLM closed stream with no text after tool execution (silent stop)',
      )
      fullContent = `*(This task executed ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} but the model did not produce a final response. This can happen on very large contexts. Retry with a tighter scope or ask the Agent to continue.)*`
      streamSnapshot.content = fullContent
      sseManager.sendToAgent(task.parentAgentId, {
        type: 'chat:token',
        agentId: task.parentAgentId,
        data: { messageId: assistantMessageId, token: fullContent, taskId, contentLength: fullContent.length },
      })
    }

    // Detect silent provider failures: stream completed but produced no output at all
    if (!fullContent && toolCallsLog.length === 0) {
      log.warn({ taskId }, 'Sub-Agent stream produced no output — treating as failure')

      sseManager.sendToAgent(task.parentAgentId, {
        type: 'chat:done',
        agentId: task.parentAgentId,
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
    sseManager.sendToAgent(task.parentAgentId, {
      type: 'chat:done',
      agentId: task.parentAgentId,
      data: { messageId: assistantMessageId, content: responseText, taskId, ...(tokenUsage ? { tokenUsage } : {}) },
    })

    // If the task was suspended for an inter-Agent response or a human prompt,
    // don't nudge — just return. The runner resumes via resumeSubAgent() when
    // the response arrives (respondToHumanPrompt / interAgent reply handler).
    const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (
      currentTask &&
      (currentTask.status === 'awaiting_agent_response' ||
        currentTask.status === 'awaiting_human_input' ||
        currentTask.status === 'awaiting_subtask')
    ) {
      log.info({ taskId, status: currentTask.status }, 'Sub-Agent suspended — exiting without nudge')
      return
    }

    // If the Agent didn't explicitly resolve the task via update_task_status(),
    // give it one more chance (nudge turn) before marking as failed.
    if (currentTask && currentTask.status === 'in_progress') {
      if (!isNudge) {
        // First attempt — inject a reminder and re-run one more LLM turn
        log.info({ taskId }, 'Sub-Agent finished without calling update_task_status — sending nudge turn')

        await db.insert(messages).values({
          id: uuid(),
          agentId: task.parentAgentId,
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

        await executeSubAgent(taskId, true)
      } else {
        // Already nudged once — now fail for real
        log.warn({ taskId }, 'Sub-Agent still did not call update_task_status after nudge — marking as failed')
        await resolveTask(taskId, 'failed', undefined, 'Task did not explicitly report completion')
      }
    }
  } catch (err) {
    activeTaskStreams.delete(taskId)
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    log.error({ taskId, error: errorMsg }, 'Sub-Agent execution failed')
    // Sub-Agents / tasks have their own ephemeral message stream and don't
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

export async function resolveTask(
  taskId: string,
  status: 'completed' | 'failed',
  result?: string,
  error?: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return

  // The Agent that actually executed the task (target Agent for 'other', parent for 'self')
  const executingAgentId = task.sourceAgentId ?? task.parentAgentId

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

  // Resolve executing Agent info for SSE metadata
  const executingAgent = await db.select().from(agents).where(eq(agents.id, executingAgentId)).get()

  // Emit SSE
  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:done',
    agentId: task.parentAgentId,
    data: {
      taskId,
      agentId: task.parentAgentId,
      status,
      result: result ?? null,
      error: error ?? null,
      title: task.title ?? task.description,
      startedAt: task.startedAt ? task.startedAt.getTime() : null,
      endedAt: endedAt.getTime(),
      senderName: executingAgent?.name ?? null,
      senderAvatarUrl: agentAvatarUrl(executingAgentId, executingAgent?.avatarPath ?? null, executingAgent?.updatedAt),
    },
  })

  // Use title for UI display, fall back to description
  const taskLabel = task.title ?? task.description

  // Notify source Agent about task completion/failure (only for spawn_type = 'other')
  if (task.spawnType === 'other' && task.sourceAgentId) {
    const sourceMsg = status === 'completed'
      ? `[Task completed: ${taskLabel}] ${result ?? ''}`
      : `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`
    notifySourceAgent(task.sourceAgentId, task.parentAgentId, sourceMsg, taskId)
      .catch((err) => log.warn({ taskId, sourceAgentId: task.sourceAgentId, err }, 'Failed to notify source Agent on resolve'))
  }

  const taskMetadata = JSON.stringify({ resolvedTaskId: taskId })


  // Scout / sub-task parent resume: when this finishing task is the `await`
  // child of a TASK parent that suspended itself into 'awaiting_subtask'
  // waiting on THIS child (the scout primitive), deliver the result by
  // resuming the parent task — NOT by enqueueing into the executing Agent's
  // main queue (which would wrongly give the MAIN Agent a turn). The atomic
  // claim inside resumeTaskFromChildResult guarantees we only do this for a
  // parent still genuinely waiting on this child. When it fires, we skip the
  // normal await/async parent-delivery block below.
  let resumedSuspendedParent = false
  if (task.parentTaskId) {
    const parentRow = await db
      .select({ status: tasks.status, pendingChildTaskId: tasks.pendingChildTaskId })
      .from(tasks)
      .where(eq(tasks.id, task.parentTaskId))
      .get()
    if (parentRow?.status === 'awaiting_subtask' && parentRow.pendingChildTaskId === taskId) {
      resumedSuspendedParent = await resumeTaskFromChildResult(
        task.parentTaskId,
        taskId,
        status,
        result ?? null,
        error ?? null,
        taskLabel,
      )
    }
  }

  // If await mode, deposit result (or failure) in parent's queue
  if (resumedSuspendedParent) {
    // The suspended parent task already received the digest via resume — do
    // not also enqueue/deposit into the main session.
  } else if (task.mode === 'await' && status === 'completed' && result) {
    await enqueueMessage({
      agentId: task.parentAgentId,
      messageType: 'task_result',
      content: `[Task: ${taskLabel}] Result: ${result}`,
      sourceType: 'task',
      sourceId: executingAgentId,
      priority: config.queue.taskPriority,
      taskId, // Used by agent-engine to set metadata.resolvedTaskId on the message
      channelOriginId: task.channelOriginId ?? undefined,
    })
  } else if (task.mode === 'await' && status === 'failed') {
    await enqueueMessage({
      agentId: task.parentAgentId,
      messageType: 'task_result',
      content: `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`,
      sourceType: 'task',
      sourceId: executingAgentId,
      priority: config.queue.taskPriority,
      taskId,
      channelOriginId: task.channelOriginId ?? undefined,
    })
  } else if (task.mode === 'async' && status === 'completed' && result) {
    // Async mode: deposit as informational message (no queue entry)
    const msgId = uuid()
    await db.insert(messages).values({
      id: msgId,
      agentId: task.parentAgentId,
      role: 'user',
      content: `[Task completed: ${taskLabel}] ${result}`,
      sourceType: 'task',
      sourceId: executingAgentId,
      metadata: taskMetadata,
      createdAt: new Date(),
    })

    // Notify via SSE
    sseManager.sendToAgent(task.parentAgentId, {
      type: 'chat:message',
      agentId: task.parentAgentId,
      data: {
        id: msgId,
        role: 'user',
        content: `[Task completed: ${taskLabel}] ${result}`,
        sourceType: 'task',
        sourceId: executingAgentId,
        resolvedTaskId: taskId,
        createdAt: Date.now(),
      },
    })
  } else if (task.mode === 'async' && status === 'failed') {
    const failureContent = `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`

    if (task.cronId) {
      // Cron-triggered failures are actionable — enqueue so the owner Agent reacts
      await enqueueMessage({
        agentId: task.parentAgentId,
        messageType: 'task_result',
        content: failureContent,
        sourceType: 'task',
        sourceId: executingAgentId,
        priority: config.queue.taskPriority,
        taskId,
        channelOriginId: task.channelOriginId ?? undefined,
      })
    } else {
      // Non-cron async failure: deposit as informational message (no turn)
      const msgId = uuid()
      await db.insert(messages).values({
        id: msgId,
        agentId: task.parentAgentId,
        role: 'user',
        content: failureContent,
        sourceType: 'task',
        sourceId: executingAgentId,
        metadata: taskMetadata,
        createdAt: new Date(),
      })

      sseManager.sendToAgent(task.parentAgentId, {
        type: 'chat:message',
        agentId: task.parentAgentId,
        data: {
          id: msgId,
          role: 'user',
          content: failureContent,
          sourceType: 'task',
          sourceId: executingAgentId,
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

  // A resolved task left the global executing set → a slot just freed. Drive
  // the global queue so the oldest runnable queued task starts immediately.
  promoteGlobalQueue().catch((err) =>
    log.error({ taskId, err }, 'Failed to promote global queue after resolve'),
  )
}

// ─── Task Operations ─────────────────────────────────────────────────────────

export async function cancelTask(taskId: string, agentId: string) {
  const task = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.parentAgentId, agentId)))
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

  // Clear any pending inter-Agent timeout timer
  const interAgentTimer = interAgentTimeouts.get(taskId)
  if (interAgentTimer) {
    clearTimeout(interAgentTimer)
    interAgentTimeouts.delete(taskId)
  }

  const cancelledAt = new Date()
  await db
    .update(tasks)
    .set({ status: 'cancelled', pendingRequestId: null, pendingChildTaskId: null, endedAt: cancelledAt, updatedAt: cancelledAt })
    .where(eq(tasks.id, taskId))

  sseManager.sendToAgent(agentId, {
    type: 'task:status',
    agentId,
    data: {
      taskId,
      agentId,
      status: 'cancelled',
      title: task.title ?? task.description,
      startedAt: task.startedAt ? task.startedAt.getTime() : null,
      endedAt: cancelledAt.getTime(),
    },
  })

  // Notify source Agent about cancellation (only for spawn_type = 'other')
  if (task.spawnType === 'other' && task.sourceAgentId) {
    const taskLabel = task.title ?? task.description
    notifySourceAgent(
      task.sourceAgentId,
      agentId,
      `[Task cancelled: ${taskLabel}]`,
      task.id,
    ).catch((err) => log.warn({ taskId: task.id, sourceAgentId: task.sourceAgentId, err }, 'Failed to notify source Agent on cancel'))
  }

  // Promote next queued task in the same concurrency group
  if (task.concurrencyGroup && task.concurrencyMax) {
    promoteNextQueuedTask(task.concurrencyGroup, task.concurrencyMax).catch((err) =>
      log.error({ taskId, group: task.concurrencyGroup, err }, 'Failed to promote next queued task after cancel'),
    )
  }

  // Cancellation is terminal → the task left the global executing set, freeing
  // a slot. Drive the global queue (only meaningful when the cancelled task was
  // itself executing; a no-op when it was suspended/queued).
  promoteGlobalQueue().catch((err) =>
    log.error({ taskId, err }, 'Failed to promote global queue after cancel'),
  )

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
 *     sub-Agent runner — only text content survives across reload).
 *
 * The original failed task is left intact for audit. The new task carries
 * the same parent/source/cron/webhook/concurrency wiring as the
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

  let thinkingConfig: AgentThinkingConfig | undefined
  if (original.thinkingConfig) {
    try {
      thinkingConfig = JSON.parse(original.thinkingConfig) as AgentThinkingConfig
    } catch {
      thinkingConfig = undefined
    }
  }

  const spawned = await spawnTask({
    parentAgentId: original.parentAgentId,
    sourceAgentId: original.sourceAgentId ?? undefined,
    spawnType: original.spawnType as 'self' | 'other',
    mode: original.mode as 'await' | 'async',
    title: original.title ?? undefined,
    description: original.description,
    depth: original.depth,
    parentTaskId: original.parentTaskId ?? undefined,
    cronId: original.cronId ?? undefined,
    channelOriginId: original.channelOriginId ?? undefined,
    webhookId: original.webhookId ?? undefined,
    model: original.model ?? undefined,
    providerId: original.providerId ?? undefined,
    allowHumanPrompt: original.allowHumanPrompt,
    thinkingConfig,
    concurrencyGroup: original.concurrencyGroup ?? undefined,
    concurrencyMax: original.concurrencyMax ?? undefined,
    toolPreset: (original.toolPreset ?? undefined) as 'code' | 'research' | 'ops' | 'all' | undefined,
    toolboxIds: parseTaskToolboxIds(original.toolboxIds as string | null),
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
  // wait for promotion — the promoter will call executeSubAgent when a slot
  // opens, same as a normal spawn.
  if (!spawned.queued) {
    executeSubAgent(spawned.taskId).catch((err) =>
      log.error({ taskId: spawned.taskId, err }, 'Sub-Agent retry execution error'),
    )
  }

  return spawned
}

export async function listAgentTasks(agentId: string, statusFilter?: TaskStatus) {
  const conditions = [eq(tasks.parentAgentId, agentId)]
  if (statusFilter) conditions.push(eq(tasks.status, statusFilter))

  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .all()
}

/** List tasks where this Agent was the executing source (spawned by another Agent). */
export async function listSourceAgentTasks(agentId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.sourceAgentId, agentId), eq(tasks.spawnType, 'other')))
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
  agentId?: string
  cronId?: string
  search?: string
  limit: number
  offset: number
}

export async function listTasksPaginated(params: ListTasksPaginatedParams) {
  const { status, agentId, cronId, search, limit, offset } = params
  const conditions: ReturnType<typeof eq>[] = []

  if (status) conditions.push(eq(tasks.status, status))
  if (agentId) conditions.push(eq(tasks.parentAgentId, agentId))
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

export type TaskKind = 'spawn_self' | 'spawn_agent' | 'webhook' | 'cron' | 'unknown'

export interface ListTasksFilters {
  status?: TaskStatus | 'all'
  parentAgentSlug?: string
  childAgentSlug?: string
  kind?: TaskKind | 'all'
  since?: number
  until?: number
  relatedToAgentId?: string
  limit?: number
  offset?: number
}

export interface ListTasksRow {
  id: string
  title: string | null
  status: string
  kind: TaskKind
  parentAgentSlug: string | null
  childAgentSlug: string | null
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
  if (row.spawnType === 'other') return 'spawn_agent'
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

async function resolveAgentIdBySlug(slug: string): Promise<string | null> {
  const row = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.slug, slug))
    .get()
  return row?.id ?? null
}

export async function listTasksFiltered(filters: ListTasksFilters): Promise<ListTasksResult> {
  const limit = clampLimit(filters.limit)
  const offset = clampOffset(filters.offset)

  let parentAgentId: string | undefined
  let childAgentId: string | undefined
  if (filters.parentAgentSlug) {
    const resolved = await resolveAgentIdBySlug(filters.parentAgentSlug)
    if (!resolved) return { tasks: [], total: 0 }
    parentAgentId = resolved
  }
  if (filters.childAgentSlug) {
    const resolved = await resolveAgentIdBySlug(filters.childAgentSlug)
    if (!resolved) return { tasks: [], total: 0 }
    childAgentId = resolved
  }

  const conditions: ReturnType<typeof eq>[] = []

  if (filters.status && filters.status !== 'all') {
    conditions.push(eq(tasks.status, filters.status))
  }
  if (parentAgentId) conditions.push(eq(tasks.parentAgentId, parentAgentId))
  if (childAgentId) conditions.push(eq(tasks.sourceAgentId, childAgentId))

  if (filters.kind && filters.kind !== 'all') {
    switch (filters.kind) {
      case 'spawn_self':
        conditions.push(eq(tasks.spawnType, 'self'))
        conditions.push(isNull(tasks.webhookId))
        conditions.push(isNull(tasks.cronId))
        break
      case 'spawn_agent':
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

  if (filters.relatedToAgentId) {
    conditions.push(
      or(
        eq(tasks.parentAgentId, filters.relatedToAgentId),
        eq(tasks.sourceAgentId, filters.relatedToAgentId),
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

  const relatedAgentIds = Array.from(
    new Set(
      rows.flatMap((r) => [r.parentAgentId, r.sourceAgentId].filter((id): id is string => !!id)),
    ),
  )
  const slugMap = new Map<string, string>()
  if (relatedAgentIds.length > 0) {
    const agentRows = await db
      .select({ id: agents.id, slug: agents.slug, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, relatedAgentIds))
      .all()
    for (const k of agentRows) slugMap.set(k.id, k.slug ?? k.name)
  }

  return {
    total,
    tasks: rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      kind: computeTaskKind(r),
      parentAgentSlug: slugMap.get(r.parentAgentId) ?? null,
      childAgentSlug: r.sourceAgentId ? slugMap.get(r.sourceAgentId) ?? null : null,
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
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, parentAgentId: tasks.parentAgentId })
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

// ─── Sub-Agent Operations ──────────────────────────────────────────────────────

export async function reportToParent(taskId: string, message: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return false

  // Save the report as a message in the task's message history
  await db.insert(messages).values({
    id: uuid(),
    agentId: task.parentAgentId,
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

    sseManager.sendToAgent(task.parentAgentId, {
      type: 'task:status',
      agentId: task.parentAgentId,
      data: { taskId, agentId: task.parentAgentId, status, title: task.title ?? task.description },
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

  // Sub-Agents ask their parent Agent: deposit the question in the parent's
  // queue, where it's processed as a normal task_input message.
  await enqueueMessage({
    agentId: task.parentAgentId,
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

  // Inject answer into sub-Agent's message history
  await db.insert(messages).values({
    id: uuid(),
    agentId: task.parentAgentId,
    taskId,
    role: 'user',
    content: `[Parent response]: ${answer}`,
    sourceType: 'system',
    createdAt: new Date(),
  })

  // Re-trigger sub-Agent execution
  executeSubAgent(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Agent re-execution error'),
  )

  return true
}

// ─── Sub-task (scout) Suspension ────────────────────────────────────────────

/**
 * Suspend a TASK (sub-Agent) parent while it blocks on an `await` child it just
 * spawned (the `scout` tool's primitive). This is the task-parent equivalent of
 * the MAIN-Agent await flow: a main Agent enqueues `task_result` → processNextMessage
 * gives it a new turn, but a sub-Agent has no main queue to re-enter, so instead it
 * suspends here (mirroring request_input → awaiting_human_input and send_message
 * → awaiting_agent_response) and the runner ENDS the current run WITHOUT resolving
 * the parent. When the child resolveTask()s, `resumeTaskFromChildResult` finds
 * the waiting parent via `pendingChildTaskId`, injects the child's digest, and
 * re-enters executeSubAgent.
 *
 * Called from the `scout` tool when running inside a sub-Agent task. Returns
 * `{ success:false }` (so the tool can surface an error result and the parent
 * keeps going) when the task is no longer active.
 */
export async function suspendTaskForChild(
  taskId: string,
  childTaskId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  // Atomic claim: only transition a task that's genuinely the in_progress
  // caller of scout(). Avoids racing a concurrent cancel/pause/resolve.
  const result = sqlite.run(
    `UPDATE tasks SET status = 'awaiting_subtask', pending_child_task_id = ?, updated_at = ? WHERE id = ? AND status = 'in_progress'`,
    [childTaskId, Date.now(), taskId],
  )
  if (result.changes === 0) {
    return { success: false as const, error: 'Task not active' }
  }

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (task) {
    sseManager.sendToAgent(task.parentAgentId, {
      type: 'task:status',
      agentId: task.parentAgentId,
      data: {
        taskId,
        agentId: task.parentAgentId,
        status: 'awaiting_subtask',
        title: task.title ?? task.description,
      },
    })
  }

  log.info({ taskId, childTaskId }, 'Sub-Agent suspended — awaiting scout child')

  // The parent left the executing set (awaiting_subtask is idle) → a global slot
  // just freed. Drive the global queue so a waiting task can run while the parent
  // blocks on its scout child.
  promoteGlobalQueue().catch((err) =>
    log.error({ taskId, err }, 'Failed to promote global queue after subtask suspend'),
  )

  return { success: true as const }
}

/**
 * Resume a TASK parent that was suspended (`awaiting_subtask`) on a child that
 * has now reached a terminal state. Injects the child's result (digest on
 * success, an error note on failure) into the parent's task message history as a
 * user-role message — exactly like `resumeTaskFromAgentResponse` does for an
 * inter-Agent reply — then re-enters executeSubAgent so the parent picks up where it
 * left off (the scout tool-call's placeholder result is already persisted, and
 * this injected message carries the actual findings).
 *
 * Idempotent + race-safe: the status/pending_child claim is atomic, so only one
 * caller resumes a given parent for a given child.
 *
 * Returns true if the parent was actually resumed.
 */
export async function resumeTaskFromChildResult(
  parentTaskId: string,
  childTaskId: string,
  childStatus: 'completed' | 'failed',
  childResult: string | null,
  childError: string | null,
  childLabel: string,
): Promise<boolean> {
  // Atomic claim: only resume a parent that is still awaiting THIS child.
  const result = sqlite.run(
    `UPDATE tasks SET status = 'in_progress', pending_child_task_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_subtask' AND pending_child_task_id = ?`,
    [Date.now(), parentTaskId, childTaskId],
  )
  if (result.changes === 0) return false

  const parent = await db.select().from(tasks).where(eq(tasks.id, parentTaskId)).get()
  if (!parent) return false

  // Inject the child outcome as a user-role message in the parent's task
  // history. On resume, executeSubAgent reads this back as the latest user turn,
  // so the parent reacts to the scout's findings without us having to rewrite
  // the already-persisted scout tool-result block.
  const injected =
    childStatus === 'completed'
      ? `[Scout result: ${childLabel}]\n${childResult ?? '(the scout returned no digest)'}`
      : `[Scout failed: ${childLabel}] ${childError ?? 'Unknown error'}\n\nThe scout sub-task could not complete. Continue your task without its findings, narrow the scope and dispatch another scout, or explore directly yourself.`

  await db.insert(messages).values({
    id: uuid(),
    agentId: parent.parentAgentId,
    taskId: parentTaskId,
    role: 'user',
    content: injected,
    sourceType: 'task',
    sourceId: childTaskId,
    createdAt: new Date(),
  })

  sseManager.sendToAgent(parent.parentAgentId, {
    type: 'task:status',
    agentId: parent.parentAgentId,
    data: {
      taskId: parentTaskId,
      agentId: parent.parentAgentId,
      status: 'in_progress',
      title: parent.title ?? parent.description,
    },
  })

  log.info(
    { parentTaskId, childTaskId, childStatus },
    'Sub-Agent parent resumed after scout child finished',
  )

  // Gate the resume on a global slot. The atomic claim above already flipped the
  // row to in_progress (race-winner); runOrQueueResumedTask either keeps it
  // running or demotes it back to 'queued' (it'll be promoted later off the
  // already-injected digest). The SSE 'in_progress' above is a momentary glitch
  // when re-queued, immediately corrected by the 'queued' event in the helper.
  await runOrQueueResumedTask(parentTaskId)

  return true
}

// ─── Inter-Agent Request Suspension ───────────────────────────────────────────

/**
 * Suspend a sub-Agent task while it waits for another Agent to reply.
 * Called from the `send_message` tool when `type === 'request'` in sub-Agent context.
 */
export async function suspendTaskForAgentResponse(
  taskId: string,
  requestId: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') {
    return { success: false as const, error: 'Task not active' }
  }

  if (task.interAgentRequestCount >= config.tasks.maxInterAgentRequests) {
    return {
      success: false as const,
      error: `Max inter-Agent request limit (${config.tasks.maxInterAgentRequests}) reached for this task`,
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'awaiting_agent_response',
      pendingRequestId: requestId,
      interAgentRequestCount: task.interAgentRequestCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:status',
    agentId: task.parentAgentId,
    data: {
      taskId,
      agentId: task.parentAgentId,
      status: 'awaiting_agent_response',
      title: task.title ?? task.description,
    },
  })

  scheduleInterAgentTimeout(taskId, requestId)

  // The task left the executing set (awaiting_agent_response is idle) → a global
  // slot just freed. Drive the global queue so a waiting task can run.
  promoteGlobalQueue().catch((err) =>
    log.error({ taskId, err }, 'Failed to promote global queue after inter-Agent suspend'),
  )

  return { success: true as const }
}

/** Active timeout timers for inter-Agent requests, keyed by taskId */
const interAgentTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule a timeout that resumes the task if no inter-Agent reply arrives in time.
 */
function scheduleInterAgentTimeout(taskId: string, requestId: string) {
  const timer = setTimeout(async () => {
    interAgentTimeouts.delete(taskId)
    try {
      // Atomic claim: only one path (timeout or reply) can transition the task
      const result = sqlite.run(
        `UPDATE tasks SET status = 'in_progress', pending_request_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_agent_response' AND pending_request_id = ?`,
        [Date.now(), taskId, requestId],
      )
      if (result.changes === 0) return // Already resumed, cancelled, or different request

      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!task) return

      log.info({ taskId, requestId }, 'Inter-Agent response timeout — resuming task')

      await db.insert(messages).values({
        id: uuid(),
        agentId: task.parentAgentId,
        taskId,
        role: 'user',
        content: '[System] The inter-Agent request timed out — no response was received. Continue your task without this information or try an alternative approach.',
        sourceType: 'system',
        createdAt: new Date(),
      })

      sseManager.sendToAgent(task.parentAgentId, {
        type: 'task:status',
        agentId: task.parentAgentId,
        data: {
          taskId,
          agentId: task.parentAgentId,
          status: 'in_progress',
          title: task.title ?? task.description,
        },
      })

      // Gate on a global slot (the timeout note was already injected above) —
      // awaiting_agent_response released the slot, so the timeout-resume may need
      // to re-queue if the cap is now full.
      await runOrQueueResumedTask(taskId)
    } catch (err) {
      log.error({ taskId, err }, 'Inter-Agent timeout handler error')
    }
  }, config.tasks.interAgentResponseTimeoutMs)
  interAgentTimeouts.set(taskId, timer)
}

/**
 * Resume a sub-Agent task after receiving an inter-Agent reply.
 * Called from the inter-Agent service when a reply matches a suspended task.
 */
export async function resumeTaskFromAgentResponse(
  taskId: string,
  senderAgentId: string,
  senderName: string,
  replyMessage: string,
) {
  // Atomic claim: only one path (timeout or reply) can transition the task
  const result = sqlite.run(
    `UPDATE tasks SET status = 'in_progress', pending_request_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_agent_response'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  // Clear the timeout timer since we got the reply
  const timer = interAgentTimeouts.get(taskId)
  if (timer) {
    clearTimeout(timer)
    interAgentTimeouts.delete(taskId)
  }

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  // Inject reply into task's message history
  await db.insert(messages).values({
    id: uuid(),
    agentId: task.parentAgentId,
    taskId,
    role: 'user',
    content: `[Inter-Agent response from ${senderName}]: ${replyMessage}`,
    sourceType: 'agent',
    sourceId: senderAgentId,
    createdAt: new Date(),
  })

  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:status',
    agentId: task.parentAgentId,
    data: {
      taskId,
      agentId: task.parentAgentId,
      status: 'in_progress',
      title: task.title ?? task.description,
    },
  })

  // Gate the resume on a global slot (the reply was already injected above). If
  // the cap is full, runOrQueueResumedTask demotes the row to 'queued' and
  // promoteGlobalQueue() runs it later off the injected reply.
  await runOrQueueResumedTask(taskId)

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
    sseManager.sendToAgent(task.parentAgentId, {
      type: 'task:status',
      agentId: task.parentAgentId,
      data: {
        taskId,
        agentId: task.parentAgentId,
        status: 'paused',
        title: task.title ?? task.description,
      },
    })
  }

  log.info({ taskId }, 'Task paused by user')

  // 'paused' is idle and releases the global slot → drive the queue so a waiting
  // task can run while this one sits paused.
  promoteGlobalQueue().catch((err) =>
    log.error({ taskId, err }, 'Failed to promote global queue after pause'),
  )

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
    agentId: task.parentAgentId,
    taskId,
    role: 'user',
    content: userContent,
    sourceType: message?.trim() ? 'user' : 'system',
    createdAt: new Date(),
  })

  if (displayContent) {
    sseManager.sendToAgent(task.parentAgentId, {
      type: 'chat:message',
      agentId: task.parentAgentId,
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

  sseManager.sendToAgent(task.parentAgentId, {
    type: 'task:status',
    agentId: task.parentAgentId,
    data: {
      taskId,
      agentId: task.parentAgentId,
      status: 'in_progress',
      title: task.title ?? task.description,
    },
  })

  // Gate the resume on a global slot (the continuation message was already
  // injected above). If the cap is full, runOrQueueResumedTask demotes the row
  // to 'queued' and promoteGlobalQueue() runs it later off the injected message.
  await runOrQueueResumedTask(taskId)

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
    agentId: task.parentAgentId,
    taskId,
    role: 'user',
    content: content + '\n\n[The user sent this additional context while you were in the middle of working. Take it into account and continue.]',
    sourceType: 'user',
    createdAt: new Date(),
  })

  sseManager.sendToAgent(task.parentAgentId, {
    type: 'chat:message',
    agentId: task.parentAgentId,
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
  executeSubAgent(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Agent resume error after inject'),
  )

  log.info({ taskId, wasStreaming }, 'Message injected into task by user')
  return { success: true, wasStreaming }
}
