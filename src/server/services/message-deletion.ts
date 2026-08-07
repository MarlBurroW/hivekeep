/**
 * Selective message deletion — the cascade behind "delete this message" and
 * "rewind to here" (routes/messages.ts).
 *
 * Cascade-deletes a set of conversation messages: cleans every reference that
 * isn't ON DELETE CASCADE (FKs are enforced — PRAGMA foreign_keys=ON), keeps
 * the compacting summaries' timestamp cutoff intact, then deletes the rows.
 *
 * Reference handling:
 * - files            → row deleted + file on disk (the message anchor is gone)
 * - human_prompts    → messageId nullified
 * - memories         → sourceMessageId nullified (the memory itself survives)
 * - reactions/links  → ON DELETE CASCADE (automatic)
 * - compacting_snapshots.messagesUpToId in ids → snapshot row deleted
 * - compacting_summaries: firstMessageId in ids → nullified; lastMessageId in
 *   ids → repointed to the latest surviving message ≤ its lastMessageAt (the
 *   timestamp cutoff the engine actually uses stays untouched), else the
 *   summary row is deleted.
 */
import { eq, and, isNull, lte, desc, inArray } from 'drizzle-orm'
import { db, sqlite } from '@/server/db/index'
import {
  messages,
  files,
  humanPrompts,
  memories as agentMemories,
  compactingSnapshots,
  compactingSummaries,
} from '@/server/db/schema'

export async function deleteMessagesCascade(agentId: string, allIds: string[]): Promise<void> {
  if (allIds.length === 0) return
  const idSet = new Set(allIds)
  // Chunk every IN (...) statement: a rewind on a long conversation can target
  // thousands of rows, and SQLite caps bound parameters per statement.
  const chunks: string[][] = []
  for (let i = 0; i < allIds.length; i += 500) chunks.push(allIds.slice(i, i + 500))

  // 1. Compute summary-boundary repairs FIRST, across the FULL id set —
  //    repairing per-chunk could repoint a boundary onto a message a later
  //    chunk deletes. Reads only; the writes land in the transaction below.
  const repairs: Array<{ summaryId: string; replacement: string | null }> = []
  const boundary: Array<{ id: string; lastMessageAt: Date }> = []
  for (const ids of chunks) {
    const rows = await db
      .select({ id: compactingSummaries.id, lastMessageAt: compactingSummaries.lastMessageAt })
      .from(compactingSummaries)
      .where(and(eq(compactingSummaries.agentId, agentId), inArray(compactingSummaries.lastMessageId, ids)))
    boundary.push(...rows)
  }
  for (const s of boundary) {
    // Page newest-first through candidates ≤ the summary's cutoff until we find
    // one that survives the deletion (JS-side scan avoids a NOT IN over the
    // full — possibly huge — id set).
    let replacement: string | null = null
    for (let offset = 0; replacement === null; offset += 200) {
      const candidates = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(
          eq(messages.agentId, agentId),
          isNull(messages.taskId),
          isNull(messages.sessionId),
          lte(messages.createdAt, s.lastMessageAt),
        ))
        .orderBy(desc(messages.createdAt))
        .limit(200)
        .offset(offset)
        .all()
      if (candidates.length === 0) break
      replacement = candidates.find((m) => !idSet.has(m.id))?.id ?? null
    }
    repairs.push({ summaryId: s.id, replacement })
  }

  // 2. Gather the attached files (rows + disk paths) before any write.
  const attached: Array<{ id: string; storedPath: string }> = []
  for (const ids of chunks) {
    const rows = await db
      .select({ id: files.id, storedPath: files.storedPath })
      .from(files)
      .where(and(eq(files.agentId, agentId), inArray(files.messageId, ids)))
    attached.push(...rows)
  }

  // 3. Every row mutation in ONE transaction. A crash mid-cascade used to
  //    produce a timeline that never existed (later chunks deleted, earlier
  //    ones kept) or a destroyed summary whose messages survived.
  const txn = sqlite.transaction(() => {
    for (const r of repairs) {
      if (r.replacement) {
        db.update(compactingSummaries).set({ lastMessageId: r.replacement }).where(eq(compactingSummaries.id, r.summaryId)).run()
      } else {
        db.delete(compactingSummaries).where(eq(compactingSummaries.id, r.summaryId)).run()
      }
    }
    if (attached.length > 0) {
      for (let i = 0; i < attached.length; i += 500) {
        db.delete(files).where(inArray(files.id, attached.slice(i, i + 500).map((f) => f.id))).run()
      }
    }
    for (const ids of chunks) {
      db.update(humanPrompts).set({ messageId: null }).where(inArray(humanPrompts.messageId, ids)).run()
      db.update(agentMemories).set({ sourceMessageId: null }).where(inArray(agentMemories.sourceMessageId, ids)).run()
      db.delete(compactingSnapshots).where(inArray(compactingSnapshots.messagesUpToId, ids)).run()
      db.update(compactingSummaries)
        .set({ firstMessageId: null })
        .where(and(eq(compactingSummaries.agentId, agentId), inArray(compactingSummaries.firstMessageId, ids)))
        .run()
      db.delete(messages).where(and(eq(messages.agentId, agentId), inArray(messages.id, ids))).run()
    }
  })
  txn()

  // 4. Disk cleanup after commit — an orphan file on disk beats a dangling
  //    DB row pointing at a deleted file.
  if (attached.length > 0) {
    const { unlink } = await import('fs/promises')
    for (const f of attached) {
      try { await unlink(f.storedPath) } catch { /* already gone */ }
    }
  }
}
