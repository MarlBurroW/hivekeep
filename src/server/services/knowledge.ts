import { eq, and, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { knowledgeSources, knowledgeChunks } from '@/server/db/schema'
import { generateEmbedding } from '@/server/services/embeddings'
import { config } from '@/server/config'

const log = createLogger('knowledge')

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreateSourceInput {
  name: string
  type: 'file' | 'text' | 'url'
  content?: string | null
  sourceUrl?: string | null
  originalFilename?: string | null
  mimeType?: string | null
  storedPath?: string | null
  metadata?: string | null
}

export interface KnowledgeSearchResult {
  id: string
  content: string
  sourceId: string
  position: number
  score: number
}

// ─── Chunking ────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).length / 0.75)
}

export function chunkText(text: string, maxTokens = 512, overlap = 50): string[] {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0)
  if (paragraphs.length === 0) return []

  const chunks: string[] = []
  let currentChunk = ''
  let currentTokens = 0

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para)

    if (currentTokens + paraTokens > maxTokens && currentChunk.length > 0) {
      chunks.push(currentChunk.trim())

      // Overlap: take last `overlap` tokens worth of text from previous chunk
      if (overlap > 0) {
        const words = currentChunk.trim().split(/\s+/)
        const overlapWords = Math.ceil(overlap * 0.75)
        const overlapText = words.slice(-overlapWords).join(' ')
        currentChunk = overlapText + '\n\n' + para
        currentTokens = estimateTokens(currentChunk)
      } else {
        currentChunk = para
        currentTokens = paraTokens
      }
    } else {
      currentChunk = currentChunk ? currentChunk + '\n\n' + para : para
      currentTokens += paraTokens
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim())
  }

  return chunks
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function createSource(agentId: string, input: CreateSourceInput) {
  const id = uuid()
  const now = new Date()

  await db.insert(knowledgeSources).values({
    id,
    agentId,
    name: input.name,
    type: input.type,
    status: 'pending',
    originalFilename: input.originalFilename ?? null,
    mimeType: input.mimeType ?? null,
    storedPath: input.storedPath ?? null,
    sourceUrl: input.sourceUrl ?? null,
    rawContent: input.content ?? null,
    metadata: input.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  })

  const created = db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id)).get()!

  log.debug({ agentId, sourceId: id, type: input.type }, 'Knowledge source created')
  return created
}

export async function deleteSource(sourceId: string, agentId: string) {
  const existing = await getSource(sourceId, agentId)
  if (!existing) return false

  // Remove chunks from vec index
  try {
    const chunks = db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(eq(knowledgeChunks.sourceId, sourceId)).all()
    for (const chunk of chunks) {
      try { sqlite.run('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?', [chunk.id]) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  await db.delete(knowledgeSources).where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.agentId, agentId)))

  log.debug({ sourceId, agentId }, 'Knowledge source deleted')
  return true
}

export async function listSources(agentId: string) {
  return db.select().from(knowledgeSources)
    .where(eq(knowledgeSources.agentId, agentId))
    .orderBy(desc(knowledgeSources.createdAt))
    .all()
}

export async function getSource(sourceId: string, agentId: string) {
  return db.select().from(knowledgeSources)
    .where(and(eq(knowledgeSources.id, sourceId), eq(knowledgeSources.agentId, agentId)))
    .get()
}

export async function getSourceChunks(sourceId: string) {
  return db.select().from(knowledgeChunks)
    .where(eq(knowledgeChunks.sourceId, sourceId))
    .orderBy(knowledgeChunks.position)
    .all()
}

// ─── Processing Pipeline ────────────────────────────────────────────────────

export async function processSource(sourceId: string) {
  // Get source (without agentId filter since this is internal)
  const source = db.select().from(knowledgeSources).where(eq(knowledgeSources.id, sourceId)).get()
  if (!source) throw new Error(`Knowledge source ${sourceId} not found`)

  const agentId = source.agentId

  try {
    // Update status to processing
    await db.update(knowledgeSources).set({ status: 'processing', updatedAt: new Date() })
      .where(eq(knowledgeSources.id, sourceId))

    // Extract text content
    let textContent = source.rawContent ?? ''
    if (!textContent && source.type === 'url') {
      throw new Error('URL content extraction not yet implemented')
    }
    if (!textContent && source.type === 'file' && source.storedPath) {
      try {
        const file = Bun.file(source.storedPath)
        textContent = await file.text()
      } catch (err) {
        throw new Error(`Failed to read file: ${(err as Error).message}`)
      }
    }

    if (!textContent || textContent.trim().length === 0) {
      throw new Error('No text content to process')
    }

    // Store extracted content
    await db.update(knowledgeSources).set({ rawContent: textContent }).where(eq(knowledgeSources.id, sourceId))

    // Chunk the text
    const chunks = chunkText(textContent, 512, 50)
    if (chunks.length === 0) throw new Error('Text produced no chunks')

    // Delete existing chunks
    const existingChunks = db.select({ id: knowledgeChunks.id }).from(knowledgeChunks)
      .where(eq(knowledgeChunks.sourceId, sourceId)).all()
    for (const c of existingChunks) {
      try { sqlite.run('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?', [c.id]) } catch { /* ignore */ }
    }
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId))

    // Generate embeddings and store chunks
    let totalTokens = 0
    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i]!
      const chunkId = uuid()
      const chunkTokens = estimateTokens(chunkContent)
      totalTokens += chunkTokens

      let embeddingBuf: Buffer | null = null
      try {
        const embedding = await generateEmbedding(chunkContent)
        embeddingBuf = Buffer.from(new Float32Array(embedding).buffer)
      } catch { /* embedding provider may not be available */ }

      await db.insert(knowledgeChunks).values({
        id: chunkId,
        sourceId,
        agentId,
        content: chunkContent,
        embedding: embeddingBuf,
        position: i,
        tokenCount: chunkTokens,
        createdAt: new Date(),
      })

      // Insert into vec index
      if (embeddingBuf) {
        try {
          sqlite.run('INSERT INTO knowledge_chunks_vec(chunk_id, embedding) VALUES (?, ?)', [chunkId, embeddingBuf])
        } catch { /* ignore */ }
      }
    }

    // Update source status
    await db.update(knowledgeSources).set({
      status: 'ready',
      chunkCount: chunks.length,
      tokenCount: totalTokens,
      errorMessage: null,
      updatedAt: new Date(),
    }).where(eq(knowledgeSources.id, sourceId))

    log.info({ sourceId, agentId, chunks: chunks.length, tokens: totalTokens }, 'Knowledge source processed')
  } catch (err) {
    const errorMessage = (err as Error).message || 'Unknown processing error'
    await db.update(knowledgeSources).set({
      status: 'error',
      errorMessage,
      updatedAt: new Date(),
    }).where(eq(knowledgeSources.id, sourceId))

    log.error({ sourceId, agentId, err }, 'Knowledge source processing failed')
    throw err
  }
}

// ─── Hybrid Search ──────────────────────────────────────────────────────────

/**
 * Whether the Agent has at least one indexed knowledge chunk.
 * Indexed on `agent_id`, so this is a cheap existence check.
 */
function hasIndexedChunks(agentId: string): boolean {
  try {
    const row = sqlite
      .query<{ one: number }, [string]>(
        'SELECT 1 AS one FROM knowledge_chunks WHERE agent_id = ? LIMIT 1',
      )
      .get(agentId)
    return !!row
  } catch {
    // Table missing on a partially-migrated database: treat as empty rather
    // than falling through to a search that cannot succeed either.
    return false
  }
}

export async function searchKnowledge(
  agentId: string,
  query: string,
  limit?: number,
): Promise<KnowledgeSearchResult[]> {
  const maxResults = limit ?? 5
  const K = config.memory.rrfK
  const scoreMap = new Map<string, { score: number; content: string; sourceId: string; position: number }>()

  // Bail out before embedding the query when the Agent has no indexed chunk.
  // This runs on every user message, and the embedding call below is a paid
  // round-trip that would return nothing on an Agent with no knowledge base
  // (the common case: there is no UI to add sources yet).
  if (!hasIndexedChunks(agentId)) return []

  // Vector search
  try {
    const queryEmbedding = await generateEmbedding(query)
    const queryBuf = Buffer.from(new Float32Array(queryEmbedding).buffer)

    const vecRows = sqlite
      .query<{ chunk_id: string; distance: number }, [Buffer, number]>(
        `SELECT chunk_id, distance FROM knowledge_chunks_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
      )
      .all(queryBuf, maxResults * 2)

    const threshold = config.memory.similarityThreshold
    const matchingIds = vecRows.filter((r) => r.distance <= 1 - threshold).map((r) => r.chunk_id)

    if (matchingIds.length > 0) {
      const placeholders = matchingIds.map(() => '?').join(', ')
      const chunkRows = sqlite
        .query<{ id: string; content: string; source_id: string; position: number }, string[]>(
          `SELECT id, content, source_id, position FROM knowledge_chunks WHERE id IN (${placeholders}) AND agent_id = ?`,
        )
        .all(...matchingIds, agentId)

      const chunkMap = new Map(chunkRows.map((c) => [c.id, c]))
      for (let i = 0; i < vecRows.length; i++) {
        const r = vecRows[i]!
        const c = chunkMap.get(r.chunk_id)
        if (!c) continue
        const rrfScore = 1 / (K + i + 1)
        const existing = scoreMap.get(c.id)
        if (existing) { existing.score += rrfScore } else {
          scoreMap.set(c.id, { score: rrfScore, content: c.content, sourceId: c.source_id, position: c.position })
        }
      }
    }
  } catch { /* vector search not available */ }

  // FTS search
  try {
    const terms = query
      .replace(/['"*(){}[\]:^~!@#$%&]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3)

    if (terms.length > 0) {
      const ftsQuery = terms.map((term) => `"${term}"*`).join(' AND ')
      const ftsQueryOr = terms.map((term) => `"${term}"*`).join(' OR ')

      const stmt = sqlite.query<
        { id: string; content: string; source_id: string; position: number; rank: number },
        [string, string, number]
      >(
        `SELECT c.id, c.content, c.source_id, c.position, fts.rank
         FROM knowledge_chunks_fts fts
         JOIN knowledge_chunks c ON c.rowid = fts.rowid
         WHERE knowledge_chunks_fts MATCH ? AND c.agent_id = ?
         ORDER BY fts.rank
         LIMIT ?`,
      )

      let ftsRows = stmt.all(ftsQuery, agentId, maxResults * 2)
      if (ftsRows.length === 0 && terms.length > 1) {
        ftsRows = stmt.all(ftsQueryOr, agentId, maxResults * 2)
      }

      const ftsBoost = config.memory.ftsBoost
      for (let i = 0; i < ftsRows.length; i++) {
        const r = ftsRows[i]!
        const rrfScore = ftsBoost / (K + i + 1)
        const existing = scoreMap.get(r.id)
        if (existing) { existing.score += rrfScore } else {
          scoreMap.set(r.id, { score: rrfScore, content: r.content, sourceId: r.source_id, position: r.position })
        }
      }
    }
  } catch { /* FTS not available */ }

  const sorted = Array.from(scoreMap.entries())
    .map(([id, data]) => ({ id, content: data.content, sourceId: data.sourceId, position: data.position, score: data.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)

  return sorted
}
