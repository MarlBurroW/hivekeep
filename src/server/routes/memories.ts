import { Hono } from 'hono'
import { eq, and, desc, sql } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { memories } from '@/server/db/schema'

import type { AppVariables } from '@/server/app'
import { requireAdmin } from '@/server/auth/require-admin'

const memoryRoutes = new Hono<{ Variables: AppVariables }>()

// Platform configuration: every route in this family is admin-only.
memoryRoutes.use('*', requireAdmin)

// GET /api/memories — list all memories across all Agents
memoryRoutes.get('/', async (c) => {
  const category = c.req.query('category')
  const subject = c.req.query('subject')
  const agentId = c.req.query('agentId')
  const scope = c.req.query('scope')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)

  const conditions = []
  if (agentId) conditions.push(eq(memories.agentId, agentId))
  if (category) conditions.push(eq(memories.category, category))
  if (subject) conditions.push(eq(memories.subject, subject))
  if (scope) conditions.push(eq(memories.scope, scope))

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const [countResult, result] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(whereClause)
      .all(),
    db
      .select({
        id: memories.id,
        agentId: memories.agentId,
        content: memories.content,
        category: memories.category,
        subject: memories.subject,
        scope: memories.scope,
        importance: memories.importance,
        retrievalCount: memories.retrievalCount,
        lastRetrievedAt: memories.lastRetrievedAt,
        consolidationGeneration: memories.consolidationGeneration,
        sourceChannel: memories.sourceChannel,
        sourceContext: memories.sourceContext,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(whereClause)
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .offset(offset)
      .all(),
  ])

  const total = countResult[0]?.count ?? 0
  return c.json({ memories: result, total, hasMore: offset + result.length < total })
})

// POST /api/memories/backfill-importance — score importance for unscored memories
memoryRoutes.post('/backfill-importance', async (c) => {
  const body = await c.req.json<{ agentId?: string }>().catch(() => ({} as { agentId?: string }))
  const { agentId } = body
  const { backfillImportance } = await import('@/server/services/importance-backfill')
  const result = await backfillImportance(agentId || undefined)
  return c.json(result)
})

// POST /api/memories/consolidate — trigger memory consolidation manually
memoryRoutes.post('/consolidate', async (c) => {
  const { agentId } = await c.req.json<{ agentId: string }>()
  if (!agentId) return c.json({ error: 'agentId is required' }, 400)
  const { consolidateMemories } = await import('@/server/services/consolidation')
  const removed = await consolidateMemories(agentId)
  return c.json({ removed })
})

// POST /api/memories/reembed — re-embed all memories with the current embedding model
memoryRoutes.post('/reembed', async (c) => {
  const body = await c.req.json<{ agentId?: string }>().catch(() => ({} as { agentId?: string }))
  const { agentId } = body
  const { reembedAllMemories } = await import('@/server/services/memory')
  const result = await reembedAllMemories(agentId || undefined)
  return c.json(result)
})

export { memoryRoutes }
