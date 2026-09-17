import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from '@/server/db/schema'

// Skip when another suite has globally mocked the schema to stubs (mock.module
// is process-global): real columns are required for the in-memory CRUD here.
const schemaIsReal = !!(schema as { terminalPresets?: { id?: unknown } }).terminalPresets?.id
if (!schemaIsReal) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const d = describe

const sqlite = new Database(':memory:')
sqlite.run(`CREATE TABLE terminal_presets (
  id text PRIMARY KEY NOT NULL, user_id text NOT NULL, name text NOT NULL,
  cwd text, init_script text, created_at integer NOT NULL, updated_at integer NOT NULL
)`)
const testDb = drizzle(sqlite, { schema })

mock.module('@/server/logger', () => ({ createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }) }))
mock.module('@/server/db/index', () => ({ db: testDb, sqlite, initVirtualTables() {} }))
mock.module('@/server/sse/index', () => ({ sseManager: { sendToUser() {} } }))

const { listPresets, getPreset, createPreset, updatePreset, deletePreset } = await import(
  '@/server/services/terminal-presets'
)

d('terminal-presets', () => {
  beforeEach(() => sqlite.run('DELETE FROM terminal_presets'))

  it('creates a preset (trimmed) and lists it', () => {
    const p = createPreset('u1', { name: '  Hivekeep + Claude  ', cwd: '~/projects/hivekeep', initScript: 'claude\n' })
    expect(p).not.toBeNull()
    expect(p!.name).toBe('Hivekeep + Claude')
    expect(p!.cwd).toBe('~/projects/hivekeep')
    const list = listPresets('u1')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(p!.id)
  })

  it('requires a name', () => {
    expect(createPreset('u1', { name: '   ' })).toBeNull()
    expect(createPreset('u1', {})).toBeNull()
    expect(listPresets('u1')).toHaveLength(0)
  })

  it('scopes presets to their owner', () => {
    const p = createPreset('u1', { name: 'Mine' })!
    expect(getPreset(p.id, 'intruder')).toBeNull()
    expect(updatePreset(p.id, 'intruder', { name: 'Hacked' })).toBeNull()
    expect(deletePreset(p.id, 'intruder')).toBe(false)
    expect(listPresets('intruder')).toHaveLength(0)
  })

  it('updates and clears optional fields, then deletes', () => {
    const p = createPreset('u1', { name: 'Dev', cwd: '~/x', initScript: 'echo hi' })!
    const up = updatePreset(p.id, 'u1', { name: 'Dev 2', cwd: '', initScript: '' })
    expect(up!.name).toBe('Dev 2')
    expect(up!.cwd).toBeNull()
    expect(up!.initScript).toBeNull()

    expect(deletePreset(p.id, 'u1')).toBe(true)
    expect(listPresets('u1')).toHaveLength(0)
  })
})
