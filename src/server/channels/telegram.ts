import type { ChannelAdapter, ChannelConfigSchema, IncomingMessageHandler, OutboundMessageParams, OutboundAttachment } from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName, isImageAttachment } from '@/server/channels/adapter'
import type { ChannelAdapterMeta } from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { extractAttachments } from '@/server/channels/telegram-utils'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:telegram')

const TELEGRAM_API = 'https://api.telegram.org'
const MAX_MESSAGE_LENGTH = 4096
const POLLING_TIMEOUT_S = 30
const MAX_BACKOFF_MS = 30_000

export interface TelegramChannelConfig {
  botTokenVaultKey: string
  allowedChatIds?: string[]
}

/** Split a long message into chunks respecting Telegram's 4096-char limit */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining)
      break
    }

    // Try to split at a paragraph, then line, then sentence boundary
    let splitAt = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

async function resolveToken(cfg: Record<string, unknown>): Promise<string> {
  const vaultKey = (cfg as unknown as TelegramChannelConfig).botTokenVaultKey
  const token = await getSecretValue(vaultKey)
  if (!token) throw new Error(`Vault key "${vaultKey}" not found`)
  return token
}

async function telegramApi(token: string, method: string, body?: Record<string, unknown>, signal?: AbortSignal) {
  const resp = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const data = await resp.json() as { ok: boolean; result?: unknown; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? 'Unknown error'}`)
  }
  return data.result
}

/** Returns true when no public HTTPS URL is configured (local/dev setup) */
export function shouldUsePolling(): boolean {
  return !process.env.PUBLIC_URL || !config.publicUrl?.startsWith('https://')
}

interface TelegramPollingState {
  token: string
  channelId: string
  onMessage: IncomingMessageHandler
  offset: number
  stopped: boolean
  abortController: AbortController
  allowedChatIds: Set<string> | null
}

// Dynamic config schema (issue #381).
// Schema field names are USER-FACING form input names. At runtime this adapter
// reads `<name>VaultKey` from `platformConfig` (e.g. `botTokenVaultKey`),
// populated by `createChannel()` in services/channels.ts which performs the
// vault dance based on this schema. The drift is an internal storage detail.
const telegramConfigSchema: ChannelConfigSchema = {
  fields: [
    {
      name: 'botToken',
      label: 'Bot token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
      description: 'Telegram bot token obtained from @BotFather.',
    },
  ],
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = 'telegram'
  readonly meta: ChannelAdapterMeta = { displayName: 'Telegram', brandColor: '#26A5E4' }
  readonly configSchema = telegramConfigSchema
  // Bot API exposes setMyName (display name) but NOT setMyDescription for the
  // bot picture: avatars can only be set via BotFather. We declare 'native'
  // because the name does flip globally on transfer; avatar swap is skipped.
  // NB: this changes the bot identity globally across all chats the bot is in,
  // which is a Telegram limitation (no per-chat bot identity). Accepted as a
  // known trade-off; documented in docs/channel-transfers.md.
  readonly identitySwitchMode = 'native' as const
  private pollers = new Map<string, TelegramPollingState>()

  async start(channelId: string, cfg: Record<string, unknown>, onMessage?: IncomingMessageHandler): Promise<void> {
    const token = await resolveToken(cfg)
    const telegramCfg = cfg as unknown as TelegramChannelConfig

    if (shouldUsePolling()) {
      // Delete any existing webhook (Telegram requirement before getUpdates)
      await telegramApi(token, 'deleteWebhook')

      const state: TelegramPollingState = {
        token,
        channelId,
        onMessage: onMessage!,
        offset: 0,
        stopped: false,
        abortController: new AbortController(),
        allowedChatIds: telegramCfg.allowedChatIds?.length
          ? new Set(telegramCfg.allowedChatIds)
          : null,
      }

      this.pollers.set(channelId, state)
      // Fire-and-forget — the loop runs in the background
      this.pollLoop(state)
      log.info({ channelId, mode: 'polling' }, 'Telegram polling started')
    } else {
      const webhookUrl = `${config.publicUrl}${config.channels.telegramWebhookPath}/${channelId}`
      await telegramApi(token, 'setWebhook', { url: webhookUrl })
      log.info({ channelId, mode: 'webhook', webhookUrl }, 'Telegram webhook set')
    }
  }

  async stop(channelId: string, cfg?: Record<string, unknown>): Promise<void> {
    // Check polling mode first
    const state = this.pollers.get(channelId)
    if (state) {
      state.stopped = true
      state.abortController.abort()
      this.pollers.delete(channelId)
      log.info({ channelId }, 'Telegram polling stopped')
      return
    }

    // Webhook mode cleanup
    try {
      if (cfg) {
        const token = await resolveToken(cfg)
        await telegramApi(token, 'deleteWebhook')
      }
    } catch (err) {
      log.warn({ channelId, err }, 'Failed to delete Telegram webhook (token may be invalid)')
    }
    log.info({ channelId }, 'Telegram webhook removed')
  }

  private async pollLoop(state: TelegramPollingState): Promise<void> {
    let backoff = 0

    while (!state.stopped) {
      try {
        const updates = await telegramApi(
          state.token,
          'getUpdates',
          {
            offset: state.offset,
            timeout: POLLING_TIMEOUT_S,
            allowed_updates: ['message', 'edited_message'],
          },
          state.abortController.signal,
        ) as Array<{ update_id: number; message?: Record<string, unknown>; edited_message?: Record<string, unknown> }>

        backoff = 0 // reset on success

        for (const update of updates) {
          state.offset = update.update_id + 1
          const message = update.message ?? update.edited_message
          if (!message) continue

          try {
            await this.processUpdate(state, message)
          } catch (err) {
            log.error({ channelId: state.channelId, err }, 'Error processing Telegram update')
          }
        }
      } catch (err) {
        if (state.stopped) break
        log.error({ channelId: state.channelId, err }, 'Telegram polling error')
        backoff = Math.min((backoff || 1000) * 2, MAX_BACKOFF_MS)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }

  private async processUpdate(state: TelegramPollingState, message: Record<string, unknown>): Promise<void> {
    const from = message.from as Record<string, unknown> | undefined
    const chat = message.chat as Record<string, unknown> | undefined
    if (!from || !chat) return

    const chatId = String(chat.id)

    // Filter by allowed chat IDs
    if (state.allowedChatIds && !state.allowedChatIds.has(chatId)) return

    const text = (message.text ?? message.caption ?? '') as string

    // Extract file attachments using shared logic
    const attachments = await extractAttachments(message, state.token)

    // Skip if no text AND no attachments
    if (!text && attachments.length === 0) return

    await state.onMessage({
      platformUserId: String(from.id),
      platformUsername: from.username as string | undefined,
      platformDisplayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || undefined,
      platformMessageId: String(message.message_id),
      platformChatId: chatId,
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined,
    })
  }

  async sendMessage(
    _channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<{ platformMessageId: string }> {
    const token = await resolveToken(cfg)

    let lastMessageId = ''

    // Send file attachments first (or with caption for the first one)
    if (params.attachments?.length) {
      for (let i = 0; i < params.attachments.length; i++) {
        const att = params.attachments[i]
        if (!att) continue
        const result = await sendTelegramFile(token, params.chatId, att, {
          // First attachment gets the text as caption (if short enough for Telegram's 1024 limit)
          caption: i === 0 && params.content && params.content.length <= 1024 ? params.content : undefined,
          replyToMessageId: i === 0 ? params.replyToMessageId : undefined,
        })
        lastMessageId = result
      }
      // If text was used as caption, we're done; otherwise send text separately
      if (params.content && (params.content.length > 1024 || !params.attachments.length)) {
        // Fall through to text sending below
      } else if (!params.content) {
        return { platformMessageId: lastMessageId }
      } else {
        // Caption was sent with the first attachment
        return { platformMessageId: lastMessageId }
      }
    }

    // Send text message (or remaining text if caption was too long)
    if (params.content) {
      const chunks = splitMessage(params.content)
      for (let i = 0; i < chunks.length; i++) {
        const body: Record<string, unknown> = {
          chat_id: params.chatId,
          text: chunks[i],
        }

        if (i === 0 && params.replyToMessageId && !params.attachments?.length) {
          body.reply_parameters = { message_id: Number(params.replyToMessageId) }
        }

        const result = await telegramApi(token, 'sendMessage', body) as { message_id: number }
        lastMessageId = String(result.message_id)
      }
    }

    return { platformMessageId: lastMessageId }
  }

  async validateConfig(cfg: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    try {
      const token = await resolveToken(cfg)
      await telegramApi(token, 'getMe')
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid bot token' }
    }
  }

  async getBotInfo(cfg: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    try {
      const token = await resolveToken(cfg)
      const result = await telegramApi(token, 'getMe') as {
        first_name: string
        username?: string
      }
      return { name: result.first_name, username: result.username }
    } catch {
      return null
    }
  }

  async sendTypingIndicator(_channelId: string, cfg: Record<string, unknown>, chatId: string): Promise<void> {
    const token = await resolveToken(cfg)
    await telegramApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' })
  }

  async onIdentityChange(
    _channelId: string,
    cfg: Record<string, unknown>,
    newIdentity: { kinSlug: string; kinName: string; avatarUrl?: string },
  ): Promise<void> {
    const token = await resolveToken(cfg)
    // Telegram setMyName caps the name at 64 chars (Bot API spec).
    const name = newIdentity.kinName.slice(0, 64)
    await telegramApi(token, 'setMyName', { name })
    // Telegram bot avatars are NOT settable via Bot API: BotFather is the only
    // entry point. Log a debug note when an avatar was provided so operators
    // know it was intentionally skipped.
    if (newIdentity.avatarUrl) {
      log.debug(
        { kinSlug: newIdentity.kinSlug, avatarUrl: newIdentity.avatarUrl },
        'Telegram avatar swap skipped: setMyName is the only identity API the Bot API exposes; avatars require BotFather.',
      )
    }
  }
}

/** Send a file to Telegram using multipart/form-data upload */
async function sendTelegramFile(
  token: string,
  chatId: string,
  att: OutboundAttachment,
  opts: { caption?: string; replyToMessageId?: string },
): Promise<string> {
  const blob = await readAttachmentBlob(att)
  const fileName = attachmentFileName(att)
  const isImage = isImageAttachment(att)

  // Choose Telegram method based on file type
  const method = isImage ? 'sendPhoto' : 'sendDocument'
  const fieldName = isImage ? 'photo' : 'document'

  const form = new FormData()
  form.append('chat_id', chatId)
  form.append(fieldName, blob, fileName)
  if (opts.caption) form.append('caption', opts.caption)
  if (opts.replyToMessageId) {
    form.append('reply_parameters', JSON.stringify({ message_id: Number(opts.replyToMessageId) }))
  }

  const resp = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    body: form,
  })
  const data = await resp.json() as { ok: boolean; result?: { message_id: number }; description?: string }
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? 'Unknown error'}`)
  }
  return String(data.result?.message_id ?? '')
}
