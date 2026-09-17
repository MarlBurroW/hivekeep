import { describe, expect, test } from 'bun:test'
import { normalizeToolCallArgs } from './InlineToolCall'

describe('normalizeToolCallArgs', () => {
  test('normalizes missing pending tool-call args to an empty object', () => {
    expect(normalizeToolCallArgs(undefined)).toEqual({})
    expect(normalizeToolCallArgs(null)).toEqual({})
  })

  test('preserves provided args objects', () => {
    const args = { value: 42 }
    expect(normalizeToolCallArgs(args)).toBe(args)
  })
})
