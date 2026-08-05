import { describe, it, expect } from 'bun:test'
import { parseRetryAfterMs, isRetryableSendError, resolveRetryDelayMs } from '@/server/services/channel-retry'

describe('parseRetryAfterMs', () => {
  it('reads the Telegram 429 shape', () => {
    expect(
      parseRetryAfterMs(
        new Error('Telegram API sendMessage failed: {"ok":false,"error_code":429,"parameters":{"retry_after":12}}'),
      ),
    ).toBe(12_000)
  })

  it('reads a header-style value', () => {
    expect(parseRetryAfterMs(new Error('429 Too Many Requests (retry-after: 3)'))).toBe(3_000)
  })

  it('accepts a plain string error', () => {
    expect(parseRetryAfterMs('rate limited, retry_after=7')).toBe(7_000)
  })

  it('returns null when the error carries no delay', () => {
    expect(parseRetryAfterMs(new Error('500 Internal Server Error'))).toBeNull()
    expect(parseRetryAfterMs(new Error('429 Too Many Requests'))).toBeNull()
  })

  it('returns null for a non-error value', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull()
    expect(parseRetryAfterMs(null)).toBeNull()
  })

  it('caps an absurd delay so one bad response cannot stall delivery for hours', () => {
    // 24h requested; clamped to the configured ceiling (60s by default).
    expect(parseRetryAfterMs(new Error('retry_after: 86400'))).toBe(60_000)
  })

  it('treats a zero delay as an immediate retry, not as absent', () => {
    expect(parseRetryAfterMs(new Error('retry_after: 0'))).toBe(0)
  })
})

describe('isRetryableSendError', () => {
  it('retries rate limits', () => {
    expect(isRetryableSendError(new Error('429 Too Many Requests'))).toBe(true)
    expect(isRetryableSendError(new Error('Rate limit exceeded'))).toBe(true)
  })

  it('retries upstream 5xx', () => {
    expect(isRetryableSendError(new Error('502 Bad Gateway'))).toBe(true)
    expect(isRetryableSendError(new Error('service unavailable'))).toBe(true)
  })

  it('retries transient network failures', () => {
    expect(isRetryableSendError(new Error('ECONNRESET'))).toBe(true)
    expect(isRetryableSendError(new Error('fetch failed'))).toBe(true)
  })

  it('does NOT retry a client error that will fail identically', () => {
    // Retrying these wastes the user's time and can duplicate side effects.
    expect(isRetryableSendError(new Error('400 Bad Request: chat not found'))).toBe(false)
    expect(isRetryableSendError(new Error('403 Forbidden: bot was blocked by the user'))).toBe(false)
    expect(isRetryableSendError(new Error('message text is empty'))).toBe(false)
  })

  it('does not mistake an id containing 429 for a rate limit', () => {
    expect(isRetryableSendError(new Error('chat 1442988 not found'))).toBe(false)
  })
})

describe('resolveRetryDelayMs', () => {
  it('prefers the platform-provided delay over the backoff curve', () => {
    expect(resolveRetryDelayMs(new Error('retry_after: 9'), 1)).toBe(9_000)
  })

  it('falls back to exponential backoff', () => {
    expect(resolveRetryDelayMs(new Error('502'), 1)).toBe(1_000)
    expect(resolveRetryDelayMs(new Error('502'), 2)).toBe(2_000)
    expect(resolveRetryDelayMs(new Error('502'), 3)).toBe(4_000)
  })

  it('caps the backoff', () => {
    expect(resolveRetryDelayMs(new Error('502'), 20)).toBe(60_000)
  })
})
