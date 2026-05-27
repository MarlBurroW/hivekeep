import { eq, and, count, desc, inArray, sql, ne } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { projects, projectTags, tickets, ticketTags, kins } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { DEFAULT_PROJECT_TAGS, TICKET_STATUSES, PROJECT_SLUG_REGEX } from '@/shared/constants'
import { generateSlug, ensureUniqueSlug } from '@/server/utils/slug'
import { GITHUB_REPO_REGEX, isValidGitBranch } from '@/shared/constants'
import { startClone, deleteClone } from '@/server/services/repo-clone'
import { createLogger } from '@/server/logger'
import type { Project, ProjectSummary, ProjectTag, TicketStatus, KinThinkingConfig, CloneStatus } from '@/shared/types'

const log = createLogger('projects')
import type { ActiveProjectPromptInfo } from '@/server/services/prompt-builder'
import { getPinnedKnowledge, countProjectKnowledge, listKnowledgeIndex } from '@/server/services/project-knowledge'

// ─── Internal helpers ─────────────────────────────────────────────────────────

function rowToProjectTag(row: typeof projectTags.$inferSelect): ProjectTag {
  return { id: row.id, label: row.label, color: row.color }
}

function emptyTicketCounts(): Record<TicketStatus, number> {
  return {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  }
}

async function fetchTicketCounts(projectId: string): Promise<Record<TicketStatus, number>> {
  const rows = db
    .select({ status: tickets.status, n: count() })
    .from(tickets)
    .where(eq(tickets.projectId, projectId))
    .groupBy(tickets.status)
    .all()
  const counts = emptyTicketCounts()
  for (const row of rows) {
    if ((TICKET_STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as TicketStatus] = Number(row.n)
    }
  }
  return counts
}

async function fetchProjectTags(projectId: string): Promise<ProjectTag[]> {
  const rows = db
    .select()
    .from(projectTags)
    .where(eq(projectTags.projectId, projectId))
    .all()
  return rows.map(rowToProjectTag)
}

function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = db.select().from(projects).all()

  if (rows.length === 0) return []

  // Single aggregate query for ticket counts across all projects
  const countsRows = db
    .select({
      projectId: tickets.projectId,
      status: tickets.status,
      n: count(),
    })
    .from(tickets)
    .groupBy(tickets.projectId, tickets.status)
    .all()

  const totals = new Map<string, { all: number; open: number }>()
  for (const row of countsRows) {
    const entry = totals.get(row.projectId) ?? { all: 0, open: 0 }
    entry.all += Number(row.n)
    if (row.status !== 'done') entry.open += Number(row.n)
    totals.set(row.projectId, entry)
  }

  return rows.map((row): ProjectSummary => {
    const t = totals.get(row.id) ?? { all: 0, open: 0 }
    return {
      id: row.id,
      slug: row.slug ?? '',
      title: row.title,
      githubUrl: row.githubUrl,
      githubRepo: row.githubRepo,
      cloneStatus: (row.cloneStatus as CloneStatus) ?? 'none',
      ticketCount: t.all,
      openTicketCount: t.open,
      createdAt: toMillis(row.createdAt),
      updatedAt: toMillis(row.updatedAt),
    }
  })
}

export async function getProject(projectId: string): Promise<Project | null> {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) return null

  const [tags, ticketCounts] = await Promise.all([
    fetchProjectTags(projectId),
    fetchTicketCounts(projectId),
  ])

  let thinkingConfig: KinThinkingConfig | null = null
  if (row.thinkingConfig) {
    try {
      thinkingConfig = JSON.parse(row.thinkingConfig) as KinThinkingConfig
    } catch {
      thinkingConfig = null
    }
  }

  return {
    id: row.id,
    slug: row.slug ?? '',
    title: row.title,
    description: row.description,
    githubUrl: row.githubUrl,
    githubPatVaultKey: row.githubPatVaultKey,
    githubRepo: row.githubRepo,
    defaultBranch: row.defaultBranch,
    cloneStatus: (row.cloneStatus as CloneStatus) ?? 'none',
    cloneError: row.cloneError,
    clonedAt: row.clonedAt ? toMillis(row.clonedAt) : null,
    model: row.model,
    providerId: row.providerId,
    thinkingConfig,
    tags,
    ticketCounts,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

/** Lookup a project by its slug (case-insensitive on the input).
 *  Returns null when no row matches. Useful for tools that accept
 *  `slug#number` references. */
export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const normalized = slug.toLowerCase().trim()
  if (!normalized) return null
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, normalized)).get()
  if (!row) return null
  return getProject(row.id)
}

export interface CreateProjectInput {
  title: string
  description?: string
  githubUrl?: string | null
  /** Vault key referencing the GitHub PAT to use for clone + push. */
  githubPatVaultKey?: string | null
  /** Canonical "owner/name" of the repo to clone for sub-task worktrees.
   *  Triggers a background clone when set. Must match `GITHUB_REPO_REGEX`. */
  githubRepo?: string | null
  /** Override the branch sub-task worktrees are created from. Defaults to
   *  'main' at the DB layer; sub-ticket 4 will auto-detect from the repo. */
  defaultBranch?: string
  /** Default model id for sub-Kin tasks of this project. Must be paired
   *  with `providerId` — clearing one clears both. */
  model?: string | null
  providerId?: string | null
  /** Default thinking config for sub-Kin tasks of this project. */
  thinkingConfig?: KinThinkingConfig | null
  /** Optional explicit slug. If omitted, slug is auto-generated from title.
   *  Must match `PROJECT_SLUG_REGEX` when provided. */
  slug?: string
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const id = uuid()
  const now = new Date()

  // Resolve slug: explicit value (validated) or auto-generated from title.
  let baseSlug: string
  if (input.slug !== undefined && input.slug !== null && input.slug !== '') {
    const candidate = input.slug.trim().toLowerCase()
    if (!PROJECT_SLUG_REGEX.test(candidate)) {
      throw new Error('INVALID_PROJECT_SLUG')
    }
    baseSlug = candidate
  } else {
    const auto = generateSlug(input.title)
    baseSlug = auto && PROJECT_SLUG_REGEX.test(auto) ? auto : 'project'
    // Guard the 32-char cap (generateSlug truncates at 50).
    if (baseSlug.length > 32) baseSlug = baseSlug.substring(0, 32).replace(/-+$/, '')
  }
  const existingSlugs = new Set(
    db.select({ slug: projects.slug }).from(projects).all()
      .map((r) => r.slug)
      .filter((s): s is string => typeof s === 'string'),
  )
  const slug = ensureUniqueSlug(baseSlug, existingSlugs)

  // Validate githubRepo shape early so the API surface returns a 400 instead
  // of failing later inside the clone orchestrator.
  if (input.githubRepo != null && !GITHUB_REPO_REGEX.test(input.githubRepo)) {
    throw new Error('INVALID_GITHUB_REPO')
  }
  // defaultBranch is interpolated into `git fetch / rebase / worktree add`
  // argv at sub-task time — reject anything that could be re-parsed as a
  // git flag (e.g. `--upload-pack=...`) or escape the ref namespace.
  if (input.defaultBranch !== undefined && !isValidGitBranch(input.defaultBranch)) {
    throw new Error('INVALID_GIT_BRANCH')
  }

  // model + providerId are tightly coupled at the DB layer (one being set
  // without the other means "inherit from Kin"). Refuse the partial case.
  const modelSet = input.model !== undefined && input.model !== null && input.model !== ''
  const providerSet = input.providerId !== undefined && input.providerId !== null && input.providerId !== ''
  if (modelSet !== providerSet) {
    throw new Error('MODEL_AND_PROVIDER_MUST_BOTH_BE_SET')
  }

  db.insert(projects)
    .values({
      id,
      slug,
      title: input.title,
      description: input.description ?? '',
      githubUrl: input.githubUrl ?? null,
      githubPatVaultKey: input.githubPatVaultKey ?? null,
      githubRepo: input.githubRepo ?? null,
      defaultBranch: input.defaultBranch ?? 'main',
      cloneStatus: 'none',
      model: modelSet ? input.model : null,
      providerId: providerSet ? input.providerId : null,
      thinkingConfig: input.thinkingConfig ? JSON.stringify(input.thinkingConfig) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  // Seed default tags
  for (const tag of DEFAULT_PROJECT_TAGS) {
    db.insert(projectTags)
      .values({
        id: uuid(),
        projectId: id,
        label: tag.label,
        color: tag.color,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  const project = await getProject(id)
  if (!project) throw new Error('Project creation failed: not found after insert')

  sseManager.broadcast({
    type: 'project:created',
    data: {
      project: toProjectSummary(project),
    },
  })

  // Fire-and-forget: clone runs in background, status updates via SSE.
  // Failures are surfaced through `clone_status='error'`, never thrown
  // out of createProject (which would block the user's "save" UX).
  if (project.githubRepo) {
    startClone(project.id).catch((err) => {
      log.warn({ projectId: project.id, err: err instanceof Error ? err.message : err }, 'startClone threw on create')
    })
  }

  return project
}

export interface UpdateProjectInput {
  title?: string
  description?: string
  githubUrl?: string | null
  /** Vault key for the GitHub PAT. Pass null to clear. */
  githubPatVaultKey?: string | null
  /** Canonical "owner/name". Pass null to detach the repo (deletes the
   *  local clone, resets status to 'none'). Must match `GITHUB_REPO_REGEX`
   *  when set. */
  githubRepo?: string | null
  /** Override the default branch. */
  defaultBranch?: string
  /** New slug. Editable only while the project has zero tickets (avoids
   *  breaking any external reference like `kinbot#42`). */
  slug?: string
  /** Default model for sub-Kin tasks of this project. Pass null to clear
   *  (fall back to each Kin's own model). Must be paired with providerId. */
  model?: string | null
  providerId?: string | null
  /** Default thinking config for sub-Kin tasks of this project. Pass null
   *  to clear (fall back to each Kin's own config). */
  thinkingConfig?: KinThinkingConfig | null
}

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project | null> {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return null

  const now = new Date()
  const update: Partial<typeof projects.$inferInsert> = { updatedAt: now }
  if (input.title !== undefined) update.title = input.title
  if (input.description !== undefined) update.description = input.description
  if (input.githubUrl !== undefined) update.githubUrl = input.githubUrl
  if (input.githubPatVaultKey !== undefined) update.githubPatVaultKey = input.githubPatVaultKey
  if (input.githubRepo !== undefined) {
    if (input.githubRepo !== null && !GITHUB_REPO_REGEX.test(input.githubRepo)) {
      throw new Error('INVALID_GITHUB_REPO')
    }
    update.githubRepo = input.githubRepo
  }
  if (input.defaultBranch !== undefined) {
    if (!isValidGitBranch(input.defaultBranch)) {
      throw new Error('INVALID_GIT_BRANCH')
    }
    update.defaultBranch = input.defaultBranch
  }
  if (input.model !== undefined) update.model = input.model
  if (input.providerId !== undefined) update.providerId = input.providerId
  if (input.thinkingConfig !== undefined) {
    update.thinkingConfig = input.thinkingConfig === null ? null : JSON.stringify(input.thinkingConfig)
  }

  if (input.slug !== undefined) {
    const candidate = input.slug.trim().toLowerCase()
    if (!PROJECT_SLUG_REGEX.test(candidate)) {
      throw new Error('INVALID_PROJECT_SLUG')
    }
    if (candidate !== existing.slug) {
      // Lock-down rule: slug is editable only while no ticket exists. Any
      // outstanding ticket may already be referenced as `slug#N` somewhere
      // (commit message, mini-app, chat history), so we refuse the rename.
      const ticketCountRow = db
        .select({ n: count() })
        .from(tickets)
        .where(eq(tickets.projectId, projectId))
        .get()
      if (Number(ticketCountRow?.n ?? 0) > 0) {
        throw new Error('SLUG_LOCKED')
      }
      const taken = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, candidate))
        .get()
      if (taken && taken.id !== projectId) {
        throw new Error('SLUG_TAKEN')
      }
      update.slug = candidate
    }
  }

  // Decide what to do about the local clone BEFORE writing the row so we
  // capture the previous repo value. Three cases drive it:
  //   - cleared: githubRepo went from set to null → reset status + rm clone
  //   - changed: githubRepo went from null/X to Y → re-clone (slug-keyed dir
  //              is reused; runClone wipes any leftover before cloning)
  //   - unchanged: nothing to do
  const repoCleared = input.githubRepo === null && existing.githubRepo != null
  const repoAttachedOrChanged =
    input.githubRepo !== undefined &&
    input.githubRepo !== null &&
    input.githubRepo !== existing.githubRepo

  if (repoCleared) {
    update.cloneStatus = 'none'
    update.cloneError = null
    update.clonedAt = null
  }

  db.update(projects).set(update).where(eq(projects.id, projectId)).run()

  if (repoCleared && existing.slug) {
    // Fire-and-forget so a large clone removal doesn't block the response.
    deleteClone(existing.slug).catch((err) => {
      log.warn(
        { projectId, err: err instanceof Error ? err.message : err },
        'deleteClone failed',
      )
    })
  }

  const project = await getProject(projectId)
  if (!project) return null

  sseManager.broadcast({
    type: 'project:updated',
    data: { project: toProjectSummary(project) },
  })

  if (repoAttachedOrChanged) {
    // Same fire-and-forget pattern as createProject. SSE will surface the
    // 'cloning' → 'ready'/'error' transitions.
    // NOTE: if another clone is in flight for this project (e.g. user spam-
    // saved), the in-memory guard in repo-clone.ts drops this call silently.
    // The user can hit Retry once the previous attempt completes.
    startClone(projectId).catch((err) => {
      log.warn(
        { projectId, err: err instanceof Error ? err.message : err },
        'startClone threw on update',
      )
    })
  }

  return project
}

/** Replace, append, or patch the description in a single concern.
 *  Returns the updated project, or null if not found. */
export async function editProjectDescription(
  projectId: string,
  op:
    | { mode: 'replace'; content: string }
    | { mode: 'append'; text: string; separator?: string }
    | { mode: 'patch'; find: string; replace: string },
): Promise<Project | null> {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return null

  let nextDescription: string
  if (op.mode === 'replace') {
    nextDescription = op.content
  } else if (op.mode === 'append') {
    const separator = op.separator ?? '\n\n'
    nextDescription = existing.description.length > 0
      ? `${existing.description}${separator}${op.text}`
      : op.text
  } else {
    // patch
    if (!existing.description.includes(op.find)) {
      throw new Error(`PATCH_FIND_NOT_FOUND: substring "${op.find}" not found in description`)
    }
    const occurrences = existing.description.split(op.find).length - 1
    if (occurrences > 1) {
      throw new Error(`PATCH_FIND_AMBIGUOUS: substring "${op.find}" matches ${occurrences} times; refine to a unique match`)
    }
    nextDescription = existing.description.replace(op.find, op.replace)
  }

  return updateProject(projectId, { description: nextDescription })
}

export async function deleteProject(projectId: string): Promise<boolean> {
  const existing = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return false

  // Cascades handled by FK ON DELETE CASCADE for tickets/project_tags/ticket_tags.
  // kins.active_project_id and tasks.ticket_id are reset to NULL by FK ON DELETE SET NULL.
  db.delete(projects).where(eq(projects.id, projectId)).run()

  sseManager.broadcast({
    type: 'project:deleted',
    data: { projectId },
  })

  return true
}

// ─── Active project per Kin ───────────────────────────────────────────────────

export async function setActiveProject(
  kinId: string,
  projectId: string | null,
): Promise<{ activeProjectId: string | null }> {
  // Validate project exists if non-null
  if (projectId !== null) {
    const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw new Error('PROJECT_NOT_FOUND')
  }

  const existing = db.select({ id: kins.id }).from(kins).where(eq(kins.id, kinId)).get()
  if (!existing) throw new Error('KIN_NOT_FOUND')

  db.update(kins)
    .set({ activeProjectId: projectId, updatedAt: new Date() })
    .where(eq(kins.id, kinId))
    .run()

  sseManager.broadcast({
    type: 'kin:active-project',
    data: { kinId, activeProjectId: projectId },
  })

  return { activeProjectId: projectId }
}

export async function getActiveProjectIdsByKin(): Promise<Map<string, string[]>> {
  const rows = db
    .select({ kinId: kins.id, projectId: kins.activeProjectId })
    .from(kins)
    .where(sql`${kins.activeProjectId} IS NOT NULL`)
    .all()
  const result = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.projectId) continue
    const list = result.get(row.projectId) ?? []
    list.push(row.kinId)
    result.set(row.projectId, list)
  }
  return result
}

// ─── Prompt block info ────────────────────────────────────────────────────────

const TOKEN_CHARS_PER_TOKEN = 4
function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS_PER_TOKEN)
}

/** Fetch the active project context to inject into the [7.8] prompt block.
 *  Returns null if the project does not exist (graceful fallback for races). */
export async function buildActiveProjectInfo(projectId: string): Promise<ActiveProjectPromptInfo | null> {
  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) return null

  // Cap description to maxDescriptionPromptTokens — keep the first half if exceeded.
  const cap = config.projects.maxDescriptionPromptTokens
  const descTokens = estimateTokens(row.description)
  let description = row.description
  let descriptionTruncated = false
  if (descTokens > cap) {
    const charCap = Math.floor((cap / 2) * TOKEN_CHARS_PER_TOKEN)
    description = row.description.slice(0, charCap)
    descriptionTruncated = true
  }

  // Fetch tags and open tickets in parallel
  const tagRows = db.select().from(projectTags).where(eq(projectTags.projectId, projectId)).all()
  const ticketRows = db
    .select()
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), ne(tickets.status, 'done')))
    .orderBy(desc(tickets.updatedAt))
    .limit(config.projects.maxTicketsInPrompt + 1)
    .all()

  // Total open count (uncapped, for the "and N more" line)
  const totalOpenRow = db
    .select({ n: count() })
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), ne(tickets.status, 'done')))
    .get()
  const totalOpenTickets = Number(totalOpenRow?.n ?? 0)

  const cappedTickets = ticketRows.slice(0, config.projects.maxTicketsInPrompt)

  // Fetch tags for these tickets in a single query
  const ticketIds = cappedTickets.map((t) => t.id)
  const tagsByTicket = new Map<string, string[]>()
  if (ticketIds.length > 0) {
    const ticketTagRows = db
      .select({ ticketId: ticketTags.ticketId, label: projectTags.label })
      .from(ticketTags)
      .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
      .where(inArray(ticketTags.ticketId, ticketIds))
      .all()
    for (const r of ticketTagRows) {
      const list = tagsByTicket.get(r.ticketId) ?? []
      list.push(r.label)
      tagsByTicket.set(r.ticketId, list)
    }
  }

  // Fetch pinned bodies, lightweight title index, and total count for the
  // prompt block. Failure here must not break prompt assembly.
  let pinnedKnowledge: ActiveProjectPromptInfo['pinnedKnowledge'] = []
  let knowledgeIndex: ActiveProjectPromptInfo['knowledgeIndex'] = []
  let totalKnowledgeCount = 0
  try {
    const [pinned, index, total] = await Promise.all([
      getPinnedKnowledge(projectId),
      listKnowledgeIndex(projectId),
      countProjectKnowledge(projectId),
    ])
    pinnedKnowledge = pinned.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      category: p.category,
      authorKinName: p.authorKinName,
    }))
    knowledgeIndex = index
    totalKnowledgeCount = total
  } catch {
    // ignore — knowledge fetch is best-effort
  }

  return {
    id: row.id,
    slug: row.slug ?? '',
    title: row.title,
    description,
    descriptionTruncated,
    githubUrl: row.githubUrl,
    tags: tagRows.map((t) => ({ label: t.label, color: t.color })),
    openTickets: cappedTickets.map((t) => ({
      idShort: t.id.slice(0, 8),
      number: t.number ?? null,
      title: t.title,
      status: t.status,
      tagLabels: tagsByTicket.get(t.id) ?? [],
    })),
    totalOpenTickets,
    pinnedKnowledge,
    knowledgeIndex,
    totalKnowledgeCount,
  }
}

/** Convert a full Project into its summary form (used for SSE events). */
function toProjectSummary(p: Project): ProjectSummary {
  const open = (Object.keys(p.ticketCounts) as TicketStatus[])
    .filter((s) => s !== 'done')
    .reduce((acc, s) => acc + (p.ticketCounts[s] ?? 0), 0)
  const total = (Object.keys(p.ticketCounts) as TicketStatus[])
    .reduce((acc, s) => acc + (p.ticketCounts[s] ?? 0), 0)
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    githubUrl: p.githubUrl,
    githubRepo: p.githubRepo,
    cloneStatus: p.cloneStatus,
    ticketCount: total,
    openTicketCount: open,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

/**
 * Patch the clone-lifecycle fields on a project and broadcast a
 * `project:updated` SSE event so the UI (header badge, list view) reacts.
 *
 * Used by `repo-clone.ts` as the project state transitions
 * `none` → `cloning` → `ready` | `error`. Splitting it out of
 * `updateProject` keeps the clone orchestrator from having to know about
 * the broader update surface and avoids any chance of triggering a clone
 * recursively from inside a clone transition.
 */
export async function setCloneStatus(
  projectId: string,
  patch: {
    status: CloneStatus
    error?: string | null
    clonedAt?: Date | null
  },
): Promise<Project | null> {
  const existing = db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()
  if (!existing) return null

  const update: Partial<typeof projects.$inferInsert> = {
    cloneStatus: patch.status,
    updatedAt: new Date(),
  }
  // `error` and `clonedAt` are nullable; only patch when explicitly provided
  // so a "still cloning" transition doesn't accidentally wipe state.
  if (patch.error !== undefined) update.cloneError = patch.error
  if (patch.clonedAt !== undefined) update.clonedAt = patch.clonedAt

  db.update(projects).set(update).where(eq(projects.id, projectId)).run()

  const project = await getProject(projectId)
  if (!project) return null

  sseManager.broadcast({
    type: 'project:updated',
    data: { project: toProjectSummary(project) },
  })

  return project
}
