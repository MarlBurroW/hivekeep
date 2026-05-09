import { safeGenerateText } from '@/server/services/llm-helpers'
import { eq } from 'drizzle-orm'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { memories } from '@/server/db/schema'
import { generateEmbedding } from '@/server/services/embeddings'
import { config } from '@/server/config'
import { deleteMemory, createMemory } from '@/server/services/memory'

const log = createLogger('consolidation')

interface MemoryRow {
  id: string
  content: string
  category: string
  subject: string | null
  importance: number | null
  consolidationGeneration: number
  embedding: Buffer | null
}

/**
 * Find clusters of near-duplicate memories using pairwise cosine similarity.
 * Only compares memories that haven't reached the generation ceiling.
 */
function findSimilarClusters(
  mems: MemoryRow[],
  threshold: number,
): Array<[MemoryRow, MemoryRow]> {
  const pairs: Array<[MemoryRow, MemoryRow]> = []

  for (let i = 0; i < mems.length; i++) {
    const a = mems[i]!
    if (!a.embedding) continue

    const vecA = new Float32Array(a.embedding.buffer, a.embedding.byteOffset, a.embedding.byteLength / 4)

    for (let j = i + 1; j < mems.length; j++) {
      const b = mems[j]!
      if (!b.embedding) continue

      const vecB = new Float32Array(b.embedding.buffer, b.embedding.byteOffset, b.embedding.byteLength / 4)

      const similarity = cosineSimilarity(vecA, vecB)
      if (similarity >= threshold) {
        pairs.push([a, b])
      }
    }
  }

  return pairs
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Group overlapping pairs into clusters using union-find.
 */
function clusterPairs(pairs: Array<[MemoryRow, MemoryRow]>): MemoryRow[][] {
  const parent = new Map<string, string>()
  const memMap = new Map<string, MemoryRow>()

  function find(id: string): string {
    if (!parent.has(id)) parent.set(id, id)
    if (parent.get(id) !== id) parent.set(id, find(parent.get(id)!))
    return parent.get(id)!
  }

  function union(a: string, b: string) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const [a, b] of pairs) {
    memMap.set(a.id, a)
    memMap.set(b.id, b)
    union(a.id, b.id)
  }

  const groups = new Map<string, MemoryRow[]>()
  for (const [id, mem] of memMap) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(mem)
  }

  return Array.from(groups.values()).filter((g) => g.length >= 2)
}

/**
 * Use LLM to merge a cluster of similar memories into a single, richer memory.
 */
async function mergeCluster(
  cluster: MemoryRow[],
  model: Awaited<ReturnType<typeof import('@/server/services/kin-engine').resolveLLMModel>>,
  providerId?: string | null,
  kinId?: string,
  modelId?: string,
): Promise<{ content: string; category: string; subject: string | null; importance: number } | null> {
  if (!model) return null

  const memoriesText = cluster
    .map((m, i) => `${i + 1}. [${m.category}${m.subject ? `, subject: ${m.subject}` : ''}${m.importance ? `, importance: ${m.importance}` : ''}] ${m.content}`)
    .join('\n')

  const prompt =
    `You are merging near-duplicate memories into a single, richer memory.\n\n` +
    `## Memories to merge\n\n${memoriesText}\n\n` +
    `Rules:\n` +
    `- First, verify these memories are TRULY about the same topic. If they describe genuinely different facts or subjects, return {"abort": true}\n` +
    `- Combine all information into a clear, standalone statement (1-3 sentences as needed to preserve all details)\n` +
    `- Preserve ALL unique details from each memory — information loss is worse than a slightly longer result\n` +
    `- If memories contradict, keep the most specific/recent version\n` +
    `- Pick the most appropriate category and subject\n` +
    `- Rate importance 1-10 (use the max importance from the sources, or higher if the merged result is richer)\n\n` +
    `Return exactly one JSON object:\n` +
    `{"content": "...", "category": "fact|preference|decision|knowledge", "subject": "...", "importance": N}\n` +
    `Or if memories should NOT be merged: {"abort": true}`

  try {
    const result = await safeGenerateText({
      model,
      providerId,
      prompt,
      // Output is a single small JSON object ({content, category, subject,
      // importance} or {abort: true}). 1500 is generous.
      maxTokens: 1500,
      // Hard timeout per pair. consolidateMemories iterates over many pairs
      // of near-duplicate memories — without per-call timeout, one stuck
      // provider call would hang the whole consolidation, which is itself
      // awaited inside runCompacting under the compactingKins lock.
      timeoutMs: 2 * 60 * 1000,
      callSite: 'consolidation',
      modelId,
      kinId,
    })

    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const parsed = JSON.parse(jsonMatch[0]) as {
      content?: string
      category?: string
      subject?: string
      importance?: number
      abort?: boolean
    }

    // LLM determined these memories are about different topics — skip merge
    if (parsed.abort) {
      log.info({ clusterSize: cluster.length, ids: cluster.map(m => m.id) }, 'LLM aborted merge — memories not truly duplicates')
      return null
    }

    if (!parsed.content || !parsed.category) return null

    return {
      content: parsed.content,
      category: parsed.category,
      subject: parsed.subject || cluster[0]!.subject,
      importance: Math.max(1, Math.min(10, Math.round(parsed.importance ?? 5))),
    }
  } catch (err) {
    log.error({ err }, 'Merge LLM error')
    return null
  }
}

/**
 * Run memory consolidation for a Kin.
 * Finds near-duplicate memories, merges them via LLM, replaces originals.
 * Returns the number of memories consolidated (removed).
 */
export async function consolidateMemories(kinId: string): Promise<number> {
  const maxGen = config.memory.consolidationMaxGeneration
  const threshold = config.memory.consolidationSimilarityThreshold

  // Load all memories with embeddings that haven't reached the generation ceiling
  const allMemories = await db
    .select()
    .from(memories)
    .where(eq(memories.kinId, kinId))
    .all()

  const eligible = allMemories.filter(
    (m) => m.embedding && m.consolidationGeneration < maxGen
  ) as MemoryRow[]

  if (eligible.length < 2) {
    log.debug({ kinId, count: eligible.length }, 'Not enough eligible memories for consolidation')
    return 0
  }

  log.info({ kinId, eligible: eligible.length }, 'Starting memory consolidation')

  // Phase 1: Find similar pairs, partitioned by subject for efficiency
  // Memories with the same subject are compared at the configured threshold.
  // Cross-subject memories are compared at a higher threshold (0.95) to avoid false merges.
  const crossSubjectThreshold = Math.max(threshold, 0.95)

  // Group by subject (null subject = "general")
  const bySubject = new Map<string, MemoryRow[]>()
  for (const m of eligible) {
    const key = m.subject ?? '__general__'
    if (!bySubject.has(key)) bySubject.set(key, [])
    bySubject.get(key)!.push(m)
  }

  // Within-subject pairs at normal threshold
  let pairs: Array<[MemoryRow, MemoryRow]> = []
  for (const group of bySubject.values()) {
    if (group.length >= 2) {
      pairs.push(...findSimilarClusters(group, threshold))
    }
  }

  // Cross-subject pairs at higher threshold (only if not too many subjects)
  const subjectKeys = Array.from(bySubject.keys())
  if (subjectKeys.length <= 20) {
    for (let i = 0; i < subjectKeys.length; i++) {
      for (let j = i + 1; j < subjectKeys.length; j++) {
        const groupA = bySubject.get(subjectKeys[i]!)!
        const groupB = bySubject.get(subjectKeys[j]!)!
        // Only cross-compare small groups to bound cost
        if (groupA.length * groupB.length <= 100) {
          const combined = [...groupA, ...groupB]
          const crossPairs = findSimilarClusters(combined, crossSubjectThreshold)
          // Only keep actual cross-subject pairs
          pairs.push(...crossPairs.filter(([a, b]) => (a.subject ?? '__general__') !== (b.subject ?? '__general__')))
        }
      }
    }
  }
  if (pairs.length === 0) {
    log.info({ kinId }, 'No near-duplicate memories found')
    return 0
  }

  // Group overlapping pairs into clusters
  const rawClusters = clusterPairs(pairs)

  // Cap cluster size at 3 to avoid information loss in large merges.
  // Larger clusters will be partially merged; subsequent runs handle the rest.
  const MAX_CLUSTER_SIZE = 3
  const clusters: MemoryRow[][] = []
  for (const cluster of rawClusters) {
    if (cluster.length <= MAX_CLUSTER_SIZE) {
      clusters.push(cluster)
    } else {
      // Sort by importance (desc) so we merge the most related first
      cluster.sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5))
      for (let i = 0; i < cluster.length; i += MAX_CLUSTER_SIZE) {
        const chunk = cluster.slice(i, i + MAX_CLUSTER_SIZE)
        if (chunk.length >= 2) clusters.push(chunk)
      }
    }
  }

  log.info({ kinId, rawClusters: rawClusters.length, clusters: clusters.length, pairs: pairs.length }, 'Found memory clusters')

  // Phase 2: Merge each cluster via LLM
  const { resolveLLMModel } = await import('@/server/services/kin-engine')
  const model = await resolveLLMModel(
    config.memory.consolidationModel ?? config.compacting.model ?? 'gpt-4.1-nano',
    config.memory.consolidationProviderId ?? config.compacting.providerId ?? null,
  )

  let totalRemoved = 0

  for (const cluster of clusters) {
    const consolidationModelId = config.memory.consolidationModel ?? config.compacting.model ?? 'gpt-4.1-nano'
    const merged = await mergeCluster(cluster, model, config.memory.consolidationProviderId ?? config.compacting.providerId ?? null, kinId, consolidationModelId)
    if (!merged) continue

    // Compute the new generation: max of sources + 1
    const newGen = Math.min(
      maxGen,
      Math.max(...cluster.map((m) => m.consolidationGeneration)) + 1,
    )

    const sourceIds = cluster.map((m) => m.id)

    // Create the merged memory
    const newMemory = await createMemory(kinId, {
      content: merged.content,
      category: merged.category as 'fact' | 'preference' | 'decision' | 'knowledge',
      subject: merged.subject,
      importance: merged.importance,
      sourceChannel: 'automatic',
    })

    if (!newMemory) continue

    // Update generation and lineage on the new memory
    await db
      .update(memories)
      .set({
        consolidationGeneration: newGen,
        consolidatedFromIds: JSON.stringify(sourceIds),
      })
      .where(eq(memories.id, newMemory.id))

    // Delete the source memories
    for (const sourceId of sourceIds) {
      await deleteMemory(sourceId, kinId)
    }

    totalRemoved += cluster.length - 1 // net reduction (cluster.length removed, 1 added)
    log.info(
      { kinId, merged: cluster.length, newGen, newMemoryId: newMemory.id },
      'Consolidated memory cluster',
    )
  }

  log.info({ kinId, totalRemoved, clusters: clusters.length }, 'Memory consolidation complete')
  return totalRemoved
}
