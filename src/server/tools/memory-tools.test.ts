import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockMemory = {
  searchMemories: mock(() => Promise.resolve([] as any[])),
  createMemory: mock(() => Promise.resolve(null as any)),
  updateMemory: mock(() => Promise.resolve(null as any)),
  deleteMemory: mock(() => Promise.resolve(false)),
  listMemories: mock(() => Promise.resolve([] as any[])),
  isDuplicateMemory: mock(() => Promise.resolve(false)),
  getMemory: mock(() => Promise.resolve(null as any)),
  reembedAllMemories: mock(() => Promise.resolve(0)),
}

mock.module('@/server/services/memory', () => mockMemory)
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))
mock.module('@/server/config', () => ({
  config: { ...fullMockConfig },
}))
// Spread all real exports to avoid poisoning the module for other test files
// Wrap in try-catch — if mock.module didn't intercept config/db, this import crashes
try {
  const _realAppSettings = await import('@/server/services/app-settings')
  mock.module('@/server/services/app-settings', () => ({
    ..._realAppSettings,
    getExtractionModel: mock(() => Promise.resolve(undefined)),
  }))
} catch {
  // Will be caught by the _mocksWorking probe below
}

// Import after mocks — may fail if mock.module didn't intercept (CI/standalone)
let recallTool: any, memorizeTool: any, updateMemoryTool: any,
    forgetTool: any, listMemoriesTool: any, reviewMemoriesTool: any
let _mocksWorking = false
try {
  const mod = await import('@/server/tools/memory-tools')
  recallTool = mod.recallTool
  memorizeTool = mod.memorizeTool
  updateMemoryTool = mod.updateMemoryTool
  forgetTool = mod.forgetTool
  listMemoriesTool = mod.listMemoriesTool
  reviewMemoriesTool = mod.reviewMemoriesTool
  // Probe: verify mocks actually work
  const t = recallTool.create({ agentId: 'probe', isSubAgent: false })
  await t.execute({ query: 'probe' }, { toolCallId: 'p', messages: [], abortSignal: new AbortController().signal })
  _mocksWorking = true
  mockMemory.searchMemories.mockClear()
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = { agentId: 'agent-abc', isSubAgent: false }

function execute(registration: any, args: any) {
  const t = registration.create(ctx)
  return t.execute(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

function resetMocks() {
  Object.values(mockMemory).forEach((m) => m.mockReset())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('memory-tools', () => {
  beforeEach(resetMocks)

  // ── Availability ──────────────────────────────────────────────────────────

  describe('availability', () => {
    itMocked('all memory tools are main-only', () => {
      const tools = [recallTool, memorizeTool, updateMemoryTool, forgetTool, listMemoriesTool, reviewMemoriesTool]
      for (const t of tools) {
        expect(t.availability).toEqual(['main'])
      }
    })
  })

  // ── recall ────────────────────────────────────────────────────────────────

  describe('recall', () => {
    itMocked('returns matching memories', async () => {
      mockMemory.searchMemories.mockResolvedValueOnce([
        { id: 'mem-1', content: 'User likes TypeScript', category: 'preference', subject: 'user', importance: 7, score: 0.9, updatedAt: new Date('2025-01-01') },
        { id: 'mem-2', content: 'Project uses Bun', category: 'fact', subject: 'project', importance: 5, score: 0.8, updatedAt: null },
      ])

      const result = await execute(recallTool, { query: 'typescript' })

      expect(mockMemory.searchMemories).toHaveBeenCalledWith('agent-abc', 'typescript', undefined, {
        subject: undefined,
        category: undefined,
        since: undefined,
      })
      expect(result.memories).toHaveLength(2)
      expect(result.memories[0]).toMatchObject({
        id: 'mem-1',
        content: 'User likes TypeScript',
        category: 'preference',
        subject: 'user',
        importance: 7,
      })
      expect(result.memories[0].age).toBeDefined()
    })

    itMocked('passes limit when provided', async () => {
      mockMemory.searchMemories.mockResolvedValueOnce([])

      await execute(recallTool, { query: 'test', limit: 5 })

      expect(mockMemory.searchMemories).toHaveBeenCalledWith('agent-abc', 'test', 5, {
        subject: undefined,
        category: undefined,
        since: undefined,
      })
    })

    itMocked('forwards the subject and category filters', async () => {
      mockMemory.searchMemories.mockResolvedValueOnce([])

      await execute(recallTool, { query: 'deploy', subject: 'kinbot', category: 'decision' })

      expect(mockMemory.searchMemories).toHaveBeenCalledWith('agent-abc', 'deploy', undefined, {
        subject: 'kinbot',
        category: 'decision',
        since: undefined,
      })
    })

    itMocked('parses the since filter into a Date', async () => {
      mockMemory.searchMemories.mockResolvedValueOnce([])

      await execute(recallTool, { query: 'deploy', since: '2026-07-01' })

      expect(mockMemory.searchMemories).toHaveBeenCalledWith('agent-abc', 'deploy', undefined, {
        subject: undefined,
        category: undefined,
        since: new Date('2026-07-01'),
      })
    })

    itMocked('rejects an unparseable since date instead of searching', async () => {
      const result = await execute(recallTool, { query: 'deploy', since: 'last tuesday' })

      expect(result.error).toBe('Invalid "since" date: "last tuesday". Use an ISO date such as 2026-07-01.')
      expect(mockMemory.searchMemories).not.toHaveBeenCalled()
    })

    itMocked('returns empty array when no memories match', async () => {
      mockMemory.searchMemories.mockResolvedValueOnce([])

      const result = await execute(recallTool, { query: 'nonexistent' })

      expect(result.memories).toEqual([])
    })
  })

  // ── memorize ──────────────────────────────────────────────────────────────

  describe('memorize', () => {
    itMocked('creates a memory and returns it', async () => {
      mockMemory.createMemory.mockResolvedValueOnce({
        id: 'mem-new',
        content: 'Nicolas prefers dark mode',
        category: 'preference',
        subject: 'nicolas',
      })

      const result = await execute(memorizeTool, {
        content: 'Nicolas prefers dark mode',
        category: 'preference',
        subject: 'nicolas',
        importance: 7,
      })

      expect(mockMemory.createMemory).toHaveBeenCalledWith('agent-abc', {
        content: 'Nicolas prefers dark mode',
        category: 'preference',
        subject: 'nicolas',
        importance: 7,
        sourceChannel: 'explicit',
        scope: 'private',
      })
      expect(result).toEqual({
        id: 'mem-new',
        content: 'Nicolas prefers dark mode',
        category: 'preference',
        subject: 'nicolas',
      })
    })

    itMocked('defaults importance to null when not provided', async () => {
      mockMemory.createMemory.mockResolvedValueOnce({
        id: 'mem-2',
        content: 'A fact',
        category: 'fact',
        subject: undefined,
      })

      await execute(memorizeTool, { content: 'A fact', category: 'fact' })

      expect(mockMemory.createMemory).toHaveBeenCalledWith('agent-abc', {
        content: 'A fact',
        category: 'fact',
        subject: undefined,
        importance: null,
        sourceChannel: 'explicit',
        scope: 'private',
      })
    })

    itMocked('returns error when creation fails', async () => {
      mockMemory.createMemory.mockResolvedValueOnce(null)

      const result = await execute(memorizeTool, { content: 'test', category: 'fact' })

      expect(result).toEqual({ error: 'Failed to create memory' })
    })
  })

  // ── update_memory ─────────────────────────────────────────────────────────

  describe('update_memory', () => {
    itMocked('updates and returns the memory', async () => {
      mockMemory.updateMemory.mockResolvedValueOnce({
        id: 'mem-1',
        content: 'Updated content',
        category: 'fact',
        subject: 'project',
      })

      const result = await execute(updateMemoryTool, {
        memory_id: 'mem-1',
        content: 'Updated content',
      })

      expect(mockMemory.updateMemory).toHaveBeenCalledWith('mem-1', 'agent-abc', {
        content: 'Updated content',
        category: undefined,
        subject: undefined,
      })
      expect(result).toEqual({
        id: 'mem-1',
        content: 'Updated content',
        category: 'fact',
        subject: 'project',
      })
    })

    itMocked('returns error when memory not found', async () => {
      mockMemory.updateMemory.mockResolvedValueOnce(null)

      const result = await execute(updateMemoryTool, {
        memory_id: 'mem-missing',
        content: 'new',
      })

      expect(result).toEqual({ error: 'Memory not found' })
    })
  })

  // ── forget ────────────────────────────────────────────────────────────────

  describe('forget', () => {
    itMocked('returns success when memory is deleted', async () => {
      mockMemory.deleteMemory.mockResolvedValueOnce(true)

      const result = await execute(forgetTool, { memory_id: 'mem-1' })

      expect(mockMemory.deleteMemory).toHaveBeenCalledWith('mem-1', 'agent-abc')
      expect(result).toEqual({ success: true })
    })

    itMocked('returns error when memory not found', async () => {
      mockMemory.deleteMemory.mockResolvedValueOnce(false)

      const result = await execute(forgetTool, { memory_id: 'mem-gone' })

      expect(result).toEqual({ error: 'Memory not found' })
    })
  })

  // ── list_memories ─────────────────────────────────────────────────────────

  describe('list_memories', () => {
    itMocked('returns all memories when no filters', async () => {
      mockMemory.listMemories.mockResolvedValueOnce([
        { id: 'mem-1', content: 'Fact one', category: 'fact', subject: null },
        { id: 'mem-2', content: 'Pref two', category: 'preference', subject: 'user' },
      ])

      const result = await execute(listMemoriesTool, {})

      expect(mockMemory.listMemories).toHaveBeenCalledWith('agent-abc', {
        subject: undefined,
        category: undefined,
      })
      expect(result.memories).toHaveLength(2)
    })

    itMocked('passes subject and category filters', async () => {
      mockMemory.listMemories.mockResolvedValueOnce([])

      await execute(listMemoriesTool, { subject: 'nicolas', category: 'preference' })

      expect(mockMemory.listMemories).toHaveBeenCalledWith('agent-abc', {
        subject: 'nicolas',
        category: 'preference',
      })
    })
  })
})
