import { Hono } from 'hono'
import { channelAdapters } from '@/server/channels/index'
import { SignalAdapter } from '@/server/channels/signal'
import { getChannel } from '@/server/services/channels'
import { verifyChannelWebhookToken } from '@/server/channels/webhook-token'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:channel-signal')

export const channelSignalRoutes = new Hono()

// POST /api/channels/signal/webhook/:channelId — receive Signal messages via signal-cli webhook
channelSignalRoutes.post('/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== 'signal' || channel.status !== 'active') {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  // The adapter registers the webhook URL with a derived ?token=; signal-cli
  // posts back to that exact URL. Reject deliveries without it so a leaked
  // channelId is not enough to inject forged messages.
  if (!verifyChannelWebhookToken('signal', channelId, c.req.query('token'))) {
    log.warn({ channelId }, 'Signal webhook rejected: missing or invalid token')
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook token' } }, 401)
  }

  let payload: Record<string, unknown>
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400)
  }

  try {
    const adapter = channelAdapters.get('signal') as SignalAdapter | undefined
    if (!adapter) {
      return c.json({ error: { code: 'ADAPTER_NOT_REGISTERED', message: 'Signal adapter not registered' } }, 500)
    }
    await adapter.handleWebhook(channelId, payload)
    return c.json({ ok: true })
  } catch (err) {
    log.error({ channelId, err }, 'Error handling Signal webhook')
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }, 500)
  }
})
