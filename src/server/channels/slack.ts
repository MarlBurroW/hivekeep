import type { ChannelAdapter, ChannelConfigSchema, IncomingAttachment, IncomingMessageHandler, OutboundMessageParams } from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName } from '@/server/channels/adapter'
import type { ChannelAdapterMeta } from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:slack')

const SLACK_API = 'https://slack.com/api'
const MAX_MESSAGE_LENGTH = 4000

export interface SlackChannelConfig {
  botTokenVaultKey: string
  signingSecretVaultKey: string
  allowedChannelIds?: string[]
}

/** Split a long message into chunks respecting Slack's ~4000-char limit */
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

async function resolveToken(cfg: Record<string, unknown>): Promise<string> {
  const vaultKey = (cfg as unknown as SlackChannelConfig).botTokenVaultKey
  const token = await getSecretValue(vaultKey)
  if (!token) throw new Error(`Vault key "${vaultKey}" not found`)
  return token
}

async function resolveSigningSecret(cfg: Record<string, unknown>): Promise<string> {
  const vaultKey = (cfg as unknown as SlackChannelConfig).signingSecretVaultKey
  const token = await getSecretValue(vaultKey)
  if (!token) throw new Error(`Vault key "${vaultKey}" not found`)
  return token
}

async function slackApi(token: string, method: string, body?: Record<string, unknown>) {
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await resp.json() as { ok: boolean; error?: string; [key: string]: unknown }
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error ?? 'Unknown error'}`)
  }
  return data
}

/**
 * Verify Slack request signature (v0) using Web Crypto API.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */
async function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  rawBody: string,
): Promise<boolean> {
  const baseString = `v0:${timestamp}:${rawBody}`
  const encoder = new TextEncoder()

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString))
  const hexHash = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const expected = `v0=${hexHash}`
  return expected === signature
}

// In-memory state per channel
interface SlackChannelState {
  onMessage: IncomingMessageHandler
  signingSecret: string
  botToken: string
  botUserId: string | null
  allowedChannelIds: Set<string> | null
}

// Global map of active Slack channels (channelId -> state)
const activeChannels = new Map<string, SlackChannelState>()

/**
 * Handle incoming Slack Events API webhook.
 * Called from the Hono route handler.
 */
export async function handleSlackWebhook(
  channelId: string,
  rawBody: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const state = activeChannels.get(channelId)
  if (!state) {
    return { status: 404, body: { error: 'Channel not found' } }
  }

  // Verify signature
  const signature = headers['x-slack-signature'] ?? ''
  const timestamp = headers['x-slack-request-timestamp'] ?? ''

  // Reject requests older than 5 minutes
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > 300) {
    return { status: 403, body: { error: 'Request too old' } }
  }

  const valid = await verifySlackSignature(state.signingSecret, signature, timestamp, rawBody)
  if (!valid) {
    return { status: 403, body: { error: 'Invalid signature' } }
  }

  const payload = JSON.parse(rawBody) as Record<string, unknown>

  // URL verification challenge
  if (payload.type === 'url_verification') {
    return { status: 200, body: { challenge: payload.challenge } }
  }

  // Event callback
  if (payload.type === 'event_callback') {
    const event = payload.event as Record<string, unknown>

    if (event.type === 'message' && !event.subtype && !event.bot_id) {
      const userId = event.user as string
      const channelIdSlack = event.channel as string
      const text = event.text as string
      const messageTs = event.ts as string

      // Ignore own messages
      if (userId === state.botUserId) {
        return { status: 200, body: { ok: true } }
      }

      // Filter by allowed channels if configured
      if (state.allowedChannelIds && !state.allowedChannelIds.has(channelIdSlack)) {
        return { status: 200, body: { ok: true } }
      }

      // Extract file attachments
      // Slack files use url_private_download which requires bot token auth
      let attachments: IncomingAttachment[] | undefined
      const files = event.files as Array<{
        id: string
        name?: string
        mimetype?: string
        size?: number
        url_private_download?: string
      }> | undefined

      if (files?.length) {
        attachments = files
          .filter((f) => f.url_private_download)
          .map((f) => ({
            platformFileId: f.id,
            mimeType: f.mimetype,
            fileName: f.name,
            fileSize: f.size,
            url: f.url_private_download,
            headers: { Authorization: `Bearer ${state.botToken}` },
          }))
        if (attachments.length === 0) attachments = undefined
      }

      // Ignore empty messages (no text and no attachments)
      if (!text && !attachments) {
        return { status: 200, body: { ok: true } }
      }

      state.onMessage({
        platformUserId: userId,
        platformMessageId: messageTs,
        platformChatId: channelIdSlack,
        content: text || '',
        attachments,
      }).catch((err) => {
        log.error({ channelId, err }, 'Error handling Slack message')
      })
    }

    return { status: 200, body: { ok: true } }
  }

  return { status: 200, body: { ok: true } }
}

// Dynamic config schema (issue #381). Field names are user-facing; the
// runtime adapter reads `<name>VaultKey` from `platformConfig`. The vault
// dance is performed by `createChannel()` in services/channels.ts.
const slackConfigSchema: ChannelConfigSchema = {
  fields: [
    {
      name: 'botToken',
      label: 'Bot token',
      type: 'password',
      required: true,
      placeholder: 'xoxb-…',
      description: 'Slack bot OAuth token (xoxb-…) from the app config.',
    },
    {
      name: 'signingSecret',
      label: 'Signing secret',
      type: 'password',
      required: true,
      description: 'Slack signing secret used to verify request authenticity.',
    },
  ],
}

// Per-channel identity overrides for Slack. Slack has no global "set bot
// identity" endpoint, but chat.postMessage accepts a per-message username
// and icon_url. We stash the latest identity here keyed by channelId and
// read it on every outbound to inject those fields. Lost on restart, which
// is fine: after a restart, the identity reverts to the bot's default Slack
// app config until the next transfer_channel call.
interface SlackIdentityOverride {
  username: string
  iconUrl?: string
}
const slackIdentityOverrides = new Map<string, SlackIdentityOverride>()

export class SlackAdapter implements ChannelAdapter {
  readonly platform = 'slack'
  readonly meta: ChannelAdapterMeta = { displayName: 'Slack', brandColor: '#4A154B' }
  readonly configSchema = slackConfigSchema
  // Slack has no global identity endpoint; we encode the identity per-message
  // via chat.postMessage's username + icon_url fields. onIdentityChange just
  // updates the per-channel override map. Mode is 'native' because there is
  // no global flip we could do, and the per-message override is the proper
  // platform-supported path (the prefix fallback would be redundant).
  readonly identitySwitchMode = 'native' as const

  async start(channelId: string, cfg: Record<string, unknown>, onMessage: IncomingMessageHandler): Promise<void> {
    const token = await resolveToken(cfg)
    const signingSecret = await resolveSigningSecret(cfg)
    const slackCfg = cfg as unknown as SlackChannelConfig

    // Get bot user ID
    const authResult = await slackApi(token, 'auth.test') as { user_id?: string }

    const state: SlackChannelState = {
      onMessage,
      signingSecret,
      botToken: token,
      botUserId: (authResult.user_id as string) ?? null,
      allowedChannelIds: slackCfg.allowedChannelIds?.length
        ? new Set(slackCfg.allowedChannelIds)
        : null,
    }

    activeChannels.set(channelId, state)

    const webhookUrl = `${config.publicUrl}/api/channels/slack/webhook/${channelId}`
    log.info({ channelId, webhookUrl, botUserId: state.botUserId }, 'Slack adapter started — configure Events API URL in Slack app settings')
  }

  async stop(channelId: string): Promise<void> {
    activeChannels.delete(channelId)
    log.info({ channelId }, 'Slack adapter stopped')
  }

  async sendMessage(
    _channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<{ platformMessageId: string }> {
    const token = await resolveToken(cfg)

    // Identity override: when transfer_channel flipped the bound Kin, we
    // surface the new identity here on each chat.postMessage. Slack files
    // uploads do not accept username/icon_url, so attachment-only messages
    // still appear under the bot app's default identity (documented).
    const identity = slackIdentityOverrides.get(_channelId)

    let lastMessageTs = ''

    // Upload file attachments via Slack files.uploadV2
    if (params.attachments?.length) {
      for (const att of params.attachments) {
        const blob = await readAttachmentBlob(att)
        const fileName = attachmentFileName(att)

        const form = new FormData()
        form.append('file', blob, fileName)
        form.append('channels', params.chatId)
        form.append('filename', fileName)
        if (params.content && params.attachments.length === 1) {
          form.append('initial_comment', params.content)
        }
        if (params.replyToMessageId) {
          form.append('thread_ts', params.replyToMessageId)
        }

        const resp = await fetch(`${SLACK_API}/files.upload`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        })
        const data = await resp.json() as { ok: boolean; file?: { shares?: Record<string, unknown> }; error?: string }
        if (!data.ok) {
          throw new Error(`Slack files.upload failed: ${data.error ?? 'Unknown error'}`)
        }
      }

      // If initial_comment covered the text, we're done
      if (!params.content || params.attachments.length === 1) {
        return { platformMessageId: lastMessageTs || String(Date.now()) }
      }
    }

    // Send text message
    if (params.content) {
      const chunks = splitMessage(params.content)
      for (let i = 0; i < chunks.length; i++) {
        const body: Record<string, unknown> = {
          channel: params.chatId,
          text: chunks[i],
        }

        if (params.replyToMessageId) {
          body.thread_ts = params.replyToMessageId
        }

        // Apply per-channel identity override when set (post-transfer).
        if (identity) {
          body.username = identity.username
          if (identity.iconUrl) body.icon_url = identity.iconUrl
        }

        const result = await slackApi(token, 'chat.postMessage', body)
        lastMessageTs = result.ts as string
      }
    }

    return { platformMessageId: lastMessageTs }
  }

  async validateConfig(cfg: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    try {
      const token = await resolveToken(cfg)
      await slackApi(token, 'auth.test')
      // Also verify signing secret is accessible
      await resolveSigningSecret(cfg)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid configuration' }
    }
  }

  async getBotInfo(cfg: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    try {
      const token = await resolveToken(cfg)
      const result = await slackApi(token, 'auth.test') as {
        user?: string
        bot_id?: string
      }
      // Get bot info for display name
      if (result.bot_id) {
        const botInfo = await slackApi(token, 'bots.info', { bot: result.bot_id }) as {
          bot?: { name?: string }
        }
        return {
          name: botInfo.bot?.name ?? (result.user as string) ?? 'Slack Bot',
          username: result.user as string,
        }
      }
      return { name: (result.user as string) ?? 'Slack Bot', username: result.user as string }
    } catch {
      return null
    }
  }

  async sendTypingIndicator(_channelId: string, _cfg: Record<string, unknown>, _chatId: string): Promise<void> {
    // Slack doesn't have a direct "typing" API for bots.
    // Bot typing indicators are not supported via the Web API.
    // This is a no-op.
  }

  async onIdentityChange(
    channelId: string,
    _cfg: Record<string, unknown>,
    newIdentity: { kinSlug: string; kinName: string; avatarUrl?: string },
  ): Promise<void> {
    // No Slack API call: Slack only supports per-message identity via the
    // chat.postMessage `username` + `icon_url` fields. We stash the override
    // here and sendMessage injects it on every outbound (text messages only;
    // files.upload does not accept those fields, see sendMessage comments).
    slackIdentityOverrides.set(channelId, {
      username: newIdentity.kinName,
      iconUrl: newIdentity.avatarUrl,
    })
    log.info({ channelId, kinSlug: newIdentity.kinSlug }, 'Slack identity override updated for channel')
  }
}
