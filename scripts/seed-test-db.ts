#!/usr/bin/env bun
/**
 * Build a reusable, LLM-ready test database for local verification.
 *
 * Produces a self-contained Hivekeep data dir (SQLite DB + persisted encryption
 * key) seeded with:
 *   - an admin user  (admin@local.test / Password123!)  → onboarding complete
 *   - the Anthropic "Claude (subscription)" provider in `cli` mode, which reads
 *     the host's ~/.claude/.credentials.json at runtime (NO secret is stored in
 *     the DB — portable + safe), with its models synced + set as the default LLM
 *   - one regular Agent bound to that model (so chat / tasks / tools work)
 *   - 25 contacts, 12 vault secrets, 10 webhooks (enough to exercise the
 *     settings list screens: search / filter / pagination)
 *
 * Other agents: copy the data dir somewhere writable and boot an isolated server
 * against the copy (see docs/testing-instance.md). NEVER point at the prod env.
 *
 * Usage:
 *   bun scripts/seed-test-db.ts                # seeds ~/.local/share/gezy-testdata
 *   TESTDATA_DIR=/path bun scripts/seed-test-db.ts
 *   FRESH=1 bun scripts/seed-test-db.ts        # wipe + reseed from scratch
 *
 * Idempotent: re-running tops up only what is missing.
 */
import { spawn } from 'bun'
import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync, rmSync } from 'fs'

const DATA_DIR = process.env.TESTDATA_DIR || join(homedir(), '.local/share/gezy-testdata')
const DB_PATH = join(DATA_DIR, 'hivekeep.db')
const PORT = Number(process.env.TESTDB_PORT || 4178)
const BASE = `http://localhost:${PORT}`
const ADMIN = { email: 'admin@local.test', password: 'Password123!', name: 'Test Admin' }

// Isolated env for every child process — overrides the prod vars this shell
// inherits from the user profile (DB_PATH/PORT/HIVEKEEP_DATA_DIR point at PROD).
const ENV = {
  ...process.env,
  DB_PATH,
  HIVEKEEP_DATA_DIR: DATA_DIR,
  PORT: String(PORT),
  PUBLIC_URL: BASE,
  HIVEKEEP_PUBLIC_URL: BASE,
  TRUSTED_ORIGINS: BASE,
  HIVEKEEP_MODEL_REGISTRY: 'false',
  NODE_OPTIONS: '--max-old-space-size=4096',
  // Leave ENCRYPTION_KEY unset → the app persists one into DATA_DIR/.encryption-key,
  // keeping the data dir self-contained (vault stays decryptable on reuse).
  ENCRYPTION_KEY: undefined as unknown as string,
}

const log = (...a: unknown[]) => console.log('[seed]', ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

if (process.env.FRESH && existsSync(DATA_DIR)) {
  rmSync(DATA_DIR, { recursive: true, force: true })
  log('FRESH: wiped', DATA_DIR)
}
mkdirSync(DATA_DIR, { recursive: true })

// ─── 1. Migrate the isolated DB ──────────────────────────────────────────────
log('migrating', DB_PATH)
await spawn(['bun', 'scripts/migrate.ts'], { env: ENV, stdout: 'inherit', stderr: 'inherit' }).exited

// ─── 2. Boot the server (isolated) ───────────────────────────────────────────
log(`booting server on :${PORT}`)
const server = spawn(['bun', 'src/server/index.ts'], { env: ENV, stdout: 'ignore', stderr: 'ignore' })
const stop = () => { try { server.kill() } catch { /* noop */ } }
process.on('exit', stop)
process.on('SIGINT', () => { stop(); process.exit(1) })

let up = false
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`${BASE}/api/onboarding/status`); if (r.ok) { up = true; break } } catch { /* retry */ }
  await sleep(500)
}
if (!up) { log('server did not come up'); stop(); process.exit(1) }

// ─── Cookie-jar fetch ────────────────────────────────────────────────────────
let cookie = ''
async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(',').map((c) => c.split(';')[0]!.trim()).filter(Boolean).join('; ')
  return res
}

try {
  // ─── 3. Admin + onboarding ────────────────────────────────────────────────
  const status = await (await fetch(`${BASE}/api/onboarding/status`)).json()
  if (!status.hasAdmin) {
    let r = await api('POST', '/api/auth/sign-up/email', ADMIN)
    log('sign-up:', r.status)
    if (!r.ok) { r = await api('POST', '/api/auth/sign-in/email', { email: ADMIN.email, password: ADMIN.password }); log('sign-in:', r.status) }
    r = await api('POST', '/api/onboarding/profile', { firstName: 'Test', pseudonym: 'admin', language: 'en' })
    log('profile:', r.status)
  } else {
    const r = await api('POST', '/api/auth/sign-in/email', { email: ADMIN.email, password: ADMIN.password })
    log('admin exists; sign-in:', r.status)
  }

  // ─── 4. Anthropic subscription provider (host creds) ────────────────────────
  let provs = (await (await api('GET', '/api/providers')).json()).providers || []
  let anthropic = provs.find((p: any) => p.type === 'anthropic-oauth')
  if (!anthropic) {
    const r = await api('POST', '/api/providers', { name: 'Claude (subscription)', type: 'anthropic-oauth', config: { authMode: 'cli' } })
    const j = await r.json()
    log('provider anthropic-oauth:', r.status, j.provider ? `isValid=${j.provider.isValid}` : JSON.stringify(j).slice(0, 160))
    anthropic = j.provider
  } else log('provider anthropic-oauth: already present')

  // ─── 5. Default LLM model + one Agent ───────────────────────────────────────
  if (anthropic) {
    const models = (await (await api('GET', '/api/models')).json()).models || []
    const pick = models.find((m: any) => m.providerId === anthropic.id && m.enabled && /sonnet|opus/i.test(m.modelId)) || models.find((m: any) => m.providerId === anthropic.id && m.enabled)
    if (pick) {
      await api('PUT', '/api/settings/default-llm', { model: pick.modelId, providerId: anthropic.id })
      log('default LLM set:', pick.modelId)
      const agents = (await (await api('GET', '/api/agents')).json()).agents || []
      if (!agents.length) {
        const r = await api('POST', '/api/agents', {
          name: 'Tester', role: 'Test assistant', character: 'Concise and helpful.',
          expertise: 'General-purpose testing of Hivekeep features.', model: pick.modelId, providerId: anthropic.id,
        })
        log('agent:', r.status)
      } else log(`agents: ${agents.length} already present`)
    } else log('no enabled model found to set as default (provider may be invalid on this host)')
  }

  // ─── 6. List data: contacts / vault / webhooks ──────────────────────────────
  const cTotal = (await (await api('GET', '/api/contacts?limit=1')).json()).total ?? 0
  if (cTotal < 20) {
    const firsts = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Victor', 'Walter', 'Xavier', 'Yvonne', 'Zoe', 'Quentin', 'Nina', 'Oscar']
    let ok = 0
    for (let i = 0; i < firsts.length; i++) if ((await api('POST', '/api/contacts', { firstName: firsts[i], lastName: `Sample${String(i + 1).padStart(2, '0')}` })).ok) ok++
    log('contacts seeded:', ok)
  } else log('contacts already seeded:', cTotal)

  const vEntries = (await (await api('GET', '/api/vault/entries')).json()).entries || []
  if (vEntries.length < 8) {
    let ok = 0
    for (let i = 1; i <= 12; i++) if ((await api('POST', '/api/vault/entries', { key: `SECRET_${String(i).padStart(2, '0')}`, entryType: i % 2 ? 'api_key' : 'text', value: `value-${i}`, description: `Seeded secret ${i}` })).ok) ok++
    log('vault seeded:', ok)
  } else log('vault already seeded:', vEntries.length)

  const agentForHooks = (await (await api('GET', '/api/agents')).json()).agents?.[0]
  const wHooks = (await (await api('GET', '/api/webhooks')).json()).webhooks || []
  if (agentForHooks && wHooks.length < 8) {
    let ok = 0
    for (let i = 1; i <= 10; i++) if ((await api('POST', '/api/webhooks', { agentId: agentForHooks.id, name: `Webhook ${String(i).padStart(2, '0')}`, description: `Seeded webhook ${i}` })).ok) ok++
    log('webhooks seeded:', ok)
  } else log('webhooks:', wHooks.length, agentForHooks ? '' : '(no agent — skipped)')

  log('DONE. Data dir:', DATA_DIR)
  log(`Login: ${ADMIN.email} / ${ADMIN.password}`)
} finally {
  stop()
  await sleep(300)
}
process.exit(0)
