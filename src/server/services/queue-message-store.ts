import { eq } from 'drizzle-orm'
import { db, sqlite } from '@/server/db/index'
import { messages, queueItems } from '@/server/db/schema'

/** Commit the message and its queue receipt together. A process crash can leave
 * both absent or both present, never an unacknowledged duplicate user turn. */
export function persistQueuedMessage(itemId: string, message: typeof messages.$inferInsert): string {
  return sqlite.transaction(() => {
    const item = db.select({ messageId: queueItems.createdMessageId })
      .from(queueItems).where(eq(queueItems.id, itemId)).get()
    if (!item) throw new Error(`Queue item ${itemId} no longer exists`)
    if (item.messageId) return item.messageId

    db.insert(messages).values(message).run()
    db.update(queueItems).set({ createdMessageId: message.id })
      .where(eq(queueItems.id, itemId)).run()
    return message.id
  }).immediate()
}
