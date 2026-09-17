import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'
import { fullMockSchema, fullMockDrizzleOrm, fullMockDbIndex } from '../../test-helpers'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockDb = {
  select: mock(() => mockDb),
  from: mock(() => mockDb),
  where: mock(() => mockDb),
  get: mock(() => null as any),
}

const mockHumanPrompts = {
  createHumanPrompt: mock(() => Promise.resolve({ promptId: 'prompt-1' })),
}

mock.module('@/server/db/index', () => ({ ...fullMockDbIndex, db: mockDb }))
mock.module('@/server/db/schema', () => ({ ...fullMockSchema, tasks: {} }))
mock.module('drizzle-orm', () => ({ ...fullMockDrizzleOrm, eq: (...args: any[]) => args }))
mock.module('@/server/services/human-prompts', () => mockHumanPrompts)
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

// ─── Import after mocks ─────────────────────────────────────────────────────

const { promptHumanTool } = await import('@/server/tools/human-prompt-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const baseCtx: ToolExecutionContext = { agentId: 'agent-test', isSubAgent: false }

function execute(ctx: ToolExecutionContext, args: any) {
  const t = (promptHumanTool as any).create(ctx)
  return t.execute(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

const validArgs = {
  prompt_type: 'confirm' as const,
  question: 'Do you want to proceed?',
  options: [
    { label: 'Yes', value: 'yes' },
    { label: 'No', value: 'no' },
  ],
}

function resetMocks() {
  Object.values(mockDb).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) (m as any).mockReset()
  })
  // Re-chain mockDb fluent API
  mockDb.select.mockReturnValue(mockDb as any)
  mockDb.from.mockReturnValue(mockDb as any)
  mockDb.where.mockReturnValue(mockDb as any)
  mockDb.get.mockReturnValue(null)

  mockHumanPrompts.createHumanPrompt.mockReset()
  mockHumanPrompts.createHumanPrompt.mockReturnValue(Promise.resolve({ promptId: 'prompt-1' }))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('promptHumanTool', () => {
  beforeEach(resetMocks)

  it('rejects private sessions before creating a shared prompt or looking up tasks', async () => {
    const result = await execute({ ...baseCtx, sessionId: 'private-session' }, validArgs)
    expect(result.error).toContain('private sessions')
    expect(mockHumanPrompts.createHumanPrompt).not.toHaveBeenCalled()
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  describe('registration', () => {
    it('is available to main and sub-agent', () => {
      expect(promptHumanTool.availability).toEqual(['main', 'sub-agent'])
    })

    it('create() returns a tool with description and execute', () => {
      const t = promptHumanTool.create(baseCtx)
      expect(typeof t.description).toBe('string')
      expect(t.description!.length).toBeGreaterThan(0)
      expect(typeof t.execute).toBe('function')
    })
  })

  describe('main context (no taskId)', () => {
    it('creates a human prompt and returns promptId', async () => {
      const result = await execute(baseCtx, validArgs)
      expect(result).toEqual({
        promptId: 'prompt-1',
        status: 'pending',
        message: expect.stringContaining('prompted'),
      })
      expect(mockHumanPrompts.createHumanPrompt).toHaveBeenCalledTimes(1)
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.agentId).toBe('agent-test')
      expect(call.promptType).toBe('confirm')
      expect(call.question).toBe('Do you want to proceed?')
      expect(call.options).toHaveLength(2)
    })

    it('passes description when provided', async () => {
      await execute(baseCtx, { ...validArgs, description: 'Some context here' })
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.description).toBe('Some context here')
    })

    it('passes taskId as undefined when no taskId in context', async () => {
      await execute(baseCtx, validArgs)
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.taskId).toBeUndefined()
    })

    it('supports select prompt type', async () => {
      const args = {
        prompt_type: 'select' as const,
        question: 'Pick one',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
          { label: 'C', value: 'c' },
        ],
      }
      await execute(baseCtx, args)
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.promptType).toBe('select')
      expect(call.options).toHaveLength(3)
    })

    it('supports multi_select prompt type', async () => {
      const args = {
        prompt_type: 'multi_select' as const,
        question: 'Pick several',
        options: [
          { label: 'X', value: 'x' },
          { label: 'Y', value: 'y' },
        ],
      }
      await execute(baseCtx, args)
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.promptType).toBe('multi_select')
    })

    it('passes option variants when provided', async () => {
      const args = {
        ...validArgs,
        options: [
          { label: 'Delete', value: 'delete', variant: 'destructive' as const, description: 'Permanently remove' },
          { label: 'Cancel', value: 'cancel', variant: 'default' as const },
        ],
      }
      await execute(baseCtx, args)
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.options[0].variant).toBe('destructive')
      expect(call.options[0].description).toBe('Permanently remove')
      expect(call.options[1].variant).toBe('default')
    })
  })

  describe('rate limiting', () => {
    it('blocks second prompt_human call on the same tool instance (same turn)', async () => {
      const t = (promptHumanTool as any).create(baseCtx)
      const callOpts = { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal }

      const first = await t.execute(validArgs, callOpts)
      expect(first.promptId).toBe('prompt-1')

      const second = await t.execute(validArgs, callOpts)
      expect(second.error).toContain('already prompted')
      expect(mockHumanPrompts.createHumanPrompt).toHaveBeenCalledTimes(1)
    })

    it('allows prompt_human on a new tool instance (new turn)', async () => {
      const t1 = (promptHumanTool as any).create(baseCtx)
      const t2 = (promptHumanTool as any).create(baseCtx)
      const callOpts = { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal }

      const first = await t1.execute(validArgs, callOpts)
      expect(first.promptId).toBe('prompt-1')

      const second = await t2.execute(validArgs, callOpts)
      expect(second.promptId).toBe('prompt-1')
      expect(mockHumanPrompts.createHumanPrompt).toHaveBeenCalledTimes(2)
    })
  })

  describe('sub-agent context (with taskId)', () => {
    const subCtx: ToolExecutionContext = { agentId: 'agent-sub', isSubAgent: true, taskId: 'task-1' }

    it('returns error when task is not found', async () => {
      mockDb.get.mockReturnValue(null)
      const result = await execute(subCtx, validArgs)
      expect(result).toEqual({ error: 'Task not found' })
      expect(mockHumanPrompts.createHumanPrompt).not.toHaveBeenCalled()
    })

    it('returns error when task is cron-triggered', async () => {
      mockDb.get.mockReturnValue({ id: 'task-1', cronId: 'cron-abc', allowHumanPrompt: true })
      const result = await execute(subCtx, validArgs)
      expect(result).toEqual({ error: 'prompt_human is not available in cron-triggered tasks' })
      expect(mockHumanPrompts.createHumanPrompt).not.toHaveBeenCalled()
    })

    it('returns error when allowHumanPrompt is false', async () => {
      mockDb.get.mockReturnValue({ id: 'task-1', cronId: null, allowHumanPrompt: false })
      const result = await execute(subCtx, validArgs)
      expect(result).toEqual({ error: 'Human prompts are disabled for this task by the parent' })
      expect(mockHumanPrompts.createHumanPrompt).not.toHaveBeenCalled()
    })

    it('succeeds when task allows human prompts', async () => {
      mockDb.get.mockReturnValue({ id: 'task-1', cronId: null, allowHumanPrompt: true })
      const result = await execute(subCtx, validArgs)
      expect(result).toEqual({
        promptId: 'prompt-1',
        status: 'pending',
        message: expect.stringContaining('prompted'),
      })
      expect(mockHumanPrompts.createHumanPrompt).toHaveBeenCalledTimes(1)
      const call = (mockHumanPrompts.createHumanPrompt as any).mock.calls[0][0]
      expect(call.taskId).toBe('task-1')
    })

    it('succeeds when task has no cronId (user-spawned sub-agent)', async () => {
      mockDb.get.mockReturnValue({ id: 'task-1', cronId: null, allowHumanPrompt: true })
      const result = await execute(subCtx, validArgs)
      expect(result.promptId).toBe('prompt-1')
    })
  })
})
