import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  formatRelativeTime,
  formatDurationBetween,
  formatElapsed,
  formatDurationMs,
  computeDurationMs,
  timeAgo,
} from './time'

// ─── formatDurationMs ───────────────────────────────────────────────────────

describe('formatDurationMs', () => {
  it('returns <1s for sub-second durations', () => {
    expect(formatDurationMs(0)).toBe('<1s')
    expect(formatDurationMs(1)).toBe('<1s')
    expect(formatDurationMs(500)).toBe('<1s')
    expect(formatDurationMs(999)).toBe('<1s')
  })

  it('returns seconds for < 60s', () => {
    expect(formatDurationMs(1000)).toBe('1s')
    expect(formatDurationMs(1500)).toBe('1s') // floors
    expect(formatDurationMs(45_000)).toBe('45s')
    expect(formatDurationMs(59_999)).toBe('59s')
  })

  it('returns minutes and seconds for < 60m', () => {
    expect(formatDurationMs(60_000)).toBe('1m')
    expect(formatDurationMs(90_000)).toBe('1m 30s')
    expect(formatDurationMs(135_000)).toBe('2m 15s')
    expect(formatDurationMs(3_540_000)).toBe('59m') // 59 minutes exactly
    expect(formatDurationMs(3_599_999)).toBe('59m 59s')
  })

  it('omits seconds when exactly on the minute', () => {
    expect(formatDurationMs(120_000)).toBe('2m')
    expect(formatDurationMs(300_000)).toBe('5m')
  })

  it('returns hours and minutes for < 24h', () => {
    expect(formatDurationMs(3_600_000)).toBe('1h')
    expect(formatDurationMs(5_400_000)).toBe('1h 30m')
    expect(formatDurationMs(7_200_000)).toBe('2h')
    expect(formatDurationMs(86_399_999)).toBe('23h 59m')
  })

  it('omits minutes when exactly on the hour', () => {
    expect(formatDurationMs(7_200_000)).toBe('2h')
    expect(formatDurationMs(36_000_000)).toBe('10h')
  })

  it('returns days and hours for >= 24h', () => {
    expect(formatDurationMs(86_400_000)).toBe('1d')
    expect(formatDurationMs(90_000_000)).toBe('1d 1h')
    expect(formatDurationMs(172_800_000)).toBe('2d')
    expect(formatDurationMs(180_000_000)).toBe('2d 2h')
  })

  it('handles large values', () => {
    // 30 days
    expect(formatDurationMs(30 * 86_400_000)).toBe('30d')
    // 365 days
    expect(formatDurationMs(365 * 86_400_000)).toBe('365d')
  })

  it('handles negative values gracefully', () => {
    // Negative ms should return <1s (floors to 0 or negative)
    expect(formatDurationMs(-1000)).toBe('<1s')
  })
})

// ─── formatRelativeTime ─────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  let realDateNow: () => number

  beforeEach(() => {
    realDateNow = Date.now
  })

  afterEach(() => {
    Date.now = realDateNow
  })

  it('returns <1m for very recent timestamps', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(formatRelativeTime(now)).toBe('<1m')
    expect(formatRelativeTime(now - 30_000)).toBe('<1m')
    expect(formatRelativeTime(now - 59_999)).toBe('<1m')
  })

  it('returns minutes for < 1h', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(formatRelativeTime(now - 60_000)).toBe('1m')
    expect(formatRelativeTime(now - 300_000)).toBe('5m')
    expect(formatRelativeTime(now - 3_599_999)).toBe('59m')
  })

  it('returns hours for < 1d', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(formatRelativeTime(now - 3_600_000)).toBe('1h')
    expect(formatRelativeTime(now - 7_200_000)).toBe('2h')
    expect(formatRelativeTime(now - 86_399_999)).toBe('23h')
  })

  it('returns days for >= 1d', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(formatRelativeTime(now - 86_400_000)).toBe('1d')
    expect(formatRelativeTime(now - 172_800_000)).toBe('2d')
  })

  it('appends suffix when requested', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(formatRelativeTime(now, { suffix: true })).toBe('<1m ago')
    expect(formatRelativeTime(now - 300_000, { suffix: true })).toBe('5m ago')
    expect(formatRelativeTime(now - 7_200_000, { suffix: true })).toBe('2h ago')
    expect(formatRelativeTime(now - 86_400_000, { suffix: true })).toBe('1d ago')
  })

  it('does not append suffix by default', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(formatRelativeTime(now - 300_000)).toBe('5m')
    expect(formatRelativeTime(now - 300_000, {})).toBe('5m')
    expect(formatRelativeTime(now - 300_000, { suffix: false })).toBe('5m')
  })
})

// ─── formatDurationBetween ──────────────────────────────────────────────────

describe('formatDurationBetween', () => {
  it('computes duration between two ISO timestamps', () => {
    expect(formatDurationBetween('2024-01-01T00:00:00Z', '2024-01-01T00:00:45Z')).toBe('45s')
    expect(formatDurationBetween('2024-01-01T00:00:00Z', '2024-01-01T00:02:15Z')).toBe('2m 15s')
    expect(formatDurationBetween('2024-01-01T00:00:00Z', '2024-01-01T01:30:00Z')).toBe('1h 30m')
  })

  it('returns <1s for identical timestamps', () => {
    expect(formatDurationBetween('2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')).toBe('<1s')
  })

  it('handles sub-second differences', () => {
    expect(formatDurationBetween('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.500Z')).toBe('<1s')
  })
})

// ─── formatElapsed ──────────────────────────────────────────────────────────

describe('formatElapsed', () => {
  let realDateNow: () => number

  beforeEach(() => {
    realDateNow = Date.now
  })

  afterEach(() => {
    Date.now = realDateNow
  })

  it('returns seconds for < 60s', () => {
    const now = new Date('2024-01-01T00:01:00Z').getTime()
    Date.now = () => now
    expect(formatElapsed('2024-01-01T00:00:45Z')).toBe('15s')
    expect(formatElapsed('2024-01-01T00:00:30Z')).toBe('30s')
  })

  it('returns 0s for current time', () => {
    const now = new Date('2024-01-01T00:00:00Z').getTime()
    Date.now = () => now
    expect(formatElapsed('2024-01-01T00:00:00Z')).toBe('0s')
  })

  it('returns minutes for >= 60s', () => {
    const now = new Date('2024-01-01T00:05:00Z').getTime()
    Date.now = () => now
    expect(formatElapsed('2024-01-01T00:00:00Z')).toBe('5m')
    expect(formatElapsed('2024-01-01T00:02:00Z')).toBe('3m')
  })
})

// ─── computeDurationMs ──────────────────────────────────────────────────────

describe('computeDurationMs', () => {
  it('returns null when start is null/undefined', () => {
    expect(computeDurationMs(null, null, 1000)).toBeNull()
    expect(computeDurationMs(undefined, 500, 1000)).toBeNull()
  })

  it('returns the frozen span when end is set', () => {
    expect(computeDurationMs(1000, 5000, 9999)).toBe(4000)
  })

  it('returns the live span (now - start) when end is null', () => {
    expect(computeDurationMs(1000, null, 5000)).toBe(4000)
    expect(computeDurationMs(1000, undefined, 3500)).toBe(2500)
  })

  it('clamps negative spans to 0', () => {
    expect(computeDurationMs(5000, 1000)).toBe(0)
    expect(computeDurationMs(5000, null, 1000)).toBe(0)
  })
})

// ─── timeAgo ────────────────────────────────────────────────────────────────

describe('timeAgo', () => {
  let realDateNow: () => number

  beforeEach(() => {
    realDateNow = Date.now
  })

  afterEach(() => {
    Date.now = realDateNow
  })

  it('is an alias for formatRelativeTime', () => {
    const now = 1_700_000_000_000
    Date.now = () => now
    expect(timeAgo(now)).toBe('<1m')
    expect(timeAgo(now - 300_000)).toBe('5m')
    expect(timeAgo(now - 7_200_000)).toBe('2h')
    expect(timeAgo(now - 86_400_000)).toBe('1d')
  })
})
