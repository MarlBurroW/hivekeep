/**
 * Retry policy for outbound channel sends.
 *
 * Kept dependency-free and separate from channels.ts so it can be unit-tested
 * directly (importing channels.ts pulls in the DB and the adapter registry).
 */
import { config } from '@/server/config'

/**
 * Extract a platform-requested wait, in ms, from a rate-limit error.
 *
 * Telegram answers 429 with `parameters.retry_after` (seconds) and adapters
 * surface it inside the thrown message. Honouring it is the difference between
 * a reply that lands a few seconds late and one that is dropped: a single
 * attempt against a rate limit used to lose the message outright.
 *
 * Clamped, so one absurd value cannot stall delivery for hours.
 */
export function parseRetryAfterMs(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const m = /retry[_\s-]?after"?\s*[:=]?\s*(\d+)/i.exec(msg)
  if (!m) return null
  const seconds = Number(m[1])
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.min(seconds * 1000, config.channels.maxRetryDelayMs)
}

/** Transient failures worth retrying: rate limits, 5xx, network resets. */
export function isRetryableSendError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase()
  if (/(^|\D)429(\D|$)|too many requests|rate.?limit/.test(msg)) return true
  if (/(^|\D)(500|502|503|504)(\D|$)|bad gateway|service unavailable|gateway timeout/.test(msg)) return true
  return /econnreset|etimedout|enotfound|socket hang up|network|fetch failed|aborted/.test(msg)
}

/** Backoff for attempt N (1-based), honouring a platform-provided delay. */
export function resolveRetryDelayMs(error: unknown, attempt: number): number {
  return parseRetryAfterMs(error) ?? Math.min(1000 * 2 ** (attempt - 1), config.channels.maxRetryDelayMs)
}
