import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '@/server/config'

/**
 * Per-channel webhook token, derived (never stored) from the instance
 * encryption key. Channel ids appear in URLs, logs and exports, so "the id is
 * a UUID" is not an auth scheme: without this token anyone who learns an id
 * can POST forged platform updates straight into an Agent's queue. The token
 * is re-registered with the platform every time the adapter starts (boot or
 * activate), so no migration or config field is needed.
 */
export function channelWebhookToken(platform: string, channelId: string): string {
  return createHmac('sha256', config.encryptionKey)
    .update(`channel-webhook:${platform}:${channelId}`)
    .digest('hex')
}

export function verifyChannelWebhookToken(
  platform: string,
  channelId: string,
  presented: string | undefined | null,
): boolean {
  if (!presented) return false
  const expected = Buffer.from(channelWebhookToken(platform, channelId))
  const got = Buffer.from(presented)
  return got.length === expected.length && timingSafeEqual(got, expected)
}
