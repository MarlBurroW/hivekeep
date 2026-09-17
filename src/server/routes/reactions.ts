import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { messageReactions, messages } from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { resolveAgentId } from '@/server/services/agent-resolver'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:reactions')

// Preset emojis available for reactions
export const PRESET_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉']

const reactionRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/agents/:agentId/messages/:messageId/reactions
reactionRoutes.get('/', async (c) => {
  const messageId = c.req.param('messageId')!

  const reactions = await db
    .select()
    .from(messageReactions)
    .where(eq(messageReactions.messageId, messageId))
    .all()

  return c.json({ reactions })
})

// POST /api/agents/:agentId/messages/:messageId/reactions — toggle a reaction
reactionRoutes.post('/', async (c) => {
  const agentIdParam = c.req.param('agentId')
  const agentId = agentIdParam ? resolveAgentId(agentIdParam) : null
  if (!agentId) {
    return c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const messageId = c.req.param('messageId')!
  const user = c.get('user') as { id: string; name: string }
  const body = await c.req.json()
  const { emoji } = body as { emoji: string }

  if (!emoji || !PRESET_EMOJIS.includes(emoji)) {
    return c.json({ error: { code: 'INVALID_EMOJI', message: `Emoji must be one of: ${PRESET_EMOJIS.join(' ')}` } }, 400)
  }

  // Check message exists
  const msg = await db.select({ id: messages.id }).from(messages).where(eq(messages.id, messageId)).get()
  if (!msg) {
    return c.json({ error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found' } }, 404)
  }

  // Check if reaction already exists (toggle behavior)
  const existing = await db
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, user.id),
        eq(messageReactions.emoji, emoji),
      ),
    )
    .get()

  if (existing) {
    // Remove the reaction
    await db.delete(messageReactions).where(eq(messageReactions.id, existing.id))

    sseManager.sendToAgent(agentId, {
      type: 'reaction:removed',
      agentId,
      data: {
        messageId,
        userId: user.id,
        userName: user.name,
        emoji,
        reactionId: existing.id,
      },
    })

    log.debug({ messageId, userId: user.id, emoji }, 'Reaction removed')
    return c.json({ action: 'removed', reactionId: existing.id })
  }

  // Add the reaction
  const reactionId = uuid()
  const now = new Date()

  await db.insert(messageReactions).values({
    id: reactionId,
    messageId,
    userId: user.id,
    emoji,
    createdAt: now,
  })

  sseManager.sendToAgent(agentId, {
    type: 'reaction:added',
    agentId,
    data: {
      messageId,
      userId: user.id,
      userName: user.name,
      emoji,
      reactionId,
    },
  })

  log.debug({ messageId, userId: user.id, emoji }, 'Reaction added')
  return c.json({ action: 'added', reactionId })
})

export { reactionRoutes }
