import { eq, and, like, or, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { safeGenerateText } from '@/server/services/llm-helpers'
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

// ─── Temporal Decay ──────────────────────────────────────────────────────────

/**
 * Compute a temporal decay weight for a memory based on its age and category.
 * Facts and knowledge decay very slowly; preferences and decisions decay faster.
 * Returns a multiplier in (0, 1].
 */
function temporalDecayWeight(updatedAt: Date | null, category: string, importance?: number | null): number {
  const lambda = config.memory.temporalDecayLambda
  if (lambda <= 0 || !updatedAt) return 1 // No decay

  const daysSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24)
  if (daysSinceUpdate <= 0) return 1

  // Category-based decay rates: facts/knowledge are durable, decisions are ephemeral
  const categoryMultiplier: Record<string, number> = {
    fact: 0.1,       // Very slow decay (half-life ~693 days at λ=0.01)
    knowledge: 0.1,  // Very slow decay
    preference: 0.5, // Moderate decay (half-life ~139 days at λ=0.01)
    decision: 2.0,   // Faster decay (half-life ~35 days at λ=0.01)
  }

  // Importance-gated decay: high-importance memories decay slower.
  // importance 1-10, default 5. Scale: imp 10 → 0.3x decay rate, imp 1 → 1.4x decay rate.
  const imp = importance ?? 5
  const importanceGate = 1.5 - (imp / 10) // 10→0.5, 5→1.0, 1→1.4

  const effectiveLambda = lambda * (categoryMultiplier[category] ?? 1) * importanceGate

  // Decay floor: never let temporal decay push below 0.3, ensuring old but
  // semantically relevant memories remain retrievable.
  const decayFloor = config.memory.temporalDecayFloor ?? 0.3
  return Math.max(decayFloor, Math.exp(-effectiveLambda * daysSinceUpdate))
}

// ─── Recency Boost ──────────────────────────────────────────────────────────

import { recencyBoost as _recencyBoostPure } from '@/server/services/memory-utils'

/**
 * Apply a multiplicative boost to very recent memories.
 * Delegates to pure utility, passing config flag.
 */
export function recencyBoost(updatedAt: Date | null): number {
  return _recencyBoostPure(updatedAt, config.memory.recencyBoostEnabled)
}

// ─── Multi-Query Generation ──────────────────────────────────────────────────

/**
 * Get distinct non-null subjects for a given agent, used to ground query expansion.
 */
async function getDistinctSubjects(agentId: string): Promise<string[]> {
  try {
    const rows = sqlite
      .query<{ subject: string }, [string]>(
        `SELECT DISTINCT subject FROM memories WHERE (agent_id = ? OR scope = 'shared') AND subject IS NOT NULL AND subject != '' ORDER BY subject`,
      )
      .all(agentId)
    return rows.map((r) => r.subject)
  } catch {
    return []
  }
}

/**
 * Generate alternative query formulations to improve recall.
 * Uses a fast/cheap LLM to create 2-3 variations of the original query,
 * capturing different perspectives and phrasings.
 * When known subjects are provided, the LLM can generate more targeted
 * entity-specific queries instead of abstract rephrasing.
 */
async function generateQueryVariations(query: string, knownSubjects?: string[], agentId?: string): Promise<string[]> {
  const multiQueryModel = config.memory.multiQueryModel
  if (!multiQueryModel) return [query]

  try {
    const { resolveLLM } = await import('@/server/llm/core/resolve')
    let resolved
    try {
      resolved = await resolveLLM({ modelId: multiQueryModel, providerId: config.memory.multiQueryProviderId ?? null })
    } catch { return [query] }

    const subjectHint = knownSubjects && knownSubjects.length > 0
      ? `\nKnown subjects in memory: ${knownSubjects.join(', ')}\nUse these to generate targeted queries about specific entities when relevant.`
      : ''

    const result = await safeGenerateText({
      resolved,
      callSite: 'memory-multi-query',
      timeoutMs: config.memory.retrievalLlmTimeoutMs,
      agentId,
      prompt:
        `Generate 3 alternative search queries for retrieving relevant memories based on this message. ` +
        `Each query should target a DIFFERENT aspect, entity, or sub-topic to maximize recall. ` +
        `Use specific nouns and keywords rather than abstract rephrasing.\n\n` +
        `Original: "${query}"\n${subjectHint}\n` +
        `Return ONLY a JSON array of 3 strings, no explanation. Example: ["query1", "query2", "query3"]`,
    })

    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return [query]

    const variations = JSON.parse(jsonMatch[0]) as string[]
    if (!Array.isArray(variations) || variations.length === 0) return [query]

    // Return original + variations (deduplicated)
    const all = [query, ...variations.filter((v) => typeof v === 'string' && v.trim().length > 0)]
    return [...new Set(all)].slice(0, 4) // Cap at 4 total queries
  } catch (err) {
    log.debug({ err }, 'Multi-query generation failed, falling back to single query')
    return [query]
  }
}

// ─── HyDE (Hypothetical Document Embedding) ──────────────────────────────────

/**
 * Generate a hypothetical memory entry that would answer the query.
 * The embedding of this hypothetical doc is closer to actual relevant memories
 * than the question-style query embedding, improving retrieval quality.
 *
 * Returns null if HyDE is disabled or generation fails.
 */
async function generateHypotheticalMemory(query: string, agentId?: string): Promise<string | null> {
  const hydeModel = config.memory.hydeModel
  if (!hydeModel) return null

  try {
    const { resolveLLM } = await import('@/server/llm/core/resolve')
    let resolved
    try {
      resolved = await resolveLLM({ modelId: hydeModel, providerId: config.memory.hydeProviderId ?? null })
    } catch { return null }

    const result = await safeGenerateText({
      resolved,
      callSite: 'memory-hyde',
      timeoutMs: config.memory.retrievalLlmTimeoutMs,
      agentId,
      prompt:
        `You are a personal AI companion that stores memories about its user. ` +
        `Given a search query, write a SHORT hypothetical memory entry (1-2 sentences) that would answer it. ` +
        `Write it as a factual statement, not a question. Be specific and use natural language.\n\n` +
        `Query: "${query}"\n\nHypothetical memory:`,
    })

    const doc = result.text.trim().replace(/^["']|["']$/g, '')
    if (doc.length > 0 && doc.length < 500) {
      log.debug({ query: query.slice(0, 80), hyde: doc.slice(0, 120) }, 'HyDE generated hypothetical memory')
      return doc
    }
    return null
  } catch (err) {
    log.debug({ err }, 'HyDE generation failed')
    return null
  }
}

// ─── Adaptive K ──────────────────────────────────────────────────────────────

/**
 * Adaptively trim a sorted (descending) result list based on score distribution.
 * Uses two heuristics:
 * 1. Minimum score ratio: drop results below `minScoreRatio * topScore`
 * 2. Largest gap detection: if there's a steep drop between consecutive scores
 *    (gap > 40% of the score range seen so far), truncate there.
 * Always returns at least 1 result.
 */
function applyAdaptiveK<T extends { score: number }>(results: T[]): T[] {
  if (!config.memory.adaptiveK || results.length <= 1) return results

  const first = results[0]
  if (!first || first.score <= 0) return results.slice(0, 1)

  const topScore = first.score
  const minScore = topScore * config.memory.adaptiveKMinScoreRatio
  let cutoff = results.length

  // Pass 1: find the largest relative gap. Threshold pulled from config so
  // operators can tune it; raised default to 60% to reduce winner-take-all
  // truncation when one memory is heavily boosted (importance × retrieval
  // feedback loop).
  const largestGapRatio = config.memory.adaptiveKLargestGapRatio ?? 0.6
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1]!
    const curr = results[i]!
    const gap = prev.score - curr.score
    const rangeFromTop = topScore - curr.score
    if (rangeFromTop > 0 && gap / rangeFromTop > largestGapRatio) {
      cutoff = i
      break
    }
  }

  // Pass 2: enforce minimum score ratio
  for (let i = 1; i < cutoff; i++) {
    if (results[i]!.score < minScore) {
      cutoff = i
      break
    }
  }

  log.debug({ total: results.length, kept: cutoff, topScore: topScore.toFixed(4), minKept: results[cutoff - 1]?.score.toFixed(4) }, 'Adaptive-K trimming')

  return results.slice(0, Math.max(1, cutoff))
}

// ─── Query Intent Detection (category boosting) ─────────────────────────────

/**
 * Detect which memory categories a query is likely asking about,
 * using lightweight bilingual (EN/FR) regex patterns.
 * Returns a Set of matching categories. Empty set = no strong signal.
 *
 * This is zero-cost (no LLM calls) and helps boost relevant categories
 * when the query has a clear intent, e.g. "what does X like?" → preference.
 */
function detectQueryIntentCategories(query: string): Set<string> {
  const q = query.toLowerCase()
  const matched = new Set<string>()

  // Preference patterns (EN + FR)
  const preferencePatterns = [
    /\b(prefer|like|love|enjoy|favorite|favourite|fond of|rather|taste)\b/,
    /\b(préfère|préféré|aime|adore|favori|goût|plutôt)\b/,
    /\b(what does .+ like|how does .+ take|how does .+ prefer)\b/,
    /\b(qu'est-ce qu.+ aime|comment .+ prend|comment .+ préfère)\b/,
  ]

  // Decision patterns (EN + FR)
  const decisionPatterns = [
    /\b(decide|decided|decision|chose|chosen|choice|plan|planned|commit|agreed)\b/,
    /\b(décidé|décision|choix|choisi|planifié|convenu|engagé)\b/,
    /\b(did (we|i|you|they) (agree|decide)|what was decided)\b/,
    /\b(on a (décidé|convenu|choisi)|qu'est-ce qu'on a décidé)\b/,
  ]

  // Knowledge patterns (EN + FR)
  const knowledgePatterns = [
    /\b(how (to|do|does|can)|explain|tutorial|guide|method|technique|process)\b/,
    /\b(comment (faire|on fait)|expliqu|tutoriel|méthode|technique|procédé)\b/,
  ]

  for (const pat of preferencePatterns) {
    if (pat.test(q)) { matched.add('preference'); break }
  }
  for (const pat of decisionPatterns) {
    if (pat.test(q)) { matched.add('decision'); break }
  }
  for (const pat of knowledgePatterns) {
    if (pat.test(q)) { matched.add('knowledge'); break }
  }

  // Note: 'fact' is the default/fallback category — we don't boost it
  // because most queries implicitly seek factual information.

  if (matched.size > 0) {
    log.debug({ query: query.slice(0, 80), categories: Array.from(matched) }, 'Query intent detected')
  }

  return matched
}

// ─── Hybrid Search (FTS5 + sqlite-vec rank fusion) ───────────────────────────

type ScoreMapEntry = { score: number; content: string; category: string; subject: string | null; sourceContext: string | null; importance: number | null; retrievalCount: number; scope: MemoryScope; agentId: string; updatedAt: Date | null }

/**
 * Run hybrid search for a single query and accumulate RRF scores into a shared score map.
 */
async function hybridSearchSingleQuery(
  agentId: string,
  query: string,
  candidateLimit: number,
  scoreMap: Map<string, ScoreMapEntry>,
  K: number,
  ftsBoost: number,
): Promise<void> {
  const [vecResults, ftsResults] = await Promise.all([
    searchByVector(agentId, query, candidateLimit),
    searchByFTS(agentId, query, candidateLimit),
  ])

  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i]!
    const existing = scoreMap.get(r.id)
    const rrfScore = 1 / (K + i + 1)
    if (existing) {
      existing.score += rrfScore
    } else {
      scoreMap.set(r.id, { score: rrfScore, content: r.content, category: r.category, subject: r.subject, sourceContext: r.sourceContext, importance: r.importance, retrievalCount: r.retrievalCount, scope: r.scope, agentId: r.agentId, updatedAt: r.updatedAt })
    }
  }
  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i]!
    const existing = scoreMap.get(r.id)
    // Apply FTS boost: gives keyword matches more influence in the fused score
    const rrfScore = ftsBoost / (K + i + 1)
    if (existing) {
      existing.score += rrfScore
    } else {
      scoreMap.set(r.id, { score: rrfScore, content: r.content, category: r.category, subject: r.subject, sourceContext: r.sourceContext, importance: r.importance, retrievalCount: r.retrievalCount, scope: r.scope, agentId: r.agentId, updatedAt: r.updatedAt })
    }
  }
}

/**
 * Search memories using hybrid search: semantic (sqlite-vec KNN) + textual (FTS5).
 * When multi-query is enabled, generates query variations first for better recall.
 * Results are merged via reciprocal rank fusion scoring, then weighted by temporal decay.
 */
export async function searchMemories(
  agentId: string,
  query: string,
  limit?: number,
): Promise<MemorySearchResult[]> {
  const maxResults = limit ?? config.memory.maxRelevantMemories
  const useRerank = !!config.memory.rerankModel
  // When re-ranking, fetch more candidates to give the LLM a wider pool
  const fetchLimit = useRerank ? maxResults * 3 : maxResults
  const K = config.memory.rrfK
  const ftsBoost = config.memory.ftsBoost
  const scoreMap = new Map<string, ScoreMapEntry>()

  // Generate query variations (multi-query) and/or hypothetical document (HyDE)
  const [multiQueries, hydeDoc] = await Promise.all([
    config.memory.multiQueryModel
      ? generateQueryVariations(query, await getDistinctSubjects(agentId), agentId)
      : Promise.resolve([query]),
    generateHypotheticalMemory(query, agentId),
  ])

  // Combine: multi-query variations + HyDE hypothetical doc (if generated)
  const queries = hydeDoc ? [...multiQueries, hydeDoc] : multiQueries

  if (queries.length > 1) {
    log.debug({ agentId, queries: queries.length, hasHyDE: !!hydeDoc }, 'Multi-query search')
  }

  // Run hybrid search for each query variation in parallel
  const candidateLimit = maxResults * 2
  await Promise.all(
    queries.map((q) => hybridSearchSingleQuery(agentId, q, candidateLimit, scoreMap, K, ftsBoost)),
  )

  // Detect subjects mentioned in the query for score boosting
  const knownSubjects = await getDistinctSubjects(agentId)
  const queryLower = query.toLowerCase()
  const matchedSubjects = new Set(
    knownSubjects.filter((s) => queryLower.includes(s.toLowerCase())),
  )
  const subjectBoostFactor = config.memory.subjectBoost ?? 1.3

  // Detect query intent to boost matching memory categories (zero-cost regex-based)
  const intentCategories = detectQueryIntentCategories(query)
  const categoryBoostFactor = config.memory.categoryBoost ?? 1.25

  // Apply temporal decay, importance weighting, retrieval frequency boost, subject boost, and category intent boost to fused scores
  for (const [, data] of scoreMap) {
    const decay = temporalDecayWeight(data.updatedAt, data.category, data.importance)
    const imp = data.importance ?? 5
    const importanceWeight = 0.5 + (imp / 10)
    // Logarithmic retrieval frequency boost capped at +20% so a memory
    // retrieved hundreds of times can't snowball past everything else
    // forever (positive feedback: more retrievals → more boost → more
    // retrievals → ...). Cap reached around retrieval_count ~= 256.
    const retrievalBoost = Math.min(1.2, 1 + Math.log2(1 + data.retrievalCount) * 0.05)
    // Subject boost: if the memory's subject matches an entity mentioned in the query, boost its score
    const subjectBoost = data.subject && matchedSubjects.has(data.subject) ? subjectBoostFactor : 1.0
    // Category intent boost: if query intent matches this memory's category, boost its score
    const categoryBoost = intentCategories.has(data.category) ? categoryBoostFactor : 1.0
    // Recency boost: explicitly favor very recent memories (complements temporal decay)
    const recentBoost = recencyBoost(data.updatedAt)
    data.score *= decay * importanceWeight * retrievalBoost * subjectBoost * categoryBoost * recentBoost
  }

  // Sort by weighted score descending
  const sorted = Array.from(scoreMap.entries())
    .map(([id, data]) => ({ id, content: data.content, category: data.category, subject: data.subject, sourceContext: data.sourceContext, importance: data.importance, scope: data.scope, authorAgentId: data.agentId, score: data.score, updatedAt: data.updatedAt }))
    .sort((a, b) => b.score - a.score)
    .slice(0, fetchLimit)

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

  // Apply re-ranking if enabled: try cross-encoder API first, fall back to LLM
  if (useRerank && sorted.length > 0) {
    const reranked = await rerankCandidates(query, sorted, maxResults, agentId)
    return applyAdaptiveK(reranked)
  }

  return applyAdaptiveK(sorted.slice(0, maxResults))
}

/**
 * Semantic search using sqlite-vec KNN.
 */
async function searchByVector(
  agentId: string,
  query: string,
  limit: number,
): Promise<Array<{ id: string; content: string; category: string; subject: string | null; sourceContext: string | null; importance: number | null; retrievalCount: number; distance: number; scope: MemoryScope; agentId: string; updatedAt: Date | null }>> {
  try {
    const queryEmbedding = await generateEmbedding(query)
    const queryBuf = Buffer.from(new Float32Array(queryEmbedding).buffer)

    const rows = sqlite
      .query<{ memory_id: string; distance: number }, [Buffer, number]>(
        `SELECT memory_id, distance
         FROM memories_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(queryBuf, limit)

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
        string[]
      >(
        `SELECT id, agent_id, content, category, subject, source_context, importance, retrieval_count, scope, updated_at FROM memories
         WHERE id IN (${placeholders}) AND (agent_id = ? OR scope = 'shared')`,
      )
      .all(...matchingIds, agentId)

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

    const stmt = sqlite.query<
      { id: string; agent_id: string; content: string; category: string; subject: string | null; source_context: string | null; importance: number | null; retrieval_count: number; scope: string; rank: number; updated_at: string | null },
      [string, string, number]
    >(
      `SELECT m.id, m.agent_id, m.content, m.category, m.subject, m.source_context, m.importance, m.retrieval_count, m.scope, fts.rank, m.updated_at
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE memories_fts MATCH ? AND (m.agent_id = ? OR m.scope = 'shared')
       ORDER BY fts.rank
       LIMIT ?`,
    )

    // Try AND first (precise), fall back to OR (broad) if no results
    let rows = stmt.all(ftsQuery, agentId, limit)
    if (rows.length === 0 && terms.length > 1) {
      rows = stmt.all(ftsQueryOr, agentId, limit)
    }

    return Promise.resolve(rows.map((r) => ({ ...r, agentId: r.agent_id, sourceContext: r.source_context, retrievalCount: r.retrieval_count, scope: r.scope as MemoryScope, updatedAt: r.updated_at ? new Date(r.updated_at) : null })))
  } catch {
    return Promise.resolve([])
  }
}

// ─── LLM Re-ranking ─────────────────────────────────────────────────────────

/**
 * Re-rank memory search results using an LLM for better precision.
 */
async function rerankCandidates(
  query: string,
  candidates: MemorySearchResult[],
  limit: number,
  agentId?: string,
): Promise<MemorySearchResult[]> {
  const rerankModel = config.memory.rerankModel
  if (!rerankModel || candidates.length === 0) return candidates.slice(0, limit)
  return rerankWithLLM(query, candidates, limit, agentId)
}

/**
 * Takes the top candidates from hybrid search and asks an LLM to score
 * each memory's relevance to the query on a 0-10 scale.
 * Falls back to original ordering if the LLM call fails.
 */
async function rerankWithLLM(
  query: string,
  candidates: MemorySearchResult[],
  limit: number,
  agentId?: string,
): Promise<MemorySearchResult[]> {
  const rerankModel = config.memory.rerankModel
  if (!rerankModel || candidates.length === 0) return candidates.slice(0, limit)

  try {
    const { resolveLLM } = await import('@/server/llm/core/resolve')
    let resolved
    try {
      resolved = await resolveLLM({ modelId: rerankModel, providerId: config.memory.rerankProviderId ?? null })
    } catch { return candidates.slice(0, limit) }

    // Build a numbered list of memory snippets (truncate long ones)
    const memoryList = candidates
      .map((m, i) => `[${i}] (${m.category}${m.subject ? `, subject: ${m.subject}` : ''}) ${m.content.slice(0, 300)}`)
      .join('\n')

    const result = await safeGenerateText({
      resolved,
      callSite: 'memory-rerank',
      timeoutMs: config.memory.retrievalLlmTimeoutMs,
      agentId,
      prompt:
        `You are a relevance judge. Given a user query and a list of memory snippets, ` +
        `score each memory's relevance to the query from 0 (irrelevant) to 10 (highly relevant).\n\n` +
        `Query: "${query}"\n\n` +
        `Memories:\n${memoryList}\n\n` +
        `Return ONLY a JSON array of objects with "index" and "score" fields, sorted by score descending. ` +
        `Example: [{"index":2,"score":9},{"index":0,"score":7},{"index":1,"score":3}]`,
    })

    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return candidates.slice(0, limit)

    const scores = JSON.parse(jsonMatch[0]) as Array<{ index: number; score: number }>
    if (!Array.isArray(scores) || scores.length === 0) return candidates.slice(0, limit)

    // Validate and rebuild results with LLM scores blended into existing scores
    const reranked: MemorySearchResult[] = []
    for (const entry of scores) {
      if (typeof entry.index !== 'number' || entry.index < 0 || entry.index >= candidates.length) continue
      if (typeof entry.score !== 'number') continue

      const original = candidates[entry.index]!
      // Blend: use LLM score as primary, original hybrid score as tiebreaker
      reranked.push({
        ...original,
        score: (entry.score / 10) + (original.score * 0.01),
      })
    }

    // Sort by blended score descending
    reranked.sort((a, b) => b.score - a.score)

    // If LLM missed some candidates, append them at the end
    if (reranked.length < candidates.length) {
      const seen = new Set(reranked.map((r) => r.id))
      for (const c of candidates) {
        if (!seen.has(c.id)) reranked.push(c)
      }
    }

    log.debug({ query: query.slice(0, 80), candidates: candidates.length, reranked: reranked.length }, 'LLM re-ranking complete')
    return reranked.slice(0, limit)
  } catch (err) {
    log.debug({ err }, 'LLM re-ranking failed, using original order')
    return candidates.slice(0, limit)
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

// ─── Conversational Query Rewriting ──────────────────────────────────────────

/**
 * Determine if a user message is likely too short or ambiguous to produce
 * good memory retrieval on its own. Uses character length and pattern matching.
 */
function needsContextualRewrite(message: string): boolean {
  const threshold = config.memory.contextualRewriteThreshold
  if (message.length > threshold) return false

  // Always rewrite very short messages
  if (message.length < 20) return true

  // Check for follow-up patterns (pronouns, short answers, references)
  const followUpPatterns = /^(yes|no|ok|oui|non|d'accord|yeah|yep|nope|sure|exactly|right|correct|why|how|what|when|where|who|it|this|that|these|those|he|she|they|him|her|them|and |but |so |also |the same|me too|agreed|perfect|thanks|merci|pareil|idem|voilà)\b/i
  if (followUpPatterns.test(message.trim())) return true

  // Check for very few words (< 5 words and < threshold chars)
  const wordCount = message.trim().split(/\s+/).length
  if (wordCount < 5) return true

  return false
}

/**
 * Rewrite a short/ambiguous user message into a standalone query for memory retrieval,
 * incorporating recent conversation context.
 *
 * This prevents poor retrieval when users send follow-ups like "yes", "what about that?",
 * or other messages that only make sense in conversational context.
 *
 * Returns the original message if rewriting is disabled, unnecessary, or fails.
 */
export async function rewriteQueryWithContext(
  message: string,
  recentMessages: Array<{ role: string; content: string }>,
  agentId?: string,
): Promise<string> {
  const model = config.memory.contextualRewriteModel
  if (!model || !needsContextualRewrite(message) || recentMessages.length === 0) {
    return message
  }

  try {
    const { resolveLLM } = await import('@/server/llm/core/resolve')
    let resolved
    try {
      resolved = await resolveLLM({ modelId: model, providerId: config.memory.contextualRewriteProviderId ?? null })
    } catch { return message }

    // Build a compact conversation snippet (last 4 turns max)
    const context = recentMessages
      .slice(-4)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`)
      .join('\n')

    const result = await safeGenerateText({
      resolved,
      callSite: 'memory-contextual-rewrite',
      timeoutMs: config.memory.retrievalLlmTimeoutMs,
      agentId,
      prompt:
        `Rewrite the user's last message into a standalone search query for retrieving relevant memories. ` +
        `The query should capture the full intent by incorporating context from the conversation.\n\n` +
        `Conversation:\n${context}\n\nLast message: "${message}"\n\n` +
        `Return ONLY the rewritten query, nothing else. Keep it concise (1-2 sentences max). ` +
        `If the message is already self-contained, return it unchanged.`,
    })

    const rewritten = result.text.trim().replace(/^["']|["']$/g, '')
    if (rewritten.length > 0 && rewritten.length < 500) {
      log.debug({ original: message, rewritten }, 'Query rewritten with conversation context')
      return rewritten
    }
    return message
  } catch (err) {
    log.debug({ err }, 'Contextual query rewrite failed, using original')
    return message
  }
}

// ─── Convenience: retrieve relevant memories for prompt injection ────────────

/**
 * Retrieve the most relevant memories for a given query (incoming user message).
 * Used by agent-engine.ts for Block [5] injection.
 */
export async function getRelevantMemories(
  agentId: string,
  query: string,
): Promise<Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; scope: MemoryScope; authorAgentName?: string | null; updatedAt: Date | null; score: number }>> {
  const results = await searchMemories(agentId, query, config.memory.maxRelevantMemories)
  // Track which memories were actually injected into the prompt (fire-and-forget)
  trackRetrievals(results.map((r) => r.id))
  return results.map((r) => ({ id: r.id, category: r.category, content: r.content, subject: r.subject, importance: r.importance, scope: r.scope, authorAgentName: r.authorAgentName, updatedAt: r.updatedAt, score: r.score }))
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

// ─── Importance Recalibration ────────────────────────────────────────────────

/**
 * Recalibrate importance scores for memories based on retrieval patterns.
 *
 * For memories older than 7 days with retrieval data, gently nudge importance:
 * - Frequently retrieved memories get a bump (the system finds them useful)
 * - Never-retrieved old memories get a slight decrease (likely less relevant)
 *
 * Adjustments are small (±0.5 per run, clamped to [1, 10]) to avoid overcorrection.
 * Returns the number of memories adjusted.
 */
export async function recalibrateImportance(agentId: string): Promise<number> {
  const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
  const now = Date.now()

  const allMems = sqlite.query<
    { id: string; importance: number; retrieval_count: number; created_at: number; last_retrieved_at: number | null },
    [string]
  >(
    `SELECT id, importance, retrieval_count, created_at, last_retrieved_at
     FROM memories
     WHERE agent_id = ? AND importance IS NOT NULL`,
  ).all(agentId)

  let adjusted = 0
  const adjustedIds: string[] = []

  for (const mem of allMems) {
    const ageMs = now - mem.created_at
    if (ageMs < MIN_AGE_MS) continue // Too young for recalibration

    const ageDays = ageMs / (24 * 60 * 60 * 1000)
    // Expected retrievals: rough heuristic — ~0.1 per day for average memory
    const expectedRetrievals = ageDays * 0.1
    const ratio = expectedRetrievals > 0 ? mem.retrieval_count / expectedRetrievals : 0

    let delta = 0
    if (ratio >= 2.0) {
      // Retrieved much more than expected — bump up (small, was 0.5).
      // Larger values created a positive feedback loop: more retrievals
      // → higher importance → higher score multiplier → more retrievals.
      // After many recalibrations a single popular memory snowballed to
      // importance 10 and crowded out everything else.
      delta = 0.2
    } else if (ratio >= 1.0) {
      // At expected retrieval rate — no reward. Previously +0.2 here was
      // basically free importance for memories that just kept getting
      // surfaced; combined with the >=2.0 bump it made the runaway
      // worse.
      delta = 0
    } else if (mem.retrieval_count === 0 && ageDays > 30) {
      // Never retrieved in 30+ days — slight decrease.
      delta = -0.3
    } else if (ratio < 0.3 && ageDays > 14) {
      // Retrieved much less than expected — slight decrease.
      delta = -0.2
    } else {
      continue // No adjustment needed
    }
    if (delta === 0) continue

    const newImportance = Math.max(1, Math.min(10, Math.round((mem.importance + delta) * 10) / 10))
    if (newImportance === mem.importance) continue

    sqlite.run(
      `UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?`,
      [newImportance, now, mem.id],
    )
    adjustedIds.push(mem.id)
    adjusted++
  }

  if (adjusted > 0) {
    log.info({ agentId, adjusted, total: allMems.length }, 'Importance recalibration complete')

    // Emit one aggregate SSE event so connected clients refetch their memory
    // lists with updated importance scores. A single event is sufficient
    // because the memory:updated handler in useMemories calls fetchMemories().
    sseManager.sendToAgent(agentId, {
      type: 'memory:updated',
      agentId,
      data: { agentId, memoryIds: adjustedIds, reason: 'recalibration' },
    })
  }

  return adjusted
}

// ─── Automated Stale Memory Pruning ─────────────────────────────────────────

/**
 * Prune memories that have decayed to very low importance and are never retrieved.
 * This is the natural end of the importance recalibration lifecycle:
 * recalibration gradually lowers scores → pruning removes the dead weight.
 *
 * Thresholds (conservative):
 * - importance ≤ 1 AND never retrieved AND older than 60 days → prune
 * - importance ≤ 2 AND never retrieved AND older than 90 days → prune
 *
 * Returns the number of memories pruned.
 */
export async function pruneStaleMemories(agentId: string): Promise<number> {
  const now = Date.now()
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

  // Find candidates: low importance, never retrieved, old enough
  const candidates = sqlite.query<
    { id: string; importance: number; retrieval_count: number; created_at: number; content: string },
    [string]
  >(
    `SELECT id, importance, retrieval_count, created_at, content
     FROM memories
     WHERE agent_id = ?
       AND importance IS NOT NULL
       AND retrieval_count = 0`,
  ).all(agentId)

  let pruned = 0

  for (const mem of candidates) {
    const ageMs = now - mem.created_at

    const shouldPrune =
      (mem.importance <= 1 && ageMs > SIXTY_DAYS_MS) ||
      (mem.importance <= 2 && ageMs > NINETY_DAYS_MS)

    if (!shouldPrune) continue

    log.info(
      { agentId, memoryId: mem.id, importance: mem.importance, ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)), content: mem.content.slice(0, 100) },
      'Pruning stale memory',
    )

    await deleteMemory(mem.id, agentId)
    pruned++
  }

  if (pruned > 0) {
    log.info({ agentId, pruned, candidates: candidates.length }, 'Stale memory pruning complete')
  }

  return pruned
}
