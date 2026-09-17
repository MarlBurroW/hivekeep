/**
 * Integration tests for the model registry reconciliation against a real
 * in-memory SQLite DB (the heart of phase 1). Uses the bundled models.dev
 * snapshot for matching, so the assertions also pin the real seed data.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'
import { __setSnapshotForTests } from '@/server/llm/metadata/models-dev'

// Some earlier test files stub `@/server/db/schema` via mock.module (every table
// becomes `{}`). When this file runs after one of those, the static
// `import { modelRegistry } from schema` inside the SUT throws. Detect pollution
// and skip cleanly — same pattern as the other DB-backed service tests.
const schemaIsReal = !!(schema as { modelRegistry?: { id?: unknown } }).modelRegistry?.id
const d = schemaIsReal ? describe : describe.skip

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

const sqlite = new Database(':memory:')
// Only the table under test — no FK enforcement so we don't need a providers row.
sqlite.run(`CREATE TABLE model_registry (
  id text PRIMARY KEY NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  display_name text,
  mapping_mode text DEFAULT 'auto' NOT NULL,
  models_dev_key text,
  match_confidence text,
  context_window integer,
  max_output integer,
  supports_tool_call integer,
  supports_image_input integer,
  supports_pdf_input integer,
  reasoning text,
  pricing text,
  overridden_fields text,
  enabled integer DEFAULT true NOT NULL,
  needs_review integer DEFAULT false NOT NULL,
  stale integer DEFAULT false NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
)`)
const testDb = drizzle(sqlite, { schema })
mock.module('@/server/db/index', () => ({ db: testDb, sqlite }))

// Only load the SUT when the schema is real — a polluted schema makes the SUT's
// static `modelRegistry` import throw at module eval.
const reg = schemaIsReal
  ? await import('@/server/services/model-registry')
  : ({} as typeof import('@/server/services/model-registry'))
const { reconcileProviderModels, getRegistryRow, listRegistryByProvider, rowToMetadata, updateRegistryModel, remapModel, setMappingMode, resetModelToAuto, bulkSetEnabled, bulkConfirmReview } = reg
const modelRegistry = (schema as typeof import('@/server/db/schema')).modelRegistry

const PROVIDER = 'provider-uuid-1'

beforeEach(() => {
  if (schemaIsReal) testDb.delete(modelRegistry).run()
})

d('reconcileProviderModels', () => {
  it('seeds a matched model: API value wins, models.dev fills the gaps (pricing) and owns efforts', () => {
    // deepseek provider sets context + thinking; does NOT set pricing.
    reconcileProviderModels(PROVIDER, 'deepseek', [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, thinking: { efforts: ['low', 'medium', 'high', 'max'] } },
    ])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.contextWindow).toBe(1_000_000) // apiSeed
    expect(row.supportsImageInput).toBe(false) // filled from models.dev (input:[text])
    expect(row.modelsDevKey).toBe('deepseek/deepseek-v4-flash')
    expect(row.matchConfidence).toBe('exact')
    expect(row.needsReview).toBe(false)
    expect(row.enabled).toBe(true) // confident match → active immediately
    expect(row.stale).toBe(false)
    expect(JSON.parse(row.pricing!)).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.0028 }) // models.dev
    // models.dev's explicit per-model effort list beats the provider's
    // heuristic seed (mergeAutoMetadata thinking exception).
    expect(JSON.parse(row.reasoning!)).toEqual({ enabled: true, efforts: ['high', 'max'] })
  })

  it('flags an unmatched model for review (no models.dev entry)', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-mystery-x', name: 'Mystery', contextWindow: 64_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-mystery-x')!
    expect(row.contextWindow).toBe(64_000) // apiSeed only
    expect(row.modelsDevKey).toBeNull()
    expect(row.matchConfidence).toBe('none')
    expect(row.needsReview).toBe(true)
    expect(row.enabled).toBe(false) // review models land disabled until confirmed
  })

  it('marks a disappeared model as stale (not deleted)', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [
      { id: 'deepseek-v4-flash', name: 'a' },
      { id: 'deepseek-v4-pro', name: 'b' },
    ])
    expect(listRegistryByProvider(PROVIDER)).toHaveLength(2)
    // pro disappears from the live list
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'a' }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-pro')!.stale).toBe(true)
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.stale).toBe(false)
    expect(listRegistryByProvider(PROVIDER)).toHaveLength(2) // not deleted
  })

  it('preserves admin-pinned fields across re-reconcile', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    // Admin pins a custom context window (raw UPDATE keeps the test drizzle-free).
    sqlite.run(`UPDATE model_registry SET context_window=200000, overridden_fields='["contextWindow"]' WHERE id=?`, [row.id])
    // Re-reconcile with a different live context — the pinned field must survive.
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 999_999 }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.contextWindow).toBe(200_000)
  })

  it('freezes a manual-mode row entirely', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    sqlite.run(`UPDATE model_registry SET mapping_mode='manual', context_window=123 WHERE id=?`, [row.id])
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 999_999 }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.contextWindow).toBe(123)
  })
})

d('rowToMetadata', () => {
  it('round-trips columns back into resolved metadata', () => {
    reconcileProviderModels(PROVIDER, 'minimax', [{ id: 'MiniMax-M3', name: 'MiniMax-M3' }])
    const md = rowToMetadata(getRegistryRow(PROVIDER, 'MiniMax-M3')!)
    expect(md.contextWindow).toBe(512_000) // from models.dev
    expect(md.supportsImageInput).toBe(true)
    expect(md.supportsPdfInput).toBe(false)
    expect(md.thinking).toEqual({ efforts: [] }) // reasoning toggle-only
  })
})

d('admin edits (Models view)', () => {
  it('pins an edited field so it survives re-reconcile', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    updateRegistryModel(id, { contextWindow: 50_000 })
    let row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.contextWindow).toBe(50_000)
    expect(JSON.parse(row.overriddenFields!)).toContain('contextWindow')
    // resync must NOT clobber the pinned value
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.contextWindow).toBe(50_000)
  })

  it('remaps an unmatched model onto a models.dev entry', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'weird-alias', name: 'Weird' }])
    const id = getRegistryRow(PROVIDER, 'weird-alias')!.id
    expect(getRegistryRow(PROVIDER, 'weird-alias')!.needsReview).toBe(true)
    remapModel(id, 'deepseek/deepseek-v4-flash')
    const row = getRegistryRow(PROVIDER, 'weird-alias')!
    expect(row.modelsDevKey).toBe('deepseek/deepseek-v4-flash')
    expect(row.needsReview).toBe(false)
    expect(row.contextWindow).toBe(1_000_000) // pulled from models.dev
    expect(JSON.parse(row.pricing!).input).toBe(0.14)
  })

  it('freezes a row set to manual mode', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    setMappingMode(id, 'manual')
    updateRegistryModel(id, { contextWindow: 7 })
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.contextWindow).toBe(7)
  })

  it('confirming a review clears the flag, enables the model, and pins nothing', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'weird-alias', name: 'Weird' }])
    const id = getRegistryRow(PROVIDER, 'weird-alias')!.id
    expect(getRegistryRow(PROVIDER, 'weird-alias')!.needsReview).toBe(true)
    expect(getRegistryRow(PROVIDER, 'weird-alias')!.enabled).toBe(false) // review → disabled
    updateRegistryModel(id, {}) // empty patch = the ✓ confirm
    const row = getRegistryRow(PROVIDER, 'weird-alias')!
    expect(row.needsReview).toBe(false)
    expect(row.enabled).toBe(true) // confirming enables it
    expect(JSON.parse(row.overriddenFields!)).toEqual([])
  })

  it('auto-confirms (clears review + enables) when a later resync matches confidently', () => {
    try {
      // First pass: model absent from the snapshot → flagged review + disabled.
      __setSnapshotForTests({ deepseek: {} } as never)
      reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'ds-future', name: 'x' }])
      let row = getRegistryRow(PROVIDER, 'ds-future')!
      expect(row.needsReview).toBe(true)
      expect(row.enabled).toBe(false)

      // Second pass: the snapshot now has it (exact) → auto-confirm + enable.
      __setSnapshotForTests({ deepseek: { 'ds-future': { name: 'DS Future', context: 1000 } } } as never)
      reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'ds-future', name: 'x' }])
      row = getRegistryRow(PROVIDER, 'ds-future')!
      expect(row.matchConfidence).toBe('exact')
      expect(row.needsReview).toBe(false)
      expect(row.enabled).toBe(true)
    } finally {
      __setSnapshotForTests(null)
    }
  })

  it('does NOT re-flag or re-enable an admin-disabled row on resync', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    updateRegistryModel(id, { enabled: false }) // admin hides a confident model
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.enabled).toBe(false) // stays hidden — resync respects the choice
    expect(row.needsReview).toBe(false)
  })

  it('lets an explicit enabled=false win over the auto-enable on review-clear', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'weird-alias', name: 'Weird' }])
    const id = getRegistryRow(PROVIDER, 'weird-alias')!.id
    updateRegistryModel(id, { enabled: false }) // toggle stays off even though review clears
    const row = getRegistryRow(PROVIDER, 'weird-alias')!
    expect(row.needsReview).toBe(false)
    expect(row.enabled).toBe(false)
  })

  it('bulk enable/disable flips many rows and clears review', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'weird-1', name: 'a' }, { id: 'weird-2', name: 'b' }])
    const ids = [getRegistryRow(PROVIDER, 'weird-1')!.id, getRegistryRow(PROVIDER, 'weird-2')!.id]
    expect(getRegistryRow(PROVIDER, 'weird-1')!.enabled).toBe(false) // review → disabled
    bulkSetEnabled(ids, true)
    expect(getRegistryRow(PROVIDER, 'weird-1')!.enabled).toBe(true)
    expect(getRegistryRow(PROVIDER, 'weird-2')!.needsReview).toBe(false)
    bulkSetEnabled(ids, false)
    expect(getRegistryRow(PROVIDER, 'weird-2')!.enabled).toBe(false)
  })

  it('bulk confirm only clears review rows (and enables them)', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [
      { id: 'deepseek-v4-flash', name: 'DS' }, // exact → not review, enabled
      { id: 'weird-x', name: 'x' }, // none → review, disabled
    ])
    const good = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    const rev = getRegistryRow(PROVIDER, 'weird-x')!
    bulkConfirmReview([good.id, rev.id])
    expect(getRegistryRow(PROVIDER, 'weird-x')!.needsReview).toBe(false)
    expect(getRegistryRow(PROVIDER, 'weird-x')!.enabled).toBe(true)
    // the already-confident row is untouched (still enabled, still no review)
    expect(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.enabled).toBe(true)
  })

  it('resetModelToAuto drops every pin, returns to auto, and re-derives from models.dev', () => {
    reconcileProviderModels(PROVIDER, 'deepseek', [{ id: 'deepseek-v4-flash', name: 'DS', contextWindow: 1_000_000 }])
    const id = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.id
    updateRegistryModel(id, { contextWindow: 42, displayName: 'My Custom Label' })
    setMappingMode(id, 'manual')
    expect(JSON.parse(getRegistryRow(PROVIDER, 'deepseek-v4-flash')!.overriddenFields!).length).toBeGreaterThan(0)

    resetModelToAuto(id)
    const row = getRegistryRow(PROVIDER, 'deepseek-v4-flash')!
    expect(row.mappingMode).toBe('auto')
    expect(JSON.parse(row.overriddenFields!)).toEqual([])
    expect(row.contextWindow).toBe(1_000_000) // back to the models.dev value
    expect(row.displayName).not.toBe('My Custom Label') // custom label dropped
    expect(row.needsReview).toBe(false)
  })
})
