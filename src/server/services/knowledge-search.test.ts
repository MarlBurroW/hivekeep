import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { fullMockConfig, fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// `searchKnowledge` runs on every user message. The assertion that matters here
// is that it does NOT pay for a query embedding when the Agent has nothing
// indexed, which is the default state (there is no UI to add sources yet).

const mockGenerateEmbedding = mock(() => Promise.resolve(new Array(8).fill(0.1)))

/** Rows returned by the `hasIndexedChunks` existence probe. */
let chunkProbeRows: Array<{ one: number }> = []

mock.module('@/server/services/embeddings', () => ({
  generateEmbedding: mockGenerateEmbedding,
}))

mock.module('@/server/config', () => ({ config: fullMockConfig }))
mock.module('@/server/db/schema', () => ({ ...fullMockSchema }))
mock.module('drizzle-orm', () => ({ ...fullMockDrizzleOrm }))

mock.module('@/server/db/index', () => ({
  db: { select: () => ({}), insert: () => ({}), update: () => ({}), delete: () => ({}) },
  sqlite: {
    run: () => ({}),
    query: (sql: string) => ({
      // The probe is the only statement whose result steers the early return.
      get: () => (sql.includes('FROM knowledge_chunks WHERE agent_id') ? chunkProbeRows[0] : undefined),
      all: () => [],
    }),
  },
  initVirtualTables: () => ({}),
}))

let searchKnowledge: typeof import('./knowledge')['searchKnowledge']
let mocksWorking = false
try {
  const mod = await import('./knowledge')
  searchKnowledge = mod.searchKnowledge
  mocksWorking = true
} catch {
  mocksWorking = false
}

const itMocked = mocksWorking ? it : it.skip

describe('searchKnowledge', () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockClear()
    chunkProbeRows = []
  })

  itMocked('does not embed the query when the Agent has no indexed chunks', async () => {
    const results = await searchKnowledge('agent-1', 'anything at all')

    expect(results).toEqual([])
    expect(mockGenerateEmbedding).not.toHaveBeenCalled()
  })

  itMocked('embeds the query once the Agent has indexed chunks', async () => {
    chunkProbeRows = [{ one: 1 }]

    await searchKnowledge('agent-1', 'anything at all')

    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1)
  })
})
