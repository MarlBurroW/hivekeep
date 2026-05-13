import { streamText, type Tool, type ModelMessage } from 'ai'
import { eq, and, desc, asc, inArray, like, or, sql } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { tasks, kins, messages } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { buildSystemPrompt } from '@/server/services/prompt-builder'
import {
  buildSegmentedMessages,
  markLastToolCacheable,
} from '@/server/services/llm-cache-hints'
import { resolveLLMModel, buildThinkingProviderOptions, resolveThinkingConfig, isContextTooLargeError } from '@/server/services/kin-engine'
import { toolRegistry } from '@/server/tools/index'
import { resolveMCPTools } from '@/server/services/mcp'
import { resolveCustomTools } from '@/server/services/custom-tools'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { getGlobalPrompt } from '@/server/services/app-settings'
import { wrapToolsWithSpill } from '@/server/services/tool-output-spill'
import { executeToolBatch } from '@/server/services/tool-executor'
import { recordUsage, aggregateStepUsage } from '@/server/services/token-usage'
import type { TaskStatus, TaskMode, KinToolConfig, KinThinkingConfig } from '@/shared/types'
import { guessProviderType } from '@/shared/model-ref'

const log = createLogger('tasks')

/**
 * Strip execute functions from tools so the SDK only collects tool call intents
 * without executing them. This allows our custom loop to execute tools
 * sequentially between LLM steps, preventing hallucinated tool results.
 */
function stripToolExecute(tools: Record<string, Tool>): Record<string, Tool> {
  const schemas: Record<string, Tool> = {}
  for (const [name, t] of Object.entries(tools)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { execute, ...rest } = t as Record<string, unknown>
    schemas[name] = rest as Tool
  }
  return schemas
}

// AbortController registry — one per actively-streaming task
const activeTaskAbortControllers = new Map<string, AbortController>()

/** Abort a running task stream. Returns true if a stream was actually aborted. */
export function abortTaskStream(taskId: string): boolean {
  const controller = activeTaskAbortControllers.get(taskId)
  if (!controller) return false
  controller.abort()
  activeTaskAbortControllers.delete(taskId)
  return true
}

/** Check whether a task currently has an active LLM stream. */
export function isTaskStreaming(taskId: string): boolean {
  return activeTaskAbortControllers.has(taskId)
}

// Live in-memory snapshot of the currently-streaming assistant message per task.
// The DB is only checkpointed every 500ms of text + at each tool-batch boundary,
// so a client reconnecting mid-stream would otherwise miss any text emitted
// between the last checkpoint and connect time, breaking tool-call offset
// alignment in the UI. Reading this map gives the route handler the live values.
export interface ActiveTaskStreamSnapshot {
  messageId: string
  content: string
  toolCalls: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }>
  reasoning: Array<{ offset: number; text: string }>
}

const activeTaskStreams = new Map<string, ActiveTaskStreamSnapshot>()

/** Read-only access to an in-flight task's accumulated content/tool-calls/reasoning.
 *  The returned arrays are live references held by `executeSubKin` — callers must not mutate them. */
export function getActiveTaskSnapshot(taskId: string): ActiveTaskStreamSnapshot | undefined {
  return activeTaskStreams.get(taskId)
}

/** Build a public avatar URL from a Kin's stored avatar path */
function kinAvatarUrl(kinId: string, avatarPath: string | null, updatedAt?: Date | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  const v = updatedAt ? updatedAt.getTime() : Date.now()
  return `/api/uploads/kins/${kinId}/avatar.${ext}?v=${v}`
}

// ─── Startup Recovery ────────────────────────────────────────────────────────

/**
 * Recover orphaned tasks stuck in 'pending' or 'in_progress' status.
 * This can happen after a crash or restart. Called once at worker startup.
 * Marks them as 'failed' so they don't block concurrent limits or spin forever.
 */
export function recoverStaleTasks() {
  // Note: 'awaiting_human_input' is NOT recovered — the human can still respond after restart
  // Note: 'awaiting_kin_response' IS recovered — the timeout timer is lost on restart
  // Note: 'queued' IS recovered — the promotion mechanism is lost on restart
  // Note: 'paused' IS recovered — the user context is lost on restart
  const result = sqlite.run(
    `UPDATE tasks SET status = 'failed', error = 'Interrupted by server restart', updated_at = ? WHERE status IN ('queued', 'pending', 'in_progress', 'paused', 'awaiting_kin_response')`,
    [Date.now()],
  )
  if (result.changes > 0) {
    log.warn({ count: result.changes }, 'Recovered stale tasks → marked as failed')
  }
}

// ─── Concurrency Group Helpers ───────────────────────────────────────────────

const ACTIVE_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'paused', 'awaiting_human_input', 'awaiting_kin_response']

async function countActiveTasksInGroup(group: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.concurrencyGroup, group), inArray(tasks.status, ACTIVE_STATUSES)))
    .all()
  return result[0]?.count ?? 0
}

export async function promoteNextQueuedTask(group: string, maxConcurrent: number) {
  const activeCount = await countActiveTasksInGroup(group)
  if (activeCount >= maxConcurrent) return

  // Get oldest queued task in this group
  const next = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.concurrencyGroup, group), eq(tasks.status, 'queued')))
    .orderBy(asc(tasks.queuedAt))
    .limit(1)
    .get()

  if (!next) return

  // Promote: queued → pending
  await db
    .update(tasks)
    .set({ status: 'pending', queuedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, next.id))

  // Resolve executing Kin info for SSE
  const executingKinId = next.sourceKinId ?? next.parentKinId
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  sseManager.sendToKin(next.parentKinId, {
    type: 'task:status',
    kinId: next.parentKinId,
    data: {
      taskId: next.id,
      kinId: next.parentKinId,
      status: 'pending',
      title: next.title ?? next.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
    },
  })

  log.info({ taskId: next.id, group }, 'Queued task promoted to pending')

  // Notify source Kin (for spawn_type = 'other')
  if (next.spawnType === 'other' && next.sourceKinId) {
    const taskLabel = next.title ?? next.description
    const briefDesc = next.description.length > 200
      ? next.description.slice(0, 200) + '...'
      : next.description
    notifySourceKin(next.sourceKinId, next.parentKinId, `[Task assigned: ${taskLabel}] ${briefDesc}`, next.id)
      .catch((err) => log.warn({ taskId: next.id, sourceKinId: next.sourceKinId, err }, 'Failed to notify source Kin on promote'))
  }

  // Execute the sub-Kin
  executeSubKin(next.id).catch((err) =>
    log.error({ taskId: next.id, err }, 'Sub-Kin execution error after promotion'),
  )
}

export async function forcePromoteTask(taskId: string): Promise<boolean> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'queued') return false

  await db
    .update(tasks)
    .set({ status: 'pending', queuedAt: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  const executingKinId = task.sourceKinId ?? task.parentKinId
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId: task.id,
      kinId: task.parentKinId,
      status: 'pending',
      title: task.title ?? task.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
    },
  })

  log.info({ taskId, group: task.concurrencyGroup }, 'Task force-promoted')

  if (task.spawnType === 'other' && task.sourceKinId) {
    const taskLabel = task.title ?? task.description
    const briefDesc = task.description.length > 200 ? task.description.slice(0, 200) + '...' : task.description
    notifySourceKin(task.sourceKinId, task.parentKinId, `[Task assigned: ${taskLabel}] ${briefDesc}`, task.id)
      .catch((err) => log.warn({ taskId, sourceKinId: task.sourceKinId, err }, 'Failed to notify source Kin on force-promote'))
  }

  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin execution error after force-promote'),
  )

  return true
}

// ─── Source Kin Notification ─────────────────────────────────────────────────

/**
 * Deposit an informational message in the source Kin's main session.
 * No queue entry → no LLM turn triggered.
 * Follows the same pattern as inter-kin 'inform' messages.
 * Only used for spawn_type = 'other' tasks.
 */
async function notifySourceKin(
  sourceKinId: string,
  parentKinId: string,
  content: string,
  taskId: string,
) {
  // Guard: source Kin must still exist
  const sourceKin = await db.select({ id: kins.id }).from(kins).where(eq(kins.id, sourceKinId)).get()
  if (!sourceKin) return

  const parentKin = await db
    .select({ name: kins.name })
    .from(kins)
    .where(eq(kins.id, parentKinId))
    .get()

  const msgId = uuid()
  await db.insert(messages).values({
    id: msgId,
    kinId: sourceKinId,
    role: 'user',
    content,
    sourceType: 'task',
    sourceId: parentKinId,
    metadata: JSON.stringify({ relatedTaskId: taskId, fromParentKinId: parentKinId }),
    createdAt: new Date(),
  })

  sseManager.sendToKin(sourceKinId, {
    type: 'chat:message',
    kinId: sourceKinId,
    data: {
      id: msgId,
      role: 'user',
      content,
      sourceType: 'task',
      sourceId: parentKinId,
      sourceName: parentKin?.name ?? null,
      resolvedTaskId: taskId,
      createdAt: Date.now(),
    },
  })
}

// ─── Spawn ───────────────────────────────────────────────────────────────────

interface SpawnParams {
  parentKinId: string
  title?: string
  description: string
  mode: TaskMode
  spawnType: 'self' | 'other'
  sourceKinId?: string
  model?: string
  providerId?: string
  parentTaskId?: string
  cronId?: string
  depth?: number
  allowHumanPrompt?: boolean
  channelOriginId?: string
  webhookId?: string
  thinkingConfig?: KinThinkingConfig
  concurrencyGroup?: string
  concurrencyMax?: number
}

export async function spawnTask(params: SpawnParams) {
  const depth = params.depth ?? 1

  // Check max depth
  if (depth > config.tasks.maxDepth) {
    throw new Error(`Max task depth (${config.tasks.maxDepth}) exceeded`)
  }

  // Check max concurrent
  const activeTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['pending', 'in_progress']))
    .all()

  if (activeTasks.length >= config.tasks.maxConcurrent) {
    throw new Error(`Max concurrent tasks (${config.tasks.maxConcurrent}) reached`)
  }

  const taskId = uuid()
  const now = new Date()

  // Determine initial status — if concurrency group is full, start as 'queued'
  const concurrencyGroup = params.concurrencyGroup ?? null
  const concurrencyMax = params.concurrencyMax ?? null
  let initialStatus: 'pending' | 'queued' = 'pending'

  if (concurrencyGroup && concurrencyMax) {
    const activeCount = await countActiveTasksInGroup(concurrencyGroup)
    if (activeCount >= concurrencyMax) {
      initialStatus = 'queued'
    }
  }

  await db.insert(tasks).values({
    id: taskId,
    parentKinId: params.parentKinId,
    sourceKinId: params.sourceKinId ?? null,
    spawnType: params.spawnType,
    mode: params.mode,
    model: params.model ?? null,
    providerId: params.providerId ?? null,
    title: params.title ?? null,
    description: params.description,
    status: initialStatus,
    depth,
    parentTaskId: params.parentTaskId ?? null,
    cronId: params.cronId ?? null,
    channelOriginId: params.channelOriginId ?? null,
    webhookId: params.webhookId ?? null,
    allowHumanPrompt: params.allowHumanPrompt ?? true,
    thinkingConfig: params.thinkingConfig ? JSON.stringify(params.thinkingConfig) : null,
    concurrencyGroup,
    concurrencyMax,
    queuedAt: initialStatus === 'queued' ? now : null,
    createdAt: now,
    updatedAt: now,
  })

  // Resolve executing Kin info for SSE metadata
  const executingKinId = params.sourceKinId ?? params.parentKinId
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  // Emit SSE event with metadata for live task card
  sseManager.sendToKin(params.parentKinId, {
    type: 'task:status',
    kinId: params.parentKinId,
    data: {
      taskId,
      kinId: params.parentKinId,
      status: initialStatus,
      title: params.title ?? params.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
      concurrencyGroup,
    },
  })

  log.info({ taskId, parentKinId: params.parentKinId, mode: params.mode, spawnType: params.spawnType, depth, queued: initialStatus === 'queued' }, 'Task spawned')

  // If queued, don't execute yet — will be promoted when a slot opens
  if (initialStatus === 'queued') {
    return { taskId, queued: true }
  }

  // Notify source Kin about being spawned (only for spawn_type = 'other')
  if (params.spawnType === 'other' && params.sourceKinId) {
    const taskLabel = params.title ?? params.description
    // Truncate description to avoid leaking raw prompts into the conversation UI
    const briefDesc = params.description.length > 200
      ? params.description.slice(0, 200) + '...'
      : params.description
    notifySourceKin(
      params.sourceKinId,
      params.parentKinId,
      `[Task assigned: ${taskLabel}] ${briefDesc}`,
      taskId,
    ).catch((err) => log.warn({ taskId, sourceKinId: params.sourceKinId, err }, 'Failed to notify source Kin on spawn'))
  }

  // Execute the sub-Kin in the background
  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin execution error'),
  )

  return { taskId, queued: false }
}

// ─── Sub-Kin Execution ───────────────────────────────────────────────────────

/**
 * Re-trigger sub-Kin execution after pause (e.g., human prompt response).
 * Reads accumulated message history from DB and starts a new LLM stream.
 */
export const resumeSubKin = executeSubKin

async function executeSubKin(taskId: string, isNudge = false) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return

  const parentKin = await db.select().from(kins).where(eq(kins.id, task.parentKinId)).get()
  if (!parentKin) return

  // Determine which Kin's identity to use
  let kinIdentity = parentKin
  if (task.spawnType === 'other' && task.sourceKinId) {
    const sourceKin = await db.select().from(kins).where(eq(kins.id, task.sourceKinId)).get()
    if (sourceKin) kinIdentity = sourceKin
  }

  // Update status to in_progress
  await db
    .update(tasks)
    .set({ status: 'in_progress', updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'in_progress',
      title: task.title ?? task.description,
      senderName: kinIdentity.name,
      senderAvatarUrl: kinAvatarUrl(kinIdentity.id, kinIdentity.avatarPath, kinIdentity.updatedAt),
    },
  })

  try {
    // Fetch previous cron runs for journal continuity
    const previousCronRuns = task.cronId
      ? await fetchPreviousCronRuns(task.cronId, 5)
      : undefined

    // Fetch accumulated cron learnings
    const cronLearnings = task.cronId
      ? (await import('@/server/services/cron-learnings')).fetchCronLearnings(task.cronId)
      : undefined

    // Build sub-Kin system prompt
    const globalPrompt = await getGlobalPrompt()
    const { listAvailableKins } = await import('@/server/services/inter-kin')
    const kinDirectory = await listAvailableKins(kinIdentity.id)

    const systemSegments = buildSystemPrompt({
      kin: {
        name: kinIdentity.name,
        slug: kinIdentity.slug,
        role: kinIdentity.role,
        character: kinIdentity.character,
        expertise: kinIdentity.expertise,
      },
      contacts: [],
      relevantMemories: [],
      kinDirectory,
      isSubKin: true,
      taskDescription: task.description,
      previousCronRuns,
      cronLearnings,
      globalPrompt,
      userLanguage: 'en',
      workspacePath: kinIdentity.workspacePath,
    })

    // Resolve model — use task's provider if stored, else Kin's provider when using Kin's own model
    const modelId = task.model ?? kinIdentity.model
    const preferredProvider = task.providerId ?? (task.model ? null : kinIdentity.providerId)
    const model = await resolveLLMModel(modelId, preferredProvider)
    if (!model) {
      throw new Error('No LLM provider available')
    }

    // Resolve thinking config: task-level override takes precedence over parent Kin.
    // Defaults to enabled (interleaved thinking reduces tool-result hallucinations).
    const taskThinkingConfig = resolveThinkingConfig(
      (task.thinkingConfig as string | null) ?? (kinIdentity.thinkingConfig as string | null),
    )
    const taskProviderType = guessProviderType(modelId) ?? kinIdentity.providerId ?? ''
    const taskThinkingProviderOptions = buildThinkingProviderOptions(taskProviderType, taskThinkingConfig)

    // Resolve tools: spawned Kin's full toolset (minus excluded) + sub-Kin communication tools
    const kinToolConfig: KinToolConfig | null = kinIdentity.toolConfig
      ? JSON.parse(kinIdentity.toolConfig)
      : null

    // Native tools resolved as the spawned Kin (same as a main Kin)
    const nativeTools = toolRegistry.resolve({
      kinId: kinIdentity.id,
      taskId,
      taskDepth: task.depth,
      isSubKin: false,
      channelOriginId: task.channelOriginId ?? undefined,
      cronId: task.cronId ?? undefined,
    })

    // Filter disabled native tools per Kin config (deny-list)
    if (kinToolConfig?.disabledNativeTools?.length) {
      for (const name of kinToolConfig.disabledNativeTools) {
        delete nativeTools[name]
      }
    }

    // Filter out defaultDisabled tools not explicitly opted-in
    const allRegistered = toolRegistry.list()
    const optInSet = new Set(kinToolConfig?.enabledOptInTools ?? [])
    for (const reg of allRegistered) {
      if (reg.defaultDisabled && !optInSet.has(reg.name)) {
        delete nativeTools[reg.name]
      }
    }

    // Remove tools not appropriate for sub-Kins
    const SUB_KIN_EXCLUDED_TOOLS = [
      'spawn_self', 'spawn_kin',
      'respond_to_task', 'cancel_task', 'list_tasks',
      'reply',
      'create_cron', 'update_cron', 'delete_cron', 'list_crons',
      'add_mcp_server', 'update_mcp_server', 'remove_mcp_server', 'list_mcp_servers',
      'register_tool', 'list_custom_tools',
      'create_kin', 'update_kin', 'delete_kin', 'get_kin_details',
    ]
    for (const name of SUB_KIN_EXCLUDED_TOOLS) {
      delete nativeTools[name]
    }

    // Sub-Kin-specific tools (scoped to parent for communication back)
    const subKinTools = toolRegistry.resolve({
      kinId: task.parentKinId,
      taskId,
      taskDepth: task.depth,
      isSubKin: true,
      channelOriginId: task.channelOriginId ?? undefined,
      cronId: task.cronId ?? undefined,
    })

    // MCP + custom tools for the spawned Kin
    const mcpTools = await resolveMCPTools(kinIdentity.id, kinToolConfig)
    const customToolDefs = await resolveCustomTools(kinIdentity.id)

    const tools = wrapToolsWithSpill(
      { ...nativeTools, ...subKinTools, ...mcpTools, ...customToolDefs },
      kinIdentity.workspacePath,
    )

    // Build task message history (only messages for this task)
    const taskMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.kinId, task.parentKinId), eq(messages.taskId, taskId)))
      .orderBy(asc(messages.createdAt))
      .all()

    const messageHistory: ModelMessage[] = taskMessages
      // Filter out empty assistant messages left by aborted/paused streams
      .filter((m) => !(m.role === 'assistant' && !m.content?.trim() && !m.toolCalls))
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content ?? '',
      }))

    // Add initial task instruction as user message if no history yet
    if (messageHistory.length === 0) {
      messageHistory.push({ role: 'user', content: task.description })

      // Save to DB
      const initialMsgId = uuid()
      const initialMsgCreatedAt = new Date()
      await db.insert(messages).values({
        id: initialMsgId,
        kinId: task.parentKinId,
        taskId,
        role: 'user',
        content: task.description,
        sourceType: 'system',
        createdAt: initialMsgCreatedAt,
      })

      // Notify the frontend so the task detail modal can show this message
      // immediately instead of waiting for the next fetchDetail() call.
      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:message',
        kinId: task.parentKinId,
        data: {
          id: initialMsgId,
          taskId,
          role: 'user',
          content: task.description,
          sourceType: 'system',
          createdAt: initialMsgCreatedAt.getTime(),
        },
      })
    }

    const hasTools = Object.keys(tools).length > 0

    // Execute LLM with streaming (same pattern as kin-engine)
    const assistantMessageId = uuid()
    let fullContent = ''
    const reasoningSegments: Array<{ offset: number; text: string }> = []
    let currentReasoning = ''
    const toolCallsLog: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }> = []
    let streamError: Error | null = null
    let lastCheckpointAt = Date.now()

    // In-memory snapshot for clients that connect mid-stream — see activeTaskStreams above.
    // Arrays are shared by reference so server-side mutations are visible immediately.
    const streamSnapshot: ActiveTaskStreamSnapshot = {
      messageId: assistantMessageId,
      content: '',
      toolCalls: toolCallsLog,
      reasoning: reasoningSegments,
    }
    activeTaskStreams.set(taskId, streamSnapshot)

    // Pre-insert assistant message so it's visible in fetchDetail() during streaming.
    // Content and tool calls will be updated when the stream completes.
    const assistantMsgCreatedAt = new Date()
    await db.insert(messages).values({
      id: assistantMessageId,
      kinId: task.parentKinId,
      taskId,
      role: 'assistant',
      content: '',
      sourceType: 'kin',
      sourceId: kinIdentity.id,
      createdAt: assistantMsgCreatedAt,
    })

    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:message',
      kinId: task.parentKinId,
      data: {
        id: assistantMessageId,
        taskId,
        role: 'assistant',
        content: '',
        sourceType: 'kin',
        sourceId: kinIdentity.id,
        createdAt: assistantMsgCreatedAt.getTime(),
      },
    })

    // Create an AbortController so the stream can be cancelled from outside
    const abortController = new AbortController()
    activeTaskAbortControllers.set(taskId, abortController)

    // Strip execute functions from tools so the SDK only collects intents
    // (we execute tools ourselves between steps), then mark the last tool as
    // cache-eligible for Anthropic prompt caching.
    const toolSchemas = hasTools ? markLastToolCacheable(stripToolExecute(tools)) : undefined

    const maxSteps = hasTools ? (config.tools.maxSteps > 0 ? config.tools.maxSteps : 100) : 1
    const stepResults: Array<ReturnType<typeof streamText>> = []
    let silentStopAfterTools = false

    let step = 0
    for (; step < maxSteps; step++) {
      if (abortController.signal.aborted) break

      const result = streamText({
        model,
        messages: buildSegmentedMessages(systemSegments, messageHistory),
        tools: toolSchemas,
        abortSignal: abortController.signal,
        ...(taskThinkingProviderOptions ? { providerOptions: taskThinkingProviderOptions as any } : {}),
      })
      stepResults.push(result)

      // Collect tool call intents from this step
      const stepToolCalls: Array<{ id: string; name: string; args: unknown; offset: number }> = []
      // Per-step text. fullContent keeps accumulating across steps for
      // persistence, offset math, and UI rendering, but only stepText is
      // pushed into the assistant history block so the model never sees
      // its own prior-step narration repeated back to it.
      let stepText = ''

      try {
        for await (const part of result.fullStream) {
          // Handle tool-call-streaming-start (not yet in AI SDK type union)
          if ((part.type as string) === 'tool-call-streaming-start') {
            const p = part as unknown as { toolCallId: string; toolName: string }
            sseManager.sendToKin(task.parentKinId, {
              type: 'chat:tool-call-start',
              kinId: task.parentKinId,
              data: {
                messageId: assistantMessageId,
                toolCallId: p.toolCallId,
                toolName: p.toolName,
                contentOffset: fullContent.length,
                taskId,
              },
            })
            continue
          }

          // Handle reasoning/thinking stream parts
          if ((part.type as string) === 'reasoning-start') {
            currentReasoning = ''
            continue
          }
          if ((part.type as string) === 'reasoning-delta') {
            const p = part as unknown as { text: string }
            currentReasoning += p.text
            sseManager.sendToKin(task.parentKinId, {
              type: 'chat:reasoning-token',
              kinId: task.parentKinId,
              data: { messageId: assistantMessageId, token: p.text, taskId },
            })
            continue
          }
          if ((part.type as string) === 'reasoning-end') {
            if (currentReasoning) {
              reasoningSegments.push({ offset: fullContent.length, text: currentReasoning })
              currentReasoning = ''
            }
            sseManager.sendToKin(task.parentKinId, {
              type: 'chat:reasoning-done',
              kinId: task.parentKinId,
              data: { messageId: assistantMessageId, taskId },
            })
            continue
          }

          switch (part.type) {
            case 'text-delta': {
              fullContent += part.text
              stepText += part.text
              streamSnapshot.content = fullContent
              sseManager.sendToKin(task.parentKinId, {
                type: 'chat:token',
                kinId: task.parentKinId,
                data: { messageId: assistantMessageId, token: part.text, taskId, contentLength: fullContent.length },
              })

              // Periodic checkpoint: persist partial content every 500ms so a page
              // refresh can show accumulated text instead of an empty message.
              const now = Date.now()
              if (now - lastCheckpointAt >= 500) {
                lastCheckpointAt = now
                db.update(messages)
                  .set({
                    content: fullContent,
                    toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
                  })
                  .where(eq(messages.id, assistantMessageId))
                  .then(() => {}, () => {})
              }
              break
            }
            case 'tool-call': {
              const contentOffset = fullContent.length
              stepToolCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: part.input,
                offset: contentOffset,
              })
              sseManager.sendToKin(task.parentKinId, {
                type: 'chat:tool-call',
                kinId: task.parentKinId,
                data: {
                  messageId: assistantMessageId,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.input,
                  contentOffset,
                  taskId,
                },
              })
              break
            }
          }
        }
      } catch (err) {
        // If the stream was aborted (user cancelled), handle gracefully
        if (abortController.signal.aborted) {
          log.info({ taskId }, 'Sub-Kin stream aborted by cancellation')
        } else {
          streamError = err instanceof Error ? err : new Error(String(err))
        }
      }

      // No tool calls this step or error/abort → exit loop.
      // Silent-stop detection: provider closed the stream with no text and no
      // tool calls at this step, AFTER at least one prior tool batch executed
      // and the overall turn produced no text either. Surface a fallback below
      // so the task doesn't end with an empty assistant row.
      if (stepToolCalls.length === 0 || streamError || abortController.signal.aborted) {
        if (
          !streamError &&
          !abortController.signal.aborted &&
          toolCallsLog.length > 0 &&
          fullContent.length === 0
        ) {
          silentStopAfterTools = true
        }
        break
      }

      // Build assistant content for history
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      if (stepText) assistantContent.push({ type: 'text', text: stepText })
      for (const tc of stepToolCalls) {
        assistantContent.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args })
      }

      // Execute tool calls (concurrently if all read-only, sequentially otherwise)
      const batch = await executeToolBatch({
        stepToolCalls,
        tools,
        abortController,
        kinId: task.parentKinId,
        assistantMessageId,
        sseExtra: { taskId },
      })
      toolCallsLog.push(...batch.toolCallsLog)

      // Checkpoint: persist partial content + tool calls so a page refresh
      // can show progress instead of an empty message.
      if (batch.toolCallsLog.length > 0) {
        await db.update(messages)
          .set({
            content: fullContent,
            toolCalls: JSON.stringify(toolCallsLog),
          })
          .where(eq(messages.id, assistantMessageId))
      }

      if (batch.wasAborted) break

      // Nudge: if this is a cron task and a tool returned an error, hint about save_run_learning
      if (task.cronId) {
        for (const tr of batch.toolResults) {
          const val = tr.output.value as Record<string, unknown> | null
          if (val && typeof val === 'object' && 'error' in val) {
            (val as Record<string, unknown>)._hint = 'If this error reveals something useful for future runs, use save_run_learning() to record it.'
          }
        }
      }

      // Append assistant message (with tool calls) + tool results to history for next step
      messageHistory.push({ role: 'assistant', content: assistantContent })
      messageHistory.push({ role: 'tool' as const, content: batch.toolResults })

      // Text accumulates across steps so tool call offsets remain valid
    }

    activeTaskAbortControllers.delete(taskId)
    activeTaskStreams.delete(taskId)

    // Aggregate token usage (awaited so we can persist in metadata + SSE)
    const taskModelId = task.model ?? kinIdentity.model
    const taskProviderId = task.providerId ?? (task.model ? null : kinIdentity.providerId)
    const tokenUsage = await aggregateStepUsage(stepResults)

    // Fire-and-forget: record to llm_usage table for analytics
    if (tokenUsage) {
      recordUsage({
        callSite: 'task',
        callType: 'stream-text',
        providerType: guessProviderType(taskModelId),
        providerId: taskProviderId,
        modelId: taskModelId,
        kinId: task.parentKinId,
        taskId,
        cronId: task.cronId ?? null,
        usage: {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
          inputTokenDetails: { cacheReadTokens: tokenUsage.cacheReadTokens ?? 0, cacheWriteTokens: tokenUsage.cacheWriteTokens ?? 0 },
          outputTokenDetails: { reasoningTokens: tokenUsage.reasoningTokens ?? 0 },
        },
        stepCount: stepResults.length,
      })
    }

    // If the stream was aborted (cancel/pause), persist partial content and stop
    if (abortController.signal.aborted) {
      if (fullContent || toolCallsLog.length > 0) {
        // Save the partial response so it's visible in the task history
        await db.update(messages)
          .set({
            content: fullContent || '',
            toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
          })
          .where(eq(messages.id, assistantMessageId))
      } else {
        // No content was generated — delete the pre-inserted empty assistant message
        // to avoid polluting the message history on resume
        await db.delete(messages).where(eq(messages.id, assistantMessageId))
      }

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:done',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, content: fullContent, taskId },
      })
      return
    }

    // If the stream errored, fail the task immediately
    if (streamError) {
      log.error({ taskId, error: streamError.message }, 'Sub-Kin stream error')

      // Update pre-inserted assistant message with partial content from the error
      await db.update(messages)
        .set({
          content: fullContent || '',
          toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        })
        .where(eq(messages.id, assistantMessageId))

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:done',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, content: fullContent, taskId },
      })

      const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (currentTask && currentTask.status === 'in_progress') {
        await resolveTask(taskId, 'failed', undefined, streamError.message)
      }
      return
    }

    // Surface silent-stop: provider closed the stream with no text after
    // tool execution. Produce a fallback so the task row is not persisted
    // as empty (Anthropic also rejects empty text content blocks on the
    // next turn, which would block the conversation entirely).
    if (silentStopAfterTools) {
      log.warn(
        { taskId, messageId: assistantMessageId, toolCalls: toolCallsLog.length, step },
        'Sub-Kin: LLM closed stream with no text after tool execution (silent stop)',
      )
      fullContent = `*(This task executed ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} but the model did not produce a final response. This can happen on very large contexts. Retry with a tighter scope or ask the Kin to continue.)*`
      streamSnapshot.content = fullContent
      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:token',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, token: fullContent, taskId, contentLength: fullContent.length },
      })
    }

    // Detect silent provider failures: stream completed but produced no output at all
    if (!fullContent && toolCallsLog.length === 0) {
      log.warn({ taskId }, 'Sub-Kin stream produced no output — treating as failure')

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:done',
        kinId: task.parentKinId,
        data: { messageId: assistantMessageId, content: '', taskId },
      })

      const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (currentTask && currentTask.status === 'in_progress') {
        await resolveTask(taskId, 'failed', undefined, 'LLM returned empty response')
      }
      return
    }

    const responseText = fullContent

    // Update the pre-inserted assistant message with final content, tool calls, and token usage
    await db.update(messages)
      .set({
        content: responseText,
        toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        reasoning: reasoningSegments.length > 0 ? JSON.stringify(reasoningSegments) : null,
        ...(tokenUsage ? { metadata: JSON.stringify({ tokenUsage }) } : {}),
      })
      .where(eq(messages.id, assistantMessageId))

    // Emit chat:done so the frontend knows streaming is over
    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:done',
      kinId: task.parentKinId,
      data: { messageId: assistantMessageId, content: responseText, taskId, ...(tokenUsage ? { tokenUsage } : {}) },
    })

    // If the task was suspended for an inter-Kin response, don't nudge — just return
    const currentTask = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (currentTask && currentTask.status === 'awaiting_kin_response') {
      log.info({ taskId }, 'Sub-Kin suspended awaiting inter-Kin response')
      return
    }

    // If the Kin didn't explicitly resolve the task via update_task_status(),
    // give it one more chance (nudge turn) before marking as failed.
    if (currentTask && currentTask.status === 'in_progress') {
      if (!isNudge) {
        // First attempt — inject a reminder and re-run one more LLM turn
        log.info({ taskId }, 'Sub-Kin finished without calling update_task_status — sending nudge turn')

        await db.insert(messages).values({
          id: uuid(),
          kinId: task.parentKinId,
          taskId,
          role: 'user',
          content:
            '[System] You have not called update_task_status() yet. ' +
            'You MUST finalize this task now:\n' +
            '- Call update_task_status("completed", "<summary of what you accomplished>") if the task is done.\n' +
            '- Call update_task_status("failed", undefined, "<reason>") if you could not complete it.\n' +
            'Do this immediately.',
          sourceType: 'system',
          createdAt: new Date(),
        })

        await executeSubKin(taskId, true)
      } else {
        // Already nudged once — now fail for real
        log.warn({ taskId }, 'Sub-Kin still did not call update_task_status after nudge — marking as failed')
        await resolveTask(taskId, 'failed', undefined, 'Task did not explicitly report completion')
      }
    }
  } catch (err) {
    activeTaskStreams.delete(taskId)
    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
    log.error({ taskId, error: errorMsg }, 'Sub-Kin execution failed')
    // Sub-Kins / tasks have their own ephemeral message stream and don't
    // share the parent's compacting summaries — there's no automatic
    // recovery path here, so override the generic "compaction triggered"
    // friendly message (which would lie) with task-specific guidance.
    const displayError = isContextTooLargeError(errorMsg)
      ? `This task got too long for the model's context window. Retry with a tighter scope or split into smaller sub-tasks.`
      : errorMsg
    await resolveTask(taskId, 'failed', undefined, displayError)
  }
}

// ─── Task Resolution ─────────────────────────────────────────────────────────

export async function resolveTask(
  taskId: string,
  status: 'completed' | 'failed',
  result?: string,
  error?: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return

  // The Kin that actually executed the task (target Kin for 'other', parent for 'self')
  const executingKinId = task.sourceKinId ?? task.parentKinId

  log.info({ taskId, status, mode: task.mode }, 'Task resolved')

  // Close any browser sessions opened by this task (best-effort, non-blocking)
  import('@/server/services/playwright-manager')
    .then(({ playwrightManager }) => playwrightManager.closeSessionsForTask(taskId))
    .catch((err) => log.warn({ taskId, err }, 'Failed to close browser sessions for task'))

  await db
    .update(tasks)
    .set({
      status,
      result: result ?? null,
      error: error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  // Resolve executing Kin info for SSE metadata
  const executingKin = await db.select().from(kins).where(eq(kins.id, executingKinId)).get()

  // Emit SSE
  sseManager.sendToKin(task.parentKinId, {
    type: 'task:done',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status,
      result: result ?? null,
      error: error ?? null,
      title: task.title ?? task.description,
      senderName: executingKin?.name ?? null,
      senderAvatarUrl: kinAvatarUrl(executingKinId, executingKin?.avatarPath ?? null, executingKin?.updatedAt),
    },
  })

  // Use title for UI display, fall back to description
  const taskLabel = task.title ?? task.description

  // Notify source Kin about task completion/failure (only for spawn_type = 'other')
  if (task.spawnType === 'other' && task.sourceKinId) {
    const sourceMsg = status === 'completed'
      ? `[Task completed: ${taskLabel}] ${result ?? ''}`
      : `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`
    notifySourceKin(task.sourceKinId, task.parentKinId, sourceMsg, taskId)
      .catch((err) => log.warn({ taskId, sourceKinId: task.sourceKinId, err }, 'Failed to notify source Kin on resolve'))
  }

  const taskMetadata = JSON.stringify({ resolvedTaskId: taskId })

  // If await mode, deposit result (or failure) in parent's queue
  if (task.mode === 'await' && status === 'completed' && result) {
    await enqueueMessage({
      kinId: task.parentKinId,
      messageType: 'task_result',
      content: `[Task: ${taskLabel}] Result: ${result}`,
      sourceType: 'task',
      sourceId: executingKinId,
      priority: config.queue.taskPriority,
      taskId, // Used by kin-engine to set metadata.resolvedTaskId on the message
      channelOriginId: task.channelOriginId ?? undefined,
    })
  } else if (task.mode === 'await' && status === 'failed') {
    await enqueueMessage({
      kinId: task.parentKinId,
      messageType: 'task_result',
      content: `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`,
      sourceType: 'task',
      sourceId: executingKinId,
      priority: config.queue.taskPriority,
      taskId,
      channelOriginId: task.channelOriginId ?? undefined,
    })
  } else if (task.mode === 'async' && status === 'completed' && result) {
    // Async mode: deposit as informational message (no queue entry)
    const msgId = uuid()
    await db.insert(messages).values({
      id: msgId,
      kinId: task.parentKinId,
      role: 'user',
      content: `[Task completed: ${taskLabel}] ${result}`,
      sourceType: 'task',
      sourceId: executingKinId,
      metadata: taskMetadata,
      createdAt: new Date(),
    })

    // Notify via SSE
    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:message',
      kinId: task.parentKinId,
      data: {
        id: msgId,
        role: 'user',
        content: `[Task completed: ${taskLabel}] ${result}`,
        sourceType: 'task',
        sourceId: executingKinId,
        resolvedTaskId: taskId,
        createdAt: Date.now(),
      },
    })
  } else if (task.mode === 'async' && status === 'failed') {
    const failureContent = `[Task failed: ${taskLabel}] Error: ${error ?? 'Unknown error'}`

    if (task.cronId) {
      // Cron-triggered failures are actionable — enqueue so the owner Kin reacts
      await enqueueMessage({
        kinId: task.parentKinId,
        messageType: 'task_result',
        content: failureContent,
        sourceType: 'task',
        sourceId: executingKinId,
        priority: config.queue.taskPriority,
        taskId,
        channelOriginId: task.channelOriginId ?? undefined,
      })
    } else {
      // Non-cron async failure: deposit as informational message (no turn)
      const msgId = uuid()
      await db.insert(messages).values({
        id: msgId,
        kinId: task.parentKinId,
        role: 'user',
        content: failureContent,
        sourceType: 'task',
        sourceId: executingKinId,
        metadata: taskMetadata,
        createdAt: new Date(),
      })

      sseManager.sendToKin(task.parentKinId, {
        type: 'chat:message',
        kinId: task.parentKinId,
        data: {
          id: msgId,
          role: 'user',
          content: failureContent,
          sourceType: 'task',
          sourceId: executingKinId,
          resolvedTaskId: taskId,
          createdAt: Date.now(),
        },
      })
    }
  }

  // Promote next queued task in the same concurrency group
  if (task.concurrencyGroup && task.concurrencyMax) {
    promoteNextQueuedTask(task.concurrencyGroup, task.concurrencyMax).catch((err) =>
      log.error({ taskId, group: task.concurrencyGroup, err }, 'Failed to promote next queued task'),
    )
  }
}

// ─── Task Operations ─────────────────────────────────────────────────────────

export async function cancelTask(taskId: string, kinId: string) {
  const task = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.parentKinId, kinId)))
    .get()

  if (!task) return false
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
    return false
  }

  // Abort the running LLM stream if any
  const controller = activeTaskAbortControllers.get(taskId)
  if (controller) {
    controller.abort()
    activeTaskAbortControllers.delete(taskId)
  }

  // Cancel any pending human prompts for this task
  const { cancelPendingPromptsForTask } = await import('@/server/services/human-prompts')
  await cancelPendingPromptsForTask(taskId)

  // Clear any pending inter-Kin timeout timer
  const interKinTimer = interKinTimeouts.get(taskId)
  if (interKinTimer) {
    clearTimeout(interKinTimer)
    interKinTimeouts.delete(taskId)
  }

  await db
    .update(tasks)
    .set({ status: 'cancelled', pendingRequestId: null, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  sseManager.sendToKin(kinId, {
    type: 'task:status',
    kinId,
    data: {
      taskId,
      kinId,
      status: 'cancelled',
      title: task.title ?? task.description,
    },
  })

  // Notify source Kin about cancellation (only for spawn_type = 'other')
  if (task.spawnType === 'other' && task.sourceKinId) {
    const taskLabel = task.title ?? task.description
    notifySourceKin(
      task.sourceKinId,
      kinId,
      `[Task cancelled: ${taskLabel}]`,
      task.id,
    ).catch((err) => log.warn({ taskId: task.id, sourceKinId: task.sourceKinId, err }, 'Failed to notify source Kin on cancel'))
  }

  // Promote next queued task in the same concurrency group
  if (task.concurrencyGroup && task.concurrencyMax) {
    promoteNextQueuedTask(task.concurrencyGroup, task.concurrencyMax).catch((err) =>
      log.error({ taskId, group: task.concurrencyGroup, err }, 'Failed to promote next queued task after cancel'),
    )
  }

  return true
}

export async function getTask(taskId: string) {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).get()
}

export async function listKinTasks(kinId: string, statusFilter?: TaskStatus) {
  const conditions = [eq(tasks.parentKinId, kinId)]
  if (statusFilter) conditions.push(eq(tasks.status, statusFilter))

  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(desc(tasks.createdAt))
    .all()
}

/** List tasks where this Kin was the executing source (spawned by another Kin). */
export async function listSourceKinTasks(kinId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.sourceKinId, kinId), eq(tasks.spawnType, 'other')))
    .orderBy(desc(tasks.createdAt))
    .all()
}

export async function listAllTasks(statusFilter?: TaskStatus) {
  const conditions = statusFilter ? [eq(tasks.status, statusFilter)] : []

  return db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(tasks.createdAt))
    .all()
}

interface ListTasksPaginatedParams {
  status?: TaskStatus
  kinId?: string
  cronId?: string
  search?: string
  limit: number
  offset: number
}

export async function listTasksPaginated(params: ListTasksPaginatedParams) {
  const { status, kinId, cronId, search, limit, offset } = params
  const conditions: ReturnType<typeof eq>[] = []

  if (status) conditions.push(eq(tasks.status, status))
  if (kinId) conditions.push(eq(tasks.parentKinId, kinId))
  if (cronId) conditions.push(eq(tasks.cronId, cronId))
  if (search) {
    const pattern = `%${search}%`
    conditions.push(or(like(tasks.title, pattern), like(tasks.description, pattern))!)
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(whereClause)
    .all()

  const total = countResult[0]?.count ?? 0

  const rows = await db
    .select()
    .from(tasks)
    .where(whereClause)
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .offset(offset)
    .all()

  return { tasks: rows, total }
}

// ─── Cron Journal ────────────────────────────────────────────────────────────

export async function fetchPreviousCronRuns(cronId: string, limit = 5) {
  return db
    .select({
      status: tasks.status,
      result: tasks.result,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(and(
      eq(tasks.cronId, cronId),
      inArray(tasks.status, ['completed', 'failed']),
    ))
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .all()
}

// ─── Sub-Kin Operations ──────────────────────────────────────────────────────

export async function reportToParent(taskId: string, message: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return false

  // Save the report as a message in the task's message history
  await db.insert(messages).values({
    id: uuid(),
    kinId: task.parentKinId,
    taskId,
    role: 'assistant',
    content: message,
    sourceType: 'task',
    sourceId: taskId,
    createdAt: new Date(),
  })

  return true
}

export async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'completed' | 'failed',
  result?: string,
  error?: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  if (status === 'completed' || status === 'failed') {
    await resolveTask(taskId, status, result, error)
  } else {
    await db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))

    sseManager.sendToKin(task.parentKinId, {
      type: 'task:status',
      kinId: task.parentKinId,
      data: { taskId, kinId: task.parentKinId, status },
    })
  }

  return true
}

export async function requestInput(taskId: string, question: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return { success: false, error: 'Task not active' }

  if (task.requestInputCount >= config.tasks.maxRequestInput) {
    return {
      success: false,
      error: `Max request_input limit (${config.tasks.maxRequestInput}) reached`,
    }
  }

  // Increment counter
  await db
    .update(tasks)
    .set({ requestInputCount: task.requestInputCount + 1, updatedAt: new Date() })
    .where(eq(tasks.id, taskId))

  // Deposit question in parent's queue
  await enqueueMessage({
    kinId: task.parentKinId,
    messageType: 'task_input',
    content: `[Task "${task.description}" asks]: ${question}`,
    sourceType: 'task',
    sourceId: taskId,
    priority: config.queue.taskPriority,
    taskId,
  })

  return { success: true }
}

export async function respondToTask(taskId: string, answer: string) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') return false

  // Inject answer into sub-Kin's message history
  await db.insert(messages).values({
    id: uuid(),
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: `[Parent response]: ${answer}`,
    sourceType: 'system',
    createdAt: new Date(),
  })

  // Re-trigger sub-Kin execution
  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin re-execution error'),
  )

  return true
}

// ─── Inter-Kin Request Suspension ───────────────────────────────────────────

/**
 * Suspend a sub-Kin task while it waits for another Kin to reply.
 * Called from the `send_message` tool when `type === 'request'` in sub-Kin context.
 */
export async function suspendTaskForKinResponse(
  taskId: string,
  requestId: string,
) {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task || task.status !== 'in_progress') {
    return { success: false as const, error: 'Task not active' }
  }

  if (task.interKinRequestCount >= config.tasks.maxInterKinRequests) {
    return {
      success: false as const,
      error: `Max inter-Kin request limit (${config.tasks.maxInterKinRequests}) reached for this task`,
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'awaiting_kin_response',
      pendingRequestId: requestId,
      interKinRequestCount: task.interKinRequestCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'awaiting_kin_response',
      title: task.title ?? task.description,
    },
  })

  scheduleInterKinTimeout(taskId, requestId)

  return { success: true as const }
}

/** Active timeout timers for inter-Kin requests, keyed by taskId */
const interKinTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule a timeout that resumes the task if no inter-Kin reply arrives in time.
 */
function scheduleInterKinTimeout(taskId: string, requestId: string) {
  const timer = setTimeout(async () => {
    interKinTimeouts.delete(taskId)
    try {
      // Atomic claim: only one path (timeout or reply) can transition the task
      const result = sqlite.run(
        `UPDATE tasks SET status = 'in_progress', pending_request_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_kin_response' AND pending_request_id = ?`,
        [Date.now(), taskId, requestId],
      )
      if (result.changes === 0) return // Already resumed, cancelled, or different request

      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
      if (!task) return

      log.info({ taskId, requestId }, 'Inter-Kin response timeout — resuming task')

      await db.insert(messages).values({
        id: uuid(),
        kinId: task.parentKinId,
        taskId,
        role: 'user',
        content: '[System] The inter-Kin request timed out — no response was received. Continue your task without this information or try an alternative approach.',
        sourceType: 'system',
        createdAt: new Date(),
      })

      sseManager.sendToKin(task.parentKinId, {
        type: 'task:status',
        kinId: task.parentKinId,
        data: {
          taskId,
          kinId: task.parentKinId,
          status: 'in_progress',
          title: task.title ?? task.description,
        },
      })

      executeSubKin(taskId).catch((err) =>
        log.error({ taskId, err }, 'Sub-Kin resume error after inter-Kin timeout'),
      )
    } catch (err) {
      log.error({ taskId, err }, 'Inter-Kin timeout handler error')
    }
  }, config.tasks.interKinResponseTimeoutMs)
  interKinTimeouts.set(taskId, timer)
}

/**
 * Resume a sub-Kin task after receiving an inter-Kin reply.
 * Called from the inter-Kin service when a reply matches a suspended task.
 */
export async function resumeTaskFromKinResponse(
  taskId: string,
  senderKinId: string,
  senderName: string,
  replyMessage: string,
) {
  // Atomic claim: only one path (timeout or reply) can transition the task
  const result = sqlite.run(
    `UPDATE tasks SET status = 'in_progress', pending_request_id = NULL, updated_at = ? WHERE id = ? AND status = 'awaiting_kin_response'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  // Clear the timeout timer since we got the reply
  const timer = interKinTimeouts.get(taskId)
  if (timer) {
    clearTimeout(timer)
    interKinTimeouts.delete(taskId)
  }

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  // Inject reply into task's message history
  await db.insert(messages).values({
    id: uuid(),
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: `[Inter-Kin response from ${senderName}]: ${replyMessage}`,
    sourceType: 'kin',
    sourceId: senderKinId,
    createdAt: new Date(),
  })

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'in_progress',
      title: task.title ?? task.description,
    },
  })

  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin resume error after inter-Kin reply'),
  )

  return true
}

// ─── User Task Control (Pause / Resume / Inject) ────────────────────────────

/**
 * Pause a running task: abort the LLM stream and set status to 'paused'.
 * Only works on tasks with status 'in_progress'.
 */
export async function pauseTask(taskId: string): Promise<boolean> {
  // Atomically check and update status
  const result = sqlite.run(
    `UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'in_progress'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  // Abort the running LLM stream
  abortTaskStream(taskId)

  // Fetch task for SSE notification
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (task) {
    sseManager.sendToKin(task.parentKinId, {
      type: 'task:status',
      kinId: task.parentKinId,
      data: {
        taskId,
        kinId: task.parentKinId,
        status: 'paused',
        title: task.title ?? task.description,
      },
    })
  }

  log.info({ taskId }, 'Task paused by user')
  return true
}

/**
 * Resume a paused task, optionally injecting a user message before restarting.
 * Only works on tasks with status 'paused'.
 */
export async function resumeTask(taskId: string, message?: string): Promise<boolean> {
  // Atomically check and update status
  const result = sqlite.run(
    `UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'paused'`,
    [Date.now(), taskId],
  )
  if (result.changes === 0) return false

  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return false

  // Insert a user message so the LLM history doesn't end with the partial assistant response.
  // Without this, the LLM sees the last message as an assistant message and returns empty.
  const msgId = uuid()
  const userContent = message?.trim()
    ? message.trim() + '\n\n[The user sent this message while the task was paused. Take it into account and continue.]'
    : '[System] The task was paused by the user and has now been resumed. Continue where you left off.'
  const displayContent = message?.trim() || undefined

  await db.insert(messages).values({
    id: msgId,
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: userContent,
    sourceType: message?.trim() ? 'user' : 'system',
    createdAt: new Date(),
  })

  if (displayContent) {
    sseManager.sendToKin(task.parentKinId, {
      type: 'chat:message',
      kinId: task.parentKinId,
      data: {
        id: msgId,
        role: 'user',
        content: displayContent,
        sourceType: 'user',
        taskId,
        createdAt: new Date().toISOString(),
      },
    })
  }

  sseManager.sendToKin(task.parentKinId, {
    type: 'task:status',
    kinId: task.parentKinId,
    data: {
      taskId,
      kinId: task.parentKinId,
      status: 'in_progress',
      title: task.title ?? task.description,
    },
  })

  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin resume error after user resume'),
  )

  log.info({ taskId, withMessage: !!message?.trim() }, 'Task resumed by user')
  return true
}

/**
 * Inject a message into a running task: abort the stream, insert the user message,
 * and restart execution. Like /btw but for tasks.
 * Only works on tasks with status 'in_progress'.
 */
export async function injectIntoTask(taskId: string, content: string): Promise<{ success: boolean; wasStreaming: boolean; error?: string }> {
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return { success: false, wasStreaming: false, error: 'Task not found' }
  if (task.status !== 'in_progress') return { success: false, wasStreaming: false, error: 'Task is not running' }

  // Abort the running LLM stream
  const wasStreaming = abortTaskStream(taskId)

  // Insert the user message into the task's message history
  const msgId = uuid()
  await db.insert(messages).values({
    id: msgId,
    kinId: task.parentKinId,
    taskId,
    role: 'user',
    content: content + '\n\n[The user sent this additional context while you were in the middle of working. Take it into account and continue.]',
    sourceType: 'user',
    createdAt: new Date(),
  })

  sseManager.sendToKin(task.parentKinId, {
    type: 'chat:message',
    kinId: task.parentKinId,
    data: {
      id: msgId,
      role: 'user',
      content,
      sourceType: 'user',
      taskId,
      createdAt: new Date().toISOString(),
    },
  })

  // Restart execution with the new context
  executeSubKin(taskId).catch((err) =>
    log.error({ taskId, err }, 'Sub-Kin resume error after inject'),
  )

  log.info({ taskId, wasStreaming }, 'Message injected into task by user')
  return { success: true, wasStreaming }
}
