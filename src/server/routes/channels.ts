import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { kins } from '@/server/db/schema'
import {
  createChannel,
  getChannel,
  listChannels,
  updateChannel,
  deleteChannel,
  activateChannel,
  deactivateChannel,
  testChannel,
  listPendingUsers,
  approveChannelUser,
  countPendingApprovals,
  countPendingApprovalsForChannel,
  handleIncomingChannelMessage,
  transferChannel,
} from '@/server/services/channels'
import { resolveKinId } from '@/server/services/kin-resolver'
import type { AppVariables } from '@/server/app'
import { channelAdapters } from '@/server/channels/index'
import {
  buildZodSchemaFromConfigSchema,
  formatZodIssues,
} from '@/server/channels/configSchemaValidator'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:channels')

export const channelRoutes = new Hono<{ Variables: AppVariables }>()

function kinAvatarUrl(kinId: string, avatarPath: string | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  return `/api/uploads/kins/${kinId}/avatar.${ext}`
}

interface KinInfo { name: string; avatarPath: string | null }

function serializeChannel(channel: any, kinInfo?: KinInfo, pendingApprovalCount = 0) {
  return {
    id: channel.id,
    kinId: channel.kinId,
    kinName: kinInfo?.name ?? 'Unknown',
    kinAvatarUrl: kinInfo ? kinAvatarUrl(channel.kinId, kinInfo.avatarPath) : null,
    name: channel.name,
    platform: channel.platform,
    status: channel.status,
    statusMessage: channel.statusMessage,
    autoCreateContacts: !!channel.autoCreateContacts,
    messagesReceived: channel.messagesReceived,
    messagesSent: channel.messagesSent,
    lastActivityAt: channel.lastActivityAt ? new Date(channel.lastActivityAt).getTime() : null,
    createdBy: channel.createdBy,
    createdAt: new Date(channel.createdAt).getTime(),
    pendingApprovalCount,
  }
}

// GET /api/channels — list channels with optional kinId filter
channelRoutes.get('/', async (c) => {
  const kinId = c.req.query('kinId')
  const allChannels = await listChannels(kinId ?? undefined)

  // Fetch kin info
  const kinIds = [...new Set(allChannels.map((ch) => ch.kinId))]
  const kinMap = new Map<string, KinInfo>()
  for (const id of kinIds) {
    const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, id)).get()
    if (kin) kinMap.set(id, kin)
  }

  // Fetch pending approval counts per channel
  const pendingCounts = new Map<string, number>()
  for (const ch of allChannels) {
    pendingCounts.set(ch.id, await countPendingApprovalsForChannel(ch.id))
  }

  return c.json({
    channels: allChannels.map((ch) => serializeChannel(ch, kinMap.get(ch.kinId), pendingCounts.get(ch.id) ?? 0)),
  })
})

// GET /api/channels/platforms — list registered platforms with metadata
channelRoutes.get('/platforms', async (c) => {
  return c.json({ platforms: channelAdapters.listWithMeta() })
})

// GET /api/channels/pending-count — global pending approval count (must be before /:id)
channelRoutes.get('/pending-count', async (c) => {
  const count = await countPendingApprovals()
  return c.json({ count })
})

// POST /api/channels/plugin/:platform/webhook/:channelId
//
// Built-in dispatcher for inbound webhooks from external platforms that drive
// plugin channels (Twilio, future SMS or voice providers). Loads the channel,
// validates the platform matches, then hands the raw Request to the adapter's
// optional handleWebhook(). The adapter parses, authenticates (signature
// validation etc.), and returns the IncomingMessage to inject plus the HTTP
// Response to send back. The channelId in the URL is a v4 UUID, so the path
// is unpredictable; cryptographic signature validation is still the adapter's
// responsibility.
channelRoutes.post('/plugin/:platform/webhook/:channelId', async (c) => {
  const platform = c.req.param('platform')
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== platform) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }
  if (channel.status !== 'active') {
    return c.json({ error: { code: 'CHANNEL_INACTIVE', message: 'Channel inactive' } }, 410)
  }

  const adapter = channelAdapters.get(platform)
  if (!adapter || typeof adapter.handleInboundWebhook !== 'function') {
    return c.json(
      { error: { code: 'WEBHOOK_NOT_SUPPORTED', message: 'Webhook not supported for this platform' } },
      404,
    )
  }

  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
  } catch {
    return c.json(
      { error: { code: 'INVALID_CHANNEL_CONFIG', message: 'Invalid channel config' } },
      500,
    )
  }

  try {
    const result = await adapter.handleInboundWebhook(channelId, cfg, c.req.raw)
    if (result.incoming) {
      await handleIncomingChannelMessage(channelId, result.incoming)
    }
    return result.response
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err), platform, channelId }, 'webhook dispatch failed')
    return c.json(
      { error: { code: 'WEBHOOK_DISPATCH_ERROR', message: 'Webhook dispatch failed' } },
      500,
    )
  }
})

// POST /api/channels — create a channel
channelRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    kinId: string
    name: string
    platform: string
    platformConfig?: Record<string, unknown>
    allowedChatIds?: string[]
    autoCreateContacts?: boolean
  }>()

  if (!body.kinId || !body.name || !body.platform) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'kinId, name, and platform are required' } },
      400,
    )
  }

  const adapter = channelAdapters.get(body.platform)
  if (!adapter) {
    const available = channelAdapters.list().join(', ')
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: `Invalid platform. Registered: ${available}` } },
      400,
    )
  }

  // Validate platformConfig against the adapter's declarative schema. Adapters
  // without a configSchema accept any platformConfig (none of the built-ins
  // are in that state post-#381 but plugins may temporarily ship without one).
  const platformConfig: Record<string, unknown> = body.platformConfig ?? {}
  if (adapter.configSchema) {
    const zodSchema = buildZodSchemaFromConfigSchema(adapter.configSchema)
    const parsed = zodSchema.safeParse(platformConfig)
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid platformConfig: ${formatZodIssues(parsed.error)}`,
          },
        },
        400,
      )
    }
  }

  // Verify Kin exists
  const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, body.kinId)).get()
  if (!kin) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  try {
    const channel = await createChannel({
      kinId: body.kinId,
      name: body.name,
      platform: body.platform,
      platformConfig,
      allowedChatIds: body.allowedChatIds,
      autoCreateContacts: body.autoCreateContacts,
      createdBy: 'user',
    })

    return c.json({ channel: serializeChannel(channel, kin) }, 201)
  } catch (err) {
    return c.json(
      { error: { code: 'CHANNEL_CREATE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      400,
    )
  }
})

// GET /api/channels/:id — get channel details
channelRoutes.get('/:id', async (c) => {
  const channelId = c.req.param('id')
  const channel = await getChannel(channelId)
  if (!channel) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, channel.kinId)).get()
  return c.json({ channel: serializeChannel(channel, kin ?? undefined) })
})

// PATCH /api/channels/:id — update a channel
channelRoutes.patch('/:id', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const body = await c.req.json<{
    name?: string
    kinId?: string
    allowedChatIds?: string[] | null
    autoCreateContacts?: boolean
  }>()

  // Block silent kinId mutations: re-binding a channel triggers system
  // events, the sideband hint, the SSE broadcast, and onIdentityChange.
  // Any caller that bypassed this and PATCHed kinId directly would skip
  // all of that and leave the system in a half-state. Route them to the
  // transfer endpoint (or the transfer_channel tool).
  if (body.kinId !== undefined && body.kinId !== existing.kinId) {
    return c.json(
      {
        error: {
          code: 'KINID_NOT_PATCHABLE',
          message: 'To change the bound Kin, use POST /api/channels/:id/transfer or the transfer_channel tool.',
        },
      },
      400,
    )
  }

  // Strip kinId from the patch even when it matches (no-op) so updateChannel
  // never sees a kinId at all on this code path.
  const { kinId: _ignoreKinId, ...patch } = body

  try {
    const updated = await updateChannel(channelId, patch)
    if (!updated) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
    }

    const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, updated.kinId)).get()
    return c.json({ channel: serializeChannel(updated, kin ?? undefined) })
  } catch (err) {
    return c.json(
      { error: { code: 'CHANNEL_UPDATE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      400,
    )
  }
})

// POST /api/channels/:id/transfer — re-bind a channel to a different Kin
//
// Shared entry point for UI driven transfers. Calls the same
// transferChannel() service that the transfer_channel tool uses, so the
// audit-trail rows, sideband hint, SSE broadcast, and adapter identity
// switch all fire consistently regardless of who initiated the action.
channelRoutes.post('/:id/transfer', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const body = await c.req.json<{
    targetKinId?: string
    targetKinSlug?: string
    reason?: string
  }>()

  if (!body.targetKinId && !body.targetKinSlug) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'targetKinId or targetKinSlug is required.' } },
      400,
    )
  }

  if (body.reason !== undefined && body.reason.length > 200) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'reason must be 200 characters or fewer.' } },
      400,
    )
  }

  // Resolve to a UUID; accept either targetKinId (UUID expected) or
  // targetKinSlug (slug or UUID, normalized via the resolver).
  const targetKinId = body.targetKinId ?? (body.targetKinSlug ? resolveKinId(body.targetKinSlug) : null)
  if (!targetKinId) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: `Target Kin "${body.targetKinId ?? body.targetKinSlug}" not found.` } },
      404,
    )
  }

  const result = await transferChannel({
    channelId,
    targetKinId,
    reason: body.reason,
    initiatedBy: 'ui',
  })

  if (result.ok === false) {
    // transferChannel returns dangling-row / unknown-channel errors that map
    // to 404; the only other failure here is the no-op case (ok:true, noop)
    // which is handled below.
    return c.json({ error: { code: 'TRANSFER_ERROR', message: result.error } }, 404)
  }

  if (result.noop) {
    return c.json({ ok: true, noop: true, message: result.message })
  }

  // On success, return the updated channel envelope plus the transfer info
  // so the caller can update its local state without an extra GET.
  const updated = await getChannel(channelId)
  const kin = updated
    ? await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, updated.kinId)).get()
    : undefined

  return c.json({
    ok: true,
    transferredAt: result.transferredAt,
    previousKinSlug: result.previousKinSlug,
    newKinSlug: result.newKinSlug,
    fromKinName: result.fromKinName,
    toKinName: result.toKinName,
    channel: updated ? serializeChannel(updated, kin ?? undefined) : null,
  })
})

// DELETE /api/channels/:id — delete a channel
channelRoutes.delete('/:id', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  try {
    await deleteChannel(channelId)
    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: { code: 'CHANNEL_DELETE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      500,
    )
  }
})

// POST /api/channels/:id/activate — activate a channel
channelRoutes.post('/:id/activate', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const channel = await activateChannel(channelId)
  if (!channel) {
    return c.json({ error: { code: 'ACTIVATE_ERROR', message: 'Failed to activate channel' } }, 500)
  }

  const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, channel.kinId)).get()
  return c.json({ channel: serializeChannel(channel, kin ?? undefined) })
})

// POST /api/channels/:id/deactivate — deactivate a channel
channelRoutes.post('/:id/deactivate', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const channel = await deactivateChannel(channelId)
  if (!channel) {
    return c.json({ error: { code: 'DEACTIVATE_ERROR', message: 'Failed to deactivate channel' } }, 500)
  }

  const kin = await db.select({ name: kins.name, avatarPath: kins.avatarPath }).from(kins).where(eq(kins.id, channel.kinId)).get()
  return c.json({ channel: serializeChannel(channel, kin ?? undefined) })
})

// POST /api/channels/:id/test — test channel connection
channelRoutes.post('/:id/test', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const result = await testChannel(channelId)
  return c.json(result)
})

// GET /api/channels/:id/user-mappings — list pending users for a channel
channelRoutes.get('/:id/user-mappings', async (c) => {
  const channelId = c.req.param('id')
  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const pending = await listPendingUsers(channelId)
  return c.json({
    mappings: pending.map((m) => ({
      id: m.id,
      channelId: m.channelId,
      platformUserId: m.platformUserId,
      platformUsername: m.platformUsername,
      platformDisplayName: m.platformDisplayName,
      createdAt: new Date(m.createdAt).getTime(),
    })),
  })
})

// POST /api/channels/:id/user-mappings/:mapId/approve — approve a pending user
channelRoutes.post('/:id/user-mappings/:mapId/approve', async (c) => {
  const channelId = c.req.param('id')
  const mapId = c.req.param('mapId')

  const existing = await getChannel(channelId)
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  const body = await c.req.json<{
    action: 'create' | 'link'
    name?: string
    contactId?: string
  }>()

  if (body.action !== 'create' && body.action !== 'link') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'action must be "create" or "link"' } }, 400)
  }

  if (body.action === 'link' && !body.contactId) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'contactId is required when action is "link"' } }, 400)
  }

  try {
    const params = body.action === 'create'
      ? { action: 'create' as const, name: body.name }
      : { action: 'link' as const, contactId: body.contactId! }

    const result = await approveChannelUser(mapId, params)
    if (!result) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } }, 404)
    }

    return c.json({ success: true, contactId: result.contactId })
  } catch (err) {
    return c.json(
      { error: { code: 'APPROVE_ERROR', message: err instanceof Error ? err.message : 'Unknown error' } },
      400,
    )
  }
})
