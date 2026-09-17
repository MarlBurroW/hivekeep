import type { ChannelAdapter, ChannelConfigSchema, IncomingAttachment, IncomingMessageHandler, OutboundMessageParams } from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName } from '@/server/channels/adapter'
import type { ChannelAdapterMeta } from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { config } from '@/server/config'
import { channelWebhookToken } from '@/server/channels/webhook-token'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:signal')

const MAX_MESSAGE_LENGTH = 2000

export interface SignalChannelConfig {
  /** Vault key containing the signal-cli REST API base URL (e.g. http://localhost:8080) */
  apiUrlVaultKey: string
  /** The phone number registered with signal-cli (E.164 format, e.g. +1234567890) */
  phoneNumber: string
  /** Optional: restrict to specific group IDs or phone numbers */
  allowedChatIds?: string[]
}

/** Split a long message into chunks */
function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf('. ', MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}

async function resolveApiUrl(cfg: Record<string, unknown>): Promise<string> {
  const vaultKey = (cfg as unknown as SignalChannelConfig).apiUrlVaultKey
  const url = await getSecretValue(vaultKey)
  if (!url) throw new Error(`Vault key "${vaultKey}" not found`)
  // Strip trailing slash
  return url.replace(/\/+$/, '')
}

function getPhoneNumber(cfg: Record<string, unknown>): string {
  const phone = (cfg as unknown as SignalChannelConfig).phoneNumber
  if (!phone) throw new Error('phoneNumber is required in Signal channel config')
  return phone
}

async function signalApi(
  apiUrl: string,
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
) {
  const resp = await fetch(`${apiUrl}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Signal API ${method} ${endpoint} failed (${resp.status}): ${text}`)
  }

  const contentType = resp.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return await resp.json()
  }
  return null
}

/**
 * Signal channel adapter using signal-cli REST API.
 *
 * signal-cli REST API: https://github.com/bbernhard/signal-cli-rest-api
 *
 * Incoming messages are received via webhook callbacks from signal-cli.
 * The webhook URL is registered when the channel starts.
 */
// Dynamic config schema (issue #381). `apiUrl` is treated as a password
// to avoid leaking internal topology in logs/UI listings. phoneNumber is
// stored plain. The vault dance is performed by `createChannel()`.
const signalConfigSchema: ChannelConfigSchema = {
  fields: [
    {
      name: 'apiUrl',
      label: 'signal-cli REST API URL',
      type: 'password',
      required: true,
      placeholder: 'http://signal-cli:8080',
      description: 'Base URL of the signal-cli REST API instance.',
    },
    {
      name: 'phoneNumber',
      label: 'Phone number',
      type: 'text',
      required: true,
      placeholder: '+33612345678',
      description: 'E.164 number registered with signal-cli.',
    },
  ],
}

export class SignalAdapter implements ChannelAdapter {
  readonly platform = 'signal'
  readonly meta: ChannelAdapterMeta = { displayName: 'Signal', brandColor: '#3A76F0' }
  readonly configSchema = signalConfigSchema
  // signal-cli and the underlying Signal protocol do not expose an API to
  // change the bot account's display name per chat (and updating the
  // profile name globally requires re-registration). Fall back to the
  // core's "[Agent Name] " prefix.
  readonly identitySwitchMode = 'prefix' as const

  /** Store message handlers for webhook processing */
  private handlers = new Map<string, { onMessage: IncomingMessageHandler; cfg: SignalChannelConfig }>()

  async start(channelId: string, cfg: Record<string, unknown>, onMessage: IncomingMessageHandler): Promise<void> {
    const apiUrl = await resolveApiUrl(cfg)
    const phone = getPhoneNumber(cfg)
    const signalCfg = cfg as unknown as SignalChannelConfig

    this.handlers.set(channelId, { onMessage, cfg: signalCfg })

    // Register webhook with signal-cli REST API
    const webhookUrl = `${config.publicUrl}/api/channels/signal/webhook/${channelId}?token=${channelWebhookToken('signal', channelId)}`
    try {
      await signalApi(apiUrl, 'PUT', `/v1/accounts/${encodeURIComponent(phone)}/settings`, {
        webhook: webhookUrl,
      })
      log.info({ channelId, webhookUrl, phone }, 'Signal webhook registered')
    } catch (err) {
      // Some signal-cli versions use a different endpoint for webhooks
      log.warn({ channelId, err }, 'Failed to set webhook via settings, trying alternative')
      try {
        await signalApi(apiUrl, 'POST', '/v1/webhook', {
          url: webhookUrl,
          account: phone,
        })
        log.info({ channelId, webhookUrl, phone }, 'Signal webhook registered (alternative)')
      } catch (err2) {
        log.error({ channelId, err: err2 }, 'Failed to register Signal webhook')
        throw err2
      }
    }
  }

  async stop(channelId: string): Promise<void> {
    this.handlers.delete(channelId)
    log.info({ channelId }, 'Signal adapter stopped')
  }

  async sendMessage(
    _channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<{ platformMessageId: string }> {
    const apiUrl = await resolveApiUrl(cfg)
    const phone = getPhoneNumber(cfg)
    const chunks = splitMessage(params.content)

    // Prepare base64 attachments if any
    let base64Attachments: Array<string> | undefined
    if (params.attachments?.length) {
      base64Attachments = []
      for (const att of params.attachments) {
        const blob = await readAttachmentBlob(att)
        const buffer = await blob.arrayBuffer()
        const base64 = Buffer.from(buffer).toString('base64')
        const dataUri = `data:${att.mimeType};filename=${attachmentFileName(att)};base64,${base64}`
        base64Attachments.push(dataUri)
      }
    }

    let lastTimestamp = ''
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        message: chunks[i],
        number: phone,
        // chatId is either a phone number (DM) or a group ID (base64)
        ...(params.chatId.startsWith('+')
          ? { recipients: [params.chatId] }
          : { recipients: [], group_id: params.chatId }),
      }

      if (i === 0 && params.replyToMessageId) {
        body.quote = { id: Number(params.replyToMessageId) }
      }

      // Attach files to the first chunk only
      if (i === 0 && base64Attachments?.length) {
        body.base64_attachments = base64Attachments
      }

      const result = await signalApi(apiUrl, 'POST', `/v2/send`, body) as {
        timestamp?: string | number
      } | null

      lastTimestamp = String(result?.timestamp ?? Date.now())
    }

    return { platformMessageId: lastTimestamp }
  }

  async validateConfig(cfg: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    try {
      const apiUrl = await resolveApiUrl(cfg)
      const phone = getPhoneNumber(cfg)
      await signalApi(apiUrl, 'GET', `/v1/accounts/${encodeURIComponent(phone)}`)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid Signal config' }
    }
  }

  async getBotInfo(cfg: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    try {
      const apiUrl = await resolveApiUrl(cfg)
      const phone = getPhoneNumber(cfg)
      const result = await signalApi(apiUrl, 'GET', `/v1/accounts/${encodeURIComponent(phone)}`) as {
        name?: string
        uuid?: string
      } | null
      return { name: result?.name ?? phone, username: phone }
    } catch {
      return null
    }
  }

  /**
   * Handle an incoming webhook from signal-cli REST API.
   * Called by the route handler.
   */
  async handleWebhook(channelId: string, payload: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(channelId)
    if (!handler) {
      log.warn({ channelId }, 'No handler registered for Signal channel')
      return
    }

    const envelope = (payload.envelope ?? payload) as {
      source?: string
      sourceName?: string
      sourceUuid?: string
      timestamp?: number
      dataMessage?: {
        message?: string
        timestamp?: number
        groupInfo?: { groupId?: string }
        attachments?: Array<{
          contentType?: string
          filename?: string
          size?: number
          id?: string
        }>
      }
    }

    const dataMessage = envelope.dataMessage
    if (!dataMessage) return

    const source = envelope.source ?? envelope.sourceUuid ?? ''
    const chatId = dataMessage.groupInfo?.groupId ?? source

    // Filter by allowed chat IDs if configured
    if (handler.cfg.allowedChatIds?.length) {
      if (!handler.cfg.allowedChatIds.includes(chatId) && !handler.cfg.allowedChatIds.includes(source)) {
        return
      }
    }

    // Extract file attachments from signal-cli
    let attachments: IncomingAttachment[] | undefined
    if (dataMessage.attachments?.length) {
      const apiUrl = await resolveApiUrl(handler.cfg as unknown as Record<string, unknown>)
      attachments = dataMessage.attachments
        .filter((att) => att.id)
        .map((att) => ({
          platformFileId: att.id!,
          mimeType: att.contentType,
          fileName: att.filename,
          fileSize: att.size,
          url: `${apiUrl}/v1/attachments/${att.id}`,
        }))
      if (attachments.length === 0) attachments = undefined
    }

    // Skip if no text AND no attachments
    if (!dataMessage.message && !attachments) return

    await handler.onMessage({
      platformUserId: source,
      platformUsername: source,
      platformDisplayName: envelope.sourceName ?? source,
      platformMessageId: String(dataMessage.timestamp ?? envelope.timestamp ?? Date.now()),
      platformChatId: chatId,
      content: dataMessage.message ?? '',
      attachments,
    })
  }
}
