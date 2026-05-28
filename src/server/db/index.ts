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

  // FTS5 + triggers + vec for knowledge chunks
  // Wrapped in try-catch: knowledge_chunks table must exist (created by migrations)
  try {
    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='unicode61'
      )
    `)

    sqlite.run(`
      CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_insert AFTER INSERT ON knowledge_chunks
      WHEN new.content IS NOT NULL
      BEGIN
        INSERT INTO knowledge_chunks_fts(rowid, content) VALUES (new.rowid, new.content);
      END
    `)
    sqlite.run(`
      CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_update AFTER UPDATE OF content ON knowledge_chunks
      WHEN new.content IS NOT NULL
      BEGIN
        UPDATE knowledge_chunks_fts SET content = new.content WHERE rowid = old.rowid;
      END
    `)
    sqlite.run(`
      CREATE TRIGGER IF NOT EXISTS knowledge_chunks_fts_delete AFTER DELETE ON knowledge_chunks
      BEGIN
        DELETE FROM knowledge_chunks_fts WHERE rowid = old.rowid;
      END
    `)
  } catch (e) {
    log.warn('knowledge_chunks FTS5 setup failed — knowledge full-text search disabled: %s', e)
  }

  try {
    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_vec USING vec0(
        chunk_id text PRIMARY KEY,
        embedding float[${config.memory.embeddingDimension}]
      )
    `)
  } catch {
    log.warn('sqlite-vec: knowledge_chunks_vec creation failed - vector search disabled for knowledge')
  }

  // FTS5 + triggers + vec for project_knowledge (curated, project-scoped facts)
  try {
    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS project_knowledge_fts USING fts5(
        content,
        content_rowid='rowid',
        tokenize='unicode61'
      )
    `)

    // The fts5 `content` column stores `title || char(10) || body` so that
    // FTS queries hit both title and body words. Trigger fires on any
    // UPDATE (not OF content) so title-only edits also re-index.
    //
    // Drop-then-create on every boot — `CREATE TRIGGER IF NOT EXISTS` would
    // silently keep a stale definition from an older codebase, which is
    // exactly how the title-not-indexed bug shipped. Triggers are cheap;
    // re-binding them at startup makes the DB definition match this file.
    sqlite.run('DROP TRIGGER IF EXISTS project_knowledge_fts_insert')
    sqlite.run('DROP TRIGGER IF EXISTS project_knowledge_fts_update')
    sqlite.run('DROP TRIGGER IF EXISTS project_knowledge_fts_delete')
    sqlite.run(`
      CREATE TRIGGER project_knowledge_fts_insert AFTER INSERT ON project_knowledge
      WHEN new.content IS NOT NULL
      BEGIN
        INSERT INTO project_knowledge_fts(rowid, content) VALUES (new.rowid, new.title || char(10) || new.content);
      END
    `)
    sqlite.run(`
      CREATE TRIGGER project_knowledge_fts_update AFTER UPDATE ON project_knowledge
      WHEN new.content IS NOT NULL
      BEGIN
        UPDATE project_knowledge_fts SET content = new.title || char(10) || new.content WHERE rowid = old.rowid;
      END
    `)
    sqlite.run(`
      CREATE TRIGGER project_knowledge_fts_delete AFTER DELETE ON project_knowledge
      BEGIN
        DELETE FROM project_knowledge_fts WHERE rowid = old.rowid;
      END
    `)

    // Rebuild the FTS index from the source table. This must live here (not in
    // a Drizzle migration) because the virtual table only exists after this
    // function runs. It is the migration path for two cases:
    //   1. Rows created before the title column existed (migration 0076) were
    //      indexed body-only — re-index them with title + body.
    //   2. A fresh prod DB where the FTS table was just created above and the
    //      triggers weren't around when the rows were inserted by migrations.
    // The rebuild is idempotent and cheap (project knowledge is small), so we
    // run it unconditionally rather than trying to detect staleness. Triggers
    // fire on project_knowledge writes, not on FTS writes, so these statements
    // don't recurse.
    sqlite.run('DELETE FROM project_knowledge_fts')
    sqlite.run(`
      INSERT INTO project_knowledge_fts(rowid, content)
      SELECT rowid, title || char(10) || content FROM project_knowledge WHERE content IS NOT NULL
    `)
  } catch (e) {
    log.warn('project_knowledge FTS5 setup failed — project knowledge full-text search disabled: %s', e)
  }

  try {
    sqlite.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS project_knowledge_vec USING vec0(
        knowledge_id text PRIMARY KEY,
        embedding float[${config.memory.embeddingDimension}]
      )
    `)
  } catch {
    log.warn('sqlite-vec: project_knowledge_vec creation failed — vector search disabled for project knowledge')
  }

  // Backfill slugs for existing kins that don't have one
  backfillSlugs()
  // Backfill project slugs + ticket numbers for the project/ticket tables
  // introduced before migration 0060 (both columns are nullable for legacy
  // rows; the application layer expects them to be set everywhere).
  backfillProjectSlugs()
  backfillTicketNumbers()
}

/**
 * Generate slugs for any kins that have a NULL slug.
 * Called once at startup after schema is applied.
 */
function backfillSlugs() {
  const kinsWithoutSlug = sqlite.query<{ id: string; name: string }, []>(
    'SELECT id, name FROM kins WHERE slug IS NULL'
  ).all()

  if (kinsWithoutSlug.length === 0) return

  const existingSlugs = new Set(
    sqlite.query<{ slug: string }, []>(
      'SELECT slug FROM kins WHERE slug IS NOT NULL'
    ).all().map((r) => r.slug)
  )

  for (const kin of kinsWithoutSlug) {
    const baseSlug = generateSlug(kin.name)
    const slug = ensureUniqueSlug(baseSlug || 'kin', existingSlugs)
    existingSlugs.add(slug)
    sqlite.run('UPDATE kins SET slug = ? WHERE id = ?', [slug, kin.id])
  }

  log.info({ count: kinsWithoutSlug.length }, 'Backfilled slugs for existing kins')
}

/**
 * Backfill `projects.slug` for any project row that pre-dates migration 0060.
 * Slugs are derived from the title, clamped to the project regex (2-32 chars,
 * starts with a letter), and de-duplicated with `-2`, `-3` suffixes.
 */
function backfillProjectSlugs() {
  const rows = sqlite.query<{ id: string; title: string }, []>(
    'SELECT id, title FROM projects WHERE slug IS NULL OR slug = \'\''
  ).all()

  if (rows.length === 0) return

  const existing = new Set(
    sqlite.query<{ slug: string }, []>(
      'SELECT slug FROM projects WHERE slug IS NOT NULL AND slug != \'\''
    ).all().map((r) => r.slug),
  )

  // Project slugs are tighter than the kin slug rule (must start with a letter,
  // 2-32 chars). Normalize defensively: strip leading digits/hyphens, cap length.
  function normalize(raw: string): string {
    let s = (raw || '').replace(/^[^a-z]+/, '').replace(/-+$/, '')
    if (s.length < 2) s = 'project'
    if (s.length > 32) s = s.substring(0, 32).replace(/-+$/, '')
    return s
  }

  for (const row of rows) {
    const base = normalize(generateSlug(row.title))
    const slug = ensureUniqueSlug(base, existing)
    existing.add(slug)
    sqlite.run('UPDATE projects SET slug = ? WHERE id = ?', [slug, row.id])
  }

  log.info({ count: rows.length }, 'Backfilled slugs for existing projects')
}

/**
 * Backfill `tickets.number` for any ticket row that pre-dates migration 0060.
 * Numbers are assigned per project in `createdAt ASC` order, starting at 1 and
 * continuing past whatever max(number) already exists in the column (a previous
 * partial run, for instance).
 */
function backfillTicketNumbers() {
  // Group projects with at least one un-numbered ticket.
  const projectsWithGaps = sqlite.query<{ project_id: string }, []>(
    'SELECT DISTINCT project_id FROM tickets WHERE number IS NULL'
  ).all()

  if (projectsWithGaps.length === 0) return

  let totalAssigned = 0
  for (const { project_id: projectId } of projectsWithGaps) {
    const maxRow = sqlite.query<{ n: number | null }, [string]>(
      'SELECT MAX(number) as n FROM tickets WHERE project_id = ?'
    ).get(projectId)
    let next = (maxRow?.n ?? 0) + 1

    const ticketRows = sqlite.query<{ id: string }, [string]>(
      'SELECT id FROM tickets WHERE project_id = ? AND number IS NULL ORDER BY created_at ASC, id ASC'
    ).all(projectId)

    for (const t of ticketRows) {
      sqlite.run('UPDATE tickets SET number = ? WHERE id = ?', [next, t.id])
      next++
      totalAssigned++
    }
  }

  log.info(
    { count: totalAssigned, projects: projectsWithGaps.length },
    'Backfilled numbers for existing tickets',
  )
}
