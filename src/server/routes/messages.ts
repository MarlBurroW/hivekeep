import { Hono } from 'hono'
import { eq, and, isNull, gt, desc, inArray, sql } from 'drizzle-orm'
import { db, sqlite } from '@/server/db/index'
import { messages, agents, channels, channelMessageLinks, compactingSnapshots, compactingSummaries, memories as agentMemories, files, humanPrompts, messageReactions } from '@/server/db/schema'
import { enqueueMessage, getPendingQueueItems, removeQueueItem, isAgentProcessing } from '@/server/services/queue'
import { deleteMessagesCascade } from '@/server/services/message-deletion'
import { abortAgentStream, getActiveAgentStreamSnapshot } from '@/server/services/agent-engine'
import { sseManager } from '@/server/sse/index'
import { getFilesForMessages, serializeFile } from '@/server/services/files'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { parseMentions, notifyMentionedUsers } from '@/server/services/mentions'
import { channelAdapters } from '@/server/channels/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { MAX_MESSAGE_LENGTH } from '@/shared/constants'

const log = createLogger('routes:messages')
const messageRoutes = new Hono<{ Variables: AppVariables }>()

// POST /api/agents/:agentId/messages — send a message to an agent (accepts UUID or slug)
messageRoutes.post('/', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const user = c.get('user') as { id: string; name: string }
  const body = await c.req.json()
  const { content, fileIds, clientMessageId } = body as { content: string; fileIds?: string[]; clientMessageId?: string }
  const hasFiles = fileIds && fileIds.length > 0
  // Reconciliation token echoed back over SSE (not the message PK) — accept it
  // only when it's a sane short string to avoid arbitrary passthrough.
  const reconcileToken = typeof clientMessageId === 'string' && clientMessageId.length > 0 && clientMessageId.length <= 100
    ? clientMessageId
    : undefined

  if (!content?.trim() && !hasFiles) {
    return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content or files required' } }, 400)
  }

  if (content && content.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: { code: 'MESSAGE_TOO_LONG', message: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` } }, 400)
  }

  // Enqueue the message (clean content — pseudonym prefix is added by agent-engine for LLM context)
  // fileIds are passed through the queue and linked to the actual message in agent-engine
  const { id, queuePosition } = await enqueueMessage({
    agentId,
    messageType: 'user',
    content: content ?? '',
    sourceType: 'user',
    sourceId: user.id,
    fileIds: hasFiles ? fileIds : undefined,
    clientMessageId: reconcileToken,
  })

  log.debug({ agentId, messageId: id, contentLength: content?.length ?? 0, fileCount: fileIds?.length ?? 0 }, 'Message enqueued')

  // Fire-and-forget: parse @mentions and notify mentioned users
  if (content) {
    parseMentions(content).then((mentions) => {
      if (mentions.length > 0) {
        notifyMentionedUsers(mentions, agentId, id, user.name).catch(() => {})
      }
    }).catch(() => {})
  }

  return c.json({ messageId: id, queuePosition }, 202)
})

// GET /api/agents/:agentId/messages — get message history (accepts UUID or slug)
messageRoutes.get('/', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const before = c.req.query('before')
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 100)

  // Resolve the cursor message to (created_at, rowid). Message ids are random
  // UUIDs, so the old `id < before` cursor had no relation to time: paging up
  // duplicated the newest page and permanently skipped part of the history.
  let cursor: { createdAt: number; rowid: number } | null = null
  if (before) {
    const row = sqlite
      .query<{ created_at: number; rowid: number }, [string]>('SELECT created_at, rowid FROM messages WHERE id = ?')
      .get(before)
    if (!row) {
      return c.json({ error: { code: 'INVALID_CURSOR', message: 'Unknown `before` message id' } }, 400)
    }
    cursor = { createdAt: row.created_at, rowid: row.rowid }
  }

  const conditions = [eq(messages.agentId, agentId), isNull(messages.taskId), isNull(messages.sessionId)]
  if (cursor) {
    conditions.push(
      sql`(${messages.createdAt} < ${cursor.createdAt} OR (${messages.createdAt} = ${cursor.createdAt} AND rowid < ${cursor.rowid}))`,
    )
  }

  const rawResult = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(sql`rowid`))
    .limit(limit + 1) // +1 to check hasMore
    .all()

  // hasMore is computed on the RAW window: filtering hidden rows first made
  // hasMore false whenever a hidden message fell inside the window, stalling
  // infinite scroll with older history still unreachable.
  const hasMore = rawResult.length > limit
  const windowRows = hasMore ? rawResult.slice(0, limit) : rawResult
  // Drop messages flagged hidden (e.g. the onboarding kickoff trigger) — they
  // exist only to drive an LLM turn and must never render in the chat.
  const messageList = windowRows.filter((m) => {
    if (!m.metadata) return true
    try { return (JSON.parse(m.metadata as string) as { hidden?: boolean }).hidden !== true } catch { return true }
  })

  // Reverse for chronological order
  messageList.reverse()

  // Fetch files and reactions for all messages
  const messageIds = messageList.map((m) => m.id)
  const fileMap = await getFilesForMessages(messageIds)

  // Fetch reactions for all messages
  const reactionMap = new Map<string, Array<{ id: string; userId: string; emoji: string; createdAt: Date }>>()
  if (messageIds.length > 0) {
    const allReactions = await db
      .select()
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, messageIds))
      .all()
    for (const r of allReactions) {
      const arr = reactionMap.get(r.messageId) ?? []
      arr.push({ id: r.id, userId: r.userId, emoji: r.emoji, createdAt: r.createdAt })
      reactionMap.set(r.messageId, arr)
    }
  }

  // Resolve source agent info for inter-agent and task messages
  const agentSourceIds = [
    ...new Set(
      messageList
        .filter((m) => (m.sourceType === 'agent' || m.sourceType === 'task') && m.sourceId)
        .map((m) => m.sourceId!),
    ),
  ]
  const agentInfoMap = new Map<string, { name: string; avatarUrl: string | null }>()
  if (agentSourceIds.length > 0) {
    const sourceAgents = await db
      .select({ id: agents.id, name: agents.name, avatarPath: agents.avatarPath })
      .from(agents)
      .where(inArray(agents.id, agentSourceIds))
      .all()
    for (const k of sourceAgents) {
      const ext = k.avatarPath?.split('.').pop() ?? 'png'
      agentInfoMap.set(k.id, {
        name: k.name,
        avatarUrl: k.avatarPath ? `/api/uploads/agents/${k.id}/avatar.${ext}` : null,
      })
    }
  }

  // ─── Channel metadata enrichment ─────────────────────────────────────────
  // For each message that transited through a channel (inbound user OR outbound
  // agent), look up the platform + adapter brand color so the UI can render the
  // bubble with a brand-colored accent and the adapter-supplied context line.
  // Inbound: messages.sourceType === 'channel' && sourceId === channelId.
  // Outbound: linked via channel_message_links.direction === 'outbound'.
  const platformByMessageId = new Map<string, string>()

  // Inbound: sourceId points to the channel for sourceType='channel'
  const inboundChannelIds = [
    ...new Set(
      messageList
        .filter((m) => m.sourceType === 'channel' && m.sourceId)
        .map((m) => m.sourceId!),
    ),
  ]
  const channelPlatformById = new Map<string, string>()
  if (inboundChannelIds.length > 0) {
    const rows = await db
      .select({ id: channels.id, platform: channels.platform })
      .from(channels)
      .where(inArray(channels.id, inboundChannelIds))
      .all()
    for (const r of rows) channelPlatformById.set(r.id, r.platform)
    for (const m of messageList) {
      if (m.sourceType === 'channel' && m.sourceId) {
        const p = channelPlatformById.get(m.sourceId)
        if (p) platformByMessageId.set(m.id, p)
      }
    }
  }

  // Outbound: join channel_message_links → channels for assistant messages
  if (messageIds.length > 0) {
    const links = await db
      .select({
        messageId: channelMessageLinks.messageId,
        platform: channels.platform,
      })
      .from(channelMessageLinks)
      .innerJoin(channels, eq(channelMessageLinks.channelId, channels.id))
      .where(and(inArray(channelMessageLinks.messageId, messageIds), eq(channelMessageLinks.direction, 'outbound')))
      .all()
    for (const link of links) {
      // messageId is nullable (proactive cross-Agent sends have no assistant row).
      if (link.messageId && !platformByMessageId.has(link.messageId)) {
        platformByMessageId.set(link.messageId, link.platform)
      }
    }
  }

  // Resolve adapter meta (displayName, brandColor) once per platform
  const platformMetaCache = new Map<string, { platform: string; displayName: string; brandColor: string | null }>()
  function getPlatformMeta(platform: string) {
    if (platformMetaCache.has(platform)) return platformMetaCache.get(platform)!
    const adapter = channelAdapters.get(platform)
    const meta = {
      platform,
      displayName: adapter?.meta?.displayName ?? platform,
      brandColor: adapter?.meta?.brandColor ?? null,
    }
    platformMetaCache.set(platform, meta)
    return meta
  }

  // ─── Transfer system-event enrichment ────────────────────────────────────
  // For channel_transferred_in/out audit rows, surface a fully-resolved
  // `systemEvent` blob with the OTHER Agent's name + avatar and the channel's
  // current platform meta, so MessageBubble can render the dedicated cards
  // without an extra round trip.
  const transferOtherAgentIds = new Set<string>()
  const transferChannelIds = new Set<string>()
  const transferMetaByMessageId = new Map<string, Record<string, unknown>>()
  for (const m of messageList) {
    if (!m.metadata) continue
    try {
      const meta = JSON.parse(m.metadata as string)
      const ev = meta?.systemEvent
      if (ev !== 'channel_transferred_out' && ev !== 'channel_transferred_in') continue
      transferMetaByMessageId.set(m.id, meta as Record<string, unknown>)
      const otherAgentId = (ev === 'channel_transferred_out' ? meta.targetAgentId : meta.fromAgentId) as string | undefined
      if (otherAgentId) transferOtherAgentIds.add(otherAgentId)
      if (typeof meta.channelId === 'string') transferChannelIds.add(meta.channelId)
    } catch { /* corrupted, skip */ }
  }

  const transferAgentInfoMap = new Map<string, { id: string; slug: string | null; name: string; avatarUrl: string | null }>()
  if (transferOtherAgentIds.size > 0) {
    const rows = await db
      .select({ id: agents.id, slug: agents.slug, name: agents.name, avatarPath: agents.avatarPath })
      .from(agents)
      .where(inArray(agents.id, Array.from(transferOtherAgentIds)))
      .all()
    for (const k of rows) {
      const ext = k.avatarPath?.split('.').pop() ?? 'png'
      transferAgentInfoMap.set(k.id, {
        id: k.id,
        slug: k.slug ?? null,
        name: k.name,
        avatarUrl: k.avatarPath ? `/api/uploads/agents/${k.id}/avatar.${ext}` : null,
      })
    }
  }

  const transferChannelPlatformMap = new Map<string, string>()
  if (transferChannelIds.size > 0) {
    const rows = await db
      .select({ id: channels.id, platform: channels.platform })
      .from(channels)
      .where(inArray(channels.id, Array.from(transferChannelIds)))
      .all()
    for (const r of rows) transferChannelPlatformMap.set(r.id, r.platform)
  }

  // If a stream is currently in-flight on this Agent's main thread, expose the
  // live snapshot so a client mounting mid-stream can seed its streaming
  // bubble immediately instead of staring at a typing indicator until
  // `chat:done` fires. Same pattern as `getActiveTaskSnapshot()` for tasks.
  // Note: unlike sub-task streams, the main-thread row is only inserted at
  // the END of the turn, so the streaming messageId is NEVER in `messageList`
  // and never needs to be overlay-merged with a persisted row.
  // Skipped on paginated (?before=) queries — they fetch older history and
  // the in-flight bubble (if any) belongs to the initial-fetch caller.
  const streamSnapshot = !before ? getActiveAgentStreamSnapshot(agentId) : undefined
  const streamingMessage = streamSnapshot
    ? {
        messageId: streamSnapshot.messageId,
        content: streamSnapshot.content,
        reasoning: streamSnapshot.reasoning.length > 0 ? streamSnapshot.reasoning : null,
        toolCalls: streamSnapshot.toolCalls.length > 0 ? streamSnapshot.toolCalls : null,
        outputTokens: streamSnapshot.outputTokens,
        sourceName: streamSnapshot.sourceName,
        sourceAvatarUrl: streamSnapshot.sourceAvatarUrl,
        startedAt: streamSnapshot.startedAt,
      }
    : null

  return c.json({
    streamingMessage,
    messages: messageList.map((m) => {
      const agentInfo = (m.sourceType === 'agent' || m.sourceType === 'task') && m.sourceId ? agentInfoMap.get(m.sourceId) : null
      let meta: Record<string, unknown> | null = null
      let toolCalls: unknown = null
      let reasoning: unknown = null
      try { meta = m.metadata ? JSON.parse(m.metadata as string) : null } catch { /* corrupted metadata */ }
      try { toolCalls = m.toolCalls ? JSON.parse(m.toolCalls as string) : null } catch { /* corrupted toolCalls */ }
      try { reasoning = m.reasoning ? JSON.parse(m.reasoning as string) : null } catch { /* corrupted reasoning */ }

      // Channel context line: inbound was persisted at top-level
      // (channelContextLine); outbound under channelDelivery.contextLine.
      const channelDelivery = meta?.channelDelivery as { contextLine?: string } | undefined
      const channelContextLine = (meta?.channelContextLine as string | undefined) ?? channelDelivery?.contextLine ?? null

      const platform = platformByMessageId.get(m.id) ?? null
      const channelMeta = platform ? getPlatformMeta(platform) : null

      // Resolve the transfer system-event blob (if any). The card needs the
      // OTHER Agent's name/slug/avatar, plus the channel's current platform
      // info so we can paint the platform icon next to the channel name.
      // For plugin-card system rows the pluginCard blob is self-contained
      // in metadata, so we just pass it through under the same systemEvent
      // field with a discriminating `type` so MessageBubble can route it.
      let systemEvent: Record<string, unknown> | null = null
      if (meta && (meta as Record<string, unknown>).systemEvent === 'plugin-card') {
        const pluginCard = (meta as Record<string, unknown>).pluginCard
        if (pluginCard && typeof pluginCard === 'object') {
          systemEvent = { type: 'plugin-card', pluginCard }
        }
      }
      const transferMeta = transferMetaByMessageId.get(m.id)
      if (transferMeta) {
        const evType = transferMeta.systemEvent as 'channel_transferred_out' | 'channel_transferred_in'
        const otherAgentId = (evType === 'channel_transferred_out' ? transferMeta.targetAgentId : transferMeta.fromAgentId) as string | undefined
        const otherAgentSlugInMeta = (evType === 'channel_transferred_out' ? transferMeta.targetAgentSlug : transferMeta.fromAgentSlug) as string | null | undefined
        const otherAgentNameInMeta = (evType === 'channel_transferred_out' ? transferMeta.targetAgentName : transferMeta.fromAgentName) as string | undefined
        const otherAgentInfo = otherAgentId ? transferAgentInfoMap.get(otherAgentId) : undefined
        const channelIdRef = transferMeta.channelId as string | undefined
        const channelPlatform = channelIdRef ? transferChannelPlatformMap.get(channelIdRef) ?? null : null
        const channelPlatformMeta = channelPlatform ? getPlatformMeta(channelPlatform) : null
        systemEvent = {
          type: evType,
          channelId: channelIdRef ?? null,
          channelName: (transferMeta.channelName as string | undefined) ?? null,
          channelPlatform,
          channelBrandColor: channelPlatformMeta?.brandColor ?? null,
          otherAgent: {
            // Prefer the row data (current) but fall back to whatever the
            // audit-trail snapshot recorded if the Agent row has since been
            // deleted.
            id: otherAgentId ?? null,
            slug: otherAgentInfo?.slug ?? otherAgentSlugInMeta ?? null,
            name: otherAgentInfo?.name ?? otherAgentNameInMeta ?? 'Unknown Agent',
            avatarUrl: otherAgentInfo?.avatarUrl ?? null,
          },
          reason: (transferMeta.reason as string | null | undefined) ?? null,
          at: (transferMeta.at as number | undefined) ?? null,
        }
      }

      return {
        id: m.id,
        role: m.role,
        content: m.content,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        sourceName: agentInfo?.name ?? null,
        sourceAvatarUrl: agentInfo?.avatarUrl ?? null,
        isRedacted: m.isRedacted,
        toolCalls,
        resolvedTaskId: meta?.resolvedTaskId ?? meta?.relatedTaskId ?? null,
        injectedMemories: meta?.injectedMemories ?? null,
        memoriesExtracted: meta?.memoriesExtracted ?? null,
        compactingError: meta?.error ?? null,
        stepLimitReached: meta?.stepLimitReached ?? false,
        emptyTurn: meta?.emptyTurn ?? false,
        finishReason: meta?.finishReason ?? null,
        silentStop: meta?.silentStop ?? false,
        tokenUsage: meta?.tokenUsage ?? null,
        reasoning,
        files: (fileMap.get(m.id) ?? []).map(serializeFile),
        reactions: reactionMap.get(m.id) ?? [],
        channelContextLine,
        channelMeta,
        systemEvent,
        createdAt: m.createdAt,
      }
    }),
    hasMore,
  })
})

// POST /api/agents/:agentId/messages/stop — stop an active LLM generation
messageRoutes.post('/stop', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const aborted = abortAgentStream(agentId)
  if (!aborted) {
    return c.json({ error: { code: 'NOT_STREAMING', message: 'No active generation to stop' } }, 409)
  }

  return c.json({ ok: true })
})

// POST /api/agents/:agentId/messages/inject — inject a message into the current streaming response (/btw)
messageRoutes.post('/inject', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const user = c.get('user') as { id: string; name: string }
  const body = await c.req.json()
  const { content, queueItemId } = body as { content: string; queueItemId?: string }

  if (!content?.trim()) {
    return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content required' } }, 400)
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: { code: 'MESSAGE_TOO_LONG', message: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` } }, 400)
  }

  // If promoting from queue, remove the original item
  if (queueItemId) {
    try { await removeQueueItem(agentId, queueItemId) } catch { /* already removed or processing */ }
  }

  // Abort current stream so the partial response is saved
  const aborted = abortAgentStream(agentId)

  // Enqueue with high priority so it processes next
  const { id, queuePosition } = await enqueueMessage({
    agentId,
    messageType: aborted ? 'user_addendum' : 'user',
    content: content.trim(),
    sourceType: 'user',
    sourceId: user.id,
    priority: 999,
  })

  log.debug({ agentId, messageId: id, aborted, queueItemId }, 'Message injected')

  return c.json({ messageId: id, queuePosition, injected: aborted }, 202)
})

// DELETE /api/agents/:agentId/messages — clear all conversation messages (not task/session messages)
messageRoutes.delete('/', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  try {
    // Delete compacting data first (references messages.id without cascade)
    await db.delete(compactingSnapshots).where(eq(compactingSnapshots.agentId, agentId))
    await db.delete(compactingSummaries).where(eq(compactingSummaries.agentId, agentId))

    // Nullify sourceMessageId in memories (no cascade)
    await db
      .update(agentMemories)
      .set({ sourceMessageId: null })
      .where(eq(agentMemories.agentId, agentId))

    // Delete orphaned files from disk and DB (instead of just nullifying messageId)
    const agentFiles = await db
      .select({ id: files.id, storedPath: files.storedPath })
      .from(files)
      .where(eq(files.agentId, agentId))

    if (agentFiles.length > 0) {
      const { unlink } = await import('fs/promises')
      for (const f of agentFiles) {
        try {
          await unlink(f.storedPath)
        } catch {
          // File may already be missing from disk
        }
      }
      await db.delete(files).where(
        inArray(
          files.id,
          agentFiles.map((f) => f.id),
        ),
      )
      log.info({ agentId, count: agentFiles.length }, 'Deleted files during conversation clear')
    }

    // Nullify messageId in humanPrompts (no cascade)
    await db
      .update(humanPrompts)
      .set({ messageId: null })
      .where(eq(humanPrompts.agentId, agentId))

    // Delete conversation messages (exclude task/session messages)
    const deleted = await db
      .delete(messages)
      .where(
        and(
          eq(messages.agentId, agentId),
          isNull(messages.taskId),
          isNull(messages.sessionId),
        ),
      )

    log.info({ agentId }, 'Conversation cleared')

    sseManager.sendToAgent(agentId, {
      type: 'chat:cleared',
      agentId,
      data: { agentId },
    })

    return c.json({ ok: true })
  } catch (err) {
    log.error({ agentId, err }, 'Failed to clear conversation')
    return c.json(
      { error: { code: 'CLEAR_FAILED', message: err instanceof Error ? err.message : 'Unknown error' } },
      500,
    )
  }
})

// DELETE /api/agents/:agentId/messages/:messageId — delete a single message.
// The row carries its whole turn step (tool calls + results live in the
// assistant row's toolCalls JSON), so removing a full row keeps the LLM
// history well-formed.
messageRoutes.delete('/:messageId', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const messageId = c.req.param('messageId')
  if (messageId === 'queue') return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)

  if (await isAgentProcessing(agentId, 'main')) {
    return c.json({ error: { code: 'AGENT_BUSY', message: 'The agent is processing — wait for the turn to finish before deleting messages' } }, 409)
  }

  const msg = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.agentId, agentId), isNull(messages.taskId), isNull(messages.sessionId)))
    .get()
  if (!msg) {
    return c.json({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } }, 404)
  }

  try {
    await deleteMessagesCascade(agentId, [messageId])
    log.info({ agentId, messageId }, 'Message deleted')
    sseManager.sendToAgent(agentId, {
      type: 'chat:messages-deleted',
      agentId,
      data: { agentId, messageIds: [messageId] },
    })
    return c.json({ ok: true, deletedCount: 1 })
  } catch (err) {
    log.error({ agentId, messageId, err }, 'Failed to delete message')
    return c.json({ error: { code: 'DELETE_FAILED', message: err instanceof Error ? err.message : 'Unknown error' } }, 500)
  }
})

// POST /api/agents/:agentId/messages/rewind — make a message the newest one:
// delete every conversation message strictly after it (including hidden
// context messages), so the LLM context rolls back to that point.
messageRoutes.post('/rewind', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const { messageId } = (await c.req.json().catch(() => ({}))) as { messageId?: string }
  if (!messageId) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'messageId is required' } }, 400)
  }

  if (await isAgentProcessing(agentId, 'main')) {
    return c.json({ error: { code: 'AGENT_BUSY', message: 'The agent is processing — wait for the turn to finish before rewinding' } }, 409)
  }

  const target = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.agentId, agentId), isNull(messages.taskId), isNull(messages.sessionId)))
    .get()
  if (!target) {
    return c.json({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } }, 404)
  }

  try {
    // Strictly after the target. Equal-timestamp siblings survive — with ms
    // precision and sequential inserts that's the safe direction (delete less).
    const after = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(
        eq(messages.agentId, agentId),
        isNull(messages.taskId),
        isNull(messages.sessionId),
        gt(messages.createdAt, target.createdAt),
      ))
      .all()
    const ids = after.map((m) => m.id)

    // Summaries covering deleted territory reference content that no longer
    // exists — drop them; the messages they covered up to the rewind point
    // simply re-enter the visible (non-compacted) history.
    await db
      .delete(compactingSummaries)
      .where(and(eq(compactingSummaries.agentId, agentId), gt(compactingSummaries.lastMessageAt, target.createdAt)))

    await deleteMessagesCascade(agentId, ids)

    log.info({ agentId, messageId, deletedCount: ids.length }, 'Conversation rewound')
    if (ids.length > 0) {
      sseManager.sendToAgent(agentId, {
        type: 'chat:messages-deleted',
        agentId,
        data: { agentId, messageIds: ids },
      })
    }
    return c.json({ ok: true, deletedCount: ids.length })
  } catch (err) {
    log.error({ agentId, messageId, err }, 'Failed to rewind conversation')
    return c.json({ error: { code: 'REWIND_FAILED', message: err instanceof Error ? err.message : 'Unknown error' } }, 500)
  }
})

// GET /api/agents/:agentId/messages/queue — list pending queue items
messageRoutes.get('/queue', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const items = await getPendingQueueItems(agentId)
  return c.json({ items })
})

// DELETE /api/agents/:agentId/messages/queue/:itemId — remove a pending queue item
messageRoutes.delete('/queue/:itemId', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const itemId = c.req.param('itemId')
  const removed = await removeQueueItem(agentId, itemId)
  if (!removed) {
    return c.json({ error: { code: 'QUEUE_ITEM_NOT_FOUND', message: 'Queue item not found or already processing' } }, 404)
  }

  return c.json({ ok: true })
})

export { messageRoutes }
