import { Hono } from 'hono'
import { THINKING_EFFORTS } from '@/shared/constants'
import { eq, and, asc, desc, inArray, sql } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { quickSessions, messages, agents, memories } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { abortQuickSessionStream } from '@/server/services/agent-engine'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { getFilesForMessages, serializeFile } from '@/server/services/files'
import { createMemory } from '@/server/services/memory'
import { config } from '@/server/config'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import type { QuickSessionStatus, QuickSessionSummary } from '@/shared/types'

const log = createLogger('routes:quick-sessions')

// ─── Agent-scoped routes: /api/agents/:agentId/quick-sessions ──────────────────────

const agentScopedRoutes = new Hono<{ Variables: AppVariables }>()

// POST / — create a new quick session
agentScopedRoutes.post('/', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const user = c.get('user') as { id: string; name: string }
  const body = await c.req.json().catch(() => ({}))
  const { title: rawTitle } = body as { title?: string }

  // Validate title
  const title = rawTitle?.trim() || null
  if (title && title.length > 200) {
    return c.json({ error: { code: 'TITLE_TOO_LONG', message: 'Title must be 200 characters or less' } }, 400)
  }

  // Check max active sessions per user per agent. Exclude kind='api' (external
  // API isolated conversations) — they are not human quick-chat sessions and
  // must not count against the user's quota or appear in their list.
  const activeCount = await db
    .select()
    .from(quickSessions)
    .where(and(
      eq(quickSessions.agentId, agentId),
      eq(quickSessions.createdBy, user.id),
      eq(quickSessions.status, 'active'),
      eq(quickSessions.kind, 'quick'),
    ))
    .all()

  if (activeCount.length >= config.quickSessions.maxActivePerUserPerAgent) {
    return c.json({
      error: { code: 'MAX_QUICK_SESSIONS', message: 'Maximum active quick sessions reached for this Agent' },
    }, 409)
  }

  const now = new Date()
  const session = {
    id: uuid(),
    agentId,
    createdBy: user.id,
    title: title || null,
    status: 'active' as const,
    createdAt: now,
    closedAt: null,
    expiresAt: new Date(now.getTime() + config.quickSessions.defaultExpirationHours * 60 * 60 * 1000),
  }

  await db.insert(quickSessions).values(session)

  log.debug({ agentId, sessionId: session.id, userId: user.id }, 'Quick session created')

  return c.json({
    id: session.id,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt.getTime(),
    closedAt: null,
    expiresAt: session.expiresAt ? (session.expiresAt as Date).getTime() : null,
  } satisfies QuickSessionSummary, 201)
})

// GET / — list quick sessions for the current user on this agent
// Query params:
//   ?status=active (default) | closed | all
//   ?limit=N (default 20, max 50, only for closed/all)
agentScopedRoutes.get('/', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const user = c.get('user') as { id: string; name: string }
  const statusFilter = (c.req.query('status') ?? 'active') as string
  const limitParam = Math.min(Math.max(parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 50)
  const offsetParam = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0)

  const conditions = [
    eq(quickSessions.agentId, agentId),
    eq(quickSessions.createdBy, user.id),
    eq(quickSessions.kind, 'quick'), // hide external-API isolated conversations
  ]

  if (statusFilter === 'active' || statusFilter === 'closed') {
    conditions.push(eq(quickSessions.status, statusFilter))
  }
  // 'all' — no status filter

  const sessions = await db
    .select()
    .from(quickSessions)
    .where(and(...conditions))
    .orderBy(desc(quickSessions.createdAt))
    .limit(limitParam + 1)
    .offset(offsetParam)
    .all()

  const hasMore = sessions.length > limitParam
  if (hasMore) sessions.pop()

  // For closed sessions, include message count
  const sessionIds = sessions.filter(s => s.status === 'closed').map(s => s.id)
  const messageCounts = new Map<string, number>()

  if (sessionIds.length > 0) {
    const counts = await db
      .select({ sessionId: messages.sessionId, count: sql<number>`count(*)` })
      .from(messages)
      .where(inArray(messages.sessionId, sessionIds))
      .groupBy(messages.sessionId)
      .all()
    for (const row of counts) {
      if (row.sessionId) messageCounts.set(row.sessionId, row.count)
    }
  }

  return c.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      agentId: s.agentId,
      title: s.title,
      status: s.status as QuickSessionStatus,
      createdAt: (s.createdAt as Date).getTime(),
      closedAt: s.closedAt ? (s.closedAt as Date).getTime() : null,
      expiresAt: s.expiresAt ? (s.expiresAt as Date).getTime() : null,
      messageCount: messageCounts.get(s.id) ?? undefined,
    })),
    hasMore,
  })
})

// ─── Session-scoped routes: /api/quick-sessions/:id ──────────────────────────

const sessionRoutes = new Hono<{ Variables: AppVariables }>()

// Helper: load session and verify ownership
async function loadSession(sessionId: string, userId: string) {
  const session = await db
    .select()
    .from(quickSessions)
    .where(eq(quickSessions.id, sessionId))
    .get()

  if (!session) return { error: 'NOT_FOUND' as const, session: null }
  if (session.createdBy !== userId) return { error: 'FORBIDDEN' as const, session: null }
  return { error: null, session }
}

// GET /:id — get session detail + messages
sessionRoutes.get('/:id', async (c) => {
  const user = c.get('user') as { id: string; name: string }
  const { error, session } = await loadSession(c.req.param('id'), user.id)

  if (error === 'NOT_FOUND') {
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Quick session not found' } }, 404)
  }
  if (error === 'FORBIDDEN') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'You do not own this session' } }, 403)
  }

  // Fetch messages for this session
  const sessionMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, session!.id))
    .orderBy(asc(messages.createdAt))
    .all()

  const messageIds = sessionMessages.map((m) => m.id)
  const fileMap = await getFilesForMessages(messageIds)

  // Resolve agent info for assistant messages
  const agent = await db.select({ name: agents.name, avatarPath: agents.avatarPath }).from(agents).where(eq(agents.id, session!.agentId)).get()
  const agentAvatarUrl = agent?.avatarPath
    ? `/api/uploads/agents/${session!.agentId}/avatar.${agent.avatarPath.split('.').pop() ?? 'png'}`
    : null

  return c.json({
    session: {
      id: session!.id,
      agentId: session!.agentId,
      title: session!.title,
      status: session!.status as QuickSessionStatus,
      createdAt: (session!.createdAt as Date).getTime(),
      closedAt: session!.closedAt ? (session!.closedAt as Date).getTime() : null,
      expiresAt: session!.expiresAt ? (session!.expiresAt as Date).getTime() : null,
      model: session!.model ?? null,
      providerId: session!.providerId ?? null,
      thinkingEnabled: session!.thinkingEnabled ?? null,
      thinkingEffort: (session!.thinkingEffort as QuickSessionSummary['thinkingEffort']) ?? null,
    } satisfies QuickSessionSummary,
    messages: sessionMessages.map((m) => {
      let meta: Record<string, unknown> | null = null
      let reasoning: unknown = null
      try { meta = m.metadata ? JSON.parse(m.metadata as string) : null } catch { /* ignore */ }
      try { reasoning = m.reasoning ? JSON.parse(m.reasoning as string) : null } catch { /* ignore */ }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        sourceName: m.role === 'assistant' ? agent?.name ?? null : null,
        sourceAvatarUrl: m.role === 'assistant' ? agentAvatarUrl : null,
        isRedacted: m.isRedacted,
        toolCalls: m.toolCalls ? JSON.parse(m.toolCalls as string) : null,
        resolvedTaskId: null,
        injectedMemories: meta?.injectedMemories ?? null,
        stepLimitReached: meta?.stepLimitReached ?? false,
        emptyTurn: meta?.emptyTurn ?? false,
        finishReason: meta?.finishReason ?? null,
        silentStop: meta?.silentStop ?? false,
        tokenUsage: meta?.tokenUsage ?? null,
        reasoning,
        files: (fileMap.get(m.id) ?? []).map(serializeFile),
        createdAt: m.createdAt,
      }
    }),
  })
})

// PATCH /:id — update the session's per-session LLM overrides (model/effort).
// null clears an override back to "inherit the agent's configuration". Only
// the session owner can change it; the next turn picks the values up.
sessionRoutes.patch('/:id', async (c) => {
  const user = c.get('user') as { id: string; name: string }
  const { error, session } = await loadSession(c.req.param('id'), user.id)

  if (error === 'NOT_FOUND') {
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Quick session not found' } }, 404)
  }
  if (error === 'FORBIDDEN') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'You do not own this session' } }, 403)
  }
  if (session!.status !== 'active') {
    return c.json({ error: { code: 'SESSION_CLOSED', message: 'This quick session is closed' } }, 409)
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    model?: string | null
    providerId?: string | null
    thinkingEnabled?: boolean | null
    thinkingEffort?: string | null
  }

  const set: Record<string, unknown> = {}
  if ('model' in body) {
    if (body.model !== null && (typeof body.model !== 'string' || !body.model.trim())) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'model must be a non-empty string or null' } }, 400)
    }
    set.model = body.model
  }
  if ('providerId' in body) {
    if (body.providerId !== null && typeof body.providerId !== 'string') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'providerId must be a string or null' } }, 400)
    }
    set.providerId = body.providerId
  }
  if ('thinkingEnabled' in body) {
    if (body.thinkingEnabled !== null && typeof body.thinkingEnabled !== 'boolean') {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'thinkingEnabled must be a boolean or null' } }, 400)
    }
    set.thinkingEnabled = body.thinkingEnabled
  }
  if ('thinkingEffort' in body) {
    if (body.thinkingEffort !== null && !(THINKING_EFFORTS as readonly string[]).includes(body.thinkingEffort as string)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: `thinkingEffort must be one of ${THINKING_EFFORTS.join(' | ')} or null` } }, 400)
    }
    set.thinkingEffort = body.thinkingEffort
  }
  if (Object.keys(set).length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Nothing to update' } }, 400)
  }

  await db.update(quickSessions).set(set).where(eq(quickSessions.id, session!.id))
  const updated = await db.select().from(quickSessions).where(eq(quickSessions.id, session!.id)).get()

  log.debug({ sessionId: session!.id, set }, 'Quick session overrides updated')

  return c.json({
    session: {
      id: updated!.id,
      agentId: updated!.agentId,
      title: updated!.title,
      status: updated!.status as QuickSessionStatus,
      createdAt: (updated!.createdAt as Date).getTime(),
      closedAt: updated!.closedAt ? (updated!.closedAt as Date).getTime() : null,
      expiresAt: updated!.expiresAt ? (updated!.expiresAt as Date).getTime() : null,
      model: updated!.model ?? null,
      providerId: updated!.providerId ?? null,
      thinkingEnabled: updated!.thinkingEnabled ?? null,
      thinkingEffort: (updated!.thinkingEffort as QuickSessionSummary['thinkingEffort']) ?? null,
    } satisfies QuickSessionSummary,
  })
})

// POST /:id/messages — send a message to a quick session
sessionRoutes.post('/:id/messages', async (c) => {
  const user = c.get('user') as { id: string; name: string }
  const { error, session } = await loadSession(c.req.param('id'), user.id)

  if (error === 'NOT_FOUND') {
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Quick session not found' } }, 404)
  }
  if (error === 'FORBIDDEN') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'You do not own this session' } }, 403)
  }
  if (session!.status !== 'active') {
    return c.json({ error: { code: 'SESSION_CLOSED', message: 'This quick session is closed' } }, 409)
  }
  if (session!.expiresAt && (session!.expiresAt as Date) < new Date()) {
    return c.json({ error: { code: 'SESSION_EXPIRED', message: 'This quick session has expired' } }, 409)
  }

  const body = await c.req.json()
  const { content, fileIds } = body as { content: string; fileIds?: string[] }
  const hasFiles = fileIds && fileIds.length > 0

  if (!content?.trim() && !hasFiles) {
    return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content or files required' } }, 400)
  }

  if (content && content.length > 100_000) {
    return c.json({ error: { code: 'CONTENT_TOO_LONG', message: 'Message content must be 100,000 characters or less' } }, 400)
  }

  if (fileIds) {
    if (fileIds.length > 10) {
      return c.json({ error: { code: 'TOO_MANY_FILES', message: 'Maximum 10 files per message' } }, 400)
    }
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (fileIds.some((id: string) => typeof id !== 'string' || !uuidRegex.test(id))) {
      return c.json({ error: { code: 'INVALID_FILE_ID', message: 'Each fileId must be a valid UUID' } }, 400)
    }
  }

  const { id, queuePosition } = await enqueueMessage({
    agentId: session!.agentId,
    messageType: 'user',
    content: content ?? '',
    sourceType: 'user',
    sourceId: user.id,
    sessionId: session!.id,
    fileIds: hasFiles ? fileIds : undefined,
  })

  log.debug({ sessionId: session!.id, agentId: session!.agentId, messageId: id }, 'Quick session message enqueued')

  return c.json({ messageId: id, queuePosition }, 202)
})

// POST /:id/messages/stop — stop streaming in a quick session
sessionRoutes.post('/:id/messages/stop', async (c) => {
  const user = c.get('user') as { id: string; name: string }
  const { error, session } = await loadSession(c.req.param('id'), user.id)

  if (error === 'NOT_FOUND') {
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Quick session not found' } }, 404)
  }
  if (error === 'FORBIDDEN') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'You do not own this session' } }, 403)
  }

  const aborted = abortQuickSessionStream(session!.id)
  if (!aborted) {
    return c.json({ error: { code: 'NOT_STREAMING', message: 'No active generation to stop' } }, 409)
  }

  return c.json({ ok: true })
})

// POST /:id/close — close a quick session
sessionRoutes.post('/:id/close', async (c) => {
  const user = c.get('user') as { id: string; name: string }
  const { error, session } = await loadSession(c.req.param('id'), user.id)

  if (error === 'NOT_FOUND') {
    return c.json({ error: { code: 'SESSION_NOT_FOUND', message: 'Quick session not found' } }, 404)
  }
  if (error === 'FORBIDDEN') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'You do not own this session' } }, 403)
  }
  if (session!.status === 'closed') {
    return c.json({ ok: true }) // Already closed, idempotent
  }

  // Abort any active streaming
  abortQuickSessionStream(session!.id)

  const body = await c.req.json().catch(() => ({}))
  const { saveMemory, memorySummary: rawSummary } = body as { saveMemory?: boolean; memorySummary?: string }

  // Validate memory summary length
  const memorySummary = rawSummary?.trim() || undefined
  if (memorySummary && memorySummary.length > 5000) {
    return c.json({ error: { code: 'SUMMARY_TOO_LONG', message: 'Memory summary must be 5000 characters or less' } }, 400)
  }

  // Validate: if saveMemory is requested, summary must not be empty
  if (saveMemory && !memorySummary) {
    return c.json({ error: { code: 'SUMMARY_REQUIRED', message: 'A summary is required when saving as memory' } }, 400)
  }

  // Save memory if requested (uses createMemory to generate embedding + vector index)
  if (saveMemory && memorySummary) {
    const memory = await createMemory(session!.agentId, {
      content: memorySummary.trim(),
      category: 'knowledge',
      subject: session!.title ?? 'Quick session',
      sourceChannel: 'explicit',
    })
    log.debug({ sessionId: session!.id, agentId: session!.agentId, memoryId: memory.id }, 'Quick session memory saved')
  }

  // Close the session
  await db.update(quickSessions).set({
    status: 'closed',
    closedAt: new Date(),
  }).where(eq(quickSessions.id, session!.id))

  // Notify via SSE
  sseManager.sendToAgent(session!.agentId, {
    type: 'quick-session:closed',
    agentId: session!.agentId,
    data: { sessionId: session!.id },
  })

  log.debug({ sessionId: session!.id }, 'Quick session closed')

  return c.json({ ok: true })
})

export { agentScopedRoutes as quickSessionAgentRoutes, sessionRoutes as quickSessionDetailRoutes }
