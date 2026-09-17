import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// Skip when another suite has globally mocked the schema to stubs (mock.module
// is process-global): real columns are required for the in-memory CRUD here.
const schemaIsReal = !!(schema as { apiClients?: { id?: unknown } }).apiClients?.id
if (!schemaIsReal) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const d = describe

const sqlite = new Database(':memory:')
sqlite.run(`CREATE TABLE api_clients (
  id text PRIMARY KEY NOT NULL, name text NOT NULL, description text,
  owner_user_id text NOT NULL, agent_id text,
  allowed_modes text NOT NULL DEFAULT '["main","isolated"]',
  rate_limit_per_min integer, status text NOT NULL DEFAULT 'active',
  created_at integer NOT NULL, updated_at integer NOT NULL
)`)
sqlite.run(`CREATE TABLE api_keys (
  id text PRIMARY KEY NOT NULL, client_id text NOT NULL, label text NOT NULL,
  key_hash text NOT NULL, key_prefix text NOT NULL,
  last_used_at integer, revoked_at integer, created_at integer NOT NULL
)`)
sqlite.run(`CREATE TABLE api_requests (
  id text PRIMARY KEY NOT NULL, client_id text NOT NULL, agent_id text NOT NULL,
  conversation_id text, queue_item_id text, request_message_id text,
  status text NOT NULL DEFAULT 'pending', reply_message_id text, reply_content text,
  error_code text, error_message text, created_at integer NOT NULL, completed_at integer
)`)
sqlite.run(`CREATE TABLE quick_sessions (
  id text PRIMARY KEY NOT NULL, agent_id text NOT NULL, created_by text NOT NULL,
  title text, status text NOT NULL DEFAULT 'active', kind text NOT NULL DEFAULT 'quick',
  model text, provider_id text, thinking_enabled integer, thinking_effort text,
  created_at integer NOT NULL, closed_at integer, expires_at integer
)`)
sqlite.run(`CREATE TABLE api_conversations (
  id text PRIMARY KEY NOT NULL, client_id text NOT NULL, agent_id text NOT NULL,
  session_id text NOT NULL, title text, status text NOT NULL DEFAULT 'active',
  created_at integer NOT NULL, last_message_at integer, expires_at integer
)`)
const testDb = drizzle(sqlite, { schema })

mock.module('@/server/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }) }))
mock.module('@/server/db/index', () => ({ db: testDb, sqlite, initVirtualTables() {} }))

// Guard the service import: when a prior suite has globally stubbed the schema
// (mock.module is process-global), the service's named imports can't link. In
// that case these suites are skipped, so an empty stand-in is enough.
const svc = schemaIsReal
  ? await import('@/server/services/external-api')
  : ({} as typeof import('@/server/services/external-api'))

const {
  mintApiKey,
  resolveApiKeyToken,
  consumeRateLimit,
  createApiRequest,
  resolveApiReply,
  failPendingApiRequest,
  getApiRequest,
  waitForApiReply,
  parseAllowedModes,
  createApiConversation,
  resolveApiConversation,
  closeApiConversation,
  listApiConversations,
  getApiConversationSessionId,
  refreshApiConversationActivity,
} = svc

function seedClient(overrides: Partial<{ id: string; status: string }> = {}) {
  const id = overrides.id ?? 'client-1'
  sqlite.run(
    `INSERT INTO api_clients (id, name, owner_user_id, allowed_modes, status, created_at, updated_at)
     VALUES (?, 'CI', 'user-1', '["main"]', ?, 0, 0)`,
    [id, overrides.status ?? 'active'],
  )
  return id
}

d('external-api keys', () => {
  beforeEach(() => {
    sqlite.run('DELETE FROM api_keys')
    sqlite.run('DELETE FROM api_clients')
    sqlite.run('DELETE FROM api_requests')
  })

  it('mints a key in hk_<id>.<secret> form and stores only its hash', async () => {
    const clientId = seedClient()
    const minted = await mintApiKey(clientId, 'CI server')
    expect(minted.fullKey.startsWith(`hk_${minted.id}.`)).toBe(true)
    expect(minted.prefix).toBe(`hk_${minted.id.slice(0, 8)}`)

    const row = sqlite.query('SELECT key_hash FROM api_keys WHERE id = ?').get(minted.id) as { key_hash: string }
    const secret = minted.fullKey.slice(minted.fullKey.indexOf('.') + 1)
    expect(row.key_hash).not.toBe(secret) // secret never stored in clear
    expect(row.key_hash).toHaveLength(64) // sha256 hex
  })

  it('resolves a valid token to its client', async () => {
    const clientId = seedClient()
    const minted = await mintApiKey(clientId, 'CI')
    const result = await resolveApiKeyToken(minted.fullKey)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.client.id).toBe(clientId)
  })

  it('rejects a tampered secret as UNAUTHORIZED', async () => {
    const clientId = seedClient()
    const minted = await mintApiKey(clientId, 'CI')
    const tampered = `hk_${minted.id}.deadbeefdeadbeefdeadbeefdeadbeef`
    const result = await resolveApiKeyToken(tampered)
    expect(result).toMatchObject({ ok: false, code: 'UNAUTHORIZED', status: 401 })
  })

  it('rejects malformed tokens before any lookup', async () => {
    expect(await resolveApiKeyToken('not-a-key')).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
    expect(await resolveApiKeyToken('hk_no-dot-here')).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('reports a revoked key distinctly', async () => {
    const clientId = seedClient()
    const minted = await mintApiKey(clientId, 'CI')
    sqlite.run('UPDATE api_keys SET revoked_at = 1 WHERE id = ?', [minted.id])
    expect(await resolveApiKeyToken(minted.fullKey)).toMatchObject({ ok: false, code: 'API_KEY_REVOKED' })
  })

  it('reports a disabled client distinctly', async () => {
    const clientId = seedClient({ status: 'disabled' })
    const minted = await mintApiKey(clientId, 'CI')
    expect(await resolveApiKeyToken(minted.fullKey)).toMatchObject({ ok: false, code: 'CLIENT_DISABLED', status: 403 })
  })
})

d('external-api rate limit', () => {
  it('allows up to the limit then blocks within the window', () => {
    const id = `rl-${Math.round(performance.now())}` // distinct bucket per run
    expect(consumeRateLimit(id, 2)).toBe(true)
    expect(consumeRateLimit(id, 2)).toBe(true)
    expect(consumeRateLimit(id, 2)).toBe(false)
  })
})

d('external-api requests', () => {
  beforeEach(() => {
    sqlite.run('DELETE FROM api_requests')
    sqlite.run('DELETE FROM api_clients')
    seedClient()
  })

  it('correlates a reply: pending then done, scoped to the client', async () => {
    await createApiRequest({ requestId: 'req-1', clientId: 'client-1', agentId: 'agent-1', queueItemId: 'q-1' })
    expect(getApiRequest('req-1', 'client-1')).toMatchObject({ status: 'pending', reply: null })
    expect(getApiRequest('req-1', 'other-client')).toBeNull() // not visible to another client

    await resolveApiReply('req-1', 'msg-9', 'the answer')
    expect(getApiRequest('req-1', 'client-1')).toMatchObject({ status: 'done', reply: 'the answer' })
  })

  it('releases a wait() caller when the reply resolves', async () => {
    await createApiRequest({ requestId: 'req-2', clientId: 'client-1', agentId: 'agent-1' })
    const waiter = waitForApiReply('req-2', 5000)
    await resolveApiReply('req-2', 'msg-2', 'hi there')
    const result = await waiter
    expect(result).toMatchObject({ status: 'done', reply: 'hi there' })
  })

  it('times out a wait() caller to null when nothing resolves', async () => {
    await createApiRequest({ requestId: 'req-3', clientId: 'client-1', agentId: 'agent-1' })
    expect(await waitForApiReply('req-3', 10)).toBeNull()
  })

  it('failPendingApiRequest no-ops once a reply is done', async () => {
    await createApiRequest({ requestId: 'req-4', clientId: 'client-1', agentId: 'agent-1' })
    await resolveApiReply('req-4', 'msg-4', 'done answer')
    await failPendingApiRequest('req-4', 'TURN_INCOMPLETE', 'should not apply')
    expect(getApiRequest('req-4', 'client-1')).toMatchObject({ status: 'done', reply: 'done answer' })
  })

  it('failPendingApiRequest fails a still-pending request', async () => {
    await createApiRequest({ requestId: 'req-5', clientId: 'client-1', agentId: 'agent-1' })
    await failPendingApiRequest('req-5', 'TURN_INCOMPLETE', 'turn died')
    expect(getApiRequest('req-5', 'client-1')).toMatchObject({
      status: 'error',
      error: { code: 'TURN_INCOMPLETE', message: 'turn died' },
    })
  })
})

d('external-api isolated conversations', () => {
  beforeEach(() => {
    sqlite.run('DELETE FROM api_conversations')
    sqlite.run('DELETE FROM quick_sessions')
  })

  it('creates an isolated thread backed by a kind=api session exempt from idle GC', () => {
    const created = createApiConversation({ clientId: 'client-1', agentId: 'agent-1', ownerUserId: 'user-1', title: 'CI run' })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const session = sqlite.query('SELECT kind, expires_at, status FROM quick_sessions WHERE id = ?').get(created.sessionId) as { kind: string; expires_at: number | null; status: string }
    expect(session.kind).toBe('api')
    expect(session.expires_at).toBeNull() // never auto-closed by the quick-session GC
    expect(session.status).toBe('active')
  })

  it('resolves an owned active conversation and rejects others', () => {
    const created = createApiConversation({ clientId: 'client-1', agentId: 'agent-1', ownerUserId: 'user-1' })
    if (!created.ok) throw new Error('setup failed')
    expect(resolveApiConversation(created.conversationId, 'client-1', 'agent-1')).toEqual({ ok: true, sessionId: created.sessionId })
    expect(resolveApiConversation(created.conversationId, 'other-client', 'agent-1')).toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' })
    expect(resolveApiConversation(created.conversationId, 'client-1', 'other-agent')).toMatchObject({ ok: false, code: 'CONVERSATION_NOT_FOUND' })
  })

  it('closes both the conversation and its backing session', () => {
    const created = createApiConversation({ clientId: 'client-1', agentId: 'agent-1', ownerUserId: 'user-1' })
    if (!created.ok) throw new Error('setup failed')
    expect(closeApiConversation(created.conversationId, 'client-1')).toBe(true)
    expect(resolveApiConversation(created.conversationId, 'client-1', 'agent-1')).toMatchObject({ ok: false, code: 'CONVERSATION_CLOSED' })
    const session = sqlite.query('SELECT status FROM quick_sessions WHERE id = ?').get(created.sessionId) as { status: string }
    expect(session.status).toBe('closed')
  })

  it('lists only the calling client conversations and resolves the session for reads', () => {
    const a = createApiConversation({ clientId: 'client-1', agentId: 'agent-1', ownerUserId: 'user-1' })
    createApiConversation({ clientId: 'client-2', agentId: 'agent-1', ownerUserId: 'user-2' })
    if (!a.ok) throw new Error('setup failed')
    const list = listApiConversations('client-1')
    expect(list).toHaveLength(1)
    expect(list[0]!.conversationId).toBe(a.conversationId)
    expect(getApiConversationSessionId(a.conversationId, 'client-1')).toBe(a.sessionId)
    expect(getApiConversationSessionId(a.conversationId, 'client-2')).toBeNull()
  })

  it('slides the TTL forward on activity', () => {
    const created = createApiConversation({ clientId: 'client-1', agentId: 'agent-1', ownerUserId: 'user-1' })
    if (!created.ok) throw new Error('setup failed')
    sqlite.run('UPDATE api_conversations SET expires_at = 1, last_message_at = 1 WHERE id = ?', [created.conversationId])
    refreshApiConversationActivity(created.sessionId)
    const row = sqlite.query('SELECT expires_at, last_message_at FROM api_conversations WHERE id = ?').get(created.conversationId) as { expires_at: number; last_message_at: number }
    expect(row.expires_at).toBeGreaterThan(1)
    expect(row.last_message_at).toBeGreaterThan(1)
  })
})

d('external-api modes', () => {
  it('parses allowed_modes JSON, defaulting to none on corruption', () => {
    expect(parseAllowedModes({ id: 'c', allowedModes: '["main"]' } as never)).toEqual(['main'])
    expect(parseAllowedModes({ id: 'c', allowedModes: 'not json' } as never)).toEqual([])
  })
})
