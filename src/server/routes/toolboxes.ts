import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  listToolboxes,
  getToolbox,
  createToolbox,
  updateToolbox,
  deleteToolbox,
} from '@/server/services/toolboxes'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:toolboxes')

/**
 * CRUD over the global, user-defined (and built-in) toolboxes. A toolbox is a
 * named, explicit allow-list of individual native tool names; tasks reference an
 * array of toolboxes to compose their native toolset (see
 * src/server/services/toolboxes.ts).
 *
 * Built-in toolboxes (code / research / ops / all / scout) are read-only:
 * editing or deleting one returns 400 TOOLBOX_BUILTIN_READONLY.
 */
export const toolboxRoutes = new Hono<{ Variables: AppVariables }>()

// Reads stay member-accessible (pickers, list views); mutations are platform
// configuration and admin-only.
toolboxRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

// Map a service-layer error code to an HTTP status + human message.
function mapToolboxError(code: string): { status: 400 | 404 | 409; message: string } {
  switch (code) {
    case 'TOOLBOX_NOT_FOUND':
      return { status: 404, message: 'Toolbox not found' }
    case 'TOOLBOX_BUILTIN_READONLY':
      return { status: 400, message: 'Built-in toolboxes cannot be edited or deleted' }
    case 'TOOLBOX_NAME_TAKEN':
      return { status: 409, message: 'A toolbox with this name already exists' }
    case 'TOOLBOX_NAME_REQUIRED':
      return { status: 400, message: 'Toolbox name is required' }
    default:
      return { status: 400, message: code }
  }
}

// Validate + normalize a toolNames payload into a clean string[].
function sanitizeToolNames(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return null
    const trimmed = item.trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  // De-duplicate while preserving order.
  return Array.from(new Set(out))
}

// GET /api/toolboxes — list all toolboxes (built-in + user-defined).
toolboxRoutes.get('/', (c) => {
  return c.json({ toolboxes: listToolboxes() })
})

// GET /api/toolboxes/:id — fetch a single toolbox.
toolboxRoutes.get('/:id', (c) => {
  const tb = getToolbox(c.req.param('id'))
  if (!tb) {
    return c.json({ error: { code: 'TOOLBOX_NOT_FOUND', message: 'Toolbox not found' } }, 404)
  }
  return c.json({ toolbox: tb })
})

// POST /api/toolboxes — create a user-defined toolbox.
toolboxRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({})) as {
    name?: unknown
    description?: unknown
    toolNames?: unknown
  }

  if (typeof body.name !== 'string' || body.name.trim().length === 0) {
    return c.json({ error: { code: 'TOOLBOX_NAME_REQUIRED', message: 'Toolbox name is required' } }, 400)
  }

  const toolNames = sanitizeToolNames(body.toolNames)
  if (toolNames === null) {
    return c.json({ error: { code: 'INVALID_TOOL_NAMES', message: 'toolNames must be an array of strings' } }, 400)
  }

  let description: string | null = null
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      return c.json({ error: { code: 'INVALID_DESCRIPTION', message: 'description must be a string' } }, 400)
    }
    description = body.description
  }

  try {
    const toolbox = createToolbox({ name: body.name, description, toolNames })
    return c.json({ toolbox }, 201)
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapToolboxError(code)
    log.warn({ code }, 'createToolbox failed')
    return c.json({ error: { code, message } }, status)
  }
})

// Shared update handler for PUT + PATCH (full vs partial update have the same
// semantics here — only provided fields are written).
async function handleUpdate(c: Context<{ Variables: AppVariables }>) {
  const id = c.req.param('id')
  if (!id) {
    return c.json({ error: { code: 'TOOLBOX_NOT_FOUND', message: 'Toolbox not found' } }, 404)
  }
  const body = await c.req.json().catch(() => ({})) as {
    name?: unknown
    description?: unknown
    toolNames?: unknown
  }

  const patch: { name?: string; description?: string | null; toolNames?: string[] } = {}

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return c.json({ error: { code: 'TOOLBOX_NAME_REQUIRED', message: 'Toolbox name is required' } }, 400)
    }
    patch.name = body.name
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return c.json({ error: { code: 'INVALID_DESCRIPTION', message: 'description must be a string' } }, 400)
    }
    patch.description = body.description as string | null
  }

  if (body.toolNames !== undefined) {
    const toolNames = sanitizeToolNames(body.toolNames)
    if (toolNames === null) {
      return c.json({ error: { code: 'INVALID_TOOL_NAMES', message: 'toolNames must be an array of strings' } }, 400)
    }
    patch.toolNames = toolNames
  }

  try {
    const toolbox = updateToolbox(id, patch)
    return c.json({ toolbox })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapToolboxError(code)
    log.warn({ code, id }, 'updateToolbox failed')
    return c.json({ error: { code, message } }, status)
  }
}

// PUT /api/toolboxes/:id — update a user-defined toolbox.
toolboxRoutes.put('/:id', handleUpdate)

// PATCH /api/toolboxes/:id — same semantics as PUT (partial update).
toolboxRoutes.patch('/:id', handleUpdate)

// DELETE /api/toolboxes/:id — delete a user-defined toolbox (rejects built-ins).
toolboxRoutes.delete('/:id', (c) => {
  const id = c.req.param('id')
  try {
    deleteToolbox(id)
    return c.json({ success: true })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapToolboxError(code)
    log.warn({ code, id }, 'deleteToolbox failed')
    return c.json({ error: { code, message } }, status)
  }
})
