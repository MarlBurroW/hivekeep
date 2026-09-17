import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { agentProfiles } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { countTokens } from '@/shared/token-estimator'
import { createLogger } from '@/server/logger'

const log = createLogger('agent-profile')

/** Section holding entries the maintenance rewrite must reproduce verbatim. */
export const PINNED_SECTION = 'Pinned'

export type ProfileUpdateSource = 'maintenance' | 'tool' | 'user' | 'regenerate'

export interface AgentProfile {
  content: string
  tokenEstimate: number
  lastRewriteAt: Date | null
  manuallyEditedAt: Date | null
  updatedAt: Date | null
}

const EMPTY: AgentProfile = {
  content: '',
  tokenEstimate: 0,
  lastRewriteAt: null,
  manuallyEditedAt: null,
  updatedAt: null,
}

export function getProfileBudget(): number {
  return config.memory.profileMaxTokens
}

export async function getProfile(agentId: string): Promise<AgentProfile> {
  const row = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .get()
  if (!row) return { ...EMPTY }
  return {
    content: row.content,
    tokenEstimate: row.tokenEstimate,
    lastRewriteAt: row.lastRewriteAt,
    manuallyEditedAt: row.manuallyEditedAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Write a profile document, creating the row on first write.
 *
 * Callers pass a fully-formed document: the maintenance rewrite, a tool edit,
 * or a user edit. The write is the only place `token_estimate` is computed, so
 * it can never drift from `content`.
 */
export async function setProfile(
  agentId: string,
  content: string,
  source: ProfileUpdateSource,
): Promise<AgentProfile> {
  const now = new Date()
  const trimmed = content.trim()
  const tokenEstimate = countTokens(trimmed)

  const existing = await db
    .select({ id: agentProfiles.id })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, agentId))
    .get()

  const timestamps = {
    ...(source === 'user' ? { manuallyEditedAt: now } : {}),
    ...(source === 'maintenance' || source === 'regenerate' ? { lastRewriteAt: now } : {}),
  }

  if (existing) {
    await db
      .update(agentProfiles)
      .set({ content: trimmed, tokenEstimate, updatedAt: now, ...timestamps })
      .where(eq(agentProfiles.agentId, agentId))
  } else {
    await db.insert(agentProfiles).values({
      id: uuid(),
      agentId,
      content: trimmed,
      tokenEstimate,
      createdAt: now,
      updatedAt: now,
      lastRewriteAt: null,
      manuallyEditedAt: null,
      ...timestamps,
    })
  }

  log.debug({ agentId, source, tokenEstimate }, 'Agent profile written')

  sseManager.sendToAgent(agentId, {
    type: 'agent-profile:updated',
    agentId,
    data: { agentId, tokenEstimate, source },
  })

  return getProfile(agentId)
}

// ─── Section-level editing ───────────────────────────────────────────────────

interface ParsedSection {
  title: string
  lines: string[]
}

/**
 * Split a profile document into `## ` sections. Content appearing before the
 * first heading is preserved under an empty title so a malformed or
 * hand-written document never loses text on a round-trip.
 */
export function parseSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = []
  let current: ParsedSection = { title: '', lines: [] }

  for (const line of content.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      if (current.title || current.lines.some((l) => l.trim())) sections.push(current)
      current = { title: heading[1]!, lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  if (current.title || current.lines.some((l) => l.trim())) sections.push(current)

  return sections
}

export function serializeSections(sections: ParsedSection[]): string {
  return sections
    .map((s) => {
      const body = s.lines.join('\n').replace(/^\n+|\n+$/g, '')
      if (!s.title) return body
      return body ? `## ${s.title}\n\n${body}` : `## ${s.title}`
    })
    .filter((block) => block.trim().length > 0)
    .join('\n\n')
}

export type ProfileEditOperation = 'append' | 'replace_section' | 'remove_line'

export class ProfileBudgetError extends Error {
  constructor(readonly tokenEstimate: number, readonly budget: number) {
    super(
      `The profile would reach ${tokenEstimate} tokens, over the ${budget}-token budget. ` +
      `Remove or condense existing entries first, or move episodic detail to the archive with memorize().`,
    )
    this.name = 'ProfileBudgetError'
  }
}

export class ProfileLineNotFoundError extends Error {
  constructor(readonly line: string, readonly section: string) {
    super(`No line matching "${line}" was found in section "${section}".`)
    this.name = 'ProfileLineNotFoundError'
  }
}

/**
 * Apply a single structured edit to a profile document and return the new
 * document. Pure: no I/O, so the operations are directly testable.
 */
export function applyProfileEdit(
  content: string,
  edit: { section: string; operation: ProfileEditOperation; content: string; pin?: boolean },
): string {
  const targetTitle = edit.pin ? PINNED_SECTION : edit.section
  const sections = parseSections(content)
  const index = sections.findIndex((s) => s.title.toLowerCase() === targetTitle.toLowerCase())

  if (edit.operation === 'remove_line') {
    if (index === -1) throw new ProfileLineNotFoundError(edit.content, targetTitle)
    const target = sections[index]!
    const needle = edit.content.trim().replace(/^[-*]\s*/, '')
    const kept = target.lines.filter((l) => l.trim().replace(/^[-*]\s*/, '') !== needle)
    if (kept.length === target.lines.length) throw new ProfileLineNotFoundError(edit.content, targetTitle)
    target.lines = kept
    // Drop the section if the removal emptied it, so the document doesn't
    // accumulate bare headings.
    if (!target.lines.some((l) => l.trim())) sections.splice(index, 1)
    return serializeSections(sections)
  }

  const body = edit.content.trim()

  if (edit.operation === 'replace_section') {
    if (index === -1) sections.push({ title: targetTitle, lines: body.split('\n') })
    else sections[index]!.lines = body.split('\n')
    return serializeSections(sections)
  }

  // append
  if (index === -1) {
    sections.push({ title: targetTitle, lines: body.split('\n') })
  } else {
    const target = sections[index]!
    const existing = target.lines.filter((l) => l.trim())
    target.lines = [...existing, ...body.split('\n')]
  }
  return serializeSections(sections)
}

/**
 * Whether an edit may be persisted given the token budget.
 *
 * Over-budget results are refused, with one exception: an edit that SHRINKS the
 * document always passes. A profile can legitimately sit above budget (the
 * maintenance rewrite tolerates an overshoot, and a single oversized section
 * cannot be truncated), and refusing the very edits that bring it back down
 * would leave no way out.
 */
export function isEditAllowedByBudget(current: string, next: string, budget: number): boolean {
  if (budget <= 0) return true
  const tokens = countTokens(next)
  if (tokens <= budget) return true
  return tokens < countTokens(current)
}

/**
 * Apply an edit and persist it, enforcing the token budget.
 * Throws ProfileBudgetError / ProfileLineNotFoundError so callers can surface
 * an actionable message to the model or the user.
 */
export async function editProfile(
  agentId: string,
  edit: { section: string; operation: ProfileEditOperation; content: string; pin?: boolean },
  source: ProfileUpdateSource = 'tool',
): Promise<AgentProfile> {
  const current = await getProfile(agentId)
  const next = applyProfileEdit(current.content, edit)

  const budget = getProfileBudget()
  const tokens = countTokens(next)
  if (!isEditAllowedByBudget(current.content, next, budget)) {
    throw new ProfileBudgetError(tokens, budget)
  }

  return setProfile(agentId, next, source)
}
