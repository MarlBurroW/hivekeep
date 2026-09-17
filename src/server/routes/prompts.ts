import { Hono } from 'hono'
import { and, count, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents, humanPrompts } from '@/server/db/schema'
import { respondToHumanPrompt, getPendingPrompts } from '@/server/services/human-prompts'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'

const log = createLogger('routes:prompts')

export const promptRoutes = new Hono<{ Variables: AppVariables }>()

/** Shared conversation prompts, using the same authenticated-member access as chat. */
promptRoutes.get('/inbox', (c) => {
  const boundedInteger = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (!value || !/^\d+$/.test(value)) return fallback
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= min ? Math.min(parsed, max) : fallback
  }
  const limit = boundedInteger(c.req.query('limit'), 20, 1, 50)
  const offset = boundedInteger(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const where = and(eq(humanPrompts.status, 'pending'), isNull(humanPrompts.taskId))
  const result = db.transaction((tx) => {
    const total = tx.select({ total: count() }).from(humanPrompts)
      .innerJoin(agents, eq(humanPrompts.agentId, agents.id)).where(where).get()!.total
    const prompts = tx.select({
      id: humanPrompts.id, agentId: humanPrompts.agentId,
      agentName: agents.name, agentSlug: agents.slug, question: humanPrompts.question,
    }).from(humanPrompts).innerJoin(agents, eq(humanPrompts.agentId, agents.id))
      .where(where).orderBy(desc(humanPrompts.createdAt), desc(humanPrompts.id))
      .limit(limit).offset(offset).all()
    return { prompts, total, hasMore: offset < total - prompts.length }
  })
  return c.json(result)
})

/**
 * POST /api/prompts/:id/respond — submit a response to a human prompt.
 */
promptRoutes.post('/:id/respond', async (c) => {
  const promptId = c.req.param('id')
  const body = await c.req.json<{ response: unknown }>()

  if (body.response === undefined || body.response === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Response is required' } }, 400)
  }

  const user = c.get('user')
  const result = await respondToHumanPrompt(promptId, body.response, user.id)

  if (!result.success) {
    if (result.error === 'TASK_ALREADY_FINISHED') {
      return c.json(
        {
          error: {
            code: 'TASK_ALREADY_FINISHED',
            message:
              `This task already reached the "${result.taskStatus}" status before your reply arrived — it can no longer resume from this prompt. The reply has been kept on the prompt for audit.`,
          },
        },
        409,
      )
    }
    return c.json({ error: { code: 'PROMPT_ERROR', message: result.error } }, 400)
  }

  return c.json({ success: true })
})

/**
 * GET /api/prompts/pending — get pending prompts for hydration on page load.
 * Query params: agentId (required), taskId (optional)
 */
promptRoutes.get('/pending', async (c) => {
  const agentId = c.req.query('agentId')
  const taskId = c.req.query('taskId')

  if (!agentId) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'agentId is required' } }, 400)
  }

  const prompts = await getPendingPrompts(agentId, taskId ?? undefined)
  return c.json({ prompts })
})
