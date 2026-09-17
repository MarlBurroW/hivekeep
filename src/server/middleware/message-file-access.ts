import type { MiddlewareHandler } from 'hono'
import { eq } from 'drizzle-orm'
import { basename } from 'node:path'
import { db } from '@/server/db'
import { files, messages, quickSessions } from '@/server/db/schema'
import type { AppVariables } from '@/server/app'

/** Authorize attachments before the static handler. Unsent uploads are personal;
 * sent shared files remain shared; private files stay scoped even after close. */
export const requireMessageFileAccess: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  let pathname: string
  try { pathname = decodeURIComponent(new URL(c.req.url).pathname) } catch { return c.notFound() }
  if (!pathname.startsWith('/api/uploads/messages/')) return next()
  const parts = pathname.slice('/api/uploads/messages/'.length).split('/')
  if (parts.length !== 2) return c.notFound()
  const [agentId, filename] = parts
  const id = filename?.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[.-]|$)/i)?.[1]
  if (!id) return c.notFound()
  const row = db.select().from(files).where(eq(files.id, id)).get()
  if (!row || row.agentId !== agentId || basename(row.storedPath) !== filename) return c.notFound()
  const user = c.get('user') as { id: string } | undefined
  if (!user) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401)
  const message = row.messageId ? db.select({ sessionId: messages.sessionId }).from(messages).where(eq(messages.id, row.messageId)).get() : null
  const sessionId = row.sessionId ?? message?.sessionId
  if (sessionId) {
    const owner = db.select({ createdBy: quickSessions.createdBy }).from(quickSessions).where(eq(quickSessions.id, sessionId)).get()
    if (owner?.createdBy !== user.id) return c.notFound()
  } else if (!row.messageId && row.uploadedBy && row.uploadedBy !== 'channel' && row.uploadedBy !== user.id) {
    return c.notFound()
  }
  c.header('Cache-Control', 'private, no-store')
  return next()
}
