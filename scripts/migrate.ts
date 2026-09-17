/**
 * Standalone migration script using bun:sqlite (not better-sqlite3).
 * drizzle-kit migrate internally depends on better-sqlite3 which Bun
 * does not support, so we run migrations via drizzle-orm's migrator instead.
 */
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { runMigrations } from '../src/server/db/run-migrations'
import { mkdirSync, existsSync } from 'fs'
import { dirname, resolve } from 'path'

const dbPath = process.env.DB_PATH ?? './data/hivekeep.db'

// Ensure data directory exists
const dbDir = dirname(dbPath)
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true })
}

const sqlite = new Database(dbPath)
sqlite.run('PRAGMA journal_mode = WAL')
sqlite.run('PRAGMA foreign_keys = ON')

const db = drizzle(sqlite)

const migrationsFolder = resolve(import.meta.dir, '../src/server/db/migrations')

console.log(`Migrating database at ${dbPath}...`)
runMigrations(sqlite, db, migrationsFolder)
console.log('Migrations complete.')

sqlite.close()
