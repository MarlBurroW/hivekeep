import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { mcpServers } from '@/server/db/schema'
import { disconnectServer, getConnectionStatus, testConnection } from '@/server/services/mcp'
import { sseManager } from '@/server/sse/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:mcp-servers')

export const mcpServerRoutes = new Hono<{ Variables: AppVariables }>()

// Reads stay member-accessible (pickers, list views); mutations are platform
// configuration and admin-only.
mcpServerRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

function serialize(server: typeof mcpServers.$inferSelect) {
  // Never expose env var values to the frontend — only return keys with empty strings
  const envParsed = server.env ? JSON.parse(server.env) as Record<string, string> : null
  const maskedEnv = envParsed
    ? Object.fromEntries(Object.keys(envParsed).map((k) => [k, '']))
    : null

  return {
    id: server.id,
    name: server.name,
    command: server.command,
    args: server.args ? JSON.parse(server.args) : [],
    env: maskedEnv,
    hasEnv: envParsed !== null && Object.keys(envParsed).length > 0,
    status: server.status,
    createdByAgentId: server.createdByAgentId,
    createdAt: new Date(server.createdAt).getTime(),
    updatedAt: new Date(server.updatedAt).getTime(),
  }
}

// GET /api/mcp-servers — list all MCP servers
mcpServerRoutes.get('/', async (c) => {
  const servers = await db.select().from(mcpServers).all()
  return c.json({ servers: servers.map(serialize) })
})

// POST /api/mcp-servers — create a new MCP server
mcpServerRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    name: string
    command: string
    args?: string[]
    env?: Record<string, string>
    status?: string
    createdByAgentId?: string
  }>()

  const trimmedName = body.name?.trim()
  const trimmedCommand = body.command?.trim()

  if (!trimmedName || !trimmedCommand) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'name and command are required' } },
      400,
    )
  }

  if (trimmedName.length > 200) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name must be 200 characters or fewer' } }, 400)
  }
  if (trimmedCommand.length > 500) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'command must be 500 characters or fewer' } }, 400)
  }
  if (body.args && body.args.length > 50) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'maximum 50 arguments allowed' } }, 400)
  }
  if (body.args?.some((a: string) => a.length > 1000)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'each argument must be 1000 characters or fewer' } }, 400)
  }
  if (body.env) {
    const entries = Object.entries(body.env)
    if (entries.length > 50) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'maximum 50 environment variables allowed' } }, 400)
    }
    for (const [k, v] of entries) {
      if (k.length > 100) return c.json({ error: { code: 'VALIDATION_ERROR', message: `env key "${k.slice(0, 20)}..." must be 100 characters or fewer` } }, 400)
      if (typeof v === 'string' && v.length > 10000) return c.json({ error: { code: 'VALIDATION_ERROR', message: `env value for "${k}" must be 10000 characters or fewer` } }, 400)
    }
  }

  const id = uuid()
  const now = new Date()

  await db.insert(mcpServers).values({
    id,
    name: trimmedName,
    command: trimmedCommand,
    args: body.args ? JSON.stringify(body.args) : null,
    env: body.env ? JSON.stringify(body.env) : null,
    status: body.status ?? 'active',
    createdByAgentId: body.createdByAgentId ?? null,
    createdAt: now,
    updatedAt: now,
  })

  log.info({ serverId: id, name: body.name, command: body.command, status: body.status ?? 'active' }, 'MCP server created')

  const created = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  const serialized = serialize(created!)

  sseManager.broadcast({
    type: 'mcp-server:created',
    data: { serverId: id, server: serialized },
  })

  return c.json({ server: serialized }, 201)
})

// PATCH /api/mcp-servers/:id — update an MCP server
mcpServerRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  const body = await c.req.json<{
    name?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
  }>()

  const updates: Partial<typeof mcpServers.$inferInsert> = { updatedAt: new Date() }

  if (body.name !== undefined) {
    const trimmed = body.name.trim()
    if (!trimmed) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name cannot be empty' } }, 400)
    }
    if (trimmed.length > 200) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name must be 200 characters or fewer' } }, 400)
    }
    updates.name = trimmed
  }

  if (body.command !== undefined) {
    const trimmed = body.command.trim()
    if (!trimmed) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'command cannot be empty' } }, 400)
    }
    if (trimmed.length > 500) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'command must be 500 characters or fewer' } }, 400)
    }
    updates.command = trimmed
  }

  if (body.args !== undefined) {
    if (Array.isArray(body.args) && body.args.length > 50) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'maximum 50 arguments allowed' } }, 400)
    }
    if (Array.isArray(body.args) && body.args.some((a: string) => a.length > 1000)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'each argument must be 1000 characters or fewer' } }, 400)
    }
    updates.args = JSON.stringify(body.args)
  }

  if (body.env !== undefined) {
    if (!body.env) {
      updates.env = null
    } else if (typeof body.env === 'object') {
      const envEntries = Object.entries(body.env)
      if (envEntries.length > 50) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'maximum 50 environment variables allowed' } }, 400)
      }
      for (const [k, v] of envEntries) {
        if (k.length > 100) return c.json({ error: { code: 'VALIDATION_ERROR', message: `env key "${k.slice(0, 20)}..." must be 100 characters or fewer` } }, 400)
        if (typeof v === 'string' && v.length > 10000) return c.json({ error: { code: 'VALIDATION_ERROR', message: `env value for "${k}" must be 10000 characters or fewer` } }, 400)
      }
    }

    if (body.env && typeof body.env === 'object') {
      // Merge: empty string values preserve existing secrets (since we don't send values to frontend)
      const existingEnv = existing.env ? JSON.parse(existing.env) as Record<string, string> : {}
      const merged: Record<string, string> = {}
      for (const [k, v] of Object.entries(body.env)) {
        merged[k] = v || existingEnv[k] || ''
      }
      updates.env = JSON.stringify(merged)
    }
  }

  await db.update(mcpServers).set(updates).where(eq(mcpServers.id, id))

  // If command, args, or env changed, disconnect so next call reconnects with new config
  const configChanged = body.command !== undefined || body.args !== undefined || body.env !== undefined
  if (configChanged) {
    await disconnectServer(id)
  }

  const updated = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  const serializedUpdated = serialize(updated!)
  log.info({ serverId: id, name: updated!.name, configChanged }, 'MCP server updated')

  sseManager.broadcast({
    type: 'mcp-server:updated',
    data: { serverId: id, server: serializedUpdated },
  })

  return c.json({ server: serializedUpdated })
})

// POST /api/mcp-servers/:id/approve — approve a pending MCP server
mcpServerRoutes.post('/:id/approve', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  if (existing.status !== 'pending_approval') {
    return c.json({ error: { code: 'ALREADY_ACTIVE', message: 'This server is already active' } }, 409)
  }

  await db.update(mcpServers).set({ status: 'active', updatedAt: new Date() }).where(eq(mcpServers.id, id))

  const updated = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  const serializedApproved = serialize(updated!)
  log.info({ serverId: id, name: updated!.name }, 'MCP server approved')

  sseManager.broadcast({
    type: 'mcp-server:updated',
    data: { serverId: id, server: serializedApproved },
  })

  return c.json({ server: serializedApproved })
})

// GET /api/mcp-servers/:id/status — check connection status
mcpServerRoutes.get('/:id/status', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  const status = await getConnectionStatus(id)
  return c.json(status)
})

// POST /api/mcp-servers/:id/test — force a fresh connection test
mcpServerRoutes.post('/:id/test', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  const status = await testConnection(id)
  return c.json(status)
})

// DELETE /api/mcp-servers/:id — delete an MCP server
mcpServerRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  const existing = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()

  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'MCP server not found' } }, 404)
  }

  // Disconnect if running
  await disconnectServer(id)

  // Delete (cascade removes agent_mcp_servers links)
  await db.delete(mcpServers).where(eq(mcpServers.id, id))

  log.info({ serverId: id, name: existing.name }, 'MCP server deleted')

  sseManager.broadcast({
    type: 'mcp-server:deleted',
    data: { serverId: id },
  })

  return c.json({ success: true })
})
