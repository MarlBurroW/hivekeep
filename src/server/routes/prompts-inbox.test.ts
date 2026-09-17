import { afterAll, describe, expect, it, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Hono } from 'hono'
import * as schema from '@/server/db/schema'

const sqlite = new Database(':memory:')
sqlite.run('CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL)')
sqlite.run('CREATE TABLE human_prompts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, question TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)')
sqlite.run("INSERT INTO agents VALUES ('agent-a', 'Atlas', 'atlas'), ('agent-b', 'Nova', 'nova')")
for (let i = 0; i < 53; i++) sqlite.run("INSERT INTO human_prompts VALUES (?, ?, NULL, ?, 'pending', ?)", [String(i).padStart(3, '0'), i % 2 ? 'agent-a' : 'agent-b', `Question ${i}`, i])
sqlite.run("INSERT INTO human_prompts VALUES ('answered', 'agent-a', NULL, 'Already answered', 'answered', 99), ('task', 'agent-a', 'task-id', 'Task question', 'pending', 100)")
const db = drizzle(sqlite, { schema })
mock.module('@/server/db/index', () => ({ db, sqlite }))
mock.module('@/server/services/human-prompts', () => ({ getPendingPrompts() {}, respondToHumanPrompt() {} }))
mock.module('@/server/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const { promptRoutes } = await import('./prompts')
const app = new Hono<any>()
// The application mounts prompts after authentication, without an admin gate.
app.use('*', async (c, next) => {
  const role = c.req.header('x-fixture-role')
  if (!role) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', { id: role, role })
  await next()
})
app.route('/api/prompts', promptRoutes)
const request = (query = '', role = 'member') => app.request(`/api/prompts/inbox${query}`, { headers: { 'x-fixture-role': role } })
afterAll(() => sqlite.close())

describe('shared prompt inbox', () => {
  it('returns only pending conversation prompts with Agent destinations and an unpaginated total', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.total).toBe(53)
    expect(body.prompts).toHaveLength(20)
    expect(body.hasMore).toBe(true)
    expect(body.prompts[0]).toEqual({ id: '052', agentId: 'agent-b', agentName: 'Nova', agentSlug: 'nova', question: 'Question 52' })
    expect(body.prompts.some((prompt: any) => ['task', 'answered'].includes(prompt.id))).toBe(false)
    expect(await (await request('', 'admin')).json()).toEqual(body)
    expect((await app.request('/api/prompts/inbox')).status).toBe(401)
  })

  it('paginates with a stable order, caps the limit and preserves total on an empty page', async () => {
    const first = await (await request('?limit=999')).json()
    expect(first.prompts).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    const last = await (await request('?limit=50&offset=50')).json()
    expect(last.prompts.map((prompt: any) => prompt.id)).toEqual(['002', '001', '000'])
    expect(last.total).toBe(53)
    expect(last.hasMore).toBe(false)
    const empty = await (await request('?offset=1000')).json()
    expect(empty).toEqual({ prompts: [], total: 53, hasMore: false })
  })

  it('uses finite defaults for malformed, negative, fractional and unsafe values', async () => {
    for (const value of ['-1', 'Infinity', 'NaN', '1.5', '9007199254740992', '1%20OR%201=1']) {
      const body = await (await request(`?limit=${value}&offset=${value}`)).json()
      expect(body.prompts).toHaveLength(20)
      expect(body.prompts[0].id).toBe('052')
      expect(body.total).toBe(53)
    }
    expect((await (await request('?limit=0')).json()).prompts).toHaveLength(20)
  })
})
