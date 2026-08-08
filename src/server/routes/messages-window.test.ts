/**
 * Pins the visibility predicate used by the message-history window against real
 * SQLite. The invariant: a page of `limit` really contains `limit` renderable
 * rows, so the client's cursor always advances. Hidden rows used to be dropped
 * after the limit, which returned short pages (down to empty) alongside
 * hasMore: true and stalled infinite scroll.
 *
 * The predicate is exercised as raw SQL rather than through Drizzle so this
 * runs regardless of the suite-wide `@/server/db/schema` module mocks.
 */
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { VISIBLE_MESSAGE_PREDICATE } from '@/server/routes/messages'

const AGENT = 'agent-1'

function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.run(`CREATE TABLE messages (
    id text PRIMARY KEY NOT NULL,
    agent_id text NOT NULL,
    task_id text,
    session_id text,
    metadata text,
    created_at integer NOT NULL
  )`)
  return sqlite
}

function insert(sqlite: Database, rows: Array<{ id: string; createdAt: number; metadata?: string | null }>) {
  for (const r of rows) {
    sqlite.run('INSERT INTO messages (id, agent_id, metadata, created_at) VALUES (?, ?, ?, ?)', [
      r.id,
      AGENT,
      r.metadata ?? null,
      r.createdAt,
    ])
  }
}

/** Mirrors the route: fetch limit + 1 rows to derive hasMore, newest first. */
function page(sqlite: Database, limit: number) {
  const raw = sqlite
    .query<{ id: string }, [string, number]>(
      `SELECT id FROM messages
       WHERE agent_id = ? AND task_id IS NULL AND session_id IS NULL AND ${VISIBLE_MESSAGE_PREDICATE}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(AGENT, limit + 1)
  const hasMore = raw.length > limit
  return { ids: (hasMore ? raw.slice(0, limit) : raw).map((r) => r.id), hasMore }
}

describe('VISIBLE_MESSAGE_PREDICATE', () => {
  it('fills a page with visible rows instead of shortening it', () => {
    const sqlite = makeDb()
    // Four hidden rows sit on top of three visible ones. A limit of 3 must
    // return all three visible rows, not the single leftover a post-filter left.
    insert(sqlite, [
      { id: 'v1', createdAt: 1 },
      { id: 'v2', createdAt: 2 },
      { id: 'v3', createdAt: 3 },
      { id: 'h1', createdAt: 4, metadata: '{"hidden":true}' },
      { id: 'h2', createdAt: 5, metadata: '{"hidden":true}' },
      { id: 'h3', createdAt: 6, metadata: '{"hidden":true}' },
      { id: 'h4', createdAt: 7, metadata: '{"hidden":true}' },
    ])
    expect(page(sqlite, 3)).toEqual({ ids: ['v3', 'v2', 'v1'], hasMore: false })
  })

  it('reports hasMore only when a further visible row exists', () => {
    const sqlite = makeDb()
    insert(sqlite, [
      { id: 'v1', createdAt: 1 },
      { id: 'v2', createdAt: 2 },
      { id: 'h1', createdAt: 3, metadata: '{"hidden":true}' },
    ])
    expect(page(sqlite, 1)).toEqual({ ids: ['v2'], hasMore: true })
    expect(page(sqlite, 2)).toEqual({ ids: ['v2', 'v1'], hasMore: false })
  })

  it('keeps rows whose metadata is absent, unrelated, false or unparseable', () => {
    const sqlite = makeDb()
    insert(sqlite, [
      { id: 'null-meta', createdAt: 1, metadata: null },
      { id: 'bad-json', createdAt: 2, metadata: 'not json' },
      { id: 'other-key', createdAt: 3, metadata: '{"channelId":"c1"}' },
      { id: 'hidden-false', createdAt: 4, metadata: '{"hidden":false}' },
      { id: 'hidden-true', createdAt: 5, metadata: '{"hidden":true}' },
    ])
    expect(page(sqlite, 10).ids).toEqual(['hidden-false', 'other-key', 'bad-json', 'null-meta'])
  })
})
