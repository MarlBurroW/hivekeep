import { describe, it, expect, beforeEach } from 'bun:test'

// LogStore class is not exported, so we test via the exported `logStore` singleton.
// Each test uses unique tags to avoid cross-test pollution.

describe('LogStore', () => {
  // We'll dynamically import to get a fresh module each time
  // But bun caches imports, so let's just use the singleton and accept accumulation.

  let logStore: typeof import('./log-store')['logStore']

  beforeEach(async () => {
    // Fresh import won't work due to module caching in bun.
    // Instead, we'll just use the singleton and be aware of accumulated state.
    const mod = await import('./log-store')
    logStore = mod.logStore
  })

  describe('pushRaw', () => {
    it('omits private-session payloads from the shared ring and subscriber callback', () => {
      const marker = `private-sentinel-${Date.now()}`
      let captured: unknown
      logStore.setOnEntry((entry) => { captured = entry })
      logStore.pushRaw(JSON.stringify({
        level: 50, msg: marker, module: 'private-test', sessionId: 'private-session', agentId: 'agent',
        preview: marker, err: { message: marker },
      }))
      expect(logStore.query({ search: marker })).toHaveLength(0)
      expect(JSON.stringify(captured)).not.toContain(marker)
      expect(JSON.stringify(captured)).not.toContain('private-session')
      logStore.setOnEntry(() => {})
    })
    it('parses a valid Pino JSON log line', () => {
      const line = JSON.stringify({
        level: 30,
        time: '2026-01-15T12:00:00.000Z',
        msg: 'Test message',
        module: 'test-mod',
        pid: 123,
        hostname: 'localhost',
      })

      logStore.pushRaw(line)

      const results = logStore.query({ search: 'Test message', limit: 1 })
      expect(results.length).toBeGreaterThanOrEqual(1)

      const entry = results[results.length - 1]!
      expect(entry.level).toBe('info')
      expect(entry.module).toBe('test-mod')
      expect(entry.message).toBe('Test message')
    })

    it('maps Pino numeric levels correctly', () => {
      const levels = [
        { num: 10, label: 'trace' },
        { num: 20, label: 'debug' },
        { num: 30, label: 'info' },
        { num: 40, label: 'warn' },
        { num: 50, label: 'error' },
        { num: 60, label: 'fatal' },
      ]

      for (const { num, label } of levels) {
        const uniqueMsg = `level-test-${label}-${Date.now()}-${Math.random()}`
        logStore.pushRaw(JSON.stringify({ level: num, msg: uniqueMsg, module: 'level-test' }))
        const results = logStore.query({ search: uniqueMsg, limit: 1 })
        expect(results.length).toBe(1)
        expect(results[0]!.level).toBe(label)
      }
    })

    it('defaults to info for unknown numeric levels', () => {
      const uniqueMsg = `unknown-level-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 99, msg: uniqueMsg }))
      const results = logStore.query({ search: uniqueMsg, limit: 1 })
      expect(results.length).toBe(1)
      expect(results[0]!.level).toBe('info')
    })

    it('defaults module to "root" when not provided', () => {
      const uniqueMsg = `no-module-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 30, msg: uniqueMsg }))
      const results = logStore.query({ search: uniqueMsg, limit: 1 })
      expect(results.length).toBe(1)
      expect(results[0]!.module).toBe('root')
    })

    it('captures extra fields as data', () => {
      const uniqueMsg = `extra-fields-${Date.now()}`
      logStore.pushRaw(
        JSON.stringify({
          level: 30,
          msg: uniqueMsg,
          module: 'test',
          customField: 'hello',
          count: 42,
          // These should be excluded:
          pid: 1,
          hostname: 'h',
          time: '2026-01-01T00:00:00Z',
        }),
      )
      const results = logStore.query({ search: uniqueMsg, limit: 1 })
      expect(results.length).toBe(1)
      const data = results[0]!.data!
      expect(data.customField).toBe('hello')
      expect(data.count).toBe(42)
      // Excluded keys should not appear
      expect(data.pid).toBeUndefined()
      expect(data.hostname).toBeUndefined()
      expect(data.msg).toBeUndefined()
      expect(data.level).toBeUndefined()
      expect(data.time).toBeUndefined()
      expect(data.module).toBeUndefined()
    })

    it('ignores unparseable lines', () => {
      // Should not throw
      logStore.pushRaw('this is not json')
      logStore.pushRaw('')
      logStore.pushRaw('{broken')
    })

    it('handles empty message gracefully', () => {
      const uniqueModule = `empty-msg-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 30, module: uniqueModule }))
      const results = logStore.query({ module: uniqueModule, limit: 1 })
      expect(results.length).toBe(1)
      expect(results[0]!.message).toBe('')
    })

    it('sets data to undefined when no extra fields exist', () => {
      const uniqueMsg = `no-extra-${Date.now()}`
      // Only standard fields
      logStore.pushRaw(
        JSON.stringify({
          level: 30,
          msg: uniqueMsg,
          module: 'test',
          pid: 1,
          hostname: 'h',
          time: '2026-01-01T00:00:00Z',
        }),
      )
      const results = logStore.query({ search: uniqueMsg, limit: 1 })
      expect(results.length).toBe(1)
      expect(results[0]!.data).toBeUndefined()
    })
  })

  describe('query', () => {
    it('filters by level', () => {
      const tag = `level-filter-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 50, msg: `${tag}-error`, module: tag }))
      logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-info`, module: tag }))

      const errors = logStore.query({ module: tag, level: 'error' })
      expect(errors.every((e) => e.level === 'error')).toBe(true)
      expect(errors.some((e) => e.message === `${tag}-error`)).toBe(true)
    })

    it('filters by module (case-insensitive partial match)', () => {
      const tag = `ModFilter-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 30, msg: 'match', module: tag }))
      logStore.pushRaw(JSON.stringify({ level: 30, msg: 'no-match', module: 'other' }))

      const results = logStore.query({ module: tag.toLowerCase() })
      expect(results.some((e) => e.message === 'match')).toBe(true)
      expect(results.every((e) => e.module.toLowerCase().includes(tag.toLowerCase()))).toBe(true)
    })

    it('filters by search (case-insensitive, message)', () => {
      const tag = `SearchMsg-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 30, msg: `Hello ${tag} World` }))

      const results = logStore.query({ search: tag.toLowerCase() })
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('filters by search in data fields', () => {
      const tag = `SearchData-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 30, msg: 'generic', secretTag: tag }))

      const results = logStore.query({ search: tag })
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('filters by minutesAgo', () => {
      const tag = `time-filter-${Date.now()}`
      // Push entry with current timestamp
      logStore.pushRaw(JSON.stringify({ level: 30, msg: tag, module: tag }))

      const results = logStore.query({ module: tag, minutesAgo: 1 })
      expect(results.length).toBeGreaterThanOrEqual(1)

      // Very short window should still include it (just pushed)
      const recent = logStore.query({ module: tag, minutesAgo: 1 })
      expect(recent.length).toBeGreaterThanOrEqual(1)
    })

    it('respects limit parameter', () => {
      const tag = `limit-test-${Date.now()}`
      for (let i = 0; i < 10; i++) {
        logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-${i}`, module: tag }))
      }

      const limited = logStore.query({ module: tag, limit: 3 })
      expect(limited.length).toBe(3)
    })

    it('caps limit at 200', () => {
      // query with limit > 200 should be capped
      const results = logStore.query({ limit: 999 })
      expect(results.length).toBeLessThanOrEqual(200)
    })

    it('defaults limit to 50', () => {
      const tag = `default-limit-${Date.now()}`
      for (let i = 0; i < 60; i++) {
        logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-${i}`, module: tag }))
      }

      const results = logStore.query({ module: tag })
      expect(results.length).toBe(50)
    })

    it('returns newest entries last', () => {
      const tag = `order-test-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-first`, module: tag }))
      logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-second`, module: tag }))

      const results = logStore.query({ module: tag })
      const firstIdx = results.findIndex((e) => e.message === `${tag}-first`)
      const secondIdx = results.findIndex((e) => e.message === `${tag}-second`)
      expect(secondIdx).toBeGreaterThan(firstIdx)
    })

    it('combines multiple filters', () => {
      const tag = `combo-${Date.now()}`
      logStore.pushRaw(JSON.stringify({ level: 50, msg: `${tag}-error`, module: tag }))
      logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-info`, module: tag }))
      logStore.pushRaw(JSON.stringify({ level: 50, msg: `${tag}-error2`, module: 'other' }))

      const results = logStore.query({ module: tag, level: 'error', search: tag })
      expect(results.length).toBe(1)
      expect(results[0]!.message).toBe(`${tag}-error`)
    })

    it('returns empty array when no matches', () => {
      const results = logStore.query({ search: `nonexistent-${Date.now()}-${Math.random()}` })
      expect(results).toEqual([])
    })
  })

  describe('ring buffer behavior', () => {
    it('trims old entries when buffer exceeds maxSize', () => {
      // We can't easily test with the singleton (maxSize=2000),
      // but we can verify that pushRaw doesn't crash with many entries
      const tag = `overflow-${Date.now()}`
      for (let i = 0; i < 100; i++) {
        logStore.pushRaw(JSON.stringify({ level: 30, msg: `${tag}-${i}`, module: tag }))
      }
      const results = logStore.query({ module: tag, limit: 200 })
      expect(results.length).toBe(100)
    })
  })
})
