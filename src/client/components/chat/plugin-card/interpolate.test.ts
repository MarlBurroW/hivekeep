import { describe, test, expect } from 'bun:test'
import { interpolate } from './interpolate'

describe('interpolate', () => {
  test('replaces a full {{key}} placeholder with the raw value', () => {
    expect(interpolate('{{count}}', { count: 42 })).toBe(42)
    expect(interpolate('{{items}}', { items: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  test('does template expansion when placeholder is embedded in a string', () => {
    expect(interpolate('Hello {{name}}!', { name: 'world' })).toBe('Hello world!')
    expect(interpolate('{{a}}/{{b}}', { a: 1, b: 2 })).toBe('1/2')
  })

  test('returns string unchanged when key is missing for a full placeholder', () => {
    expect(interpolate('{{missing}}', {})).toBe('{{missing}}')
  })

  test('renders missing keys as empty inside embedded strings', () => {
    expect(interpolate('a={{x}} b={{y}}', { x: '1' })).toBe('a=1 b=')
  })

  test('walks arrays and objects recursively', () => {
    const layout = {
      type: 'stat-row',
      items: [
        { label: 'Status', value: '{{phase}}', variant: '{{phaseVariant}}' },
        { label: 'Count', value: '{{count}}' },
      ],
    }
    const state = { phase: 'Running', phaseVariant: 'primary', count: '7' }
    expect(interpolate(layout, state)).toEqual({
      type: 'stat-row',
      items: [
        { label: 'Status', value: 'Running', variant: 'primary' },
        { label: 'Count', value: '7' },
      ],
    })
  })

  test('supports dot paths for nested state lookup', () => {
    expect(interpolate('Hello {{user.name}}', { user: { name: 'Nico' } })).toBe('Hello Nico')
    expect(interpolate('{{user.name}}', { user: { name: 'Nico' } })).toBe('Nico')
  })

  test('preserves arrays passed through a full placeholder', () => {
    const layout = { type: 'log-stream', lines: '{{logs}}' }
    const state = { logs: ['line a', 'line b'] }
    expect(interpolate(layout, state)).toEqual({ type: 'log-stream', lines: ['line a', 'line b'] })
  })
})
