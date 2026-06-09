import { Hono } from 'hono'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import {
  createAccountTrigger,
  updateAccountTrigger,
  deleteAccountTrigger,
  listAccountTriggers,
  getTriggerLogs,
  type UpdateTriggerPatch,
} from '@/server/services/account-triggers'
import {
  getAgentTriggersRequireApproval,
  setAgentTriggersRequireApproval,
} from '@/server/services/app-settings'
import type { ConditionNode, TriggerDispatchMode } from '@/shared/types'

const log = createLogger('routes:account-triggers')

export const accountTriggerRoutes = new Hono<{ Variables: AppVariables }>()

function bad(message: string, code = 'VALIDATION_ERROR') {
  return { error: { code, message } } as const
}

// ─── Global approval setting (literal path — registered before /:id) ──────────

accountTriggerRoutes.get('/settings/approval', async (c) => {
  return c.json({ requireApproval: await getAgentTriggersRequireApproval() })
})

accountTriggerRoutes.put('/settings/approval', async (c) => {
  const body = await c.req.json<{ enabled?: boolean }>()
  if (typeof body.enabled !== 'boolean') return c.json(bad('enabled (boolean) is required'), 400)
  await setAgentTriggersRequireApproval(body.enabled)
  return c.json({ requireApproval: body.enabled })
})

// ─── CRUD ─────────────────────────────────────────────────────────────────────

// GET /api/account-triggers?accountId= — list triggers (optionally for one account)
accountTriggerRoutes.get('/', async (c) => {
  const accountId = c.req.query('accountId')
  const triggers = await listAccountTriggers(accountId ?? undefined)
  return c.json({ triggers })
})

// POST /api/account-triggers — create a user trigger
accountTriggerRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    accountId?: string
    name?: string
    folder?: string
    conditions?: ConditionNode
    prompt?: string
    targetAgentId?: string
    dispatchMode?: TriggerDispatchMode
    maxConcurrentTasks?: number
  }>()

  const name = body.name?.trim()
  if (!body.accountId || !name || !body.prompt?.trim() || !body.targetAgentId || !body.conditions) {
    return c.json(bad('accountId, name, prompt, targetAgentId and conditions are required'), 400)
  }
  if (name.length > 200) return c.json(bad('Name must be 200 characters or less'), 400)

  try {
    const trigger = await createAccountTrigger({
      accountId: body.accountId,
      name,
      folder: body.folder,
      conditions: body.conditions,
      prompt: body.prompt,
      targetAgentId: body.targetAgentId,
      dispatchMode: body.dispatchMode,
      maxConcurrentTasks: body.maxConcurrentTasks,
      createdBy: 'user',
    })
    return c.json({ trigger }, 201)
  } catch (err) {
    log.warn({ err }, 'Failed to create trigger')
    return c.json(bad(err instanceof Error ? err.message : 'Failed to create trigger'), 400)
  }
})

// PATCH /api/account-triggers/:id — update / approve
accountTriggerRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<UpdateTriggerPatch>()
  try {
    const trigger = await updateAccountTrigger(id, body)
    if (!trigger) return c.json(bad('Trigger not found', 'NOT_FOUND'), 404)
    return c.json({ trigger })
  } catch (err) {
    log.warn({ err, id }, 'Failed to update trigger')
    return c.json(bad(err instanceof Error ? err.message : 'Failed to update trigger'), 400)
  }
})

// DELETE /api/account-triggers/:id
accountTriggerRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await deleteAccountTrigger(id)
  return c.json({ ok: true })
})

// GET /api/account-triggers/:id/logs — recent evaluation/fire logs
accountTriggerRoutes.get('/:id/logs', async (c) => {
  const id = c.req.param('id')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200)
  const logs = await getTriggerLogs(id, limit)
  return c.json({ logs })
})
