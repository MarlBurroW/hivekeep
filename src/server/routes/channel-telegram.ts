import { Hono } from 'hono'
import { handleIncomingChannelMessage, getChannel } from '@/server/services/channels'
import { getSecretValue } from '@/server/services/vault'
import { verifyChannelWebhookToken } from '@/server/channels/webhook-token'
import { createLogger } from '@/server/logger'
import type { IncomingAttachment } from '@/server/channels/adapter'
import { extractAttachments } from '@/server/channels/telegram-utils'

const log = createLogger('routes:channel-telegram')

// ─── Routes ─────────────────────────────────────────────────────────────────

export const channelTelegramRoutes = new Hono()

// POST /api/channels/telegram/:channelId — receive Telegram updates (unauthenticated)
channelTelegramRoutes.post('/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== 'telegram' || channel.status !== 'active') {
    return c.json({ ok: true })
  }

  // In webhook mode the adapter registers a per-channel secret_token via
  // setWebhook; Telegram echoes it on every delivery. Without this check,
  // anyone who learns the channelId can inject forged updates.
  if (!verifyChannelWebhookToken('telegram', channelId, c.req.header('x-telegram-bot-api-secret-token'))) {
    log.warn({ channelId }, 'Telegram webhook rejected: missing or invalid secret token')
    return c.json({ error: 'Unauthorized' }, 401)
  }

  let update: Record<string, unknown>
  try {
    update = await c.req.json()
  } catch {
    return c.json({ ok: true })
  }

  // Extract message from update (support message and edited_message)
  const message = (update.message ?? update.edited_message) as Record<string, unknown> | undefined
  if (!message) {
    return c.json({ ok: true })
  }

  const from = message.from as Record<string, unknown> | undefined
  const chat = message.chat as Record<string, unknown> | undefined
  if (!from || !chat) {
    return c.json({ ok: true })
  }

  // Extract text content (support text and caption for photos/documents)
  const text = (message.text ?? message.caption ?? '') as string

  // Resolve bot token for file downloads
  const cfg = JSON.parse(channel.platformConfig) as { botTokenVaultKey: string }
  const token = await getSecretValue(cfg.botTokenVaultKey)

  // Extract file attachments
  let attachments: IncomingAttachment[] | undefined
  if (token) {
    const extracted = await extractAttachments(message, token)
    if (extracted.length > 0) attachments = extracted
  }

  // Skip if no text AND no attachments
  if (!text && !attachments) {
    return c.json({ ok: true })
  }

  try {
    await handleIncomingChannelMessage(channelId, {
      platformUserId: String(from.id),
      platformUsername: from.username as string | undefined,
      platformDisplayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined,
      platformMessageId: String(message.message_id),
      platformChatId: String(chat.id),
      content: text,
      attachments,
    })
  } catch (err) {
    log.error({ channelId, err }, 'Error handling Telegram update')
  }

  return c.json({ ok: true })
})
