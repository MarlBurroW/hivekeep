// Child-process fixture: each action opens only its supplied temporary DB.
// Separate processes prove the envelope does not depend on module-level maps.
import { mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { resolve } from 'path'
import * as schema from '@/server/db/schema'
import { runMigrations } from '@/server/db/run-migrations'

const [dbPath, action, lane = 'main'] = process.argv.slice(2)
if (!dbPath || !action) throw new Error('Expected temporary DB path and fixture action')
const sqlite = new Database(dbPath)
const db = drizzle(sqlite, { schema })
runMigrations(sqlite, db, resolve(import.meta.dir, '../db/migrations'))
mock.module('@/server/db/index', () => ({ db, sqlite }))
mock.module('@/server/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }))
mock.module('@/server/sse/index', () => ({ sseManager: { sendToAgent() {} } }))
const queue = await import('./queue')
const { persistQueuedMessage } = await import('./queue-message-store')
sqlite.run(`INSERT OR IGNORE INTO agents (id, name, role, character, expertise, model, workspace_path, created_at, updated_at)
  VALUES ('recovery-agent', 'Recovery', 'helper', 'test', 'test', 'fake', '/unused', 0, 0)`)
sqlite.run(`INSERT OR IGNORE INTO user (id, name, email, created_at, updated_at)
  VALUES ('fixture-user', 'Fixture', 'fixture@example.invalid', 0, 0)`)
for (const id of ['attachment-one', 'attachment-two']) {
  sqlite.run(`INSERT OR IGNORE INTO files (id, agent_id, uploaded_by, original_name, stored_path, mime_type, size, created_at)
    VALUES (?, 'recovery-agent', 'fixture-user', 'fixture.txt', '/unused/fixture.txt', 'text/plain', 1, 0)`, [id])
}
if (lane === 'quick') {
  sqlite.run(`INSERT OR IGNORE INTO quick_sessions (id, agent_id, created_by, created_at)
    VALUES ('private-session', 'recovery-agent', 'fixture-user', 0)`)
}

if (action === 'enqueue') {
  const result = await queue.enqueueMessage({
    id: 'recovery-item', agentId: 'recovery-agent', messageType: 'user',
    content: 'A durable question', sourceType: 'user', sourceId: 'fixture-user',
    fileIds: ['attachment-one', 'attachment-two'], clientMessageId: 'optimistic-token',
    messageMetadata: { channel: { modality: 'audio', context: 'durable context' } },
    ...(lane === 'quick' ? { sessionId: 'private-session' } : {}),
  })
  process.stdout.write(JSON.stringify(result))
} else if (action === 'reserve-race') {
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => queue.enqueueMessage({
    id: `competing-${index}`, agentId: 'recovery-agent', sourceType: 'user', sourceId: 'fixture-user',
    content: 'competing send', messageType: 'user', fileIds: ['attachment-one'],
    ...(index % 2 === 0 ? { sessionId: 'private-session' } : {}),
  })))
  process.stdout.write(JSON.stringify({
    accepted: results.filter((result) => result.status === 'fulfilled').length,
    rejected: results.filter((result) => result.status === 'rejected').length,
    rows: sqlite.query('SELECT id, session_id FROM queue_items').all(),
    file: sqlite.query('SELECT session_id FROM files WHERE id = \'attachment-one\'').get(),
  }))
} else if (action === 'inspect-main') {
  process.stdout.write(JSON.stringify({
    items: await queue.getPendingQueueItems('recovery-agent'),
    size: await queue.getQueueSize('recovery-agent'),
    removed: await queue.removeQueueItem('recovery-agent', 'recovery-item'),
  }))
} else {
  queue.recoverStaleProcessingItems()
  const item = await queue.dequeueMessage('recovery-agent', lane === 'quick' ? 'quick' : 'main')
  if (!item) throw new Error('Expected pending fixture item')
  const metadata = queue.popQueueMessageMetadata(item.id)
  let messageId: string | null = null
  let rolledBack = false
  if (action === 'fail-receipt') {
    sqlite.run(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF created_message_id ON queue_items
      BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`)
  }
  if (action === 'persist' || action === 'fail-receipt') {
    try {
      messageId = persistQueuedMessage(item.id, {
        id: crypto.randomUUID(), agentId: item.agentId, sessionId: item.sessionId,
        role: 'user', content: item.content, sourceType: item.sourceType,
        metadata: JSON.stringify(metadata), createdAt: new Date(),
      })
    } catch (error) {
      if (action !== 'fail-receipt' || !String(error).includes('receipt failure')) throw error
      rolledBack = true
    } finally {
      if (action === 'fail-receipt') sqlite.run('DROP TRIGGER fail_receipt')
    }
  }
  const messageCount = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM messages').get()!.count
  const receipt = sqlite.query<{ created_message_id: string | null }, []>(
    'SELECT created_message_id FROM queue_items',
  ).get()!.created_message_id
  process.stdout.write(JSON.stringify({ item, metadata, messageId, messageCount, receipt, rolledBack }))
}
sqlite.close()
