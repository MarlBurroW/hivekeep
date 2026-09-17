import { eq, and, lt } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { quickSessions, messages, files } from '@/server/db/schema'
import { deleteMessagesCascade } from '@/server/services/message-deletion'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'

const log = createLogger('quick-session-cleanup')

let cleanupInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start the periodic cleanup job for quick sessions.
 * - Closes sessions that have expired (expiresAt < now)
 * - Deletes closed sessions older than retentionDays
 *   (messages cascade-deleted via FK)
 */
export function startQuickSessionCleanup() {
  if (cleanupInterval) return

  const intervalMs = config.quickSessions.cleanupIntervalMinutes * 60 * 1000

  cleanupInterval = setInterval(async () => {
    try {
      const now = new Date()

      // 1. Close expired sessions
      const expired = await db
        .select({ id: quickSessions.id, agentId: quickSessions.agentId })
        .from(quickSessions)
        .where(and(
          eq(quickSessions.status, 'active'),
          lt(quickSessions.expiresAt, now),
        ))
        .all()

      if (expired.length > 0) {
        for (const s of expired) {
          await db.update(quickSessions).set({
            status: 'closed',
            closedAt: now,
          }).where(eq(quickSessions.id, s.id))

          // Notify connected clients so the UI updates
          sseManager.sendToAgent(s.agentId, {
            type: 'quick-session:closed',
            agentId: s.agentId,
            data: { sessionId: s.id },
          })
        }
        log.info({ count: expired.length }, 'Closed expired quick sessions')
      }

      // 2. Delete closed sessions older than retentionDays
      const cutoff = new Date(now.getTime() - config.quickSessions.retentionDays * 24 * 60 * 60 * 1000)
      const stale = await db
        .select({ id: quickSessions.id, agentId: quickSessions.agentId })
        .from(quickSessions)
        .where(and(
          eq(quickSessions.status, 'closed'),
          lt(quickSessions.closedAt, cutoff),
        ))
        .all()

      if (stale.length > 0) {
        for (const session of stale) {
          const rows = db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, session.id)).all()
          await deleteMessagesCascade(session.agentId, rows.map((row) => row.id))
          // Generated artifacts may not be attached to a message; their explicit
          // session scope still makes them eligible for the same retention.
          const orphanFiles = db.select().from(files).where(eq(files.sessionId, session.id)).all()
          await db.delete(files).where(eq(files.sessionId, session.id))
          for (const file of orphanFiles) await Bun.file(file.storedPath).delete().catch(() => {})
          await db.delete(quickSessions).where(eq(quickSessions.id, session.id))
        }
        log.info({ count: stale.length }, 'Deleted stale quick sessions')
      }
    } catch (err) {
      log.error({ err }, 'Quick session cleanup error')
    }
  }, intervalMs)

  log.info({ intervalMinutes: config.quickSessions.cleanupIntervalMinutes }, 'Quick session cleanup started')
}

export function stopQuickSessionCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
}
