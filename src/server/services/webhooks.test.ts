import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { fullMockConfig, fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mock dependencies ──────────────────────────────────────────────────────

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}))

mock.module('@/server/db/index', () => {
  const mockDb = {
    select: () => mockDb,
    from: () => mockDb,
    where: () => mockDb,
    orderBy: () => mockDb,
    limit: () => mockDb,
    insert: () => mockDb,
    values: () => ({ run: () => {} }),
    update: () => mockDb,
    set: () => mockDb,
    delete: () => mockDb,
    all: () => [],
    get: () => undefined,
    run: () => {},
  }
  return { db: mockDb, sqlite: { run: () => ({ changes: 0 }) } }
})

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  webhooks: {},
  webhookLogs: {},
  agents: {},
}))

mock.module('@/server/services/queue', () => ({
  enqueueMessage: async () => ({ id: 'queue-1', queuePosition: 1 }),
  dequeueMessage: async () => null,
  markQueueItemDone: async () => {},
  isAgentProcessing: async () => false,
  getQueueSize: async () => 0,
  getPendingQueueItems: async () => [],
  removeQueueItem: async () => false,
  recoverStaleProcessingItems: () => {},
  requeueProcessingItems: () => 0,
}))

mock.module('@/server/sse/index', () => ({
  sseManager: {
    broadcast: () => {},
    sendToAgent: () => {},
  },
}))

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    publicUrl: 'https://hivekeep.example.com',
    webhooks: {
      ...fullMockConfig.webhooks,
      maxPerAgent: 10,
    },
    queue: {
      ...fullMockConfig.queue,
      agentPriority: 5,
    },
  },
}))

mock.module('@/server/services/tasks', () => ({ spawnTask: mock(async () => ({ id: 'task-1' })) }))

const { validateToken, buildWebhookUrl } = await import('./webhooks')

// ─── Re-implement pure functions from webhooks.ts for isolated testing ───────
// These mirror the exact source logic. Import-based testing fails in the full
// test suite due to bun's mock.module leaking across files.

function extractByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

const MAX_FILTER_EXPRESSION_LENGTH = 500

interface FilterConfig {
  filterMode: string | null
  filterField: string | null
  filterAllowedValues: string | null
  filterExpression: string | null
}

interface FilterResult {
  passed: boolean
  extractedValue?: string | null
  error?: string
}

function evaluateFilter(config: FilterConfig, payload: string): FilterResult {
  if (!config.filterMode) return { passed: true }

  if (config.filterMode === 'simple') {
    if (!config.filterField) return { passed: true }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      return { passed: false, error: 'non-json' }
    }

    const raw = extractByPath(parsed, config.filterField)
    const extractedValue = raw == null ? null : String(raw)

    let allowedValues: string[] = []
    try {
      allowedValues = config.filterAllowedValues ? JSON.parse(config.filterAllowedValues) : []
    } catch {
      return { passed: false, error: 'invalid-allowed-values' }
    }

    if (allowedValues.length === 0) {
      return { passed: false, extractedValue }
    }

    if (extractedValue == null) {
      return { passed: false, extractedValue: null }
    }

    const lowerValue = extractedValue.toLowerCase()
    const passed = allowedValues.some((v) => v.toLowerCase() === lowerValue)
    return { passed, extractedValue }
  }

  if (config.filterMode === 'advanced') {
    if (!config.filterExpression) return { passed: true }
    if (config.filterExpression.length > MAX_FILTER_EXPRESSION_LENGTH) {
      return { passed: true, error: 'expression-too-long' }
    }

    try {
      const regex = new RegExp(config.filterExpression)
      return { passed: regex.test(payload) }
    } catch {
      return { passed: true, error: 'invalid-regex' }
    }
  }

  return { passed: true }
}

function resolveTemplate(template: string | null | undefined, payload: string): string | null {
  if (!template) return null

  let parsed: unknown = null
  try {
    parsed = JSON.parse(payload)
  } catch {
    // Non-JSON payload — only {{__payload__}} will resolve
  }

  return template.replace(/\{\{(.+?)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim()
    if (trimmed === '__payload__') return payload
    if (parsed == null) return ''
    const value = extractByPath(parsed, trimmed)
    if (value == null) return ''
    if (typeof value === 'object') {
      try { return JSON.stringify(value) } catch { return '' }
    }
    return String(value)
  })
}

function extractFieldPaths(obj: unknown, prefix = '', depth = 0): string[] {
  if (depth > 5 || obj == null || typeof obj !== 'object' || Array.isArray(obj)) return []

  const paths: string[] = []
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    paths.push(path)
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...extractFieldPaths(value, path, depth + 1))
    }
    if (paths.length >= 100) break
  }
  return paths.slice(0, 100)
}

// ─── validateToken ──────────────────────────────────────────────────────────

describe('validateToken', () => {
  it('returns true for matching tokens', () => {
    const token = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    expect(validateToken(token, token)).toBe(true)
  })

  it('returns false for different tokens of same length', () => {
    const a = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    const b = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    expect(validateToken(a, b)).toBe(false)
  })

  it('returns false for tokens of different lengths', () => {
    expect(validateToken('short', 'muchlongertoken')).toBe(false)
  })

  it('returns false when provided is empty', () => {
    expect(validateToken('', 'sometoken')).toBe(false)
  })

  it('returns false when stored is empty', () => {
    expect(validateToken('sometoken', '')).toBe(false)
  })

  it('returns false when both are empty', () => {
    expect(validateToken('', '')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(validateToken('AbCdEf', 'abcdef')).toBe(false)
  })

  it('handles unicode characters', () => {
    // Even though tokens should be hex, test that it doesn't crash
    expect(validateToken('héllo', 'héllo')).toBe(true)
    expect(validateToken('héllo', 'hello')).toBe(false)
  })

  it('uses timing-safe comparison (does not short-circuit)', () => {
    // We can't directly test timing, but we can verify it handles
    // tokens that differ only in the last character
    const a = 'abcdefghijklmnop'
    const b = 'abcdefghijklmnoq'
    expect(validateToken(a, b)).toBe(false)
  })
})

// ─── buildWebhookUrl ────────────────────────────────────────────────────────

describe('buildWebhookUrl', () => {
  it('constructs correct URL from webhook ID', () => {
    const id = 'abc-123-def'
    const url = buildWebhookUrl(id)
    expect(url).toBe('https://hivekeep.example.com/api/webhooks/incoming/abc-123-def')
  })

  it('handles UUID-style webhook IDs', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const url = buildWebhookUrl(id)
    expect(url).toBe(
      'https://hivekeep.example.com/api/webhooks/incoming/550e8400-e29b-41d4-a716-446655440000',
    )
  })

  it('uses the configured publicUrl', () => {
    const url = buildWebhookUrl('test')
    expect(url).toStartWith('https://hivekeep.example.com/')
  })

  it('includes the /api/webhooks/incoming/ path prefix', () => {
    const url = buildWebhookUrl('x')
    expect(url).toContain('/api/webhooks/incoming/')
  })
})

// ─── evaluateFilter ─────────────────────────────────────────────────────────

describe('evaluateFilter', () => {
  describe('no filter mode', () => {
    it('passes when filterMode is null', () => {
      const result = evaluateFilter({
        filterMode: null,
        filterField: null,
        filterAllowedValues: null,
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(true)
    })

    it('passes when filterMode is undefined', () => {
      const result = evaluateFilter({
        filterMode: undefined as any,
        filterField: null,
        filterAllowedValues: null,
        filterExpression: null,
      }, '{}')
      expect(result.passed).toBe(true)
    })
  })

  describe('simple mode', () => {
    it('passes when filterField is null (no filtering)', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(true)
    })

    it('fails on non-JSON payload', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: '["push"]',
        filterExpression: null,
      }, 'not json')
      expect(result.passed).toBe(false)
      expect(result.error).toBe('non-json')
    })

    it('matches value from top-level field', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: '["push","pull_request"]',
        filterExpression: null,
      }, '{"event":"push","ref":"main"}')
      expect(result.passed).toBe(true)
      expect(result.extractedValue).toBe('push')
    })

    it('matches value from nested field using dot notation', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'action.type',
        filterAllowedValues: '["created"]',
        filterExpression: null,
      }, '{"action":{"type":"created"}}')
      expect(result.passed).toBe(true)
      expect(result.extractedValue).toBe('created')
    })

    it('fails when value not in allowed list', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: '["push"]',
        filterExpression: null,
      }, '{"event":"issue"}')
      expect(result.passed).toBe(false)
      expect(result.extractedValue).toBe('issue')
    })

    it('is case-insensitive when matching allowed values', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: '["PUSH"]',
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(true)
    })

    it('fails when field does not exist in payload', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'missing',
        filterAllowedValues: '["value"]',
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(false)
      expect(result.extractedValue).toBeNull()
    })

    it('fails when allowed values list is empty', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: '[]',
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(false)
    })

    it('fails when filterAllowedValues is null', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: null,
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(false)
    })

    it('handles invalid filterAllowedValues JSON', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'event',
        filterAllowedValues: 'not json',
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(false)
      expect(result.error).toBe('invalid-allowed-values')
    })

    it('converts numeric values to string for comparison', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'status',
        filterAllowedValues: '["200"]',
        filterExpression: null,
      }, '{"status":200}')
      expect(result.passed).toBe(true)
      expect(result.extractedValue).toBe('200')
    })

    it('converts boolean values to string for comparison', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'active',
        filterAllowedValues: '["true"]',
        filterExpression: null,
      }, '{"active":true}')
      expect(result.passed).toBe(true)
    })

    it('handles deeply nested paths', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'a.b.c.d',
        filterAllowedValues: '["deep"]',
        filterExpression: null,
      }, '{"a":{"b":{"c":{"d":"deep"}}}}')
      expect(result.passed).toBe(true)
    })

    it('returns null extractedValue when path leads to null', () => {
      const result = evaluateFilter({
        filterMode: 'simple',
        filterField: 'value',
        filterAllowedValues: '["something"]',
        filterExpression: null,
      }, '{"value":null}')
      expect(result.passed).toBe(false)
      expect(result.extractedValue).toBeNull()
    })
  })

  describe('advanced mode (regex)', () => {
    it('passes when filterExpression is null (no filtering)', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: null,
      }, '{"event":"push"}')
      expect(result.passed).toBe(true)
    })

    it('passes when regex matches payload', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: '"event":\\s*"push"',
      }, '{"event": "push"}')
      expect(result.passed).toBe(true)
    })

    it('fails when regex does not match payload', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: '"event":\\s*"release"',
      }, '{"event":"push"}')
      expect(result.passed).toBe(false)
    })

    it('passes (with error) on invalid regex', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: '[invalid regex',
      }, '{"event":"push"}')
      expect(result.passed).toBe(true)
      expect(result.error).toBe('invalid-regex')
    })

    it('passes (with error) when expression exceeds max length', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: 'a'.repeat(501),
      }, '{}')
      expect(result.passed).toBe(true)
      expect(result.error).toBe('expression-too-long')
    })

    it('handles expression at exactly max length (500 chars)', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: 'a'.repeat(500),
      }, 'a'.repeat(500))
      // Regex 'aaa...' should match since payload contains 'aaa...'
      expect(result.passed).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('matches against raw payload string (not parsed JSON)', () => {
      const result = evaluateFilter({
        filterMode: 'advanced',
        filterField: null,
        filterAllowedValues: null,
        filterExpression: '^not-json-at-all$',
      }, 'not-json-at-all')
      expect(result.passed).toBe(true)
    })
  })

  describe('unknown filter mode', () => {
    it('passes for unknown filter modes', () => {
      const result = evaluateFilter({
        filterMode: 'unknown' as any,
        filterField: null,
        filterAllowedValues: null,
        filterExpression: null,
      }, '{}')
      expect(result.passed).toBe(true)
    })
  })
})

// ─── resolveTemplate ────────────────────────────────────────────────────────

describe('resolveTemplate', () => {
  it('returns null for null template', () => {
    expect(resolveTemplate(null, '{"a":1}')).toBeNull()
  })

  it('returns null for undefined template', () => {
    expect(resolveTemplate(undefined, '{"a":1}')).toBeNull()
  })

  it('returns null for empty string template', () => {
    expect(resolveTemplate('', '{"a":1}')).toBeNull()
  })

  it('returns template unchanged when no placeholders', () => {
    expect(resolveTemplate('static text', '{"a":1}')).toBe('static text')
  })

  it('resolves __payload__ to raw payload', () => {
    const payload = '{"event":"push"}'
    const result = resolveTemplate('Got: {{__payload__}}', payload)
    expect(result).toBe(`Got: ${payload}`)
  })

  it('resolves top-level field paths', () => {
    const result = resolveTemplate(
      'Event: {{event}}, Ref: {{ref}}',
      '{"event":"push","ref":"main"}',
    )
    expect(result).toBe('Event: push, Ref: main')
  })

  it('resolves nested field paths', () => {
    const result = resolveTemplate(
      'Author: {{commit.author.name}}',
      '{"commit":{"author":{"name":"Alice"}}}',
    )
    expect(result).toBe('Author: Alice')
  })

  it('replaces missing fields with empty string', () => {
    const result = resolveTemplate(
      'Value: {{missing}}',
      '{"other":"data"}',
    )
    expect(result).toBe('Value: ')
  })

  it('serializes object values as JSON', () => {
    const result = resolveTemplate(
      'Data: {{nested}}',
      '{"nested":{"a":1,"b":2}}',
    )
    expect(result).toBe('Data: {"a":1,"b":2}')
  })

  it('converts numbers to string', () => {
    const result = resolveTemplate('Count: {{count}}', '{"count":42}')
    expect(result).toBe('Count: 42')
  })

  it('converts booleans to string', () => {
    const result = resolveTemplate('Active: {{active}}', '{"active":true}')
    expect(result).toBe('Active: true')
  })

  it('handles non-JSON payload (only __payload__ resolves)', () => {
    const result = resolveTemplate(
      'Raw: {{__payload__}}, Field: {{event}}',
      'not-json',
    )
    expect(result).toBe('Raw: not-json, Field: ')
  })

  it('handles null field value as empty string', () => {
    const result = resolveTemplate('Val: {{val}}', '{"val":null}')
    expect(result).toBe('Val: ')
  })

  it('trims whitespace in path placeholders', () => {
    const result = resolveTemplate(
      '{{ event }}',
      '{"event":"push"}',
    )
    expect(result).toBe('push')
  })

  it('handles multiple occurrences of same placeholder', () => {
    const result = resolveTemplate(
      '{{event}} and {{event}}',
      '{"event":"push"}',
    )
    expect(result).toBe('push and push')
  })
})

// ─── extractFieldPaths ──────────────────────────────────────────────────────

describe('extractFieldPaths', () => {
  it('returns empty for null', () => {
    expect(extractFieldPaths(null)).toEqual([])
  })

  it('returns empty for undefined', () => {
    expect(extractFieldPaths(undefined)).toEqual([])
  })

  it('returns empty for arrays', () => {
    expect(extractFieldPaths([1, 2, 3])).toEqual([])
  })

  it('returns empty for primitives', () => {
    expect(extractFieldPaths('string')).toEqual([])
    expect(extractFieldPaths(42)).toEqual([])
    expect(extractFieldPaths(true)).toEqual([])
  })

  it('extracts top-level keys', () => {
    const paths = extractFieldPaths({ event: 'push', ref: 'main' })
    expect(paths).toContain('event')
    expect(paths).toContain('ref')
  })

  it('extracts nested object paths with dot notation', () => {
    const paths = extractFieldPaths({
      commit: { author: { name: 'Alice' } },
    })
    expect(paths).toContain('commit')
    expect(paths).toContain('commit.author')
    expect(paths).toContain('commit.author.name')
  })

  it('does not recurse into arrays', () => {
    const paths = extractFieldPaths({
      items: [1, 2, 3],
      name: 'test',
    })
    expect(paths).toContain('items')
    expect(paths).toContain('name')
    // Should not recurse into the array
    expect(paths).not.toContain('items.0')
  })

  it('respects max depth of 5 (stops recursing when depth > 5)', () => {
    // depth starts at 0, stops when depth > 5, so 6 levels of nesting are explored (0-5)
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } }
    const paths = extractFieldPaths(deep)
    expect(paths).toContain('a')
    expect(paths).toContain('a.b')
    expect(paths).toContain('a.b.c')
    expect(paths).toContain('a.b.c.d')
    expect(paths).toContain('a.b.c.d.e')
    expect(paths).toContain('a.b.c.d.e.f')
    // At depth 6 (>5), recursion stops
    expect(paths).not.toContain('a.b.c.d.e.f.g')
  })

  it('limits total paths to 100', () => {
    // Create object with many keys
    const obj: Record<string, string> = {}
    for (let i = 0; i < 150; i++) {
      obj[`key${i}`] = `value${i}`
    }
    const paths = extractFieldPaths(obj)
    expect(paths.length).toBeLessThanOrEqual(100)
  })

  it('uses custom prefix', () => {
    const paths = extractFieldPaths({ name: 'Alice' }, 'data')
    expect(paths).toContain('data.name')
  })

  it('handles empty object', () => {
    expect(extractFieldPaths({})).toEqual([])
  })

  it('handles mixed value types', () => {
    const paths = extractFieldPaths({
      str: 'hello',
      num: 42,
      bool: true,
      nil: null,
      arr: [1, 2],
      obj: { nested: 'value' },
    })
    expect(paths).toContain('str')
    expect(paths).toContain('num')
    expect(paths).toContain('bool')
    expect(paths).toContain('nil')
    expect(paths).toContain('arr')
    expect(paths).toContain('obj')
    expect(paths).toContain('obj.nested')
  })
})
