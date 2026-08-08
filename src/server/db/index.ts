import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import * as schema from '@/server/db/schema'
import { generateSlug, ensureUniqueSlug } from '@/server/utils/slug'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

const log = createLogger('database')

// Ensure data directory exists
const dbDir = dirname(config.db.path)
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true })
}

const sqlite = new Database(config.db.path)
log.info({ path: config.db.path }, 'SQLite database opened')

// Enable WAL mode for better concurrency
sqlite.run('PRAGMA journal_mode = WAL')
sqlite.run('PRAGMA foreign_keys = ON')
sqlite.run('PRAGMA busy_timeout = 5000')
log.debug('WAL mode enabled, foreign keys on, busy timeout 5000ms')

// Load sqlite-vec extension for vector search
try {
  const { getLoadablePath } = require('sqlite-vec')
  sqlite.loadExtension(getLoadablePath())
} catch {
  log.warn('sqlite-vec extension not available — vector search will be disabled')
}

export const db = drizzle(sqlite, { schema })
export { sqlite }

/**
 * Initialize virtual tables (FTS5, sqlite-vec) that Drizzle doesn't manage.
 * Called once at startup after Drizzle migrations have run.
 */
export function initVirtualTables() {
  // Leftovers from the removed knowledge base. Migration 0118 drops the real
  // tables, but Drizzle does not know about virtual ones, and dropping the vec
  // table needs the sqlite-vec module loaded — which is true here and not in
  // the standalone migrate script. Safe to delete once every install has
  // booted past 0118.
  try {
    sqlite.run('DROP TABLE IF EXISTS knowledge_chunks_fts')
    sqlite.run('DROP TABLE IF EXISTS knowledge_chunks_vec')
  } catch (e) {
    log.warn('knowledge base virtual-table cleanup failed (harmless leftovers remain): %s', e)
  }

  // FTS5: full-text search on memories
  sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid='rowid',
      tokenize='unicode61'
    )
  `)

  // FTS5: full-text search on messages
  sqlite.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content_rowid='rowid',
      tokenize='unicode61'
    )
  `)

  // Triggers to sync memories_fts with memories
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories
    WHEN new.content IS NOT NULL
    BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `)
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories
    WHEN new.content IS NOT NULL
    BEGIN
      UPDATE memories_fts SET content = new.content WHERE rowid = old.rowid;
    END
  `)
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories
    BEGIN
      DELETE FROM memories_fts WHERE rowid = old.rowid;
    END
  `)

  // Triggers to sync messages_fts with messages
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages
    WHEN new.content IS NOT NULL
    BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END
  `)
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages
    WHEN new.content IS NOT NULL
    BEGIN
      UPDATE messages_fts SET content = new.content WHERE rowid = old.rowid;
    END
  `)
  sqlite.run(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages
    BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END
  `)

  // sqlite-vec: vector search on memory embeddings
  // Note: sqlite-vec extension must be loaded. This may fail if the extension
  // is not available — we'll handle that gracefully in later phases.
  try {
    // Detect dimension mismatch: if the vec table exists with a different dimension,
    // we need to drop and recreate it (data will be re-populated from memory embeddings).
    let needsRecreate = false
    try {
      const info = sqlite.query<{ type: string }, []>(
        `SELECT type FROM vec_info('memories_vec') WHERE key = 'dimensions'`
      ).get()
      if (info) {
        const existingDim = parseInt(info.type, 10)
        if (!isNaN(existingDim) && existingDim !== config.memory.embeddingDimension) {
          log.info(
            { from: existingDim, to: config.memory.embeddingDimension },
            'Embedding dimension changed — recreating vector index (re-embedding required)',
          )
          needsRecreate = true
        }
      }
    } catch {
      // Table doesn't exist yet or vec_info not available — will be created below
    }

    if (needsRecreate) {
      sqlite.run(`DROP TABLE IF EXISTS memories_vec`)
    }

    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        memory_id text PRIMARY KEY,
        embedding float[${config.memory.embeddingDimension}]
      )
    `)
  } catch {
    log.warn('sqlite-vec: virtual table creation failed — vector search disabled')
  }

  // Backfill slugs for existing agents that don't have one
  backfillSlugs()
}

/**
 * Generate slugs for any agents that have a NULL slug.
 * Called once at startup after schema is applied.
 */
function backfillSlugs() {
  const agentsWithoutSlug = sqlite.query<{ id: string; name: string }, []>(
    'SELECT id, name FROM agents WHERE slug IS NULL'
  ).all()

  if (agentsWithoutSlug.length === 0) return

  const existingSlugs = new Set(
    sqlite.query<{ slug: string }, []>(
      'SELECT slug FROM agents WHERE slug IS NOT NULL'
    ).all().map((r) => r.slug)
  )

  for (const agent of agentsWithoutSlug) {
    const baseSlug = generateSlug(agent.name)
    const slug = ensureUniqueSlug(baseSlug || 'agent', existingSlugs)
    existingSlugs.add(slug)
    sqlite.run('UPDATE agents SET slug = ? WHERE id = ?', [slug, agent.id])
  }

  log.info({ count: agentsWithoutSlug.length }, 'Backfilled slugs for existing agents')
}
