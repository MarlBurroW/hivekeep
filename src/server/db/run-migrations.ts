import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { Database } from 'bun:sqlite'
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'

/**
 * Run Drizzle migrations with FK enforcement disabled at the connection level.
 *
 * The Drizzle migrator wraps all pending migrations in a single transaction,
 * and SQLite ignores `PRAGMA foreign_keys` while a transaction is open, so a
 * `PRAGMA foreign_keys=OFF` inside a migration file is a no-op. Any migration
 * that rebuilds a referenced table (`DROP TABLE agents` + rename) therefore
 * fails on a populated database unless the pragma is set on the connection
 * before the transaction starts. Integrity is checked explicitly afterwards,
 * but only when something was actually applied (`foreign_key_check` scans the
 * whole database, which is too slow to pay on every boot).
 */
export function runMigrations(
  sqlite: Database,
  db: BunSQLiteDatabase<Record<string, unknown>>,
  migrationsFolder: string,
): void {
  const applied = countAppliedMigrations(sqlite)
  sqlite.run('PRAGMA foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder })
    if (countAppliedMigrations(sqlite) !== applied) {
      const violations = sqlite.query('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new Error(
          `Migrations left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations.slice(0, 5))}`,
        )
      }
    }
  } finally {
    sqlite.run('PRAGMA foreign_keys = ON')
  }
}

function countAppliedMigrations(sqlite: Database): number {
  try {
    const row = sqlite
      .query<{ c: number }, []>('SELECT count(*) AS c FROM __drizzle_migrations')
      .get()
    return row?.c ?? 0
  } catch {
    return 0
  }
}
