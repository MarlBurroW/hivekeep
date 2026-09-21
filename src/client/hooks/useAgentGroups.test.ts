/**
 * Tests for `upsertGroup`, the reducer behind every write in useAgentGroups.
 *
 * It exists because of a real bug: creating a group made it appear TWICE in the
 * sidebar for a few seconds. The SSE broadcast and the POST response are two
 * deliveries of the same change racing each other — the server broadcasts
 * before the response reaches the browser, so the event usually lands first and
 * the plain append that followed added a second copy. The duplicate then
 * vanished on the next refetch, which is exactly what made it look like a
 * rendering glitch instead of a state bug.
 *
 * Pure function, no DOM and no hook runtime needed — the same reason
 * `chunkText` and `selectEmbeddingProvider` are extracted in the server code.
 */
import { describe, it, expect } from 'bun:test'
import { upsertGroup } from '@/client/hooks/useAgentGroups'
import type { AgentGroup } from '@/shared/types'

function group(id: string, name: string, sortOrder = 0): AgentGroup {
  return { id, name, sortOrder, createdAt: 0, updatedAt: 0 }
}

describe('upsertGroup', () => {
  it('inserts a group that is not there yet', () => {
    const result = upsertGroup([], group('a', 'Finances'))
    expect(result.map((g) => g.id)).toEqual(['a'])
  })

  it('does NOT duplicate when the same id arrives twice', () => {
    // The exact race that shipped the bug: SSE first, then the POST response.
    const fromSse = upsertGroup([], group('a', 'Research'))
    const fromPost = upsertGroup(fromSse, group('a', 'Research'))
    expect(fromPost).toHaveLength(1)
  })

  it('replaces the existing entry rather than appending', () => {
    const before = upsertGroup([], group('a', 'Old name'))
    const after = upsertGroup(before, group('a', 'New name'))
    expect(after).toHaveLength(1)
    expect(after[0]!.name).toBe('New name')
  })

  it('matches on id, so two groups sharing a name stay separate', () => {
    const result = upsertGroup([group('a', 'Same')], group('b', 'Same'))
    expect(result).toHaveLength(2)
  })

  it('keeps display order: sortOrder first, then name', () => {
    const result = [
      group('z', 'Zebra', 0),
      group('m', 'Middle', -1),
      group('a', 'Alpha', 0),
    ].reduce<AgentGroup[]>((acc, g) => upsertGroup(acc, g), [])

    expect(result.map((g) => g.name)).toEqual(['Middle', 'Alpha', 'Zebra'])
  })

  it('re-sorts when an update changes sortOrder', () => {
    const before = [group('a', 'Alpha', 0), group('b', 'Beta', 1)].reduce<AgentGroup[]>(
      (acc, g) => upsertGroup(acc, g),
      [],
    )
    const after = upsertGroup(before, group('b', 'Beta', -1))
    expect(after.map((g) => g.id)).toEqual(['b', 'a'])
  })

  it('does not mutate the array it is given', () => {
    const original = [group('a', 'Alpha')]
    const copy = [...original]
    upsertGroup(original, group('b', 'Beta'))
    expect(original).toEqual(copy)
  })
})
