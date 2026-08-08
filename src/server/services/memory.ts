import { eq, and, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { memories } from '@/server/db/schema'
import { generateEmbedding } from '@/server/services/embeddings'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import type { MemoryCategory, MemoryScope } from '@/shared/types'

const log = createLogger('memory')

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreateMemoryInput {
  content: string
  category: MemoryCategory
  subject?: string | null
  sourceContext?: string | null
  importance?: number | null
  sourceMessageId?: string | null
  sourceChannel?: 'automatic' | 'explicit'
  scope?: MemoryScope
}

interface UpdateMemoryInput {
  content?: string
  category?: MemoryCategory
  subject?: string | null
  sourceContext?: string | null
  importance?: number | null
  scope?: MemoryScope
}

/** Optional metadata narrowing for an archive search. */
export interface MemorySearchFilters {
  subject?: string
  category?: string
  since?: Date
}

interface MemorySearchResult {
  id: string
  content: string
  category: string
  subject: string | null
  sourceContext: string | null
  importance: number | null
  scope: MemoryScope
  authorAgentId?: string
  authorAgentName?: string | null
  score: number
  updatedAt: Date | null
}

// ─── Dedup (lightweight, raw vector distance) ───────────────────────────────

/**
 * Check if a memory content is a near-duplicate of an existing memory for an Agent.
 * Uses raw cosine distance (no boosts, no HyDE, no multi-query) for speed and accuracy.
 * Returns true if a duplicate is found (distance < threshold).
 */
export async function isDuplicateMemory(
  agentId: string,
  content: string,
  distanceThreshold = 0.15, // cosine distance; 0.15 ≈ similarity > 0.85
): Promise<boolean> {
  try {
    const embedding = await generateEmbedding(content)
    const queryBuf = Buffer.from(new Float32Array(embedding).buffer)

    const rows = sqlite
      .query<{ memory_id: string; distance: number }, [Buffer, number]>(
        `SELECT memory_id, distance
         FROM memories_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(queryBuf, 3)

    if (rows.length === 0) return false

    // Filter to this Agent's memories OR any shared memories (cross-scope dedup)
    const ids = rows.map((r) => r.memory_id)
    const placeholders = ids.map(() => '?').join(', ')
    const relevantMemories = sqlite
      .query<{ id: string }, string[]>(
        `SELECT id FROM memories WHERE id IN (${placeholders}) AND (agent_id = ? OR scope = 'shared')`,
      )
      .all(...ids, agentId)
    const relevantIds = new Set(relevantMemories.map((m) => m.id))

    return rows.some((r) => relevantIds.has(r.memory_id) && r.distance < distanceThreshold)
  } catch {
    // If embeddings unavailable, fall back to allowing the memory
    return false
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function getMemory(memoryId: string, agentId: string) {
  return db
    .select()
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.agentId, agentId)))
    .get()
}

export async function listMemories(
  agentId: string,
  filters?: { category?: MemoryCategory; subject?: string; scope?: MemoryScope },
) {
  const conditions = []

  if (filters?.scope === 'shared') {
    // List all shared memories (from any Agent)
    conditions.push(eq(memories.scope, 'shared'))
  } else {
    // Default: list own memories only (private scope)
    conditions.push(eq(memories.agentId, agentId))
    if (filters?.scope === 'private') {
      conditions.push(eq(memories.scope, 'private'))
    }
  }

  if (filters?.category) conditions.push(eq(memories.category, filters.category))
  if (filters?.subject) conditions.push(eq(memories.subject, filters.subject))

  return db
    .select()
    .from(memories)
    .where(and(...conditions))
    .orderBy(desc(memories.updatedAt))
    .all()
}

export async function createMemory(agentId: string, input: CreateMemoryInput) {
  const id = uuid()
  const now = new Date()

  // Generate embedding
  let embeddingBuf: Buffer | null = null
  try {
    const embedding = await generateEmbedding(input.content)
    embeddingBuf = Buffer.from(new Float32Array(embedding).buffer)
  } catch {
    // Embedding provider may not be available — store without vector
  }

  await db.insert(memories).values({
    id,
    agentId,
    content: input.content,
    embedding: embeddingBuf,
    category: input.category,
    subject: input.subject ?? null,
    sourceContext: input.sourceContext ?? null,
    importance: input.importance ?? null,
    sourceMessageId: input.sourceMessageId ?? null,
    sourceChannel: input.sourceChannel ?? 'explicit',
    scope: input.scope ?? 'private',
    createdAt: now,
    updatedAt: now,
  })

  // Insert into sqlite-vec if embedding was generated
  if (embeddingBuf) {
    try {
      sqlite.run(
        'INSERT INTO memories_vec(memory_id, embedding) VALUES (?, ?)',
        [id, embeddingBuf],
      )
    } catch (err) {
      // sqlite-vec unavailable, or a real failure (e.g. dimension mismatch
      // after an embedding-provider change). Silent loss here degrades vector
      // search with zero signal, so log it; the boot reconciliation sweep
      // cannot repair a missing vec row, only orphans.
      log.warn({ memoryId: id, err }, 'memories_vec insert failed — memory not vector-searchable')
    }
  }

  log.debug({ agentId, memoryId: id, category: input.category, hasEmbedding: !!embeddingBuf }, 'Memory created')

  const created = db.select().from(memories).where(eq(memories.id, id)).get()!

  sseManager.sendToAgent(agentId, {
    type: 'memory:created',
    agentId,
    data: { memoryId: id, agentId, category: input.category, content: input.content, subject: input.subject ?? null, scope: input.scope ?? 'private' },
  })

  return created
}

export async function updateMemory(memoryId: string, agentId: string, updates: UpdateMemoryInput) {
  const existing = await getMemory(memoryId, agentId)
  if (!existing) return null

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (updates.content !== undefined) setValues.content = updates.content
  if (updates.category !== undefined) setValues.category = updates.category
  if (updates.subject !== undefined) setValues.subject = updates.subject
  if (updates.sourceContext !== undefined) setValues.sourceContext = updates.sourceContext
  if (updates.importance !== undefined) setValues.importance = updates.importance
  if (updates.scope !== undefined) setValues.scope = updates.scope

  // Re-generate embedding if content changed
  if (updates.content !== undefined) {
    try {
      const embedding = await generateEmbedding(updates.content)
      const embeddingBuf = Buffer.from(new Float32Array(embedding).buffer)
      setValues.embedding = embeddingBuf

      // Update sqlite-vec
      try {
        sqlite.run('DELETE FROM memories_vec WHERE memory_id = ?', [memoryId])
        sqlite.run(
          'INSERT INTO memories_vec(memory_id, embedding) VALUES (?, ?)',
          [memoryId, embeddingBuf],
        )
      } catch (err) {
        log.warn({ memoryId, err }, 'memories_vec update failed — memory not vector-searchable')
      }
    } catch {
      // Embedding provider may not be available
    }
  }

  await db
    .update(memories)
    .set(setValues)
    .where(and(eq(memories.id, memoryId), eq(memories.agentId, agentId)))

  const updated = db.select().from(memories).where(eq(memories.id, memoryId)).get()!

  sseManager.sendToAgent(agentId, {
    type: 'memory:updated',
    agentId,
    data: { memoryId, agentId, ...(updates.content !== undefined && { content: updates.content }), ...(updates.category !== undefined && { category: updates.category }), ...(updates.subject !== undefined && { subject: updates.subject }) },
  })

  return updated
}

export async function deleteMemory(memoryId: string, agentId: string) {
  const existing = await getMemory(memoryId, agentId)
  if (!existing) return false

  // Remove from sqlite-vec
  try {
    sqlite.run('DELETE FROM memories_vec WHERE memory_id = ?', [memoryId])
  } catch (err) {
    log.warn({ memoryId, err }, 'memories_vec delete failed — orphan repaired by the boot sweep')
  }

  await db.delete(memories).where(and(eq(memories.id, memoryId), eq(memories.agentId, agentId)))
  log.debug({ memoryId, agentId }, 'Memory deleted')

  sseManager.sendToAgent(agentId, {
    type: 'memory:deleted',
    agentId,
    data: { memoryId, agentId },
  })

  return true
}

// ─── Hybrid Search (FTS5 + sqlite-vec rank fusion) ───────────────────────────

type ScoreMapEntry = { score: number; content: string; category: string; subject: string | null; sourceContext: string | null; importance: number | null; scope: MemoryScope; agentId: string; updatedAt: Date | null }

/**
 * Search the memory archive: semantic (sqlite-vec KNN) + textual (FTS5),
 * merged by reciprocal rank fusion.
 *
 * Relevance to the query is the only ranking signal. v1 multiplied the fused
 * score by temporal decay, importance, retrieval count, subject and category
 * boosts; on real data that produced a winner-take-all archive where a handful
 * of memories were returned forever and half the corpus was never surfaced
 * once. Recency only breaks ties.
 */
export async function searchMemories(
  agentId: string,
  query: string,
  limit?: number,
  filters?: MemorySearchFilters,
): Promise<MemorySearchResult[]> {
  const maxResults = limit ?? config.memory.maxRelevantMemories
  const K = config.memory.rrfK
  const ftsBoost = config.memory.ftsBoost
  const scoreMap = new Map<string, ScoreMapEntry>()

  const candidateLimit = maxResults * 2
  const [vecResults, ftsResults] = await Promise.all([
    searchByVector(agentId, query, candidateLimit, filters),
    searchByFTS(agentId, query, candidateLimit, filters),
  ])

  const accumulate = (
    results: Array<{ id: string; content: string; category: string; subject: string | null; sourceContext: string | null; importance: number | null; scope: MemoryScope; agentId: string; updatedAt: Date | null }>,
    weight: number,
  ) => {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      const rrfScore = weight / (K + i + 1)
      const existing = scoreMap.get(r.id)
      if (existing) {
        existing.score += rrfScore
      } else {
        scoreMap.set(r.id, { score: rrfScore, content: r.content, category: r.category, subject: r.subject, sourceContext: r.sourceContext, importance: r.importance, scope: r.scope, agentId: r.agentId, updatedAt: r.updatedAt })
      }
    }
  }

  accumulate(vecResults, 1)
  // The FTS arm is weighted separately: keyword hits and vector neighbours are
  // not equally trustworthy at the same rank.
  accumulate(ftsResults, ftsBoost)

  const sorted = Array.from(scoreMap.entries())
    .map(([id, data]) => ({ id, content: data.content, category: data.category, subject: data.subject, sourceContext: data.sourceContext, importance: data.importance, scope: data.scope, authorAgentId: data.agentId, score: data.score, updatedAt: data.updatedAt }))
    .sort((a, b) => b.score - a.score || (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0))
    .slice(0, maxResults)

  // Resolve author Agent names for shared memories from other Agents
  const sharedFromOthers = sorted.filter((m) => m.scope === 'shared' && m.authorAgentId !== agentId)
  if (sharedFromOthers.length > 0) {
    const uniqueAgentIds = [...new Set(sharedFromOthers.map((m) => m.authorAgentId))]
    try {
      const agentPlaceholders = uniqueAgentIds.map(() => '?').join(', ')
      const agentRows = sqlite
        .query<{ id: string; name: string }, string[]>(
          `SELECT id, name FROM agents WHERE id IN (${agentPlaceholders})`,
        )
        .all(...uniqueAgentIds)
      const agentNameMap = new Map(agentRows.map((k) => [k.id, k.name]))
      for (const m of sorted) {
        if (m.scope === 'shared' && m.authorAgentId !== agentId) {
          (m as MemorySearchResult).authorAgentName = agentNameMap.get(m.authorAgentId) ?? null
        }
      }
    } catch {
      // Agent name resolution failed — continue without names
    }
  }

  trackRetrievals(sorted.map((m) => m.id))

  return sorted
}

/**
 * Build the SQL fragment + bound values for the optional archive filters.
 * Shared by both search arms so a filter can never apply to only one of them.
 */
function buildFilterClause(
  filters?: MemorySearchFilters,
  /** Table alias to qualify columns with, for queries that join two tables. */
  prefix = '',
): { sql: string; params: Array<string | number> } {
  const col = (name: string) => `${prefix}${name}`
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (filters?.subject) {
    clauses.push(`${col('subject')} = ?`)
    params.push(filters.subject)
  }
  if (filters?.category) {
    clauses.push(`${col('category')} = ?`)
    params.push(filters.category)
  }
  if (filters?.since) {
    clauses.push(`${col('updated_at')} >= ?`)
    params.push(filters.since.getTime())
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params }
}

/**
 * Semantic search using sqlite-vec KNN.
 */
async function searchByVector(
  agentId: string,
  query: string,
  limit: number,
  filters?: MemorySearchFilters,
): Promise<Array<{ id: string; content: string; category: string; subject: string | null; sourceContext: string | null; importance: number | null; retrievalCount: number; distance: number; scope: MemoryScope; agentId: string; updatedAt: Date | null }>> {
  try {
    const queryEmbedding = await generateEmbedding(query)
    const queryBuf = Buffer.from(new Float32Array(queryEmbedding).buffer)

    const filter = buildFilterClause(filters)
    // KNN runs before the metadata filter, so a filtered search needs a wider
    // candidate pool or the filter would starve the vector arm.
    const k = filter.params.length > 0 ? limit * 4 : limit

    const rows = sqlite
      .query<{ memory_id: string; distance: number }, [Buffer, number]>(
        `SELECT memory_id, distance
         FROM memories_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(queryBuf, k)

    // Filter by similarity threshold (distance = 1 - cosine_similarity for vec0)
    const threshold = config.memory.similarityThreshold
    const matchingIds = rows
      .filter((r) => r.distance <= 1 - threshold)
      .map((r) => r.memory_id)

    if (matchingIds.length === 0) return []

    // Fetch full memory rows: own memories + shared memories from all Agents
    const placeholders = matchingIds.map(() => '?').join(', ')
    const memRows = sqlite
      .query<
        { id: string; agent_id: string; content: string; category: string; subject: string | null; source_context: string | null; importance: number | null; retrieval_count: number; scope: string; updated_at: string | null },
        Array<string | number>
      >(
        `SELECT id, agent_id, content, category, subject, source_context, importance, retrieval_count, scope, updated_at FROM memories
         WHERE id IN (${placeholders}) AND (agent_id = ? OR scope = 'shared')${filter.sql}`,
      )
      .all(...matchingIds, agentId, ...filter.params)

    // Preserve distance ordering
    const memMap = new Map(memRows.map((m) => [m.id, m]))
    return rows
      .filter((r) => memMap.has(r.memory_id))
      .map((r) => {
        const m = memMap.get(r.memory_id)!
        return { id: m.id, agentId: m.agent_id, content: m.content, category: m.category, subject: m.subject, sourceContext: m.source_context, importance: m.importance, retrievalCount: m.retrieval_count, scope: m.scope as MemoryScope, distance: r.distance, updatedAt: m.updated_at ? new Date(m.updated_at) : null }
      })
  } catch {
    // sqlite-vec or embedding provider not available
    return []
  }
}

/**
 * Full-text search using FTS5.
 */
function searchByFTS(
  agentId: string,
  query: string,
  limit: number,
  filters?: MemorySearchFilters,
): Promise<Array<{ id: string; content: string; category: string; subject: string | null; sourceContext: string | null; importance: number | null; retrievalCount: number; rank: number; scope: MemoryScope; agentId: string; updatedAt: Date | null }>> {
  try {
    // Escape FTS5 special characters, filter noise, build query with prefix matching
    const terms = query
      .replace(/['"*(){}[\]:^~!@#$%&]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3) // skip very short terms (noise for FTS)

    if (terms.length === 0) return Promise.resolve([])

    // Build AND query with prefix matching on each term for partial word matches
    // e.g. "deploy kubernetes" → "deploy"* AND "kubernetes"*
    const ftsQuery = terms.map((term) => `"${term}"*`).join(' AND ')

    // Fallback: if AND is too strict, we'll catch empty results and retry with OR
    const ftsQueryOr = terms.map((term) => `"${term}"*`).join(' OR ')

    // Columns are qualified: the FTS join brings two tables into scope.
    const filter = buildFilterClause(filters, 'm.')

    const stmt = sqlite.query<
      { id: string; agent_id: string; content: string; category: string; subject: string | null; source_context: string | null; importance: number | null; retrieval_count: number; scope: string; rank: number; updated_at: string | null },
      Array<string | number>
    >(
      `SELECT m.id, m.agent_id, m.content, m.category, m.subject, m.source_context, m.importance, m.retrieval_count, m.scope, fts.rank, m.updated_at
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND (m.agent_id = ? OR m.scope = 'shared')${filter.sql}
       ORDER BY fts.rank
       LIMIT ?`,
    )

    // Try AND first (precise), fall back to OR (broad) if no results
    let rows = stmt.all(ftsQuery, agentId, ...filter.params, limit)
    if (rows.length === 0 && terms.length > 1) {
      rows = stmt.all(ftsQueryOr, agentId, ...filter.params, limit)
    }

    return Promise.resolve(rows.map((r) => ({ ...r, agentId: r.agent_id, sourceContext: r.source_context, retrievalCount: r.retrieval_count, scope: r.scope as MemoryScope, updatedAt: r.updated_at ? new Date(r.updated_at) : null })))
  } catch {
    return Promise.resolve([])
  }
}

// ─── Retrieval Tracking ──────────────────────────────────────────────────────

/**
 * Increment retrieval_count and update last_retrieved_at for the given memory IDs.
 * Fire-and-forget: errors are logged but never block the caller.
 */
function trackRetrievals(memoryIds: string[]): void {
  if (memoryIds.length === 0) return
  try {
    const now = Date.now()
    const placeholders = memoryIds.map(() => '?').join(', ')
    sqlite.run(
      `UPDATE memories SET retrieval_count = retrieval_count + 1, last_retrieved_at = ? WHERE id IN (${placeholders})`,
      [now, ...memoryIds],
    )
  } catch (err) {
    log.warn({ err, count: memoryIds.length }, 'Failed to track memory retrievals')
  }
}

// ─── Re-embedding ────────────────────────────────────────────────────────────

/**
 * Re-embed all memories for a given Agent (or all Agents if agentId is null).
 * Useful when switching embedding models. Processes memories in batches
 * and reports progress via SSE.
 * Returns { total, success, failed }.
 */
export async function reembedAllMemories(
  agentId?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ total: number; success: number; failed: number }> {
  const conditions = agentId ? [eq(memories.agentId, agentId)] : []
  const allMemories = await db
    .select({ id: memories.id, agentId: memories.agentId, content: memories.content })
    .from(memories)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all()

  const total = allMemories.length
  let success = 0
  let failed = 0

  // Process in batches of 10 to avoid overwhelming the embedding API
  const BATCH_SIZE = 10
  for (let i = 0; i < allMemories.length; i += BATCH_SIZE) {
    const batch = allMemories.slice(i, i + BATCH_SIZE)
    await Promise.all(
      batch.map(async (mem) => {
        try {
          const embedding = await generateEmbedding(mem.content)
          const embeddingBuf = Buffer.from(new Float32Array(embedding).buffer)

          // Update the embedding in the memories table
          await db
            .update(memories)
            .set({ embedding: embeddingBuf })
            .where(eq(memories.id, mem.id))

          // Update sqlite-vec index
          try {
            sqlite.run('DELETE FROM memories_vec WHERE memory_id = ?', [mem.id])
            sqlite.run(
              'INSERT INTO memories_vec(memory_id, embedding) VALUES (?, ?)',
              [mem.id, embeddingBuf],
            )
          } catch {
            // sqlite-vec may not be available
          }

          success++
        } catch (err) {
          log.warn({ memoryId: mem.id, err }, 'Failed to re-embed memory')
          failed++
        }
      }),
    )

    onProgress?.(success + failed, total)
  }

  log.info({ total, success, failed, agentId: agentId ?? 'all' }, 'Re-embedding complete')
  return { total, success, failed }
}
