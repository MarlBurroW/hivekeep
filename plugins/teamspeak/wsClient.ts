/**
 * ts-bot WebSocket client helper.
 *
 * - One singleton client per (wsUrl) — multiple consumers (channel adapter + tools)
 *   share the same connection.
 * - Broadcast model: every connected WS client sees every event. We correlate
 *   command responses by `command_id`.
 * - Auto-reconnect with exponential backoff (capped). Listeners survive
 *   reconnects.
 * - Promises for commands time out after 10s.
 */

import { randomUUID } from 'node:crypto'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TsBotChannel {
  id: number
  name: string
  parent_id: number
  // ts-bot returns more fields (codec, order, topic, etc.) — we keep them as-is.
  [k: string]: unknown
}

export interface TsBotClient {
  id: number
  name: string
  channel_id: number
  uid?: string
  [k: string]: unknown
}

export interface TsBotServerState {
  own_client_id: number
  channels: TsBotChannel[]
  clients: TsBotClient[]
}

export interface WelcomeEvent {
  type: 'welcome'
  /** Documented as `bot_nickname` but the Rust enum serializes as `nickname`. We accept both. */
  nickname?: string
  bot_nickname?: string
  server?: string
  ts3_server?: string
  api_version: string
  connection_status: string
}

export interface CommandResponseEvent {
  type: 'command_response'
  command_id: string | null
  success: boolean
  message?: string
  data?: unknown
}

export interface MessageReceivedEvent {
  type: 'message_received'
  timestamp: string
  sender_id: number
  /** Real payload is a byte array (e.g. [54,85,...]); doc says base64 string. We accept both. */
  sender_uid: number[] | string
  sender_name: string
  message_type: 'channel' | 'private'
  content: string
  channel_id: number | null
  channel_name: string | null
}

export interface TranscriptionEvent {
  type: 'transcription'
  timestamp: string
  speaker_id: number
  speaker_uid: number[] | string
  speaker_name: string
  text: string
  confidence: number | null
  language: string | null
  duration_ms: number
}

export interface ConnectionStatusEvent {
  type: 'connection_status'
  status: 'connected' | 'disconnected' | 'reconnecting'
  server?: string
  channel_id?: number | null
  channel_name?: string | null
  error?: string | null
}

export interface ClientConnectedEvent {
  type: 'client_connected'
  client_id: number
  client_name: string
  channel_id: number
  uid?: string
}

export interface ClientDisconnectedEvent {
  type: 'client_disconnected'
  client_id: number
  client_name: string
  uid?: string
}

export interface ClientMovedEvent {
  type: 'client_moved'
  client_id: number
  client_name: string
  old_channel_id: number
  new_channel_id: number
  old_channel_name?: string | null
  new_channel_name?: string | null
  uid?: string
}

export interface SpeakStartedEvent {
  type: 'speak_started'
  text: string
}

export interface SpeakCompletedEvent {
  type: 'speak_completed'
  text: string
  duration_ms: number
  success?: boolean
  error?: string | null
}

export type TsBotEvent =
  | WelcomeEvent
  | CommandResponseEvent
  | MessageReceivedEvent
  | TranscriptionEvent
  | ConnectionStatusEvent
  | ClientConnectedEvent
  | ClientDisconnectedEvent
  | ClientMovedEvent
  | SpeakStartedEvent
  | SpeakCompletedEvent
  | { type: string;[k: string]: unknown }

export type EventType = TsBotEvent['type']

export type EventHandler<E extends TsBotEvent = TsBotEvent> = (event: E) => void

export interface PluginLogger {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

// ─── Internal pending command tracking ──────────────────────────────────────

interface PendingCommand {
  resolve: (response: CommandResponseEvent) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
  /**
   * When true, the command is known to emit a placeholder ack
   * ("Moving channel...", get_status's empty initial response, etc.)
   * before the real result — skip the first ack-looking response and
   * resolve on the next one carrying the same command_id.
   */
  skipAck: boolean
  /** Set once we've consumed the placeholder ack while waiting for the real response. */
  ackSeen: boolean
}

const COMMAND_TIMEOUT_MS = 10_000

// ─── Client ─────────────────────────────────────────────────────────────────

export interface WsClientOptions {
  url: string
  log: PluginLogger
  reconnectMaxBackoffMs?: number
}

export class TsBotWsClient {
  private ws: WebSocket | null = null
  private connected = false
  private welcomeEvent: WelcomeEvent | null = null
  private welcomeWaiters: Array<(welcome: WelcomeEvent) => void> = []
  private pending = new Map<string, PendingCommand>()
  private listeners = new Map<string, Set<EventHandler>>()
  private wildcardListeners = new Set<EventHandler>()
  private stopped = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly maxBackoff: number

  constructor(private readonly opts: WsClientOptions) {
    this.maxBackoff = opts.reconnectMaxBackoffMs ?? 30_000
  }

  /** Open the connection. Resolves on welcome, or rejects on first failure if `awaitWelcomeOnce` is true. */
  async start(awaitWelcomeOnce = false, welcomeTimeoutMs = 5000): Promise<WelcomeEvent> {
    this.stopped = false

    if (awaitWelcomeOnce) {
      // Single-shot connect, no auto-reconnect. Used for validateConfig/getBotInfo.
      return await this.connectOnce(welcomeTimeoutMs)
    }

    // Long-lived: connect and auto-reconnect on failure.
    this.scheduleConnect(0)
    return await this.waitForWelcome(welcomeTimeoutMs)
  }

  /** Close the connection and stop reconnecting. */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try { this.ws.close(1000, 'plugin shutdown') } catch { /* ignore */ }
      this.ws = null
    }
    // Reject all pending commands
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('WebSocket client stopped'))
    }
    this.pending.clear()
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  getWelcome(): WelcomeEvent | null {
    return this.welcomeEvent
  }

  /** Subscribe to events of a specific type. Returns an unsubscribe function. */
  on<E extends TsBotEvent>(type: EventType, handler: EventHandler<E>): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(handler as EventHandler)
    return () => {
      set!.delete(handler as EventHandler)
    }
  }

  /** Subscribe to ALL events (useful for debugging / future routing). */
  onAny(handler: EventHandler): () => void {
    this.wildcardListeners.add(handler)
    return () => { this.wildcardListeners.delete(handler) }
  }

  /** Wait until the welcome event has been received. */
  async waitForWelcome(timeoutMs = 5000): Promise<WelcomeEvent> {
    if (this.welcomeEvent) return this.welcomeEvent
    return await new Promise<WelcomeEvent>((resolve, reject) => {
      const t = setTimeout(() => {
        const idx = this.welcomeWaiters.indexOf(resolver)
        if (idx >= 0) this.welcomeWaiters.splice(idx, 1)
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ts-bot welcome event`))
      }, timeoutMs)
      const resolver = (welcome: WelcomeEvent) => {
        clearTimeout(t)
        resolve(welcome)
      }
      this.welcomeWaiters.push(resolver)
    })
  }

  /**
   * Send a command and wait for the matching `command_response`.
   *
   * Some commands (move_channel, get_status, send_message) emit two responses:
   * an immediate ack (placeholder) then the real result. We always wait for the
   * "real" one (the second response with the same command_id). For simple
   * commands (speak, stop_speaking) only one response is emitted; we accept the
   * first immediately.
   */
  async sendCommand<TData = unknown>(
    command: Record<string, unknown>,
    opts: { expectIntermediate?: boolean; timeoutMs?: number } = {},
  ): Promise<CommandResponseEvent & { data?: TData }> {
    if (!this.connected || !this.ws) {
      throw new Error('Not connected to ts-bot WebSocket')
    }
    const command_id = (command.command_id as string | undefined) ?? randomUUID()
    const payload = { ...command, command_id }
    const expectIntermediate = opts.expectIntermediate ?? false

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command_id)
        reject(new Error(`Timed out after ${opts.timeoutMs ?? COMMAND_TIMEOUT_MS}ms waiting for ts-bot command "${String(command.type)}" response`))
      }, opts.timeoutMs ?? COMMAND_TIMEOUT_MS)

      this.pending.set(command_id, {
        resolve: (resp) => resolve(resp as CommandResponseEvent & { data?: TData }),
        reject,
        timeout,
        skipAck: expectIntermediate,
        ackSeen: false,
      })

      try {
        this.ws!.send(JSON.stringify(payload))
      } catch (err) {
        this.pending.delete(command_id)
        clearTimeout(timeout)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private scheduleConnect(delayMs: number): void {
    if (this.stopped) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delayMs)
  }

  private async connectOnce(welcomeTimeoutMs: number): Promise<WelcomeEvent> {
    return await new Promise<WelcomeEvent>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.opts.url)
      const t = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* ignore */ }
        reject(new Error(`Timed out after ${welcomeTimeoutMs}ms connecting to ${this.opts.url}`))
      }, welcomeTimeoutMs)

      ws.addEventListener('message', (ev) => {
        if (settled) return
        try {
          const data = JSON.parse(String((ev as MessageEvent).data)) as TsBotEvent
          if (data.type === 'welcome') {
            settled = true
            clearTimeout(t)
            try { ws.close(1000, 'probe complete') } catch { /* ignore */ }
            resolve(data as WelcomeEvent)
          }
        } catch { /* ignore non-JSON */ }
      })

      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(t)
        reject(new Error(`WebSocket error connecting to ${this.opts.url}`))
      })
      ws.addEventListener('close', () => {
        if (settled) return
        settled = true
        clearTimeout(t)
        reject(new Error(`WebSocket closed before welcome from ${this.opts.url}`))
      })
    })
  }

  private openSocket(): void {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.opts.url)
    } catch (err) {
      this.opts.log.error({ err: String(err), url: this.opts.url }, 'Failed to construct WebSocket')
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.opts.log.info({ url: this.opts.url }, 'ts-bot WebSocket connected')
      this.connected = true
      this.reconnectAttempt = 0
    })

    ws.addEventListener('message', (ev) => {
      this.handleRawMessage(String((ev as MessageEvent).data))
    })

    ws.addEventListener('close', (ev) => {
      this.opts.log.warn(
        { code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason, url: this.opts.url },
        'ts-bot WebSocket closed',
      )
      this.connected = false
      this.welcomeEvent = null
      this.ws = null
      // Don't reject pending — let them time out, since the next reconnect may complete them is unrealistic.
      // Actually it's safer to reject so callers don't hang.
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('WebSocket closed before response'))
      }
      this.pending.clear()
      this.scheduleReconnect()
    })

    ws.addEventListener('error', (ev) => {
      this.opts.log.warn({ err: String((ev as ErrorEvent).message ?? ev), url: this.opts.url }, 'ts-bot WebSocket error')
      // 'close' handler will trigger reconnect.
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    this.reconnectAttempt += 1
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), this.maxBackoff)
    // Add jitter ±20%
    const jitter = base * 0.2 * (Math.random() * 2 - 1)
    const delay = Math.max(500, Math.round(base + jitter))
    this.opts.log.info({ delayMs: delay, attempt: this.reconnectAttempt }, 'Scheduling ts-bot WebSocket reconnect')
    this.scheduleConnect(delay)
  }

  private handleRawMessage(raw: string): void {
    let event: TsBotEvent
    try {
      event = JSON.parse(raw) as TsBotEvent
    } catch (err) {
      this.opts.log.warn({ err: String(err), raw: raw.slice(0, 200) }, 'Received non-JSON frame from ts-bot')
      return
    }
    if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') {
      return
    }

    // Welcome: capture and notify waiters
    if (event.type === 'welcome') {
      this.welcomeEvent = event as WelcomeEvent
      const waiters = this.welcomeWaiters.splice(0)
      for (const w of waiters) {
        try { w(this.welcomeEvent) } catch { /* ignore */ }
      }
    }

    // Command response: correlate
    if (event.type === 'command_response') {
      const resp = event as CommandResponseEvent
      const id = resp.command_id
      if (id) {
        const pending = this.pending.get(id)
        if (pending) {
          // Determine if this is the placeholder ack or the final response.
          // Heuristic: the placeholder ack has no `data` field and a `message`
          // ending in "..." (e.g. "Moving channel...", "Sending message...").
          // For get_status the ack has neither message nor data; the real
          // response has `data`. For move_channel/send_message the ack ends
          // with "...". For speak/stop_speaking only one response is sent.
          const looksLikeAck =
            resp.success &&
            resp.data === undefined &&
            typeof resp.message === 'string' &&
            resp.message.endsWith('...')
          const looksLikeAckEmpty =
            resp.success &&
            resp.data === undefined &&
            (resp.message === undefined || resp.message === null)

          // When the caller passed expectIntermediate=true (mapped to skipAck=true),
          // discard the first ack-looking response and wait for the real one.
          // Otherwise resolve on the first response.
          if (pending.skipAck) {
            if (!pending.ackSeen && (looksLikeAck || looksLikeAckEmpty)) {
              pending.ackSeen = true
              // keep waiting for the real response
            } else {
              clearTimeout(pending.timeout)
              this.pending.delete(id)
              pending.resolve(resp)
            }
          } else {
            clearTimeout(pending.timeout)
            this.pending.delete(id)
            pending.resolve(resp)
          }
        }
        // else: response from another WS client (broadcast model) — ignore
      }
    }

    // Fan out to listeners
    const set = this.listeners.get(event.type)
    if (set) {
      for (const handler of set) {
        try { handler(event) } catch (err) {
          this.opts.log.warn({ err: String(err), type: event.type }, 'event handler threw')
        }
      }
    }
    for (const handler of this.wildcardListeners) {
      try { handler(event) } catch (err) {
        this.opts.log.warn({ err: String(err), type: event.type }, 'wildcard event handler threw')
      }
    }
  }
}

// ─── Singleton registry ─────────────────────────────────────────────────────

const clients = new Map<string, TsBotWsClient>()

/** Get-or-create a singleton client per URL. Multiple consumers share it. */
export function getOrCreateClient(opts: WsClientOptions): TsBotWsClient {
  const existing = clients.get(opts.url)
  if (existing) return existing
  const client = new TsBotWsClient(opts)
  clients.set(opts.url, client)
  return client
}

/** Stop and forget a singleton client. */
export function disposeClient(url: string): void {
  const existing = clients.get(url)
  if (existing) {
    existing.stop()
    clients.delete(url)
  }
}

// ─── sender_uid helpers ─────────────────────────────────────────────────────

/**
 * The ts-bot WebSocket payload may serialize `sender_uid` either as a base64
 * string (per spec) or as a byte array (observed in practice). Normalize to a
 * stable base64 string for use as a contact identifier.
 */
export function normalizeUid(raw: number[] | string | null | undefined): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    // Treat as byte array → base64
    try {
      const buf = Buffer.from(raw as number[])
      return buf.toString('base64')
    } catch {
      return ''
    }
  }
  return ''
}
