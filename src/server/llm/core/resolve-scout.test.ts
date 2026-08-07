/**
 * Tests for the scout-model fallback chain (resolve-scout.ts).
 *
 * Pins the priority order: per-spawn override → Agent scout → global default →
 * the Agent's own main model.
 *
 * Real in-memory SQLite with only the tables the resolver touches (agents,
 * app_settings — the global tier reads app_settings through the real service,
 * so we do NOT mock.module the widely-imported app-settings module; see the
 * mock-pollution note in tasks-scout-suspend.test.ts).
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// Mock pollution guard (mock.module is process-global; see model-registry.test.ts).
const schemaIsReal = !!(schema as { agents?: { id?: unknown } }).agents?.id
const d = schemaIsReal ? describe : describe.skip

const sqlite = new Database(':memory:')
sqlite.run(`CREATE TABLE agents (
  id text PRIMARY KEY NOT NULL,
  model text NOT NULL,
  provider_id text,
  scout_model text,
  scout_provider_id text,
  scout_thinking_config text
)`)
sqlite.run(`CREATE TABLE app_settings (
  key text PRIMARY KEY NOT NULL,
  value text NOT NULL,
  updated_at integer NOT NULL
)`)
const testDb = drizzle(sqlite, { schema })
if (schemaIsReal) {
  // Full export surface of '@/server/db/index' (db, sqlite, initVirtualTables) —
  // a partial mock would break later-loaded test files (process-global).
  mock.module('@/server/db/index', () => ({ db: testDb, sqlite, initVirtualTables: () => {} }))
}

const mod = schemaIsReal
  ? await import('@/server/llm/core/resolve-scout')
  : ({} as typeof import('@/server/llm/core/resolve-scout'))
const { resolveScoutModel, resolveScoutThinking } = mod

// Real app-settings service (its in-memory cache must stay coherent with our
// table — always go through the setters, never raw SQL on app_settings).
const appSettings = schemaIsReal
  ? await import('@/server/services/app-settings')
  : ({} as typeof import('@/server/services/app-settings'))

const AGENT = 'agent-1'

function seed(opts: {
  agentScout?: string | null
  agentScoutThinking?: string | null
}) {
  sqlite.run(`INSERT INTO agents (id, model, provider_id, scout_model, scout_provider_id, scout_thinking_config)
              VALUES (?, 'agent-main-model', 'prov-main', ?, ?, ?)`,
    [AGENT, opts.agentScout ?? null, opts.agentScout ? 'prov-agent' : null, opts.agentScoutThinking ?? null])
}

async function setGlobalScout(model: string | null, providerId: string | null) {
  await appSettings.setDefaultScoutModel(model)
  await appSettings.setDefaultScoutProviderId(providerId)
}

const LOW = JSON.stringify({ enabled: true, effort: 'low' })
const HIGH = JSON.stringify({ enabled: true, effort: 'high' })

beforeEach(async () => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM agents')
  await setGlobalScout(null, null) // clears rows AND the service's cache
  await appSettings.setDefaultScoutThinking(null)
})

d('resolveScoutModel priority chain', () => {
  it('per-spawn override beats every configured tier', async () => {
    seed({ agentScout: 'agent-scout' })
    const r = await resolveScoutModel({
      agentId: AGENT,
      override: { modelId: 'override-scout', providerId: 'prov-override' },
    })
    expect(r).toEqual({ modelId: 'override-scout', providerId: 'prov-override' })
  })

  it('Agent scout beats the global default', async () => {
    seed({ agentScout: 'agent-scout' })
    await setGlobalScout('global-scout', 'prov-global')
    const r = await resolveScoutModel({ agentId: AGENT })
    expect(r).toEqual({ modelId: 'agent-scout', providerId: 'prov-agent' })
  })

  it('global default when the Agent sets no scout', async () => {
    seed({})
    await setGlobalScout('global-scout', 'prov-global')
    const r = await resolveScoutModel({ agentId: AGENT })
    expect(r).toEqual({ modelId: 'global-scout', providerId: 'prov-global' })
  })

  it("safety net: the Agent's own main model when nothing is configured", async () => {
    seed({})
    const r = await resolveScoutModel({ agentId: AGENT })
    expect(r).toEqual({ modelId: 'agent-main-model', providerId: 'prov-main' })
  })

  it('ignores empty-string tiers (treated as unset)', async () => {
    seed({ agentScout: '  ' })
    await setGlobalScout('global-scout', 'prov-global')
    const r = await resolveScoutModel({ agentId: AGENT })
    expect(r).toEqual({ modelId: 'global-scout', providerId: 'prov-global' })
  })
})

d('resolveScoutThinking priority chain', () => {
  it('per-call override beats every configured tier', async () => {
    seed({ agentScoutThinking: LOW })
    const r = await resolveScoutThinking({ agentId: AGENT, override: { enabled: false } })
    expect(r).toEqual({ enabled: false })
  })

  it('Agent scout thinking beats the global default', async () => {
    seed({ agentScoutThinking: HIGH })
    await appSettings.setDefaultScoutThinking({ enabled: true, effort: 'minimal' })
    const r = await resolveScoutThinking({ agentId: AGENT })
    expect(r).toEqual({ enabled: true, effort: 'high' })
  })

  it('global default when the Agent sets no scout thinking', async () => {
    seed({})
    await appSettings.setDefaultScoutThinking({ enabled: true, effort: 'minimal' })
    const r = await resolveScoutThinking({ agentId: AGENT })
    expect(r).toEqual({ enabled: true, effort: 'minimal' })
  })

  it('null when nothing is configured (execution-time Agent fallback applies)', async () => {
    seed({})
    const r = await resolveScoutThinking({ agentId: AGENT })
    expect(r).toBeNull()
  })

  it('ignores malformed JSON tiers', async () => {
    seed({ agentScoutThinking: '{not-json' })
    await appSettings.setDefaultScoutThinking({ enabled: true, effort: 'minimal' })
    const r = await resolveScoutThinking({ agentId: AGENT })
    expect(r).toEqual({ enabled: true, effort: 'minimal' })
  })
})
