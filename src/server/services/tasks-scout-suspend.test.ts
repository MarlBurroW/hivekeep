/**
 * Tests for the scout / sub-task suspend → resume primitive.
 *
 * Spins up a real in-memory SQLite DB with the production schema (the same
 * pattern as the other DB-backed service tests) so we exercise the actual atomic
 * `sqlite.run` claims and drizzle queries end-to-end rather than the brittle
 * mock-drizzle plumbing.
 *
 * The flow under test:
 *   1. A TASK parent (in_progress) spawns an `await` scout child.
 *   2. `suspendTaskForChild` flips the parent → 'awaiting_subtask' and records
 *      the child id in `pending_child_task_id`.
 *   3. The child finishes → `resolveTask(child, 'completed', digest)` detects
 *      the waiting parent and resumes it: status back to 'in_progress',
 *      `pending_child_task_id` cleared, and the digest injected as a user-role
 *      task message. The same path handles a FAILED child (error note injected).
 *
 * We mock the heavy leaf services `resolveTask` touches (tracker, todos,
 * browser, queue, sse) and force `executeSubAgent`'s LLM resolution to throw, so
 * the fire-and-forget resume re-entry fails fast without an LLM. We assert on
 * the synchronous DB mutations (status + injected message) that complete BEFORE
 * that fire-and-forget call.
 */
import { describe, it, expect, mock, beforeAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import * as schema from '@/server/db/schema'

// ─── Mock pollution guard (matches the other DB-backed service tests) ───────
const schemaIsReal = !!(schema as any).tasks?.id

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

mock.module('@/server/sse/index', () => ({
  sseManager: { sendToAgent: () => {}, broadcast: () => {} },
}))

// Queue: capture enqueued messages so we can assert the suspended-parent path
// does NOT enqueue a task_result into the main Agent queue. We stub every symbol
// imported by agent-engine / tasks (the real queue module is otherwise pulled in
// transitively and would need a real queue_items table).
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

// NOTE: we deliberately do NOT mock.module the in-memory leaf services
// resolveTask touches (tool-call-tracker, task-todos, playwright-manager,
// token-usage). Bun's mock.module is process-global and leaks into sibling
// test files; mocking those shared modules here poisons their own test suites.
// Their real implementations are side-effect-free to import and safe to call on
// our throwaway ids (forget* no-op on unknown ids, getTaskStats returns null,
// closeSessionsForTask is fire-and-forget), so we let them run for real.

// Force the resume re-entry (executeSubAgent → resolveLLM) to throw immediately so
// it can't reach a real provider. It will then call resolveTask(child,'failed')
// on the CHILD task id only — never on the parent — so our parent assertions,
// read synchronously right after the awaited resume, stay stable.
mock.module('@/server/llm/core/resolve', () => ({
  resolveLLM: async () => { throw new Error('no-llm-in-test') },
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
const { suspendTaskForChild, resumeTaskFromChildResult, resolveTask } =
  svc as typeof import('@/server/services/tasks')

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

  // app_settings: the resume gate (runOrQueueResumedTask → getMaxConcurrentTasks)
  // reads the live tasks_max_concurrent k/v here. Empty table → getter falls back
  // to the config default, so resumes proceed (slot available) as before.
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

let parentId: string
let childId: string

beforeEach(() => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM tasks')
  sqlite.run('DELETE FROM messages')
  enqueued.length = 0
  parentId = 'parent-' + uuid().slice(0, 8)
  childId = 'child-' + uuid().slice(0, 8)
  const now = Date.now()
  // Parent: a TASK (sub-Agent) currently executing.
  sqlite.run(
    `INSERT INTO tasks (id, parent_agent_id, spawn_type, mode, description, status, depth, created_at, updated_at)
     VALUES (?, 'agent-a', 'self', 'await', 'parent task', 'in_progress', 1, ?, ?)`,
    [parentId, now, now],
  )
  // Child scout: an await child of the parent, in_progress until resolved.
  sqlite.run(
    `INSERT INTO tasks (id, parent_agent_id, spawn_type, mode, description, status, depth, parent_task_id, created_at, updated_at)
     VALUES (?, 'agent-a', 'self', 'await', 'scout', 'in_progress', 2, ?, ?, ?)`,
    [childId, parentId, now, now],
  )
})

function getTask(id: string): any {
  return sqlite.query('SELECT * FROM tasks WHERE id = ?').get(id)
}
function taskMessages(taskId: string): any[] {
  return sqlite.query('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[]
}

describe('suspendTaskForChild', () => {
  itReal('flips an in_progress parent to awaiting_subtask and records the child id', async () => {
    const res = await suspendTaskForChild(parentId, childId)
    expect(res.success).toBe(true)
    const parent = getTask(parentId)
    expect(parent.status).toBe('awaiting_subtask')
    expect(parent.pending_child_task_id).toBe(childId)
  })

  itReal('refuses to suspend a parent that is not in_progress', async () => {
    sqlite.run(`UPDATE tasks SET status = 'completed' WHERE id = ?`, [parentId])
    const res = await suspendTaskForChild(parentId, childId)
    expect(res.success).toBe(false)
    const parent = getTask(parentId)
    // Status untouched, no pending child recorded.
    expect(parent.status).toBe('completed')
    expect(parent.pending_child_task_id).toBeNull()
  })
})

describe('resumeTaskFromChildResult', () => {
  itReal('resumes the parent and injects the scout digest as a user message', async () => {
    await suspendTaskForChild(parentId, childId)
    const ok = await resumeTaskFromChildResult(
      parentId,
      childId,
      'completed',
      'DIGEST: 3 files reference X',
      null,
      'Scout',
    )
    expect(ok).toBe(true)

    const parent = getTask(parentId)
    expect(parent.status).toBe('in_progress')
    expect(parent.pending_child_task_id).toBeNull()

    const msgs = taskMessages(parentId)
    expect(msgs.length).toBe(1)
    expect(msgs[0].role).toBe('user')
    expect(msgs[0].source_type).toBe('task')
    expect(msgs[0].source_id).toBe(childId)
    expect(msgs[0].content).toContain('DIGEST: 3 files reference X')
    expect(msgs[0].content).toContain('[Scout result: Scout]')
  })

  itReal('injects an error note when the scout child failed', async () => {
    await suspendTaskForChild(parentId, childId)
    const ok = await resumeTaskFromChildResult(
      parentId,
      childId,
      'failed',
      null,
      'boom',
      'Scout',
    )
    expect(ok).toBe(true)
    const parent = getTask(parentId)
    expect(parent.status).toBe('in_progress')
    const msgs = taskMessages(parentId)
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toContain('[Scout failed: Scout]')
    expect(msgs[0].content).toContain('boom')
  })

  itReal('is idempotent / race-safe — a second resume for the same child is a no-op', async () => {
    await suspendTaskForChild(parentId, childId)
    const first = await resumeTaskFromChildResult(parentId, childId, 'completed', 'D', null, 'Scout')
    expect(first).toBe(true)
    const second = await resumeTaskFromChildResult(parentId, childId, 'completed', 'D-again', null, 'Scout')
    expect(second).toBe(false)
    // Only the first injection landed.
    expect(taskMessages(parentId).length).toBe(1)
  })

  itReal('does nothing when the parent is awaiting a DIFFERENT child', async () => {
    await suspendTaskForChild(parentId, childId)
    const ok = await resumeTaskFromChildResult(parentId, 'some-other-child', 'completed', 'D', null, 'Scout')
    expect(ok).toBe(false)
    const parent = getTask(parentId)
    expect(parent.status).toBe('awaiting_subtask')
    expect(parent.pending_child_task_id).toBe(childId)
  })
})

describe('resolveTask → parent resume integration', () => {
  itReal('resolving the await scout child resumes the suspended parent (digest injected, no main-queue enqueue)', async () => {
    // Parent suspends on the child (as the scout tool would).
    await suspendTaskForChild(parentId, childId)
    expect(getTask(parentId).status).toBe('awaiting_subtask')

    // The child reports completion. resolveTask must:
    //  - mark the child completed,
    //  - detect the waiting parent and resume it (status in_progress, digest msg),
    //  - SKIP the normal await→task_result enqueue into the Agent's main queue.
    await resolveTask(childId, 'completed', 'FOUND: the bug is in foo.ts')

    // Read parent state synchronously right after the awaited resolveTask. The
    // resume's DB writes (status flip + message insert) are all awaited before
    // the fire-and-forget executeSubAgent re-entry, so the parent is observably
    // 'in_progress' with the digest injected at this point.
    const parent = getTask(parentId)
    expect(parent.status).toBe('in_progress')
    expect(parent.pending_child_task_id).toBeNull()

    const msgs = taskMessages(parentId)
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toContain('FOUND: the bug is in foo.ts')

    // Crucially, the CHILD's resolution did NOT enqueue a task_result for the
    // child into the main Agent queue — the suspended-parent resume replaced the
    // normal await delivery. (A separate enqueue for the PARENT may appear here
    // because the fire-and-forget resume re-entry hits the throwing test LLM and
    // self-fails — that is a test artifact, not the behaviour under test.)
    expect(enqueued.some((m) => m.taskId === childId)).toBe(false)

    // The child itself is terminal.
    expect(getTask(childId).status).toBe('completed')
  })

  itReal('a FAILED scout child still resumes the parent with an error note (no main-queue enqueue)', async () => {
    await suspendTaskForChild(parentId, childId)
    await resolveTask(childId, 'failed', undefined, 'scout exploded')

    const parent = getTask(parentId)
    expect(parent.status).toBe('in_progress')
    expect(parent.pending_child_task_id).toBeNull()
    const msgs = taskMessages(parentId)
    expect(msgs.length).toBe(1)
    expect(msgs[0].content).toContain('[Scout failed')
    expect(msgs[0].content).toContain('scout exploded')
    // The child's failure resumed the parent rather than enqueueing a child
    // task_result into the main queue.
    expect(enqueued.some((m) => m.taskId === childId)).toBe(false)
  })
})
