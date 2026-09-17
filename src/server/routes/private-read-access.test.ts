import { describe, expect, it, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import { resolve } from 'path'
import * as schema from '@/server/db/schema'
import { runMigrations } from '@/server/db/run-migrations'

process.env.ENCRYPTION_KEY = '00'.repeat(32)
const sqlite = new Database(':memory:')
const db = drizzle(sqlite, { schema })
runMigrations(sqlite, db, resolve(import.meta.dir, '../db/migrations'))
mock.module('@/server/db/index', () => ({ db, sqlite, initVirtualTables() {} }))
mock.module('@/server/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const events: any[] = []
mock.module('@/server/sse/index', () => ({ sseManager: { sendToAgent: (_: string, event: unknown) => events.push(event), broadcast() {} } }))
let previews = 0
mock.module('@/server/services/context-preview', () => ({
  buildQuickSessionContextPreview: async () => { previews++; return { preview: 'private context' } },
}))
const { agentRoutes } = await import('./agents')
const { reactionRoutes } = await import('./reactions')
const app = new Hono<any>()
app.use('*', async (c, next) => {
  c.set('user', { id: c.req.header('x-fixture-user') ?? 'other', name: 'Fixture' })
  await next()
})
app.route('/api/agents', agentRoutes)
app.route('/api/agents/:agentId/messages/:messageId/reactions', reactionRoutes)
for (const id of ['owner', 'other']) sqlite.run(`INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)`, [id, id, `${id}@example.invalid`])
for (const id of ['agent-a', 'agent-b']) sqlite.run(`INSERT INTO agents (id, slug, name, role, character, expertise, model, workspace_path, created_at, updated_at)
  VALUES (?, ?, ?, 'helper', 'test', 'test', 'fake', '/unused', 0, 0)`, [id, id, id])
sqlite.run(`INSERT INTO quick_sessions (id, agent_id, created_by, created_at) VALUES ('private', 'agent-a', 'owner', 0)`)
sqlite.run(`INSERT INTO messages (id, agent_id, session_id, role, source_type, content, created_at)
  VALUES ('private-message', 'agent-a', 'private', 'user', 'user', 'private content', 0)`)
sqlite.run(`INSERT INTO queue_items (id, agent_id, session_id, message_type, source_type, content, created_at)
  VALUES ('private-pending', 'agent-a', 'private', 'user', 'user', 'private content', 0)`)

describe('private reads and reactions', () => {
  it('rejects another user and mismatched agent before constructing a private preview', async () => {
    const before = previews
    expect((await app.request('/api/agents/agent-a/context-preview?sessionId=private')).status).toBe(404)
    expect((await app.request('/api/agents/agent-b/context-preview?sessionId=private', { headers: { 'x-fixture-user': 'owner' } })).status).toBe(404)
    expect(previews).toBe(before)
    const response = await app.request('/api/agents/agent-a/context-preview?sessionId=private', { headers: { 'x-fixture-user': 'owner' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ preview: 'private context' })
  })

  it('does not expose private queue state on the shared Agent list', async () => {
    const response = await app.request('/api/agents')
    const body = await response.json()
    expect(body.agents.find((agent: any) => agent.id === 'agent-a').queueSize).toBe(0)
  })

  it('rejects private reaction reads/writes by another user, and scopes owner events', async () => {
    const route = '/api/agents/agent-a/messages/private-message/reactions'
    expect((await app.request(route)).status).toBe(404)
    expect((await app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: '👍' }) })).status).toBe(404)
    const accepted = await app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-user': 'owner' }, body: JSON.stringify({ emoji: '👍' }) })
    expect(accepted.status).toBe(200)
    expect(events.at(-1).data.sessionId).toBe('private')
    expect((await app.request('/api/agents/agent-b/messages/private-message/reactions', { headers: { 'x-fixture-user': 'owner' } })).status).toBe(404)
  })
})
