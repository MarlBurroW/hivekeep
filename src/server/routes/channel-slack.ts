import { Hono } from 'hono'
import { handleSlackWebhook } from '@/server/channels/slack'
import { getChannel } from '@/server/services/channels'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:channel-slack')

export const channelSlackRoutes = new Hono()

// POST /api/channels/slack/webhook/:channelId — receive Slack Events API callbacks
channelSlackRoutes.post('/:channelId', async (c) => {
  const channelId = c.req.param('channelId')

  const channel = await getChannel(channelId)
  if (!channel || channel.platform !== 'slack' || channel.status !== 'active') {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Channel not found' } }, 404)
  }

  // Read raw body for signature verification
  const rawBody = await c.req.text()

  // Extract relevant headers
  const headers: Record<string, string> = {
    'x-slack-signature': c.req.header('x-slack-signature') ?? '',
    'x-slack-request-timestamp': c.req.header('x-slack-request-timestamp') ?? '',
  }

  try {
    const result = await handleSlackWebhook(channelId, rawBody, headers)
    return c.json(result.body, result.status as 200)
  } catch (err) {
    log.error({ channelId, err }, 'Error handling Slack webhook')
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error' } }, 500)
  }
})
