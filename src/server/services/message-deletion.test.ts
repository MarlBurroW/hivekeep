/**
 * Integration tests for the selective message-deletion cascade against a real
 * in-memory SQLite DB with PRAGMA foreign_keys=ON (matching production) — this
 * is a data-destruction path, so every reference repair is pinned here.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// Schema-pollution guard (same pattern as model-registry.test.ts): some test
// files stub @/server/db/schema globally; fail if isolation is missing.
const schemaIsReal = !!(schema as { messages?: { id?: unknown } }).messages?.id
if (!schemaIsReal) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const d = describe

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = ON')
// Minimal DDL for the tables the cascade touches. Column names mirror the real
// schema; FK/cascade semantics mirror production (reactions cascade, the rest
// don't). No agents/user tables — those FKs are omitted on purpose.
sqlite.run(`CREATE TABLE messages (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  task_id text,
  session_id text,
  role text NOT NULL,
  content text,
  source_type text NOT NULL,
  created_at integer NOT NULL
)`)
sqlite.run(`CREATE TABLE files (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  message_id text REFERENCES messages(id),
  stored_path text NOT NULL
)`)
sqlite.run(`CREATE TABLE human_prompts (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  message_id text REFERENCES messages(id)
)`)
sqlite.run(`CREATE TABLE memories (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  source_message_id text REFERENCES messages(id)
)`)
sqlite.run(`CREATE TABLE compacting_snapshots (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  summary text NOT NULL,
  messages_up_to_id text NOT NULL REFERENCES messages(id),
  is_active integer NOT NULL DEFAULT 1,
  created_at integer NOT NULL
)`)
sqlite.run(`CREATE TABLE compacting_summaries (
  id text PRIMARY KEY NOT NULL,
  agent_id text NOT NULL,
  summary text NOT NULL,
  first_message_at integer NOT NULL,
  last_message_at integer NOT NULL,
  first_message_id text REFERENCES messages(id),
  last_message_id text NOT NULL REFERENCES messages(id),
  message_count integer NOT NULL DEFAULT 0,
  token_estimate integer NOT NULL DEFAULT 0,
  is_in_context integer NOT NULL DEFAULT 1,
  depth integer NOT NULL DEFAULT 0,
  source_summary_ids text,
  created_at integer NOT NULL
)`)
sqlite.run(`CREATE TABLE message_reactions (
  id text PRIMARY KEY NOT NULL,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  emoji text NOT NULL,
  created_at integer NOT NULL
)`)

const testDb = drizzle(sqlite, { schema })
mock.module('@/server/db/index', () => ({ db: testDb, sqlite }))

const svc = schemaIsReal
  ? await import('@/server/services/message-deletion')
  : ({} as typeof import('@/server/services/message-deletion'))
const { deleteMessagesCascade } = svc

const AGENT = 'agent-1'

function seedMessage(id: string, at: number, role = 'user'): void {
  sqlite.run(
    `INSERT INTO messages (id, agent_id, role, content, source_type, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, AGENT, role, `content-${id}`, 'user', at],
  )
}

const count = (table: string, where = '1=1'): number =>
  (sqlite.query(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get() as { n: number }).n

beforeEach(() => {
  if (!schemaIsReal) return
  for (const t of ['message_reactions', 'compacting_summaries', 'compacting_snapshots', 'memories', 'human_prompts', 'files', 'messages']) {
    sqlite.run(`DELETE FROM ${t}`)
  }
})

d('deleteMessagesCascade', () => {
  it('deletes the rows and cascades reactions automatically', async () => {
    seedMessage('m1', 1000)
    seedMessage('m2', 2000)
    sqlite.run(`INSERT INTO message_reactions (id, message_id, user_id, emoji, created_at) VALUES ('r1', 'm2', 'u1', '👍', 1)`)

    await deleteMessagesCascade(AGENT, ['m2'])

    expect(count('messages')).toBe(1)
    expect(count('messages', `id='m1'`)).toBe(1)
    expect(count('message_reactions')).toBe(0) // ON DELETE CASCADE
  })

  it('nullifies human_prompts and memories references (rows survive)', async () => {
    seedMessage('m1', 1000)
    sqlite.run(`INSERT INTO human_prompts (id, agent_id, message_id) VALUES ('hp1', '${AGENT}', 'm1')`)
    sqlite.run(`INSERT INTO memories (id, agent_id, source_message_id) VALUES ('mem1', '${AGENT}', 'm1')`)

    await deleteMessagesCascade(AGENT, ['m1'])

    expect(count('messages')).toBe(0)
    expect(count('human_prompts', `message_id IS NULL`)).toBe(1)
    expect(count('memories', `source_message_id IS NULL`)).toBe(1)
  })

  it('deletes attached file rows and snapshot rows referencing deleted ids', async () => {
    seedMessage('m1', 1000)
    seedMessage('m2', 2000)
    sqlite.run(`INSERT INTO files (id, agent_id, message_id, stored_path) VALUES ('f1', '${AGENT}', 'm2', '/nonexistent/${crypto.randomUUID()}')`)
    sqlite.run(`INSERT INTO compacting_snapshots (id, agent_id, summary, messages_up_to_id, created_at) VALUES ('snap1', '${AGENT}', 's', 'm2', 1)`)

    await deleteMessagesCascade(AGENT, ['m2'])

    expect(count('files')).toBe(0)
    expect(count('compacting_snapshots')).toBe(0)
    expect(count('messages')).toBe(1)
  })

  it('repoints a summary lastMessageId boundary to the latest surviving message ≤ cutoff', async () => {
    seedMessage('m1', 1000)
    seedMessage('m2', 2000)
    seedMessage('m3', 3000)
    sqlite.run(`INSERT INTO compacting_summaries (id, agent_id, summary, first_message_at, last_message_at, first_message_id, last_message_id, created_at)
      VALUES ('s1', '${AGENT}', 'sum', 1000, 2000, 'm1', 'm2', 1)`)

    await deleteMessagesCascade(AGENT, ['m2'])

    const s = sqlite.query(`SELECT last_message_id, last_message_at FROM compacting_summaries WHERE id='s1'`).get() as { last_message_id: string; last_message_at: number }
    expect(s.last_message_id).toBe('m1') // repointed to the survivor ≤ cutoff
    expect(s.last_message_at).toBe(2000) // the engine's timestamp cutoff is untouched
  })

  it('deletes the summary when no surviving message can hold the boundary', async () => {
    seedMessage('m1', 1000)
    seedMessage('m2', 2000)
    sqlite.run(`INSERT INTO compacting_summaries (id, agent_id, summary, first_message_at, last_message_at, last_message_id, created_at)
      VALUES ('s1', '${AGENT}', 'sum', 1000, 2000, 'm2', 1)`)

    await deleteMessagesCascade(AGENT, ['m1', 'm2'])

    expect(count('compacting_summaries')).toBe(0)
    expect(count('messages')).toBe(0)
  })

  it('nullifies a deleted firstMessageId boundary', async () => {
    seedMessage('m1', 1000)
    seedMessage('m2', 2000)
    sqlite.run(`INSERT INTO compacting_summaries (id, agent_id, summary, first_message_at, last_message_at, first_message_id, last_message_id, created_at)
      VALUES ('s1', '${AGENT}', 'sum', 1000, 2000, 'm1', 'm2', 1)`)

    await deleteMessagesCascade(AGENT, ['m1'])

    const s = sqlite.query(`SELECT first_message_id FROM compacting_summaries WHERE id='s1'`).get() as { first_message_id: string | null }
    expect(s.first_message_id).toBeNull()
  })

  it('never repoints a boundary onto a message deleted by a later chunk (>500 ids)', async () => {
    // m_keep (oldest survivor), then 600 deleted messages; the summary boundary
    // sits on the LAST of them — its replacement candidates are almost all in
    // the deletion set, spread across two chunks.
    seedMessage('m_keep', 1)
    const ids: string[] = []
    for (let i = 0; i < 600; i++) {
      const id = `del-${String(i).padStart(3, '0')}`
      seedMessage(id, 100 + i)
      ids.push(id)
    }
    sqlite.run(`INSERT INTO compacting_summaries (id, agent_id, summary, first_message_at, last_message_at, last_message_id, created_at)
      VALUES ('s1', '${AGENT}', 'sum', 1, 699, 'del-599', 1)`)

    await deleteMessagesCascade(AGENT, ids)

    expect(count('messages')).toBe(1)
    const s = sqlite.query(`SELECT last_message_id FROM compacting_summaries WHERE id='s1'`).get() as { last_message_id: string }
    expect(s.last_message_id).toBe('m_keep')
  })

  it('only touches the requested agent and ids', async () => {
    seedMessage('m1', 1000)
    sqlite.run(`INSERT INTO messages (id, agent_id, role, content, source_type, created_at) VALUES ('other', 'agent-2', 'user', 'x', 'user', 1000)`)

    await deleteMessagesCascade(AGENT, ['m1', 'other'])

    expect(count('messages', `id='other'`)).toBe(1) // different agent — untouched
  })
})
