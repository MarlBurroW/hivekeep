import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { tasks } from '@/server/db/schema'
import { createHumanPrompt } from '@/server/services/human-prompts'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:human-prompt')

const optionSchema = z.object({
  label: z.string(),
  value: z.string(),
  description: z.string().optional(),
  variant: z
    .enum(['default', 'success', 'warning', 'destructive', 'primary'])
    .optional(),
})

/**
 * prompt_human — present a structured interactive question to the human user.
 * Available in main conversation and sub-Agent tasks (but NOT cron-spawned tasks).
 */
export const promptHumanTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) => {
    let promptCalledThisTurn = false
    return tool({
      description:
        'Prompt the user with a question and wait for their reply. Choose the prompt_type that fits: `confirm` (yes/no), `select` (one of N), `multi_select` (any of N), or `text` (free-form answer). When called from a task, the task is suspended until they answer. Not available in cron tasks.',
      inputSchema: z.object({
        prompt_type: z
          .enum(['confirm', 'select', 'multi_select', 'text']),
        question: z
          .string()
          .max(500),
        description: z
          .string()
          .max(1000)
          .optional(),
        options: z
          .array(optionSchema)
          .max(10)
          .optional()
          .describe('Required for confirm/select/multi_select (min 2). Omit for text.'),
      }),
      execute: async ({ prompt_type, question, description, options }) => {
        log.debug({ agentId: ctx.agentId, taskId: ctx.taskId, promptType: prompt_type }, 'prompt_human invoked')

        // Limit to 1 prompt_human call per LLM turn
        if (promptCalledThisTurn) {
          return {
            error: 'You already prompted the user this turn. Wait for their response before asking another question. If you need multiple inputs, use a single multi_select prompt.',
          }
        }
        promptCalledThisTurn = true

        // Guard: cron-spawned tasks cannot prompt humans
        if (ctx.taskId) {
          const task = await db.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get()
          if (!task) {
            return { error: 'Task not found' }
          }
          if (task.cronId) {
            return { error: 'prompt_human is not available in cron-triggered tasks' }
          }
          if (!task.allowHumanPrompt) {
            return { error: 'Human prompts are disabled for this task by the parent' }
          }
        }

        const needsOptions = prompt_type !== 'text'
        if (needsOptions && (!options || options.length < 2)) {
          return {
            error: `prompt_type "${prompt_type}" requires at least 2 options. For free-form answers use prompt_type "text" (no options).`,
          }
        }

        const { promptId } = await createHumanPrompt({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          promptType: prompt_type,
          question,
          description,
          options: options ?? [],
        })

        return {
          promptId,
          status: 'pending',
          message: 'The user has been prompted with your question. Their response will arrive as a new message. Please wait.',
        }
      },
    })
  },
}
