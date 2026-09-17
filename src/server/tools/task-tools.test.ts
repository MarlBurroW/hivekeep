import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockTasks = {
  spawnTask: mock(() => Promise.resolve({ taskId: 'task-123' })),
  respondToTask: mock(() => Promise.resolve(true)),
  cancelTask: mock(() => Promise.resolve(true)),
  listAgentTasks: mock(() => Promise.resolve([] as any[])),
  listSourceAgentTasks: mock(() => Promise.resolve([] as any[])),
  listTasksFiltered: mock(() => Promise.resolve({ tasks: [] as any[], total: 0 })),
  getTaskMessages: mock(() => Promise.resolve({ taskId: '', taskTitle: null as string | null, taskStatus: '', total: 0, messages: [] as any[] })),
  getTask: mock(() => Promise.resolve(null as any)),
  fetchPreviousCronRuns: mock(() => Promise.resolve([] as any[])),
  listAllTasks: mock(() => Promise.resolve([])),
  listTasksPaginated: mock(() => Promise.resolve({ tasks: [], total: 0 })),
  recoverStaleTasks: mock(() => {}),
  resumeSubAgent: mock(() => Promise.resolve()),
  resolveTask: mock(() => Promise.resolve()),
  reportToParent: mock(() => Promise.resolve()),
  updateTaskStatus: mock(() => Promise.resolve()),
  requestInput: mock(() => Promise.resolve()),
  retryTask: mock(() => Promise.resolve({ taskId: 'task-stub', queued: false })),
}

// Error classes live outside `mockTasks` so the `Object.values(mockTasks)
// .forEach(mockReset)` loop in `resetMocks` keeps working — these aren't
// mock functions. They're still merged into the module mock below.
class FakeTaskNotRetryableError extends Error {
  constructor(public status: string) {
    super(`Task status "${status}" is not retryable`)
    this.name = 'TaskNotRetryableError'
  }
}
class FakeTaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task not found: ${id}`)
    this.name = 'TaskNotFoundError'
  }
}
const mockTasksExports = {
  ...mockTasks,
  TaskNotRetryableError: FakeTaskNotRetryableError,
  TaskNotFoundError: FakeTaskNotFoundError,
}

const mockAgentResolver = {
  resolveAgentId: mock(() => null as string | null),
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbChain: any = {
  select: mock(() => mockDbChain),
  from: mock(() => mockDbChain),
  where: mock(() => mockDbChain),
  orderBy: mock(() => mockDbChain),
  all: mock(() => Promise.resolve([])),
  get: mock(() => Promise.resolve(null)),
}

mock.module('@/server/services/tasks', () => mockTasksExports)
mock.module('@/server/services/agent-resolver', () => mockAgentResolver)
mock.module('@/server/db/index', () => ({ db: mockDbChain }))
mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  agents: { id: 'id', slug: 'slug', name: 'name' },
  messages: { role: 'role', content: 'content', sourceType: 'sourceType', createdAt: 'createdAt', agentId: 'agentId', taskId: 'taskId' },
}))
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))
mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  asc: (col: unknown) => col,
  inArray: (...args: unknown[]) => args,
}))

// Import after mocks (may fail if Bun mock.module() poisoned exports of
// @/server/services/tasks from a previous test file in the same process — see
// Missing mock exports fail the isolated suite instead of hiding coverage.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let spawnSelfTool: any, spawnAgentTool: any, respondToTaskTool: any, cancelTaskTool: any,
  listTasksTool: any, listActiveQueuesTool: any, getTaskDetailTool: any,
  getTaskMessagesTool: any
let _mocksWorking = false
try {
  const mod = await import('@/server/tools/task-tools')
  spawnSelfTool = mod.spawnSelfTool
  spawnAgentTool = mod.spawnAgentTool
  respondToTaskTool = mod.respondToTaskTool
  cancelTaskTool = mod.cancelTaskTool
  listTasksTool = mod.listTasksTool
  listActiveQueuesTool = mod.listActiveQueuesTool
  getTaskDetailTool = mod.getTaskDetailTool
  getTaskMessagesTool = mod.getTaskMessagesTool
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

if (!_mocksWorking) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const itMocked = it

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = { agentId: 'agent-abc', isSubAgent: false }

function execute(registration: any, args: any) {
  const t = registration.create(ctx)
  return t.execute(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

function resetMocks() {
  Object.values(mockTasks).forEach((m) => m.mockReset())
  Object.values(mockAgentResolver).forEach((m) => m.mockReset())
  mockDbChain.select.mockReturnValue(mockDbChain)
  mockDbChain.from.mockReturnValue(mockDbChain)
  mockDbChain.where.mockReturnValue(mockDbChain)
  mockDbChain.orderBy.mockReturnValue(mockDbChain)
  mockDbChain.all.mockReset()
  mockDbChain.get.mockReset()
  // Default: return empty arrays/null
  mockDbChain.all.mockResolvedValue([])
  mockDbChain.get.mockResolvedValue(null)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('task-tools', () => {
  beforeEach(resetMocks)

  // ── Availability ──────────────────────────────────────────────────────────

  describe('availability', () => {
    itMocked('spawn and query tools are available to main and sub-agent', () => {
      const subAgentTools = [spawnSelfTool, spawnAgentTool, listTasksTool, listActiveQueuesTool, getTaskDetailTool]
      for (const t of subAgentTools) {
        expect(t.availability).toEqual(['main', 'sub-agent'])
      }
    })

    itMocked('respond and cancel tools are main-only', () => {
      const mainOnlyTools = [respondToTaskTool, cancelTaskTool]
      for (const t of mainOnlyTools) {
        expect(t.availability).toEqual(['main'])
      }
    })
  })

  // ── spawnSelfTool ─────────────────────────────────────────────────────────

  describe('spawnSelfTool', () => {
    itMocked('spawns a self task with correct params', async () => {
      mockTasks.spawnTask.mockResolvedValue({ taskId: 'task-456' })

      const result = await execute(spawnSelfTool, {
        title: 'Research topic',
        task_description: 'Research quantum computing',
        mode: 'await',
      })

      expect(result).toEqual({ taskId: 'task-456', status: 'pending' })
      expect(mockTasks.spawnTask).toHaveBeenCalledTimes(1)
      expect(mockTasks.spawnTask).toHaveBeenCalledWith({
        parentAgentId: 'agent-abc',
        title: 'Research topic',
        description: 'Research quantum computing',
        mode: 'await',
        spawnType: 'self',
        model: undefined,
        allowHumanPrompt: undefined,
      })
    })

    itMocked('passes optional model parameter (with required provider_id)', async () => {
      mockTasks.spawnTask.mockResolvedValue({ taskId: 'task-789' })

      await execute(spawnSelfTool, {
        title: 'Task',
        task_description: 'Do something',
        mode: 'async',
        model: 'gpt-4o',
        provider_id: 'prov-uuid-1',
      })

      expect(mockTasks.spawnTask).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o', providerId: 'prov-uuid-1', mode: 'async' }),
      )
    })

    itMocked('throws when model is set without provider_id', async () => {
      await expect(execute(spawnSelfTool, {
        title: 'Task',
        task_description: 'Do something',
        mode: 'async',
        model: 'gpt-4o',
      })).rejects.toThrow(/provider_id/)
    })

    itMocked('passes allow_human_prompt parameter', async () => {
      mockTasks.spawnTask.mockResolvedValue({ taskId: 'task-x' })

      await execute(spawnSelfTool, {
        title: 'Task',
        task_description: 'Do it',
        mode: 'await',
        allow_human_prompt: false,
      })

      expect(mockTasks.spawnTask).toHaveBeenCalledWith(
        expect.objectContaining({ allowHumanPrompt: false }),
      )
    })
  })

  // ── spawnAgentTool ──────────────────────────────────────────────────────────

  describe('spawnAgentTool', () => {
    itMocked('returns error when agent slug not found', async () => {
      mockAgentResolver.resolveAgentId.mockReturnValue(null)

      const result = await execute(spawnAgentTool, {
        agent_slug: 'nonexistent',
        title: 'Task',
        task_description: 'Do something',
        mode: 'await',
      })

      expect(result).toEqual({ error: 'Agent not found for slug "nonexistent"' })
      expect(mockTasks.spawnTask).not.toHaveBeenCalled()
    })

    itMocked('spawns task when agent slug resolves', async () => {
      mockAgentResolver.resolveAgentId.mockReturnValue('agent-target-123')
      mockTasks.spawnTask.mockResolvedValue({ taskId: 'task-new' })

      const result = await execute(spawnAgentTool, {
        agent_slug: 'researcher-ai',
        title: 'Research',
        task_description: 'Find papers',
        mode: 'async',
      })

      expect(result).toEqual({ taskId: 'task-new', status: 'pending' })
      expect(mockTasks.spawnTask).toHaveBeenCalledWith(
        expect.objectContaining({
          parentAgentId: 'agent-abc',
          spawnType: 'other',
          sourceAgentId: 'agent-target-123',
        }),
      )
    })

    itMocked('passes optional model to spawned agent', async () => {
      mockAgentResolver.resolveAgentId.mockReturnValue('agent-target')
      mockTasks.spawnTask.mockResolvedValue({ taskId: 'task-m' })

      await execute(spawnAgentTool, {
        agent_slug: 'helper',
        title: 'Help',
        task_description: 'Help me',
        mode: 'await',
        model: 'claude-sonnet',
        provider_id: 'prov-uuid-2',
      })

      expect(mockTasks.spawnTask).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-sonnet', providerId: 'prov-uuid-2' }),
      )
    })

    itMocked('returns error when model is set without provider_id', async () => {
      const result = await execute(spawnAgentTool, {
        agent_slug: 'helper',
        title: 'Help',
        task_description: 'Help me',
        mode: 'await',
        model: 'claude-sonnet',
      })
      expect((result as { error?: string }).error).toMatch(/provider_id/)
    })
  })

  // ── respondToTaskTool ─────────────────────────────────────────────────────

  describe('respondToTaskTool', () => {
    itMocked('responds successfully to a task', async () => {
      mockTasks.respondToTask.mockResolvedValue(true)

      const result = await execute(respondToTaskTool, {
        task_id: 'task-1',
        answer: 'The answer is 42',
      })

      expect(result).toEqual({ success: true })
      expect(mockTasks.respondToTask).toHaveBeenCalledWith('task-1', 'The answer is 42')
    })

    itMocked('returns error when task not found or inactive', async () => {
      mockTasks.respondToTask.mockResolvedValue(false)

      const result = await execute(respondToTaskTool, {
        task_id: 'task-missing',
        answer: 'response',
      })

      expect(result).toEqual({ error: 'Task not found or not active' })
    })
  })

  // ── cancelTaskTool ────────────────────────────────────────────────────────

  describe('cancelTaskTool', () => {
    itMocked('cancels a task successfully', async () => {
      mockTasks.cancelTask.mockResolvedValue(true)

      const result = await execute(cancelTaskTool, { task_id: 'task-cancel' })

      expect(result).toEqual({ success: true })
      expect(mockTasks.cancelTask).toHaveBeenCalledWith('task-cancel', 'agent-abc')
    })

    itMocked('returns error when task cannot be cancelled', async () => {
      mockTasks.cancelTask.mockResolvedValue(false)

      const result = await execute(cancelTaskTool, { task_id: 'task-done' })

      expect(result).toEqual({ error: 'Task not found, not owned by you, or already finished' })
    })
  })

  // ── listTasksTool ─────────────────────────────────────────────────────────

  describe('listTasksTool', () => {
    itMocked('returns empty list with pagination when no tasks', async () => {
      mockTasks.listTasksFiltered.mockResolvedValue({ tasks: [], total: 0 })

      const result = await execute(listTasksTool, { limit: 20, offset: 0 })

      expect(result).toEqual({
        tasks: [],
        pagination: { total: 0, offset: 0, limit: 20, hasMore: false },
      })
    })

    itMocked('returns lightweight summaries (no description/result/error)', async () => {
      mockTasks.listTasksFiltered.mockResolvedValue({
        tasks: [
          {
            id: 'task-1',
            title: 'Research',
            status: 'completed',
            kind: 'spawn_self',
            parentAgentSlug: 'me',
            childAgentSlug: null,
            depth: 0,
            createdAt: 1735689600000,
            updatedAt: 1735776000000,
            durationMs: 86_400_000,
          },
        ],
        total: 1,
      })

      const result = await execute(listTasksTool, { limit: 20, offset: 0 })

      expect(result.tasks).toHaveLength(1)
      expect(result.tasks[0].id).toBe('task-1')
      expect(result.tasks[0].kind).toBe('spawn_self')
      expect(result.tasks[0].duration_ms).toBe(86_400_000)
      // Lightweight payload: no description, result, error, messages
      expect(result.tasks[0]).not.toHaveProperty('description')
      expect(result.tasks[0]).not.toHaveProperty('result')
      expect(result.tasks[0]).not.toHaveProperty('error')
      expect(result.pagination).toEqual({ total: 1, offset: 0, limit: 20, hasMore: false })
    })

    itMocked('passes filters through to listTasksFiltered', async () => {
      mockTasks.listTasksFiltered.mockResolvedValue({ tasks: [], total: 0 })

      await execute(listTasksTool, {
        status: 'completed',
        kind: 'spawn_self',
        limit: 10,
        offset: 5,
      })

      expect(mockTasks.listTasksFiltered).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          kind: 'spawn_self',
          limit: 10,
          offset: 5,
          relatedToAgentId: 'agent-abc',
        }),
      )
    })

    itMocked('computes hasMore correctly', async () => {
      mockTasks.listTasksFiltered.mockResolvedValue({
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: `t${i}`,
          title: 't',
          status: 'completed',
          kind: 'spawn_self' as const,
          parentAgentSlug: 'me',
          childAgentSlug: null,
          depth: 0,
          createdAt: 100,
          updatedAt: 200,
          durationMs: 100,
        })),
        total: 25,
      })

      const result = await execute(listTasksTool, { limit: 10, offset: 0 })

      expect(result.pagination.hasMore).toBe(true)
      expect(result.pagination.total).toBe(25)
    })

  })

  // ── getTaskDetailTool ─────────────────────────────────────────────────────

  describe('getTaskDetailTool', () => {
    itMocked('returns error when task not found', async () => {
      mockTasks.getTask.mockResolvedValue(null)

      const result = await execute(getTaskDetailTool, { task_id: 'task-missing' })

      expect(result).toEqual({ error: 'Task not found' })
    })

    itMocked('returns error when agent has no access', async () => {
      mockTasks.getTask.mockResolvedValue({
        id: 'task-private',
        parentAgentId: 'agent-other',
        sourceAgentId: 'agent-another',
      })

      const result = await execute(getTaskDetailTool, { task_id: 'task-private' })

      expect(result).toEqual({ error: 'Access denied — you are not related to this task' })
    })

    itMocked('allows access as parent agent', async () => {
      mockTasks.getTask.mockResolvedValue({
        id: 'task-mine',
        title: 'My task',
        description: 'Details',
        status: 'completed',
        mode: 'await',
        spawnType: 'self',
        parentAgentId: 'agent-abc',
        sourceAgentId: null,
        result: 'Done!',
        error: null,
        depth: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      })
      mockDbChain.all.mockResolvedValue([
        { role: 'user', content: 'hello', sourceType: 'task', createdAt: new Date('2026-01-01') },
      ])

      const result = await execute(getTaskDetailTool, { task_id: 'task-mine' })

      expect(result.task.id).toBe('task-mine')
      expect(result.task.title).toBe('My task')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0].role).toBe('user')
    })

    itMocked('allows access as source agent', async () => {
      mockTasks.getTask.mockResolvedValue({
        id: 'task-assigned',
        title: 'Assigned',
        description: 'Work',
        status: 'pending',
        mode: 'await',
        spawnType: 'other',
        parentAgentId: 'agent-boss',
        sourceAgentId: 'agent-abc',
        result: null,
        error: null,
        depth: 1,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      })
      mockDbChain.all.mockResolvedValue([])

      const result = await execute(getTaskDetailTool, { task_id: 'task-assigned' })

      expect(result.task.id).toBe('task-assigned')
      expect(result.messages).toEqual([])
    })
  })

  // ── getTaskMessagesTool ───────────────────────────────────────────────────

  describe('getTaskMessagesTool', () => {
    itMocked('availability and flags', () => {
      expect(getTaskMessagesTool.availability).toEqual(['main', 'sub-agent'])
      expect(getTaskMessagesTool.readOnly).toBe(true)
      expect(getTaskMessagesTool.concurrencySafe).toBe(true)
    })

    itMocked('returns access denied when caller is not related to the task', async () => {
      mockTasks.getTask.mockResolvedValue({
        id: 'task-x',
        parentAgentId: 'agent-other',
        sourceAgentId: 'agent-another',
      })

      const result = await execute(getTaskMessagesTool, {
        task_id: 'task-x',
        limit: 20,
        offset: 0,
        order: 'desc',
      })

      expect(result).toEqual({ error: 'Access denied — you are not related to this task' })
    })

    itMocked('returns paginated previews when caller is parent', async () => {
      mockTasks.getTask.mockResolvedValue({
        id: 'task-y',
        parentAgentId: 'agent-abc',
        sourceAgentId: null,
      })
      mockTasks.getTaskMessages.mockResolvedValue({
        taskId: 'task-y',
        taskTitle: 'Y',
        taskStatus: 'completed',
        total: 30,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            sourceType: 'task',
            createdAt: 1000,
            contentPreview: 'hello',
            contentLength: 5,
            hasToolCalls: false,
            toolCallCount: 0,
          },
        ],
      })

      const result = await execute(getTaskMessagesTool, {
        task_id: 'task-y',
        limit: 20,
        offset: 0,
        order: 'desc',
      })

      expect(result.task_id).toBe('task-y')
      expect(result.task_status).toBe('completed')
      expect(result.messages).toHaveLength(1)
      expect(result.messages[0]).toEqual({
        id: 'm1',
        role: 'assistant',
        source_type: 'task',
        created_at: 1000,
        content_preview: 'hello',
        content_length: 5,
        has_tool_calls: false,
        tool_call_count: 0,
      })
      expect(result.pagination).toEqual({ total: 30, offset: 0, limit: 20, hasMore: true })
    })
  })
})
