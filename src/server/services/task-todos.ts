/**
 * Per-task structured todo list for sub-Agents.
 *
 * Ported from opencode's TodoWrite. The sub-Agent issues a single bulk-set
 * call each time the plan changes (creating items, marking one as
 * in_progress, completing one, cancelling a stale one). The list lives in
 * memory for the duration of the task and is broadcast over SSE so the
 * task panel can render live progress.
 *
 * Discipline (enforced softly via prompt + tool description):
 *   - At most one in_progress item at a time.
 *   - Mark completed immediately on success (no batching).
 *   - Skip for trivial single-step work.
 *
 * Cleared by `resolveTask` / `cancelTask` to bound memory.
 */

import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'

const log = createLogger('task-todos')

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  id: string
  subject: string
  status: TodoStatus
}

const byTask = new Map<string, TodoItem[]>()

/**
 * Replace the todo list for a task. Returns the stored list. Throws if any
 * validation invariant is violated — the tool layer surfaces the error to
 * the model so it can fix and retry.
 */
export function setTodosForTask(
  taskId: string,
  todos: TodoItem[],
  meta: { parentAgentId: string },
): TodoItem[] {
  if (todos.length > 30) {
    throw new Error('A task may have at most 30 todos. Break large work into a sub-task with its own list.')
  }
  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  if (inProgressCount > 1) {
    throw new Error(
      `At most one todo may be in_progress at a time (found ${inProgressCount}). Mark the previous one completed before starting the next.`,
    )
  }
  const seenIds = new Set<string>()
  for (const t of todos) {
    if (!t.id || !t.subject.trim()) {
      throw new Error(`Each todo must have a non-empty id and subject (offender: ${JSON.stringify(t)}).`)
    }
    if (seenIds.has(t.id)) {
      throw new Error(`Duplicate todo id: ${t.id}. Each id must be unique within the task.`)
    }
    seenIds.add(t.id)
  }

  const stored = todos.map((t) => ({ ...t, subject: t.subject.trim() }))
  byTask.set(taskId, stored)

  sseManager.sendToAgent(meta.parentAgentId, {
    type: 'task:todos',
    agentId: meta.parentAgentId,
    data: {
      taskId,
      todos: stored,
    },
  })

  log.info(
    { taskId, count: stored.length, inProgress: inProgressCount, completed: stored.filter((t) => t.status === 'completed').length },
    'Task todos updated',
  )

  return stored
}

/** Read the current list for a task, or [] when none has been set. */
export function getTodosForTask(taskId: string): TodoItem[] {
  return byTask.get(taskId) ?? []
}

/** Drop state for a finished/cancelled task. */
export function forgetTaskTodos(taskId: string): void {
  if (byTask.delete(taskId)) {
    log.debug({ taskId }, 'Task todos cleared')
  }
}

/** Test-only. */
export function _resetAllTodos(): void {
  byTask.clear()
}
