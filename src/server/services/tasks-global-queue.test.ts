/**
 * Tests for the GLOBAL execution-slot task queue (Stage 2) and its composition
 * with the existing per-group no-overlap queue.
 *
 * Same harness as tasks-scout-suspend.test.ts: a real in-memory SQLite DB with
 * the production schema, so we exercise the actual atomic `sqlite.run` claims
 * and drizzle queries end-to-end.
 *
 * Two concurrency constraints under test (deliberately DIFFERENT slot defs):
 *   - GLOBAL: a task occupies a slot ONLY while {pending,in_progress}. Suspended
 *     states (awaiting_/paused) are IDLE and RELEASE the slot.
 *   - PER-GROUP: serializes a concurrency_group across the broader ACTIVE set
 *     (including awaiting_/paused), so a suspended cron run still blocks its
 *     group's next run.
 *
 * Scenarios:
 *   (a) spawning beyond maxConcurrent → queued, promoted on resolve.
 *   (b) a suspended task does NOT occupy a global slot — a queued task gets
 *       promoted while one task is awaiting.
 *   (c) a resume when full → queued, then promoted (with the injected reply).
 *   (d) maxQueue exceeded → TASK_QUEUE_FULL.
 *   (e) per-group no-overlap still holds — a 2nd cron-group task stays queued
 *       while the 1st is awaiting (idle for the GLOBAL queue, active for the
 *       group), and only runs after the 1st leaves the group.
 *
 * `resolveLLM` is mocked to HANG: executeSubAgent flips the row to in_progress and
 * then awaits the (never-settling) LLM call, so a promoted/spawned task holds its
 * slot deterministically without cascading into resolveTask/promote. We assert on
 * the synchronous DB state plus the awaitable promoteGlobalQueue()/gate helpers.
 */
import { describe, it, expect, mock, beforeAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { v4 as uuid } from 'uuid'
import * as schema from '@/server/db/schema'

const schemaIsReal = !!(schema as any).tasks?.id

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

mock.module('@/server/sse/index', () => ({
  sseManager: { sendToAgent: () => {}, broadcast: () => {} },
}))

// Queue: capture enqueued messages; stub the rest so resolveTask's await-mode
// delivery doesn't need a real queue_items table.
const enqueued: Array<Record<string, unknown>> = []
mock.module('@/server/services/queue', () => ({
  enqueueMessage: async (m: Record<string, unknown>) => { enqueued.push(m) },
  dequeueMessage: async () => null,
  markQueueItemDone: async () => {},
  isAgentProcessing: async () => false,
  getQueueSize: async () => 0,
  recoverStaleProcessingItems: () => {},
  popQueueMessageMetadata: () => undefined,
}))

// spawnTask freezes a prompt-context snapshot that calls listAvailableAgents.
// Stub it so we don't depend on the inter-Agent directory shape here.
mock.module('@/server/services/inter-agent', () => ({
  listAvailableAgents: async () => [],
  sendInterAgentMessage: async () => undefined,
  replyToInterAgentMessage: async () => undefined,
}))

// Force executeSubAgent's LLM resolution to HANG. executeSubAgent sets the row to
// in_progress and then awaits this forever, so a running task deterministically
// holds its global slot without auto-resolving and cascading promotion.
mock.module('@/server/llm/core/resolve', () => ({
  resolveLLM: () => new Promise(() => {}),
}))

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = ON')
const db = schemaIsReal ? drizzle(sqlite, { schema }) : (null as any)

if (schemaIsReal) {
  mock.module('@/server/db/index', () => ({ db, sqlite, initVirtualTables: () => {} }))
}

const svc = schemaIsReal
  ? await import('@/server/services/tasks')
  : ({} as typeof import('@/server/services/tasks'))
const {
  spawnTask,
  resolveTask,
  promoteGlobalQueue,
  suspendTaskForChild,
  resumeTaskFromChildResult,
  recoverStaleTasks,
} = svc as typeof import('@/server/services/tasks')

const settings = schemaIsReal
  ? await import('@/server/services/app-settings')
  : ({} as typeof import('@/server/services/app-settings'))
const { setMaxConcurrentTasks, setMaxQueuedTasks, getMaxQueuedTasks } = settings

const itReal = schemaIsReal ? it : it.skip

// ─── Schema bootstrap (only the tables these paths touch) ────────────────────
beforeAll(() => {
  if (!schemaIsReal) return
  sqlite.run(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      avatar_path TEXT,
      character TEXT NOT NULL,
      expertise TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_id TEXT,
      workspace_path TEXT NOT NULL,
      toolbox_ids TEXT,
      scout_model TEXT,
      scout_provider_id TEXT,
      compacting_config TEXT,
      thinking_config TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_agent_id TEXT NOT NULL,
      source_agent_id TEXT,
      spawn_type TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'execute',
      mode TEXT NOT NULL DEFAULT 'await',
      model TEXT,
      provider_id TEXT,
      title TEXT,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      depth INTEGER NOT NULL DEFAULT 1,
      parent_task_id TEXT,
      cron_id TEXT,
      request_input_count INTEGER NOT NULL DEFAULT 0,
      inter_agent_request_count INTEGER NOT NULL DEFAULT 0,
      pending_request_id TEXT,
      pending_child_task_id TEXT,
      channel_origin_id TEXT,
      webhook_id TEXT,
      prompt_context_snapshot TEXT,
      allow_human_prompt INTEGER NOT NULL DEFAULT 1,
      thinking_config TEXT,
      tool_preset TEXT,
      toolbox_ids TEXT,
      run_prompt TEXT,
      concurrency_group TEXT,
      concurrency_max INTEGER,
      last_api_context_tokens INTEGER,
      queued_at INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT,
      source_type TEXT NOT NULL DEFAULT 'user',
      source_id TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      request_id TEXT,
      in_reply_to TEXT,
      channel_origin_id TEXT,
      is_redacted INTEGER NOT NULL DEFAULT 0,
      redact_pending INTEGER NOT NULL DEFAULT 0,
      reasoning TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  // app_settings: the live tasks_max_concurrent / tasks_max_queue k/v store.
  sqlite.run(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    )
  `)

  sqlite.run(
    `INSERT INTO agents (id, name, role, character, expertise, model, workspace_path, created_at, updated_at)
     VALUES ('agent-a', 'Agent A', 'helper', 'c', 'e', 'm', '/w', 0, 0)`,
  )
})

function getTask(id: string): any {
  return sqlite.query('SELECT * FROM tasks WHERE id = ?').get(id)
}
function taskMessages(taskId: string): any[] {
  return sqlite.query('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[]
}
function countByStatus(status: string): number {
  return (sqlite.query('SELECT COUNT(*) AS n FROM tasks WHERE status = ?').get(status) as any).n
}
/** A promoted task occupies a global slot: it's been claimed out of 'queued'
 *  into the executing set. promoteGlobalQueue() flips it to 'pending' atomically
 *  and then kicks off executeSubAgent (fire-and-forget) which advances it to
 *  'in_progress' on a later microtask — so either executing status proves the
 *  promotion landed. We assert "executing" rather than a specific status to stay
 *  free of that scheduling race. */
function expectExecuting(id: string) {
  const status = getTask(id).status
  expect(['pending', 'in_progress']).toContain(status)
  expect(getTask(id).queued_at).toBeNull()
}

/** Seed a task row directly with a chosen status (bypasses spawnTask's heavy
 *  snapshot path). Used to model pre-existing executing / awaiting / queued tasks. */
function seedTask(opts: {
  status: string
  mode?: string
  group?: string | null
  groupMax?: number | null
  queuedAt?: number | null
  description?: string
}): string {
  const id = 't-' + uuid().slice(0, 8)
  const now = Date.now()
  sqlite.run(
    `INSERT INTO tasks (id, parent_agent_id, spawn_type, mode, description, status, depth,
       concurrency_group, concurrency_max, queued_at, created_at, updated_at)
     VALUES (?, 'agent-a', 'self', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.mode ?? 'async',
      opts.description ?? 'seed task',
      opts.status,
      opts.group ?? null,
      opts.groupMax ?? null,
      opts.queuedAt ?? (opts.status === 'queued' ? now : null),
      now,
      now,
    ],
  )
  return id
}

beforeEach(async () => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM tasks')
  sqlite.run('DELETE FROM messages')
  enqueued.length = 0
  // Reset the live limits to defaults between tests (clears the app-settings
  // cache via the setters' write path).
  await setMaxConcurrentTasks(null)
  await setMaxQueuedTasks(null)
})

// ─── (d) maxQueue guard ──────────────────────────────────────────────────────
describe('spawnTask global gate', () => {
  itReal('(a) queues a fresh task spawned beyond maxConcurrent, then promotes it on resolve', async () => {
    await setMaxConcurrentTasks(2)
    // Two executing tasks already hold both slots.
    const exec1 = seedTask({ status: 'in_progress' })
    seedTask({ status: 'in_progress' })

    // Third spawn → no global slot → queued (spawnTask takes the queued branch
    // and does NOT kick off executeSubAgent).
    const res = await spawnTask({
      parentAgentId: 'agent-a',
      description: 'third task',
      mode: 'async',
      spawnType: 'self',
    })
    expect(res.queued).toBe(true)
    expect(getTask(res.taskId).status).toBe('queued')
    expect(getTask(res.taskId).queued_at).not.toBeNull()

    // Resolve one executing task → a slot frees. Drive the queue (resolveTask
    // schedules this fire-and-forget; we await it directly for determinism).
    await resolveTask(exec1, 'completed', 'done')
    await promoteGlobalQueue()

    // The queued task was promoted into the executing set.
    expectExecuting(res.taskId)
  })

  itReal('(d) rejects with TASK_QUEUE_FULL once the queue is already at maxQueue', async () => {
    await setMaxConcurrentTasks(1)
    await setMaxQueuedTasks(2)
    // Fill the single global slot.
    seedTask({ status: 'in_progress' })
    // Fill the queue to capacity (2 queued).
    seedTask({ status: 'queued' })
    seedTask({ status: 'queued' })

    // Next spawn would have to queue, but the queue is full → throw.
    await expect(
      spawnTask({ parentAgentId: 'agent-a', description: 'overflow', mode: 'async', spawnType: 'self' }),
    ).rejects.toThrow(/TASK_QUEUE_FULL/)

    // No new row was inserted (still exactly 2 queued + 1 executing).
    expect(countByStatus('queued')).toBe(2)
    expect(countByStatus('in_progress')).toBe(1)
  })

  itReal('starts immediately (pending→in_progress) when a global slot is free', async () => {
    await setMaxConcurrentTasks(5)
    const res = await spawnTask({
      parentAgentId: 'agent-a',
      description: 'free slot',
      mode: 'async',
      spawnType: 'self',
    })
    expect(res.queued).toBe(false)
    // executeSubAgent was kicked off — the row is in the executing set (pending
    // right after spawn, advanced to in_progress once executeSubAgent runs).
    expectExecuting(res.taskId)
  })

  itReal('(d2) maxQueue=0 disables queueing — first overflow spawn throws TASK_QUEUE_FULL', async () => {
    // 0 is a legitimate "never queue" setting; it must round-trip through the
    // getter (not get floored back to the default) and make spawnTask reject the
    // moment the global slots are full instead of parking a 'queued' row.
    await setMaxConcurrentTasks(1)
    await setMaxQueuedTasks(0)
    expect(await getMaxQueuedTasks()).toBe(0) // round-trips, not bumped to 100

    // The single global slot is taken; with maxQueue=0 there's no room to queue.
    seedTask({ status: 'in_progress' })
    await expect(
      spawnTask({ parentAgentId: 'agent-a', description: 'no-queue', mode: 'async', spawnType: 'self' }),
    ).rejects.toThrow(/TASK_QUEUE_FULL/)
    expect(countByStatus('queued')).toBe(0) // nothing parked
  })
})

// ─── (b) suspended tasks release the global slot ─────────────────────────────
describe('global slot release on suspend', () => {
  itReal('(b) a suspended (awaiting_subtask) task does NOT occupy a slot — a queued task is promoted', async () => {
    // Cap = 2. Two executing tasks (the runner + its scout child) fill both
    // slots; one task waits in the queue behind them.
    await setMaxConcurrentTasks(2)
    const runner = seedTask({ status: 'in_progress', mode: 'await' })
    const child = seedTask({ status: 'in_progress', mode: 'await' })
    const queued = seedTask({ status: 'queued' })

    // While at cap (2 executing), promoting does nothing.
    await promoteGlobalQueue()
    expect(getTask(queued).status).toBe('queued')

    // The runner suspends on its scout child → leaves the executing set
    // (awaiting_subtask is idle for the GLOBAL queue). Executing drops 2 → 1, a
    // slot frees, and suspendTaskForChild's own promoteGlobalQueue() runs the
    // queued task. (The child stays in_progress, still holding the other slot.)
    const r = await suspendTaskForChild(runner, child)
    expect(r.success).toBe(true)
    expect(getTask(runner).status).toBe('awaiting_subtask')

    // suspendTaskForChild fires promoteGlobalQueue() fire-and-forget; await it
    // directly for a deterministic assertion (proves the freed slot is usable).
    await promoteGlobalQueue()

    // The queued task got promoted (a slot freed when the runner went idle).
    expectExecuting(queued)
  })
})

// ─── (c) resume gates on a slot ──────────────────────────────────────────────
describe('resume gating', () => {
  itReal('(c) a resume when full → re-queued, then promoted with the injected reply still in history', async () => {
    await setMaxConcurrentTasks(1)

    // A parent suspended on a scout child (awaiting_subtask → idle, no slot).
    const parent = seedTask({ status: 'in_progress', mode: 'await' })
    const child = seedTask({ status: 'in_progress', mode: 'await', description: 'scout' })
    await suspendTaskForChild(parent, child)
    expect(getTask(parent).status).toBe('awaiting_subtask')
    // The scout child has finished (terminal) — that's what triggers the resume.
    sqlite.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [child])

    // Meanwhile another task grabbed the single slot.
    const occupier = seedTask({ status: 'in_progress' })

    // The child finishes → resume the parent. The digest IS injected, but the
    // single slot is taken → the parent goes back to 'queued' (NOT in_progress).
    const ok = await resumeTaskFromChildResult(parent, child, 'completed', 'DIGEST: found it', null, 'Scout')
    expect(ok).toBe(true)

    const after = getTask(parent)
    expect(after.status).toBe('queued')
    expect(after.queued_at).not.toBeNull()
    // The reply was injected before the gate, so it survives the re-queue.
    const msgs = taskMessages(parent)
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toContain('DIGEST: found it')

    // The occupier finishes → slot frees → promote drives the queued parent into
    // execution, replaying the already-injected digest.
    await resolveTask(occupier, 'completed', 'done')
    await promoteGlobalQueue()

    expectExecuting(parent)
    // Digest is still there for the resumed run to read.
    expect(taskMessages(parent).some((m) => String(m.content).includes('DIGEST: found it'))).toBe(true)
  })

  itReal('a resume with a free slot proceeds straight to in_progress', async () => {
    await setMaxConcurrentTasks(5)
    const parent = seedTask({ status: 'in_progress', mode: 'await' })
    const child = seedTask({ status: 'in_progress', mode: 'await', description: 'scout' })
    await suspendTaskForChild(parent, child)

    const ok = await resumeTaskFromChildResult(parent, child, 'completed', 'D', null, 'Scout')
    expect(ok).toBe(true)
    // Slot available → ran (executing), not re-queued.
    expectExecuting(parent)
  })
})

// ─── (e) per-group no-overlap composes with the global queue ─────────────────
describe('per-group no-overlap composition', () => {
  itReal('(e) a 2nd cron-group task stays queued while the 1st is awaiting (group still active), runs only after it leaves the group', async () => {
    // Generous global cap so the GLOBAL queue never gates here — we isolate the
    // PER-GROUP constraint.
    await setMaxConcurrentTasks(10)
    const group = 'cron:abc'

    // First group run, currently executing.
    const first = seedTask({ status: 'in_progress', group, groupMax: 1, mode: 'async' })
    // Second group run, queued (the per-group serialization put it here).
    const second = seedTask({ status: 'queued', group, groupMax: 1, mode: 'async' })

    // The first run suspends (awaiting_human_input). For the GLOBAL queue this is
    // idle, but for the PER-GROUP queue awaiting_* is STILL ACTIVE — so the group
    // is at capacity and the second run must NOT be promoted.
    sqlite.run(`UPDATE tasks SET status = 'awaiting_human_input' WHERE id = ?`, [first])
    await promoteGlobalQueue()
    expect(getTask(second).status).toBe('queued') // blocked by the group, not the global cap

    // The first run finishes → leaves the group entirely. Now the second can run.
    await resolveTask(first, 'completed', 'done')
    await promoteGlobalQueue()
    expectExecuting(second)
  })

  itReal('global promotion SKIPS a group-full candidate and promotes a runnable one behind it', async () => {
    await setMaxConcurrentTasks(2)
    const group = 'cron:xyz'

    // Group is at capacity via an executing run.
    seedTask({ status: 'in_progress', group, groupMax: 1, mode: 'async' })
    // Oldest queued is group-blocked; a younger ungrouped queued task is runnable.
    const blocked = seedTask({ status: 'queued', group, groupMax: 1, queuedAt: 1000 })
    const runnable = seedTask({ status: 'queued', queuedAt: 2000 })

    await promoteGlobalQueue()

    // The group-blocked head stays queued; the runnable one behind it is promoted.
    expect(getTask(blocked).status).toBe('queued')
    expectExecuting(runnable)
  })
})

// ─── (restart survival) recoverStaleTasks no longer fails queued ─────────────
describe('restart survival', () => {
  itReal('recoverStaleTasks does NOT fail queued tasks; startup promote drives them', async () => {
    await setMaxConcurrentTasks(5)
    const queued = seedTask({ status: 'queued' })
    // A genuinely stale in_progress row IS recovered to failed.
    const stale = seedTask({ status: 'in_progress' })

    recoverStaleTasks()

    expect(getTask(queued).status).toBe('queued') // survived
    expect(getTask(stale).status).toBe('failed') // force-failed

    // The startup driver then promotes the surviving queued task.
    await promoteGlobalQueue()
    expectExecuting(queued)
  })
})
