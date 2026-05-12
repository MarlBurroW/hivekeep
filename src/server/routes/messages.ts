import { Hono } from 'hono'
import { eq, and, isNull, lt, desc, inArray } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { messages, kins, channels, channelMessageLinks, compactingSnapshots, compactingSummaries, memories as kinMemories, files, humanPrompts, messageReactions } from '@/server/db/schema'
import { enqueueMessage, getPendingQueueItems, removeQueueItem } from '@/server/services/queue'
import { abortKinStream } from '@/server/services/kin-engine'
import { sseManager } from '@/server/sse/index'
import { getFilesForMessages, serializeFile } from '@/server/services/files'
import { resolveKinId } from '@/server/services/kin-resolver'
import { parseMentions, notifyMentionedUsers } from '@/server/services/mentions'
import { channelAdapters } from '@/server/channels/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { MAX_MESSAGE_LENGTH } from '@/shared/constants'

const log = createLogger('routes:messages')
const messageRoutes = new Hono<{ Variables: AppVariables }>()

// POST /api/kins/:kinId/messages — send a message to a kin (accepts UUID or slug)
messageRoutes.post('/', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const user = c.get('user') as { id: string; name: string }
  const body = await c.req.json()
  const { content, fileIds } = body as { content: string; fileIds?: string[] }
  const hasFiles = fileIds && fileIds.length > 0

  if (!content?.trim() && !hasFiles) {
    return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content or files required' } }, 400)
  }

  if (content && content.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: { code: 'MESSAGE_TOO_LONG', message: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters` } }, 400)
  }

  // Enqueue the message (clean content — pseudonym prefix is added by kin-engine for LLM context)
  // fileIds are passed through the queue and linked to the actual message in kin-engine
  const { id, queuePosition } = await enqueueMessage({
    kinId,
    messageType: 'user',
    content: content ?? '',
    sourceType: 'user',
    sourceId: user.id,
    fileIds: hasFiles ? fileIds : undefined,
  })

  log.debug({ kinId, messageId: id, contentLength: content.length, fileCount: fileIds?.length ?? 0 }, 'Message enqueued')

  // Fire-and-forget: parse @mentions and notify mentioned users
  if (content) {
    parseMentions(content).then((mentions) => {
      if (mentions.length > 0) {
        notifyMentionedUsers(mentions, kinId, id, user.name).catch(() => {})
      }
    }).catch(() => {})
  }

  return c.json({ messageId: id, queuePosition }, 202)
})

// GET /api/kins/:kinId/messages — get message history (accepts UUID or slug)
messageRoutes.get('/', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const before = c.req.query('before')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)

  let query = db
    .select()
    .from(messages)
    .where(
      before
        ? and(
            eq(messages.kinId, kinId),
            isNull(messages.taskId),
            isNull(messages.sessionId),
            lt(messages.id, before),
          )
        : and(eq(messages.kinId, kinId), isNull(messages.taskId), isNull(messages.sessionId)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit + 1) // +1 to check hasMore

  const result = await query.all()
  const hasMore = result.length > limit
  const messageList = hasMore ? result.slice(0, limit) : result

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

  // Resolve source kin info for inter-kin and task messages
  const kinSourceIds = [
    ...new Set(
      messageList
        .filter((m) => (m.sourceType === 'kin' || m.sourceType === 'task') && m.sourceId)
        .map((m) => m.sourceId!),
    ),
  ]
  const kinInfoMap = new Map<string, { name: string; avatarUrl: string | null }>()
  if (kinSourceIds.length > 0) {
    const sourceKins = await db
      .select({ id: kins.id, name: kins.name, avatarPath: kins.avatarPath })
      .from(kins)
      .where(inArray(kins.id, kinSourceIds))
      .all()
    for (const k of sourceKins) {
      const ext = k.avatarPath?.split('.').pop() ?? 'png'
      kinInfoMap.set(k.id, {
        name: k.name,
        avatarUrl: k.avatarPath ? `/api/uploads/kins/${k.id}/avatar.${ext}` : null,
      })
    }
  }

  // ─── Channel metadata enrichment ─────────────────────────────────────────
  // For each message that transited through a channel (inbound user OR outbound
  // kin), look up the platform + adapter brand color so the UI can render the
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
      if (!platformByMessageId.has(link.messageId)) {
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
  // `systemEvent` blob with the OTHER Kin's name + avatar and the channel's
  // current platform meta, so MessageBubble can render the dedicated cards
  // without an extra round trip.
  const transferOtherKinIds = new Set<string>()
  const transferChannelIds = new Set<string>()
  const transferMetaByMessageId = new Map<string, Record<string, unknown>>()
  for (const m of messageList) {
    if (!m.metadata) continue
    try {
      const meta = JSON.parse(m.metadata as string)
      const ev = meta?.systemEvent
      if (ev !== 'channel_transferred_out' && ev !== 'channel_transferred_in') continue
      transferMetaByMessageId.set(m.id, meta as Record<string, unknown>)
      const otherKinId = (ev === 'channel_transferred_out' ? meta.targetKinId : meta.fromKinId) as string | undefined
      if (otherKinId) transferOtherKinIds.add(otherKinId)
      if (typeof meta.channelId === 'string') transferChannelIds.add(meta.channelId)
    } catch { /* corrupted, skip */ }
  }

  const transferKinInfoMap = new Map<string, { id: string; slug: string | null; name: string; avatarUrl: string | null }>()
  if (transferOtherKinIds.size > 0) {
    const rows = await db
      .select({ id: kins.id, slug: kins.slug, name: kins.name, avatarPath: kins.avatarPath })
      .from(kins)
      .where(inArray(kins.id, Array.from(transferOtherKinIds)))
      .all()
    for (const k of rows) {
      const ext = k.avatarPath?.split('.').pop() ?? 'png'
      transferKinInfoMap.set(k.id, {
        id: k.id,
        slug: k.slug ?? null,
        name: k.name,
        avatarUrl: k.avatarPath ? `/api/uploads/kins/${k.id}/avatar.${ext}` : null,
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

  return c.json({
    messages: messageList.map((m) => {
      const kinInfo = (m.sourceType === 'kin' || m.sourceType === 'task') && m.sourceId ? kinInfoMap.get(m.sourceId) : null
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
      // OTHER Kin's name/slug/avatar, plus the channel's current platform
      // info so we can paint the platform icon next to the channel name.
      let systemEvent: Record<string, unknown> | null = null
      const transferMeta = transferMetaByMessageId.get(m.id)
      if (transferMeta) {
        const evType = transferMeta.systemEvent as 'channel_transferred_out' | 'channel_transferred_in'
        const otherKinId = (evType === 'channel_transferred_out' ? transferMeta.targetKinId : transferMeta.fromKinId) as string | undefined
        const otherKinSlugInMeta = (evType === 'channel_transferred_out' ? transferMeta.targetKinSlug : transferMeta.fromKinSlug) as string | null | undefined
        const otherKinNameInMeta = (evType === 'channel_transferred_out' ? transferMeta.targetKinName : transferMeta.fromKinName) as string | undefined
        const otherKinInfo = otherKinId ? transferKinInfoMap.get(otherKinId) : undefined
        const channelIdRef = transferMeta.channelId as string | undefined
        const channelPlatform = channelIdRef ? transferChannelPlatformMap.get(channelIdRef) ?? null : null
        const channelPlatformMeta = channelPlatform ? getPlatformMeta(channelPlatform) : null
        systemEvent = {
          type: evType,
          channelId: channelIdRef ?? null,
          channelName: (transferMeta.channelName as string | undefined) ?? null,
          channelPlatform,
          channelBrandColor: channelPlatformMeta?.brandColor ?? null,
          otherKin: {
            // Prefer the row data (current) but fall back to whatever the
            // audit-trail snapshot recorded if the Kin row has since been
            // deleted.
            id: otherKinId ?? null,
            slug: otherKinInfo?.slug ?? otherKinSlugInMeta ?? null,
            name: otherKinInfo?.name ?? otherKinNameInMeta ?? 'Unknown Kin',
            avatarUrl: otherKinInfo?.avatarUrl ?? null,
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
        sourceName: kinInfo?.name ?? null,
        sourceAvatarUrl: kinInfo?.avatarUrl ?? null,
        isRedacted: m.isRedacted,
        toolCalls,
        resolvedTaskId: meta?.resolvedTaskId ?? meta?.relatedTaskId ?? null,
        injectedMemories: meta?.injectedMemories ?? null,
        memoriesExtracted: meta?.memoriesExtracted ?? null,
        compactingError: meta?.error ?? null,
        stepLimitReached: meta?.stepLimitReached ?? false,
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

// POST /api/kins/:kinId/messages/stop — stop an active LLM generation
messageRoutes.post('/stop', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const aborted = abortKinStream(kinId)
  if (!aborted) {
    return c.json({ error: { code: 'NOT_STREAMING', message: 'No active generation to stop' } }, 409)
  }

  return c.json({ ok: true })
})

// POST /api/kins/:kinId/messages/inject — inject a message into the current streaming response (/btw)
messageRoutes.post('/inject', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
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
    try { await removeQueueItem(kinId, queueItemId) } catch { /* already removed or processing */ }
  }

  // Abort current stream so the partial response is saved
  const aborted = abortKinStream(kinId)

  // Enqueue with high priority so it processes next
  const { id, queuePosition } = await enqueueMessage({
    kinId,
    messageType: aborted ? 'user_addendum' : 'user',
    content: content.trim(),
    sourceType: 'user',
    sourceId: user.id,
    priority: 999,
  })

  log.debug({ kinId, messageId: id, aborted, queueItemId }, 'Message injected')

  return c.json({ messageId: id, queuePosition, injected: aborted }, 202)
})

// DELETE /api/kins/:kinId/messages — clear all conversation messages (not task/session messages)
messageRoutes.delete('/', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  try {
    // Delete compacting data first (references messages.id without cascade)
    await db.delete(compactingSnapshots).where(eq(compactingSnapshots.kinId, kinId))
    await db.delete(compactingSummaries).where(eq(compactingSummaries.kinId, kinId))

    // Nullify sourceMessageId in memories (no cascade)
    await db
      .update(kinMemories)
      .set({ sourceMessageId: null })
      .where(eq(kinMemories.kinId, kinId))

    // Delete orphaned files from disk and DB (instead of just nullifying messageId)
    const kinFiles = await db
      .select({ id: files.id, storedPath: files.storedPath })
      .from(files)
      .where(eq(files.kinId, kinId))

    if (kinFiles.length > 0) {
      const { unlink } = await import('fs/promises')
      for (const f of kinFiles) {
        try {
          await unlink(f.storedPath)
        } catch {
          // File may already be missing from disk
        }
      }
      await db.delete(files).where(
        inArray(
          files.id,
          kinFiles.map((f) => f.id),
        ),
      )
      log.info({ kinId, count: kinFiles.length }, 'Deleted files during conversation clear')
    }

    // Nullify messageId in humanPrompts (no cascade)
    await db
      .update(humanPrompts)
      .set({ messageId: null })
      .where(eq(humanPrompts.kinId, kinId))

    // Delete conversation messages (exclude task/session messages)
    const deleted = await db
      .delete(messages)
      .where(
        and(
          eq(messages.kinId, kinId),
          isNull(messages.taskId),
          isNull(messages.sessionId),
        ),
      )

    log.info({ kinId }, 'Conversation cleared')

    sseManager.sendToKin(kinId, {
      type: 'chat:cleared',
      kinId,
      data: { kinId },
    })

    return c.json({ ok: true })
  } catch (err) {
    log.error({ kinId, err }, 'Failed to clear conversation')
    return c.json(
      { error: { code: 'CLEAR_FAILED', message: err instanceof Error ? err.message : 'Unknown error' } },
      500,
    )
  }
})

// GET /api/kins/:kinId/messages/queue — list pending queue items
messageRoutes.get('/queue', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const items = await getPendingQueueItems(kinId)
  return c.json({ items })
})

// DELETE /api/kins/:kinId/messages/queue/:itemId — remove a pending queue item
messageRoutes.delete('/queue/:itemId', async (c) => {
  const kinIdParam = c.req.param('kinId')
  const kinId = kinIdParam ? resolveKinId(kinIdParam) : null
  if (!kinId) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const itemId = c.req.param('itemId')
  const removed = await removeQueueItem(kinId, itemId)
  if (!removed) {
    return c.json({ error: { code: 'QUEUE_ITEM_NOT_FOUND', message: 'Queue item not found or already processing' } }, 404)
  }

  return c.json({ ok: true })
})

export { messageRoutes }
