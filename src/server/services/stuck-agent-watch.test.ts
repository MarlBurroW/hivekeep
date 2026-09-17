import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockConfig, fullMockDbIndex, fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// The sweep is pure policy over two queue primitives; mock those and the DB so
// the thresholds are exercised for real rather than the storage layer.
const stuckItems: Array<{ id: string; agentId: string; ageMs: number }> = []
const requeued: string[] = []
const notifications: Array<{ title: string; agentId?: string }> = []

mock.module('@/server/config', () => ({ config: fullMockConfig }))
mock.module('@/server/db/index', () => ({ ...fullMockDbIndex }))
mock.module('@/server/db/schema', () => ({ ...fullMockSchema }))
mock.module('drizzle-orm', () => ({ ...fullMockDrizzleOrm }))
mock.module('@/server/services/queue', () => ({
  findStuckProcessingItems: (olderThanMs: number) => stuckItems.filter((i) => i.ageMs >= olderThanMs),
  requeueProcessingItems: (agentId: string) => {
    requeued.push(agentId)
    return 1
  },
}))
mock.module('@/server/services/notifications', () => ({
  createNotification: async (n: { title: string; agentId?: string }) => {
    notifications.push(n)
  },
}))

const { sweepStuckAgents } = await import('@/server/services/stuck-agent-watch')

const WARN = fullMockConfig.queue.stuckWarnMs
const RECOVER = fullMockConfig.queue.stuckRecoverMs

beforeEach(() => {
  stuckItems.length = 0
  requeued.length = 0
  notifications.length = 0
})

describe('sweepStuckAgents', () => {
  it('leaves a young turn alone', async () => {
    stuckItems.push({ id: 'q1', agentId: 'a1', ageMs: 60_000 })
    const res = await sweepStuckAgents()
    expect(res).toEqual({ warned: 0, recovered: 0 })
    expect(requeued).toEqual([])
    expect(notifications).toEqual([])
  })

  it('warns past the warn threshold without touching the turn', async () => {
    // A long turn may still be legitimate, so warning must not requeue: doing
    // so would kill real work in progress.
    stuckItems.push({ id: 'q1', agentId: 'a1', ageMs: WARN + 1000 })
    const res = await sweepStuckAgents()
    expect(res.warned).toBe(1)
    expect(res.recovered).toBe(0)
    expect(requeued).toEqual([])
    expect(notifications).toHaveLength(1)
  })

  it('does not warn twice for the same Agent', async () => {
    // Distinct id per test: the dedupe set is module state that outlives a test.
    stuckItems.push({ id: 'q1', agentId: 'a-dedupe', ageMs: WARN + 1000 })
    await sweepStuckAgents()
    const second = await sweepStuckAgents()
    expect(second.warned).toBe(0)
    expect(notifications).toHaveLength(1)
  })

  it('requeues past the recovery threshold so the Agent answers again', async () => {
    stuckItems.push({ id: 'q1', agentId: 'a-recover', ageMs: RECOVER + 1000 })
    const res = await sweepStuckAgents()
    expect(res.recovered).toBe(1)
    expect(requeued).toEqual(['a-recover'])
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.title).toContain('unblocked')
  })

  it('warns again after an Agent recovered and got stuck once more', async () => {
    stuckItems.push({ id: 'q1', agentId: 'a-recycle', ageMs: WARN + 1000 })
    await sweepStuckAgents()
    stuckItems.length = 0
    await sweepStuckAgents() // no longer stuck — clears the dedupe entry
    stuckItems.push({ id: 'q2', agentId: 'a-recycle', ageMs: WARN + 1000 })
    const res = await sweepStuckAgents()
    expect(res.warned).toBe(1)
  })

  it('handles several Agents in one pass, each on its own threshold', async () => {
    stuckItems.push({ id: 'q1', agentId: 'warned', ageMs: WARN + 1000 })
    stuckItems.push({ id: 'q2', agentId: 'recovered', ageMs: RECOVER + 1000 })
    stuckItems.push({ id: 'q3', agentId: 'young', ageMs: 5_000 })
    const res = await sweepStuckAgents()
    expect(res.warned).toBe(1)
    expect(res.recovered).toBe(1)
    expect(requeued).toEqual(['recovered'])
  })
})
