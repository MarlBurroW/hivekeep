import { timingSafeEqual } from 'crypto'
import { Hono } from 'hono'
import { handleWhatsAppWebhook } from '@/server/channels/whatsapp'
import { handleIncomingChannelMessage, getChannel } from '@/server/services/channels'
import { getSecretValue } from '@/server/services/vault'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:channel-whatsapp')

export const channelWhatsAppRoutes = new Hono()

// GET /api/channels/whatsapp/webhook/:channelId — Meta webhook verification
channelWhatsAppRoutes.get('/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== 'whatsapp' || channel.status !== 'active') {
    return c.text('Not found', 404)
  }

  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  if (mode !== 'subscribe' || !token || !challenge) {
    return c.text('Bad request', 400)
  }

  // Verify the token against the one stored in vault
  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
  const verifyTokenKey = (cfg as { verifyTokenVaultKey?: string }).verifyTokenVaultKey
  if (!verifyTokenKey) {
    log.warn({ channelId }, 'No verifyTokenVaultKey configured')
    return c.text('Forbidden', 403)
  }

  const expectedToken = await getSecretValue(verifyTokenKey)
  const tokenBuf = Buffer.from(token ?? '')
  const expectedBuf = Buffer.from(expectedToken ?? '')
  if (!expectedToken || tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    log.warn({ channelId }, 'Webhook verification token mismatch')
    return c.text('Forbidden', 403)
  }

  log.info({ channelId }, 'WhatsApp webhook verified')
  return c.text(challenge)
})

// POST /api/channels/whatsapp/webhook/:channelId — receive WhatsApp messages
channelWhatsAppRoutes.post('/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== 'whatsapp' || channel.status !== 'active') {
    return c.json({ ok: true })
  }

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: true })
  }

  const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>

  try {
    await handleWhatsAppWebhook(channelId, body, async (msg) => {
      await handleIncomingChannelMessage(channelId, msg)
    }, cfg)
  } catch (err) {
    log.error({ channelId, err }, 'Error handling WhatsApp webhook')
  }

  // Meta expects 200 quickly
  return c.json({ ok: true })
})
