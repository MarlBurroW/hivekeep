import { test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { searchConversation, conversationContext } from './message-search'

test('history search pages old matches and excludes private, task, redacted and hidden rows before counting', () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE messages(id TEXT, agent_id TEXT, task_id TEXT, session_id TEXT, is_redacted INTEGER DEFAULT 0, metadata TEXT, role TEXT, content TEXT, created_at INTEGER)')
  const add = db.prepare('INSERT INTO messages(id, agent_id, task_id, session_id, is_redacted, metadata, role, content, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
  for (let index = 0; index < 65; index++) add.run(`m${index}`, 'a', null, null, 0, null, 'user', `orchidée ${index}`, index)
  add.run('private', 'a', null, 'private', 0, null, 'user', 'orchidée secret', 100)
  add.run('task', 'a', 'task', null, 0, null, 'user', 'orchidée task', 101)
  add.run('other', 'b', null, null, 0, null, 'user', 'orchidée other', 102)
  add.run('redacted', 'a', null, null, 1, null, 'user', 'orchidée secret', 103)
  add.run('hidden', 'a', null, null, 0, '{"hidden":true}', 'user', 'orchidée hidden', 104)
  const first = searchConversation(db, 'a', 'orchidée', 20)
  expect(first.total).toBe(65)
  expect(first.messages).toHaveLength(20)
  expect(first.hasMore).toBe(true)
  expect(searchConversation(db, 'a', 'orchidée', 20, 60).messages.at(-1)?.id).toBe('m0')
  expect(conversationContext(db, 'a', 'm0')?.map(row => row.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
  for (const id of ['private', 'task', 'other', 'redacted', 'hidden']) expect(conversationContext(db, 'a', id)).toBeNull()
  expect(searchConversation(db, 'a', '%').total).toBe(0)
  expect(searchConversation(db, 'a', "' OR 1=1 --").total).toBe(0)
  db.close()
})
