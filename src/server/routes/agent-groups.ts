import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  listAgentGroups,
  getAgentGroup,
  createAgentGroup,
  updateAgentGroup,
  deleteAgentGroup,
  AGENT_GROUP_NAME_MAX,
} from '@/server/services/agent-groups'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:agent-groups')

/**
 * CRUD over Agent groups — the named folders that organise the sidebar's Agent
 * list (see src/server/services/agent-groups.ts).
 *
 * Membership is NOT set here: an Agent is filed into a group through
 * `PATCH /api/agents/:id { groupId }`, so the Agent stays the single writer of
 * its own row.
 */
export const agentGroupRoutes = new Hono<{ Variables: AppVariables }>()

// Same split as toolboxes: everyone reads (the sidebar needs the list), only
// admins mutate. Groups are global, so one member renaming a folder would
// change it for the whole household.
agentGroupRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

function mapAgentGroupError(code: string): { status: 400 | 404 | 409; message: string } {
  switch (code) {
    case 'AGENT_GROUP_NOT_FOUND':
      return { status: 404, message: 'Agent group not found' }
    case 'AGENT_GROUP_NAME_TAKEN':
      return { status: 409, message: 'A group with this name already exists' }
    case 'AGENT_GROUP_NAME_REQUIRED':
      return { status: 400, message: 'Group name is required' }
    case 'AGENT_GROUP_NAME_TOO_LONG':
      return { status: 400, message: `Group name must be at most ${AGENT_GROUP_NAME_MAX} characters` }
    case 'AGENT_GROUP_INVALID_SORT_ORDER':
      return { status: 400, message: 'sortOrder must be an integer' }
    default:
      return { status: 400, message: code }
  }
}

// GET /api/agent-groups — list every group in display order.
agentGroupRoutes.get('/', (c) => {
  return c.json({ groups: listAgentGroups() })
})

// GET /api/agent-groups/:id — fetch a single group.
agentGroupRoutes.get('/:id', (c) => {
  const group = getAgentGroup(c.req.param('id'))
  if (!group) {
    return c.json({ error: { code: 'AGENT_GROUP_NOT_FOUND', message: 'Agent group not found' } }, 404)
  }
  return c.json({ group })
})

// POST /api/agent-groups — create a group.
agentGroupRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; sortOrder?: unknown }

  if (typeof body.name !== 'string') {
    return c.json({ error: { code: 'AGENT_GROUP_NAME_REQUIRED', message: 'Group name is required' } }, 400)
  }
  if (body.sortOrder !== undefined && !Number.isInteger(body.sortOrder)) {
    return c.json({ error: { code: 'AGENT_GROUP_INVALID_SORT_ORDER', message: 'sortOrder must be an integer' } }, 400)
  }

  try {
    const group = createAgentGroup({ name: body.name, sortOrder: body.sortOrder as number | undefined })
    return c.json({ group }, 201)
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapAgentGroupError(code)
    log.warn({ code }, 'createAgentGroup failed')
    return c.json({ error: { code, message } }, status)
  }
})

// Shared handler for PUT + PATCH (only provided fields are written).
async function handleUpdate(c: Context<{ Variables: AppVariables }>) {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { code: 'AGENT_GROUP_NOT_FOUND', message: 'Agent group not found' } }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as { name?: unknown; sortOrder?: unknown }

  const patch: { name?: string; sortOrder?: number } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      return c.json({ error: { code: 'AGENT_GROUP_NAME_REQUIRED', message: 'Group name is required' } }, 400)
    }
    patch.name = body.name
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder)) {
      return c.json({ error: { code: 'AGENT_GROUP_INVALID_SORT_ORDER', message: 'sortOrder must be an integer' } }, 400)
    }
    patch.sortOrder = body.sortOrder as number
  }

  try {
    const group = updateAgentGroup(id, patch)
    return c.json({ group })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapAgentGroupError(code)
    log.warn({ code, id }, 'updateAgentGroup failed')
    return c.json({ error: { code, message } }, status)
  }
}

agentGroupRoutes.put('/:id', handleUpdate)
agentGroupRoutes.patch('/:id', handleUpdate)

// DELETE /api/agent-groups/:id — delete a group; its Agents are ungrouped.
agentGroupRoutes.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
    const { ungroupedAgentIds } = deleteAgentGroup(id)
    return c.json({ success: true, ungroupedAgentIds })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapAgentGroupError(code)
    log.warn({ code, id }, 'deleteAgentGroup failed')
    return c.json({ error: { code, message } }, status)
  }
})
