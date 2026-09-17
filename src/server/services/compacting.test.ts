import { describe, it, expect } from 'bun:test'
import { resolveKeepBudget, resolveTriggerTokens, resolveSummaryBudget } from '@/server/services/compacting'

// Token counting is delegated to the shared BPE tokenizer (countTokens) — see
// src/shared/token-estimator.ts for its coverage. Compaction no longer uses a
// local chars/4 heuristic, so there is no private estimator to characterize here.

// ─── Absolute-cap budget resolution ──────────────────────────────────────────
//
// The keep/trigger/summary budgets are `min(percent × window, absoluteCap)`.
// The cap only bites on large-window models — on a 200k model the percent still
// dominates, so behaviour there is unchanged.

describe('resolveKeepBudget', () => {
  it('percent dominates on a 200k window (cap does not bite)', () => {
    // 25% of 200k = 50k < 100k cap
    expect(resolveKeepBudget(25, 200_000, 100_000)).toBe(50_000)
  })

  it('absolute cap bounds a 1M window', () => {
    // 25% of 1M = 250k, capped to 100k
    expect(resolveKeepBudget(25, 1_000_000, 100_000)).toBe(100_000)
  })

  it('always returns the smaller of the two', () => {
    expect(resolveKeepBudget(5, 1_000_000, 100_000)).toBe(50_000) // 5% of 1M = 50k < cap
    expect(resolveKeepBudget(50, 1_000_000, 100_000)).toBe(100_000) // 50% of 1M = 500k → cap
  })
})

describe('resolveTriggerTokens', () => {
  it('percent dominates on 200k (75% = 150k < 300k cap)', () => {
    expect(resolveTriggerTokens(75, 200_000, 300_000)).toBe(150_000)
  })

  it('absolute cap bounds the 1M window (75% = 750k → 300k)', () => {
    expect(resolveTriggerTokens(75, 1_000_000, 300_000)).toBe(300_000)
  })
})

describe('resolveSummaryBudget', () => {
  it('percent dominates on 200k (20% = 40k < 48k cap)', () => {
    expect(resolveSummaryBudget(20, 200_000, 48_000)).toBe(40_000)
  })

  it('absolute cap bounds the 1M window (20% = 200k → 48k)', () => {
    expect(resolveSummaryBudget(20, 1_000_000, 48_000)).toBe(48_000)
  })
})

describe('keep-window walk under the absolute cap', () => {
  // Mirror the runCompacting walk: accumulate per-message tokens newest→oldest
  // until the budget is exceeded; everything before keepStartIndex is summarized.
  function keptCount(msgTokens: number[], budget: number): number {
    let keep = 0
    let keepStartIndex = msgTokens.length
    for (let i = msgTokens.length - 1; i >= 0; i--) {
      if (keep + msgTokens[i]! > budget) break
      keep += msgTokens[i]!
      keepStartIndex = i
    }
    return msgTokens.length - keepStartIndex
  }

  it('keeps far fewer messages under the 100k cap than under the old 250k %-budget', () => {
    const msgs = Array(300).fill(2_000) // 300 messages × 2k tokens
    const capped = keptCount(msgs, resolveKeepBudget(25, 1_000_000, 100_000)) // 100k
    const oldBehaviour = keptCount(msgs, Math.floor(0.25 * 1_000_000)) // 250k
    expect(capped).toBe(50) // 100k / 2k
    expect(oldBehaviour).toBe(125) // 250k / 2k
    expect(capped).toBeLessThan(oldBehaviour)
  })
})

// ─── Summary cleanup logic ──────────────────────────────────────────────────

// The module keeps maxSummariesPerAgent summaries, deletes oldest archived ones.

interface Snapshot {
  id: string
  isActive: boolean
  createdAt: Date
}

function selectSnapshotsToDelete(snapshots: Snapshot[], maxSnapshots: number): string[] {
  // Sorted newest first (as the module does via desc(createdAt))
  const sorted = [...snapshots].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  if (sorted.length <= maxSnapshots) return []

  const toDelete = sorted.slice(maxSnapshots)
  // Only delete inactive ones
  return toDelete.filter((s) => !s.isActive).map((s) => s.id)
}

describe('snapshot cleanup logic', () => {
  it('does nothing when under the limit', () => {
    const snapshots: Snapshot[] = [
      { id: '1', isActive: true, createdAt: new Date('2026-01-01') },
      { id: '2', isActive: false, createdAt: new Date('2025-12-01') },
    ]
    expect(selectSnapshotsToDelete(snapshots, 5)).toEqual([])
  })

  it('deletes oldest inactive snapshots when over limit', () => {
    const snapshots: Snapshot[] = [
      { id: 'newest', isActive: true, createdAt: new Date('2026-03-01') },
      { id: 'mid1', isActive: false, createdAt: new Date('2026-02-01') },
      { id: 'mid2', isActive: false, createdAt: new Date('2026-01-01') },
      { id: 'oldest', isActive: false, createdAt: new Date('2025-12-01') },
    ]
    const toDelete = selectSnapshotsToDelete(snapshots, 2)
    expect(toDelete).toContain('mid2')
    expect(toDelete).toContain('oldest')
    expect(toDelete).not.toContain('newest')
  })

  it('never deletes active snapshots even if over limit', () => {
    const snapshots: Snapshot[] = [
      { id: 'new-active', isActive: true, createdAt: new Date('2026-03-01') },
      { id: 'old-active', isActive: true, createdAt: new Date('2025-01-01') },
      { id: 'mid', isActive: false, createdAt: new Date('2025-06-01') },
    ]
    const toDelete = selectSnapshotsToDelete(snapshots, 1)
    // old-active and mid are candidates, but old-active is active
    expect(toDelete).toEqual(['mid'])
  })
})
