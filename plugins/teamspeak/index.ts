/**
 * KinBot plugin: teamspeak
 *
 * Bridges KinBot to a TeamSpeak server via the local ts-bot WebSocket API
 * (see /tmp/ts-bot/docs/websocket-api-reference.md for protocol reference).
 *
 * Exports:
 *   - channels.teamspeak  — ChannelAdapter that ingests chat & transcriptions,
 *     and routes outbound replies to chat / TTS following Nicolas's rules:
 *       * private message  → chat only (no TTS)
 *       * public channel   → TTS + chat copy
 *       * reply > ttsMaxChars → TTS short notice + full text in chat
 *   - tools.{get_status, speak, send_chat, move_channel, stop_speaking}
 *
 * The adapter uses metadata (KinBot ≥ 0.39.0) so the LLM gets full structured
 * context (modality, presence, channel info) without polluting `content`.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  getOrCreateClient,
  disposeClient,
  normalizeUid,
  type TsBotWsClient,
  type TsBotServerState,
  type TsBotChannel,
  type TsBotClient,
  type MessageReceivedEvent,
  type TranscriptionEvent,
  type ClientConnectedEvent,
  type ClientDisconnectedEvent,
  type ClientMovedEvent,
  type WelcomeEvent,
} from './wsClient'

// ─── Plugin context (loose typing to avoid coupling to internal SDK paths) ──

interface PluginCtxLog {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

interface PluginCtxStorage {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  clear(): Promise<void>
}

interface PluginCtx {
  config: Record<string, unknown>
  log: PluginCtxLog
  storage: PluginCtxStorage
  manifest: { name: string; version: string }
}

// ─── Config helpers ─────────────────────────────────────────────────────────

interface ResolvedConfig {
  wsUrl: string
  defaultVoice?: string
  ttsMaxChars: number
  enableTtsOnPublic: boolean
  ttsTooLongNotice: string
  reconnectMaxBackoffMs: number
}

function resolveConfig(raw: Record<string, unknown>): ResolvedConfig {
  return {
    wsUrl: (raw.wsUrl as string) || 'ws://127.0.0.1:8080/ws',
    defaultVoice: (raw.defaultVoice as string) || undefined,
    ttsMaxChars: typeof raw.ttsMaxChars === 'number' ? raw.ttsMaxChars : 300,
    enableTtsOnPublic: typeof raw.enableTtsOnPublic === 'boolean' ? raw.enableTtsOnPublic : true,
    ttsTooLongNotice:
      (raw.ttsTooLongNotice as string) ||
      "J'ai répondu en chat, c'était trop long pour le vocal.",
    reconnectMaxBackoffMs:
      typeof raw.reconnectMaxBackoffMs === 'number' ? raw.reconnectMaxBackoffMs : 30000,
  }
}

// ─── Local state cache (channels, clients, own_client_id) ───────────────────

interface CachedState {
  ownClientId: number | null
  channels: Map<number, TsBotChannel>
  clients: Map<number, TsBotClient>
  /** Last known client UIDs we logged as "new" (in-memory only, dedup logs) */
  knownSenderUids: Set<string>
  /** Last welcome */
  welcome: WelcomeEvent | null
}

function emptyState(): CachedState {
  return {
    ownClientId: null,
    channels: new Map(),
    clients: new Map(),
    knownSenderUids: new Set(),
    welcome: null,
  }
}

function applyServerState(state: CachedState, payload: TsBotServerState): void {
  state.ownClientId = payload.own_client_id
  state.channels.clear()
  for (const ch of payload.channels) state.channels.set(ch.id, ch)
  state.clients.clear()
  for (const cl of payload.clients) state.clients.set(cl.id, cl)
}

function botLocation(state: CachedState): { channel_id: number | null; channel_name: string | null } {
  if (state.ownClientId == null) return { channel_id: null, channel_name: null }
  const me = state.clients.get(state.ownClientId)
  if (!me) return { channel_id: null, channel_name: null }
  const ch = state.channels.get(me.channel_id)
  return { channel_id: me.channel_id, channel_name: ch?.name ?? null }
}

function presentInChannel(state: CachedState, channelId: number, excludeBot = true): Array<{ id: number; name: string }> {
  const out: Array<{ id: number; name: string }> = []
  for (const cl of state.clients.values()) {
    if (cl.channel_id !== channelId) continue
    if (excludeBot && state.ownClientId != null && cl.id === state.ownClientId) continue
    out.push({ id: cl.id, name: cl.name })
  }
  return out
}

// ─── i18n ───────────────────────────────────────────────────────────────────
// All adapter-produced context lines are localized in-plugin. The KinBot core
// passes the Kin owner's locale via `formatInboundContext(meta, locale)` and
// `sendMessage({ locale })`. Unsupported locales fall back to English.

type SupportedLocale = 'en' | 'fr'
type ContextKey =
  | 'inboundVoicePublic'         // {name}, {channel}, {present}
  | 'inboundVoicePublicAlone'    // {name}, {channel}
  | 'inboundVoicePrivate'        // {name}  (rare: should not normally happen)
  | 'inboundTextPublic'          // {name}, {channel}
  | 'inboundTextPublicWithPresence' // {name}, {channel}, {present}
  | 'inboundTextPrivate'         // {name}
  | 'outboundTtsPublic'          // {channel}, {voice}
  | 'outboundTtsPublicDefaultVoice' // {channel}
  | 'outboundTextPublic'         // {channel}
  | 'outboundTextPrivate'        // {name}
  | 'outboundTtsTooLong'         // {channel}

const I18N: Record<SupportedLocale, Record<ContextKey, string>> = {
  en: {
    inboundVoicePublic: 'Sent by {name} from #{channel} via voice (with {present})',
    inboundVoicePublicAlone: 'Sent by {name} from #{channel} via voice',
    inboundVoicePrivate: 'Sent by {name} via voice in private',
    inboundTextPublic: 'Sent by {name} in #{channel}',
    inboundTextPublicWithPresence: 'Sent by {name} in #{channel} (with {present})',
    inboundTextPrivate: 'Sent by {name} as a private message',
    outboundTtsPublic: 'Sent on TeamSpeak via TTS in #{channel} with voice {voice}',
    outboundTtsPublicDefaultVoice: 'Sent on TeamSpeak via TTS in #{channel}',
    outboundTextPublic: 'Sent on TeamSpeak as text in #{channel}',
    outboundTextPrivate: 'Sent on TeamSpeak as a private message to {name}',
    outboundTtsTooLong: 'Sent on TeamSpeak: short voice notice + full text in #{channel} chat',
  },
  fr: {
    inboundVoicePublic: 'Envoyé par {name} depuis #{channel} en vocal (avec {present})',
    inboundVoicePublicAlone: 'Envoyé par {name} depuis #{channel} en vocal',
    inboundVoicePrivate: 'Envoyé par {name} en vocal en privé',
    inboundTextPublic: 'Envoyé par {name} dans #{channel}',
    inboundTextPublicWithPresence: 'Envoyé par {name} dans #{channel} (avec {present})',
    inboundTextPrivate: 'Envoyé par {name} en message privé',
    outboundTtsPublic: 'Envoyé sur TeamSpeak en TTS dans #{channel} avec la voix {voice}',
    outboundTtsPublicDefaultVoice: 'Envoyé sur TeamSpeak en TTS dans #{channel}',
    outboundTextPublic: 'Envoyé sur TeamSpeak en texte dans #{channel}',
    outboundTextPrivate: 'Envoyé sur TeamSpeak en message privé à {name}',
    outboundTtsTooLong: 'Envoyé sur TeamSpeak : court avis vocal + texte complet dans le chat de #{channel}',
  },
}

function pickLocale(raw: string | undefined): SupportedLocale {
  if (raw === 'fr' || raw === 'en') return raw
  if (raw && raw.toLowerCase().startsWith('fr')) return 'fr'
  return 'en'
}

function tt(locale: SupportedLocale, key: ContextKey, vars: Record<string, string | number>): string {
  let s = I18N[locale][key]
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
  }
  return s
}

export type OutboundMode = 'text-private' | 'text-public' | 'tts' | 'tts-too-long'

/**
 * Compose the localized context line that surfaces under a kin's channel reply
 * ("Sent on TeamSpeak via TTS in #Gaming with voice Kartal", etc.). Exported
 * for unit testing — the adapter's sendMessage calls this with the values it
 * just computed. When the recipient's name is unknown (presence cache miss in
 * the brief window after plugin start), falls back to `session #<id>` so the
 * line never shows the meaningless placeholder "user".
 */
export function buildOutboundContextLine(args: {
  mode: OutboundMode
  locale: string
  channelName: string
  voice: string | null
  recipientName: string | null
  recipientSessionId: number | null
}): string {
  const locale = pickLocale(args.locale)
  switch (args.mode) {
    case 'text-private': {
      const name = args.recipientName ?? (args.recipientSessionId != null ? `session #${args.recipientSessionId}` : 'unknown')
      return tt(locale, 'outboundTextPrivate', { name })
    }
    case 'text-public':
      return tt(locale, 'outboundTextPublic', { channel: args.channelName })
    case 'tts':
      return args.voice
        ? tt(locale, 'outboundTtsPublic', { channel: args.channelName, voice: args.voice })
        : tt(locale, 'outboundTtsPublicDefaultVoice', { channel: args.channelName })
    case 'tts-too-long':
      return tt(locale, 'outboundTtsTooLong', { channel: args.channelName })
  }
}

// ─── Chat ID encoding ───────────────────────────────────────────────────────
// We encode the platformChatId as `channel:<id>` for public channels and
// `private:<sender_id>` for private messages. The adapter parses this back
// when sending replies. Keeping the sender_id (numeric session ID) in the
// chatId lets us send private replies via `send_message { target:'private', recipient:"N" }`
// (ts-bot expects the recipient as a string, see websocket-api-reference.md).

function encodeChannelChatId(channelId: number): string {
  return `channel:${channelId}`
}
function encodePrivateChatId(senderId: number): string {
  return `private:${senderId}`
}
function parseChatId(chatId: string): { kind: 'channel' | 'private'; id: number } | null {
  const m = /^(channel|private):(\d+)$/.exec(chatId)
  if (!m) return null
  return { kind: m[1] as 'channel' | 'private', id: Number(m[2]) }
}

// ─── Plugin entry point ─────────────────────────────────────────────────────

export default function (ctx: PluginCtx) {
  const cfg = resolveConfig(ctx.config)
  const state = emptyState()
  let client: TsBotWsClient | null = null

  // Channel adapter — only one TS server per KinBot install for the POC, so we
  // bind the singleton to whatever channel KinBot starts.
  let activeChannelId: string | null = null
  let onMessage: ((m: import('@/server/channels/adapter').IncomingMessage) => Promise<void>) | null = null

  // Restore last own_client_id from storage (purely informational, refresh on connect)
  const restoreOwnId = async (): Promise<void> => {
    try {
      const v = await ctx.storage.get<number>('lastOwnClientId')
      if (typeof v === 'number') {
        ctx.log.debug({ lastOwnClientId: v }, 'Restored last own_client_id from storage')
      }
    } catch { /* ignore */ }
  }

  const persistOwnId = async (): Promise<void> => {
    if (state.ownClientId != null) {
      try { await ctx.storage.set('lastOwnClientId', state.ownClientId) } catch { /* ignore */ }
    }
  }

  // Refresh local state via get_status
  const refreshState = async (): Promise<void> => {
    if (!client) return
    try {
      const resp = await client.sendCommand<TsBotServerState>(
        { type: 'get_status' },
        { expectIntermediate: true },
      )
      if (resp.success && resp.data && typeof resp.data === 'object') {
        applyServerState(state, resp.data as TsBotServerState)
        await persistOwnId()
        ctx.log.info(
          {
            own_client_id: state.ownClientId,
            channels: state.channels.size,
            clients: state.clients.size,
          },
          'ts-bot state refreshed',
        )
      } else {
        ctx.log.warn({ resp }, 'get_status returned no data')
      }
    } catch (err) {
      ctx.log.warn({ err: String(err) }, 'Failed to refresh ts-bot state')
    }
  }

  // ─── Incoming events → IncomingMessage ───────────────────────────────────

  const buildContextForMessage = (
    senderId: number,
    senderName: string,
    senderUidB64: string,
    isPrivate: boolean,
    channelId: number | null,
    channelName: string | null,
    modality: 'text' | 'voice',
  ): Record<string, unknown> => {
    const present = !isPrivate && channelId != null ? presentInChannel(state, channelId, true) : null
    return {
      modality,
      chatType: isPrivate ? 'private' : 'public_channel',
      channel: isPrivate ? null : { id: channelId, name: channelName },
      sender: { uid: senderUidB64, name: senderName, session_id: senderId },
      present,
      bot: botLocation(state),
    }
  }

  const handleMessageReceived = async (ev: MessageReceivedEvent): Promise<void> => {
    if (!onMessage || !activeChannelId) return
    const senderUidB64 = normalizeUid(ev.sender_uid)
    if (!senderUidB64) {
      ctx.log.warn({ ev: { sender_id: ev.sender_id, sender_name: ev.sender_name } }, 'message_received without resolvable sender_uid; skipping')
      return
    }
    if (!state.knownSenderUids.has(senderUidB64)) {
      state.knownSenderUids.add(senderUidB64)
      ctx.log.info({ uid: senderUidB64, name: ev.sender_name }, 'new sender detected')
    }

    const isPrivate = ev.message_type === 'private'
    const chatId = isPrivate ? encodePrivateChatId(ev.sender_id) : encodeChannelChatId(ev.channel_id ?? 0)
    const metadata = buildContextForMessage(
      ev.sender_id,
      ev.sender_name,
      senderUidB64,
      isPrivate,
      ev.channel_id,
      ev.channel_name,
      'text',
    )

    try {
      await onMessage({
        platformUserId: senderUidB64,
        platformDisplayName: ev.sender_name,
        platformMessageId: randomUUID(),
        platformChatId: chatId,
        content: ev.content,
        metadata,
      })
    } catch (err) {
      ctx.log.error({ err: String(err) }, 'onMessage handler threw')
    }
  }

  const handleTranscription = async (ev: TranscriptionEvent): Promise<void> => {
    if (!onMessage || !activeChannelId) return
    const speakerUidB64 = normalizeUid(ev.speaker_uid)
    if (!speakerUidB64) return
    if (!state.knownSenderUids.has(speakerUidB64)) {
      state.knownSenderUids.add(speakerUidB64)
      ctx.log.info({ uid: speakerUidB64, name: ev.speaker_name }, 'new sender detected (voice)')
    }

    // Voice always lives in the bot's current channel.
    const loc = botLocation(state)
    const channelId = loc.channel_id ?? 0
    const chatId = encodeChannelChatId(channelId)
    const metadata = buildContextForMessage(
      ev.speaker_id,
      ev.speaker_name,
      speakerUidB64,
      false,
      channelId,
      loc.channel_name,
      'voice',
    )
    // Add transcription-specific extras
    ;(metadata as Record<string, unknown>).transcription = {
      confidence: ev.confidence,
      language: ev.language,
      duration_ms: ev.duration_ms,
    }

    try {
      await onMessage({
        platformUserId: speakerUidB64,
        platformDisplayName: ev.speaker_name,
        platformMessageId: randomUUID(),
        platformChatId: chatId,
        content: ev.text,
        metadata,
      })
    } catch (err) {
      ctx.log.error({ err: String(err) }, 'onMessage handler threw (voice)')
    }
  }

  // Local cache mutations for client lifecycle events
  const handleClientConnected = (ev: ClientConnectedEvent): void => {
    state.clients.set(ev.client_id, {
      id: ev.client_id,
      name: ev.client_name,
      channel_id: ev.channel_id,
      uid: ev.uid,
    })
  }
  const handleClientDisconnected = (ev: ClientDisconnectedEvent): void => {
    state.clients.delete(ev.client_id)
  }
  const handleClientMoved = (ev: ClientMovedEvent): void => {
    const existing = state.clients.get(ev.client_id)
    if (existing) {
      existing.channel_id = ev.new_channel_id
    } else {
      state.clients.set(ev.client_id, {
        id: ev.client_id,
        name: ev.client_name,
        channel_id: ev.new_channel_id,
        uid: ev.uid,
      })
    }
    if (state.ownClientId != null && ev.client_id === state.ownClientId) {
      void persistOwnId()
    }
  }

  // ─── ChannelAdapter implementation ───────────────────────────────────────

  // ─── Inbound context line builder (i18n) ─────────────────────────────────
  const formatInboundContext = (
    metadata: Record<string, unknown>,
    rawLocale: string,
  ): string | null => {
    const locale = pickLocale(rawLocale)
    const modality = metadata.modality === 'voice' ? 'voice' : 'text'
    const chatType = metadata.chatType
    const sender = (metadata.sender ?? {}) as { name?: string }
    const senderName = sender.name ?? 'Unknown'
    const channel = (metadata.channel ?? null) as { name?: string } | null
    const channelName = channel?.name ?? 'channel'
    const presentList = (metadata.present ?? []) as Array<{ name?: string }>
    const presentNames = presentList.map((p) => p.name).filter((n): n is string => !!n)
    const presentStr = presentNames.length > 0 ? presentNames.join(', ') : ''

    if (modality === 'voice') {
      if (chatType === 'public_channel') {
        return presentStr
          ? tt(locale, 'inboundVoicePublic', { name: senderName, channel: channelName, present: presentStr })
          : tt(locale, 'inboundVoicePublicAlone', { name: senderName, channel: channelName })
      }
      return tt(locale, 'inboundVoicePrivate', { name: senderName })
    }
    // text
    if (chatType === 'private') {
      return tt(locale, 'inboundTextPrivate', { name: senderName })
    }
    return presentStr
      ? tt(locale, 'inboundTextPublicWithPresence', { name: senderName, channel: channelName, present: presentStr })
      : tt(locale, 'inboundTextPublic', { name: senderName, channel: channelName })
  }

  const adapter = {
    platform: 'teamspeak',
    meta: {
      displayName: 'TeamSpeak',
      brandColor: '#2580C3',
    },

    // ts-bot exposes a `set_nickname` command, so we can natively follow the
    // bound Kin's display name on transfer. TeamSpeak avatars are per-client
    // files uploaded via TS3 file transfer; ts-bot does not expose that path,
    // so we update the nickname only and leave the avatar to whatever the
    // operator configured on the bot's TS3 identity.
    identitySwitchMode: 'native' as const,

    formatInboundContext,

    async onIdentityChange(
      _channelId: string,
      _channelConfig: Record<string, unknown>,
      newIdentity: { kinSlug: string; kinName: string; avatarUrl?: string },
    ): Promise<void> {
      const c = ensureClient()
      // TeamSpeak nicknames are bounded by the server config (default 30
      // chars). Truncate defensively to stay well below.
      const nickname = newIdentity.kinName.slice(0, 30)
      const resp = await c.sendCommand(
        { type: 'set_nickname', nickname },
        { expectIntermediate: false },
      )
      if (!resp.success) {
        throw new Error(`ts-bot set_nickname failed: ${resp.message ?? 'unknown error'}`)
      }
      if (newIdentity.avatarUrl) {
        ctx.log.debug(
          { kinSlug: newIdentity.kinSlug, avatarUrl: newIdentity.avatarUrl },
          'TeamSpeak avatar swap skipped: ts-bot has no file-transfer endpoint for client avatars; nickname only.',
        )
      }
    },

    async start(
      channelId: string,
      channelConfig: Record<string, unknown>,
      msgHandler: (m: import('@/server/channels/adapter').IncomingMessage) => Promise<void>,
    ): Promise<void> {
      // The plugin is configured at plugin level, not per-channel. We use the
      // plugin config but also let the channel override wsUrl if it wants.
      const url = (channelConfig?.wsUrl as string) || cfg.wsUrl
      activeChannelId = channelId
      onMessage = msgHandler

      client = getOrCreateClient({
        url,
        log: ctx.log,
        reconnectMaxBackoffMs: cfg.reconnectMaxBackoffMs,
      })

      // Wire listeners
      client.on('message_received', (ev) => { void handleMessageReceived(ev as MessageReceivedEvent) })
      client.on('transcription', (ev) => { void handleTranscription(ev as TranscriptionEvent) })
      client.on('client_connected', (ev) => handleClientConnected(ev as ClientConnectedEvent))
      client.on('client_disconnected', (ev) => handleClientDisconnected(ev as ClientDisconnectedEvent))
      client.on('client_moved', (ev) => handleClientMoved(ev as ClientMovedEvent))
      client.on('welcome', (ev) => {
        state.welcome = ev as WelcomeEvent
        // Fresh connection → refresh state
        void refreshState()
      })

      await restoreOwnId()
      // Fire & forget: open WS and refresh state once connected
      try {
        await client.start(false, 5000)
        await refreshState()
      } catch (err) {
        ctx.log.warn({ err: String(err), url }, 'Initial ts-bot connection failed; will keep retrying')
      }

      ctx.log.info({ channelId, url }, 'teamspeak channel started')
    },

    async stop(channelId: string): Promise<void> {
      if (channelId !== activeChannelId) {
        ctx.log.warn({ channelId, activeChannelId }, 'stop() called for unknown teamspeak channelId')
      }
      activeChannelId = null
      onMessage = null
      // Keep the WS client alive if other consumers (tools) might still want it.
      // For the POC we tear it down to keep semantics clean.
      if (client) {
        disposeClient(cfg.wsUrl)
        client = null
      }
      ctx.log.info({ channelId }, 'teamspeak channel stopped')
    },

    async sendMessage(
      _channelId: string,
      _channelConfig: Record<string, unknown>,
      params: { chatId: string; content: string; replyToMessageId?: string; locale?: string },
    ): Promise<{ platformMessageId: string; contextLine?: string; deliveryMeta?: Record<string, unknown> }> {
      const parsed = parseChatId(params.chatId)
      if (!parsed) throw new Error(`Invalid teamspeak chatId: ${params.chatId}`)

      if (!client) throw new Error('teamspeak adapter not started (no WS client)')

      const text = (params.content ?? '').trim()
      if (!text) {
        // Nothing to send — return a synthetic ID so the caller doesn't choke.
        return { platformMessageId: randomUUID() }
      }

      const isPrivate = parsed.kind === 'private'
      const locale = pickLocale(params.locale)

      // Always send chat copy. For private MPs target the user, otherwise the
      // current channel of the bot. ts-bot expects target:'private' and the
      // recipient session id as a string; a number is silently dropped on the
      // Rust side (serde rejects the type, no response, plugin times out).
      const sendChat = async (content: string): Promise<void> => {
        const cmd: Record<string, unknown> = isPrivate
          ? { type: 'send_message', target: 'private', recipient: String(parsed.id), content }
          : { type: 'send_message', target: 'channel', content }
        await client!.sendCommand(cmd, { expectIntermediate: true })
      }

      const sendTts = async (content: string): Promise<void> => {
        const cmd: Record<string, unknown> = { type: 'speak', text: content }
        if (cfg.defaultVoice) cmd.voice = cfg.defaultVoice
        await client!.sendCommand(cmd, { expectIntermediate: false })
      }

      // Track which delivery path was taken so the core can persist a hint
      // ("Sent via TTS in #Gaming with voice Kartal") on the kin's message.
      let mode: 'text-private' | 'text-public' | 'tts' | 'tts-too-long' = 'text-public'

      try {
        if (isPrivate) {
          // Private → chat only
          await sendChat(text)
          mode = 'text-private'
        } else {
          // Public channel → ts-bot already echoes TTS to channel chat
          // automatically (see ts-bot main.rs: "Echo TTS text to TS3 channel
          // chat so muted users can read it"). So we don't duplicate the
          // chat copy ourselves on the TTS path.
          if (cfg.enableTtsOnPublic) {
            const tooLong = cfg.ttsMaxChars > 0 && text.length > cfg.ttsMaxChars
            if (tooLong) {
              // Full text via explicit chat (since the TTS notice differs)
              // + short voice notice (which ts-bot will also echo to chat).
              await sendChat(text).catch((e) => {
                ctx.log.warn({ err: String(e) }, 'chat send failed (long-reply path)')
              })
              await sendTts(cfg.ttsTooLongNotice).catch((e) => {
                ctx.log.warn({ err: String(e) }, 'TTS short-notice failed')
              })
              mode = 'tts-too-long'
            } else {
              // Speak full text — ts-bot echoes it to channel chat itself.
              await sendTts(text).catch((e) => {
                ctx.log.warn({ err: String(e) }, 'TTS send failed')
              })
              mode = 'tts'
            }
          } else {
            // TTS disabled by config → explicit chat only
            await sendChat(text)
            mode = 'text-public'
          }
        }
      } catch (err) {
        ctx.log.error({ err: String(err), chatId: params.chatId }, 'sendMessage failed')
        throw err
      }

      // Resolve display names for the context line. Public modes use the bot's
      // current channel; private mode uses the recipient client name from the
      // local presence cache (best-effort — the helper falls back to
      // `session #<id>` if the cache hasn't been populated yet).
      const botLoc = botLocation(state)
      const channelName = botLoc.channel_name ?? 'channel'
      const recipientName = isPrivate
        ? (state.clients.get(parsed.id)?.name ?? null)
        : null
      const voice = cfg.defaultVoice ?? null

      const contextLine = buildOutboundContextLine({
        mode,
        locale,
        channelName,
        voice,
        recipientName,
        recipientSessionId: isPrivate ? parsed.id : null,
      })

      const deliveryMeta: Record<string, unknown> = {
        mode,
        chatType: isPrivate ? 'private' : 'public_channel',
      }
      if (!isPrivate) deliveryMeta.channel = { id: botLoc.channel_id, name: channelName }
      if (mode === 'tts' || mode === 'tts-too-long') {
        deliveryMeta.voice = voice
        deliveryMeta.ttsMaxChars = cfg.ttsMaxChars
      }
      if (isPrivate) deliveryMeta.recipient = { id: parsed.id, name: recipientName }

      // We don't have a real platform message ID — synthesize one.
      return { platformMessageId: randomUUID(), contextLine, deliveryMeta }
    },

    async validateConfig(channelConfig: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
      const url = (channelConfig?.wsUrl as string) || cfg.wsUrl
      try {
        const { TsBotWsClient } = await import('./wsClient')
        const transient = new TsBotWsClient({ url, log: ctx.log })
        const welcome = await transient.start(true, 5000)
        transient.stop()
        if (welcome && welcome.type === 'welcome') return { valid: true }
        return { valid: false, error: 'No welcome event received' }
      } catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : String(err) }
      }
    },

    async getBotInfo(channelConfig: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
      const url = (channelConfig?.wsUrl as string) || cfg.wsUrl
      try {
        const transient = new (await import('./wsClient')).TsBotWsClient({ url, log: ctx.log })
        const welcome = await transient.start(true, 5000)
        transient.stop()
        const name = welcome.nickname ?? welcome.bot_nickname ?? 'TeamSpeak Bot'
        return { name }
      } catch (err) {
        ctx.log.warn({ err: String(err), url }, 'getBotInfo failed')
        return null
      }
    },
  }

  // ─── Tools ───────────────────────────────────────────────────────────────
  // These are namespaced as `plugin_teamspeak_*` automatically by KinBot.

  const ensureClient = (): TsBotWsClient => {
    if (!client) {
      // Lazy-init a client purely for tool use, even if no channel is bound.
      client = getOrCreateClient({
        url: cfg.wsUrl,
        log: ctx.log,
        reconnectMaxBackoffMs: cfg.reconnectMaxBackoffMs,
      })
      // Best-effort start; tools will fail if WS isn't up.
      void client.start(false, 5000).catch((err) => {
        ctx.log.warn({ err: String(err) }, 'lazy ts-bot client start failed')
      })
    }
    return client
  }

  const tools = {
    get_status: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description:
            'Get the current TeamSpeak server state via the ts-bot bridge: list of channels, list of connected clients, and the bot\'s current location.',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand<TsBotServerState>(
              { type: 'get_status' },
              { expectIntermediate: true },
            )
            if (!resp.success || !resp.data) {
              return { error: resp.message ?? 'get_status failed' }
            }
            applyServerState(state, resp.data as TsBotServerState)
            await persistOwnId()
            const loc = botLocation(state)
            return {
              own_client_id: state.ownClientId,
              bot: loc,
              channels: Array.from(state.channels.values()).map((ch) => ({
                id: ch.id,
                name: ch.name,
                parent_id: ch.parent_id,
              })),
              clients: Array.from(state.clients.values()).map((cl) => ({
                id: cl.id,
                name: cl.name,
                channel_id: cl.channel_id,
                uid: cl.uid,
              })),
            }
          },
        }),
    },

    speak: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Force TTS playback in the bot\'s current TeamSpeak channel. The text is queued and replaces any ongoing playback.',
          inputSchema: z.object({
            text: z.string().min(1).max(2000).describe('Text to synthesize (≤ 2000 chars).'),
            voice: z.string().optional().describe('Optional voice identifier. Falls back to plugin defaultVoice or server default.'),
          }),
          execute: async ({ text, voice }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'speak', text }
            const v = voice ?? cfg.defaultVoice
            if (v) cmd.voice = v
            const resp = await c.sendCommand(cmd, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    send_chat: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Send a text chat message to TeamSpeak. By default sends to the bot\'s current channel. Set target="private" with recipient=<client_id> to send a private message.',
          inputSchema: z.object({
            text: z.string().min(1).max(8192).describe('Message body (≤ 8192 chars).'),
            target: z.enum(['channel', 'private']).default('channel').describe('"channel" (current channel chat) or "private" (private message).'),
            recipient: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Required when target="private": session client ID of the recipient (use get_status to find it).'),
          }),
          execute: async ({ text, target, recipient }) => {
            const c = ensureClient()
            if (target === 'private' && (recipient == null || recipient <= 0)) {
              return { error: 'recipient (positive client id) is required when target="private"' }
            }
            const cmd: Record<string, unknown> =
              target === 'private'
                ? { type: 'send_message', target: 'private', recipient: String(recipient), content: text }
                : { type: 'send_message', target: 'channel', content: text }
            const resp = await c.sendCommand(cmd, { expectIntermediate: true })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    move_channel: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description: 'Move the TeamSpeak bot to a different channel. Use get_status to discover channel IDs.',
          inputSchema: z.object({
            channel_id: z.number().int().positive().describe('Target channel ID (> 0).'),
            password: z.string().optional().describe('Channel password if required.'),
          }),
          execute: async ({ channel_id, password }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'move_channel', channel_id }
            if (password) cmd.password = password
            const resp = await c.sendCommand(cmd, { expectIntermediate: true })
            // After a move, refresh state in the background
            void refreshState()
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    stop_speaking: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description: 'Immediately stop any ongoing TTS playback in the TeamSpeak channel. No-op if nothing is playing.',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'stop_speaking' }, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    // ─── Client moderation ────────────────────────────────────────────────

    poke_client: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Send a poke notification (popup) to a specific TS3 client. The recipient sees a modal popup with the message. Use get_status to find client session IDs.',
          inputSchema: z.object({
            client_id: z.number().int().positive().describe('Target client session ID (use get_status to discover).'),
            message: z.string().max(100).optional().describe('Optional poke message (≤ 100 chars; TS3 limit).'),
          }),
          execute: async ({ client_id, message }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'poke_client', client_id }
            if (message) cmd.message = message
            const resp = await c.sendCommand(cmd, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    kick_client: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Kick a client from the current channel or the entire server. Destructive — applied immediately, no confirmation prompt. Use get_status to find client IDs.',
          inputSchema: z.object({
            client_id: z.number().int().positive().describe('Target client session ID.'),
            reason: z.string().max(255).optional().describe('Reason shown to the kicked client.'),
            kick_type: z
              .enum(['channel', 'server'])
              .optional()
              .describe('"channel" boots them back to the default channel; "server" disconnects them. Default: "server".'),
          }),
          execute: async ({ client_id, reason, kick_type }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'kick_client', client_id }
            if (reason) cmd.reason = reason
            if (kick_type) cmd.kick_type = kick_type
            const resp = await c.sendCommand(cmd, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    move_client: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Move another client to a specific channel. (To move the bot itself, use move_channel.) Use get_status to discover client and channel IDs.',
          inputSchema: z.object({
            client_id: z.number().int().positive().describe('Client session ID to move.'),
            channel_id: z.number().int().positive().describe('Destination channel ID (> 0).'),
            password: z.string().optional().describe('Channel password if required.'),
          }),
          execute: async ({ client_id, channel_id, password }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'move_client', client_id, channel_id }
            if (password) cmd.password = password
            const resp = await c.sendCommand(cmd, { expectIntermediate: true })
            void refreshState()
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    // ─── Bot self-management ──────────────────────────────────────────────

    set_nickname: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description: "Change the bot's own display nickname on TeamSpeak. The new name is visible to everyone immediately.",
          inputSchema: z.object({
            nickname: z.string().min(1).max(30).describe('New nickname (1-30 chars; TS3 limit).'),
          }),
          execute: async ({ nickname }) => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'set_nickname', nickname }, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    // ─── Server info ──────────────────────────────────────────────────────

    get_server_info: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description: 'Get TS3 virtual server metadata (name, welcome message, version, max clients, etc.).',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'get_server_info' }, { expectIntermediate: true })
            if (!resp.success) return { error: resp.message ?? 'get_server_info failed' }
            return { success: true, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },

    // ─── Channel admin ────────────────────────────────────────────────────

    create_channel: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Create a new TS3 channel. Optionally make it temporary (auto-deletes when empty), nest it under a parent, or set topic / description / password.',
          inputSchema: z.object({
            name: z.string().min(1).max(40).describe('Channel name (1-40 chars; TS3 limit).'),
            parent_id: z.number().int().nonnegative().optional().describe('Parent channel ID (0 or omit = root).'),
            temporary: z.boolean().optional().describe('If true, the channel auto-deletes when the last client leaves.'),
            topic: z.string().max(255).optional().describe('Channel topic (short tagline).'),
            description: z.string().max(8192).optional().describe('Channel description (long text, ≤ 8192 chars).'),
            password: z.string().optional().describe('Optional password to restrict access.'),
          }),
          execute: async ({ name, parent_id, temporary, topic, description, password }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'create_channel', name }
            if (parent_id != null) cmd.parent_id = parent_id
            if (temporary != null) cmd.temporary = temporary
            if (topic) cmd.topic = topic
            if (description) cmd.description = description
            if (password) cmd.password = password
            const resp = await c.sendCommand(cmd, { expectIntermediate: true })
            void refreshState()
            return { success: resp.success, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },

    set_channel_description: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description: "Update an existing channel's description (long text shown in TS3 channel info).",
          inputSchema: z.object({
            channel_id: z.number().int().positive().describe('Target channel ID.'),
            description: z.string().max(8192).describe('New description (≤ 8192 chars). Pass an empty string to clear.'),
          }),
          execute: async ({ channel_id, description }) => {
            const c = ensureClient()
            const resp = await c.sendCommand(
              { type: 'set_channel_description', channel_id, description },
              { expectIntermediate: false },
            )
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    delete_channel: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Delete a TS3 channel. Destructive — applied immediately, no confirmation prompt. Set force=true to delete even if clients are inside (they will be moved to the default channel).',
          inputSchema: z.object({
            channel_id: z.number().int().positive().describe('Channel ID to delete.'),
            force: z.boolean().optional().describe('If true, delete even when clients are present (they get moved to the default channel). Default: false.'),
          }),
          execute: async ({ channel_id, force }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'delete_channel', channel_id }
            if (force != null) cmd.force = force
            const resp = await c.sendCommand(cmd, { expectIntermediate: false })
            void refreshState()
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    // ─── Voice listening (Whisper STT) ────────────────────────────────────

    activate_listener: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description: 'Start transcribing voice from a specific TS3 client (Whisper STT). Audio from that client will start producing transcription events.',
          inputSchema: z.object({
            client_id: z.number().int().positive().describe('Client session ID to start listening to.'),
          }),
          execute: async ({ client_id }) => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'activate_listener', client_id }, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    deactivate_listener: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description: 'Stop transcribing voice from a specific TS3 client. Transcription events for that client will cease.',
          inputSchema: z.object({
            client_id: z.number().int().positive().describe('Client session ID to stop listening to.'),
          }),
          execute: async ({ client_id }) => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'deactivate_listener', client_id }, { expectIntermediate: false })
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    set_language: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Override the language used for STT (Whisper) for a specific client. Pass an ISO 639-1 two-letter code (e.g. "fr", "en", "de") or "auto" to reset to automatic detection.',
          inputSchema: z.object({
            client_id: z.number().int().positive().describe('Client session ID.'),
            language: z
              .string()
              .regex(/^([a-z]{2}|auto)$/, 'Must be a lowercase ISO 639-1 two-letter code (e.g. "fr") or "auto".')
              .describe('ISO 639-1 code (e.g. "fr", "en", "de", "es", "ja") or "auto".'),
          }),
          execute: async ({ client_id, language }) => {
            const c = ensureClient()
            const resp = await c.sendCommand(
              { type: 'set_language', client_id, language },
              { expectIntermediate: false },
            )
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    // ─── TTS parameters: volume ───────────────────────────────────────────

    set_volume: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Set the TTS playback volume on the ts-bot side. 0 = mute, 100 = normal, 200 = 2x gain. Persisted by ts-bot until changed again.',
          inputSchema: z.object({
            volume: z
              .number()
              .int()
              .min(0)
              .max(200)
              .describe('Volume level 0-200 (100 = normal, 0 = mute, 200 = 2x gain).'),
          }),
          execute: async ({ volume }) => {
            const c = ensureClient()
            const resp = await c.sendCommand(
              { type: 'set_volume', volume },
              { expectIntermediate: false },
            )
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    get_volume: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description: 'Get the current TTS playback volume (0-200, where 100 = normal).',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'get_volume' }, { expectIntermediate: false })
            if (!resp.success) return { error: resp.message ?? 'get_volume failed' }
            return { success: true, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },

    // ─── TTS parameters: voice ────────────────────────────────────────────

    set_voice: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Set the default TTS voice used by ts-bot. Accepts any voice registered server-side: OpenAI voices (alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse) and any ElevenLabs voice or cloned voice that ts-bot has loaded at startup (e.g. kartal, jade, edouard...). Validation is performed by ts-bot against its live voice registry; invalid voices return an error message listing the valid ones. Persisted by ts-bot until changed again.',
          inputSchema: z.object({
            voice: z
              .string()
              .min(1)
              .describe(
                'Voice name. OpenAI voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse. ElevenLabs/cloned voices depend on what ts-bot has loaded (use get_status or ask ts-bot to discover the current list).',
              ),
          }),
          execute: async ({ voice }) => {
            const c = ensureClient()
            const resp = await c.sendCommand(
              { type: 'set_voice', voice },
              { expectIntermediate: false },
            )
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    get_voice: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description: 'Get the current default TTS voice used by ts-bot.',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'get_voice' }, { expectIntermediate: false })
            if (!resp.success) return { error: resp.message ?? 'get_voice failed' }
            return { success: true, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },

    // ─── TTS parameters: speed ────────────────────────────────────────────

    set_speed: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Set the TTS speech speed. Range 0.25 (very slow) to 4.0 (very fast); ts-bot default is 1.15. Persisted until changed again.',
          inputSchema: z.object({
            speed: z
              .number()
              .min(0.25)
              .max(4.0)
              .describe('TTS speed (0.25-4.0, default 1.15).'),
          }),
          execute: async ({ speed }) => {
            const c = ensureClient()
            const resp = await c.sendCommand(
              { type: 'set_speed', speed },
              { expectIntermediate: false },
            )
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    get_speed: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description: 'Get the current TTS speech speed (0.25-4.0).',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'get_speed' }, { expectIntermediate: false })
            if (!resp.success) return { error: resp.message ?? 'get_speed failed' }
            return { success: true, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },

    // ─── STT silence-detection timeout ────────────────────────────────────

    set_timeout: {
      availability: ['main'] as const,
      create: () =>
        tool({
          description:
            'Set the silence-detection timeout (in milliseconds) used by the STT/listener pipeline to decide when a speaker has stopped talking. Range 500-10000 ms.',
          inputSchema: z.object({
            timeout_ms: z
              .number()
              .int()
              .min(500)
              .max(10000)
              .describe('Silence detection timeout in milliseconds (500-10000).'),
          }),
          execute: async ({ timeout_ms }) => {
            const c = ensureClient()
            const resp = await c.sendCommand(
              { type: 'set_timeout', timeout_ms },
              { expectIntermediate: false },
            )
            return { success: resp.success, message: resp.message }
          },
        }),
    },

    get_timeout: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description: 'Get the current STT silence-detection timeout in milliseconds.',
          inputSchema: z.object({}),
          execute: async () => {
            const c = ensureClient()
            const resp = await c.sendCommand({ type: 'get_timeout' }, { expectIntermediate: false })
            if (!resp.success) return { error: resp.message ?? 'get_timeout failed' }
            return { success: true, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },

    // ─── Conversation history ─────────────────────────────────────────────

    get_history: {
      availability: ['main', 'sub-kin'] as const,
      create: () =>
        tool({
          description:
            'Fetch the most recent conversation history entries (chat + voice transcriptions) tracked by ts-bot. Optional `count` controls how many entries are returned (default 20, max 50).',
          inputSchema: z.object({
            count: z
              .number()
              .int()
              .min(1)
              .max(50)
              .optional()
              .describe('Number of entries to return (default 20, max 50).'),
          }),
          execute: async ({ count }) => {
            const c = ensureClient()
            const cmd: Record<string, unknown> = { type: 'get_history' }
            if (count != null) cmd.count = count
            const resp = await c.sendCommand(cmd, { expectIntermediate: false })
            if (!resp.success) return { error: resp.message ?? 'get_history failed' }
            return { success: true, message: resp.message ?? null, data: resp.data ?? null }
          },
        }),
    },
  }

  return {
    channels: { teamspeak: adapter },
    tools,

    async activate(): Promise<void> {
      ctx.log.info(
        {
          wsUrl: cfg.wsUrl,
          enableTtsOnPublic: cfg.enableTtsOnPublic,
          ttsMaxChars: cfg.ttsMaxChars,
          defaultVoice: cfg.defaultVoice ?? null,
        },
        'teamspeak plugin activated',
      )
    },

    async deactivate(): Promise<void> {
      try { disposeClient(cfg.wsUrl) } catch { /* ignore */ }
      client = null
      activeChannelId = null
      onMessage = null
      ctx.log.info('teamspeak plugin deactivated')
    },
  }
}
