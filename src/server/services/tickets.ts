import { eq, and, inArray, max, count, desc, like, or, sql } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { tickets, ticketTags, projectTags, projects, tasks, agents, user, userProfiles, ticketAttachments } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { TICKET_STATUSES, TICKET_RUNNING_TASK_STATUSES } from '@/shared/constants'
import { spawnTask } from '@/server/services/tasks'
import {
  parseTicketRef,
  ticketResolutionMessage,
  type TicketResolutionErrorCode,
} from '@/server/utils/ticket-ref'
import type {
  Ticket,
  TicketStatus,
  TicketSummary,
  TicketTaskSummary,
  ProjectTag,
  RunningAgentOnTicket,
  TicketReporter,
  AgentThinkingConfig,
} from '@/shared/types'
import type { TicketAssignmentInfo } from '@/server/services/prompt-builder'

function toMillis(value: Date | number): number {
  return value instanceof Date ? value.getTime() : value
}

function isValidStatus(status: string): status is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(status)
}

async function fetchTagsForTicket(ticketId: string): Promise<ProjectTag[]> {
  const rows = db
    .select({ id: projectTags.id, label: projectTags.label, color: projectTags.color })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(eq(ticketTags.ticketId, ticketId))
    .all()
  return rows.map((r) => ({ id: r.id, label: r.label, color: r.color }))
}

async function fetchTagsForTickets(ticketIds: string[]): Promise<Map<string, ProjectTag[]>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: ticketTags.ticketId,
      id: projectTags.id,
      label: projectTags.label,
      color: projectTags.color,
    })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(inArray(ticketTags.ticketId, ticketIds))
    .all()

  const result = new Map<string, ProjectTag[]>()
  for (const row of rows) {
    const list = result.get(row.ticketId) ?? []
    list.push({ id: row.id, label: row.label, color: row.color })
    result.set(row.ticketId, list)
  }
  return result
}

async function fetchAttachmentCountsForTickets(
  ticketIds: string[],
): Promise<Map<string, number>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({ ticketId: ticketAttachments.ticketId, n: count() })
    .from(ticketAttachments)
    .where(inArray(ticketAttachments.ticketId, ticketIds))
    .groupBy(ticketAttachments.ticketId)
    .all()
  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row.ticketId, Number(row.n))
  }
  return result
}

async function fetchTaskCountsForTickets(
  ticketIds: string[],
): Promise<Map<string, { total: number; running: number; awaitingInput: number }>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: tasks.ticketId,
      status: tasks.status,
      n: count(),
    })
    .from(tasks)
    .where(inArray(tasks.ticketId, ticketIds))
    .groupBy(tasks.ticketId, tasks.status)
    .all()

  const result = new Map<string, { total: number; running: number; awaitingInput: number }>()
  for (const row of rows) {
    if (!row.ticketId) continue
    const entry = result.get(row.ticketId) ?? { total: 0, running: 0, awaitingInput: 0 }
    entry.total += Number(row.n)
    if ((TICKET_RUNNING_TASK_STATUSES as readonly string[]).includes(row.status)) {
      entry.running += Number(row.n)
    }
    if (row.status === 'awaiting_human_input') {
      entry.awaitingInput += Number(row.n)
    }
    result.set(row.ticketId, entry)
  }
  return result
}

/** For each ticket, fetch the Agents currently executing a task on it (one entry per running task). */
async function fetchRunningAgentsForTickets(
  ticketIds: string[],
): Promise<Map<string, RunningAgentOnTicket[]>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: tasks.ticketId,
      taskId: tasks.id,
      agentId: agents.id,
      agentName: agents.name,
      agentSlug: agents.slug,
      avatarPath: agents.avatarPath,
      avatarUpdatedAt: agents.updatedAt,
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.parentAgentId, agents.id))
    .where(
      and(
        inArray(tasks.ticketId, ticketIds),
        inArray(tasks.status, [...TICKET_RUNNING_TASK_STATUSES]),
      ),
    )
    .all()

  const result = new Map<string, RunningAgentOnTicket[]>()
  for (const row of rows) {
    if (!row.ticketId) continue
    const list = result.get(row.ticketId) ?? []
    list.push({
      agentId: row.agentId,
      agentName: row.agentName,
      agentSlug: row.agentSlug,
      avatarUrl: row.avatarPath
        ? `/api/uploads/agents/${row.agentId}/avatar.${row.avatarPath.split('.').pop() ?? 'png'}?v=${toMillis(row.avatarUpdatedAt)}`
        : null,
      taskId: row.taskId,
    })
    result.set(row.ticketId, list)
  }
  return result
}

/**
 * For each ticket, compute the timestamp (unix-ms) at which the EARLIEST
 * currently-running task started being processed. "Running" here means the
 * task sits in one of TICKET_RUNNING_TASK_STATUSES (queued/pending/in_progress
 * plus the suspended-but-alive states paused/awaiting_agent_response/
 * awaiting_subtask) — the same set that powers `runningAgents` and the running
 * framing on the card, so a task that delegates to a scout keeps its ticket
 * framed as running. We coalesce
 * `started_at` (actual execution start) → `queued_at` → `created_at` so a
 * task that is queued but not yet executing still contributes a sensible
 * timestamp. Tickets with no running task are absent from the map (→ null).
 *
 * This is deliberately decoupled from `tickets.in_progress_at` (the kanban
 * column transition): the card chrono reflects live task work, not which
 * column the ticket happens to sit in.
 */
async function fetchRunningSinceForTickets(
  ticketIds: string[],
): Promise<Map<string, number>> {
  if (ticketIds.length === 0) return new Map()
  const rows = db
    .select({
      ticketId: tasks.ticketId,
      startedAt: tasks.startedAt,
      queuedAt: tasks.queuedAt,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.ticketId, ticketIds),
        inArray(tasks.status, [...TICKET_RUNNING_TASK_STATUSES]),
      ),
    )
    .all()

  const result = new Map<string, number>()
  for (const row of rows) {
    if (!row.ticketId) continue
    const start = toMillis(row.startedAt ?? row.queuedAt ?? row.createdAt)
    const current = result.get(row.ticketId)
    if (current === undefined || start < current) {
      result.set(row.ticketId, start)
    }
  }
  return result
}

/** Resolve a reporter (user or agent) into the public-facing shape. Null if neither set. */
async function fetchReporterForTicket(
  reporterUserId: string | null,
  reporterAgentId: string | null,
): Promise<TicketReporter | null> {
  if (reporterAgentId) {
    const k = db
      .select({ id: agents.id, slug: agents.slug, name: agents.name, avatarPath: agents.avatarPath, updatedAt: agents.updatedAt })
      .from(agents)
      .where(eq(agents.id, reporterAgentId))
      .get()
    if (k) {
      return {
        type: 'agent',
        id: k.id,
        slug: k.slug,
        name: k.name,
        avatarUrl: k.avatarPath
          ? `/api/uploads/agents/${k.id}/avatar.${k.avatarPath.split('.').pop() ?? 'png'}?v=${toMillis(k.updatedAt)}`
          : null,
      }
    }
  }
  if (reporterUserId) {
    const row = db
      .select({
        id: user.id,
        userName: user.name,
        userImage: user.image,
        profileFirstName: userProfiles.firstName,
        profileLastName: userProfiles.lastName,
        profilePseudonym: userProfiles.pseudonym,
      })
      .from(user)
      .leftJoin(userProfiles, eq(userProfiles.userId, user.id))
      .where(eq(user.id, reporterUserId))
      .get()
    if (row) {
      const fullName = row.profileFirstName && row.profileLastName
        ? `${row.profileFirstName} ${row.profileLastName}`
        : row.profilePseudonym ?? row.userName
      return {
        type: 'user',
        id: row.id,
        name: fullName,
        avatarUrl: row.userImage ?? null,
      }
    }
  }
  return null
}

async function rowToTicketSummary(
  row: typeof tickets.$inferSelect,
  tags: ProjectTag[],
  taskCounts: { total: number; running: number; awaitingInput: number },
  runningAgents: RunningAgentOnTicket[] = [],
  reporter: TicketReporter | null = null,
  attachmentCount = 0,
  runningSince: number | null = null,
): Promise<TicketSummary> {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number ?? null,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    position: row.position,
    tags,
    taskCount: taskCounts.total,
    runningTaskCount: taskCounts.running,
    awaitingHumanInputCount: taskCounts.awaitingInput,
    runningAgents,
    reporter,
    attachmentCount,
    inProgressAt: row.inProgressAt ? toMillis(row.inProgressAt) : null,
    runningSince,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

// ─── Reference resolution (UUID / slug#N / #N) ────────────────────────────────

/** Result of resolving a ticket reference. On success, `ticketId` is the UUID
 *  callers can pass to any of the existing UUID-keyed service functions. */
export type ResolveTicketRefResult =
  | { ok: true; ticketId: string }
  | { ok: false; code: TicketResolutionErrorCode; message: string }

/** Resolve a free-form ticket reference (UUID, `slug#N`, or bare `#N` / `N`)
 *  to a ticket UUID using the database.
 *
 *  - UUID: direct lookup.
 *  - `slug#N`: look up the project by slug, then the ticket by (project, number).
 *  - bare `#N`/`N`: requires an `activeProjectId` argument. Resolved against
 *    that project's tickets table.
 *
 *  All failure modes return a structured `{ code, message }` for tools to
 *  surface — never throws on a missing project/ticket. */
export async function resolveTicketRef(
  raw: string,
  ctx: { activeProjectId?: string | null } = {},
): Promise<ResolveTicketRefResult> {
  const parsed = parseTicketRef(raw)
  if (parsed.kind === 'invalid') {
    return {
      ok: false,
      code: 'INVALID_TICKET_REF',
      message: ticketResolutionMessage('INVALID_TICKET_REF', { raw: parsed.raw }),
    }
  }

  if (parsed.kind === 'uuid') {
    const row = db.select({ id: tickets.id }).from(tickets).where(eq(tickets.id, parsed.id)).get()
    if (!row) {
      return {
        ok: false,
        code: 'TICKET_NOT_FOUND',
        message: ticketResolutionMessage('TICKET_NOT_FOUND'),
      }
    }
    return { ok: true, ticketId: row.id }
  }

  if (parsed.kind === 'qualified') {
    const project = db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, parsed.slug))
      .get()
    if (!project) {
      return {
        ok: false,
        code: 'PROJECT_NOT_FOUND',
        message: ticketResolutionMessage('PROJECT_NOT_FOUND', { slug: parsed.slug }),
      }
    }
    const ticket = db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.projectId, project.id), eq(tickets.number, parsed.number)))
      .get()
    if (!ticket) {
      return {
        ok: false,
        code: 'TICKET_NOT_FOUND',
        message: ticketResolutionMessage('TICKET_NOT_FOUND', {
          slug: parsed.slug,
          number: parsed.number,
        }),
      }
    }
    return { ok: true, ticketId: ticket.id }
  }

  // Bare number: needs an active project context.
  if (!ctx.activeProjectId) {
    return {
      ok: false,
      code: 'NO_ACTIVE_PROJECT',
      message: ticketResolutionMessage('NO_ACTIVE_PROJECT'),
    }
  }
  const project = db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, ctx.activeProjectId))
    .get()
  if (!project) {
    return {
      ok: false,
      code: 'PROJECT_NOT_FOUND',
      message: ticketResolutionMessage('PROJECT_NOT_FOUND', { slug: '' }),
    }
  }
  const ticket = db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.projectId, project.id), eq(tickets.number, parsed.number)))
    .get()
  if (!ticket) {
    return {
      ok: false,
      code: 'TICKET_NOT_FOUND',
      message: ticketResolutionMessage('TICKET_NOT_FOUND', {
        slug: project.slug ?? undefined,
        number: parsed.number,
      }),
    }
  }
  return { ok: true, ticketId: ticket.id }
}

// ─── Mention resolution (batch, public) ────────────────────────────────────────

/** Maximum number of refs accepted per batch call. Anything above is rejected
 *  to keep `resolveMentions` cheap and predictable for the chat hot-path. */
export const RESOLVE_MENTIONS_MAX_REFS = 50

/** Resolved mention info exposed to the client. Snapshot at resolution time —
 *  the client may rely on SSE for live updates. */
export interface ResolvedMention {
  found: true
  id: string
  number: number
  title: string
  status: TicketStatus
  projectId: string
  projectSlug: string
  projectName: string
}

export interface UnresolvedMention {
  found: false
  /** Why it could not be resolved. Useful for debugging / future UX. */
  reason: TicketResolutionErrorCode
}

export type MentionResolution = ResolvedMention | UnresolvedMention

/**
 * Resolve a list of free-form ticket refs in batch. Refs that fail to parse,
 * point to a missing project or ticket, or use a bare `#N` without an active
 * project context, are returned with `found: false` rather than throwing.
 *
 * Duplicate refs are collapsed to a single DB lookup — callers can pass the
 * same ref multiple times safely.
 *
 * Returns an object keyed by the original ref strings, preserving the input
 * casing so the client can match each mention exactly as it was written.
 */
export async function resolveMentions(
  refs: string[],
  ctx: { activeProjectId?: string | null } = {},
): Promise<Record<string, MentionResolution>> {
  const out: Record<string, MentionResolution> = {}
  if (!Array.isArray(refs) || refs.length === 0) return out

  // De-dup while preserving the original input strings (case-sensitive: callers
  // already enforced lowercase slugs upstream, but we keep the keys verbatim
  // for round-tripping in the client cache).
  const unique = Array.from(new Set(refs.filter((r) => typeof r === 'string' && r.length > 0)))
  const capped = unique.slice(0, RESOLVE_MENTIONS_MAX_REFS)

  // Group lookups: collect slugs and bare numbers separately to minimize roundtrips.
  type Parsed = { raw: string; parsed: ReturnType<typeof parseTicketRef> }
  const parsedRefs: Parsed[] = capped.map((raw) => ({ raw, parsed: parseTicketRef(raw) }))

  const slugs = new Set<string>()
  for (const { parsed } of parsedRefs) {
    if (parsed.kind === 'qualified') slugs.add(parsed.slug)
  }

  // Bare refs need the active project resolved upfront so they can join the
  // same ticket lookup path as qualified refs.
  let activeProject: { id: string; slug: string; name: string } | null = null
  if (ctx.activeProjectId) {
    const row = db
      .select({ id: projects.id, slug: projects.slug, name: projects.title })
      .from(projects)
      .where(eq(projects.id, ctx.activeProjectId))
      .get()
    if (row && row.slug) {
      activeProject = { id: row.id, slug: row.slug, name: row.name }
    }
  }

  // Fetch all referenced projects (qualified slugs + active project) in a single query.
  const projectRows = slugs.size > 0
    ? db
        .select({ id: projects.id, slug: projects.slug, name: projects.title })
        .from(projects)
        .where(inArray(projects.slug, Array.from(slugs)))
        .all()
    : []
  const projectsBySlug = new Map<string, { id: string; slug: string; name: string }>()
  for (const p of projectRows) {
    if (p.slug) projectsBySlug.set(p.slug, { id: p.id, slug: p.slug, name: p.name })
  }
  if (activeProject) projectsBySlug.set(activeProject.slug, activeProject)

  // Build the list of (projectId, number) we need to look up.
  type Lookup = { raw: string; projectId: string; projectSlug: string; projectName: string; number: number }
  const lookups: Lookup[] = []

  for (const { raw, parsed } of parsedRefs) {
    if (parsed.kind === 'invalid') {
      out[raw] = { found: false, reason: 'INVALID_TICKET_REF' }
      continue
    }
    if (parsed.kind === 'uuid') {
      // Single-shot UUID lookup. Cheap enough to do inline.
      const row = db
        .select({
          id: tickets.id,
          number: tickets.number,
          title: tickets.title,
          status: tickets.status,
          projectId: tickets.projectId,
        })
        .from(tickets)
        .where(eq(tickets.id, parsed.id))
        .get()
      if (!row || row.number === null) {
        out[raw] = { found: false, reason: 'TICKET_NOT_FOUND' }
        continue
      }
      const proj = db
        .select({ slug: projects.slug, name: projects.title })
        .from(projects)
        .where(eq(projects.id, row.projectId))
        .get()
      out[raw] = {
        found: true,
        id: row.id,
        number: row.number,
        title: row.title,
        status: row.status as TicketStatus,
        projectId: row.projectId,
        projectSlug: proj?.slug ?? '',
        projectName: proj?.name ?? '',
      }
      continue
    }
    if (parsed.kind === 'qualified') {
      const proj = projectsBySlug.get(parsed.slug)
      if (!proj) {
        out[raw] = { found: false, reason: 'PROJECT_NOT_FOUND' }
        continue
      }
      lookups.push({
        raw,
        projectId: proj.id,
        projectSlug: proj.slug,
        projectName: proj.name,
        number: parsed.number,
      })
      continue
    }
    // bare
    if (!activeProject) {
      out[raw] = { found: false, reason: 'NO_ACTIVE_PROJECT' }
      continue
    }
    lookups.push({
      raw,
      projectId: activeProject.id,
      projectSlug: activeProject.slug,
      projectName: activeProject.name,
      number: parsed.number,
    })
  }

  if (lookups.length > 0) {
    // Fetch all candidate tickets in a single IN-list per project.
    const byProject = new Map<string, Lookup[]>()
    for (const l of lookups) {
      const arr = byProject.get(l.projectId) ?? []
      arr.push(l)
      byProject.set(l.projectId, arr)
    }

    for (const [projectId, items] of byProject) {
      const numbers = Array.from(new Set(items.map((i) => i.number)))
      const rows = db
        .select({
          id: tickets.id,
          number: tickets.number,
          title: tickets.title,
          status: tickets.status,
        })
        .from(tickets)
        .where(and(eq(tickets.projectId, projectId), inArray(tickets.number, numbers)))
        .all()
      const byNumber = new Map<number, typeof rows[number]>()
      for (const r of rows) {
        if (r.number !== null) byNumber.set(r.number, r)
      }
      for (const item of items) {
        const row = byNumber.get(item.number)
        if (!row) {
          out[item.raw] = { found: false, reason: 'TICKET_NOT_FOUND' }
          continue
        }
        out[item.raw] = {
          found: true,
          id: row.id,
          number: item.number,
          title: row.title,
          status: row.status as TicketStatus,
          projectId,
          projectSlug: item.projectSlug,
          projectName: item.projectName,
        }
      }
    }
  }

  return out
}

// ─── Ticket search (autocomplete) ─────────────────────────────────────────────

/** A single hit returned by the autocomplete search endpoint. Lean shape:
 *  enough to render the popover row (number / title / status / primary tag)
 *  and to compute the insertion (`#N` vs `slug#N`) on the client. */
export interface TicketSearchHit {
  id: string
  number: number
  title: string
  status: TicketStatus
  projectId: string
  projectSlug: string
  projectName: string
  /** Primary tag (first one by id) to show next to the title — null if none. */
  primaryTag: ProjectTag | null
  updatedAt: number
  createdAt: number
}

/** Max number of hits returned per request. The UI caps the visible list at 10
 *  with internal scroll, but we return up to 20 so a quick scroll reveals more
 *  without a refetch. */
export const TICKET_SEARCH_MAX_RESULTS = 20

export interface SearchTicketsInput {
  /** Free-form query: matches against title (LIKE) and ticket number. Empty
   *  string returns the most recently updated tickets in the project. */
  query: string
  /** Project to scope the search to. Required. */
  projectId: string
  /** Whether to include `done` tickets. Default: true. The UI may apply its
   *  own visual de-emphasis. */
  includeDone?: boolean
  /** Pagination cap. Defaults to TICKET_SEARCH_MAX_RESULTS. */
  limit?: number
  /** Pagination offset. Defaults to 0. */
  offset?: number
}

/** Escape `%` and `_` so user input cannot accidentally turn into wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * Search tickets in a project for autocomplete usage.
 *
 *   - Numeric queries: match by ticket number (exact or prefix) first.
 *   - Text queries: case-insensitive substring on title.
 *   - Default sort: `updatedAt DESC` so recently-active tickets come first;
 *     done tickets are pushed to the bottom by an explicit status order.
 *
 * Returns the lean `TicketSearchHit` shape — no task counts, no running Agents,
 * no reporter — to keep the response cheap on the chat hot-path.
 */
export async function searchTickets(input: SearchTicketsInput): Promise<TicketSearchHit[]> {
  const limit = Math.min(Math.max(1, input.limit ?? TICKET_SEARCH_MAX_RESULTS), TICKET_SEARCH_MAX_RESULTS)
  const offset = Math.max(0, input.offset ?? 0)
  const includeDone = input.includeDone ?? true

  // Verify the project exists and grab its slug + name in one shot.
  const project = db
    .select({ id: projects.id, slug: projects.slug, name: projects.title })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .get()
  if (!project) return []

  const where = [eq(tickets.projectId, input.projectId)]
  if (!includeDone) {
    where.push(sql`${tickets.status} != 'done'`)
  }

  const rawQuery = (input.query ?? '').trim()
  // Strip a leading `#` so `#42` is treated the same as `42`. The popover may
  // already have peeled it off but we don't rely on that.
  const normalized = rawQuery.replace(/^#/, '')
  const numericMatch = /^(\d{1,10})$/.exec(normalized)

  if (numericMatch) {
    // Numeric query: prefix-match the per-project number, fall back to title
    // containing the digits (rare but useful, e.g. \"v42\" in a title).
    const num = Number(numericMatch[1])
    const numStr = String(num)
    where.push(
      or(
        // Exact + prefix match on the number — drizzle has no LIKE on integers
        // so we cast via sql template.
        sql`CAST(${tickets.number} AS TEXT) LIKE ${numStr + '%'}`,
        like(tickets.title, `%${escapeLike(normalized)}%`),
      )!,
    )
  } else if (normalized.length > 0) {
    // Plain text query: LIKE on title. SQLite's default LIKE is case-insensitive
    // for ASCII which is enough for our use case.
    where.push(like(tickets.title, `%${escapeLike(normalized)}%`))
  }

  const rows = db
    .select({
      id: tickets.id,
      number: tickets.number,
      title: tickets.title,
      status: tickets.status,
      projectId: tickets.projectId,
      updatedAt: tickets.updatedAt,
      createdAt: tickets.createdAt,
    })
    .from(tickets)
    .where(and(...where))
    .orderBy(
      // Push `done` to the bottom regardless of recency.
      sql`CASE WHEN ${tickets.status} = 'done' THEN 1 ELSE 0 END`,
      desc(tickets.updatedAt),
      desc(tickets.createdAt),
    )
    .limit(limit)
    .offset(offset)
    .all()

  // Filter out tickets that never got a number assigned (pre-slug-feature rows
  // that haven't been backfilled). They cannot be referenced as `#N` anyway.
  const numbered = rows.filter((r) => r.number !== null) as Array<typeof rows[number] & { number: number }>

  if (numbered.length === 0) return []

  // Fetch the primary tag per ticket in a single query.
  const ids = numbered.map((r) => r.id)
  const tagRows = db
    .select({
      ticketId: ticketTags.ticketId,
      tagId: projectTags.id,
      label: projectTags.label,
      color: projectTags.color,
    })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(inArray(ticketTags.ticketId, ids))
    .orderBy(projectTags.label)
    .all()
  const primaryByTicket = new Map<string, ProjectTag>()
  for (const row of tagRows) {
    if (!primaryByTicket.has(row.ticketId)) {
      primaryByTicket.set(row.ticketId, { id: row.tagId, label: row.label, color: row.color })
    }
  }

  return numbered.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status as TicketStatus,
    projectId: row.projectId,
    projectSlug: project.slug ?? '',
    projectName: project.name,
    primaryTag: primaryByTicket.get(row.id) ?? null,
    updatedAt: toMillis(row.updatedAt),
    createdAt: toMillis(row.createdAt),
  }))
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ListTicketsFilters {
  status?: TicketStatus
  tagId?: string
  limit?: number
  offset?: number
}

export async function listTickets(
  projectId: string,
  filters: ListTicketsFilters = {},
): Promise<{ tickets: TicketSummary[]; hasMore: boolean }> {
  const limit = filters.limit ?? 100
  const offset = filters.offset ?? 0

  const whereClauses = [eq(tickets.projectId, projectId)]
  if (filters.status) whereClauses.push(eq(tickets.status, filters.status))

  let query
  if (filters.tagId) {
    // Join through ticket_tags
    const ticketIds = db
      .select({ ticketId: ticketTags.ticketId })
      .from(ticketTags)
      .where(eq(ticketTags.tagId, filters.tagId))
      .all()
      .map((r) => r.ticketId)
    if (ticketIds.length === 0) return { tickets: [], hasMore: false }
    whereClauses.push(inArray(tickets.id, ticketIds))
  }

  const rows = db
    .select()
    .from(tickets)
    .where(and(...whereClauses))
    .orderBy(tickets.status, tickets.position)
    .limit(limit + 1)
    .offset(offset)
    .all()

  const hasMore = rows.length > limit
  const slice = hasMore ? rows.slice(0, limit) : rows

  const ids = slice.map((r) => r.id)
  const [tagsByTicket, taskCountsByTicket, runningAgentsByTicket, attachmentCountsByTicket, runningSinceByTicket] = await Promise.all([
    fetchTagsForTickets(ids),
    fetchTaskCountsForTickets(ids),
    fetchRunningAgentsForTickets(ids),
    fetchAttachmentCountsForTickets(ids),
    fetchRunningSinceForTickets(ids),
  ])

  const items = await Promise.all(
    slice.map(async (row) =>
      rowToTicketSummary(
        row,
        tagsByTicket.get(row.id) ?? [],
        taskCountsByTicket.get(row.id) ?? { total: 0, running: 0, awaitingInput: 0 },
        runningAgentsByTicket.get(row.id) ?? [],
        await fetchReporterForTicket(row.reporterUserId, row.reporterAgentId),
        attachmentCountsByTicket.get(row.id) ?? 0,
        runningSinceByTicket.get(row.id) ?? null,
      ),
    ),
  )

  return { tickets: items, hasMore }
}

export async function getTicket(ticketId: string): Promise<Ticket | null> {
  const row = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!row) return null

  const [tags, taskRows] = await Promise.all([
    fetchTagsForTicket(ticketId),
    db
      .select({
        id: tasks.id,
        parentAgentId: tasks.parentAgentId,
        parentAgentName: agents.name,
        parentAgentAvatarPath: agents.avatarPath,
        parentAgentUpdatedAt: agents.updatedAt,
        status: tasks.status,
        mode: tasks.mode,
        kind: tasks.kind,
        startedAt: tasks.startedAt,
        endedAt: tasks.endedAt,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .innerJoin(agents, eq(tasks.parentAgentId, agents.id))
      .where(eq(tasks.ticketId, ticketId))
      .orderBy(desc(tasks.createdAt))
      .all(),
  ])

  const [taskCountsMap, runningAgentsMap, attachmentCountsMap, runningSinceMap] = await Promise.all([
    fetchTaskCountsForTickets([ticketId]),
    fetchRunningAgentsForTickets([ticketId]),
    fetchAttachmentCountsForTickets([ticketId]),
    fetchRunningSinceForTickets([ticketId]),
  ])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0, awaitingInput: 0 }
  const runningAgents = runningAgentsMap.get(ticketId) ?? []
  const reporter = await fetchReporterForTicket(row.reporterUserId, row.reporterAgentId)
  const attachmentCount = attachmentCountsMap.get(ticketId) ?? 0
  const runningSince = runningSinceMap.get(ticketId) ?? null

  const ticketTasks: TicketTaskSummary[] = taskRows.map((t) => ({
    id: t.id,
    parentAgentId: t.parentAgentId,
    parentAgentName: t.parentAgentName,
    parentAgentAvatarUrl: t.parentAgentAvatarPath
      ? `/api/uploads/agents/${t.parentAgentId}/avatar.${t.parentAgentAvatarPath.split('.').pop() ?? 'png'}?v=${toMillis(t.parentAgentUpdatedAt)}`
      : null,
    status: t.status as TicketTaskSummary['status'],
    mode: t.mode as TicketTaskSummary['mode'],
    kind: (t.kind as TicketTaskSummary['kind']) ?? 'execute',
    startedAt: t.startedAt ? toMillis(t.startedAt) : null,
    endedAt: t.endedAt ? toMillis(t.endedAt) : null,
    createdAt: toMillis(t.createdAt),
    updatedAt: toMillis(t.updatedAt),
  }))

  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number ?? null,
    title: row.title,
    description: row.description,
    status: row.status as TicketStatus,
    position: row.position,
    tags,
    taskCount: counts.total,
    runningTaskCount: counts.running,
    awaitingHumanInputCount: counts.awaitingInput,
    runningAgents,
    reporter,
    attachmentCount,
    inProgressAt: row.inProgressAt ? toMillis(row.inProgressAt) : null,
    runningSince,
    tasks: ticketTasks,
    createdAt: toMillis(row.createdAt),
    updatedAt: toMillis(row.updatedAt),
  }
}

async function computeNextPositionInColumn(projectId: string, status: TicketStatus): Promise<number> {
  const row = db
    .select({ maxPos: max(tickets.position) })
    .from(tickets)
    .where(and(eq(tickets.projectId, projectId), eq(tickets.status, status)))
    .get()
  const current = row?.maxPos ?? 0
  return current + config.projects.kanbanPositionStep
}

async function setTicketTags(ticketId: string, tagIds: string[]): Promise<void> {
  // Replace the set entirely (PUT-like semantics)
  db.delete(ticketTags).where(eq(ticketTags.ticketId, ticketId)).run()
  if (tagIds.length === 0) return

  // Validate tags belong to the same project as the ticket
  const ticket = db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) throw new Error('TICKET_NOT_FOUND')

  const validTags = db
    .select({ id: projectTags.id })
    .from(projectTags)
    .where(and(eq(projectTags.projectId, ticket.projectId), inArray(projectTags.id, tagIds)))
    .all()
  const validIds = new Set(validTags.map((t) => t.id))

  for (const tagId of tagIds) {
    if (!validIds.has(tagId)) continue // Silently skip invalid tags (cross-project or non-existent)
    db.insert(ticketTags)
      .values({ ticketId, tagId })
      .onConflictDoNothing()
      .run()
  }
}

export interface CreateTicketInput {
  projectId: string
  title: string
  description?: string
  status?: TicketStatus
  tagIds?: string[]
  /** Who's creating this ticket — set exactly one (or neither for system seeds). */
  reporter?: { type: 'user'; id: string } | { type: 'agent'; id: string } | null
}

export async function createTicket(input: CreateTicketInput): Promise<TicketSummary> {
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).get()
  if (!project) throw new Error('PROJECT_NOT_FOUND')

  const status = input.status ?? 'backlog'
  if (!isValidStatus(status)) throw new Error('INVALID_STATUS')

  const id = uuid()
  const now = new Date()
  const position = await computeNextPositionInColumn(input.projectId, status)

  const reporterUserId = input.reporter?.type === 'user' ? input.reporter.id : null
  const reporterAgentId = input.reporter?.type === 'agent' ? input.reporter.id : null

  // Allocate the per-project monotonic number atomically.
  // SQLite serializes writers so MAX(...)+1 inside a single tx is race-safe;
  // the unique index (project_id, number) is the ultimate safeguard.
  let allocatedNumber = 0
  const txn = sqlite.transaction(() => {
    const maxRow = sqlite
      .query<{ n: number | null }, [string]>(
        'SELECT MAX(number) as n FROM tickets WHERE project_id = ?',
      )
      .get(input.projectId)
    allocatedNumber = (maxRow?.n ?? 0) + 1

    db.insert(tickets)
      .values({
        id,
        projectId: input.projectId,
        number: allocatedNumber,
        title: input.title,
        description: input.description ?? '',
        status,
        position,
        reporterUserId,
        reporterAgentId,
        inProgressAt: status === 'in_progress' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  txn()

  if (input.tagIds && input.tagIds.length > 0) {
    await setTicketTags(id, input.tagIds)
  }

  const tags = await fetchTagsForTicket(id)
  const reporter = await fetchReporterForTicket(reporterUserId, reporterAgentId)
  const summary: TicketSummary = {
    id,
    projectId: input.projectId,
    number: allocatedNumber,
    title: input.title,
    description: input.description ?? '',
    status,
    position,
    tags,
    taskCount: 0,
    runningTaskCount: 0,
    awaitingHumanInputCount: 0,
    runningAgents: [],
    reporter,
    attachmentCount: 0,
    inProgressAt: status === 'in_progress' ? now.getTime() : null,
    // A freshly created ticket has no tasks yet, so no task is running.
    runningSince: null,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
  }

  sseManager.broadcast({
    type: 'ticket:created',
    data: { ticket: summary },
  })

  return summary
}

export interface UpdateTicketInput {
  title?: string
  description?: string
  status?: TicketStatus
  position?: number
  tagIds?: string[]
}

export async function updateTicket(
  ticketId: string,
  input: UpdateTicketInput,
): Promise<TicketSummary | null> {
  const existing = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!existing) return null

  const update: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() }
  if (input.title !== undefined) update.title = input.title
  if (input.description !== undefined) update.description = input.description

  let newStatus: TicketStatus = existing.status as TicketStatus
  if (input.status !== undefined) {
    if (!isValidStatus(input.status)) throw new Error('INVALID_STATUS')
    newStatus = input.status
    update.status = input.status
    // Stamp the moment the ticket (re)enters the in_progress column so the
    // kanban card can show a live "in progress since" duration. Re-stamped on
    // every fresh transition into in_progress (e.g. done → in_progress again)
    // so the timer reflects the current work session, not a stale one.
    if (input.status === 'in_progress' && existing.status !== 'in_progress') {
      update.inProgressAt = new Date()
    }
  }

  if (input.position !== undefined) {
    update.position = input.position
  } else if (input.status !== undefined && input.status !== existing.status) {
    // Status changed without explicit position → place at top of new column
    update.position = await computeNextPositionInColumn(existing.projectId, newStatus)
  }

  db.update(tickets).set(update).where(eq(tickets.id, ticketId)).run()

  if (input.tagIds !== undefined) {
    await setTicketTags(ticketId, input.tagIds)
  }

  const refreshed = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!refreshed) return null

  const tags = await fetchTagsForTicket(ticketId)
  const [taskCountsMap, runningAgentsMap, attachmentCountsMap, runningSinceMap] = await Promise.all([
    fetchTaskCountsForTickets([ticketId]),
    fetchRunningAgentsForTickets([ticketId]),
    fetchAttachmentCountsForTickets([ticketId]),
    fetchRunningSinceForTickets([ticketId]),
  ])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0, awaitingInput: 0 }
  const runningAgents = runningAgentsMap.get(ticketId) ?? []
  const reporter = await fetchReporterForTicket(refreshed.reporterUserId, refreshed.reporterAgentId)
  const attachmentCount = attachmentCountsMap.get(ticketId) ?? 0
  const runningSince = runningSinceMap.get(ticketId) ?? null

  const summary = await rowToTicketSummary(refreshed, tags, counts, runningAgents, reporter, attachmentCount, runningSince)

  sseManager.broadcast({
    type: 'ticket:updated',
    data: { ticket: summary },
  })

  return summary
}

export async function addTicketTag(ticketId: string, tagId: string): Promise<boolean> {
  const ticket = db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) return false

  const tag = db.select().from(projectTags).where(eq(projectTags.id, tagId)).get()
  if (!tag || tag.projectId !== ticket.projectId) return false

  db.insert(ticketTags)
    .values({ ticketId, tagId })
    .onConflictDoNothing()
    .run()

  // Trigger a ticket:updated broadcast so kanban refreshes
  const summary = await getTicketSummary(ticketId)
  if (summary) {
    sseManager.broadcast({ type: 'ticket:updated', data: { ticket: summary } })
  }
  return true
}

export async function removeTicketTag(ticketId: string, tagId: string): Promise<boolean> {
  const existing = db
    .select({ ticketId: ticketTags.ticketId })
    .from(ticketTags)
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .get()
  if (!existing) return false

  db.delete(ticketTags)
    .where(and(eq(ticketTags.ticketId, ticketId), eq(ticketTags.tagId, tagId)))
    .run()

  const summary = await getTicketSummary(ticketId)
  if (summary) {
    sseManager.broadcast({ type: 'ticket:updated', data: { ticket: summary } })
  }
  return true
}

async function getTicketSummary(ticketId: string): Promise<TicketSummary | null> {
  const row = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!row) return null
  const tags = await fetchTagsForTicket(ticketId)
  const [taskCountsMap, runningAgentsMap, attachmentCountsMap, runningSinceMap] = await Promise.all([
    fetchTaskCountsForTickets([ticketId]),
    fetchRunningAgentsForTickets([ticketId]),
    fetchAttachmentCountsForTickets([ticketId]),
    fetchRunningSinceForTickets([ticketId]),
  ])
  const counts = taskCountsMap.get(ticketId) ?? { total: 0, running: 0, awaitingInput: 0 }
  const runningAgents = runningAgentsMap.get(ticketId) ?? []
  const reporter = await fetchReporterForTicket(row.reporterUserId, row.reporterAgentId)
  const attachmentCount = attachmentCountsMap.get(ticketId) ?? 0
  const runningSince = runningSinceMap.get(ticketId) ?? null
  return rowToTicketSummary(row, tags, counts, runningAgents, reporter, attachmentCount, runningSince)
}

/** Re-fetch a ticket summary and broadcast a `ticket:updated` SSE event.
 *  Used by ticket-attachments service (and any other side-effect surface) to
 *  refresh client caches after a non-core mutation that doesn't touch the
 *  tickets row itself. */
export async function broadcastTicketUpdated(ticketId: string): Promise<void> {
  const summary = await getTicketSummary(ticketId)
  if (summary) {
    sseManager.broadcast({ type: 'ticket:updated', data: { ticket: summary } })
  }
}

// ─── Prompt block info ────────────────────────────────────────────────────────

/** Fetch the current ticket + its project context for the sub-Agent prompt.
 *  Returns null if the ticket has been deleted (graceful fallback).
 *
 *  `options.runPrompt` is the optional sur-prompt persisted on the task row
 *  at spawn time. It is injected into the assignment block as its own
 *  "Run-specific instructions" section so the agent can scope its run
 *  without conflating it with the ticket description. */
export async function buildTicketAssignmentInfo(
  ticketId: string,
  options: { runPrompt?: string | null; currentTaskId?: string | null } = {},
): Promise<TicketAssignmentInfo | null> {
  const ticket = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) return null

  const project = db.select().from(projects).where(eq(projects.id, ticket.projectId)).get()
  if (!project) return null

  const tagLabels = db
    .select({ label: projectTags.label })
    .from(ticketTags)
    .innerJoin(projectTags, eq(ticketTags.tagId, projectTags.id))
    .where(eq(ticketTags.ticketId, ticketId))
    .all()
    .map((r) => r.label)

  const taskRows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      kind: tasks.kind,
      parentAgentName: agents.name,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
      result: tasks.result,
      error: tasks.error,
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.parentAgentId, agents.id))
    .where(eq(tasks.ticketId, ticketId))
    .orderBy(desc(tasks.createdAt))
    .limit(20)
    .all()

  const taskHistory = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    kind: t.kind,
    parentAgentName: t.parentAgentName,
    createdAt: toMillis(t.createdAt),
    updatedAt: toMillis(t.updatedAt),
    result: t.result,
    error: t.error,
    isCurrent: options.currentTaskId === t.id,
  }))

  // Dynamic import to avoid a static cycle: ticket-comments → tickets is fine,
  // but tickets → ticket-comments would pull the comments module into the
  // tickets module graph unnecessarily for many callers.
  const { listRecentCommentsForPrompt } = await import('@/server/services/ticket-comments')
  const comments = await listRecentCommentsForPrompt(ticketId, 50)

  // Capture pinned project knowledge into the snapshot. Frozen for cache
  // stability — newly pinned entries appear only at the next ticket task spawn
  // (or via live `search_project_knowledge` calls from inside the sub-Agent).
  let pinnedKnowledge: TicketAssignmentInfo['pinnedKnowledge'] = []
  let knowledgeIndex: TicketAssignmentInfo['knowledgeIndex'] = []
  let totalKnowledgeCount = 0
  try {
    const { getPinnedKnowledge, countProjectKnowledge, listKnowledgeIndex } = await import('@/server/services/project-knowledge')
    const [pinned, index, total] = await Promise.all([
      getPinnedKnowledge(project.id),
      listKnowledgeIndex(project.id),
      countProjectKnowledge(project.id),
    ])
    pinnedKnowledge = pinned.map((p) => ({
      id: p.id,
      title: p.title,
      content: p.content,
      category: p.category,
      authorAgentName: p.authorAgentName,
    }))
    knowledgeIndex = index
    totalKnowledgeCount = total
  } catch {
    // ignore — best-effort
  }

  return {
    ticketId: ticket.id,
    ticketNumber: ticket.number ?? null,
    ticketTitle: ticket.title,
    ticketDescription: ticket.description,
    ticketStatus: ticket.status,
    ticketTags: tagLabels,
    projectId: project.id,
    projectSlug: project.slug ?? '',
    projectTitle: project.title,
    projectDescription: project.description,
    projectGithubUrl: project.githubUrl,
    taskHistory,
    comments,
    runPrompt: options.runPrompt ?? null,
    pinnedKnowledge,
    knowledgeIndex,
    totalKnowledgeCount,
  }
}

// ─── Start a ticket task ──────────────────────────────────────────────────────

export interface StartTicketTaskResult {
  taskId: string
  ticketId: string
  parentAgentId: string
  status: string
  mode: 'await'
  createdAt: number
}

/** Maximum length of the optional run-specific sur-prompt accepted at task
 *  spawn. Kept short on purpose: this is a focus hint, not a way to rewrite
 *  the ticket from scratch. Enforced both at the API surface and in the
 *  spawn helper to keep persisted rows bounded. */
export const TICKET_TASK_RUN_PROMPT_MAX = 500

/** Spawn a sub-Agent to work on a ticket. Always in await mode (projects.md § 5).
 *  No side-effect on the ticket — the Agent manages status manually.
 *
 *  `options.runPrompt` is an optional free-form sur-prompt that scopes this
 *  particular run (e.g. "only backend", "stop after migration phase"). It is
 *  persisted on the task row and injected into the brief at prompt-build time. */
export async function startTicketTask(
  ticketId: string,
  parentAgentId: string,
  options: {
    runPrompt?: string | null
    toolboxIds?: string[]
    /** Per-run model override. Must be paired with `providerId`. When unset,
     *  spawnTask falls back to project default → Agent model. */
    model?: string
    providerId?: string
    /** Per-run thinking/effort override. When unset, spawnTask falls back to
     *  project default → Agent config. */
    thinkingConfig?: AgentThinkingConfig
  } = {},
): Promise<StartTicketTaskResult> {
  const ticket = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) throw new Error('TICKET_NOT_FOUND')

  const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.id, parentAgentId)).get()
  if (!agent) throw new Error('KIN_NOT_FOUND')

  // Gate: when the ticket's project has a GitHub repo wired up, refuse to
  // spawn until the per-project clone is ready. Otherwise the sub-task
  // runner would fail mid-setup trying to fork a worktree off a missing/
  // broken clone — better to surface a clear error at the tool layer so
  // the parent Agent can prompt the user to retry the clone from the UI.
  const project = db
    .select({ githubRepo: projects.githubRepo, cloneStatus: projects.cloneStatus })
    .from(projects)
    .where(eq(projects.id, ticket.projectId))
    .get()
  if (project?.githubRepo && project.cloneStatus !== 'ready') {
    throw new Error('CLONE_NOT_READY')
  }

  const trimmedRunPrompt = options.runPrompt?.trim() ?? ''
  const runPrompt = trimmedRunPrompt.length > 0
    ? trimmedRunPrompt.slice(0, TICKET_TASK_RUN_PROMPT_MAX)
    : null

  // Description is intentionally short — the rich ticket context is injected
  // at prompt-build time from tasks.ticket_id (always the current version).
  const description = `Work on ticket: ${ticket.title}`

  const result = await spawnTask({
    parentAgentId,
    description,
    title: `Ticket: ${ticket.title}`,
    mode: 'await',
    spawnType: 'self',
    ticketId,
    runPrompt,
    // Freeze the user-chosen toolbox selection onto the task. When omitted,
    // spawnTask/resolveTaskToolboxIds falls back to the project default, then
    // the 'code' built-in for ticket tasks (back-compat with old presets).
    toolboxIds: options.toolboxIds && options.toolboxIds.length > 0 ? options.toolboxIds : undefined,
    // Per-run overrides. When unset, spawnTask resolves model/thinking via
    // project default → Agent (priority chain handled inside spawnTask).
    model: options.model,
    providerId: options.providerId,
    thinkingConfig: options.thinkingConfig,
  })

  // Re-read the row to expose status + createdAt without coupling to spawnTask's return shape.
  const row = db.select().from(tasks).where(eq(tasks.id, result.taskId)).get()
  if (!row) throw new Error('TASK_NOT_FOUND_AFTER_SPAWN')

  return {
    taskId: row.id,
    ticketId,
    parentAgentId,
    status: row.status,
    mode: 'await',
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
  }
}

// ─── Ticket enrichment ────────────────────────────────────────────────────────

/** Description length threshold above which the enrich agent should append a
 *  new section rather than rewrite the existing description from scratch. */
export const TICKET_ENRICH_REWRITE_THRESHOLD = 500

export interface StartTicketEnrichmentResult {
  taskId: string
  ticketId: string
  parentAgentId: string
  status: string
  mode: 'await'
  kind: 'enrich'
  createdAt: number
}

/** Returns true if an enrichment task is already in flight on this ticket. */
export async function hasActiveEnrichment(ticketId: string): Promise<boolean> {
  const row = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.ticketId, ticketId),
        eq(tasks.kind, 'enrich'),
        inArray(tasks.status, [
          'queued',
          'pending',
          'in_progress',
          'paused',
          'awaiting_human_input',
          'awaiting_agent_response',
          'awaiting_subtask',
        ]),
      ),
    )
    .limit(1)
    .get()
  return !!row
}

/** Build the system mission used by the dedicated enrichment sub-Agent.
 *  This is injected as the task description (= "## Your mission" block) so we
 *  don't need a new prompt-builder branch — the regular `## Ticket assignment`
 *  block already carries the current ticket state. */
export function buildEnrichmentBrief(input: {
  ticketTitle: string
  descriptionLength: number
  focus?: string | null
}): string {
  const today = new Date().toISOString().slice(0, 10)
  const longDescription = input.descriptionLength > TICKET_ENRICH_REWRITE_THRESHOLD
  const writeMode = longDescription
    ? `The current description is already substantial (> ${TICKET_ENRICH_REWRITE_THRESHOLD} chars). ` +
      `Do NOT rewrite it from scratch. Instead, APPEND a new "## Enrichment (${today})" section at the end ` +
      `that adds missing context, spec, acceptance criteria, repro steps, file pointers, effort estimate. ` +
      `Preserve everything that was already there.`
    : `The current description is short or empty. Rewrite it entirely with: ` +
      `clear context, symptom/repro if bug, proposed spec or design, acceptance criteria, ` +
      `relevant files/lines, estimated effort.`

  const focusBlock = input.focus && input.focus.trim().length > 0
    ? `\n\n## Specific focus\n\nThe user asked for an enrichment with this orientation:\n> ${input.focus.trim()}\n\nKeep this focus in mind while writing the new content.`
    : ''

  return (
    `Enrich ticket: ${input.ticketTitle}\n\n` +
    `You are a ticket-enrichment agent. Your job is NOT to implement or fix anything — only to make this ticket actionable for whoever picks it up next.\n\n` +
    `## What to do\n\n` +
    `1. Read the existing ticket title, description, and tags (visible in the "Ticket you are working on" block above).\n` +
    `2. Gather context. Use any tool that helps:\n` +
    `   - read_file / grep / list_directory on the project repo (gezy-dev/) for code and docs\n` +
    `   - search_history if the ticket might have been discussed in chat\n` +
    `   - list_tickets / get_ticket to cross-check related tickets in the same project\n` +
    `   - If a GitHub URL is set on the project, you may consult GitHub issues for additional context.\n` +
    `3. Rewrite the ticket to make it executable:\n` +
    `   - **Title**: rewrite only if it is vague or misleading. Keep it short and specific.\n` +
    `   - **Description**: ${writeMode}\n` +
    `   - **Tags**: add missing tags (bug / feature / chore / doc / refactor / ...) or remove incorrect ones. Use list_project_tags to discover the palette. Do not invent new tags.\n` +
    `4. Apply your changes via update_ticket(). All three fields (title, description, tag_ids) can be passed in a single call.\n` +
    `5. Append a small audit footer to the description (a final line):\n` +
    `   \`> _Enriched on ${today} by agent._\`\n` +
    `   This makes it visible at a glance that the ticket was touched by an enrichment pass.${focusBlock}\n\n` +
    `## Guard rails\n\n` +
    `- Do NOT change the ticket status — leave it where it is.\n` +
    `- Do NOT create new tickets, do NOT delete tickets, do NOT delete tags.\n` +
    `- Do NOT spawn sub-tasks of your own.\n` +
    `- Be concise. The goal is clarity, not verbosity. Avoid em-dashes per repo conventions.\n` +
    `- If after investigation you have nothing meaningful to add (ticket already clear), say so in your final result via update_task_status("completed", "...") and skip the update_ticket call.\n\n` +
    `## When you are done\n\n` +
    `Call update_task_status("completed", "<one-line summary of what you changed>"). ` +
    `If you could not enrich (e.g. ticket was deleted, no context found), call update_task_status("failed", undefined, "<reason>").`
  )
}

/** Spawn a dedicated enrichment sub-Agent on a ticket. Always in await mode.
 *  Refuses if another enrichment is already in flight on the same ticket. */
export async function startTicketEnrichment(
  ticketId: string,
  parentAgentId: string,
  options: { focus?: string | null } = {},
): Promise<StartTicketEnrichmentResult> {
  const ticket = db.select().from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!ticket) throw new Error('TICKET_NOT_FOUND')

  const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.id, parentAgentId)).get()
  if (!agent) throw new Error('KIN_NOT_FOUND')

  if (await hasActiveEnrichment(ticketId)) {
    throw new Error('ENRICHMENT_ALREADY_RUNNING')
  }

  const description = buildEnrichmentBrief({
    ticketTitle: ticket.title,
    descriptionLength: ticket.description?.length ?? 0,
    focus: options.focus ?? null,
  })

  const result = await spawnTask({
    parentAgentId,
    description,
    title: `Enrich ticket: ${ticket.title}`,
    mode: 'await',
    spawnType: 'self',
    ticketId,
    kind: 'enrich',
  })

  const row = db.select().from(tasks).where(eq(tasks.id, result.taskId)).get()
  if (!row) throw new Error('TASK_NOT_FOUND_AFTER_SPAWN')

  return {
    taskId: row.id,
    ticketId,
    parentAgentId,
    status: row.status,
    mode: 'await',
    kind: 'enrich',
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
  }
}

export async function deleteTicket(ticketId: string): Promise<boolean> {
  const existing = db.select({ projectId: tickets.projectId }).from(tickets).where(eq(tickets.id, ticketId)).get()
  if (!existing) return false

  // Clean up attachment files on disk BEFORE the cascade wipes the rows.
  // Dynamic import to avoid a static cycle (ticket-attachments imports tickets
  // for broadcastTicketUpdated).
  try {
    const { purgeAttachmentsForTicket } = await import('@/server/services/ticket-attachments')
    await purgeAttachmentsForTicket(ticketId)
  } catch {
    // Best-effort cleanup; the DB rows will still cascade away below.
  }

  // Cascade: ticket_tags + ticket_attachments removed by FK. tasks.ticket_id set to NULL by FK (history preserved).
  db.delete(tickets).where(eq(tickets.id, ticketId)).run()

  sseManager.broadcast({
    type: 'ticket:deleted',
    data: { ticketId, projectId: existing.projectId },
  })

  return true
}
