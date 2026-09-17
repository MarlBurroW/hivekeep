import { inArray } from 'drizzle-orm'
import { db } from '@/server/db'
import { files } from '@/server/db/schema'

/** User sends may consume their own unsent uploads, never relink another
 * conversation's attachment or publish a file from a private session. */
export function canAttachFiles(fileIds: string[], userId: string, agentId: string, sessionId?: string): boolean {
  if (!fileIds.length) return true
  if (fileIds.length > 10 || fileIds.some((id) => typeof id !== 'string')) return false
  const rows = db.select().from(files).where(inArray(files.id, fileIds)).all()
  return new Set(fileIds).size === rows.length && rows.every((file) =>
    file.agentId === agentId && file.uploadedBy === userId && !file.messageId &&
    (!file.sessionId || file.sessionId === sessionId),
  )
}
