import { eq, and, desc, asc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { queueItems } from '@/server/db/schema'
import { config } from '@/server/config'
import { sseManager } from '@/server/sse/index'

const log = createLogger('queue')

/** In-memory sideband for file IDs attached to queue items (single-process, lost on restart — files stay orphaned but harmless) */
const queueFileIds = new Map<string, string[]>()

/**
 * In-memory sideband for the client-generated reconciliation token attached to
 * a queue item. Echoed back over SSE (chat:message) when the user message is
 * persisted, so the originating web client can match the broadcast to its own
 * optimistic bubble (and other devices simply append it). This is NOT the
 * message primary key. Single-process, lost on restart (harmless — on a
 * restart the originating optimistic bubble is gone anyway).
 */
const queueClientMessageId = new Map<string, string>()

/**
 * In-memory sideband for free-form structured metadata attached to queue items
 * (e.g. channel adapter context like modality, presence, channel info).
 * Read once by the agent-engine when persisting the user message and merged
 * into messages.metadata. Single-process, lost on restart.
 */
const queueMessageMetadata = new Map<string, Record<string, unknown>>()

export function popQueueMessageMetadata(itemId: string): Record<string, unknown> | undefined {
  const meta = queueMessageMetadata.get(itemId)
  if (meta) queueMessageMetadata.delete(itemId)
  return meta
}

export interface EnqueueParams {
  agentId: string
  messageType: string
  content: string
  sourceType: string
  sourceId?: string
  priority?: number
  requestId?: string
  inReplyTo?: string
  taskId?: string
  sessionId?: string
  /** Uploaded file IDs to link to the message once it's created */
  fileIds?: string[]
  /**
   * Client-generated reconciliation token (NOT the message PK). Echoed back
   * over the chat:message SSE so the originating web client can reconcile its
   * optimistic bubble with the persisted message, while other devices append it.
   */
  clientMessageId?: string
  /** Optional pre-generated ID (used by channel origin to self-reference) */
  id?: string
  /** ID of the originating channel queue item (causal chain tracking) */
  channelOriginId?: string
  /**
   * Free-form structured metadata to attach to the user message once persisted.
   * Used by channel adapters / plugins to pass context to the LLM (modality,
   * presence, channel info...). Stored in messages.metadata under the
   * `channel` key (or merged with other reserved keys).
   */
  messageMetadata?: Record<string, unknown>
}

/**
 * Enqueue a message for an Agent. Returns the queue item ID and position.
 */
export async function enqueueMessage(params: EnqueueParams) {
  const id = params.id ?? uuid()
  const priority = params.priority ?? (params.sourceType === 'user' ? config.queue.userPriority : config.queue.agentPriority)

  await db.insert(queueItems).values({
    id,
    agentId: params.agentId,
    messageType: params.messageType,
    content: params.content,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
    priority,
    requestId: params.requestId,
    inReplyTo: params.inReplyTo,
    taskId: params.taskId,
    sessionId: params.sessionId,
    channelOriginId: params.channelOriginId ?? null,
    status: 'pending',
    createdAt: new Date(),
  })

  // Compute queue position
  const pending = await db
    .select()
    .from(queueItems)
    .where(and(eq(queueItems.agentId, params.agentId), eq(queueItems.status, 'pending')))
    .all()

  const queuePosition = pending.length

  // Emit queue update via SSE. Reflect the REAL processing state: a message
  // enqueued WHILE the Agent is mid-turn must not report isProcessing:false —
  // that clobbers the client's queue state and makes the live thinking bubble
  // disappear until a manual refresh. Scope to the message's lane (quick
  // session vs main thread) so each reflects its own processing status.
  const processing = await isAgentProcessing(params.agentId, params.sessionId ? 'quick' : 'main')
  sseManager.sendToAgent(params.agentId, {
    type: 'queue:update',
    agentId: params.agentId,
    data: { agentId: params.agentId, queueSize: queuePosition, isProcessing: processing },
  })

  // Store file IDs in sideband map for later retrieval by agent-engine
  if (params.fileIds && params.fileIds.length > 0) {
    queueFileIds.set(id, params.fileIds)
  }

  // Store the client reconciliation token in sideband for later echo over SSE
  if (params.clientMessageId) {
    queueClientMessageId.set(id, params.clientMessageId)
  }

  // Store free-form message metadata in sideband for later retrieval by agent-engine
  if (params.messageMetadata && Object.keys(params.messageMetadata).length > 0) {
    queueMessageMetadata.set(id, params.messageMetadata)
  }

  log.debug({ agentId: params.agentId, itemId: id, messageType: params.messageType, sourceType: params.sourceType, queuePosition }, 'Message enqueued')

  return { id, queuePosition }
}

/**
 * Dequeue the next message for an Agent. Returns null if the queue is empty.
 * Messages are ordered by priority (DESC) then creation time (ASC).
 *
 * Uses a single atomic UPDATE ... RETURNING * to prevent race conditions:
 * no two callers can grab the same item, even without external locks.
 *
 * @param mode - 'main' filters for session_id IS NULL (main session + tasks),
 *               'quick' filters for session_id IS NOT NULL (quick sessions).
 */
export async function dequeueMessage(agentId: string, mode: 'main' | 'quick' = 'main') {
  const sessionFilter = mode === 'main'
    ? 'AND session_id IS NULL'
    : 'AND session_id IS NOT NULL'

  const row = sqlite.query<{
    id: string
    agent_id: string
    message_type: string
    content: string
    source_type: string
    source_id: string | null
    priority: number
    request_id: string | null
    in_reply_to: string | null
    task_id: string | null
    session_id: string | null
    channel_origin_id: string | null
    status: string
    created_message_id: string | null
    created_at: number
    processed_at: number | null
  }, [number, string]>(`
    UPDATE queue_items
    SET status = 'processing', processing_started_at = ?
    WHERE id = (
      SELECT id FROM queue_items
      WHERE agent_id = ? AND status = 'pending' ${sessionFilter}
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    )
    RETURNING *
  `).get(Date.now(), agentId)

  if (!row) return null

  // Pop file IDs from sideband map (one-shot — consumed on dequeue)
  const fileIds = queueFileIds.get(row.id)
  if (fileIds) queueFileIds.delete(row.id)

  // Pop client reconciliation token from sideband (one-shot — consumed on dequeue)
  const clientMessageId = queueClientMessageId.get(row.id)
  if (clientMessageId) queueClientMessageId.delete(row.id)

  return {
    id: row.id,
    agentId: row.agent_id,
    messageType: row.message_type,
    content: row.content,
    sourceType: row.source_type,
    sourceId: row.source_id,
    priority: row.priority,
    requestId: row.request_id,
    inReplyTo: row.in_reply_to,
    taskId: row.task_id,
    sessionId: row.session_id,
    channelOriginId: row.channel_origin_id,
    status: row.status,
    createdMessageId: row.created_message_id,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : null,
    fileIds: fileIds ?? null,
    clientMessageId: clientMessageId ?? null,
  }
}

/**
 * Mark a queue item as done.
 */
/** Purge processed queue items older than `olderThanMs`. Done rows are only
 *  useful for short-term inspection; without a purge they accumulate forever
 *  and every scan of the table degrades with total history. */
export function purgeDoneQueueItems(olderThanMs: number): number {
  const result = sqlite.run(
    `DELETE FROM queue_items WHERE status = 'done' AND processed_at < ?`,
    [Date.now() - olderThanMs],
  )
  return result.changes ?? 0
}

export async function markQueueItemDone(itemId: string) {
  await db
    .update(queueItems)
    .set({ status: 'done', processedAt: new Date() })
    .where(eq(queueItems.id, itemId))
}

/**
 * Check if an Agent is currently processing a message.
 * @param mode - 'main' checks only main/task items, 'quick' checks only quick session items.
 */
export async function isAgentProcessing(agentId: string, mode: 'main' | 'quick' = 'main'): Promise<boolean> {
  const sessionFilter = mode === 'main'
    ? 'AND session_id IS NULL'
    : 'AND session_id IS NOT NULL'

  const row = sqlite.query<{ id: string }, [string]>(
    `SELECT id FROM queue_items WHERE agent_id = ? AND status = 'processing' ${sessionFilter} LIMIT 1`,
  ).get(agentId)

  return !!row
}

/**
 * Get the queue size for an Agent.
 */
export async function getQueueSize(agentId: string): Promise<number> {
  const pending = await db
    .select()
    .from(queueItems)
    .where(and(eq(queueItems.agentId, agentId), eq(queueItems.status, 'pending')))
    .all()

  return pending.length
}

/**
 * List pending queue items for an Agent (ordered by priority DESC, creation time ASC).
 */
export async function getPendingQueueItems(agentId: string) {
  const rows = await db
    .select()
    .from(queueItems)
    .where(and(eq(queueItems.agentId, agentId), eq(queueItems.status, 'pending')))
    .orderBy(desc(queueItems.priority), asc(queueItems.createdAt))
    .all()

  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    messageType: r.messageType,
    content: r.content,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    priority: r.priority,
    createdAt: r.createdAt,
  }))
}

/**
 * Remove a pending queue item. Returns true if removed, false if not found or not pending.
 */
export async function removeQueueItem(agentId: string, itemId: string): Promise<boolean> {
  const result = sqlite.run(
    `DELETE FROM queue_items WHERE id = ? AND agent_id = ? AND status = 'pending'`,
    [itemId, agentId],
  )

  if (result.changes > 0) {
    // Clean up ALL sideband maps — leaving the other two behind leaked one
    // entry per removed item for the life of the process.
    queueFileIds.delete(itemId)
    queueClientMessageId.delete(itemId)
    queueMessageMetadata.delete(itemId)

    // Emit updated queue state
    const size = await getQueueSize(agentId)
    const processing = await isAgentProcessing(agentId)
    sseManager.sendToAgent(agentId, {
      type: 'queue:update',
      agentId,
      data: { agentId, queueSize: size, isProcessing: processing },
    })

    log.debug({ agentId, itemId }, 'Queue item removed')
    return true
  }

  return false
}

/**
 * Recover orphaned queue items stuck in 'processing' status.
 * This can happen after a crash or restart. Called once at worker startup.
 * Resets them to 'pending' so they get re-processed.
 */
export function recoverStaleProcessingItems() {
  const result = sqlite.run(
    `UPDATE queue_items SET status = 'pending' WHERE status = 'processing'`,
  )
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'Recovered stale processing queue items → reset to pending')
  }
}

/** Reset one Agent's in-flight items so its queue can move again. Used by the
 *  operator force-reset; scoped to the Agent, unlike the boot-wide recovery. */
export function requeueProcessingItems(agentId: string): number {
  const result = sqlite.run(
    `UPDATE queue_items SET status = 'pending' WHERE status = 'processing' AND agent_id = ?`,
    [agentId],
  )
  return result.changes ?? 0
}

/** Queue items that have been 'processing' for longer than `olderThanMs`.
 *  Age is measured from processing_started_at (set at dequeue) — measuring
 *  from created_at classified healthy turns as stuck the moment they started,
 *  whenever the item had waited a long time in a deep queue, and then
 *  requeued them under a live turn on every sweep. created_at only serves as
 *  a fallback for items dequeued before the column existed. */
export function findStuckProcessingItems(olderThanMs: number): Array<{ id: string; agentId: string; ageMs: number }> {
  const now = Date.now()
  const rows = sqlite
    .query(
      `SELECT id, agent_id as agentId, COALESCE(processing_started_at, created_at) as startedAt
       FROM queue_items
       WHERE status = 'processing' AND COALESCE(processing_started_at, created_at) < ?`,
    )
    .all(now - olderThanMs) as unknown as Array<{ id: string; agentId: string; startedAt: number }>
  return rows.map((r) => ({ id: r.id, agentId: r.agentId, ageMs: now - r.startedAt }))
}
