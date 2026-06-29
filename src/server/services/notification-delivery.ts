import { eq, and, isNotNull } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { notificationChannels, channels, agents, contacts, contactPlatformIds } from '@/server/db/schema'
import { channelAdapters } from '@/server/channels/index'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { getContactDisplayName } from '@/shared/contact-display'
import type { NotificationType, NotificationChannelSummary, AvailableNotificationChannel, ContactForNotification } from '@/shared/types'

const log = createLogger('notification-delivery')

// ─── Rate limiting (in-memory sliding window) ────────────────────────────────

const deliveryTimestamps = new Map<string, number[]>()

function isRateLimited(notifChannelId: string): boolean {
  const now = Date.now()
  const windowMs = 60_000
  const max = config.notifications.externalDelivery.rateLimitPerMinute

  const timestamps = deliveryTimestamps.get(notifChannelId) ?? []
  const recent = timestamps.filter((t) => now - t < windowMs)
  deliveryTimestamps.set(notifChannelId, recent)

  return recent.length >= max
}

function recordDelivery(notifChannelId: string) {
  const timestamps = deliveryTimestamps.get(notifChannelId) ?? []
  timestamps.push(Date.now())
  deliveryTimestamps.set(notifChannelId, timestamps)
}

// ─── Platform-specific formatting ────────────────────────────────────────────

const NOTIFICATION_EMOJI: Record<string, string> = {
  'prompt:pending': '\u2753',
  'channel:user-pending': '\uD83D\uDC64',
  'cron:pending-approval': '\u23F0',
  'mcp:pending-approval': '\uD83E\uDDE9',
  'agent:error': '\u26A0\uFE0F',
}

interface NotificationPayload {
  type: NotificationType
  title: string
  body?: string | null
  agentName?: string | null
}

function formatNotification(payload: NotificationPayload, platform: string): string {
  const emoji = NOTIFICATION_EMOJI[payload.type] ?? '\uD83D\uDD14'
  const agentSuffix = payload.agentName ? `\n\u2014 ${payload.agentName}` : ''

  switch (platform) {
    case 'telegram':
      return [
        `${emoji} *${escapeTelegramMarkdown(payload.title)}*`,
        payload.body ? escapeTelegramMarkdown(payload.body) : null,
        agentSuffix ? escapeTelegramMarkdown(agentSuffix) : null,
      ].filter(Boolean).join('\n')

    default:
      return [
        `${emoji} ${payload.title}`,
        payload.body,
        agentSuffix,
      ].filter(Boolean).join('\n')
  }
}

function escapeTelegramMarkdown(text: string): string {
  // Escape backslashes first, then all Telegram MarkdownV2 special characters
  return text.replace(/\\/g, '\\\\').replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1')
}

// ─── External delivery ──────────────────────────────────────────────────────

export async function deliverExternalNotification(
  userId: string,
  payload: NotificationPayload,
): Promise<void> {
  try {
    const userChannels = await db
      .select()
      .from(notificationChannels)
      .where(and(
        eq(notificationChannels.userId, userId),
        eq(notificationChannels.isActive, true),
      ))
      .all()

    if (userChannels.length === 0) return

    const maxErrors = config.notifications.externalDelivery.maxConsecutiveErrors

    for (const nc of userChannels) {
      try {
        // Check type filter
        if (nc.typeFilter) {
          const allowed = JSON.parse(nc.typeFilter) as string[]
          if (!allowed.includes(payload.type)) continue
        }

        // Rate limit check
        if (isRateLimited(nc.id)) {
          log.debug({ notifChannelId: nc.id }, 'Rate limited, skipping delivery')
          continue
        }

        // Auto-disable if too many errors
        if (nc.consecutiveErrors >= maxErrors) {
          log.warn({ notifChannelId: nc.id }, 'Too many consecutive errors, auto-disabling')
          await db.update(notificationChannels)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(notificationChannels.id, nc.id))
          continue
        }

        // Resolve source channel
        const channel = await db.select().from(channels)
          .where(eq(channels.id, nc.channelId)).get()
        if (!channel || channel.status !== 'active') continue

        const adapter = channelAdapters.get(channel.platform )
        if (!adapter) continue

        // Format and send
        const text = formatNotification(payload, channel.platform)
        const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

        await adapter.sendMessage(channel.id, cfg, {
          chatId: nc.platformChatId,
          content: text,
        })

        // Success — reset errors
        await db.update(notificationChannels).set({
          lastDeliveredAt: new Date(),
          lastError: null,
          consecutiveErrors: 0,
          updatedAt: new Date(),
        }).where(eq(notificationChannels.id, nc.id))

        recordDelivery(nc.id)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error'
        log.error({ notifChannelId: nc.id, err: errMsg }, 'Failed to deliver external notification')

        await db.update(notificationChannels).set({
          lastError: errMsg,
          consecutiveErrors: nc.consecutiveErrors + 1,
          updatedAt: new Date(),
        }).where(eq(notificationChannels.id, nc.id))
      }
    }
  } catch (err) {
    log.error({ err, userId }, 'External notification delivery failed')
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listUserNotificationChannels(userId: string): Promise<NotificationChannelSummary[]> {
  const rows = await db
    .select({
      id: notificationChannels.id,
      channelId: notificationChannels.channelId,
      channelName: channels.name,
      platform: channels.platform,
      platformChatId: notificationChannels.platformChatId,
      label: notificationChannels.label,
      isActive: notificationChannels.isActive,
      typeFilter: notificationChannels.typeFilter,
      lastDeliveredAt: notificationChannels.lastDeliveredAt,
      lastError: notificationChannels.lastError,
      consecutiveErrors: notificationChannels.consecutiveErrors,
      createdAt: notificationChannels.createdAt,
    })
    .from(notificationChannels)
    .innerJoin(channels, eq(notificationChannels.channelId, channels.id))
    .where(eq(notificationChannels.userId, userId))
    .all()

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channelId,
    channelName: r.channelName,
    platform: r.platform ,
    platformChatId: r.platformChatId,
    label: r.label,
    isActive: r.isActive,
    typeFilter: r.typeFilter ? (JSON.parse(r.typeFilter) as NotificationType[]) : null,
    lastDeliveredAt: r.lastDeliveredAt?.getTime() ?? null,
    lastError: r.lastError,
    consecutiveErrors: r.consecutiveErrors,
    createdAt: r.createdAt.getTime(),
  }))
}

interface CreateParams {
  channelId: string
  platformChatId: string
  label?: string
  typeFilter?: NotificationType[]
}

export async function createUserNotificationChannel(userId: string, params: CreateParams): Promise<NotificationChannelSummary> {
  // Check max per user
  const existing = await db
    .select({ id: notificationChannels.id })
    .from(notificationChannels)
    .where(eq(notificationChannels.userId, userId))
    .all()

  if (existing.length >= config.notifications.externalDelivery.maxPerUser) {
    throw new Error(`Maximum ${config.notifications.externalDelivery.maxPerUser} notification channels per user`)
  }

  // Verify channel exists and is active
  const channel = await db.select().from(channels).where(eq(channels.id, params.channelId)).get()
  if (!channel) throw new Error('Channel not found')
  if (channel.status !== 'active') throw new Error('Channel is not active')

  const now = new Date()
  const id = uuid()

  await db.insert(notificationChannels).values({
    id,
    userId,
    channelId: params.channelId,
    platformChatId: params.platformChatId,
    label: params.label ?? null,
    isActive: true,
    typeFilter: params.typeFilter ? JSON.stringify(params.typeFilter) : null,
    consecutiveErrors: 0,
    createdAt: now,
    updatedAt: now,
  })

  return {
    id,
    channelId: channel.id,
    channelName: channel.name,
    platform: channel.platform ,
    platformChatId: params.platformChatId,
    label: params.label ?? null,
    isActive: true,
    typeFilter: params.typeFilter ?? null,
    lastDeliveredAt: null,
    lastError: null,
    consecutiveErrors: 0,
    createdAt: now.getTime(),
  }
}

interface UpdateParams {
  label?: string
  isActive?: boolean
  typeFilter?: NotificationType[] | null
  platformChatId?: string
}

export async function updateUserNotificationChannel(id: string, userId: string, params: UpdateParams): Promise<boolean> {
  const existing = await db.select().from(notificationChannels)
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.userId, userId))).get()
  if (!existing) return false

  const setValues: Record<string, unknown> = { updatedAt: new Date() }
  if (params.label !== undefined) setValues.label = params.label
  if (params.isActive !== undefined) {
    setValues.isActive = params.isActive
    // Reset errors when re-enabling
    if (params.isActive) {
      setValues.consecutiveErrors = 0
      setValues.lastError = null
    }
  }
  if (params.typeFilter !== undefined) setValues.typeFilter = params.typeFilter ? JSON.stringify(params.typeFilter) : null
  if (params.platformChatId !== undefined) setValues.platformChatId = params.platformChatId

  await db.update(notificationChannels).set(setValues).where(eq(notificationChannels.id, id))
  return true
}

export async function deleteUserNotificationChannel(id: string, userId: string): Promise<boolean> {
  const existing = await db.select({ id: notificationChannels.id }).from(notificationChannels)
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.userId, userId))).get()
  if (!existing) return false

  await db.delete(notificationChannels).where(eq(notificationChannels.id, id))
  return true
}

export async function testNotificationChannel(id: string, userId: string): Promise<{ success: boolean; error?: string }> {
  const nc = await db.select().from(notificationChannels)
    .where(and(eq(notificationChannels.id, id), eq(notificationChannels.userId, userId))).get()
  if (!nc) return { success: false, error: 'Notification channel not found' }

  const channel = await db.select().from(channels).where(eq(channels.id, nc.channelId)).get()
  if (!channel) return { success: false, error: 'Source channel not found' }
  if (channel.status !== 'active') return { success: false, error: 'Source channel is not active' }

  const adapter = channelAdapters.get(channel.platform )
  if (!adapter) return { success: false, error: `No adapter for platform "${channel.platform}"` }

  try {
    const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
    await adapter.sendMessage(channel.id, cfg, {
      chatId: nc.platformChatId,
      content: '\uD83D\uDD14 This is a test notification from Gezy.',
    })

    // Reset errors on successful test
    await db.update(notificationChannels).set({
      lastDeliveredAt: new Date(),
      lastError: null,
      consecutiveErrors: 0,
      updatedAt: new Date(),
    }).where(eq(notificationChannels.id, id))

    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error'
    return { success: false, error: errMsg }
  }
}

export async function listAvailableChannels(): Promise<AvailableNotificationChannel[]> {
  const rows = await db
    .select({
      channelId: channels.id,
      channelName: channels.name,
      platform: channels.platform,
      agentName: agents.name,
    })
    .from(channels)
    .innerJoin(agents, eq(channels.agentId, agents.id))
    .where(eq(channels.status, 'active'))
    .all()

  return rows.map((r) => ({
    channelId: r.channelId,
    channelName: r.channelName,
    platform: r.platform ,
    agentName: r.agentName,
  }))
}

export async function listContactsForPlatform(platform: string): Promise<ContactForNotification[]> {
  const rows = await db
    .select({
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      platformId: contactPlatformIds.platformId,
    })
    .from(contactPlatformIds)
    .innerJoin(contacts, eq(contactPlatformIds.contactId, contacts.id))
    .where(and(
      eq(contactPlatformIds.platform, platform),
      isNotNull(contacts.linkedUserId),
    ))
    .all()

  return rows.map((r) => ({
    contactId: r.contactId,
    contactName: getContactDisplayName({ firstName: r.firstName, lastName: r.lastName }),
    platformId: r.platformId,
  }))
}
