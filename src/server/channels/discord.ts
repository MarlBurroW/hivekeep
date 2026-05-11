import type { ChannelAdapter, ChannelConfigSchema, IncomingAttachment, IncomingMessageHandler, OutboundMessageParams } from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName } from '@/server/channels/adapter'
import type { ChannelAdapterMeta } from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:discord')

const DISCORD_API = 'https://discord.com/api/v10'
const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
const MAX_MESSAGE_LENGTH = 2000

// Gateway opcodes
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

// Required intents: GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | MESSAGE_CONTENT (1<<15) | DIRECT_MESSAGES (1<<12)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

export interface DiscordChannelConfig {
  botTokenVaultKey: string
  allowedChannelIds?: string[]
}

/** Split a long message into chunks respecting Discord's 2000-char limit */
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
  const vaultKey = (cfg as unknown as DiscordChannelConfig).botTokenVaultKey
  const token = await getSecretValue(vaultKey)
  if (!token) throw new Error(`Vault key "${vaultKey}" not found`)
  return token
}

async function discordApi(token: string, method: string, endpoint: string, body?: Record<string, unknown>) {
  const resp = await fetch(`${DISCORD_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Discord API ${method} ${endpoint} failed (${resp.status}): ${text}`)
  }

  if (resp.status === 204) return null
  return await resp.json()
}

interface GatewayState {
  ws: WebSocket | null
  heartbeatInterval: ReturnType<typeof setInterval> | null
  heartbeatAcked: boolean
  sequence: number | null
  sessionId: string | null
  resumeGatewayUrl: string | null
  token: string
  onMessage: IncomingMessageHandler
  channelId: string
  botUserId: string | null
  allowedChannelIds: Set<string> | null
  stopped: boolean
}

function createGateway(state: GatewayState): void {
  if (state.stopped) return

  const resumeUrl = state.resumeGatewayUrl
  let url = DISCORD_GATEWAY
  if (resumeUrl) {
    try {
      const parsed = new URL(resumeUrl)
      if (parsed.protocol === 'wss:' && parsed.hostname.endsWith('.discord.gg')) {
        // Build a fresh URL from validated components to cut CodeQL taint flow
        const safeUrl = new URL('wss://placeholder')
        safeUrl.hostname = parsed.hostname
        safeUrl.pathname = parsed.pathname
        safeUrl.search = parsed.search
        url = safeUrl.href
      } else {
        log.warn({ channelId: state.channelId, resumeUrl }, 'Ignoring invalid resume gateway URL')
        state.resumeGatewayUrl = null
      }
    } catch {
      log.warn({ channelId: state.channelId, resumeUrl }, 'Ignoring malformed resume gateway URL')
      state.resumeGatewayUrl = null
    }
  }
  const ws = new WebSocket(url)
  state.ws = ws

  ws.addEventListener('open', () => {
    log.info({ channelId: state.channelId }, 'Discord gateway connected')
  })

  ws.addEventListener('message', (event) => {
    let payload: { op: number; d: Record<string, unknown> | null; s?: number; t?: string }
    try {
      payload = JSON.parse(String(event.data))
    } catch {
      return
    }

    if (payload.s != null) {
      state.sequence = payload.s
    }

    switch (payload.op) {
      case OP_HELLO: {
        const interval = (payload.d as { heartbeat_interval: number }).heartbeat_interval
        startHeartbeat(state, interval)

        if (state.sessionId) {
          // Resume
          ws.send(JSON.stringify({
            op: OP_RESUME,
            d: {
              token: state.token,
              session_id: state.sessionId,
              seq: state.sequence,
            },
          }))
        } else {
          // Identify
          ws.send(JSON.stringify({
            op: OP_IDENTIFY,
            d: {
              token: state.token,
              intents: INTENTS,
              properties: {
                os: 'linux',
                browser: 'kinbot',
                device: 'kinbot',
              },
            },
          }))
        }
        break
      }

      case OP_HEARTBEAT_ACK:
        state.heartbeatAcked = true
        break

      case OP_HEARTBEAT:
        sendHeartbeat(state)
        break

      case OP_RECONNECT:
        log.info({ channelId: state.channelId }, 'Discord gateway requested reconnect')
        reconnect(state)
        break

      case OP_INVALID_SESSION: {
        const resumable = payload.d as unknown as boolean
        if (!resumable) {
          state.sessionId = null
          state.sequence = null
        }
        setTimeout(() => reconnect(state), 1000 + Math.random() * 4000)
        break
      }

      case OP_DISPATCH:
        handleDispatch(state, payload.t!, payload.d!)
        break
    }
  })

  ws.addEventListener('close', (event) => {
    log.warn({ channelId: state.channelId, code: event.code }, 'Discord gateway closed')
    stopHeartbeat(state)
    if (!state.stopped) {
      setTimeout(() => reconnect(state), 2000 + Math.random() * 3000)
    }
  })

  ws.addEventListener('error', (event) => {
    log.error({ channelId: state.channelId, error: event }, 'Discord gateway error')
  })
}

function handleDispatch(state: GatewayState, event: string, data: Record<string, unknown>): void {
  if (event === 'READY') {
    const d = data as { session_id: string; resume_gateway_url: string; user: { id: string } }
    state.sessionId = d.session_id
    state.resumeGatewayUrl = d.resume_gateway_url
    state.botUserId = d.user.id
    log.info({ channelId: state.channelId, botUserId: state.botUserId }, 'Discord gateway ready')
    return
  }

  if (event === 'MESSAGE_CREATE') {
    const msg = data as {
      id: string
      channel_id: string
      content: string
      author: { id: string; username: string; global_name?: string; bot?: boolean }
      attachments?: Array<{
        id: string
        filename: string
        content_type?: string
        size: number
        url: string
      }>
    }

    // Ignore messages from bots (including self)
    if (msg.author.bot) return

    // Filter by allowed channels if configured
    if (state.allowedChannelIds && !state.allowedChannelIds.has(msg.channel_id)) return

    // Extract file attachments from Discord CDN
    let attachments: IncomingAttachment[] | undefined
    if (msg.attachments?.length) {
      attachments = msg.attachments.map((att) => ({
        platformFileId: att.id,
        mimeType: att.content_type,
        fileName: att.filename,
        fileSize: att.size,
        url: att.url,
      }))
    }

    // Ignore empty messages (no text and no attachments)
    if (!msg.content && !attachments) return

    state.onMessage({
      platformUserId: msg.author.id,
      platformUsername: msg.author.username,
      platformDisplayName: msg.author.global_name ?? msg.author.username,
      platformMessageId: msg.id,
      platformChatId: msg.channel_id,
      content: msg.content || '',
      attachments,
    }).catch((err) => {
      log.error({ channelId: state.channelId, err }, 'Error handling Discord message')
    })
  }
}

function sendHeartbeat(state: GatewayState): void {
  state.heartbeatAcked = false
  state.ws?.send(JSON.stringify({ op: OP_HEARTBEAT, d: state.sequence }))
}

/**
 * Allowed heartbeat intervals (ms). Discord typically sends 41250.
 * We round the server value to the nearest allowed bucket so no
 * user-controlled duration ever reaches setTimeout / setInterval.
 */
const HEARTBEAT_BUCKETS = [5_000, 10_000, 15_000, 20_000, 30_000, 41_250, 45_000, 60_000, 90_000, 120_000] as const

function pickHeartbeatBucket(requestedMs: number): number {
  let closest: number = 41_250
  let bestDiff = Infinity
  for (const bucket of HEARTBEAT_BUCKETS) {
    const diff = Math.abs(bucket - requestedMs)
    if (diff < bestDiff) {
      bestDiff = diff
      closest = bucket
    }
  }
  return closest
}

function startHeartbeat(state: GatewayState, intervalMs: number): void {
  stopHeartbeat(state)
  state.heartbeatAcked = true

  // Map to a safe constant bucket to prevent resource exhaustion
  const safeInterval = pickHeartbeatBucket(intervalMs)

  // First heartbeat after jitter
  const jitter = Math.floor(Math.random() * safeInterval)
  setTimeout(() => {
    if (state.stopped) return
    sendHeartbeat(state)
  }, jitter)

  state.heartbeatInterval = setInterval(() => {
    if (!state.heartbeatAcked) {
      log.warn({ channelId: state.channelId }, 'Discord heartbeat not acked, reconnecting')
      reconnect(state)
      return
    }
    sendHeartbeat(state)
  }, safeInterval)
}

function stopHeartbeat(state: GatewayState): void {
  if (state.heartbeatInterval) {
    clearInterval(state.heartbeatInterval)
    state.heartbeatInterval = null
  }
}

function reconnect(state: GatewayState): void {
  stopHeartbeat(state)
  try {
    state.ws?.close()
  } catch { /* ignore */ }
  state.ws = null
  createGateway(state)
}

// Dynamic config schema (issue #381). Field names are user-facing; the
// runtime adapter reads `<name>VaultKey` from `platformConfig`. The vault
// dance is performed by `createChannel()` in services/channels.ts.
const discordConfigSchema: ChannelConfigSchema = {
  fields: [
    {
      name: 'botToken',
      label: 'Bot token',
      type: 'password',
      required: true,
      placeholder: 'MTAxxxxxxxxxxxxxxxxxxxx.xxxxxx.xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      description: 'Discord bot token from the Developer Portal.',
    },
  ],
}

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = 'discord'
  readonly meta: ChannelAdapterMeta = { displayName: 'Discord', brandColor: '#5865F2' }
  readonly configSchema = discordConfigSchema
  // PATCH /users/@me lets us change the bot's username and avatar globally.
  // Like Telegram, this affects the bot identity everywhere it is present
  // (the bot user has one global username, not per-guild). Accepted trade-off,
  // documented in docs/channel-transfers.md.
  readonly identitySwitchMode = 'native' as const
  private gateways = new Map<string, GatewayState>()

  async start(channelId: string, cfg: Record<string, unknown>, onMessage: IncomingMessageHandler): Promise<void> {
    const token = await resolveToken(cfg)
    const discordCfg = cfg as unknown as DiscordChannelConfig

    const state: GatewayState = {
      ws: null,
      heartbeatInterval: null,
      heartbeatAcked: true,
      sequence: null,
      sessionId: null,
      resumeGatewayUrl: null,
      token,
      onMessage,
      channelId,
      botUserId: null,
      allowedChannelIds: discordCfg.allowedChannelIds?.length
        ? new Set(discordCfg.allowedChannelIds)
        : null,
      stopped: false,
    }

    this.gateways.set(channelId, state)
    createGateway(state)
    log.info({ channelId }, 'Discord adapter started')
  }

  async stop(channelId: string): Promise<void> {
    const state = this.gateways.get(channelId)
    if (state) {
      state.stopped = true
      stopHeartbeat(state)
      try {
        state.ws?.close(1000, 'Channel deactivated')
      } catch { /* ignore */ }
      this.gateways.delete(channelId)
    }
    log.info({ channelId }, 'Discord adapter stopped')
  }

  async sendMessage(
    _channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<{ platformMessageId: string }> {
    const token = await resolveToken(cfg)

    // If attachments, use multipart/form-data
    if (params.attachments?.length) {
      const form = new FormData()
      const payload: Record<string, unknown> = {}
      if (params.content) payload.content = params.content.slice(0, MAX_MESSAGE_LENGTH)
      if (params.replyToMessageId) payload.message_reference = { message_id: params.replyToMessageId }

      // Discord supports up to 10 attachments per message
      const attachmentsMeta: Array<{ id: number; filename: string }> = []
      for (let i = 0; i < Math.min(params.attachments.length, 10); i++) {
        const att = params.attachments[i]
        if (!att) continue
        const blob = await readAttachmentBlob(att)
        const fileName = attachmentFileName(att)
        form.append(`files[${i}]`, blob, fileName)
        attachmentsMeta.push({ id: i, filename: fileName })
      }
      payload.attachments = attachmentsMeta
      form.append('payload_json', JSON.stringify(payload))

      const resp = await fetch(`${DISCORD_API}/channels/${params.chatId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}` },
        body: form,
      })
      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`Discord API POST /messages failed (${resp.status}): ${text}`)
      }
      const result = await resp.json() as { id: string }

      // If content was too long, send remaining chunks as follow-up text
      if (params.content && params.content.length > MAX_MESSAGE_LENGTH) {
        const remaining = params.content.slice(MAX_MESSAGE_LENGTH)
        for (const chunk of splitMessage(remaining)) {
          const r = await discordApi(token, 'POST', `/channels/${params.chatId}/messages`, { content: chunk }) as { id: string }
          return { platformMessageId: r.id }
        }
      }

      return { platformMessageId: result.id }
    }

    // Text-only path
    const chunks = splitMessage(params.content)
    let lastMessageId = ''
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        content: chunks[i],
      }

      if (i === 0 && params.replyToMessageId) {
        body.message_reference = { message_id: params.replyToMessageId }
      }

      const result = await discordApi(token, 'POST', `/channels/${params.chatId}/messages`, body) as { id: string }
      lastMessageId = result.id
    }

    return { platformMessageId: lastMessageId }
  }

  async validateConfig(cfg: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    try {
      const token = await resolveToken(cfg)
      await discordApi(token, 'GET', '/users/@me')
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid bot token' }
    }
  }

  async getBotInfo(cfg: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    try {
      const token = await resolveToken(cfg)
      const result = await discordApi(token, 'GET', '/users/@me') as {
        username: string
        global_name?: string
      }
      return { name: result.global_name ?? result.username, username: result.username }
    } catch {
      return null
    }
  }

  async sendTypingIndicator(_channelId: string, cfg: Record<string, unknown>, chatId: string): Promise<void> {
    const token = await resolveToken(cfg)
    await discordApi(token, 'POST', `/channels/${chatId}/typing`)
  }

  async onIdentityChange(
    _channelId: string,
    cfg: Record<string, unknown>,
    newIdentity: { kinSlug: string; kinName: string; avatarUrl?: string },
  ): Promise<void> {
    const token = await resolveToken(cfg)
    // Discord usernames are capped at 32 chars and must avoid certain
    // characters; truncate defensively. Slugs are always ASCII so this
    // mostly affects long Kin display names.
    const username = newIdentity.kinName.slice(0, 32).trim() || newIdentity.kinSlug
    const body: Record<string, unknown> = { username }

    // Avatar is optional: PATCH /users/@me accepts a data: URI in the
    // "avatar" field. We fetch the URL the core built, convert to base64,
    // and include it. If the fetch fails, send the username only rather
    // than failing the whole identity switch.
    if (newIdentity.avatarUrl) {
      try {
        const resp = await fetch(newIdentity.avatarUrl)
        if (resp.ok) {
          const contentType = resp.headers.get('content-type') ?? 'image/png'
          const buf = await resp.arrayBuffer()
          const base64 = Buffer.from(buf).toString('base64')
          body.avatar = `data:${contentType};base64,${base64}`
        } else {
          log.warn({ status: resp.status, url: newIdentity.avatarUrl }, 'Discord avatar fetch returned non-OK; skipping avatar')
        }
      } catch (err) {
        log.warn({ err: String(err), url: newIdentity.avatarUrl }, 'Discord avatar fetch failed; skipping avatar')
      }
    }

    await discordApi(token, 'PATCH', '/users/@me', body)
  }
}
