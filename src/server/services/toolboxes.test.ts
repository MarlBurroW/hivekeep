/**
 * Tests for the toolbox wildcard ("*") expansion semantics.
 *
 * Spins up a real in-memory SQLite DB with the production schema (same pattern
 * as tasks-scout-suspend.test.ts) so we exercise the actual drizzle queries in
 * `resolveToolboxNames` end-to-end. We use the REAL toolRegistry (registering a
 * couple of throwaway native + plugin tools in beforeAll / removing them in
 * afterAll) rather than mocking `@/server/tools/index`, because Bun's
 * mock.module is process-global and would poison sibling suites that rely on
 * the registry's register/unregister/resolve methods.
 *
 * The behaviour under test:
 *   - "*" (the 'all' built-in) expands to every NATIVE registry tool PLUS every
 *     ENABLED custom tool (`custom_<slug>`).
 *   - Plugin tools (`plugin_*`) live in the registry but are EXCLUDED from "*".
 *   - DISABLED custom tools are NOT added by "*".
 *   - MCP tools are never in the registry / custom set, so "*" never grants them
 *     (they must be listed by explicit name) — we assert an explicit mcp_* name
 *     listed in a toolbox is returned verbatim, while "*" alone never yields one.
 */
import { describe, it, expect, mock, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { v4 as uuid } from 'uuid'
import * as schema from '@/server/db/schema'
import { toolRegistry } from '@/server/tools/index'
import type { ToolRegistration } from '@/server/tools/types'
import type { Tool } from '@/server/tools/tool-helper'

// ─── Mock pollution guard (matches sibling real-DB tests) ────────────────────
const schemaIsReal = !!(schema as any).toolboxes?.id && !!(schema as any).customTools?.id

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
}))

const sqlite = new Database(':memory:')
sqlite.run('PRAGMA foreign_keys = OFF')
const db = schemaIsReal ? drizzle(sqlite, { schema }) : (null as any)

if (schemaIsReal) {
  mock.module('@/server/db/index', () => ({ db, sqlite, initVirtualTables: () => {} }))
}

const svc = schemaIsReal
  ? await import('@/server/services/toolboxes')
  : ({} as typeof import('@/server/services/toolboxes'))
const { resolveToolboxNames, createToolbox } =
  svc as typeof import('@/server/services/toolboxes')

if (!schemaIsReal) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const itReal = it

// Throwaway tools registered into the REAL registry for the duration of this
// suite. One native, one plugin (the plugin MUST be excluded from "*").
const NATIVE_TOOL = '__toolbox_wildcard_test_native__'
const PLUGIN_TOOL = 'plugin___toolbox_wildcard_test__'

const fakeTool = (): ToolRegistration => ({
  availability: ['main', 'sub-agent'],
  create: () =>
    ({ description: '', inputSchema: undefined as any, execute: async () => null } as unknown as Tool<
      any,
      any
    >),
})

// ─── Schema bootstrap (only the tables resolveToolboxNames touches) ──────────
beforeAll(() => {
  if (!schemaIsReal) return
  toolRegistry.register(NATIVE_TOOL, fakeTool(), 'system')
  toolRegistry.register(PLUGIN_TOOL, fakeTool(), 'system')
  sqlite.run(`
    CREATE TABLE toolboxes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      tool_names TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  sqlite.run(`
    CREATE TABLE custom_tools (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      parameters TEXT NOT NULL,
      entrypoint TEXT NOT NULL,
      translations TEXT,
      language TEXT,
      domain_slug TEXT NOT NULL DEFAULT 'custom',
      timeout_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
})

afterAll(() => {
  if (!schemaIsReal) return
  toolRegistry.unregister(NATIVE_TOOL)
  toolRegistry.unregister(PLUGIN_TOOL)
})

beforeEach(() => {
  if (!schemaIsReal) return
  sqlite.run('DELETE FROM toolboxes')
  sqlite.run('DELETE FROM custom_tools')
})

function insertCustomTool(slug: string, enabled: boolean): void {
  const now = Date.now()
  sqlite.run(
    `INSERT INTO custom_tools
       (id, slug, name, description, parameters, entrypoint, domain_slug, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'custom', ?, 'user', ?, ?)`,
    [uuid(), slug, slug, `desc ${slug}`, '{}', 'main.ts', enabled ? 1 : 0, now, now],
  )
}

describe('resolveToolboxNames — "*" wildcard', () => {
  itReal('expands "*" to native tools + ENABLED custom tools, excluding disabled customs and plugins', () => {
    insertCustomTool('enabled_one', true)
    insertCustomTool('disabled_one', false)

    const all = createToolbox({ name: 'all-test', toolNames: ['*'] })
    const resolved = resolveToolboxNames([all.id])

    // Native tool present.
    expect(resolved).toContain(NATIVE_TOOL)
    // Enabled custom present.
    expect(resolved).toContain('custom_enabled_one')
    // Disabled custom NOT present.
    expect(resolved).not.toContain('custom_disabled_one')
    // Plugin tool NOT auto-granted by "*".
    expect(resolved).not.toContain(PLUGIN_TOOL)
    // MCP tools never appear from "*" (none listed, none in universe).
    expect(resolved.some((n) => n.startsWith('mcp_'))).toBe(false)
  })

  itReal('does not grant plugin/mcp tools via "*" but returns them verbatim when listed by name', () => {
    insertCustomTool('enabled_one', true)

    const box = createToolbox({
      name: 'explicit-test',
      // "*" plus explicit plugin + mcp names.
      toolNames: ['*', PLUGIN_TOOL, 'mcp_server__do_thing'],
    })
    const resolved = resolveToolboxNames([box.id])

    // Explicitly listed names are returned verbatim.
    expect(resolved).toContain(PLUGIN_TOOL)
    expect(resolved).toContain('mcp_server__do_thing')
    // Wildcard still pulled in native + enabled custom.
    expect(resolved).toContain(NATIVE_TOOL)
    expect(resolved).toContain('custom_enabled_one')
  })

  itReal('a non-wildcard toolbox does NOT auto-grant custom tools', () => {
    insertCustomTool('enabled_one', true)

    const box = createToolbox({ name: 'native-list', toolNames: [NATIVE_TOOL] })
    const resolved = resolveToolboxNames([box.id])

    expect(resolved).toEqual([NATIVE_TOOL])
    expect(resolved).not.toContain('custom_enabled_one')
  })
})
