import { eq, and, asc, desc, count, inArray, lt } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { messages, channels, channelUserMappings, channelPendingMessages, channelMessageLinks, channelOrigins, contactPlatformIds, contactNicknames, agents, contacts, userProfiles } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { downloadChannelAttachments } from '@/server/services/files'
import { createSecret, deleteSecret, getSecretValue, getSecretByKey } from '@/server/services/vault'
import { createContact } from '@/server/services/contacts'
import { channelAdapters } from '@/server/channels/index'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { agentAvatarUrl } from '@/server/services/field-validator'
import { getContactDisplayName } from '@/shared/contact-display'
import { applyAgentNamePrefix } from '@/server/services/channel-prefix'
import type { IncomingMessage, OutboundAttachment, DeliveryStatusUpdate, ChannelPairingEvent } from '@/server/channels/adapter'
import type { ChannelPlatform, ChannelStatus } from '@/shared/types'
import QRCode from 'qrcode'

const log = createLogger('channels')

// ─── Interactive pairing (QR) → SSE bridge ──────────────────────────────────

/** Latest QR data-URL per channel, so a setup card that mounts after the first
 *  QR broadcast (or on resync) can render it immediately. Cleared on resolve. */
const latestQrByChannel = new Map<string, string>()

/** The most recent QR image for a channel, if pairing is in progress. */
export function getLatestChannelQr(channelId: string): string | undefined {
  return latestQrByChannel.get(channelId)
}

/**
 * Resolve any in-chat QR setup card waiting on this channel (P2 of
 * interactive-setup). No-op for the Settings dialog flow (no card). Dynamic
 * import to avoid a static cycle with secret-prompts.
 */
async function resolveQrCard(channelId: string, ok: boolean, summary: string): Promise<void> {
  try {
    const { resolveQrCardForChannel } = await import('@/server/services/secret-prompts')
    await resolveQrCardForChannel(channelId, { ok, summary })
  } catch (err) {
    log.warn({ channelId, err }, 'Failed to resolve QR setup card')
  }
}

/**
 * Build the `onPairing` sink for an interactive-pairing adapter (e.g.
 * WhatsApp-Web). It turns the adapter's QR/connection lifecycle into
 * `channel:pairing` SSE events (encoding the QR string into a data-URL image so
 * the client just renders an <img>), drives the channel status, and resolves
 * any in-chat QR setup card on a terminal outcome.
 */
function makePairingHandler(channelId: string, agentId: string): (e: ChannelPairingEvent) => void {
  return (event) => {
    void (async () => {
      try {
        if (event.type === 'qr') {
          const qrImage = await QRCode.toDataURL(event.qr, { margin: 1, width: 320 })
          latestQrByChannel.set(channelId, qrImage)
          sseManager.broadcast({
            type: 'channel:pairing',
            agentId,
            data: { channelId, agentId, status: 'qr', qrImage },
          })
        } else if (event.type === 'connected') {
          latestQrByChannel.delete(channelId)
          await setChannelStatus(channelId, 'active')
          sseManager.broadcast({
            type: 'channel:pairing',
            agentId,
            data: { channelId, agentId, status: 'connected' },
          })
          await resolveQrCard(channelId, true, 'the WhatsApp channel was paired and is now active.')
        } else if (event.type === 'logged-out') {
          latestQrByChannel.delete(channelId)
          await setChannelStatus(channelId, 'error', 'WhatsApp session logged out — scan the QR code again to re-pair.')
          sseManager.broadcast({
            type: 'channel:pairing',
            agentId,
            data: { channelId, agentId, status: 'logged-out' },
          })
          await resolveQrCard(channelId, false, 'the WhatsApp session was logged out before pairing completed.')
        } else {
          latestQrByChannel.delete(channelId)
          await setChannelStatus(channelId, 'error', event.message)
          sseManager.broadcast({
            type: 'channel:pairing',
            agentId,
            data: { channelId, agentId, status: 'error', message: event.message },
          })
          await resolveQrCard(channelId, false, `pairing failed: ${event.message}`)
        }
      } catch (err) {
        log.error({ channelId, err }, 'Failed to relay channel pairing event')
      }
    })()
  }
}

// ─── In-memory sideband for channel metadata (same pattern as queueFileIds) ──

export interface ChannelQueueMeta {
  channelId: string
  platformChatId: string
  platformMessageId: string
  platformUserId: string
}

const channelQueueMeta = new Map<string, ChannelQueueMeta>()

export function setChannelQueueMeta(queueItemId: string, meta: ChannelQueueMeta) {
  channelQueueMeta.set(queueItemId, meta)
}

export function getChannelQueueMeta(queueItemId: string): ChannelQueueMeta | undefined {
  return channelQueueMeta.get(queueItemId)
}

export function popChannelQueueMeta(queueItemId: string): ChannelQueueMeta | undefined {
  const meta = channelQueueMeta.get(queueItemId)
  if (meta) channelQueueMeta.delete(queueItemId)
  return meta
}

// ─── Channel transfer hints (one-shot, consumed by the next inbound) ────────
//
// When an Agent calls transfer_channel(channelId, targetAgentSlug, reason?), the
// channel binding mutates (channels.agentId is updated). The next inbound on
// the channel should carry transfer context so the new Agent understands it
// just inherited the conversation. We stash the hint here keyed by channelId.
// The hint is popped (consumed) by handleIncomingChannelMessage when the
// next inbound arrives, and merged into the user message metadata under
// `channelTransfer`. The agent-engine then surfaces it in <channel-context>.
//
// In-memory only, lost on restart. Acceptable trade-off: a stale hint after
// a restart is harmless (the Agent will simply miss the one-shot transfer
// note; the conversation history and the audit-trail system messages
// remain).

export interface ChannelTransferHint {
  fromAgentId: string
  fromAgentSlug: string
  fromAgentName: string
  reason?: string
  at: number
}

const channelTransferHints = new Map<string, ChannelTransferHint>()

export function setChannelTransferHint(channelId: string, hint: ChannelTransferHint): void {
  channelTransferHints.set(channelId, hint)
}

export function popChannelTransferHint(channelId: string): ChannelTransferHint | undefined {
  const hint = channelTransferHints.get(channelId)
  if (hint) channelTransferHints.delete(channelId)
  return hint
}

// ─── Channel origin store (causal chain tracking for follow-up delivery) ─────
//
// Persisted in `channel_origins`, NOT in RAM: the whole point is that a reply
// written long after the inbound message (sub-Agent finished, wake-up fired,
// server restarted in between) still knows where to go.

export interface ChannelOriginMeta extends ChannelQueueMeta {
  createdAt: number
}

export function setChannelOriginMeta(originId: string, meta: ChannelQueueMeta): void {
  db.insert(channelOrigins)
    .values({
      originId,
      channelId: meta.channelId,
      platformChatId: meta.platformChatId,
      platformMessageId: meta.platformMessageId,
      platformUserId: meta.platformUserId,
      createdAt: new Date(),
    })
    .onConflictDoNothing()
    .run()
}

export function getChannelOriginMeta(originId: string): ChannelOriginMeta | undefined {
  const row = db.select().from(channelOrigins).where(eq(channelOrigins.originId, originId)).get()
  if (!row) return undefined
  const createdAt = row.createdAt.getTime()
  if (Date.now() - createdAt > config.channels.originTtlMs) {
    db.delete(channelOrigins).where(eq(channelOrigins.originId, originId)).run()
    return undefined
  }
  return {
    channelId: row.channelId,
    platformChatId: row.platformChatId,
    platformMessageId: row.platformMessageId,
    platformUserId: row.platformUserId,
    createdAt,
  }
}

let originPruneInterval: ReturnType<typeof setInterval> | null = null

/** Drop origin rows past the freshness window. Lazy deletion on read only
 *  covers origins somebody still asks about; this collects the rest. */
function pruneChannelOrigins(): void {
  const cutoff = new Date(Date.now() - config.channels.originTtlMs)
  const stale = db.select({ originId: channelOrigins.originId }).from(channelOrigins).where(lt(channelOrigins.createdAt, cutoff)).all()
  if (stale.length === 0) return
  db.delete(channelOrigins).where(lt(channelOrigins.createdAt, cutoff)).run()
  log.info({ count: stale.length }, 'Pruned stale channel origins')
}

export function startChannelOriginCleanup(): void {
  if (originPruneInterval) return
  const run = () => {
    try {
      pruneChannelOrigins()
    } catch (err) {
      log.error({ err }, 'Channel origin cleanup failed')
    }
  }
  setTimeout(run, 60_000)
  originPruneInterval = setInterval(run, 6 * 60 * 60 * 1000)
}

// ─── Locale resolution (channel → agent → owner → user_profiles.language) ─────

const DEFAULT_LOCALE = 'en'

/**
 * Resolve the locale to use when an adapter localizes a `contextLine` for a
 * channel. The owner of the Agent attached to the channel sees the chat UI, so
 * we pick that user's `user_profiles.language`. Falls back to 'en'.
 */
export function resolveChannelLocale(channelId: string): string {
  try {
    const row = db
      .select({ language: userProfiles.language })
      .from(channels)
      .innerJoin(agents, eq(channels.agentId, agents.id))
      .innerJoin(userProfiles, eq(agents.createdBy, userProfiles.userId))
      .where(eq(channels.id, channelId))
      .get()
    return row?.language ?? DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

interface CreateChannelParams {
  agentId: string
  name: string
  platform: ChannelPlatform
  /**
   * Raw configuration values keyed by the field names declared in the
   * adapter's configSchema (e.g. `{ botToken: 'xxx', allowedChatIds: [...] }`).
   * Password fields are auto-vaulted before persistence and replaced with
   * `<name>VaultKey` references in the stored `platformConfig` JSON.
   */
  platformConfig?: Record<string, unknown>
  allowedChatIds?: string[]
  autoCreateContacts?: boolean
  createdBy?: 'user' | 'agent'
}

export async function createChannel(params: CreateChannelParams) {
  // Check max per Agent limit
  const existing = await db
    .select()
    .from(channels)
    .where(eq(channels.agentId, params.agentId))
    .all()

  if (existing.length >= config.channels.maxPerAgent) {
    throw new Error(`Max channels per Agent (${config.channels.maxPerAgent}) reached`)
  }

  const adapter = channelAdapters.get(params.platform)

  const id = uuid()
  const now = new Date()
  const input = params.platformConfig ?? {}

  // Build stored platformConfig from the adapter's schema. Password fields
  // are vaulted and replaced with `<name>VaultKey`; other declared fields
  // are stored as-is. Undeclared keys in `input` are dropped silently
  // (the route already Zod-validates against the schema before calling).
  // Naming convention for new vault keys: `channel_<platform>_<id>_<field>`.
  // Pre-existing channels created before issue #381 used the older single-key
  // format `channel_<platform>_<id>` (for botToken only); those entries
  // remain valid because their `botTokenVaultKey` value in DB still points
  // to that exact secret — the adapter just reads whatever VaultKey is in
  // the stored config.
  const stored: Record<string, unknown> = {}
  for (const field of adapter?.configSchema?.fields ?? []) {
    const value = input[field.name]
    if (value === undefined || value === null || value === '') continue
    if (field.type === 'password') {
      const vaultKey = `channel_${params.platform}_${id}_${field.name}`
      await createSecret(
        vaultKey,
        String(value),
        undefined,
        `${field.label} for ${params.platform} channel "${params.name}"`,
      )
      stored[`${field.name}VaultKey`] = vaultKey
    } else {
      stored[field.name] = value
    }
  }
  if (params.allowedChatIds?.length) {
    stored.allowedChatIds = params.allowedChatIds
  }

  await db.insert(channels).values({
    id,
    agentId: params.agentId,
    name: params.name,
    platform: params.platform,
    platformConfig: JSON.stringify(stored),
    status: 'inactive',
    // Default to requiring approval for new contacts (the secure default).
    // When true, unknown senders are auto-created as contacts and skip the
    // approval gate — see resolveChannelContact.
    autoCreateContacts: params.autoCreateContacts ?? false,
    messagesReceived: 0,
    messagesSent: 0,
    createdBy: params.createdBy ?? 'user',
    createdAt: now,
    updatedAt: now,
  })

  const created = await db.select().from(channels).where(eq(channels.id, id)).get()

  if (created) {
    sseManager.broadcast({
      type: 'channel:created',
      agentId: created.agentId,
      data: { channelId: created.id, agentId: created.agentId, platform: created.platform },
    })
  }

  log.info({ channelId: id, agentId: params.agentId, platform: params.platform, name: params.name }, 'Channel created')
  return created!
}

export async function getChannel(channelId: string) {
  return db.select().from(channels).where(eq(channels.id, channelId)).get()
}

export async function listChannels(agentId?: string) {
  if (agentId) {
    return db.select().from(channels).where(eq(channels.agentId, agentId)).all()
  }
  return db.select().from(channels).all()
}

/**
 * List every channel on the platform, joined with its owner Agent's slug/name.
 * Powers `list_channels({ scope: 'all' })` so an Agent can discover channels it can
 * borrow for a cross-Agent send. Left-join on agents keeps a row even if the owner
 * Agent was deleted (slug/name then null).
 */
export async function listChannelsWithOwners() {
  return db
    .select({
      id: channels.id,
      agentId: channels.agentId,
      name: channels.name,
      platform: channels.platform,
      status: channels.status,
      messagesReceived: channels.messagesReceived,
      messagesSent: channels.messagesSent,
      lastActivityAt: channels.lastActivityAt,
      ownerAgentSlug: agents.slug,
      ownerAgentName: agents.name,
    })
    .from(channels)
    .leftJoin(agents, eq(channels.agentId, agents.id))
    .all()
}

export async function updateChannel(
  channelId: string,
  updates: Partial<{
    name: string
    agentId: string
    allowedChatIds: string[] | null
    autoCreateContacts: boolean
  }>,
) {
  const existing = await getChannel(channelId)
  if (!existing) return null

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (updates.name !== undefined) setValues.name = updates.name
  if (updates.agentId !== undefined) setValues.agentId = updates.agentId
  if (updates.autoCreateContacts !== undefined) setValues.autoCreateContacts = updates.autoCreateContacts

  // Update allowedChatIds in platform config
  if (updates.allowedChatIds !== undefined) {
    const cfg = JSON.parse(existing.platformConfig) as Record<string, unknown>
    if (updates.allowedChatIds === null || updates.allowedChatIds.length === 0) {
      delete cfg.allowedChatIds
    } else {
      cfg.allowedChatIds = updates.allowedChatIds
    }
    setValues.platformConfig = JSON.stringify(cfg)
  }

  await db.update(channels).set(setValues).where(eq(channels.id, channelId))
  const updated = await getChannel(channelId)

  if (updated) {
    sseManager.broadcast({
      type: 'channel:updated',
      agentId: updated.agentId,
      data: { channelId: updated.id, agentId: updated.agentId },
    })
  }

  return updated
}

export async function deleteChannel(channelId: string) {
  const existing = await getChannel(channelId)
  if (!existing) return false

  // Stop adapter if active
  if (existing.status === 'active') {
    const adapter = channelAdapters.get(existing.platform)
    if (adapter) {
      try {
        const cfg = JSON.parse(existing.platformConfig) as Record<string, unknown>
        await adapter.stop(channelId)
      } catch (err) {
        log.warn({ channelId, err }, 'Failed to stop adapter during delete')
      }
    }
  }

  // Delete every vault secret referenced by the stored platformConfig.
  // Any key ending in `VaultKey` is treated as a vault reference (the
  // generalized vault dance writes `<name>VaultKey` for each password
  // field in the adapter's configSchema). Pre-#381 channels stored only
  // `botTokenVaultKey`; this still cleans them up.
  const storedConfig = JSON.parse(existing.platformConfig) as Record<string, unknown>
  for (const [key, value] of Object.entries(storedConfig)) {
    if (typeof value !== 'string' || !key.endsWith('VaultKey')) continue
    try {
      const secret = await getSecretByKey(value)
      if (secret) await deleteSecret(secret.id)
    } catch (err) {
      log.warn({ channelId, key, err }, 'Failed to delete vault secret during channel delete')
    }
  }

  await db.delete(channels).where(eq(channels.id, channelId))

  sseManager.broadcast({
    type: 'channel:deleted',
    agentId: existing.agentId,
    data: { channelId, agentId: existing.agentId },
  })

  log.info({ channelId, agentId: existing.agentId }, 'Channel deleted')
  return true
}

// ─── Activate / Deactivate ──────────────────────────────────────────────────

export async function activateChannel(channelId: string) {
  const channel = await getChannel(channelId)
  if (!channel) return null

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) {
    await setChannelStatus(channelId, 'error', `No adapter for platform "${channel.platform}"`)
    return null
  }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

  try {
    if (adapter.pairing && typeof adapter.startWithPairing === 'function') {
      // Interactive pairing (QR): the socket opens now, but the channel only
      // becomes 'active' once the user scans and the adapter reports
      // 'connected' (handled by makePairingHandler). The status stays as-is
      // until then; the UI watches `channel:pairing` SSE events.
      await adapter.startWithPairing(channelId, cfg, {
        onMessage: (incoming) => handleIncomingChannelMessage(channelId, incoming),
        onPairing: makePairingHandler(channelId, channel.agentId),
      })
      log.info({ channelId, platform: channel.platform }, 'Channel pairing started')
      return await getChannel(channelId)
    }
    await adapter.start(channelId, cfg, (incoming) => handleIncomingChannelMessage(channelId, incoming))
    await setChannelStatus(channelId, 'active')
    log.info({ channelId, platform: channel.platform }, 'Channel activated')
    return await getChannel(channelId)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    await setChannelStatus(channelId, 'error', errMsg)
    log.error({ channelId, err: errMsg }, 'Failed to activate channel')
    return await getChannel(channelId)
  }
}

export async function deactivateChannel(channelId: string) {
  const channel = await getChannel(channelId)
  if (!channel) return null

  const adapter = channelAdapters.get(channel.platform)
  if (adapter) {
    try {
      const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      await adapter.stop(channelId)
    } catch (err) {
      log.warn({ channelId, err }, 'Failed to stop adapter during deactivate')
    }
  }

  await setChannelStatus(channelId, 'inactive')
  log.info({ channelId }, 'Channel deactivated')
  return await getChannel(channelId)
}

async function setChannelStatus(channelId: string, status: ChannelStatus, statusMessage?: string) {
  await db
    .update(channels)
    .set({ status, statusMessage: statusMessage ?? null, updatedAt: new Date() })
    .where(eq(channels.id, channelId))

  const updated = await getChannel(channelId)
  if (updated) {
    sseManager.broadcast({
      type: 'channel:updated',
      agentId: updated.agentId,
      data: { channelId, agentId: updated.agentId, status },
    })
  }
}

// ─── Test connection ────────────────────────────────────────────────────────

export async function testChannel(channelId: string): Promise<{ valid: boolean; error?: string; botInfo?: { name: string; username?: string } }> {
  const channel = await getChannel(channelId)
  if (!channel) return { valid: false, error: 'Channel not found' }

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) return { valid: false, error: `No adapter for platform "${channel.platform}"` }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
  const result = await adapter.validateConfig(cfg)

  if (result.valid) {
    const botInfo = await adapter.getBotInfo(cfg)
    return { valid: true, botInfo: botInfo ?? undefined }
  }

  return result
}

// ─── Incoming message handling ──────────────────────────────────────────────

export async function handleIncomingChannelMessage(channelId: string, incoming: IncomingMessage) {
  const channel = await getChannel(channelId)
  if (!channel || channel.status !== 'active') return

  const cfg = JSON.parse(channel.platformConfig) as { allowedChatIds?: string[] }

  // Check if chat is allowed
  if (cfg.allowedChatIds?.length && !cfg.allowedChatIds.includes(incoming.platformChatId)) {
    log.debug({ channelId, chatId: incoming.platformChatId }, 'Chat not in allowedChatIds, ignoring')
    return
  }

  // Resolve contact via contactPlatformIds or create pending mapping
  const { contact, pendingMappingId } = await resolveChannelContact(channel, incoming)
  const senderName = channelSenderName(contact, incoming)

  // ─── Approval gate ────────────────────────────────────────────────────────
  // The contact is still pending approval: buffer this message (capped) instead
  // of dropping it, so approving the contact can replay the backlog as a single
  // Agent turn. We do NOT enqueue while pending.
  if (pendingMappingId) {
    await bufferPendingChannelMessage(channel, pendingMappingId, incoming)
    return
  }
  // ─── End approval gate ────────────────────────────────────────────────────

  // Handle bot commands (/start, /start@botname, /start deeplink)
  if (/^\/start(?:\s|@|$)/.test(incoming.content)) {
    await handleBotStart(channel, incoming, senderName)
    return
  }

  await enqueueChannelTurn(channel, contact, [incoming])

  // Update stats (one inbound message counted)
  await db
    .update(channels)
    .set({
      messagesReceived: channel.messagesReceived + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId))
}

/** Resolve the human-readable sender name for a channel message: the contact's
 *  display name (falling back to its first nickname), else the platform handle. */
function channelSenderName(
  contact: typeof contacts.$inferSelect | null,
  incoming: IncomingMessage,
): string {
  let contactDisplayName: string | null = null
  if (contact) {
    // If firstName/lastName both missing, look up the first nickname as fallback
    let firstNickname: string | undefined
    if (!contact.firstName && !contact.lastName) {
      const nick = db
        .select({ nickname: contactNicknames.nickname })
        .from(contactNicknames)
        .where(eq(contactNicknames.contactId, contact.id))
        .limit(1)
        .get()
      firstNickname = nick?.nickname
    }
    const name = getContactDisplayName({
      firstName: contact.firstName,
      lastName: contact.lastName,
      nicknames: firstNickname ? [firstNickname] : undefined,
    })
    contactDisplayName = name === 'Unnamed contact' ? null : name
  }
  return contactDisplayName ?? incoming.platformDisplayName ?? incoming.platformUsername ?? 'Unknown'
}

/**
 * Buffer a message from a still-pending contact (capped at
 * config.channels.maxPendingBufferedMessages, keeping the most recent). The
 * "pending approval" reply is sent only once (on the first buffered message) to
 * avoid spamming the sender on every message. Stats are counted here so each
 * inbound is counted exactly once (the replay on approval does not re-count).
 */
async function bufferPendingChannelMessage(
  channel: typeof channels.$inferSelect,
  mappingId: string,
  incoming: IncomingMessage,
) {
  const priorCount =
    db.select({ value: count() }).from(channelPendingMessages).where(eq(channelPendingMessages.mappingId, mappingId)).get()
      ?.value ?? 0

  await db.insert(channelPendingMessages).values({
    id: uuid(),
    mappingId,
    payload: JSON.stringify(incoming),
    createdAt: new Date(),
  })

  // Enforce the cap: keep only the most recent N (drop the oldest overflow).
  const cap = config.channels.maxPendingBufferedMessages
  if (priorCount + 1 > cap) {
    const rows = db
      .select({ id: channelPendingMessages.id })
      .from(channelPendingMessages)
      .where(eq(channelPendingMessages.mappingId, mappingId))
      .orderBy(asc(channelPendingMessages.createdAt))
      .all()
    const overflow = rows.slice(0, Math.max(0, rows.length - cap))
    for (const r of overflow) {
      await db.delete(channelPendingMessages).where(eq(channelPendingMessages.id, r.id))
    }
  }

  // Notify the sender once that they are pending approval.
  if (priorCount === 0) {
    const adapter = channelAdapters.get(channel.platform)
    if (adapter) {
      const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      adapter
        .sendMessage(channel.id, adapterCfg, {
          chatId: incoming.platformChatId,
          content: 'Your access is pending approval. Please wait for an admin to approve your access.',
          replyToMessageId: incoming.platformMessageId,
        })
        .catch((err) => log.warn({ channelId: channel.id, err }, 'Failed to send pending-approval message'))
    }
  }

  // Count the inbound message even though it is not enqueued yet.
  await db
    .update(channels)
    .set({
      messagesReceived: channel.messagesReceived + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channel.id))
}

/**
 * Build and enqueue a SINGLE Agent turn from one or more channel messages.
 * Used both for the live path (one message) and the approval replay (the
 * accumulated backlog), so a freshly-approved contact triggers exactly one
 * turn carrying everything they said. Attachments across all messages are
 * downloaded and merged. Stats are NOT updated here (the caller owns counting).
 */
async function enqueueChannelTurn(
  channel: typeof channels.$inferSelect,
  contact: typeof contacts.$inferSelect | null,
  messages: IncomingMessage[],
) {
  const first = messages[0]
  if (!first) return

  const channelId = channel.id
  const last = messages[messages.length - 1] ?? first
  const senderName = channelSenderName(contact, first)

  // Sender prefix (once). When the contact is unresolved, include platform
  // metadata so the Agent can identify/create the contact itself.
  const head = contact
    ? `[${channel.platform}:${senderName}]`
    : (() => {
        const parts = [`${channel.platform}_id: ${first.platformUserId}`]
        if (first.platformUsername) parts.push(`username: ${first.platformUsername}`)
        return `[${channel.platform}:${senderName} (unknown, ${parts.join(', ')})]`
      })()

  const bodies = messages.map((m) => m.content).filter((c) => c && c.trim().length > 0)
  let content = bodies.length > 0 ? `${head} ${bodies.join('\n')}` : head

  // Download and merge file attachments from every buffered message.
  const fileIdSet: string[] = []
  let totalAttachments = 0
  const failedLines: string[] = []
  for (const m of messages) {
    if (!m.attachments || m.attachments.length === 0) continue
    totalAttachments += m.attachments.length
    const result = await downloadChannelAttachments(channel.agentId, m.attachments)
    fileIdSet.push(...result.fileIds)
    for (const f of result.failedAttachments) {
      failedLines.push(`- ${f.fileName ?? f.mimeType ?? 'unknown file'}: ${f.reason}`)
    }
  }
  const fileIds = fileIdSet.length > 0 ? fileIdSet : undefined
  if (failedLines.length > 0) {
    content += `\n\n[System: The user sent ${totalAttachments} file(s), but ${failedLines.length} could not be processed:\n${failedLines.join('\n')}]`
  }

  // Pre-generate ID so the queue item can self-reference as its own channelOriginId
  const originId = uuid()

  // Adapter-provided context line (already localized) for the conversation UI,
  // built from the most recent message's metadata.
  let inboundContextLine: string | null = null
  if (last.metadata && Object.keys(last.metadata).length > 0) {
    const adapter = channelAdapters.get(channel.platform)
    if (adapter?.formatInboundContext) {
      try {
        const locale = resolveChannelLocale(channelId)
        inboundContextLine = adapter.formatInboundContext(last.metadata, locale)
      } catch (err) {
        log.warn({ channelId, err }, 'formatInboundContext threw, ignoring')
      }
    }
  }

  // One-shot transfer hint consumed on the first inbound after a transfer_channel.
  const transferHint = popChannelTransferHint(channelId)

  const messageMetadata: Record<string, unknown> | undefined = (() => {
    const hasChannelMeta = last.metadata && Object.keys(last.metadata).length > 0
    if (!hasChannelMeta && !inboundContextLine && !transferHint) return undefined
    const out: Record<string, unknown> = {}
    if (hasChannelMeta) out.channel = last.metadata
    if (inboundContextLine) out.channelContextLine = inboundContextLine
    if (transferHint) out.channelTransfer = transferHint
    return out
  })()

  const { id: queueItemId } = await enqueueMessage({
    id: originId,
    agentId: channel.agentId,
    messageType: 'channel',
    content,
    sourceType: 'channel',
    sourceId: channelId,
    priority: config.queue.userPriority,
    fileIds,
    channelOriginId: originId,
    messageMetadata,
  })

  // Reply threading / direct response targets the most recent message.
  setChannelQueueMeta(queueItemId, {
    channelId,
    platformChatId: last.platformChatId,
    platformMessageId: last.platformMessageId,
    platformUserId: last.platformUserId,
  })

  setChannelOriginMeta(originId, {
    channelId,
    platformChatId: last.platformChatId,
    platformMessageId: last.platformMessageId,
    platformUserId: last.platformUserId,
  })

  // Send typing indicator (fire-and-forget)
  const adapter = channelAdapters.get(channel.platform)
  if (adapter?.sendTypingIndicator) {
    const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    adapter.sendTypingIndicator(channel.id, adapterCfg, last.platformChatId).catch(() => {})
  }

  // Emit SSE event for web UI
  sseManager.sendToAgent(channel.agentId, {
    type: 'channel:message-received',
    agentId: channel.agentId,
    data: { channelId, platform: channel.platform, sender: senderName },
  })

  log.info(
    { channelId, agentId: channel.agentId, sender: senderName, platform: channel.platform, messages: messages.length },
    'Channel message received',
  )
}

// ─── Bot /start command ──────────────────────────────────────────────────────

async function handleBotStart(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
  senderName: string,
) {
  // Fetch Agent info for the welcome message
  const agent = await db
    .select({ name: agents.name, role: agents.role })
    .from(agents)
    .where(eq(agents.id, channel.agentId))
    .get()

  const agentName = agent?.name ?? 'Agent'
  const agentRole = agent?.role ? ` — ${agent.role}` : ''
  const welcomeText = `Hi! I'm ${agentName}${agentRole}.\nSend me a message and I'll respond.`

  // Send welcome message via adapter
  const adapter = channelAdapters.get(channel.platform)
  if (adapter) {
    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    try {
      await adapter.sendMessage(channel.id, cfg, {
        chatId: incoming.platformChatId,
        content: welcomeText,
        replyToMessageId: incoming.platformMessageId,
      })
    } catch (err) {
      log.error({ channelId: channel.id, err }, 'Failed to send /start welcome message')
    }
  }

  // Update stats (count as received but not sent to Agent)
  await db
    .update(channels)
    .set({
      messagesReceived: channel.messagesReceived + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channel.id))

  log.info({ channelId: channel.id, sender: senderName, platform: channel.platform }, 'Handled /start command')
}

// ─── Cross-Agent proactive send ───────────────────────────────────────────────

export interface SendToChannelAsParams {
  channelId: string
  /** The Agent actually sending. Drives the cross-Agent prefix + audit trail. */
  senderAgentId: string
  chatId: string
  content: string
  attachments?: OutboundAttachment[]
}

export interface SendToChannelAsResult {
  platformMessageId: string
  /** True when a `[AgentName]` prefix was prepended (sender ≠ channel owner). */
  prefixed: boolean
}

/**
 * Send a message proactively through a channel, on behalf of `senderAgentId`.
 *
 * Shared by send_channel_message and send_to_contact. Unlike
 * `deliverChannelResponse` (auto-delivery of an Agent reply tied to an assistant
 * `messages` row), this path has no originating message — it persists an audit
 * `channel_message_links` row with `messageId = null` and `sentByAgentId` set.
 *
 * Cross-Agent handling: when the sending Agent is NOT the channel owner
 * (channels.agentId), the message is prefixed with `[SenderAgentName] ` so the human
 * understands who is speaking through the borrowed bot, regardless of the
 * adapter's identitySwitchMode. When the sender IS the owner, no prefix is added
 * (preserves the historical single-Agent behaviour).
 *
 * Channel existence (not ownership) is the only gate — on a self-hosted
 * single-user instance every Agent is under the same control.
 */
export async function sendToChannelAs(
  params: SendToChannelAsParams,
): Promise<{ ok: true; result: SendToChannelAsResult } | { ok: false; error: string }> {
  const { channelId, senderAgentId, chatId, content, attachments } = params

  const channel = await getChannel(channelId)
  if (!channel) return { ok: false, error: 'Channel not found' }
  if (channel.status !== 'active') return { ok: false, error: 'Channel is not active' }

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) return { ok: false, error: `No adapter for platform ${channel.platform}` }

  // Cross-Agent prefix: only when the sender is not the channel owner.
  const isCrossAgent = senderAgentId !== channel.agentId
  let outboundContent = content
  let prefixed = false
  if (isCrossAgent) {
    const senderRow = db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, senderAgentId))
      .get()
    if (senderRow?.name) {
      const next = applyAgentNamePrefix(content, senderRow.name)
      prefixed = next !== content
      outboundContent = next
    }
  }

  try {
    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    const locale = resolveChannelLocale(channelId)
    const result = await adapter.sendMessage(channelId, cfg, {
      chatId,
      content: outboundContent,
      attachments: attachments?.length ? attachments : undefined,
      locale,
    })

    // Audit link: no originating assistant message, but record who sent it.
    await db.insert(channelMessageLinks).values({
      id: uuid(),
      channelId,
      messageId: null,
      platformMessageId: result.platformMessageId,
      platformChatId: chatId,
      direction: 'outbound',
      sentByAgentId: senderAgentId,
      createdAt: new Date(),
    })

    // Update stats
    await db
      .update(channels)
      .set({
        messagesSent: channel.messagesSent + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId))

    // SSE — broadcast to the channel owner so any open UI tab refreshes.
    sseManager.sendToAgent(channel.agentId, {
      type: 'channel:message-sent',
      agentId: channel.agentId,
      data: {
        channelId,
        platform: channel.platform,
        messageId: null,
        contextLine: result.contextLine ?? null,
      },
    })

    log.info(
      {
        channelId,
        ownerAgentId: channel.agentId,
        senderAgentId,
        crossAgent: isCrossAgent,
        prefix: prefixed,
        platform: channel.platform,
      },
      'Proactive channel message sent',
    )

    return { ok: true, result: { platformMessageId: result.platformMessageId, prefixed } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

// ─── Response delivery ──────────────────────────────────────────────────────

export async function deliverChannelResponse(
  meta: ChannelQueueMeta,
  assistantMessageId: string,
  content: string,
  attachments?: OutboundAttachment[],
) {
  const channel = await getChannel(meta.channelId)
  if (!channel || channel.status !== 'active') return

  const adapter = channelAdapters.get(channel.platform)
  if (!adapter) {
    log.error({ channelId: meta.channelId }, 'No adapter found for response delivery')
    return
  }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

  // Identity prefix fallback. When the adapter does NOT switch identity
  // natively on the external platform, we prepend "[Agent Name] " to the
  // text content so the user knows which Agent is speaking after a
  // transfer_channel handoff. Precedence:
  //   - 'native': adapter pushed name/avatar to the platform itself,
  //               no prefix needed.
  //   - 'none':   neither switch nor prefix (caller opted out).
  //   - 'prefix' or undefined (default): prepend the prefix.
  // Skip when content is empty (attachments-only messages do not need
  // an identity hint).
  let outboundContent = content
  if (
    adapter.identitySwitchMode !== 'native' &&
    adapter.identitySwitchMode !== 'none' &&
    typeof content === 'string' &&
    content.trim().length > 0
  ) {
    const agentRow = db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, channel.agentId))
      .get()
    if (agentRow?.name) {
      outboundContent = applyAgentNamePrefix(content, agentRow.name)
    }
  }

  try {
    const locale = resolveChannelLocale(meta.channelId)
    const result = await adapter.sendMessage(meta.channelId, cfg, {
      chatId: meta.platformChatId,
      content: outboundContent,
      replyToMessageId: meta.platformMessageId,
      attachments: attachments?.length ? attachments : undefined,
      locale,
    })

    // Record the outbound link. Auto-delivered replies are authored by the
    // channel's current owner Agent, so sentByAgentId mirrors channel.agentId.
    await db.insert(channelMessageLinks).values({
      id: uuid(),
      channelId: meta.channelId,
      messageId: assistantMessageId,
      platformMessageId: result.platformMessageId,
      platformChatId: meta.platformChatId,
      direction: 'outbound',
      sentByAgentId: channel.agentId,
      createdAt: new Date(),
    })

    // Persist delivery context on the Agent's message so the UI can render a
    // "Sent on X via Y" hint under the bubble. Merge with whatever metadata
    // the engine already wrote.
    if (result.contextLine || result.deliveryMeta) {
      try {
        const existing = await db
          .select({ metadata: messages.metadata })
          .from(messages)
          .where(eq(messages.id, assistantMessageId))
          .get()
        let merged: Record<string, unknown> = {}
        if (existing?.metadata) {
          try { merged = JSON.parse(existing.metadata as string) as Record<string, unknown> } catch { /* corrupted, overwrite */ }
        }
        merged.channelDelivery = {
          platform: channel.platform,
          ...(result.contextLine ? { contextLine: result.contextLine } : {}),
          ...(result.deliveryMeta ? { meta: result.deliveryMeta } : {}),
        }
        await db
          .update(messages)
          .set({ metadata: JSON.stringify(merged) })
          .where(eq(messages.id, assistantMessageId))
      } catch (err) {
        log.warn({ messageId: assistantMessageId, err }, 'Failed to persist channelDelivery metadata')
      }
    }

    // Update stats
    await db
      .update(channels)
      .set({
        messagesSent: channel.messagesSent + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, meta.channelId))

    // Emit SSE — include contextLine so the UI can refresh the message hint
    sseManager.sendToAgent(channel.agentId, {
      type: 'channel:message-sent',
      agentId: channel.agentId,
      data: {
        channelId: meta.channelId,
        platform: channel.platform,
        messageId: assistantMessageId,
        contextLine: result.contextLine ?? null,
      },
    })

    log.info({ channelId: meta.channelId, agentId: channel.agentId, platform: channel.platform }, 'Channel response delivered')
  } catch (err) {
    log.error({ channelId: meta.channelId, err }, 'Failed to deliver channel response')
  }
}

/**
 * The Agent wrote a reply for a turn that came from an external channel, but no
 * destination could be resolved (origin row missing or past the freshness
 * window). Without this the reply vanishes silently and the Agent believes it
 * answered. Tell it, in its own conversation, so it can resend explicitly.
 *
 * Callers must have established that the turn really had a channel origin.
 * This must never fire for a plain web-UI or external-API reply.
 */
export async function reportUndeliveredChannelReply(params: {
  agentId: string
  assistantMessageId: string
  channelOriginId?: string
  reason: string
}): Promise<void> {
  const { agentId, assistantMessageId, channelOriginId, reason } = params
  const content =
    '⚠️ Your previous reply was NOT delivered to any external channel: the originating channel context could not be resolved ' +
    `(${reason}). If it was meant for a contact or a channel, send it again explicitly with send_to_contact() or send_channel_message().`

  const msgId = uuid()
  const createdAt = new Date()
  await db.insert(messages).values({
    id: msgId,
    agentId,
    role: 'user',
    content,
    sourceType: 'system',
    metadata: JSON.stringify({ systemEvent: 'channel_delivery_failed', assistantMessageId, channelOriginId: channelOriginId ?? null, reason }),
    createdAt,
  })

  sseManager.sendToAgent(agentId, {
    type: 'chat:message',
    agentId,
    data: { id: msgId, role: 'user', content, sourceType: 'system', createdAt: createdAt.getTime() },
  })

  // Mirror the success path's `channelDelivery` marker so the undelivered state
  // is visible on the Agent's own message, not only in the follow-up note.
  try {
    const existing = await db.select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, assistantMessageId)).get()
    let merged: Record<string, unknown> = {}
    if (existing?.metadata) {
      try { merged = JSON.parse(existing.metadata as string) as Record<string, unknown> } catch { /* corrupted, overwrite */ }
    }
    merged.channelDelivery = { status: 'undelivered', reason }
    await db.update(messages).set({ metadata: JSON.stringify(merged) }).where(eq(messages.id, assistantMessageId))
  } catch (err) {
    log.warn({ messageId: assistantMessageId, err }, 'Failed to mark message as undelivered')
  }
}

// ─── Asynchronous delivery-status updates (webhook status callbacks) ─────────

// Short localized labels for the delivery hint shown under the bubble. The
// status set is bounded (DeliveryStatus), so an inline map beats wiring the
// server into the client i18n bundle. Falls back to English, then to the raw
// status string for anything unmapped.
const DELIVERY_STATUS_LABELS: Record<string, Partial<Record<string, string>>> = {
  en: { delivered: 'Delivered', sent: 'Sent', queued: 'Queued', read: 'Read', undelivered: 'Delivery failed', failed: 'Delivery failed' },
  fr: { delivered: 'Remis', sent: 'Envoyé', queued: 'En file d’attente', read: 'Lu', undelivered: 'Échec de remise', failed: 'Échec de remise' },
  de: { delivered: 'Zugestellt', sent: 'Gesendet', queued: 'In Warteschlange', read: 'Gelesen', undelivered: 'Zustellung fehlgeschlagen', failed: 'Zustellung fehlgeschlagen' },
  es: { delivered: 'Entregado', sent: 'Enviado', queued: 'En cola', read: 'Leído', undelivered: 'Entrega fallida', failed: 'Entrega fallida' },
}

function buildDeliveryContextLine(update: DeliveryStatusUpdate, platformName: string, locale: string): string {
  const lang = (locale || 'en').slice(0, 2).toLowerCase()
  const labels = DELIVERY_STATUS_LABELS[lang] ?? DELIVERY_STATUS_LABELS.en ?? {}
  const label = labels[update.status] ?? update.status
  const isFailure = update.status === 'failed' || update.status === 'undelivered'
  const isSuccess = update.status === 'delivered' || update.status === 'read'
  const icon = isFailure ? '✗ ' : isSuccess ? '✓ ' : ''
  const errorSuffix = isFailure && update.errorCode ? ` (${update.errorCode})` : ''
  return `${icon}${label}${errorSuffix} · ${platformName}`
}

/**
 * Apply an asynchronous delivery-status update produced by a webhook-driven
 * channel (e.g. a Twilio MessageStatus callback). Correlates the provider's
 * message id back to the originating Agent message via `channelMessageLinks`,
 * refreshes the delivery hint stored on that message, and emits SSE so the
 * bubble updates live. No-op when the message id can't be correlated (e.g.
 * proactive sends with no originating message, or a callback that races the
 * link insert).
 */
export async function applyChannelDeliveryStatusUpdate(
  channelId: string,
  update: DeliveryStatusUpdate,
): Promise<void> {
  const channel = await getChannel(channelId)
  if (!channel) return

  const link = db
    .select({ messageId: channelMessageLinks.messageId })
    .from(channelMessageLinks)
    .where(
      and(
        eq(channelMessageLinks.channelId, channelId),
        eq(channelMessageLinks.platformMessageId, update.platformMessageId),
        eq(channelMessageLinks.direction, 'outbound'),
      ),
    )
    .orderBy(desc(channelMessageLinks.createdAt))
    .get()

  if (!link?.messageId) {
    log.info(
      { channelId, platformMessageId: update.platformMessageId, status: update.status },
      'Delivery status update with no linked message; skipping UI update',
    )
    return
  }

  const platformName = channelAdapters.get(channel.platform)?.meta?.displayName ?? channel.platform
  const locale = resolveChannelLocale(channelId)
  const contextLine = update.contextLine ?? buildDeliveryContextLine(update, platformName, locale)

  try {
    const existing = db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(eq(messages.id, link.messageId))
      .get()
    let merged: Record<string, unknown> = {}
    if (existing?.metadata) {
      try { merged = JSON.parse(existing.metadata as string) as Record<string, unknown> } catch { /* corrupted, overwrite */ }
    }
    const prevDelivery =
      merged.channelDelivery && typeof merged.channelDelivery === 'object'
        ? (merged.channelDelivery as Record<string, unknown>)
        : {}
    merged.channelDelivery = {
      ...prevDelivery,
      platform: channel.platform,
      contextLine,
      deliveryStatus: update.status,
      ...(update.errorCode ? { errorCode: update.errorCode } : {}),
      ...(update.errorMessage ? { errorMessage: update.errorMessage } : {}),
    }
    await db
      .update(messages)
      .set({ metadata: JSON.stringify(merged) })
      .where(eq(messages.id, link.messageId))
  } catch (err) {
    log.warn({ messageId: link.messageId, err }, 'Failed to persist delivery status update')
    return
  }

  // Reuse channel:message-sent — the client already updates the message's
  // channelContextLine from this event, so the hint refreshes without a fetch.
  sseManager.sendToAgent(channel.agentId, {
    type: 'channel:message-sent',
    agentId: channel.agentId,
    data: {
      channelId,
      platform: channel.platform,
      messageId: link.messageId,
      contextLine,
    },
  })

  log.info(
    { channelId, agentId: channel.agentId, messageId: link.messageId, status: update.status, errorCode: update.errorCode },
    'Applied channel delivery status update',
  )
}

// ─── Channel transfer (UI + tool share this single entry point) ─────────────

export interface TransferChannelParams {
  channelId: string
  targetAgentId: string
  reason?: string
  /** Surfaced in the log line only; useful for ops traceability. */
  initiatedBy: 'tool' | 'ui'
  /** Calling Agent ID (tool flow). Logged for audit, not persisted. */
  calledByAgentId?: string
}

export type TransferChannelResult =
  | { ok: true; noop: true; message: string }
  | {
      ok: true
      noop?: false
      transferredAt: number
      previousAgentSlug: string
      newAgentSlug: string
      fromAgentId: string
      fromAgentName: string
      toAgentId: string
      toAgentName: string
    }
  | { ok: false; error: string }

/**
 * Re-bind a channel to a different Agent at runtime. Single source of truth for
 * both the transfer_channel tool and the REST endpoint
 * POST /api/channels/:id/transfer. Wraps:
 *
 *   1. Validation: channel exists, target Agent exists, no-op detection.
 *   2. channels.agentId mutation.
 *   3. Two role='system' audit-trail messages (one per Agent, with
 *      metadata.systemEvent set so buildMessageHistory can filter them out
 *      of the LLM prompt and the UI can render them as handoff banners).
 *   4. Sideband channelTransferHint for the next inbound's <channel-context>.
 *   5. SSE 'channel:transferred' broadcast.
 *   6. Best-effort adapter.onIdentityChange (warn on failure).
 *
 * Callers should never re-implement any of these steps directly; the only
 * place channels.agentId is mutated should be here.
 */
export async function transferChannel(params: TransferChannelParams): Promise<TransferChannelResult> {
  const channel = await getChannel(params.channelId)
  if (!channel) {
    return { ok: false, error: `Channel "${params.channelId}" not found.` }
  }

  if (channel.agentId === params.targetAgentId) {
    return { ok: true, noop: true, message: 'Channel is already bound to this Agent.' }
  }

  const fromAgentRow = db
    .select({ id: agents.id, slug: agents.slug, name: agents.name })
    .from(agents)
    .where(eq(agents.id, channel.agentId))
    .get()
  if (!fromAgentRow) {
    return { ok: false, error: `Source Agent "${channel.agentId}" not found; refusing to transfer from a dangling binding.` }
  }
  const toAgentRow = db
    .select({ id: agents.id, slug: agents.slug, name: agents.name, avatarPath: agents.avatarPath, updatedAt: agents.updatedAt })
    .from(agents)
    .where(eq(agents.id, params.targetAgentId))
    .get()
  if (!toAgentRow) {
    return { ok: false, error: `Target Agent "${params.targetAgentId}" not found; refusing to transfer to a dangling binding.` }
  }

  const fromAgentId = fromAgentRow.id
  const fromAgentSlug = fromAgentRow.slug ?? fromAgentRow.id
  const fromAgentName = fromAgentRow.name
  const toAgentId = toAgentRow.id
  const toAgentSlug = toAgentRow.slug ?? toAgentRow.id
  const toAgentName = toAgentRow.name

  const at = Date.now()
  const now = new Date(at)

  // (2) Mutate the binding.
  await db
    .update(channels)
    .set({ agentId: toAgentId, updatedAt: now })
    .where(eq(channels.id, channel.id))

  // (3) Audit-trail rows. Same content/shape as before the extraction so the
  //     UI rendering and prompt filtering continue to work unchanged.
  const reasonOrNull = params.reason ?? null
  const outMetaJson = JSON.stringify({
    systemEvent: 'channel_transferred_out',
    channelId: channel.id,
    channelName: channel.name,
    targetAgentId: toAgentId,
    targetAgentSlug: toAgentSlug,
    targetAgentName: toAgentName,
    reason: reasonOrNull,
    at,
  })
  const inMetaJson = JSON.stringify({
    systemEvent: 'channel_transferred_in',
    channelId: channel.id,
    channelName: channel.name,
    fromAgentId,
    fromAgentSlug,
    fromAgentName,
    reason: reasonOrNull,
    at,
  })
  await db.insert(messages).values({
    id: uuid(),
    agentId: fromAgentId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: outMetaJson,
    createdAt: now,
  })
  await db.insert(messages).values({
    id: uuid(),
    agentId: toAgentId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: inMetaJson,
    createdAt: now,
  })

  // (4) One-shot sideband hint for the next inbound.
  setChannelTransferHint(channel.id, {
    fromAgentId,
    fromAgentSlug,
    fromAgentName,
    reason: params.reason,
    at,
  })

  // (5) Live UI broadcast.
  sseManager.broadcast({
    type: 'channel:transferred',
    data: {
      channelId: channel.id,
      channelName: channel.name,
      platform: channel.platform,
      fromAgentId,
      fromAgentSlug,
      fromAgentName,
      toAgentId,
      toAgentSlug,
      toAgentName,
      reason: reasonOrNull,
      at,
    },
  })

  // (6) Best-effort native identity switch on the external platform.
  const adapter = channelAdapters.get(channel.platform)
  if (adapter && typeof adapter.onIdentityChange === 'function') {
    try {
      const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      const relAvatar = agentAvatarUrl(toAgentId, toAgentRow.avatarPath, toAgentRow.updatedAt)
      const avatarUrl = relAvatar ? `${config.publicUrl}${relAvatar}` : undefined
      await adapter.onIdentityChange(channel.id, cfg, {
        agentSlug: toAgentSlug,
        agentName: toAgentName,
        avatarUrl,
      })
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), channelId: channel.id, newAgentSlug: toAgentSlug },
        'onIdentityChange failed (non-fatal); the prefix fallback (if any) still applies',
      )
    }
  }

  log.info(
    {
      initiatedBy: params.initiatedBy,
      calledByAgentId: params.calledByAgentId ?? null,
      channelId: channel.id,
      fromAgentId,
      toAgentId,
      reason: reasonOrNull,
    },
    'Channel transferred',
  )

  return {
    ok: true,
    transferredAt: at,
    previousAgentSlug: fromAgentSlug,
    newAgentSlug: toAgentSlug,
    fromAgentId,
    fromAgentName,
    toAgentId,
    toAgentName,
  }
}

// ─── Contact resolution ─────────────────────────────────────────────────────

/** Look up a contact by (platform, platformId) in the contactPlatformIds table */
export function findContactByPlatformId(platform: string, platformId: string) {
  const row = db
    .select({ contactId: contactPlatformIds.contactId })
    .from(contactPlatformIds)
    .where(and(eq(contactPlatformIds.platform, platform), eq(contactPlatformIds.platformId, platformId)))
    .get()

  return row ? db.select().from(contacts).where(eq(contacts.id, row.contactId)).get() ?? null : null
}

interface ResolvedChannelUser {
  contact: typeof contacts.$inferSelect | null
  /** Non-null only when the user is pending approval */
  pendingMappingId: string | null
}

/**
 * Auto-create and authorize a contact for an unknown sender on a channel whose
 * approval gate is disabled (autoCreateContacts). Always creates a NEW distinct
 * contact identified only by the platform handle (nickname), then binds the
 * (platform, platformUserId) → contact authorization. Returns the contact, or
 * null if creation failed (caller falls back to the approval flow).
 */
async function autoCreateChannelContact(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
): Promise<typeof contacts.$inferSelect | null> {
  const handle =
    incoming.platformDisplayName ??
    incoming.platformUsername ??
    `${channel.platform}:${incoming.platformUserId}`

  const result = await createContact({ nicknames: [handle] })
  if ('error' in result) {
    log.warn(
      { channelId: channel.id, platformUserId: incoming.platformUserId, linked: result.linkedContactName },
      'Auto-create contact failed; falling back to approval flow',
    )
    return null
  }

  const now = new Date()
  await db.insert(contactPlatformIds).values({
    id: uuid(),
    contactId: result.id,
    platform: channel.platform,
    platformId: incoming.platformUserId,
    createdAt: now,
    updatedAt: now,
  })

  log.info(
    { channelId: channel.id, contactId: result.id, platform: channel.platform },
    'Auto-created contact (approval disabled for channel)',
  )

  return db.select().from(contacts).where(eq(contacts.id, result.id)).get() ?? null
}

async function resolveChannelContact(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
): Promise<ResolvedChannelUser> {
  // 1. Check contactPlatformIds — authorized contact?
  const contact = findContactByPlatformId(channel.platform, incoming.platformUserId)
  if (contact) {
    return { contact, pendingMappingId: null }
  }

  // 1b. Approval disabled for this channel → auto-create a brand-new contact and
  // authorize it immediately, skipping the pending gate. SECURITY: we always
  // create a DISTINCT new contact (never auto-link to an existing one based on a
  // claimed identity) and only ever bind the platform id to this fresh contact.
  // The contact carries only the platform handle as a nickname (no "verified"
  // name) so it stays visibly distinct from a validated contact.
  if (channel.autoCreateContacts) {
    const created = await autoCreateChannelContact(channel, incoming)
    if (created) return { contact: created, pendingMappingId: null }
    // Fall through to the approval flow if auto-create failed for any reason.
  }

  // 2. Check for existing pending mapping on this channel
  const existingMapping = await db
    .select()
    .from(channelUserMappings)
    .where(
      and(
        eq(channelUserMappings.channelId, channel.id),
        eq(channelUserMappings.platformUserId, incoming.platformUserId),
      ),
    )
    .get()

  if (existingMapping) {
    // Update metadata (username, display name may have changed)
    await db
      .update(channelUserMappings)
      .set({
        platformUsername: incoming.platformUsername ?? existingMapping.platformUsername,
        platformDisplayName: incoming.platformDisplayName ?? existingMapping.platformDisplayName,
        updatedAt: new Date(),
      })
      .where(eq(channelUserMappings.id, existingMapping.id))

    return { contact: null, pendingMappingId: existingMapping.id }
  }

  // 3. New user — create pending mapping + broadcast
  const now = new Date()
  const mappingId = uuid()
  await db.insert(channelUserMappings).values({
    id: mappingId,
    channelId: channel.id,
    platformUserId: incoming.platformUserId,
    platformUsername: incoming.platformUsername ?? null,
    platformDisplayName: incoming.platformDisplayName ?? null,
    contactId: null,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  })

  sseManager.broadcast({
    type: 'channel:user-pending',
    agentId: channel.agentId,
    data: {
      channelId: channel.id,
      mappingId,
      platformUsername: incoming.platformUsername,
      platformDisplayName: incoming.platformDisplayName,
      platform: channel.platform,
    },
  })

  // Persistent notification
  const { createNotification } = await import('@/server/services/notifications')
  createNotification({
    type: 'channel:user-pending',
    title: 'New user awaiting approval',
    body: `${incoming.platformDisplayName ?? incoming.platformUsername ?? incoming.platformUserId} on ${channel.name}`,
    agentId: channel.agentId,
    relatedId: channel.id,
    relatedType: 'channel',
  }).catch(() => {})

  log.info(
    { channelId: channel.id, platformUserId: incoming.platformUserId, platform: channel.platform },
    'New channel user pending approval',
  )

  return { contact: null, pendingMappingId: mappingId }
}

// ─── User mappings (pending only) ───────────────────────────────────────────

export async function listPendingUsers(channelId: string) {
  const mappings = db
    .select({
      id: channelUserMappings.id,
      channelId: channelUserMappings.channelId,
      platformUserId: channelUserMappings.platformUserId,
      platformUsername: channelUserMappings.platformUsername,
      platformDisplayName: channelUserMappings.platformDisplayName,
      createdAt: channelUserMappings.createdAt,
    })
    .from(channelUserMappings)
    .where(and(eq(channelUserMappings.channelId, channelId), eq(channelUserMappings.status, 'pending')))
    .orderBy(desc(channelUserMappings.createdAt))
    .all()

  if (mappings.length === 0) return []

  // Number of buffered messages awaiting replay per pending mapping.
  const counts = db
    .select({ mappingId: channelPendingMessages.mappingId, value: count() })
    .from(channelPendingMessages)
    .where(inArray(channelPendingMessages.mappingId, mappings.map((m) => m.id)))
    .groupBy(channelPendingMessages.mappingId)
    .all()
  const countByMapping = new Map(counts.map((c) => [c.mappingId, c.value]))

  return mappings.map((m) => ({ ...m, bufferedCount: countByMapping.get(m.id) ?? 0 }))
}

// ─── Approval ───────────────────────────────────────────────────────────────

type ApproveParams =
  | { action: 'create'; name?: string }
  | { action: 'link'; contactId: string }

export async function approveChannelUser(mappingId: string, params: ApproveParams) {
  const mapping = await db.select().from(channelUserMappings).where(eq(channelUserMappings.id, mappingId)).get()
  if (!mapping) return null

  const channel = await getChannel(mapping.channelId)
  if (!channel) return null

  // Load any buffered messages BEFORE the mapping (and its cascade) is removed,
  // so we can replay them as a single Agent turn once the contact is authorized.
  const bufferedRows = db
    .select({ payload: channelPendingMessages.payload })
    .from(channelPendingMessages)
    .where(eq(channelPendingMessages.mappingId, mappingId))
    .orderBy(asc(channelPendingMessages.createdAt))
    .all()

  const now = new Date()
  let contactId: string

  if (params.action === 'create') {
    // Create a new contact with the platform ID pre-filled.
    // Use the user-provided name as firstName, falling back to platform metadata as a nickname.
    const rawName = params.name?.trim()
    const fallbackNick = mapping.platformDisplayName ?? mapping.platformUsername ?? `${channel.platform}:${mapping.platformUserId}`
    const result = await createContact(
      rawName
        ? { firstName: rawName }
        : { nicknames: [fallbackNick] },
    )
    if ('error' in result) throw new Error(`User already linked to "${result.linkedContactName}"`)
    contactId = result.id
    log.info({ mappingId, contactId, firstName: rawName ?? null }, 'Created contact on approval')
  } else {
    // Link to an existing contact — verify it exists
    const existing = await db.select().from(contacts).where(eq(contacts.id, params.contactId)).get()
    if (!existing) throw new Error('Contact not found')
    contactId = params.contactId
  }

  // Insert platform ID linking (platform, platformUserId) → contact
  await db.insert(contactPlatformIds).values({
    id: uuid(),
    contactId,
    platform: channel.platform,
    platformId: mapping.platformUserId,
    createdAt: now,
    updatedAt: now,
  })

  // Replay the buffered backlog as a single Agent turn now that the contact is
  // authorized, then clear the buffer (cascade on the mapping delete is a
  // backstop; we don't rely on PRAGMA foreign_keys being on).
  if (bufferedRows.length > 0) {
    const contactRow = db.select().from(contacts).where(eq(contacts.id, contactId)).get() ?? null
    const buffered = bufferedRows
      .map((r) => {
        try {
          return JSON.parse(r.payload) as IncomingMessage
        } catch {
          return null
        }
      })
      .filter((m): m is IncomingMessage => m !== null)
    if (contactRow && buffered.length > 0) {
      await enqueueChannelTurn(channel, contactRow, buffered)
    }
    await db.delete(channelPendingMessages).where(eq(channelPendingMessages.mappingId, mappingId))
  }

  // Delete this pending mapping
  await db.delete(channelUserMappings).where(eq(channelUserMappings.id, mappingId))

  // Clean up any other pending mappings for the same (platform, platformUserId) on other channels
  // since the user is now globally authorized via contactPlatformIds
  const otherMappings = await db
    .select({ id: channelUserMappings.id, channelId: channelUserMappings.channelId })
    .from(channelUserMappings)
    .where(
      and(
        eq(channelUserMappings.platformUserId, mapping.platformUserId),
        eq(channelUserMappings.status, 'pending'),
      ),
    )
    .all()

  // We need to know which channels share the same platform to clean up cross-channel mappings
  for (const other of otherMappings) {
    const otherChannel = await getChannel(other.channelId)
    if (otherChannel?.platform === channel.platform) {
      await db.delete(channelUserMappings).where(eq(channelUserMappings.id, other.id))
      // Broadcast approval on those channels too
      sseManager.broadcast({
        type: 'channel:user-approved',
        agentId: otherChannel.agentId,
        data: { channelId: other.channelId, mappingId: other.id },
      })
    }
  }

  // Broadcast SSE for the primary channel
  sseManager.broadcast({
    type: 'channel:user-approved',
    agentId: channel.agentId,
    data: { channelId: mapping.channelId, mappingId },
  })

  // Send approval notification to the user on the platform
  const adapter = channelAdapters.get(channel.platform)
  if (adapter) {
    const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    adapter.sendMessage(channel.id, adapterCfg, {
      chatId: mapping.platformUserId,
      content: 'Your access has been approved! You can now send messages.',
    }).catch((err) => log.warn({ channelId: channel.id, err }, 'Failed to send approval notification'))
  }

  log.info({ mappingId, channelId: mapping.channelId, contactId }, 'Channel user approved')
  return { contactId }
}

export async function countPendingApprovals(): Promise<number> {
  const result = await db
    .select({ value: count() })
    .from(channelUserMappings)
    .where(eq(channelUserMappings.status, 'pending'))
    .get()
  return result?.value ?? 0
}

export async function countPendingApprovalsForChannel(channelId: string): Promise<number> {
  const result = await db
    .select({ value: count() })
    .from(channelUserMappings)
    .where(and(eq(channelUserMappings.channelId, channelId), eq(channelUserMappings.status, 'pending')))
    .get()
  return result?.value ?? 0
}

// ─── Contact platform IDs ───────────────────────────────────────────────────

export function listContactPlatformIds(contactId: string) {
  return db
    .select({
      id: contactPlatformIds.id,
      contactId: contactPlatformIds.contactId,
      platform: contactPlatformIds.platform,
      platformId: contactPlatformIds.platformId,
      createdAt: contactPlatformIds.createdAt,
    })
    .from(contactPlatformIds)
    .where(eq(contactPlatformIds.contactId, contactId))
    .all()
}

export function removeContactPlatformId(id: string, contactId?: string): boolean {
  const existing = db.select().from(contactPlatformIds).where(eq(contactPlatformIds.id, id)).get()
  if (!existing) return false
  if (contactId && existing.contactId !== contactId) return false
  db.delete(contactPlatformIds).where(eq(contactPlatformIds.id, id)).run()
  log.info({ id, contactId: existing.contactId, platform: existing.platform, platformId: existing.platformId }, 'Contact platform ID removed (access revoked)')

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId: existing.contactId },
  })

  return true
}

export function addContactPlatformId(contactId: string, platform: string, platformId: string) {
  const now = new Date()
  const id = uuid()
  db.insert(contactPlatformIds).values({
    id,
    contactId,
    platform,
    platformId,
    createdAt: now,
    updatedAt: now,
  }).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId },
  })

  return { id, contactId, platform, platformId, createdAt: now }
}

// ─── Known conversations (for proactive messaging) ──────────────────────────

export async function listChannelConversations(channelId: string) {
  const channel = await getChannel(channelId)
  if (!channel) return { users: [], knownChatIds: [] }

  // Get authorized users for this channel's platform from contactPlatformIds
  const platformUsers = db
    .select({
      platformId: contactPlatformIds.platformId,
      contactId: contactPlatformIds.contactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contactPlatformIds)
    .innerJoin(contacts, eq(contactPlatformIds.contactId, contacts.id))
    .where(eq(contactPlatformIds.platform, channel.platform))
    .all()

  // Also include pending users from mappings
  const pendingUsers = await db
    .select({
      platformUserId: channelUserMappings.platformUserId,
      platformUsername: channelUserMappings.platformUsername,
      platformDisplayName: channelUserMappings.platformDisplayName,
    })
    .from(channelUserMappings)
    .where(and(eq(channelUserMappings.channelId, channelId), eq(channelUserMappings.status, 'pending')))
    .all()

  // Get distinct chat IDs from message links (covers both DMs and groups)
  const links = await db
    .select({
      platformChatId: channelMessageLinks.platformChatId,
    })
    .from(channelMessageLinks)
    .where(eq(channelMessageLinks.channelId, channelId))
    .all()

  const distinctChatIds = [...new Set(links.map((l) => l.platformChatId))]

  // Merge authorized + pending users
  const users = [
    ...platformUsers.map((u) => ({
      platformUserId: u.platformId,
      chatId: u.platformId, // For Telegram DMs, chatId = userId
      username: null as string | null,
      displayName: getContactDisplayName({ firstName: u.firstName, lastName: u.lastName }),
    })),
    ...pendingUsers.map((m) => ({
      platformUserId: m.platformUserId,
      chatId: m.platformUserId,
      username: m.platformUsername,
      displayName: m.platformDisplayName,
    })),
  ]

  return { users, knownChatIds: distinctChatIds }
}

// ─── Active channels for an Agent (for prompt builder) ─────────────────────────

export async function getActiveChannelsForAgent(agentId: string) {
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.agentId, agentId), eq(channels.status, 'active')))
    .all()
}

// ─── Startup: restore active channels ───────────────────────────────────────

export async function restoreActiveChannels() {
  const activeChannels = await db
    .select()
    .from(channels)
    .where(eq(channels.status, 'active'))
    .all()

  log.info({ count: activeChannels.length }, 'Restoring active channels')

  for (const channel of activeChannels) {
    const adapter = channelAdapters.get(channel.platform)
    if (!adapter) {
      log.warn({ channelId: channel.id, platform: channel.platform }, 'No adapter for active channel, marking as error')
      await setChannelStatus(channel.id, 'error', `No adapter for platform "${channel.platform}"`)
      continue
    }

    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    try {
      if (adapter.pairing && typeof adapter.startWithPairing === 'function') {
        // Reconnect from the stored session. If it's still valid the adapter
        // reports 'connected'; if it was logged out it reports 'logged-out'
        // and makePairingHandler flips the channel to an error state.
        await adapter.startWithPairing(channel.id, cfg, {
          onMessage: (incoming) => handleIncomingChannelMessage(channel.id, incoming),
          onPairing: makePairingHandler(channel.id, channel.agentId),
        })
      } else {
        await adapter.start(channel.id, cfg, (incoming) => handleIncomingChannelMessage(channel.id, incoming))
      }
      log.info({ channelId: channel.id, platform: channel.platform }, 'Channel restored')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      await setChannelStatus(channel.id, 'error', errMsg)
      log.error({ channelId: channel.id, err: errMsg }, 'Failed to restore channel')
    }
  }
}
