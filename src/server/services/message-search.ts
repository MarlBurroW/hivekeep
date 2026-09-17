import type { Database } from 'bun:sqlite'

// Shared conversation only. Apply scope before counting or returning excerpts.
const scope = `agent_id = ? AND task_id IS NULL AND session_id IS NULL AND is_redacted = 0
  AND (metadata IS NULL OR json_valid(metadata) = 0 OR json_extract(metadata, '$.hidden') IS NOT 1)`
export interface SearchMessage { id: string; role: string; content: string; createdAt: number }
const fields = 'id, role, substr(content, 1, 8000) AS content, created_at AS createdAt'
export function searchConversation(database: Database, agentId: string, query: string, limit = 20, offset = 0) {
  const pattern = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`
  const where = `${scope} AND content LIKE ? ESCAPE '\\'`
  const rows = database.query(`SELECT ${fields} FROM messages WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(agentId, pattern, limit, offset) as SearchMessage[]
  const count = database.query(`SELECT count(*) AS total FROM messages WHERE ${where}`).get(agentId, pattern) as { total: number }
  return { messages: rows, total: count.total, hasMore: offset + rows.length < count.total }
}
export function conversationContext(database: Database, agentId: string, messageId: string): SearchMessage[] | null {
  const target = database.query(`SELECT rowid AS position, created_at AS createdAt FROM messages WHERE ${scope} AND id = ?`).get(agentId, messageId) as { position: number; createdAt: number } | null
  if (!target) return null
  const older = database.query(`SELECT ${fields} FROM messages WHERE ${scope} AND (created_at < ? OR (created_at = ? AND rowid <= ?)) ORDER BY created_at DESC, rowid DESC LIMIT 4`).all(agentId, target.createdAt, target.createdAt, target.position) as SearchMessage[]
  const newer = database.query(`SELECT ${fields} FROM messages WHERE ${scope} AND (created_at > ? OR (created_at = ? AND rowid > ?)) ORDER BY created_at, rowid LIMIT 3`).all(agentId, target.createdAt, target.createdAt, target.position) as SearchMessage[]
  return [...older.reverse(), ...newer]
}
