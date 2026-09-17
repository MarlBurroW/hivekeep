import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { tasks } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import { setTodosForTask } from '@/server/services/task-todos'
import { recordGuardFire } from '@/server/services/tool-call-tracker'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tool:task-todos')

const todoItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .describe('Stable identifier for this todo. Reuse the same id across updates.'),
  subject: z
    .string()
    .min(1)
    .max(200)
    .describe('What needs to be done — one clear, actionable sentence.'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .describe('Current status. At most ONE todo may be in_progress at a time.'),
})

/**
 * `task_todos` — bulk-set the structured plan for a sub-Agent task.
 *
 * Available to sub-Agents only. The model passes the FULL list each time it
 * changes (creating items, advancing one to in_progress, marking one as
 * completed, cancelling stale ones). The list is held in memory for the
 * task lifetime and broadcast over SSE so the task UI can render
 * progress. It is NOT persisted to disk — a server restart loses it,
 * which matches the same model as `awaiting_agent_response` recovery.
 */
export const taskTodosTool: ToolRegistration = {
  availability: ['sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Set or update the structured plan for this task. Pass the FULL list each call — this replaces the previous list. **Use for non-trivial multi-step work** (≥3 distinct steps, complex refactors, multi-file changes): plan up-front, mark items in_progress as you start them (at most ONE in_progress at a time), and completed AS SOON AS each finishes (never batch completions at the end). Skip for trivial single-step tasks. Capped at 30 items.',
      inputSchema: z.object({
        todos: z.array(todoItemSchema).max(30),
      }),
      execute: async ({ todos }) => {
        if (!ctx.taskId) {
          return { error: 'task_todos is only available inside a sub-Agent task.' }
        }

        const task = await db.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get()
        if (!task) return { error: 'Task not found.' }

        try {
          const stored = setTodosForTask(ctx.taskId, todos, { parentAgentId: task.parentAgentId })
          recordGuardFire(ctx.taskId, 'todoUpdate')
          log.debug({ taskId: ctx.taskId, count: stored.length }, 'task_todos updated')
          return {
            success: true,
            todos: stored,
            counts: {
              total: stored.length,
              pending: stored.filter((t) => t.status === 'pending').length,
              in_progress: stored.filter((t) => t.status === 'in_progress').length,
              completed: stored.filter((t) => t.status === 'completed').length,
              cancelled: stored.filter((t) => t.status === 'cancelled').length,
            },
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to update task todos.'
          return { error: message }
        }
      },
    }),
}
