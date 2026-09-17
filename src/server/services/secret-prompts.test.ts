/**
 * Regression tests for the secure-input (secret prompt) lifecycle, pinned after
 * the "re-prompted forever" bug: a failed side effect used to leave the prompt
 * `pending`, so it re-fired on every reload/SSE-resync. These assert that EVERY
 * terminal path (success, handled failure, cancel) takes the prompt out of
 * `pending` and resumes the Agent — and that a vault key collision now upserts
 * instead of throwing.
 *
 * Real in-memory SQLite + real collaborators (vault, queue, sse, config). Only
 * structural modules are mocked: logger (noop), db/index (in-memory), and
 * encryption (real, with a sentinel value that throws so the failure path can be
 * exercised deterministically without a network call). Keeping the mock surface
 * tiny avoids polluting other suites under bun's process-global module mocks.
 */
import { describe, it, expect, mock, beforeEach, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import * as schema from '@/server/db/schema'
import * as realEncryption from '@/server/services/encryption'

if (!schema.secretPrompts?.id) throw new Error("This suite requires isolated module mocks")
const d = describe

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = OFF')
sqlite.run(`CREATE TABLE secret_prompts (
  id text PRIMARY KEY NOT NULL, agent_id text NOT NULL, task_id text,
  purpose text NOT NULL, spec text NOT NULL, status text NOT NULL DEFAULT 'pending',
  result_ref text, created_at integer NOT NULL, responded_at integer
)`)
sqlite.run(`CREATE TABLE vault_secrets (
  id text PRIMARY KEY NOT NULL, key text NOT NULL UNIQUE, encrypted_value text NOT NULL,
  description text, entry_type text NOT NULL DEFAULT 'text', vault_type_id text,
  is_favorite integer NOT NULL DEFAULT 0, created_by_agent_id text,
  last_used_at integer, allowed_tools text, allowed_hosts text,
  created_at integer NOT NULL, updated_at integer NOT NULL
)`)
sqlite.run(`CREATE TABLE queue_items (
  id text PRIMARY KEY NOT NULL, agent_id text NOT NULL, message_type text NOT NULL,
  content text NOT NULL, source_type text NOT NULL, source_id text,
  priority integer NOT NULL DEFAULT 0, request_id text, in_reply_to text, task_id text,
  session_id text, channel_origin_id text, status text NOT NULL DEFAULT 'pending',
  created_message_id text, processing_started_at integer, file_ids text, client_message_id text,
  message_metadata text, created_at integer NOT NULL, processed_at integer
)`)
const testDb = drizzle(sqlite, { schema })

const THROW_SENTINEL = '__throw_on_encrypt__'

// Snapshot the real encryption exports BEFORE mock.module — bun mutates the live
// `realEncryption` namespace in place when mocking, so calling `realEncryption.x`
// from inside the wrapper would re-enter the wrapper (infinite recursion). The
// snapshot keeps genuine references.
const realEnc = { ...realEncryption }

mock.module('@/server/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }) }))
mock.module('@/server/db/index', () => ({ db: testDb, sqlite, initVirtualTables() {} }))
// Preserve every encryption export for other suites; only wrap `encrypt` to
// throw on a sentinel value, so the failure path is testable without a network.
mock.module('@/server/services/encryption', () => ({
  ...realEnc,
  encrypt: async (v: string) => {
    if (v === THROW_SENTINEL) throw new Error('boom')
    return realEnc.encrypt(v)
  },
}))

const { secretPrompts, vaultSecrets, queueItems } = schema
const { respondToSecretPrompt, cancelSecretPrompt, getPendingSecretPrompts } = await import('@/server/services/secret-prompts')
const { getSecretValue } = await import('@/server/services/vault')

async function insertVaultPrompt(id: string, key: string, agentId = 'agent-1') {
  await testDb.insert(secretPrompts).values({
    id, agentId, taskId: null, purpose: 'vault',
    spec: JSON.stringify({ key, title: 'Store token', fields: [{ key, label: 'GitHub PAT', secret: true }] }),
    status: 'pending', createdAt: new Date(),
  })
}
const statusOf = (id: string) =>
  testDb.select({ s: secretPrompts.status }).from(secretPrompts).where(eq(secretPrompts.id, id)).get()?.s
const resumeMessages = (agentId = 'agent-1') =>
  testDb.select({ c: queueItems.content }).from(queueItems).where(eq(queueItems.agentId, agentId)).all().map((r) => r.c)

beforeAll(async () => {
  // Deterministic key so real encrypt/decrypt round-trips in-test.
  await realEnc._setTestKey('00'.repeat(32))
})

beforeEach(() => {
  sqlite.run('DELETE FROM secret_prompts')
  sqlite.run('DELETE FROM vault_secrets')
  sqlite.run('DELETE FROM queue_items')
})

d('secret prompts — terminal lifecycle', () => {
  it('vault: stores a fresh secret, answers the prompt, resumes the Agent', async () => {
    await insertVaultPrompt('p1', 'github_pat')
    const res = await respondToSecretPrompt('p1', { github_pat: 'ghp_aaa' }, 'user-1')

    expect(res.success).toBe(true)
    expect(statusOf('p1')).toBe('answered')
    expect(await getSecretValue('github_pat')).toBe('ghp_aaa')
    const msgs = resumeMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('Secure input received')
  })

  it('vault: a key that already exists is UPDATED, not a UNIQUE crash (the re-prompt bug)', async () => {
    await insertVaultPrompt('p0', 'github_pat')
    await respondToSecretPrompt('p0', { github_pat: 'ghp_OLD' }, 'user-1') // first store
    sqlite.run('DELETE FROM queue_items')
    await insertVaultPrompt('p2', 'github_pat') // same key again

    const res = await respondToSecretPrompt('p2', { github_pat: 'ghp_NEW' }, 'user-1')

    expect(res.success).toBe(true) // was false (UNIQUE crash → "Failed to apply") before the fix
    expect(statusOf('p2')).toBe('answered')
    expect(testDb.select().from(vaultSecrets).where(eq(vaultSecrets.key, 'github_pat')).all()).toHaveLength(1)
    expect(await getSecretValue('github_pat')).toBe('ghp_NEW')
  })

  it('a thrown side effect still finalizes the prompt and resumes the Agent (no infinite re-prompt)', async () => {
    await insertVaultPrompt('p3', 'will_throw')
    const res = await respondToSecretPrompt('p3', { will_throw: THROW_SENTINEL }, 'user-1')

    expect(res.success).toBe(false) // client still shows the error toast…
    expect(statusOf('p3')).toBe('answered') // …but the prompt is NO LONGER pending
    expect(resumeMessages()[0]).toContain('Secure input failed')
    expect(await getPendingSecretPrompts('agent-1')).toHaveLength(0) // never re-surfaces
  })

  it('cancel: dismisses the prompt, resumes the Agent, and is idempotent', async () => {
    await insertVaultPrompt('p4', 'some_key')

    const res = await cancelSecretPrompt('p4', 'user-1')
    expect(res.success).toBe(true)
    expect(statusOf('p4')).toBe('cancelled')
    const msgs = resumeMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('dismissed')
    expect(await getPendingSecretPrompts('agent-1')).toHaveLength(0)

    const again = await cancelSecretPrompt('p4', 'user-1') // idempotent — no duplicate resume
    expect(again.success).toBe(true)
    expect(resumeMessages()).toHaveLength(1)
  })
})
