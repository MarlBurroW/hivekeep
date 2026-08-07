import { sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'

const log = createLogger('vector-maintenance')

/**
 * The sqlite-vec virtual tables (memories_vec, knowledge_chunks_vec) have no
 * FK or trigger sync with their base tables — every deletion path must remove
 * the vector rows explicitly, and any path that forgets leaves orphans that
 * occupy KNN slots forever (blinding duplicate detection and starving search
 * results). This module centralizes the removal plus a boot-time sweep that
 * repairs whatever slipped through (crashes between row and vector writes,
 * historical bulk deletes).
 */

function hasTable(name: string): boolean {
  return !!sqlite
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE name = ?")
    .get(name)
}

/** Delete vector rows by id, chunked to stay under the bound-parameter cap. */
export function deleteVectorRows(table: string, column: string, ids: string[]): void {
  if (ids.length === 0 || !hasTable(table)) return
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400)
    sqlite.run(`DELETE FROM ${table} WHERE ${column} IN (${chunk.map(() => '?').join(', ')})`, chunk)
  }
}

/**
 * Remove vector rows whose base row no longer exists. Called once at startup,
 * after migrations and virtual-table init.
 */
export function reconcileVectorTables(): void {
  const sweeps: Array<{ table: string; column: string; base: string }> = [
    { table: 'memories_vec', column: 'memory_id', base: 'memories' },
    { table: 'knowledge_chunks_vec', column: 'chunk_id', base: 'knowledge_chunks' },
  ]
  for (const { table, column, base } of sweeps) {
    if (!hasTable(table) || !hasTable(base)) continue
    try {
      const orphans = sqlite
        .query<{ id: string }, []>(
          `SELECT ${column} AS id FROM ${table} WHERE ${column} NOT IN (SELECT id FROM ${base})`,
        )
        .all()
        .map((r) => r.id)
      if (orphans.length > 0) {
        deleteVectorRows(table, column, orphans)
        log.info({ table, removed: orphans.length }, 'Removed orphaned vector rows')
      }
    } catch (err) {
      log.warn({ table, err }, 'Vector reconciliation sweep failed')
    }
  }
}
