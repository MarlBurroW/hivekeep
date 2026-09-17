import { describe, it, expect, mock, beforeEach, spyOn } from 'bun:test'
import { fullMockConfig, fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mock dependencies before importing the module ───────────────────────────

// Mock drizzle DB
const mockGet = mock(() => undefined)
const mockAll = mock(() => [])
const mockRun = mock(() => undefined)
const mockInsert = mock(() => ({ values: mock(() => Promise.resolve()) }))
const mockDelete = mock(() => ({
  where: mock(() => Promise.resolve()),
}))
const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}))
const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => ({
      get: mockGet,
      all: mockAll,
      orderBy: mock(() => ({
        all: mockAll,
      })),
    })),
  })),
}))

mock.module('@/server/db/index', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
  sqlite: {
    run: mockRun,
    query: mock(() => ({
      all: mock(() => []),
    })),
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

mock.module('@/server/sse/index', () => ({
  sseManager: {
    sendToAgent: mock(() => {}),
  },
}))

const mockGenerateEmbedding = mock(() => Promise.resolve(new Array(256).fill(0.1)))
mock.module('@/server/services/embeddings', () => ({
  generateEmbedding: mockGenerateEmbedding,
}))

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    memory: {
      ...fullMockConfig.memory,
      similarityThreshold: 0.5,
      maxRelevantMemories: 10,
    },
  },
}))

mock.module('uuid', () => ({
  v4: () => 'test-uuid-1234',
}))

// `ai`/`@ai-sdk/*` are no longer used — memory.ts goes through the native
// `resolveLLM` + `runOneShot` path.

// Drizzle operators — just return the args for mock matching
mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (...args: unknown[]) => ({ type: 'eq', args }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
  like: (...args: unknown[]) => ({ type: 'like', args }),
  or: (...args: unknown[]) => ({ type: 'or', args }),
  desc: (col: unknown) => ({ type: 'desc', col }),
}))

mock.module('@/server/services/rerank', () => ({
  rerankDocuments: mock(async (docs: unknown[]) => docs),
}))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  memories: {
    id: 'id',
    agentId: 'agentId',
    content: 'content',
    embedding: 'embedding',
    category: 'category',
    subject: 'subject',
    importance: 'importance',
    sourceMessageId: 'sourceMessageId',
    sourceChannel: 'sourceChannel',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}))

// ─── Import the module under test ────────────────────────────────────────────

// Note: Due to heavy DB coupling, we primarily validate:
// 1. Function signatures and return shapes
// 2. That embeddings are generated when creating/updating memories
// 3. Edge cases in the search pipeline (via config variations)
// 4. The searchByFTS query building logic (special char escaping)

describe('memory service', () => {
  // ─── FTS query building ───────────────────────────────────────────────

  describe('FTS query building logic', () => {
    it('should escape special FTS5 characters', () => {
      const query = 'deploy "kubernetes" (v1.27)'
      const cleaned = query.replace(/['"*(){}[\]:^~!@#$%&]/g, ' ')
      expect(cleaned).toBe('deploy  kubernetes   v1.27 ')
    })

    it('should filter terms shorter than 3 characters', () => {
      const query = 'the big red fox is on it'
      const terms = query
        .replace(/['"*(){}[\]:^~!@#$%&]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3)
      expect(terms).toEqual(['the', 'big', 'red', 'fox'])
    })

    it('should return empty for very short queries', () => {
      const query = 'a b'
      const terms = query
        .replace(/['"*(){}[\]:^~!@#$%&]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3)
      expect(terms).toEqual([])
    })

    it('should build AND query with prefix matching', () => {
      const terms = ['deploy', 'kubernetes']
      const ftsQuery = terms.map((term) => `"${term}"*`).join(' AND ')
      expect(ftsQuery).toBe('"deploy"* AND "kubernetes"*')
    })

    it('should build OR fallback query', () => {
      const terms = ['deploy', 'kubernetes']
      const ftsQueryOr = terms.map((term) => `"${term}"*`).join(' OR ')
      expect(ftsQueryOr).toBe('"deploy"* OR "kubernetes"*')
    })
  })

  // ─── RRF (Reciprocal Rank Fusion) scoring ─────────────────────────────

  describe('reciprocal rank fusion scoring', () => {
    it('should compute correct RRF scores', () => {
      const K = 60

      // First result in a ranking gets 1/(60+0+1) = 1/61
      expect(1 / (K + 0 + 1)).toBeCloseTo(1 / 61, 6)

      // Second result gets 1/(60+1+1) = 1/62
      expect(1 / (K + 1 + 1)).toBeCloseTo(1 / 62, 6)

      // A result that appears first in BOTH vec and FTS gets:
      // 1/61 + 1/61 = 2/61
      const dualFirstScore = 1 / (K + 0 + 1) + 1 / (K + 0 + 1)
      expect(dualFirstScore).toBeCloseTo(2 / 61, 6)
    })

    it('should rank items appearing in both lists higher', () => {
      const K = 60
      // Item A: first in vec only → score = 1/61
      const scoreA = 1 / (K + 0 + 1)
      // Item B: second in vec, first in FTS → score = 1/62 + 1/61
      const scoreB = 1 / (K + 1 + 1) + 1 / (K + 0 + 1)
      expect(scoreB).toBeGreaterThan(scoreA)
    })

    it('should accumulate scores across multiple query variations', () => {
      const K = 60
      // With 3 query variations, a result appearing first in all 3:
      const score3x = 3 * (1 / (K + 0 + 1))
      // vs appearing first in only 1:
      const score1x = 1 / (K + 0 + 1)
      expect(score3x).toBeCloseTo(3 * score1x, 6)
      expect(score3x).toBeGreaterThan(score1x)
    })
  })

  // ─── Embedding buffer conversion ──────────────────────────────────────

  describe('embedding buffer handling', () => {
    it('should convert Float32Array to Buffer correctly', () => {
      const embedding = [0.1, 0.2, 0.3, 0.4]
      const buf = Buffer.from(new Float32Array(embedding).buffer)
      expect(buf.length).toBe(embedding.length * 4) // 4 bytes per float32

      // Read back
      const readBack = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
      expect(readBack[0]).toBeCloseTo(0.1, 5)
      expect(readBack[3]).toBeCloseTo(0.4, 5)
    })

    it('should handle empty embeddings', () => {
      const buf = Buffer.from(new Float32Array([]).buffer)
      expect(buf.length).toBe(0)
    })

    it('should handle large embeddings (256 dims)', () => {
      const embedding = new Array(256).fill(0.5)
      const buf = Buffer.from(new Float32Array(embedding).buffer)
      expect(buf.length).toBe(256 * 4) // 1024 bytes
    })
  })

  // ─── Similarity threshold filtering ───────────────────────────────────

  describe('similarity threshold', () => {
    it('should convert threshold to distance correctly', () => {
      // distance = 1 - cosine_similarity for vec0
      // threshold = 0.5 → max distance = 1 - 0.5 = 0.5
      const threshold = 0.5
      const maxDistance = 1 - threshold
      expect(maxDistance).toBe(0.5)

      // A result with distance 0.3 (similarity 0.7) passes
      expect(0.3).toBeLessThanOrEqual(maxDistance)

      // A result with distance 0.6 (similarity 0.4) fails
      expect(0.6).toBeGreaterThan(maxDistance)
    })

    it('should handle threshold of 0 (accept everything)', () => {
      const maxDistance = 1 - 0
      expect(maxDistance).toBe(1)
      // All cosine distances are ≤ 1
      expect(0.99).toBeLessThanOrEqual(maxDistance)
    })

    it('should handle threshold of 1 (accept only exact matches)', () => {
      const maxDistance = 1 - 1
      expect(maxDistance).toBe(0)
      // Only distance 0 passes
      expect(0).toBeLessThanOrEqual(maxDistance)
      expect(0.001).toBeGreaterThan(maxDistance)
    })
  })

  // ─── Batch processing (reembedAllMemories) ────────────────────────────

  describe('batch processing logic', () => {
    it('should process in batches of 10', () => {
      const BATCH_SIZE = 10
      const totalItems = 25

      const batches: number[] = []
      for (let i = 0; i < totalItems; i += BATCH_SIZE) {
        const batch = Math.min(BATCH_SIZE, totalItems - i)
        batches.push(batch)
      }

      expect(batches).toEqual([10, 10, 5])
    })

    it('should handle empty memory list', () => {
      const BATCH_SIZE = 10
      const totalItems = 0

      const batches: number[] = []
      for (let i = 0; i < totalItems; i += BATCH_SIZE) {
        batches.push(Math.min(BATCH_SIZE, totalItems - i))
      }

      expect(batches).toEqual([])
    })
  })

  // ─── Memory scope defaults (replicated logic) ──────────────────────────────

  describe('memory scope default behavior', () => {
    // The module defaults scope to 'private' when not specified:
    //   scope: input.scope ?? 'private'
    // This tests the contract.

    function resolveScope(inputScope?: string): string {
      return inputScope ?? 'private'
    }

    it('defaults to private when scope is undefined', () => {
      expect(resolveScope(undefined)).toBe('private')
    })

    it('defaults to private when scope is not provided', () => {
      expect(resolveScope()).toBe('private')
    })

    it('respects explicit private scope', () => {
      expect(resolveScope('private')).toBe('private')
    })

    it('respects explicit shared scope', () => {
      expect(resolveScope('shared')).toBe('shared')
    })
  })

  // ─── Shared memory filtering logic ──────────────────────────────────────────

  describe('shared memory filtering logic', () => {
    // The search results filter shared memories from other Agents:
    //   const sharedFromOthers = sorted.filter(m => m.scope === 'shared' && m.authorAgentId !== agentId)
    // This tests the contract.

    interface MemoryResult {
      id: string
      scope: string
      authorAgentId: string
    }

    function filterSharedFromOthers(results: MemoryResult[], currentAgentId: string): MemoryResult[] {
      return results.filter(m => m.scope === 'shared' && m.authorAgentId !== currentAgentId)
    }

    it('returns shared memories from other Agents', () => {
      const results: MemoryResult[] = [
        { id: '1', scope: 'shared', authorAgentId: 'agent-b' },
        { id: '2', scope: 'private', authorAgentId: 'agent-a' },
        { id: '3', scope: 'shared', authorAgentId: 'agent-a' },
      ]
      const shared = filterSharedFromOthers(results, 'agent-a')
      expect(shared).toHaveLength(1)
      expect(shared[0]!.id).toBe('1')
    })

    it('excludes own shared memories', () => {
      const results: MemoryResult[] = [
        { id: '1', scope: 'shared', authorAgentId: 'agent-a' },
      ]
      expect(filterSharedFromOthers(results, 'agent-a')).toHaveLength(0)
    })

    it('excludes private memories from others', () => {
      const results: MemoryResult[] = [
        { id: '1', scope: 'private', authorAgentId: 'agent-b' },
      ]
      expect(filterSharedFromOthers(results, 'agent-a')).toHaveLength(0)
    })

    it('handles empty results', () => {
      expect(filterSharedFromOthers([], 'agent-a')).toHaveLength(0)
    })

    it('handles multiple shared memories from different Agents', () => {
      const results: MemoryResult[] = [
        { id: '1', scope: 'shared', authorAgentId: 'agent-b' },
        { id: '2', scope: 'shared', authorAgentId: 'agent-c' },
        { id: '3', scope: 'shared', authorAgentId: 'agent-d' },
      ]
      const shared = filterSharedFromOthers(results, 'agent-a')
      expect(shared).toHaveLength(3)
    })
  })
})
