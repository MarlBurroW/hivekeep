/**
 * Tests for Agent groups — the named sidebar folders (services/agent-groups.ts).
 *
 * Spins up a real in-memory SQLite DB with the production schema (same pattern
 * as toolboxes.test.ts) so the actual drizzle queries run end-to-end, including
 * the one that matters most: deleting a group must UNGROUP its Agents, never
 * delete them.
 *
 * The `schemaIsReal` guard mirrors the sibling real-DB suites: Bun's
 * `mock.module` is process-global and leaks across files, so when another suite
 * has already stubbed `@/server/db/schema` this file skips instead of asserting
 * against a hollow schema.
 */
import { describe, it, expect, mock, beforeAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// ─── Mock pollution guard (matches sibling real-DB tests) ────────────────────
const schemaIsReal = !!(schema as any).agentGroups?.id && !!(schema as any).agents?.id

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = OFF')
const db = schemaIsReal ? drizzle(sqlite, { schema }) : (null as any)

if (schemaIsReal) {
  mock.module('@/server/db/index', () => ({ db, sqlite, initVirtualTables: () => {} }))
}

const svc = schemaIsReal
  ? await import('@/server/services/agent-groups')
  : ({} as typeof import('@/server/services/agent-groups'))
const {
  listAgentGroups,
  getAgentGroup,
  createAgentGroup,
  updateAgentGroup,
  deleteAgentGroup,
  resolveGroupIdForWrite,
  AGENT_GROUP_NAME_MAX,
} = svc as typeof import('@/server/services/agent-groups')

const itReal = schemaIsReal ? it : it.skip

// ─── Schema bootstrap (only the tables the service touches) ──────────────────
beforeAll(() => {
  if (!schemaIsReal) return
  sqlite.run(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // Trimmed to the columns this service reads/writes; the real table is far
  // wider, but a narrower one proves the queries touch nothing else.
  sqlite.run(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      group_id TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `)
})

beforeEach(() => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM agents')
  sqlite.run('DELETE FROM agent_groups')
})

function insertAgent(id: string, groupId: string | null): void {
  sqlite.run('INSERT INTO agents (id, name, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
    id,
    id,
    groupId,
    Date.now(),
    Date.now(),
  ])
}

function agentGroupOf(id: string): string | null {
  const row = sqlite.query<{ group_id: string | null }, [string]>('SELECT group_id FROM agents WHERE id = ?').get(id)
  return row?.group_id ?? null
}

describe('createAgentGroup', () => {
  itReal('creates a group and trims its name', () => {
    const group = createAgentGroup({ name: '  Finances  ' })
    expect(group.name).toBe('Finances')
    expect(getAgentGroup(group.id)?.name).toBe('Finances')
  })

  itReal('rejects an empty or whitespace-only name', () => {
    expect(() => createAgentGroup({ name: '   ' })).toThrow('AGENT_GROUP_NAME_REQUIRED')
  })

  itReal('rejects a name past the length cap', () => {
    expect(() => createAgentGroup({ name: 'x'.repeat(AGENT_GROUP_NAME_MAX + 1) })).toThrow(
      'AGENT_GROUP_NAME_TOO_LONG',
    )
  })

  itReal('rejects a duplicate name', () => {
    createAgentGroup({ name: 'Research' })
    expect(() => createAgentGroup({ name: 'Research' })).toThrow('AGENT_GROUP_NAME_TAKEN')
  })

  itReal('appends new groups to the end instead of stacking on sortOrder 0', () => {
    const first = createAgentGroup({ name: 'A' })
    const second = createAgentGroup({ name: 'B' })
    expect(first.sortOrder).toBe(0)
    expect(second.sortOrder).toBe(1)
  })
})

describe('listAgentGroups', () => {
  itReal('orders by sortOrder, then by name', () => {
    createAgentGroup({ name: 'Zebra', sortOrder: 0 })
    createAgentGroup({ name: 'Alpha', sortOrder: 0 })
    createAgentGroup({ name: 'Middle', sortOrder: -1 })

    expect(listAgentGroups().map((g) => g.name)).toEqual(['Middle', 'Alpha', 'Zebra'])
  })
})

describe('updateAgentGroup', () => {
  itReal('renames a group', () => {
    const group = createAgentGroup({ name: 'Old' })
    expect(updateAgentGroup(group.id, { name: 'New' }).name).toBe('New')
  })

  itReal('lets a group keep its own name', () => {
    const group = createAgentGroup({ name: 'Same' })
    expect(() => updateAgentGroup(group.id, { name: 'Same' })).not.toThrow()
  })

  itReal("rejects taking another group's name", () => {
    createAgentGroup({ name: 'Taken' })
    const other = createAgentGroup({ name: 'Free' })
    expect(() => updateAgentGroup(other.id, { name: 'Taken' })).toThrow('AGENT_GROUP_NAME_TAKEN')
  })

  itReal('rejects a non-integer sortOrder', () => {
    const group = createAgentGroup({ name: 'G' })
    expect(() => updateAgentGroup(group.id, { sortOrder: 1.5 })).toThrow('AGENT_GROUP_INVALID_SORT_ORDER')
  })

  itReal('throws for an unknown id', () => {
    expect(() => updateAgentGroup('nope', { name: 'x' })).toThrow('AGENT_GROUP_NOT_FOUND')
  })
})

describe('deleteAgentGroup', () => {
  itReal('ungroups its Agents instead of deleting them', () => {
    const group = createAgentGroup({ name: 'Doomed' })
    insertAgent('agent-1', group.id)
    insertAgent('agent-2', group.id)

    const { ungroupedAgentIds } = deleteAgentGroup(group.id)

    expect(ungroupedAgentIds.sort()).toEqual(['agent-1', 'agent-2'])
    expect(getAgentGroup(group.id)).toBeNull()
    // The Agents survive, with no group.
    expect(sqlite.query('SELECT count(*) AS c FROM agents').get()).toEqual({ c: 2 } as any)
    expect(agentGroupOf('agent-1')).toBeNull()
    expect(agentGroupOf('agent-2')).toBeNull()
  })

  itReal('leaves Agents of other groups untouched', () => {
    const doomed = createAgentGroup({ name: 'Doomed' })
    const kept = createAgentGroup({ name: 'Kept' })
    insertAgent('in-doomed', doomed.id)
    insertAgent('in-kept', kept.id)
    insertAgent('ungrouped', null)

    deleteAgentGroup(doomed.id)

    expect(agentGroupOf('in-kept')).toBe(kept.id)
    expect(agentGroupOf('ungrouped')).toBeNull()
  })

  itReal('throws for an unknown id', () => {
    expect(() => deleteAgentGroup('nope')).toThrow('AGENT_GROUP_NOT_FOUND')
  })
})

describe('resolveGroupIdForWrite', () => {
  itReal('maps null and empty string to null (ungroup)', () => {
    expect(resolveGroupIdForWrite(null)).toBeNull()
    expect(resolveGroupIdForWrite('')).toBeNull()
  })

  itReal('passes a known group id through', () => {
    const group = createAgentGroup({ name: 'Known' })
    expect(resolveGroupIdForWrite(group.id)).toBe(group.id)
  })

  itReal('rejects an unknown id rather than writing a dangling reference', () => {
    expect(() => resolveGroupIdForWrite('does-not-exist')).toThrow('AGENT_GROUP_NOT_FOUND')
  })

  itReal('rejects a non-string id', () => {
    expect(() => resolveGroupIdForWrite(42)).toThrow('AGENT_GROUP_NOT_FOUND')
  })
})
