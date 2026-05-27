import { eq, and, desc, count, sql } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { projectKnowledge, kins } from '@/server/db/schema'
import { generateEmbedding } from '@/server/services/embeddings'
import { config } from '@/server/config'
import type { ProjectKnowledge, ProjectKnowledgeSearchHit, ProjectKnowledgeIndexEntry } from '@/shared/types'

const log = createLogger('project-knowledge')

/** Max chars accepted for a knowledge title. Kept short on purpose — the
 *  title lands in every Kin's system-prompt index, so a runaway title from
 *  a single entry would inflate every Kin's prompt forever. */
export const PROJECT_KNOWLEDGE_TITLE_MAX = 200

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreateInput {
  projectId: string
  title: string
  content: string
  category?: string | null
  pinned?: boolean
  authorKinId?: string | null
}

interface UpdateInput {
  title?: string
  content?: string
  category?: string | null
  pinned?: boolean
}

interface ListFilters {
  category?: string
  pinned?: boolean
  limit?: number
  offset?: number
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when trying to pin an entry would exceed the per-project pin cap.
 * Carries a typed `code` so routes/tools can surface it to the user as a
 * structured error (`PIN_CAP_EXCEEDED`).
 */
export class PinCapExceededError extends Error {
  readonly code = 'PIN_CAP_EXCEEDED'
  constructor(public readonly cap: number) {
    super(`Cannot pin more than ${cap} entries per project. Unpin one first.`)
  }
}

/**
 * Thrown when create/update is called with an empty or whitespace-only title.
 * The DB column has DEFAULT '' for migration safety; we enforce non-empty at
 * the service layer so callers (tools, REST) get a typed error to surface.
 */
export class InvalidKnowledgeTitleError extends Error {
  readonly code = 'INVALID_TITLE'
  constructor(message = 'Knowledge title is required and cannot be empty.') {
    super(message)
  }
}

function normalizeTitle(raw: string): string {
  // Collapse whitespace, strip line breaks, truncate. Titles ride in every
  // turn's prompt index — multi-line or huge titles would corrupt the layout.
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.slice(0, PROJECT_KNOWLEDGE_TITLE_MAX)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type DbRow = typeof projectKnowledge.$inferSelect

async function resolveAuthorKinName(authorKinId: string | null): Promise<string | null> {
  if (!authorKinId) return null
  try {
    const row = db.select({ name: kins.name }).from(kins).where(eq(kins.id, authorKinId)).get()
    return row?.name ?? null
  } catch {
    return null
  }
}

function rowToProjectKnowledge(row: DbRow, authorKinName: string | null = null): ProjectKnowledge {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    content: row.content,
    category: row.category,
    pinned: row.pinned,
    authorKinId: row.authorKinId,
    authorKinName,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }
}

async function hydrateAuthorNames(rows: DbRow[]): Promise<ProjectKnowledge[]> {
  const kinIds = [...new Set(rows.map((r) => r.authorKinId).filter((id): id is string => !!id))]
  let kinNameMap = new Map<string, string>()
  if (kinIds.length > 0) {
    try {
      const placeholders = kinIds.map(() => '?').join(', ')
      const kinRows = sqlite
        .query<{ id: string; name: string }, string[]>(
          `SELECT id, name FROM kins WHERE id IN (${placeholders})`,
        )
        .all(...kinIds)
      kinNameMap = new Map(kinRows.map((k) => [k.id, k.name]))
    } catch {
      // ignore — names fall back to null
    }
  }
  return rows.map((r) => rowToProjectKnowledge(r, r.authorKinId ? kinNameMap.get(r.authorKinId) ?? null : null))
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function getProjectKnowledge(id: string): Promise<ProjectKnowledge | null> {
  const row = db.select().from(projectKnowledge).where(eq(projectKnowledge.id, id)).get()
  if (!row) return null
  const authorKinName = await resolveAuthorKinName(row.authorKinId)
  return rowToProjectKnowledge(row, authorKinName)
}

export async function countProjectKnowledge(projectId: string): Promise<number> {
  const row = db
    .select({ n: count() })
    .from(projectKnowledge)
    .where(eq(projectKnowledge.projectId, projectId))
    .get()
  return row?.n ?? 0
}

export async function countPinnedKnowledge(projectId: string): Promise<number> {
  const row = db
    .select({ n: count() })
    .from(projectKnowledge)
    .where(and(eq(projectKnowledge.projectId, projectId), eq(projectKnowledge.pinned, true)))
    .get()
  return row?.n ?? 0
}

export async function listProjectKnowledge(
  projectId: string,
  filters: ListFilters = {},
): Promise<ProjectKnowledge[]> {
  const conditions = [eq(projectKnowledge.projectId, projectId)]
  if (filters.category !== undefined) conditions.push(eq(projectKnowledge.category, filters.category))
  if (filters.pinned !== undefined) conditions.push(eq(projectKnowledge.pinned, filters.pinned))

  let query = db
    .select()
    .from(projectKnowledge)
    .where(and(...conditions))
    .orderBy(desc(projectKnowledge.pinned), desc(projectKnowledge.updatedAt))
    .$dynamic()

  if (filters.limit !== undefined) query = query.limit(filters.limit)
  if (filters.offset !== undefined) query = query.offset(filters.offset)

  const rows = query.all()
  return hydrateAuthorNames(rows)
}

/**
 * Top-N pinned entries for a project, sorted by updatedAt DESC. Deterministic
 * ordering is critical: this content goes into a cache-stable system prompt
 * block, so any non-deterministic sort would bust the prompt cache.
 */
export async function getPinnedKnowledge(
  projectId: string,
  limit: number = config.projectKnowledge.pinCap,
): Promise<ProjectKnowledge[]> {
  const rows = db
    .select()
    .from(projectKnowledge)
    .where(and(eq(projectKnowledge.projectId, projectId), eq(projectKnowledge.pinned, true)))
    .orderBy(desc(projectKnowledge.updatedAt))
    .limit(limit)
    .all()
  return hydrateAuthorNames(rows)
}

/**
 * Lightweight projection of every project knowledge entry used to render the
 * "knowledge index" sub-section of the system prompt. Drops the content body
 * so we can ship 100+ titles at a fraction of the token cost of the full rows.
 *
 * Sorted: pinned first (matches the inline rendering above the index), then
 * updatedAt DESC. Both orderings are deterministic so the cached prompt
 * prefix stays byte-identical between turns when nothing changed.
 *
 * `limit` caps total entries returned — beyond this, the prompt renders a
 * "... and N more — use search_project_knowledge" footer so a runaway
 * knowledge base never blows up the system prompt.
 */
export async function listKnowledgeIndex(
  projectId: string,
  limit: number = config.projectKnowledge.maxIndexEntries,
): Promise<ProjectKnowledgeIndexEntry[]> {
  const rows = db
    .select({
      id: projectKnowledge.id,
      title: projectKnowledge.title,
      category: projectKnowledge.category,
      pinned: projectKnowledge.pinned,
      authorKinId: projectKnowledge.authorKinId,
    })
    .from(projectKnowledge)
    .where(eq(projectKnowledge.projectId, projectId))
    .orderBy(desc(projectKnowledge.pinned), desc(projectKnowledge.updatedAt))
    .limit(limit)
    .all()

  const kinIds = [...new Set(rows.map((r) => r.authorKinId).filter((id): id is string => !!id))]
  let kinNameMap = new Map<string, string>()
  if (kinIds.length > 0) {
    try {
      const placeholders = kinIds.map(() => '?').join(', ')
      const kinRows = sqlite
        .query<{ id: string; name: string }, string[]>(
          `SELECT id, name FROM kins WHERE id IN (${placeholders})`,
        )
        .all(...kinIds)
      kinNameMap = new Map(kinRows.map((k) => [k.id, k.name]))
    } catch {
      // ignore — names fall back to null
    }
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    pinned: r.pinned,
    authorKinName: r.authorKinId ? kinNameMap.get(r.authorKinId) ?? null : null,
  }))
}

export async function createProjectKnowledge(input: CreateInput): Promise<ProjectKnowledge> {
  const id = uuid()
  const now = new Date()
  const wantsPin = input.pinned === true

  const title = normalizeTitle(input.title ?? '')
  if (!title) throw new InvalidKnowledgeTitleError()

  // Enforce pin cap up front: a single race window is fine — concurrent pins
  // from two different Kin tool calls are exceedingly rare and the worst case
  // is one extra pin which is harmless.
  if (wantsPin) {
    const current = await countPinnedKnowledge(input.projectId)
    if (current >= config.projectKnowledge.pinCap) {
      throw new PinCapExceededError(config.projectKnowledge.pinCap)
    }
  }

  // Embed the title + content together so search hits a title-only query
  // even when the body is long-form markdown.
  const embedSource = `${title}\n\n${input.content}`
  let embeddingBuf: Buffer | null = null
  try {
    const embedding = await generateEmbedding(embedSource)
    embeddingBuf = Buffer.from(new Float32Array(embedding).buffer)
  } catch {
    // Embedding provider may not be available — store without vector;
    // FTS5 keyword search still works.
  }

  await db.insert(projectKnowledge).values({
    id,
    projectId: input.projectId,
    title,
    content: input.content,
    embedding: embeddingBuf,
    category: input.category ?? null,
    pinned: wantsPin,
    authorKinId: input.authorKinId ?? null,
    createdAt: now,
    updatedAt: now,
  })

  if (embeddingBuf) {
    try {
      sqlite.run(
        'INSERT INTO project_knowledge_vec(knowledge_id, embedding) VALUES (?, ?)',
        [id, embeddingBuf],
      )
    } catch {
      // sqlite-vec may not be available
    }
  }

  log.debug(
    { projectId: input.projectId, knowledgeId: id, pinned: wantsPin, hasEmbedding: !!embeddingBuf },
    'Project knowledge created',
  )

  const created = db.select().from(projectKnowledge).where(eq(projectKnowledge.id, id)).get()!
  const authorKinName = await resolveAuthorKinName(created.authorKinId)
  return rowToProjectKnowledge(created, authorKinName)
}

export async function updateProjectKnowledge(
  id: string,
  updates: UpdateInput,
): Promise<ProjectKnowledge | null> {
  const existing = db.select().from(projectKnowledge).where(eq(projectKnowledge.id, id)).get()
  if (!existing) return null

  // Enforce pin cap when pinning a previously-unpinned entry
  if (updates.pinned === true && !existing.pinned) {
    const current = await countPinnedKnowledge(existing.projectId)
    if (current >= config.projectKnowledge.pinCap) {
      throw new PinCapExceededError(config.projectKnowledge.pinCap)
    }
  }

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (updates.title !== undefined) {
    const normalized = normalizeTitle(updates.title)
    if (!normalized) throw new InvalidKnowledgeTitleError()
    setValues.title = normalized
  }
  if (updates.content !== undefined) setValues.content = updates.content
  if (updates.category !== undefined) setValues.category = updates.category
  if (updates.pinned !== undefined) setValues.pinned = updates.pinned

  // Re-embed when title or content changes — they're embedded together so
  // both shifts invalidate the vector.
  if (updates.content !== undefined || updates.title !== undefined) {
    const nextTitle = (setValues.title as string | undefined) ?? existing.title
    const nextContent = updates.content ?? existing.content
    try {
      const embedding = await generateEmbedding(`${nextTitle}\n\n${nextContent}`)
      const embeddingBuf = Buffer.from(new Float32Array(embedding).buffer)
      setValues.embedding = embeddingBuf
      try {
        sqlite.run('DELETE FROM project_knowledge_vec WHERE knowledge_id = ?', [id])
        sqlite.run(
          'INSERT INTO project_knowledge_vec(knowledge_id, embedding) VALUES (?, ?)',
          [id, embeddingBuf],
        )
      } catch {
        // sqlite-vec may not be available
      }
    } catch {
      // Embedding provider may not be available
    }
  }

  await db.update(projectKnowledge).set(setValues).where(eq(projectKnowledge.id, id))

  const updated = db.select().from(projectKnowledge).where(eq(projectKnowledge.id, id)).get()!
  const authorKinName = await resolveAuthorKinName(updated.authorKinId)
  return rowToProjectKnowledge(updated, authorKinName)
}

export async function deleteProjectKnowledge(id: string): Promise<boolean> {
  const existing = db.select().from(projectKnowledge).where(eq(projectKnowledge.id, id)).get()
  if (!existing) return false

  // vec0 virtual table has no FK awareness — delete from it BEFORE the row,
  // otherwise the row goes but the vector entry stays orphaned forever.
  try {
    sqlite.run('DELETE FROM project_knowledge_vec WHERE knowledge_id = ?', [id])
  } catch {
    // sqlite-vec may not be available
  }

  await db.delete(projectKnowledge).where(eq(projectKnowledge.id, id))
  log.debug({ knowledgeId: id, projectId: existing.projectId }, 'Project knowledge deleted')
  return true
}

export async function setPinned(id: string, pinned: boolean): Promise<ProjectKnowledge | null> {
  return updateProjectKnowledge(id, { pinned })
}

// ─── Hybrid Search (FTS5 + sqlite-vec rank fusion) ───────────────────────────

const RRF_K = 60
const FTS_BOOST = 0.5

interface ScoreEntry {
  score: number
  row: DbRow
}

async function searchByVector(projectId: string, query: string, limit: number): Promise<DbRow[]> {
  try {
    const embedding = await generateEmbedding(query)
    const queryBuf = Buffer.from(new Float32Array(embedding).buffer)

    const rows = sqlite
      .query<{ knowledge_id: string; distance: number }, [Buffer, number]>(
        `SELECT knowledge_id, distance
         FROM project_knowledge_vec
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`,
      )
      .all(queryBuf, limit)

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.knowledge_id)
    const dbRows = db
      .select()
      .from(projectKnowledge)
      .where(
        and(
          eq(projectKnowledge.projectId, projectId),
          sql`${projectKnowledge.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
        ),
      )
      .all()

    const rowMap = new Map(dbRows.map((r) => [r.id, r]))
    return rows.map((r) => rowMap.get(r.knowledge_id)).filter((r): r is DbRow => !!r)
  } catch {
    return []
  }
}

function searchByFTS(projectId: string, query: string, limit: number): DbRow[] {
  try {
    const terms = query
      .replace(/['"*(){}[\]:^~!@#$%&]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .map((t) => `${t}*`)

    if (terms.length === 0) return []

    const ftsQuery = terms.join(' OR ')

    const rows = sqlite
      .query<{ id: string; rank: number }, [string, string, number]>(
        `SELECT pk.id, project_knowledge_fts.rank
         FROM project_knowledge_fts
         JOIN project_knowledge pk ON pk.rowid = project_knowledge_fts.rowid
         WHERE project_knowledge_fts MATCH ? AND pk.project_id = ?
         ORDER BY project_knowledge_fts.rank
         LIMIT ?`,
      )
      .all(ftsQuery, projectId, limit)

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)
    const dbRows = db
      .select()
      .from(projectKnowledge)
      .where(sql`${projectKnowledge.id} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
      .all()

    const rowMap = new Map(dbRows.map((r) => [r.id, r]))
    return rows.map((r) => rowMap.get(r.id)).filter((r): r is DbRow => !!r)
  } catch {
    return []
  }
}

/**
 * Hybrid search for project knowledge: semantic (sqlite-vec KNN) +
 * full-text (FTS5), merged with Reciprocal Rank Fusion.
 *
 * Simpler than `searchMemories` on purpose: no multi-query expansion, no
 * HyDE, no reranker, no temporal decay. Project knowledge is curated and
 * short — the added cost doesn't pay off.
 */
export async function searchProjectKnowledge(
  projectId: string,
  query: string,
  limit: number = config.projectKnowledge.maxSearchResults,
): Promise<ProjectKnowledgeSearchHit[]> {
  const candidateLimit = limit * 2
  const [vec, fts] = await Promise.all([
    searchByVector(projectId, query, candidateLimit),
    Promise.resolve(searchByFTS(projectId, query, candidateLimit)),
  ])

  const scoreMap = new Map<string, ScoreEntry>()

  for (let i = 0; i < vec.length; i++) {
    const r = vec[i]!
    const s = 1 / (RRF_K + i + 1)
    const ex = scoreMap.get(r.id)
    if (ex) ex.score += s
    else scoreMap.set(r.id, { score: s, row: r })
  }
  for (let i = 0; i < fts.length; i++) {
    const r = fts[i]!
    const s = FTS_BOOST / (RRF_K + i + 1)
    const ex = scoreMap.get(r.id)
    if (ex) ex.score += s
    else scoreMap.set(r.id, { score: s, row: r })
  }

  const sorted = Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const hydrated = await hydrateAuthorNames(sorted.map((s) => s.row))
  return hydrated.map((pk, i) => ({ ...pk, score: sorted[i]!.score }))
}
