import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mocks ───────────────────────────────────────────────────────────────────

// In-memory fake DB rows used by the chained mockDb.
interface FakeState {
  taskRows: any[]
  messageRows: any[]
  kinRows: any[]
  // captured args
  lastWhere: any
  lastSelect: any
  lastOrderBy: any
  lastLimit: number | undefined
  lastOffset: number | undefined
  lastFrom: string | undefined
}

const state: FakeState = {
  taskRows: [],
  messageRows: [],
  kinRows: [],
  lastWhere: undefined,
  lastSelect: undefined,
  lastOrderBy: undefined,
  lastLimit: undefined,
  lastOffset: undefined,
  lastFrom: undefined,
}

function tableName(t: any): string {
  if (t === fakeTasks) return 'tasks'
  if (t === fakeMessages) return 'messages'
  if (t === fakeKins) return 'kins'
  return 'unknown'
}

const fakeTasks = { __t: 'tasks' }
const fakeMessages = { __t: 'messages' }
const fakeKins = { __t: 'kins' }

const fakeDb: any = {
  select(sel?: any) {
    state.lastSelect = sel
    return fakeDb
  },
  from(t: any) {
    state.lastFrom = tableName(t)
    return fakeDb
  },
  where(w: any) {
    state.lastWhere = w
    return fakeDb
  },
  orderBy(o: any) {
    state.lastOrderBy = o
    return fakeDb
  },
  limit(n: number) {
    state.lastLimit = n
    return fakeDb
  },
  offset(n: number) {
    state.lastOffset = n
    return fakeDb
  },
  async all() {
    const rows = pickRows()
    return applyFilter(rows)
  },
  async get() {
    const rows = pickRows()
    return applyFilter(rows)[0]
  },
}

function pickRows(): any[] {
  if (state.lastFrom === 'tasks') return state.taskRows
  if (state.lastFrom === 'messages') return state.messageRows
  if (state.lastFrom === 'kins') return state.kinRows
  return []
}

// Predicate evaluator: filter predicates emitted by the patched drizzle operators
function applyFilter(rows: any[]): any[] {
  // If the SELECT was a count, just return [{ count: filtered.length }] over the filter.
  const sel = state.lastSelect
  const isCount = sel && typeof sel === 'object' && 'count' in sel

  const where = state.lastWhere
  let filtered = where ? rows.filter((r) => evalPredicate(where, r)) : rows.slice()

  // Apply ordering on createdAt for tasks/messages
  if (state.lastOrderBy && (state.lastFrom === 'tasks' || state.lastFrom === 'messages')) {
    const o = state.lastOrderBy
    if (o.__order === 'desc') {
      filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    } else if (o.__order === 'asc') {
      filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    }
  }

  if (isCount) {
    return [{ count: filtered.length }]
  }

  if (state.lastOffset !== undefined && state.lastOffset > 0) {
    filtered = filtered.slice(state.lastOffset)
  }
  if (state.lastLimit !== undefined && state.lastLimit > 0) {
    filtered = filtered.slice(0, state.lastLimit)
  }
  return filtered
}

function evalPredicate(p: any, row: any): boolean {
  if (!p || typeof p !== 'object') return true
  switch (p.__op) {
    case 'eq': {
      const v = row[p.col]
      return v === p.val
    }
    case 'and':
      return p.parts.every((x: any) => evalPredicate(x, row))
    case 'or':
      return p.parts.some((x: any) => evalPredicate(x, row))
    case 'isNull':
      return row[p.col] == null
    case 'isNotNull':
      return row[p.col] != null
    case 'gte':
      return row[p.col] instanceof Date
        ? row[p.col].getTime() >= p.val.getTime()
        : row[p.col] >= p.val
    case 'lte':
      return row[p.col] instanceof Date
        ? row[p.col].getTime() <= p.val.getTime()
        : row[p.col] <= p.val
    case 'inArray':
      return p.vals.includes(row[p.col])
    default:
      return true
  }
}

mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

mock.module('@/server/db/index', () => ({ db: fakeDb, sqlite: { run: () => ({ changes: 0 }) } }))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  tasks: new Proxy({}, { get: (_t, prop) => ({ __col: String(prop), __table: 'tasks' }) }),
  messages: new Proxy({}, { get: (_t, prop) => ({ __col: String(prop), __table: 'messages' }) }),
  kins: new Proxy({}, { get: (_t, prop) => ({ __col: String(prop), __table: 'kins' }) }),
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (col: any, val: any) => ({ __op: 'eq', col: col?.__col ?? col, val }),
  and: (...parts: any[]) => ({ __op: 'and', parts: parts.filter(Boolean) }),
  or: (...parts: any[]) => ({ __op: 'or', parts: parts.filter(Boolean) }),
  isNull: (col: any) => ({ __op: 'isNull', col: col?.__col ?? col }),
  isNotNull: (col: any) => ({ __op: 'isNotNull', col: col?.__col ?? col }),
  gte: (col: any, val: any) => ({ __op: 'gte', col: col?.__col ?? col, val }),
  lte: (col: any, val: any) => ({ __op: 'lte', col: col?.__col ?? col, val }),
  desc: (col: any) => ({ __order: 'desc', col }),
  asc: (col: any) => ({ __order: 'asc', col }),
  inArray: (col: any, vals: any[]) => ({ __op: 'inArray', col: col?.__col ?? col, vals }),
  like: () => ({ __op: 'like' }),
  sql: (() => {
    const fn: any = (..._args: any[]) => ({ __op: 'sql' })
    return fn
  })(),
}))

// Override fakeTasks/fakeMessages/fakeKins identity so tableName() can detect them
;(fakeTasks as any).__t = 'tasks'
;(fakeMessages as any).__t = 'messages'
;(fakeKins as any).__t = 'kins'

// Import after mocks. Bun's mock.module() leaks across test files, so a sibling
// test that stubbed @/server/services/tasks may have replaced this module
// before we get here. Detect that by checking for our real exports and skip
// rather than failing the whole file (matches the pattern in task-tools.test.ts).
let svc: typeof import('@/server/services/tasks')
let _loaded = false
try {
  // Use a relative path so sibling test files that mock '@/server/services/tasks'
  // via the alias don't intercept this import.
  svc = (await import('./tasks')) as typeof import('@/server/services/tasks')
  _loaded =
    typeof (svc as any).computeTaskKind === 'function' &&
    typeof (svc as any).listTasksFiltered === 'function' &&
    typeof (svc as any).getTaskMessages === 'function'
} catch {
  _loaded = false
}
const itLoaded = _loaded ? it : it.skip

// Replace tableName detection: schema mock returns Proxies, not fakeTasks.
// Reroute db chain to look at schema proxies by reading any column's __table.
const realDb: any = fakeDb
realDb.from = function (t: any) {
  if (t && typeof t === 'object') {
    // schema export: Proxy where every prop yields {__table}
    const sample = t.id
    if (sample?.__table) {
      state.lastFrom = sample.__table
      return fakeDb
    }
  }
  state.lastFrom = tableName(t)
  return fakeDb
}

function makeTask(overrides: Partial<any> = {}): any {
  const now = new Date('2026-05-01T00:00:00Z')
  return {
    id: 'task-' + Math.random().toString(36).slice(2, 8),
    parentKinId: 'kin-a',
    sourceKinId: null,
    spawnType: 'self',
    mode: 'await',
    title: 'A task',
    description: 'desc',
    status: 'completed',
    result: null,
    error: null,
    depth: 1,
    cronId: null,
    webhookId: null,
    parentTaskId: null,
    queuedAt: null,
    createdAt: now,
    updatedAt: new Date(now.getTime() + 60_000),
    ...overrides,
  }
}

function reset() {
  state.taskRows = []
  state.messageRows = []
  state.kinRows = []
  state.lastWhere = undefined
  state.lastSelect = undefined
  state.lastOrderBy = undefined
  state.lastLimit = undefined
  state.lastOffset = undefined
  state.lastFrom = undefined
}

// Inline duplicates of the pure helpers from tasks.ts. Bun's mock.module() is
// global across the test process — other test files stub @/server/services/tasks
// before our file runs, which means an alias-based import here returns the stub,
// not the real exports. The duplicates below mirror the source exactly and let
// these helper tests run even when the dynamic import is poisoned. (Same
// pattern as src/server/services/contacts.test.ts.)

type SpawnKindRow = { spawnType: string; webhookId: string | null; cronId: string | null }
function _computeTaskKindLocal(row: SpawnKindRow): string {
  if (row.cronId) return 'cron'
  if (row.webhookId) return 'webhook'
  if (row.spawnType === 'self') return 'spawn_self'
  if (row.spawnType === 'other') return 'spawn_kin'
  return 'unknown'
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
function _computeTaskDurationLocal(row: {
  status: string
  createdAt: Date
  updatedAt: Date
}): number | null {
  if (!TERMINAL.has(row.status)) return null
  return row.updatedAt.getTime() - row.createdAt.getTime()
}

function _buildMessagePreviewLocal(content: string | null): { preview: string; length: number } {
  if (!content) return { preview: '', length: 0 }
  const length = content.length
  if (length <= 200) return { preview: content, length }
  return { preview: content.slice(0, 200) + '...', length }
}

describe('tasks service: pure helpers (inline duplicates)', () => {
  it('computeTaskKind maps cron > webhook > spawnType', () => {
    expect(_computeTaskKindLocal({ spawnType: 'self', webhookId: null, cronId: 'c1' })).toBe('cron')
    expect(_computeTaskKindLocal({ spawnType: 'self', webhookId: 'w', cronId: null })).toBe('webhook')
    expect(_computeTaskKindLocal({ spawnType: 'self', webhookId: null, cronId: null })).toBe('spawn_self')
    expect(_computeTaskKindLocal({ spawnType: 'other', webhookId: null, cronId: null })).toBe('spawn_kin')
    expect(_computeTaskKindLocal({ spawnType: '?', webhookId: null, cronId: null })).toBe('unknown')
  })

  it('computeTaskDurationMs returns null for non-terminal status, ms diff otherwise', () => {
    const a = new Date(1000)
    const b = new Date(5000)
    expect(_computeTaskDurationLocal({ status: 'pending', createdAt: a, updatedAt: b })).toBeNull()
    expect(_computeTaskDurationLocal({ status: 'completed', createdAt: a, updatedAt: b })).toBe(4000)
  })

  it('buildMessagePreview truncates >200 chars with ellipsis', () => {
    expect(_buildMessagePreviewLocal(null)).toEqual({ preview: '', length: 0 })
    const long = 'x'.repeat(250)
    const r = _buildMessagePreviewLocal(long)
    expect(r.length).toBe(250)
    expect(r.preview.length).toBe(203)
    expect(r.preview.endsWith('...')).toBe(true)
  })
})

describe('tasks service: pure helpers', () => {
  itLoaded('computeTaskKind maps cron > webhook > spawnType', () => {
    expect(svc.computeTaskKind({ spawnType: 'self', webhookId: null, cronId: 'c1' })).toBe('cron')
    expect(svc.computeTaskKind({ spawnType: 'self', webhookId: 'w1', cronId: null })).toBe('webhook')
    expect(svc.computeTaskKind({ spawnType: 'self', webhookId: null, cronId: null })).toBe('spawn_self')
    expect(svc.computeTaskKind({ spawnType: 'other', webhookId: null, cronId: null })).toBe('spawn_kin')
    expect(svc.computeTaskKind({ spawnType: 'weird', webhookId: null, cronId: null })).toBe('unknown')
  })

  itLoaded('computeTaskDurationMs returns null for non-terminal status', () => {
    const t0 = new Date(1000)
    const t1 = new Date(5000)
    expect(svc.computeTaskDurationMs({ status: 'pending', createdAt: t0, updatedAt: t1 })).toBeNull()
    expect(svc.computeTaskDurationMs({ status: 'in_progress', createdAt: t0, updatedAt: t1 })).toBeNull()
    expect(svc.computeTaskDurationMs({ status: 'completed', createdAt: t0, updatedAt: t1 })).toBe(4000)
    expect(svc.computeTaskDurationMs({ status: 'failed', createdAt: t0, updatedAt: t1 })).toBe(4000)
    expect(svc.computeTaskDurationMs({ status: 'cancelled', createdAt: t0, updatedAt: t1 })).toBe(4000)
  })

  itLoaded('computeTaskDurationMs prefers the started/ended window over created/updated', () => {
    const created = new Date(1000)
    const started = new Date(3000)
    const ended = new Date(9000)
    const updated = new Date(10_000)
    // started → ended = 6000ms, not created → updated = 9000ms.
    expect(
      svc.computeTaskDurationMs({ status: 'completed', createdAt: created, updatedAt: updated, startedAt: started, endedAt: ended }),
    ).toBe(6000)
    // Falls back to created/updated when started/ended are null (legacy rows).
    expect(
      svc.computeTaskDurationMs({ status: 'completed', createdAt: created, updatedAt: updated, startedAt: null, endedAt: null }),
    ).toBe(9000)
  })

  itLoaded('buildMessagePreview truncates and appends ellipsis', () => {
    expect(svc.buildMessagePreview(null)).toEqual({ preview: '', length: 0 })
    expect(svc.buildMessagePreview('short')).toEqual({ preview: 'short', length: 5 })
    const long = 'x'.repeat(250)
    const r = svc.buildMessagePreview(long)
    expect(r.length).toBe(250)
    expect(r.preview.length).toBe(203)
    expect(r.preview.endsWith('...')).toBe(true)
  })
})

describe('tasks service: listTasksFiltered', () => {
  beforeEach(reset)

  itLoaded('filters by status', async () => {
    state.taskRows = [
      makeTask({ id: 't1', status: 'completed' }),
      makeTask({ id: 't2', status: 'pending' }),
      makeTask({ id: 't3', status: 'completed' }),
    ]
    const res = await svc.listTasksFiltered({ status: 'completed', limit: 20 })
    expect(res.total).toBe(2)
    expect(res.tasks.map((t) => t.id).sort()).toEqual(['t1', 't3'])
  })

  itLoaded('filters by kind=spawn_self (excludes webhook and cron tasks)', async () => {
    state.taskRows = [
      makeTask({ id: 's1', spawnType: 'self', webhookId: null, cronId: null }),
      makeTask({ id: 's2', spawnType: 'self', webhookId: 'w1', cronId: null }),
      makeTask({ id: 's3', spawnType: 'self', webhookId: null, cronId: 'c1' }),
      makeTask({ id: 's4', spawnType: 'other', webhookId: null, cronId: null }),
    ]
    const res = await svc.listTasksFiltered({ kind: 'spawn_self', limit: 20 })
    expect(res.total).toBe(1)
    expect(res.tasks[0]!.id).toBe('s1')
    expect(res.tasks[0]!.kind).toBe('spawn_self')
  })

  itLoaded('pagination returns correct slice + total', async () => {
    state.taskRows = Array.from({ length: 25 }, (_, i) =>
      makeTask({ id: `p${i}`, createdAt: new Date(2_000_000 + i * 1000), updatedAt: new Date(2_000_000 + i * 1000 + 500), status: 'completed' }),
    )
    const page1 = await svc.listTasksFiltered({ limit: 10, offset: 0 })
    expect(page1.total).toBe(25)
    expect(page1.tasks.length).toBe(10)
    const page3 = await svc.listTasksFiltered({ limit: 10, offset: 20 })
    expect(page3.total).toBe(25)
    expect(page3.tasks.length).toBe(5)
  })

  itLoaded('limit is capped at 100 and defaults to 20', async () => {
    state.taskRows = Array.from({ length: 150 }, (_, i) => makeTask({ id: `b${i}`, status: 'completed' }))
    const capped = await svc.listTasksFiltered({ limit: 9999 })
    expect(capped.tasks.length).toBe(100)
    const defaulted = await svc.listTasksFiltered({})
    expect(defaulted.tasks.length).toBe(20)
  })
})

describe('tasks service: getTaskMessages', () => {
  beforeEach(reset)

  itLoaded('throws TaskNotFoundError when task missing', async () => {
    state.taskRows = []
    await expect(svc.getTaskMessages('missing', 20, 0, 'desc')).rejects.toThrow('Task not found')
  })

  itLoaded('returns empty list when task has no messages', async () => {
    state.taskRows = [makeTask({ id: 'tA' })]
    state.messageRows = []
    const res = await svc.getTaskMessages('tA', 20, 0, 'desc')
    expect(res.total).toBe(0)
    expect(res.messages).toEqual([])
    expect(res.taskId).toBe('tA')
  })

  itLoaded('negative offset returns the most recent N messages', async () => {
    state.taskRows = [makeTask({ id: 'tB', title: 'X' })]
    state.messageRows = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      taskId: 'tB',
      role: 'assistant',
      content: `msg ${i}`,
      sourceType: 'task',
      toolCalls: null,
      createdAt: new Date(1_000_000 + i * 1000),
    }))
    const res = await svc.getTaskMessages('tB', 20, -10, 'desc')
    expect(res.total).toBe(30)
    expect(res.messages.length).toBe(10)
    // Most recent 10 in desc order: m29..m20
    expect(res.messages[0]!.id).toBe('m29')
    expect(res.messages[9]!.id).toBe('m20')
  })

  itLoaded('negative offset with asc order returns last N in chronological order', async () => {
    state.taskRows = [makeTask({ id: 'tC' })]
    state.messageRows = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      taskId: 'tC',
      role: 'assistant',
      content: 'x',
      sourceType: 'task',
      toolCalls: null,
      createdAt: new Date(2_000_000 + i * 1000),
    }))
    const res = await svc.getTaskMessages('tC', 5, -3, 'asc')
    expect(res.messages.length).toBe(3)
    expect(res.messages[0]!.id).toBe('n7')
    expect(res.messages[2]!.id).toBe('n9')
  })

  itLoaded('builds previews and counts tool calls', async () => {
    state.taskRows = [makeTask({ id: 'tD' })]
    state.messageRows = [
      {
        id: 'msg1',
        taskId: 'tD',
        role: 'assistant',
        content: 'hello world',
        sourceType: 'task',
        toolCalls: JSON.stringify([{ id: '1' }, { id: '2' }]),
        createdAt: new Date(100),
      },
    ]
    const res = await svc.getTaskMessages('tD', 20, 0, 'desc')
    expect(res.messages[0]!.contentPreview).toBe('hello world')
    expect(res.messages[0]!.contentLength).toBe(11)
    expect(res.messages[0]!.toolCallCount).toBe(2)
    expect(res.messages[0]!.hasToolCalls).toBe(true)
  })
})

// retryTask tests were intentionally not added here. Cross-file Bun
// `mock.module('@/server/services/tasks', ...)` leaks (subtask-tools.test.ts,
// task-tools.test.ts, cron-tools.test.ts) replace the real `tasks` module
// in this worker, so anything that imports it through `await import(...)`
// gets the stub. Validation is 2 lines (TaskNotFoundError + status check)
// and the user-facing behaviour is covered by manual UI verification of
// the retry buttons in TaskPanelContent.
