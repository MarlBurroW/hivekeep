import type { ChannelAdapter, ChannelConfigSchema, IncomingAttachment, IncomingMessageHandler, OutboundMessageParams } from '@/server/channels/adapter'
import { readAttachmentBlob, attachmentFileName, isImageAttachment } from '@/server/channels/adapter'
import type { ChannelAdapterMeta } from '@/server/channels/adapter'
import { getSecretValue } from '@/server/services/vault'
import { createLogger } from '@/server/logger'

const log = createLogger('channel:matrix')

const MAX_MESSAGE_LENGTH = 4096

export interface MatrixChannelConfig {
  /** Vault key containing the Matrix access token */
  accessTokenVaultKey: string
  /** Homeserver URL (e.g. https://matrix.org) */
  homeserverUrl: string
  /** Optional: restrict to specific room IDs */
  allowedRoomIds?: string[]
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

async function resolveToken(cfg: Record<string, unknown>): Promise<string> {
  const vaultKey = (cfg as unknown as MatrixChannelConfig).accessTokenVaultKey
  const token = await getSecretValue(vaultKey)
  if (!token) throw new Error(`Vault key "${vaultKey}" not found`)
  return token
}

function getHomeserverUrl(cfg: Record<string, unknown>): string {
  const url = (cfg as unknown as MatrixChannelConfig).homeserverUrl
  if (!url) throw new Error('homeserverUrl is required in Matrix channel config')
  return url.replace(/\/+$/, '')
}

async function matrixApi(
  homeserver: string,
  token: string,
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
) {
  const resp = await fetch(`${homeserver}/_matrix/client/v3${endpoint}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Matrix API ${method} ${endpoint} failed (${resp.status}): ${text}`)
  }

  const contentType = resp.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    return await resp.json()
  }
  return null
}

/**
 * Matrix channel adapter using the Matrix Client-Server API.
 *
 * Uses long-polling /sync for receiving messages and standard REST for sending.
 * Incoming messages are received via the /sync loop started on `start()`.
 *
 * Matrix spec: https://spec.matrix.org/latest/client-server-api/
 */
// Dynamic config schema (issue #381). The runtime adapter reads
// accessTokenVaultKey and homeserverUrl from platformConfig; createChannel()
// stores accessToken as a vault entry and copies homeserverUrl as-is.
const matrixConfigSchema: ChannelConfigSchema = {
  fields: [
    {
      name: 'homeserverUrl',
      label: 'Homeserver URL',
      type: 'text',
      required: true,
      placeholder: 'https://matrix.example.org',
      description: 'Base URL of the Matrix homeserver (no trailing slash).',
    },
    {
      name: 'accessToken',
      label: 'Access token',
      type: 'password',
      required: true,
      description: 'Bot account access token (issued via /login or admin API).',
    },
  ],
}

export class MatrixAdapter implements ChannelAdapter {
  readonly platform = 'matrix'
  readonly meta: ChannelAdapterMeta = { displayName: 'Matrix', brandColor: '#0DBD8B' }
  readonly configSchema = matrixConfigSchema
  // Matrix exposes profile.set_displayname + profile.set_avatar_url on the
  // homeserver. The change is global to the bot account (its display name in
  // every room), which mirrors Telegram/Discord. Per-room overrides exist on
  // the Matrix spec but require admin power, so we stick with the global
  // profile API. Documented in docs/channel-transfers.md.
  readonly identitySwitchMode = 'native' as const

  private syncAbortControllers = new Map<string, AbortController>()
  private handlers = new Map<string, { onMessage: IncomingMessageHandler; cfg: MatrixChannelConfig }>()
  /** Track the bot's own user ID per channel to ignore own messages */
  private botUserIds = new Map<string, string>()

  async start(channelId: string, cfg: Record<string, unknown>, onMessage: IncomingMessageHandler): Promise<void> {
    const homeserver = getHomeserverUrl(cfg)
    const token = await resolveToken(cfg)
    const matrixCfg = cfg as unknown as MatrixChannelConfig

    this.handlers.set(channelId, { onMessage, cfg: matrixCfg })

    // Get bot's own user ID
    try {
      const whoami = await matrixApi(homeserver, token, 'GET', '/account/whoami') as { user_id: string }
      this.botUserIds.set(channelId, whoami.user_id)
      log.info({ channelId, userId: whoami.user_id }, 'Matrix bot identified')
    } catch (err) {
      log.error({ channelId, err }, 'Failed to identify Matrix bot user')
      throw err
    }

    // Start /sync long-polling loop
    this.startSyncLoop(channelId, homeserver, token, matrixCfg)

    log.info({ channelId, homeserver }, 'Matrix sync loop started')
  }

  async stop(channelId: string): Promise<void> {
    const controller = this.syncAbortControllers.get(channelId)
    if (controller) {
      controller.abort()
      this.syncAbortControllers.delete(channelId)
    }
    this.handlers.delete(channelId)
    this.botUserIds.delete(channelId)
    log.info({ channelId }, 'Matrix adapter stopped')
  }

  async sendMessage(
    channelId: string,
    cfg: Record<string, unknown>,
    params: OutboundMessageParams,
  ): Promise<{ platformMessageId: string }> {
    const homeserver = getHomeserverUrl(cfg)
    const token = await resolveToken(cfg)
    const roomId = encodeURIComponent(params.chatId)

    let lastEventId = ''

    // Send file attachments first
    if (params.attachments?.length) {
      for (const att of params.attachments) {
        const blob = await readAttachmentBlob(att)
        const fileName = attachmentFileName(att)

        // Upload to Matrix content repo
        const uploadResp = await fetch(
          `${homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(fileName)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': att.mimeType,
            },
            body: blob,
          },
        )
        if (!uploadResp.ok) {
          const text = await uploadResp.text()
          throw new Error(`Matrix media upload failed (${uploadResp.status}): ${text}`)
        }
        const uploadData = await uploadResp.json() as { content_uri: string }

        // Send media event
        const txnId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const isImage = isImageAttachment(att)
        const msgtype = isImage ? 'm.image' : 'm.file'

        const body: Record<string, unknown> = {
          msgtype,
          body: fileName,
          url: uploadData.content_uri,
          info: { mimetype: att.mimeType },
        }

        const result = await matrixApi(
          homeserver,
          token,
          'PUT',
          `/rooms/${roomId}/send/m.room.message/${encodeURIComponent(txnId)}`,
          body,
        ) as { event_id: string }
        lastEventId = result.event_id
      }
    }

    // Send text message
    if (params.content) {
      const chunks = splitMessage(params.content)
      for (let i = 0; i < chunks.length; i++) {
        const txnId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${i}`
        const body: Record<string, unknown> = {
          msgtype: 'm.text',
          body: chunks[i],
        }

        if (i === 0 && params.replyToMessageId && !params.attachments?.length) {
          body['m.relates_to'] = {
            'm.in_reply_to': {
              event_id: params.replyToMessageId,
            },
          }
        }

        const result = await matrixApi(
          homeserver,
          token,
          'PUT',
          `/rooms/${roomId}/send/m.room.message/${encodeURIComponent(txnId)}`,
          body,
        ) as { event_id: string }
        lastEventId = result.event_id
      }
    }

    return { platformMessageId: lastEventId }
  }

  async validateConfig(cfg: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
    try {
      const homeserver = getHomeserverUrl(cfg)
      const token = await resolveToken(cfg)
      await matrixApi(homeserver, token, 'GET', '/account/whoami')
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid Matrix config' }
    }
  }

  async getBotInfo(cfg: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
    try {
      const homeserver = getHomeserverUrl(cfg)
      const token = await resolveToken(cfg)
      const whoami = await matrixApi(homeserver, token, 'GET', '/account/whoami') as {
        user_id: string
      }

      // Try to get display name
      const userId = encodeURIComponent(whoami.user_id)
      try {
        const profile = await matrixApi(homeserver, token, 'GET', `/profile/${userId}`) as {
          displayname?: string
        }
        return { name: profile.displayname ?? whoami.user_id, username: whoami.user_id }
      } catch {
        return { name: whoami.user_id, username: whoami.user_id }
      }
    } catch {
      return null
    }
  }

  async sendTypingIndicator(_channelId: string, cfg: Record<string, unknown>, chatId: string): Promise<void> {
    try {
      const homeserver = getHomeserverUrl(cfg)
      const token = await resolveToken(cfg)

      // Need bot user ID for typing endpoint
      const whoami = await matrixApi(homeserver, token, 'GET', '/account/whoami') as { user_id: string }
      const roomId = encodeURIComponent(chatId)
      const userId = encodeURIComponent(whoami.user_id)

      await matrixApi(homeserver, token, 'PUT', `/rooms/${roomId}/typing/${userId}`, {
        typing: true,
        timeout: 10000,
      })
    } catch (err) {
      log.debug({ err }, 'Failed to send Matrix typing indicator')
    }
  }

  async onIdentityChange(
    _channelId: string,
    cfg: Record<string, unknown>,
    newIdentity: { kinSlug: string; kinName: string; avatarUrl?: string },
  ): Promise<void> {
    const homeserver = getHomeserverUrl(cfg)
    const token = await resolveToken(cfg)

    // Resolve bot user ID (Matrix profile endpoints are keyed by it).
    const whoami = await matrixApi(homeserver, token, 'GET', '/account/whoami') as { user_id: string }
    const userId = encodeURIComponent(whoami.user_id)

    // 1) Display name (always attempted).
    await matrixApi(homeserver, token, 'PUT', `/profile/${userId}/displayname`, {
      displayname: newIdentity.kinName,
    })

    // 2) Avatar: fetch the URL the core provided, upload to the Matrix media
    //    repo to obtain an mxc:// URI, then point the profile at it. If any
    //    step fails, log a warning and keep the display name change.
    if (newIdentity.avatarUrl) {
      try {
        const resp = await fetch(newIdentity.avatarUrl)
        if (!resp.ok) throw new Error(`avatar fetch returned ${resp.status}`)
        const contentType = resp.headers.get('content-type') ?? 'image/png'
        const blob = await resp.blob()
        const uploadResp = await fetch(
          `${homeserver}/_matrix/media/v3/upload?filename=avatar`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': contentType,
            },
            body: blob,
          },
        )
        if (!uploadResp.ok) throw new Error(`media upload returned ${uploadResp.status}`)
        const uploadData = await uploadResp.json() as { content_uri: string }
        await matrixApi(homeserver, token, 'PUT', `/profile/${userId}/avatar_url`, {
          avatar_url: uploadData.content_uri,
        })
      } catch (err) {
        log.warn(
          { err: String(err), kinSlug: newIdentity.kinSlug, avatarUrl: newIdentity.avatarUrl },
          'Matrix avatar update skipped: fetch or upload failed; display name was still updated',
        )
      }
    }
  }

  // ─── Sync loop ──────────────────────────────────────────────────────────────

  private startSyncLoop(
    channelId: string,
    homeserver: string,
    token: string,
    cfg: MatrixChannelConfig,
  ): void {
    const controller = new AbortController()
    this.syncAbortControllers.set(channelId, controller)

    let nextBatch: string | undefined
    let isInitialSync = true

    const doSync = async () => {
      while (!controller.signal.aborted) {
        try {
          const params = new URLSearchParams({
            timeout: '30000',
            // Only get room timeline events, minimal state
            filter: JSON.stringify({
              room: {
                timeline: { limit: isInitialSync ? 0 : 50 },
                state: { lazy_load_members: true },
              },
              presence: { types: [] },
              account_data: { types: [] },
            }),
          })
          if (nextBatch) params.set('since', nextBatch)

          const resp = await fetch(
            `${homeserver}/_matrix/client/v3/sync?${params.toString()}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: controller.signal,
            },
          )

          if (!resp.ok) {
            const text = await resp.text()
            log.error({ channelId, status: resp.status, text }, 'Matrix /sync failed')
            await new Promise((r) => setTimeout(r, 5000))
            continue
          }

          const data = await resp.json() as {
            next_batch: string
            rooms?: {
              join?: Record<string, {
                timeline?: {
                  events?: Array<{
                    type: string
                    event_id: string
                    sender: string
                    origin_server_ts: number
                    content: {
                      msgtype?: string
                      body?: string
                      displayname?: string
                      url?: string
                      info?: unknown
                    }
                  }>
                }
              }>
            }
          }

          nextBatch = data.next_batch

          // Skip processing on initial sync (just catch up the token)
          if (isInitialSync) {
            isInitialSync = false
            log.debug({ channelId, nextBatch }, 'Matrix initial sync complete')
            continue
          }

          // Process room events
          const joinedRooms = data.rooms?.join ?? {}
          for (const [roomId, roomData] of Object.entries(joinedRooms)) {
            // Filter by allowed rooms if configured
            if (cfg.allowedRoomIds?.length && !cfg.allowedRoomIds.includes(roomId)) {
              continue
            }

            const events = roomData.timeline?.events ?? []
            for (const event of events) {
              if (event.type !== 'm.room.message') continue

              const msgtype = event.content.msgtype
              const mediaTypes = ['m.image', 'm.file', 'm.audio', 'm.video']
              const isMedia = msgtype && mediaTypes.includes(msgtype)
              const isText = msgtype === 'm.text'

              if (!isText && !isMedia) continue
              if (!event.content.body && !isMedia) continue

              // Ignore own messages
              const botUserId = this.botUserIds.get(channelId)
              if (botUserId && event.sender === botUserId) continue

              const handler = this.handlers.get(channelId)
              if (!handler) continue

              // Extract file attachment from media messages
              let attachments: IncomingAttachment[] | undefined
              if (isMedia && event.content.url) {
                const mxcUrl = event.content.url as string
                // Convert mxc://server/mediaId to download URL
                const downloadUrl = mxcUrl.startsWith('mxc://')
                  ? `${homeserver}/_matrix/media/v3/download/${mxcUrl.slice(6)}`
                  : mxcUrl

                attachments = [{
                  platformFileId: mxcUrl,
                  mimeType: (event.content.info as Record<string, unknown> | undefined)?.mimetype as string | undefined,
                  fileName: event.content.body ?? undefined,
                  fileSize: (event.content.info as Record<string, unknown> | undefined)?.size as number | undefined,
                  url: downloadUrl,
                  headers: { Authorization: `Bearer ${token}` },
                }]
              }

              // For media messages, use body as caption (Matrix uses body as filename fallback)
              const content = isText ? (event.content.body ?? '') : ''

              // Skip if no text AND no attachments
              if (!content && !attachments) continue

              try {
                await handler.onMessage({
                  platformUserId: event.sender,
                  platformUsername: event.sender,
                  platformDisplayName: event.content.displayname ?? event.sender,
                  platformMessageId: event.event_id,
                  platformChatId: roomId,
                  content,
                  attachments,
                })
              } catch (err) {
                log.error({ channelId, roomId, eventId: event.event_id, err }, 'Error handling Matrix message')
              }
            }
          }
        } catch (err) {
          if (controller.signal.aborted) break
          log.error({ channelId, err }, 'Matrix sync error, retrying...')
          await new Promise((r) => setTimeout(r, 5000))
        }
      }
    }

    // Run async without awaiting
    doSync().catch((err) => {
      if (!controller.signal.aborted) {
        log.error({ channelId, err }, 'Matrix sync loop crashed')
      }
    })
  }
}
