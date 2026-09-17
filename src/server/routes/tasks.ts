import { Hono } from 'hono'
import { eq, and, asc } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { tasks, messages, agents } from '@/server/db/schema'
import { getTask, listTasksPaginated, cancelTask, forcePromoteTask, pauseTask, resumeTask, injectIntoTask, getActiveTaskSnapshot, retryTask, TaskNotRetryableError, TaskNotFoundError } from '@/server/services/tasks'
import { resolveThinkingConfig } from '@/server/services/agent-engine'
import { fetchCronLearningsByTask } from '@/server/services/cron-learnings'
import { getTodosForTask } from '@/server/services/task-todos'
import { getTaskTotals, getTaskTotalsBatch } from '@/server/services/token-usage'
import { guessProviderType } from '@/shared/model-ref'
import type { AppVariables } from '@/server/app'
import type { TaskStatus } from '@/shared/types'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:tasks')

export const taskRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/tasks — list tasks with pagination, search, and optional filters
taskRoutes.get('/', async (c) => {
  const status = c.req.query('status') as TaskStatus | undefined
  const agentId = c.req.query('agentId')
  const cronId = c.req.query('cronId')
  const search = c.req.query('search')?.trim() || undefined
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 100)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)

  const { tasks: allTasks, total } = await listTasksPaginated({ status, agentId, cronId, search, limit, offset })

  // Fetch agent info (name + avatar + thinking config) for display
  const agentIds = [...new Set(allTasks.flatMap((t) => [t.parentAgentId, t.sourceAgentId].filter((id): id is string => id != null)))]
  const agentMap = new Map<string, { name: string; avatarUrl: string | null; model: string; thinkingConfig: string | null }>()

  for (const id of agentIds) {
    const agent = await db.select({ id: agents.id, name: agents.name, avatarPath: agents.avatarPath, model: agents.model, thinkingConfig: agents.thinkingConfig }).from(agents).where(eq(agents.id, id)).get()
    if (agent) {
      const ext = agent.avatarPath?.split('.').pop() ?? 'png'
      agentMap.set(agent.id, {
        name: agent.name,
        avatarUrl: agent.avatarPath ? `/api/uploads/agents/${agent.id}/avatar.${ext}` : null,
        model: agent.model,
        thinkingConfig: agent.thinkingConfig,
      })
    }
  }

  // Per-task token roll-up — one GROUP BY query, then merged into each row.
  const usageMap = getTaskTotalsBatch(allTasks.map((t) => t.id))

  return c.json({
    tasks: allTasks.map((t) => {
      const parentAgent = agentMap.get(t.parentAgentId)
      const sourceAgent = t.sourceAgentId ? agentMap.get(t.sourceAgentId) : null
      // Mirror the runtime cascade in tasks.ts: task.thinkingConfig ?? parentAgent.thinkingConfig
      // → resolveThinkingConfig() applies the default (medium) when neither is set.
      const effectiveThinking = resolveThinkingConfig(t.thinkingConfig ?? parentAgent?.thinkingConfig ?? null)
      const effectiveModel = t.model ?? parentAgent?.model ?? null
      const providerType = effectiveModel ? guessProviderType(effectiveModel) : null
      return {
        id: t.id,
        parentAgentId: t.parentAgentId,
        parentAgentName: parentAgent?.name ?? 'Unknown',
        parentAgentAvatarUrl: parentAgent?.avatarUrl ?? null,
        sourceAgentId: t.sourceAgentId,
        sourceAgentName: sourceAgent?.name ?? null,
        sourceAgentAvatarUrl: sourceAgent?.avatarUrl ?? null,
        title: t.title,
        description: t.description,
        status: t.status,
        mode: t.mode,
        model: effectiveModel,
        providerType,
        providerId: t.providerId ?? null,
        cronId: t.cronId ?? null,
        depth: t.depth,
        thinkingEnabled: effectiveThinking.enabled === true,
        thinkingEffort: effectiveThinking.effort ?? null,
        concurrencyGroup: t.concurrencyGroup ?? null,
        concurrencyMax: t.concurrencyMax ?? null,
        queuePosition: null, // Computed on-demand for queued tasks
        tokenUsage: usageMap.get(t.id) ?? null,
        startedAt: t.startedAt ?? null,
        endedAt: t.endedAt ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
    }),
    total,
    hasMore: offset + allTasks.length < total,
  })
})

// GET /api/tasks/:id — get detailed task info including messages
taskRoutes.get('/:id', async (c) => {
  const taskId = c.req.param('id')
  const task = await getTask(taskId)

  if (!task) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
  }

  // Fetch task messages
  const taskMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.agentId, task.parentAgentId), eq(messages.taskId, taskId)))
    .orderBy(asc(messages.createdAt))
    .all()

  // Resolve effective model + thinking config (fall back to parent Agent, mirroring tasks.ts runtime cascade)
  const parentAgent = await db.select({ model: agents.model, thinkingConfig: agents.thinkingConfig }).from(agents).where(eq(agents.id, task.parentAgentId)).get()
  const effectiveModel = task.model ?? parentAgent?.model ?? null
  const effectiveThinking = resolveThinkingConfig(task.thinkingConfig ?? parentAgent?.thinkingConfig ?? null)

  // Fetch learnings saved during this task run (if cron task)
  const learningsSaved = task.cronId
    ? fetchCronLearningsByTask(taskId).map((l) => ({
        id: l.id,
        content: l.content,
        category: l.category,
        createdAt: l.createdAt,
      }))
    : []

  // If a stream is currently in-flight, the DB row for the streaming assistant
  // message lags by up to 500ms of text. Overlay the live snapshot so a client
  // that opens the modal mid-stream sees content/tool-calls/reasoning aligned
  // with the offsets emitted via SSE.
  const snapshot = getActiveTaskSnapshot(taskId)

  // Roll-up of every LLM call attributed to this task so the panel can show a
  // running total without polling. Null when nothing has been recorded yet.
  const tokenUsage = getTaskTotals(taskId)
  const providerType = effectiveModel ? guessProviderType(effectiveModel) : null

  return c.json({
    task: {
      id: task.id,
      parentAgentId: task.parentAgentId,
      title: task.title,
      description: task.description,
      status: task.status,
      mode: task.mode,
      model: effectiveModel,
      providerType,
      thinkingEnabled: effectiveThinking.enabled === true,
      thinkingEffort: effectiveThinking.effort ?? null,
      depth: task.depth,
      result: task.result,
      error: task.error,
      concurrencyGroup: task.concurrencyGroup ?? null,
      concurrencyMax: task.concurrencyMax ?? null,
      cronId: task.cronId ?? null,
      tokenUsage,
      startedAt: task.startedAt ?? null,
      endedAt: task.endedAt ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
    messages: taskMessages.map((m) => {
      let toolCalls: unknown = null
      let meta: Record<string, unknown> | null = null
      let reasoning: unknown = null
      try { toolCalls = m.toolCalls ? JSON.parse(m.toolCalls) : null } catch { /* corrupted */ }
      try { meta = m.metadata ? JSON.parse(m.metadata as string) : null } catch { /* corrupted */ }
      try { reasoning = m.reasoning ? JSON.parse(m.reasoning as string) : null } catch { /* corrupted */ }

      const isStreaming = snapshot && m.id === snapshot.messageId
      return {
        id: m.id,
        role: m.role,
        content: isStreaming ? snapshot.content + snapshot.provisional : m.content,
        sourceType: m.sourceType,
        sourceId: m.sourceId,
        isRedacted: m.isRedacted,
        toolCalls: isStreaming
          ? (snapshot.toolCalls.length > 0 ? snapshot.toolCalls : null)
          : toolCalls,
        tokenUsage: meta?.tokenUsage ?? null,
        reasoning: isStreaming
          ? (snapshot.reasoning.length > 0 ? snapshot.reasoning : null)
          : reasoning,
        createdAt: m.createdAt,
      }
    }),
    streamingMessageId: snapshot?.messageId ?? null,
    // Live thinking-bubble fields for a client mounting mid-stream: the real
    // turn start (so the chrono resumes instead of restarting) and the running
    // output-token total. Null when no stream is in-flight. Mirrors the main
    // thread's streamingMessage.{startedAt,outputTokens} (see routes/messages.ts).
    streamingStartedAt: snapshot?.startedAt ?? null,
    streamingOutputTokens: snapshot?.outputTokens ?? null,
    learningsSaved,
    todos: getTodosForTask(taskId),
  })
})

// POST /api/tasks/:id/cancel — cancel a task
// POST /api/tasks/:id/retry — spawn a new task derived from a failed/cancelled one.
// Body: { preserveHistory?: boolean }. Defaults to false (clean retry).
taskRoutes.post('/:id/retry', async (c) => {
  const taskId = c.req.param('id')
  let body: { preserveHistory?: unknown } = {}
  try {
    body = await c.req.json()
  } catch {
    // empty body is fine — defaults below
  }
  const preserveHistory = body.preserveHistory === true

  try {
    const result = await retryTask(taskId, { preserveHistory })
    log.info({ originalTaskId: taskId, newTaskId: result.taskId, preserveHistory }, 'Task retried')
    return c.json({ taskId: result.taskId, queued: result.queued })
  } catch (err) {
    if (err instanceof TaskNotFoundError) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
    }
    if (err instanceof TaskNotRetryableError) {
      return c.json({ error: { code: 'TASK_NOT_RETRYABLE', message: err.message } }, 409)
    }
    log.error({ taskId, err }, 'Failed to retry task')
    return c.json({ error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Retry failed' } }, 500)
  }
})

taskRoutes.post('/:id/cancel', async (c) => {
  const taskId = c.req.param('id')
  const task = await getTask(taskId)

  if (!task) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
  }

  const success = await cancelTask(taskId, task.parentAgentId)
  if (!success) {
    return c.json(
      { error: { code: 'TASK_NOT_CANCELLABLE', message: 'Task is already finished' } },
      409,
    )
  }

  log.info({ taskId, parentAgentId: task.parentAgentId }, 'Task cancelled')
  return c.json({ success: true })
})

// POST /api/tasks/:id/force-promote — force-start a queued task (ignoring concurrency limit)
taskRoutes.post('/:id/force-promote', async (c) => {
  const taskId = c.req.param('id')
  const task = await getTask(taskId)

  if (!task) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
  }

  const success = await forcePromoteTask(taskId)
  if (!success) {
    return c.json(
      { error: { code: 'TASK_NOT_QUEUED', message: 'Task is not in queued status' } },
      409,
    )
  }

  log.info({ taskId }, 'Task force-promoted')
  return c.json({ success: true })
})

// POST /api/tasks/:id/pause — pause a running task
taskRoutes.post('/:id/pause', async (c) => {
  const taskId = c.req.param('id')
  const task = await getTask(taskId)

  if (!task) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
  }

  const success = await pauseTask(taskId)
  if (!success) {
    return c.json(
      { error: { code: 'TASK_NOT_PAUSABLE', message: 'Task is not currently running' } },
      409,
    )
  }

  log.info({ taskId }, 'Task paused')
  return c.json({ success: true })
})

// POST /api/tasks/:id/resume — resume a paused task, optionally with a message
taskRoutes.post('/:id/resume', async (c) => {
  const taskId = c.req.param('id')
  const task = await getTask(taskId)

  if (!task) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
  }

  const body = await c.req.json().catch(() => ({}))
  const { message } = body as { message?: string }

  const success = await resumeTask(taskId, message)
  if (!success) {
    return c.json(
      { error: { code: 'TASK_NOT_PAUSED', message: 'Task is not paused' } },
      409,
    )
  }

  log.info({ taskId, withMessage: !!message?.trim() }, 'Task resumed')
  return c.json({ success: true })
})

// POST /api/tasks/:id/inject — inject a message into a running task
taskRoutes.post('/:id/inject', async (c) => {
  const taskId = c.req.param('id')
  const task = await getTask(taskId)

  if (!task) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Task not found' } }, 404)
  }

  const body = await c.req.json()
  const { content } = body as { content: string }
  if (!content?.trim()) {
    return c.json(
      { error: { code: 'EMPTY_CONTENT', message: 'Message content is required' } },
      400,
    )
  }

  const result = await injectIntoTask(taskId, content.trim())
  if (!result.success) {
    return c.json(
      { error: { code: 'INJECT_FAILED', message: result.error ?? 'Injection failed' } },
      409,
    )
  }

  log.info({ taskId, wasStreaming: result.wasStreaming }, 'Message injected into task')
  return c.json({ success: true, injected: result.wasStreaming }, 202)
})
