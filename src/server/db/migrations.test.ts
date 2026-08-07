/**
 * Migration integrity test.
 *
 * Re-implements the checks that used to live in the standalone `migrations.yml`
 * GitHub workflow as a unit test so they run inside `bun run test`:
 *
 *   1. All Drizzle migrations apply cleanly to a FRESH sqlite database, using
 *      the SAME mechanism the app uses (`drizzle-orm/bun-sqlite` migrator
 *      pointed at `src/server/db/migrations`, exactly like `scripts/migrate.ts`).
 *   2. Every table declared in the Drizzle schema exists after migrating, plus a
 *      representative core subset is spot-checked by name.
 *   3. Foreign-key integrity holds on the fresh schema (`PRAGMA foreign_key_check`
 *      reports zero violations) and a basic FK relationship actually enforces.
 *   4. Migrations are IDEMPOTENT: running the migrator a second time on the
 *      already-migrated database is a no-op (no error, no duplicate-table
 *      failure, no extra rows in drizzle's bookkeeping table).
 *   5. The newest migration applies to a POPULATED database, not just a fresh
 *      one. Migration 0114 shipped green on fresh DBs but failed on every
 *      installed instance: the migrator runs inside one transaction where
 *      `PRAGMA foreign_keys=OFF` is a no-op, so its `DROP TABLE agents`
 *      violated live FKs. This test applies all-but-the-last migration, seeds
 *      referencing rows, then runs the head migration over them.
 *
 * Deliberately self-contained: it never imports `@/server/db/index` (that would
 * open the real on-disk DB) and uses NO `mock.module`, so it can't leak mocks
 * into sibling test files. The only schema import is to derive the real,
 * post-migration table names instead of hardcoding/guessing them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import * as schema from '@/server/db/schema'
import { runMigrations } from '@/server/db/run-migrations'

// NOTE: deliberately import ONLY from drizzle submodule specifiers
// (`drizzle-orm/sqlite-core`, `drizzle-orm/bun-sqlite/*`), never from the bare
// `drizzle-orm` package. Several sibling tests do `mock.module('drizzle-orm', ...)`
// with a partial stub that omits `getTableName`/`is`; because bun's module mocks
// leak across files in a run, importing those from the bare package here would
// crash this test when it runs after one of them. The submodule specifiers are
// distinct module ids and are not mocked, so they stay intact.

// Same migrations folder `scripts/migrate.ts` and drizzle.config.ts point at.
const migrationsFolder = resolve(import.meta.dir, 'migrations')

// Derive the real SQL table names straight from the Drizzle schema so the
// assertions track schema changes automatically (no manual list to drift).
// `SQLiteTable.Symbol.Name` is drizzle's accessor for a table's underlying SQL
// name; reading it (rather than the bare-package `getTableName`) keeps this
// test independent of the mocked `drizzle-orm` module (see import note above).
const tableNameSymbol = (SQLiteTable as unknown as { Symbol: { Name: symbol } })
  .Symbol.Name
const schemaTableNames: string[] = Object.values(schema)
  .filter((v) => v instanceof SQLiteTable)
  .map((t) => (t as unknown as Record<symbol, string>)[tableNameSymbol])
  .filter((name): name is string => typeof name === 'string')
  .sort()

// Several sibling tests do `mock.module('@/server/db/schema', () => fullMockSchema)`
// where each table is a plain `{}` (not a SQLiteTable). Because bun's module
// mocks leak across files within a single `bun test` run, the `schema` import
// above can resolve to that stub when this file runs after one of them. In that
// case `schemaTableNames` comes back empty. We detect that and skip ONLY the
// schema<->DB completeness comparison (which needs the real schema); the
// migration apply, FK, idempotency, and core-table-by-name checks all still run
// and are immune to the leak. Mirrors the `schemaIsReal` guard used in the
// other schema-touching test files.
const schemaIsReal = schemaTableNames.length > 0

// A representative subset of core domain tables. These are spot-checked by name
// so a wholesale rename (the kind that broke things during the Kin -> Agent
// rebrand) is caught explicitly, not just implicitly via the schema scan.
// Curated from the real schema; validated against it below when the real schema
// is loaded so this list can't silently rot.
const CORE_TABLES = [
  'agents',
  'messages',
  'memories',
  'tasks',
  'crons',
  'providers',
  'toolboxes',
  'channels',
  'vault_secrets',
  'app_settings',
  'user_profiles',
  'queue_items',
] as const

let tmpDir: string
let dbPath: string

function openDb() {
  const sqlite = new Database(dbPath)
  // Mirror the app/runner pragmas (scripts/migrate.ts + src/server/db/index.ts).
  sqlite.run('PRAGMA journal_mode = WAL')
  sqlite.run('PRAGMA foreign_keys = ON')
  return sqlite
}

describe('database migrations', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hivekeep-migrations-test-'))
    dbPath = join(tmpDir, 'fresh.db')
  })

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it.skipIf(!schemaIsReal)(
    'derives a non-trivial set of table names from the schema',
    () => {
      // When the real schema is loaded it must expose a substantial table set;
      // a tiny count would mean something stubbed the schema and the
      // completeness check below would be vacuous.
      expect(schemaTableNames.length).toBeGreaterThan(20)
    },
  )

  it.skipIf(!schemaIsReal)(
    'every spot-checked core table is actually declared in the schema',
    () => {
      for (const name of CORE_TABLES) {
        expect(schemaTableNames).toContain(name)
      }
    },
  )

  it('applies all migrations cleanly to a fresh database', () => {
    const sqlite = openDb()
    try {
      const db = drizzle(sqlite)
      expect(() => runMigrations(sqlite, db, migrationsFolder)).not.toThrow()

      // drizzle records applied migrations in __drizzle_migrations; a fresh
      // apply should record every journal entry (one row per migration).
      const applied = sqlite
        .query<{ c: number }, []>(
          'SELECT COUNT(*) AS c FROM __drizzle_migrations',
        )
        .get()
      expect(applied?.c ?? 0).toBeGreaterThan(0)
    } finally {
      sqlite.close()
    }
  })

  it.skipIf(!schemaIsReal)(
    'creates every table declared in the Drizzle schema',
    () => {
      const sqlite = openDb()
      try {
        const existing = new Set(
          sqlite
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type = 'table'",
            )
            .all()
            .map((r) => r.name),
        )

        // Any schema-declared table missing from the migrated DB means a
        // migration was forgotten for that table.
        const missing = schemaTableNames.filter((t) => !existing.has(t))
        expect(missing).toEqual([])
      } finally {
        sqlite.close()
      }
    },
  )

  it('creates the representative core tables by name', () => {
    const sqlite = openDb()
    try {
      for (const name of CORE_TABLES) {
        const row = sqlite
          .query<{ name: string }, [string]>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(name)
        expect(row?.name).toBe(name)
      }
    } finally {
      sqlite.close()
    }
  })

  it('has no foreign-key violations on the fresh schema', () => {
    const sqlite = openDb()
    try {
      // PRAGMA foreign_key_check returns one row PER violation; an empty result
      // means the schema's FK graph is internally consistent.
      const violations = sqlite
        .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
        .all()
      expect(violations).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('enforces a representative foreign-key relationship', () => {
    const sqlite = openDb()
    try {
      // agents.id is referenced by many child tables; messages.agent_id is one
      // such FK. This insert satisfies every NOT NULL column (id, agent_id, role,
      // source_type, created_at) so the ONLY thing that can make it fail is the
      // dangling agent_id. With foreign_keys ON it must be rejected, proving the
      // constraint actually shipped (not merely that a column was missing).
      let message = ''
      try {
        sqlite.run(
          "INSERT INTO messages (id, agent_id, role, source_type, content, created_at) VALUES ('m_fk_test', 'no_such_agent', 'user', 'user', 'x', 0)",
        )
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain('FOREIGN KEY')
    } finally {
      sqlite.close()
    }
  })

  it('is idempotent: re-running the migrator is a no-op', () => {
    const sqlite = openDb()
    try {
      const db = drizzle(sqlite)

      const countApplied = () =>
        sqlite
          .query<{ c: number }, []>(
            'SELECT COUNT(*) AS c FROM __drizzle_migrations',
          )
          .get()?.c ?? 0

      const before = countApplied()
      expect(before).toBeGreaterThan(0)

      // A second run on the already-migrated DB must not throw (e.g. no
      // "table already exists") and must not re-apply anything.
      expect(() => runMigrations(sqlite, db, migrationsFolder)).not.toThrow()

      const after = countApplied()
      expect(after).toBe(before)
    } finally {
      sqlite.close()
    }
  })

  it('applies the newest migration to a populated database', () => {
    // Build a migrations folder containing everything EXCEPT the newest journal
    // entry, migrate a scratch DB with it, seed rows that exercise the FK graph
    // (agents referenced by messages/tasks/memories), then run the full set so
    // the head migration executes over live data exactly like an upgrade of an
    // installed instance.
    const journal = JSON.parse(
      readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    expect(journal.entries.length).toBeGreaterThan(1)

    const partialDir = join(tmpDir, 'partial-migrations')
    mkdirSync(join(partialDir, 'meta'), { recursive: true })
    const truncated = { ...journal, entries: journal.entries.slice(0, -1) }
    writeFileSync(join(partialDir, 'meta', '_journal.json'), JSON.stringify(truncated))
    for (const entry of truncated.entries) {
      copyFileSync(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(partialDir, `${entry.tag}.sql`),
      )
    }

    // Insert one row filling every NOT-NULL-without-default column with a
    // type-appropriate dummy, so the seed keeps working as the previous-version
    // schema evolves. FK columns must come in via overrides.
    const seedRow = (
      sqlite: Database,
      table: string,
      overrides: Record<string, string | number>,
    ) => {
      const cols = sqlite
        .query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
          `PRAGMA table_info(${table})`,
        )
        .all()
      const values: Record<string, string | number> = { ...overrides }
      for (const c of cols) {
        if (c.name in values) continue
        if (!c.notnull || c.dflt_value !== null) continue
        const t = c.type.toLowerCase()
        values[c.name] = t.includes('int') || t.includes('real') || t.includes('num') ? 0 : 'x'
      }
      const names = Object.keys(values)
      sqlite.run(
        `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        names.map((n) => values[n]!),
      )
    }

    const popPath = join(tmpDir, 'populated.db')
    const sqlite = new Database(popPath)
    sqlite.run('PRAGMA journal_mode = WAL')
    sqlite.run('PRAGMA foreign_keys = ON')
    try {
      const db = drizzle(sqlite)
      runMigrations(sqlite, db, partialDir)

      seedRow(sqlite, 'agents', { id: 'agent_pop' })
      seedRow(sqlite, 'messages', { id: 'msg_pop', agent_id: 'agent_pop' })
      seedRow(sqlite, 'tasks', { id: 'task_pop', parent_agent_id: 'agent_pop' })
      seedRow(sqlite, 'memories', { id: 'mem_pop', agent_id: 'agent_pop' })

      expect(() => runMigrations(sqlite, db, migrationsFolder)).not.toThrow()

      // The upgrade must preserve the seeded rows and leave the FK graph clean.
      for (const [table, id] of [
        ['agents', 'agent_pop'],
        ['messages', 'msg_pop'],
        ['tasks', 'task_pop'],
        ['memories', 'mem_pop'],
      ] as const) {
        const row = sqlite
          .query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE id = ?`)
          .get(id)
        expect(row?.id).toBe(id)
      }
      const violations = sqlite
        .query<Record<string, unknown>, []>('PRAGMA foreign_key_check')
        .all()
      expect(violations).toEqual([])
    } finally {
      sqlite.close()
    }
  })
})
