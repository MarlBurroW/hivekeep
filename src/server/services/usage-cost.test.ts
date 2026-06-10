import { describe, it, expect } from 'bun:test'
import { computeUsageCostUsd } from '@/server/services/usage-cost'

describe('computeUsageCostUsd', () => {
  // Pricing is USD per million tokens.
  const pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

  it('prices input + output at their per-million rates', () => {
    // 1M input @ $3 + 1M output @ $15 = $18
    expect(computeUsageCostUsd({ input: 3, output: 15 }, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6)
  })

  it('prices cache read/write at their own rates', () => {
    // 1M cache read @ $0.30 + 1M cache write @ $3.75 = $4.05
    expect(computeUsageCostUsd(pricing, { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 })).toBeCloseTo(4.05, 6)
  })

  it('falls back to the input rate when a cache rate is absent', () => {
    // No cacheRead price → cache reads billed at input ($3). 1M @ $3 = $3
    expect(computeUsageCostUsd({ input: 3, output: 15 }, { cacheReadTokens: 1_000_000 })).toBeCloseTo(3, 6)
  })

  it('handles null/undefined token counts as zero', () => {
    expect(computeUsageCostUsd(pricing, { inputTokens: null, outputTokens: undefined })).toBe(0)
  })

  it('computes a realistic small turn', () => {
    // 1000 input @ $3/M + 500 output @ $15/M = 0.003 + 0.0075 = 0.0105
    expect(computeUsageCostUsd({ input: 3, output: 15 }, { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(0.0105, 9)
  })
})
