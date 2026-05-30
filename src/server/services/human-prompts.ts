import { eq, and } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { humanPrompts, tasks, messages } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { enqueueMessage } from '@/server/services/queue'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { HumanPromptOption, HumanPromptType } from '@/shared/types'

const log = createLogger('human-prompts')

// ─── Create ─────────────────────────────────────────────────────────────────

interface CreatePromptParams {
  kinId: string
  taskId?: string
  messageId?: string
  promptType: HumanPromptType
  question: string
  description?: string
  options: HumanPromptOption[]
}

export async function createHumanPrompt(params: CreatePromptParams) {
  const promptId = uuid()

  await db.insert(humanPrompts).values({
    id: promptId,
    kinId: params.kinId,
    taskId: params.taskId ?? null,
    messageId: params.messageId ?? null,
    promptType: params.promptType,
    question: params.question,
    description: params.description ?? null,
    options: JSON.stringify(params.options),
    status: 'pending',
    createdAt: new Date(),
  })

  // If task context, update task status to awaiting_human_input
  if (params.taskId) {
    const task = await db.select().from(tasks).where(eq(tasks.id, params.taskId)).get()
    if (task) {
      await db
        .update(tasks)
        .set({ status: 'awaiting_human_input', updatedAt: new Date() })
        .where(eq(tasks.id, params.taskId))

      sseManager.sendToKin(task.parentKinId, {
        type: 'task:status',
        kinId: task.parentKinId,
        data: {
          taskId: params.taskId,
          kinId: task.parentKinId,
          status: 'awaiting_human_input',
          title: task.title ?? task.description,
        },
      })

      // The task just left the global executing set (awaiting_human_input is
      // idle) → a slot freed. Drive the global queue so a waiting task can run
      // while this one blocks on a human. Dynamic import avoids a tasks ↔
      // human-prompts circular import at module load.
      import('@/server/services/tasks')
        .then(({ promoteGlobalQueue }) =>
          promoteGlobalQueue().catch((err) =>
            log.error({ taskId: params.taskId, err }, 'Failed to promote global queue after human-prompt suspend'),
          ),
        )
        .catch((err) => log.error({ taskId: params.taskId, err }, 'Failed to load tasks for global promote'))
    }
  }

  // Emit prompt:pending SSE event
  sseManager.sendToKin(params.kinId, {
    type: 'prompt:pending',
    kinId: params.kinId,
    data: {
      promptId,
      kinId: params.kinId,
      taskId: params.taskId ?? null,
      promptType: params.promptType,
      question: params.question,
      description: params.description ?? null,
      options: params.options,
    },
  })

  // Persistent notification for action-required
  const { createNotification } = await import('@/server/services/notifications')
  const taskTitle = params.taskId
    ? (await db.select({ title: tasks.title, description: tasks.description }).from(tasks).where(eq(tasks.id, params.taskId)).get())
    : null
  createNotification({
    type: 'prompt:pending',
    title: taskTitle
      ? `Task needs your input: ${taskTitle.title ?? taskTitle.description ?? 'Unnamed task'}`
      : 'Kin needs your input',
    body: params.question,
    kinId: params.kinId,
    relatedId: promptId,
    relatedType: 'prompt',
  }).catch(() => {}) // fire-and-forget

  log.info({ promptId, kinId: params.kinId, taskId: params.taskId, promptType: params.promptType }, 'Human prompt created')

  return { promptId }
}

// ─── Respond ────────────────────────────────────────────────────────────────

export async function respondToHumanPrompt(promptId: string, response: unknown, userId?: string) {
  const prompt = await db.select().from(humanPrompts).where(eq(humanPrompts.id, promptId)).get()
  if (!prompt) return { success: false as const, error: 'Prompt not found' }
  if (prompt.status !== 'pending') return { success: false as const, error: 'Prompt is no longer pending' }

  const options: HumanPromptOption[] = JSON.parse(prompt.options)
  const validationError = validateResponse(prompt.promptType, response, options)
  if (validationError) return { success: false as const, error: validationError }

  // Late-response guard: if the prompt is attached to a task that already
  // reached a terminal state (the agent decided to proceed without the
  // answer, or the task was cancelled / failed independently), we must NOT
  // resurrect that task. Mark the prompt as `expired` and bail. The caller
  // surfaces the explicit error code so the UI can render "too late".
  // Observed on prod task `4e4f1760` (ticket #22): the agent finished at
  // 11:58 without waiting, then a response at 13:13 force-reset the task
  // to in_progress and ran a second time.
  if (prompt.taskId) {
    const linkedTask = await db.select().from(tasks).where(eq(tasks.id, prompt.taskId)).get()
    if (linkedTask && (linkedTask.status === 'completed' || linkedTask.status === 'failed' || linkedTask.status === 'cancelled')) {
      await db
        .update(humanPrompts)
        .set({
          response: JSON.stringify(response),
          status: 'expired',
          respondedAt: new Date(),
        })
        .where(eq(humanPrompts.id, promptId))
      log.warn(
        { promptId, taskId: prompt.taskId, taskStatus: linkedTask.status },
        'Human prompt answered after the task already reached a terminal state — marking prompt expired without resuming the task',
      )
      sseManager.sendToKin(prompt.kinId, {
        type: 'prompt:expired',
        kinId: prompt.kinId,
        data: {
          promptId,
          kinId: prompt.kinId,
          taskId: prompt.taskId,
          taskStatus: linkedTask.status,
        },
      })
      return { success: false as const, error: 'TASK_ALREADY_FINISHED', taskStatus: linkedTask.status }
    }
  }

  // Mark as answered
  await db
    .update(humanPrompts)
    .set({
      response: JSON.stringify(response),
      status: 'answered',
      respondedAt: new Date(),
    })
    .where(eq(humanPrompts.id, promptId))

  const formattedResponse = formatResponseForLLM(prompt.promptType, prompt.question, response, options)

  if (prompt.taskId) {
    // ── Task context: atomically claim the resume, then inject + re-trigger ──

    // Atomic race-winner claim: only the answer that flips the task OUT of
    // `awaiting_human_input` proceeds. A concurrent answer, a cancel, a restart
    // recovery, or the agent having moved on loses here and must NOT inject a
    // duplicate response message or resume the task a second time. Mirrors the
    // awaiting_kin_response / awaiting_subtask resume claims (tasks.ts).
    const claim = sqlite.run(
      `UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'awaiting_human_input'`,
      [Date.now(), prompt.taskId],
    )
    if (claim.changes === 0) {
      const current = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, prompt.taskId)).get()
      log.warn(
        { promptId, taskId: prompt.taskId, taskStatus: current?.status },
        'Human prompt answered but task is no longer awaiting_human_input — not injecting or resuming (lost the resume race)',
      )
      return { success: false as const, error: 'TASK_NOT_AWAITING', taskStatus: current?.status }
    }

    // Won the claim — inject the response into the sub-Kin history.
    await db.insert(messages).values({
      id: uuid(),
      kinId: prompt.kinId,
      taskId: prompt.taskId,
      role: 'user',
      content: `[Human response to "${prompt.question}"]: ${formattedResponse}`,
      sourceType: 'user',
      sourceId: userId ?? null,
      createdAt: new Date(),
    })

    sseManager.sendToKin(prompt.kinId, {
      type: 'task:status',
      kinId: prompt.kinId,
      data: {
        taskId: prompt.taskId,
        kinId: prompt.kinId,
        status: 'in_progress',
      },
    })

    // Re-trigger sub-Kin execution (dynamic import to avoid circular deps).
    // The claim above already performed the race-winner flip to in_progress that
    // runOrQueueResumedTask expects; it either runs the sub-Kin now or demotes the
    // row to 'queued' for later promotion if the global exec-slots are full.
    const { runOrQueueResumedTask } = await import('@/server/services/tasks')
    runOrQueueResumedTask(prompt.taskId).catch((err) =>
      log.error({ taskId: prompt.taskId, err }, 'Sub-Kin resume error after human prompt'),
    )
  } else {
    // ── Main conversation: enqueue as user message ──

    await enqueueMessage({
      kinId: prompt.kinId,
      messageType: 'user',
      content: `[Human response to "${prompt.question}"]: ${formattedResponse}`,
      sourceType: 'user',
      sourceId: userId,
      priority: config.queue.userPriority,
    })
  }

  // Emit prompt:answered SSE
  sseManager.sendToKin(prompt.kinId, {
    type: 'prompt:answered',
    kinId: prompt.kinId,
    data: {
      promptId,
      kinId: prompt.kinId,
      taskId: prompt.taskId ?? null,
      response,
    },
  })

  log.info({ promptId, taskId: prompt.taskId }, 'Human prompt answered')

  return { success: true as const }
}

// ─── Cancel / Query ─────────────────────────────────────────────────────────

export async function cancelPendingPromptsForTask(taskId: string) {
  const pending = await db
    .select()
    .from(humanPrompts)
    .where(and(eq(humanPrompts.taskId, taskId), eq(humanPrompts.status, 'pending')))
    .all()

  for (const prompt of pending) {
    await db
      .update(humanPrompts)
      .set({ status: 'cancelled' })
      .where(eq(humanPrompts.id, prompt.id))

    sseManager.sendToKin(prompt.kinId, {
      type: 'prompt:answered',
      kinId: prompt.kinId,
      data: {
        promptId: prompt.id,
        kinId: prompt.kinId,
        taskId,
        cancelled: true,
      },
    })
  }

  return pending.length
}

export async function getPendingPrompts(kinId: string, taskId?: string) {
  const conditions = [eq(humanPrompts.kinId, kinId), eq(humanPrompts.status, 'pending')]
  if (taskId) conditions.push(eq(humanPrompts.taskId, taskId))

  const rows = await db
    .select()
    .from(humanPrompts)
    .where(and(...conditions))
    .all()

  return rows.map((r) => ({
    id: r.id,
    kinId: r.kinId,
    taskId: r.taskId,
    promptType: r.promptType,
    question: r.question,
    description: r.description,
    options: JSON.parse(r.options),
    response: r.response ? JSON.parse(r.response) : null,
    status: r.status,
    createdAt: r.createdAt?.getTime() ?? 0,
    respondedAt: r.respondedAt?.getTime() ?? null,
  }))
}

// ─── Validation ─────────────────────────────────────────────────────────────

function validateResponse(
  promptType: string,
  response: unknown,
  options: HumanPromptOption[],
): string | null {
  const validValues = options.map((o) => o.value)

  switch (promptType) {
    case 'confirm':
      if (typeof response !== 'string' || !validValues.includes(response)) {
        return `Confirm response must be one of: ${validValues.join(', ')}`
      }
      return null

    case 'select':
      if (typeof response !== 'string' || !validValues.includes(response)) {
        return `Select response must be one of: ${validValues.join(', ')}`
      }
      return null

    case 'multi_select':
      if (
        !Array.isArray(response) ||
        response.length === 0 ||
        !response.every((v) => typeof v === 'string' && validValues.includes(v))
      ) {
        return 'Multi-select response must be a non-empty array of valid values'
      }
      return null

    case 'text':
      if (typeof response !== 'string' || response.trim().length === 0) {
        return 'Text response must be a non-empty string'
      }
      return null

    default:
      return 'Unknown prompt type'
  }
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatResponseForLLM(
  promptType: string,
  question: string,
  response: unknown,
  options: HumanPromptOption[],
): string {
  const optionLabelMap = new Map(options.map((o) => [o.value, o.label]))

  switch (promptType) {
    case 'confirm': {
      const label = optionLabelMap.get(response as string) ?? String(response)
      return label
    }
    case 'select': {
      const label = optionLabelMap.get(response as string) ?? String(response)
      return label
    }
    case 'multi_select': {
      const labels = (response as string[]).map((v) => optionLabelMap.get(v) ?? v)
      return labels.join(', ')
    }
    case 'text':
      return (response as string).trim()
    default:
      return JSON.stringify(response)
  }
}
