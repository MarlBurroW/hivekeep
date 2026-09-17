import { describe, it, expect, beforeEach, mock } from 'bun:test'

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const sseSent: Array<{ agentId: string; event: { type: string; data: Record<string, unknown> } }> = []
mock.module('@/server/sse/index', () => ({
  sseManager: {
    sendToAgent: (agentId: string, event: { type: string; data: Record<string, unknown> }) => {
      sseSent.push({ agentId, event })
    },
    broadcast: () => {},
  },
}))

const { setTodosForTask, getTodosForTask, forgetTaskTodos, _resetAllTodos } = await import('./task-todos')

const META = { parentAgentId: 'agent-1' }

beforeEach(() => {
  _resetAllTodos()
  sseSent.length = 0
})

describe('setTodosForTask', () => {
  it('persists the list and returns it normalised', () => {
    const stored = setTodosForTask(
      'task-1',
      [{ id: 'a', subject: '  do the thing  ', status: 'pending' }],
      META,
    )
    expect(stored).toEqual([{ id: 'a', subject: 'do the thing', status: 'pending' }])
    expect(getTodosForTask('task-1')).toEqual(stored)
  })

  it('broadcasts a task:todos SSE event to the parent Agent', () => {
    setTodosForTask(
      'task-1',
      [{ id: 'a', subject: 'do', status: 'pending' }],
      META,
    )
    expect(sseSent).toHaveLength(1)
    expect(sseSent[0]?.agentId).toBe('agent-1')
    expect(sseSent[0]?.event.type).toBe('task:todos')
    expect(sseSent[0]?.event.data).toMatchObject({
      taskId: 'task-1',
      todos: [{ id: 'a', subject: 'do', status: 'pending' }],
    })
  })

  it('replaces the previous list (bulk-set semantics)', () => {
    setTodosForTask('task-1', [{ id: 'a', subject: 'a', status: 'pending' }], META)
    setTodosForTask('task-1', [{ id: 'b', subject: 'b', status: 'pending' }], META)
    expect(getTodosForTask('task-1')).toEqual([{ id: 'b', subject: 'b', status: 'pending' }])
  })

  it('rejects more than one in_progress', () => {
    expect(() =>
      setTodosForTask(
        'task-1',
        [
          { id: 'a', subject: 'a', status: 'in_progress' },
          { id: 'b', subject: 'b', status: 'in_progress' },
        ],
        META,
      ),
    ).toThrow(/at most one/i)
  })

  it('rejects more than 30 items', () => {
    const many = Array.from({ length: 31 }, (_, i) => ({
      id: `t-${i}`,
      subject: `item ${i}`,
      status: 'pending' as const,
    }))
    expect(() => setTodosForTask('task-1', many, META)).toThrow(/at most 30/i)
  })

  it('rejects duplicate ids', () => {
    expect(() =>
      setTodosForTask(
        'task-1',
        [
          { id: 'a', subject: 'a', status: 'pending' },
          { id: 'a', subject: 'a-bis', status: 'pending' },
        ],
        META,
      ),
    ).toThrow(/duplicate todo id/i)
  })

  it('rejects empty subject', () => {
    expect(() =>
      setTodosForTask(
        'task-1',
        [{ id: 'a', subject: '   ', status: 'pending' }],
        META,
      ),
    ).toThrow(/non-empty/i)
  })

  it('isolates per task', () => {
    setTodosForTask('task-1', [{ id: 'a', subject: 'a', status: 'pending' }], META)
    setTodosForTask('task-2', [{ id: 'b', subject: 'b', status: 'pending' }], META)
    expect(getTodosForTask('task-1').map((t) => t.id)).toEqual(['a'])
    expect(getTodosForTask('task-2').map((t) => t.id)).toEqual(['b'])
  })

  it('allows zero todos (clearing the plan)', () => {
    setTodosForTask('task-1', [{ id: 'a', subject: 'a', status: 'pending' }], META)
    setTodosForTask('task-1', [], META)
    expect(getTodosForTask('task-1')).toEqual([])
  })
})

describe('forgetTaskTodos', () => {
  it('clears state so subsequent reads return []', () => {
    setTodosForTask('task-1', [{ id: 'a', subject: 'a', status: 'pending' }], META)
    forgetTaskTodos('task-1')
    expect(getTodosForTask('task-1')).toEqual([])
  })

  it('does not touch other tasks', () => {
    setTodosForTask('task-1', [{ id: 'a', subject: 'a', status: 'pending' }], META)
    setTodosForTask('task-2', [{ id: 'b', subject: 'b', status: 'pending' }], META)
    forgetTaskTodos('task-1')
    expect(getTodosForTask('task-2').map((t) => t.id)).toEqual(['b'])
  })
})
