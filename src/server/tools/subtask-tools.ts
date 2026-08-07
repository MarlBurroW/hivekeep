import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  reportToParent,
  updateTaskStatus,
  requestInput,
} from '@/server/services/tasks'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:subtask')

/**
 * report_to_parent — send a message or intermediate result to the parent Agent.
 * Available to sub-Agents only.
 */
export const reportToParentTool: ToolRegistration = {
  availability: ['sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Send a message or intermediate result to the parent Agent.',
      inputSchema: z.object({
        message: z
          .string(),
      }),
      execute: async ({ message }) => {
        log.debug({ agentId: ctx.agentId, taskId: ctx.taskId }, 'report_to_parent invoked')
        if (!ctx.taskId) {
          return { error: 'No task context — this tool is only available to sub-Agents' }
        }
        const success = await reportToParent(ctx.taskId, message)
        if (!success) {
          return { error: 'Task not found or not active' }
        }
        return { success: true }
      },
    }),
}

/**
 * update_task_status — update the status of the current task.
 * Available to sub-Agents only.
 */
export const updateTaskStatusTool: ToolRegistration = {
  availability: ['sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Update task status. "completed" or "failed" finalizes the task.',
      inputSchema: z.object({
        status: z
          .enum(['in_progress', 'completed', 'failed']),
        result: z
          .string()
          .optional()
          .describe('For status="completed"'),
        error: z
          .string()
          .optional()
          .describe('For status="failed"'),
      }),
      execute: async ({ status, result, error }) => {
        log.debug({ agentId: ctx.agentId, taskId: ctx.taskId, status }, 'update_task_status invoked')
        if (!ctx.taskId) {
          return { error: 'No task context — this tool is only available to sub-Agents' }
        }
        const success = await updateTaskStatus(ctx.taskId, status, result, error)
        if (!success) {
          return { error: 'Task not found' }
        }
        return { success: true }
      },
    }),
}

/**
 * request_input — ask the parent Agent for clarification or a decision.
 * Available to sub-Agents only,
 * capped at `config.tasks.maxRequestInput` invocations per task.
 *
 * The tool **pauses the task**: the runner stops the multi-step loop and
 * resumes the sub-Agent only once the response arrives. The `note` in the
 * returned payload tells the model to emit nothing further on this turn —
 * any tool call you'd make next would race the suspension and likely be
 * the wrong move with the question still unanswered.
 */
export const requestInputTool: ToolRegistration = {
  availability: ['sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Ask the parent Agent for clarification or a decision. The task is suspended until the response arrives. DO NOT emit any further tool calls in this turn. Limited calls per task.',
      inputSchema: z.object({
        question: z.string(),
      }),
      execute: async ({ question }) => {
        log.debug({ agentId: ctx.agentId, taskId: ctx.taskId }, 'request_input invoked')
        if (!ctx.taskId) {
          return { error: 'No task context — this tool is only available to sub-Agents' }
        }
        const result = await requestInput(ctx.taskId, question)
        if (!result.success) {
          return { error: result.error }
        }
        return {
          success: true,
          paused: true as const,
          note:
            'Your task is now PAUSED waiting for the answer. Do NOT emit any further tool calls on this turn — the runner will stop the loop after this step and resume your sub-Agent once the response arrives in your message history. Acting on a guess before the human answers usually picks the wrong path; wait for the actual response.',
        }
      },
    }),
}
