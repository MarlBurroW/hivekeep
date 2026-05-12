import { eq, and, desc, count } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { messages, channels, channelUserMappings, channelMessageLinks, contactPlatformIds, contactNicknames, kins, contacts, userProfiles } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { downloadChannelAttachments } from '@/server/services/files'
import { createSecret, deleteSecret, getSecretValue, getSecretByKey } from '@/server/services/vault'
import { createContact } from '@/server/services/contacts'
import { channelAdapters } from '@/server/channels/index'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { kinAvatarUrl } from '@/server/services/field-validator'
import { getContactDisplayName } from '@/shared/contact-display'
import type { IncomingMessage, OutboundAttachment } from '@/server/channels/adapter'
import type { ChannelPlatform, ChannelStatus } from '@/shared/types'

const log = createLogger('channels')

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
// When a Kin calls transfer_channel(channelId, targetKinSlug, reason?), the
// channel binding mutates (channels.kinId is updated). The next inbound on
// the channel should carry transfer context so the new Kin understands it
// just inherited the conversation. We stash the hint here keyed by channelId.
// The hint is popped (consumed) by handleIncomingChannelMessage when the
// next inbound arrives, and merged into the user message metadata under
// `channelTransfer`. The kin-engine then surfaces it in <channel-context>.
//
// In-memory only, lost on restart. Acceptable trade-off: a stale hint after
// a restart is harmless (the Kin will simply miss the one-shot transfer
// note; the conversation history and the audit-trail system messages
// remain).

export interface ChannelTransferHint {
  fromKinId: string
  fromKinSlug: string
  fromKinName: string
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

export interface ChannelOriginMeta {
  channelId: string
  platformChatId: string
  platformMessageId: string
  platformUserId: string
  createdAt: number
  ttlMs: number
}

const channelOriginStore = new Map<string, ChannelOriginMeta>()

export function setChannelOriginMeta(originId: string, meta: ChannelOriginMeta): void {
  channelOriginStore.set(originId, meta)
}

export function getChannelOriginMeta(originId: string): ChannelOriginMeta | undefined {
  const meta = channelOriginStore.get(originId)
  if (!meta) return undefined
  if (Date.now() - meta.createdAt > meta.ttlMs) {
    channelOriginStore.delete(originId)
    return undefined
  }
  return meta
}

// ─── Locale resolution (channel → kin → owner → user_profiles.language) ─────

const DEFAULT_LOCALE = 'en'

/**
 * Resolve the locale to use when an adapter localizes a `contextLine` for a
 * channel. The owner of the Kin attached to the channel sees the chat UI, so
 * we pick that user's `user_profiles.language`. Falls back to 'en'.
 */
export function resolveChannelLocale(channelId: string): string {
  try {
    const row = db
      .select({ language: userProfiles.language })
      .from(channels)
      .innerJoin(kins, eq(channels.kinId, kins.id))
      .innerJoin(userProfiles, eq(kins.createdBy, userProfiles.userId))
      .where(eq(channels.id, channelId))
      .get()
    return row?.language ?? DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

interface CreateChannelParams {
  kinId: string
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
  createdBy?: 'user' | 'kin'
}

export async function createChannel(params: CreateChannelParams) {
  // Check max per Kin limit
  const existing = await db
    .select()
    .from(channels)
    .where(eq(channels.kinId, params.kinId))
    .all()

  if (existing.length >= config.channels.maxPerKin) {
    throw new Error(`Max channels per Kin (${config.channels.maxPerKin}) reached`)
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
    kinId: params.kinId,
    name: params.name,
    platform: params.platform,
    platformConfig: JSON.stringify(stored),
    status: 'inactive',
    autoCreateContacts: params.autoCreateContacts ?? true,
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
      kinId: created.kinId,
      data: { channelId: created.id, kinId: created.kinId, platform: created.platform },
    })
  }

  log.info({ channelId: id, kinId: params.kinId, platform: params.platform, name: params.name }, 'Channel created')
  return created!
}

export async function getChannel(channelId: string) {
  return db.select().from(channels).where(eq(channels.id, channelId)).get()
}

export async function listChannels(kinId?: string) {
  if (kinId) {
    return db.select().from(channels).where(eq(channels.kinId, kinId)).all()
  }
  return db.select().from(channels).all()
}

export async function updateChannel(
  channelId: string,
  updates: Partial<{
    name: string
    kinId: string
    allowedChatIds: string[] | null
    autoCreateContacts: boolean
  }>,
) {
  const existing = await getChannel(channelId)
  if (!existing) return null

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (updates.name !== undefined) setValues.name = updates.name
  if (updates.kinId !== undefined) setValues.kinId = updates.kinId
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
      kinId: updated.kinId,
      data: { channelId: updated.id, kinId: updated.kinId },
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
    kinId: existing.kinId,
    data: { channelId, kinId: existing.kinId },
  })

  log.info({ channelId, kinId: existing.kinId }, 'Channel deleted')
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
      kinId: updated.kinId,
      data: { channelId, kinId: updated.kinId, status },
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
  const senderName = contactDisplayName ?? incoming.platformDisplayName ?? incoming.platformUsername ?? 'Unknown'

  // ─── Approval gate ────────────────────────────────────────────────────────
  if (pendingMappingId) {
    const adapter = channelAdapters.get(channel.platform)
    if (adapter) {
      const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      adapter.sendMessage(channel.id, adapterCfg, {
        chatId: incoming.platformChatId,
        content: 'Your access is pending approval. Please wait for an admin to approve your access.',
        replyToMessageId: incoming.platformMessageId,
      }).catch((err) => log.warn({ channelId, err }, 'Failed to send pending-approval message'))
    }

    // Update stats but do NOT enqueue
    await db
      .update(channels)
      .set({
        messagesReceived: channel.messagesReceived + 1,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId))
    return
  }
  // ─── End approval gate ────────────────────────────────────────────────────

  // Handle bot commands (/start, /start@botname, /start deeplink)
  if (/^\/start(?:\s|@|$)/.test(incoming.content)) {
    await handleBotStart(channel, incoming, senderName)
    return
  }

  // Format content with sender context
  // When the contact is not resolved, include platform metadata so the Kin can identify/create the contact
  let content: string
  if (contact) {
    content = `[${channel.platform}:${senderName}] ${incoming.content}`
  } else {
    const parts = [`${channel.platform}_id: ${incoming.platformUserId}`]
    if (incoming.platformUsername) parts.push(`username: ${incoming.platformUsername}`)
    content = `[${channel.platform}:${senderName} (unknown — ${parts.join(', ')})] ${incoming.content}`
  }

  // Download and store any file attachments
  let fileIds: string[] | undefined
  if (incoming.attachments && incoming.attachments.length > 0) {
    const result = await downloadChannelAttachments(channel.kinId, incoming.attachments)
    fileIds = result.fileIds.length > 0 ? result.fileIds : undefined

    // Inform the Kin about files that couldn't be processed
    if (result.failedAttachments.length > 0) {
      const failedLines = result.failedAttachments
        .map((f) => `- ${f.fileName ?? f.mimeType ?? 'unknown file'}: ${f.reason}`)
        .join('\n')
      content += `\n\n[System: The user sent ${incoming.attachments.length} file(s), but ${result.failedAttachments.length} could not be processed:\n${failedLines}]`
    }
  }

  // Pre-generate ID so the queue item can self-reference as its own channelOriginId
  const originId = uuid()

  // Adapter-provided context line (already localized) for the conversation UI.
  // Built from the same `incoming.metadata` the LLM gets via <channel-context>,
  // but rendered as a subtle hint below the bubble — not injected in the prompt.
  let inboundContextLine: string | null = null
  if (incoming.metadata && Object.keys(incoming.metadata).length > 0) {
    const adapter = channelAdapters.get(channel.platform)
    if (adapter?.formatInboundContext) {
      try {
        const locale = resolveChannelLocale(channelId)
        inboundContextLine = adapter.formatInboundContext(incoming.metadata, locale)
      } catch (err) {
        log.warn({ channelId, err }, 'formatInboundContext threw, ignoring')
      }
    }
  }

  // One-shot transfer hint: when a transfer_channel call was made before
  // this inbound, surface the handoff context to the new Kin via the same
  // <channel-context> block. Consumed (popped) on first inbound after the
  // transfer; subsequent inbounds carry no hint.
  const transferHint = popChannelTransferHint(channelId)

  // Enqueue message to Kin's queue.
  // Channel adapters can attach free-form structured context via incoming.metadata
  // (modality, presence, channel info, etc.). It is stored under the `channel`
  // key of the user message metadata so the kin-engine can inject it as a
  // <channel-context> block in the prompt.
  const messageMetadata: Record<string, unknown> | undefined = (() => {
    const hasChannelMeta = incoming.metadata && Object.keys(incoming.metadata).length > 0
    if (!hasChannelMeta && !inboundContextLine && !transferHint) return undefined
    const out: Record<string, unknown> = {}
    if (hasChannelMeta) out.channel = incoming.metadata
    if (inboundContextLine) out.channelContextLine = inboundContextLine
    if (transferHint) out.channelTransfer = transferHint
    return out
  })()

  const { id: queueItemId } = await enqueueMessage({
    id: originId,
    kinId: channel.kinId,
    messageType: 'channel',
    content,
    sourceType: 'channel',
    sourceId: channelId,
    priority: config.queue.userPriority,
    fileIds,
    channelOriginId: originId,
    messageMetadata,
  })

  // Store channel metadata in one-shot sideband for direct channel response
  setChannelQueueMeta(queueItemId, {
    channelId,
    platformChatId: incoming.platformChatId,
    platformMessageId: incoming.platformMessageId,
    platformUserId: incoming.platformUserId,
  })

  // Store origin metadata for causal chain tracking (persists for follow-up turns)
  setChannelOriginMeta(originId, {
    channelId,
    platformChatId: incoming.platformChatId,
    platformMessageId: incoming.platformMessageId,
    platformUserId: incoming.platformUserId,
    createdAt: Date.now(),
    ttlMs: config.channels.pendingOriginTtlMs,
  })

  // Send typing indicator (fire-and-forget)
  const adapter = channelAdapters.get(channel.platform)
  if (adapter?.sendTypingIndicator) {
    const adapterCfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    adapter.sendTypingIndicator(channel.id, adapterCfg, incoming.platformChatId).catch(() => {})
  }

  // Update stats
  await db
    .update(channels)
    .set({
      messagesReceived: channel.messagesReceived + 1,
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(channels.id, channelId))

  // Emit SSE event for web UI
  sseManager.sendToKin(channel.kinId, {
    type: 'channel:message-received',
    kinId: channel.kinId,
    data: { channelId, platform: channel.platform, sender: senderName },
  })

  log.info({ channelId, kinId: channel.kinId, sender: senderName, platform: channel.platform }, 'Channel message received')
}

// ─── Bot /start command ──────────────────────────────────────────────────────

async function handleBotStart(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
  senderName: string,
) {
  // Fetch Kin info for the welcome message
  const kin = await db
    .select({ name: kins.name, role: kins.role })
    .from(kins)
    .where(eq(kins.id, channel.kinId))
    .get()

  const kinName = kin?.name ?? 'Kin'
  const kinRole = kin?.role ? ` — ${kin.role}` : ''
  const welcomeText = `Hi! I'm ${kinName}${kinRole}.\nSend me a message and I'll respond.`

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

  // Update stats (count as received but not sent to Kin)
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
  // natively on the external platform, we prepend "[Kin Name] " to the
  // text content so the user knows which Kin is speaking after a
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
    const kinRow = db
      .select({ name: kins.name })
      .from(kins)
      .where(eq(kins.id, channel.kinId))
      .get()
    if (kinRow?.name) {
      outboundContent = `[${kinRow.name}] ${content}`
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

    // Record the outbound link
    await db.insert(channelMessageLinks).values({
      id: uuid(),
      channelId: meta.channelId,
      messageId: assistantMessageId,
      platformMessageId: result.platformMessageId,
      platformChatId: meta.platformChatId,
      direction: 'outbound',
      createdAt: new Date(),
    })

    // Persist delivery context on the Kin's message so the UI can render a
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
    sseManager.sendToKin(channel.kinId, {
      type: 'channel:message-sent',
      kinId: channel.kinId,
      data: {
        channelId: meta.channelId,
        platform: channel.platform,
        messageId: assistantMessageId,
        contextLine: result.contextLine ?? null,
      },
    })

    log.info({ channelId: meta.channelId, kinId: channel.kinId, platform: channel.platform }, 'Channel response delivered')
  } catch (err) {
    log.error({ channelId: meta.channelId, err }, 'Failed to deliver channel response')
  }
}

// ─── Channel transfer (UI + tool share this single entry point) ─────────────

export interface TransferChannelParams {
  channelId: string
  targetKinId: string
  reason?: string
  /** Surfaced in the log line only; useful for ops traceability. */
  initiatedBy: 'tool' | 'ui'
  /** Calling Kin ID (tool flow). Logged for audit, not persisted. */
  calledByKinId?: string
}

export type TransferChannelResult =
  | { ok: true; noop: true; message: string }
  | {
      ok: true
      noop?: false
      transferredAt: number
      previousKinSlug: string
      newKinSlug: string
      fromKinId: string
      fromKinName: string
      toKinId: string
      toKinName: string
    }
  | { ok: false; error: string }

/**
 * Re-bind a channel to a different Kin at runtime. Single source of truth for
 * both the transfer_channel tool and the REST endpoint
 * POST /api/channels/:id/transfer. Wraps:
 *
 *   1. Validation: channel exists, target Kin exists, no-op detection.
 *   2. channels.kinId mutation.
 *   3. Two role='system' audit-trail messages (one per Kin, with
 *      metadata.systemEvent set so buildMessageHistory can filter them out
 *      of the LLM prompt and the UI can render them as handoff banners).
 *   4. Sideband channelTransferHint for the next inbound's <channel-context>.
 *   5. SSE 'channel:transferred' broadcast.
 *   6. Best-effort adapter.onIdentityChange (warn on failure).
 *
 * Callers should never re-implement any of these steps directly; the only
 * place channels.kinId is mutated should be here.
 */
export async function transferChannel(params: TransferChannelParams): Promise<TransferChannelResult> {
  const channel = await getChannel(params.channelId)
  if (!channel) {
    return { ok: false, error: `Channel "${params.channelId}" not found.` }
  }

  if (channel.kinId === params.targetKinId) {
    return { ok: true, noop: true, message: 'Channel is already bound to this Kin.' }
  }

  const fromKinRow = db
    .select({ id: kins.id, slug: kins.slug, name: kins.name })
    .from(kins)
    .where(eq(kins.id, channel.kinId))
    .get()
  if (!fromKinRow) {
    return { ok: false, error: `Source Kin "${channel.kinId}" not found; refusing to transfer from a dangling binding.` }
  }
  const toKinRow = db
    .select({ id: kins.id, slug: kins.slug, name: kins.name, avatarPath: kins.avatarPath, updatedAt: kins.updatedAt })
    .from(kins)
    .where(eq(kins.id, params.targetKinId))
    .get()
  if (!toKinRow) {
    return { ok: false, error: `Target Kin "${params.targetKinId}" not found; refusing to transfer to a dangling binding.` }
  }

  const fromKinId = fromKinRow.id
  const fromKinSlug = fromKinRow.slug ?? fromKinRow.id
  const fromKinName = fromKinRow.name
  const toKinId = toKinRow.id
  const toKinSlug = toKinRow.slug ?? toKinRow.id
  const toKinName = toKinRow.name

  const at = Date.now()
  const now = new Date(at)

  // (2) Mutate the binding.
  await db
    .update(channels)
    .set({ kinId: toKinId, updatedAt: now })
    .where(eq(channels.id, channel.id))

  // (3) Audit-trail rows. Same content/shape as before the extraction so the
  //     UI rendering and prompt filtering continue to work unchanged.
  const reasonOrNull = params.reason ?? null
  const outMetaJson = JSON.stringify({
    systemEvent: 'channel_transferred_out',
    channelId: channel.id,
    channelName: channel.name,
    targetKinId: toKinId,
    targetKinSlug: toKinSlug,
    targetKinName: toKinName,
    reason: reasonOrNull,
    at,
  })
  const inMetaJson = JSON.stringify({
    systemEvent: 'channel_transferred_in',
    channelId: channel.id,
    channelName: channel.name,
    fromKinId,
    fromKinSlug,
    fromKinName,
    reason: reasonOrNull,
    at,
  })
  await db.insert(messages).values({
    id: uuid(),
    kinId: fromKinId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: outMetaJson,
    createdAt: now,
  })
  await db.insert(messages).values({
    id: uuid(),
    kinId: toKinId,
    role: 'system',
    content: null,
    sourceType: 'system',
    sourceId: null,
    metadata: inMetaJson,
    createdAt: now,
  })

  // (4) One-shot sideband hint for the next inbound.
  setChannelTransferHint(channel.id, {
    fromKinId,
    fromKinSlug,
    fromKinName,
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
      fromKinId,
      fromKinSlug,
      fromKinName,
      toKinId,
      toKinSlug,
      toKinName,
      reason: reasonOrNull,
      at,
    },
  })

  // (6) Best-effort native identity switch on the external platform.
  const adapter = channelAdapters.get(channel.platform)
  if (adapter && typeof adapter.onIdentityChange === 'function') {
    try {
      const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
      const relAvatar = kinAvatarUrl(toKinId, toKinRow.avatarPath, toKinRow.updatedAt)
      const avatarUrl = relAvatar ? `${config.publicUrl}${relAvatar}` : undefined
      await adapter.onIdentityChange(channel.id, cfg, {
        kinSlug: toKinSlug,
        kinName: toKinName,
        avatarUrl,
      })
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), channelId: channel.id, newKinSlug: toKinSlug },
        'onIdentityChange failed (non-fatal); the prefix fallback (if any) still applies',
      )
    }
  }

  log.info(
    {
      initiatedBy: params.initiatedBy,
      calledByKinId: params.calledByKinId ?? null,
      channelId: channel.id,
      fromKinId,
      toKinId,
      reason: reasonOrNull,
    },
    'Channel transferred',
  )

  return {
    ok: true,
    transferredAt: at,
    previousKinSlug: fromKinSlug,
    newKinSlug: toKinSlug,
    fromKinId,
    fromKinName,
    toKinId,
    toKinName,
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

async function resolveChannelContact(
  channel: typeof channels.$inferSelect,
  incoming: IncomingMessage,
): Promise<ResolvedChannelUser> {
  // 1. Check contactPlatformIds — authorized contact?
  const contact = findContactByPlatformId(channel.platform, incoming.platformUserId)
  if (contact) {
    return { contact, pendingMappingId: null }
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
    kinId: channel.kinId,
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
    kinId: channel.kinId,
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
  return db
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
        kinId: otherChannel.kinId,
        data: { channelId: other.channelId, mappingId: other.id },
      })
    }
  }

  // Broadcast SSE for the primary channel
  sseManager.broadcast({
    type: 'channel:user-approved',
    kinId: channel.kinId,
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

// ─── Active channels for a Kin (for prompt builder) ─────────────────────────

export async function getActiveChannelsForKin(kinId: string) {
  return db
    .select()
    .from(channels)
    .where(and(eq(channels.kinId, kinId), eq(channels.status, 'active')))
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
      await adapter.start(channel.id, cfg, (incoming) => handleIncomingChannelMessage(channel.id, incoming))
      log.info({ channelId: channel.id, platform: channel.platform }, 'Channel restored')
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      await setChannelStatus(channel.id, 'error', errMsg)
      log.error({ channelId: channel.id, err: errMsg }, 'Failed to restore channel')
    }
  }
}
