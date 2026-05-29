/**
 * Shared time formatting utilities.
 *
 * These cover the common patterns used across sidebar, chat, and notification
 * components. Prefer these over inline helpers to keep formatting consistent.
 */

/** Compact relative time from a Unix-ms timestamp ("2m", "3h", "1d"). */
export function formatRelativeTime(ms: number, options?: { suffix?: boolean }): string {
  const diff = Date.now() - ms
  const suf = options?.suffix ? ' ago' : ''
  if (diff < 60_000) return `<1m${suf}`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m${suf}`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h${suf}`
  return `${Math.floor(diff / 86_400_000)}d${suf}`
}

/**
 * Compact duration between two ISO timestamps ("3s", "2m 15s").
 * For sub-second durations returns "<1s".
 */
export function formatDurationBetween(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return formatDurationMs(ms)
}

/** Compact elapsed time from an ISO timestamp until now ("12s", "3m"). */
export function formatElapsed(start: string): string {
  const ms = Date.now() - new Date(start).getTime()
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m`
}

/**
 * Compact duration from milliseconds.
 * Short form: "<1s", "45s", "2m 15s"
 * Long form (>1h): "2h 30m", "3d 5h"
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return '<1s'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const remainingSeconds = seconds % 60
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

/** Compact "time ago" from a Unix-ms timestamp ("<1m", "5m", "2h", "3d"). */
export function timeAgo(timestamp: number): string {
  return formatRelativeTime(timestamp)
}

/**
 * Compute a task / ticket run duration in milliseconds from a start timestamp.
 *
 * - `start` null → returns null (work hasn't begun: queued / pending / never
 *   moved to in_progress).
 * - `end` set → frozen duration (end - start). Used once the task is terminal.
 * - `end` null → live duration (now - start). `nowMs` lets callers pass a
 *   shared ticking clock so a list of rows recomputes in lockstep.
 *
 * Returns 0 (not null) for the degenerate case where start is in the future
 * relative to end/now, so callers can still render "<1s" instead of nothing.
 */
export function computeDurationMs(
  start: number | null | undefined,
  end: number | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (start == null) return null
  const endpoint = end ?? nowMs
  return Math.max(0, endpoint - start)
}
