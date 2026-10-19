/**
 * Agent groups — named folders that organise the Agent roster in the sidebar.
 *
 * A group is global, exactly like the Agents it holds: this instance shows the
 * same Agent list to everyone, so the folders that tidy it are shared too.
 * What stays personal is ORDER — `user_profiles.agent_order` keeps its existing
 * meaning and is applied within each group at render time, so two users can
 * order the same group differently.
 *
 * Membership lives on `agents.group_id` (nullable, ON DELETE SET NULL):
 *
 *   - null            → ungrouped; rendered as a plain list above the groups,
 *                       which is byte-for-byte the pre-groups behaviour.
 *   - a group id      → rendered under that group's collapsible header.
 *
 * Deleting a group therefore never deletes Agents — it ungroups them.
 */

import { eq, asc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { agentGroups, agents } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import type { AgentGroup } from '@/shared/types'

const log = createLogger('agent-groups')

/** Longest accepted group name. Long enough for "Finanças da casa", short
 *  enough that a sidebar header never needs to wrap to three lines. */
export const AGENT_GROUP_NAME_MAX = 60

type AgentGroupRow = typeof agentGroups.$inferSelect

function rowToGroup(row: AgentGroupRow): AgentGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  }
}

/**
 * Validate and normalise a group name.
 *
 * Throws AGENT_GROUP_NAME_REQUIRED when empty after trimming and
 * AGENT_GROUP_NAME_TOO_LONG past the cap, so callers can map both to 400.
 */
function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('AGENT_GROUP_NAME_REQUIRED')
  if (name.length > AGENT_GROUP_NAME_MAX) throw new Error('AGENT_GROUP_NAME_TOO_LONG')
  return name
}

/** List every group, in display order: `sortOrder` ascending, then name so the
 *  order is total and stable (all groups start at sortOrder 0 + n). */
export function listAgentGroups(): AgentGroup[] {
  const rows = db.select().from(agentGroups).orderBy(asc(agentGroups.sortOrder), asc(agentGroups.name)).all()
  return rows.map(rowToGroup)
}

export function getAgentGroup(id: string): AgentGroup | null {
  const row = db.select().from(agentGroups).where(eq(agentGroups.id, id)).get()
  return row ? rowToGroup(row) : null
}

function getAgentGroupByName(name: string): AgentGroup | null {
  const row = db.select().from(agentGroups).where(eq(agentGroups.name, name)).get()
  return row ? rowToGroup(row) : null
}

export function createAgentGroup(input: { name: string; sortOrder?: number }): AgentGroup {
  const name = normalizeName(input.name)
  if (getAgentGroupByName(name)) throw new Error('AGENT_GROUP_NAME_TAKEN')

  // Default to the end of the list rather than 0, so a new group does not
  // silently jump above existing ones on a name tie-break.
  const sortOrder = input.sortOrder ?? nextSortOrder()
  const now = new Date()
  const id = uuid()
  db.insert(agentGroups).values({ id, name, sortOrder, createdAt: now, updatedAt: now }).run()

  const created = getAgentGroup(id)
  if (!created) throw new Error('Agent group creation failed: not found after insert')
  log.debug({ groupId: id, name }, 'Agent group created')
  sseManager.broadcast({ type: 'agent-group:created', data: created as unknown as Record<string, unknown> })
  return created
}

function nextSortOrder(): number {
  const rows = db.select({ sortOrder: agentGroups.sortOrder }).from(agentGroups).all()
  if (rows.length === 0) return 0
  return Math.max(...rows.map((r) => r.sortOrder)) + 1
}

export function updateAgentGroup(id: string, input: { name?: string; sortOrder?: number }): AgentGroup {
  const existing = getAgentGroup(id)
  if (!existing) throw new Error('AGENT_GROUP_NOT_FOUND')

  const patch: Partial<typeof agentGroups.$inferInsert> = { updatedAt: new Date() }
  if (input.name !== undefined) {
    const name = normalizeName(input.name)
    const clash = getAgentGroupByName(name)
    if (clash && clash.id !== id) throw new Error('AGENT_GROUP_NAME_TAKEN')
    patch.name = name
  }
  if (input.sortOrder !== undefined) {
    if (!Number.isInteger(input.sortOrder)) throw new Error('AGENT_GROUP_INVALID_SORT_ORDER')
    patch.sortOrder = input.sortOrder
  }

  db.update(agentGroups).set(patch).where(eq(agentGroups.id, id)).run()

  const updated = getAgentGroup(id)
  if (!updated) throw new Error('AGENT_GROUP_NOT_FOUND')
  sseManager.broadcast({ type: 'agent-group:updated', data: updated as unknown as Record<string, unknown> })
  return updated
}

/**
 * Delete a group. Its Agents are UNGROUPED, never deleted.
 *
 * The FK is ON DELETE SET NULL, but the null-out is done explicitly first: the
 * app boots with `PRAGMA foreign_keys = ON`, yet relying on the cascade would
 * make this depend on a connection pragma set elsewhere, and the migrator turns
 * that pragma OFF while it runs. Doing it here is one extra statement and makes
 * the outcome independent of pragma state.
 */
export function deleteAgentGroup(id: string): { ungroupedAgentIds: string[] } {
  const existing = getAgentGroup(id)
  if (!existing) throw new Error('AGENT_GROUP_NOT_FOUND')

  const members = db.select({ id: agents.id }).from(agents).where(eq(agents.groupId, id)).all()
  const ungroupedAgentIds = members.map((m) => m.id)

  db.update(agents).set({ groupId: null, updatedAt: new Date() }).where(eq(agents.groupId, id)).run()
  db.delete(agentGroups).where(eq(agentGroups.id, id)).run()

  log.debug({ groupId: id, ungrouped: ungroupedAgentIds.length }, 'Agent group deleted')
  sseManager.broadcast({ type: 'agent-group:deleted', data: { groupId: id, ungroupedAgentIds } })
  return { ungroupedAgentIds }
}

/**
 * Resolve a caller-supplied groupId into a value safe to write to
 * `agents.group_id`.
 *
 * Accepts null/'' (explicitly ungroup) and a known group id. Throws
 * AGENT_GROUP_NOT_FOUND for an unknown id rather than silently writing a
 * dangling reference — with foreign_keys ON that would fail at the DB anyway,
 * but as an opaque constraint error instead of a 404.
 */
export function resolveGroupIdForWrite(raw: unknown): string | null {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new Error('AGENT_GROUP_NOT_FOUND')
  if (!getAgentGroup(raw)) throw new Error('AGENT_GROUP_NOT_FOUND')
  return raw
}
