import { describe, it, expect } from 'bun:test'
import { resolve, join } from 'path'

/**
 * Tests for mini-app capability permission logic and guards.
 *
 * We avoid importing the module (it pulls config/logger, and mock.module for
 * shared modules leaks across the suite) — instead we replicate the pure
 * logic, mirroring the house style of mini-apps.test.ts / crons.test.ts.
 */

// ─── Permission id validation (replicated from mini-app-capabilities.ts) ─────

const STATIC_PERMISSIONS = ['llm', 'agent:inform', 'agent:task'] as const
const SECRET_PERMISSION_RE = /^secrets:[A-Za-z0-9_.-]{1,128}$/

function isKnownPermission(permission: string): boolean {
  return (STATIC_PERMISSIONS as readonly string[]).includes(permission) || SECRET_PERMISSION_RE.test(permission)
}

function parseRequestedPermissions(manifest: { permissions?: unknown }): string[] {
  if (!Array.isArray(manifest.permissions)) return []
  const seen = new Set<string>()
  for (const entry of manifest.permissions) {
    if (typeof entry === 'string' && isKnownPermission(entry)) seen.add(entry)
  }
  return [...seen]
}

function parseGrantedPermissions(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string')
  } catch { /* malformed */ }
  return []
}

describe('Permission id validation', () => {
  it('accepts static permissions', () => {
    expect(isKnownPermission('llm')).toBe(true)
    expect(isKnownPermission('agent:inform')).toBe(true)
    expect(isKnownPermission('agent:task')).toBe(true)
  })

  it('accepts well-formed secret permissions', () => {
    expect(isKnownPermission('secrets:OPENWEATHER_API_KEY')).toBe(true)
    expect(isKnownPermission('secrets:my.key-2')).toBe(true)
  })

  it('rejects unknown and malformed ids', () => {
    expect(isKnownPermission('secrets:')).toBe(false)
    expect(isKnownPermission('secrets:with space')).toBe(false)
    expect(isKnownPermission('root')).toBe(false)
    expect(isKnownPermission('agent:delete-everything')).toBe(false)
    expect(isKnownPermission('')).toBe(false)
  })
})

describe('Manifest permission parsing', () => {
  it('keeps only well-formed entries, deduplicated', () => {
    const requested = parseRequestedPermissions({
      permissions: ['llm', 'llm', 'secrets:KEY', 'bogus', 42, null, 'agent:inform'],
    })
    expect(requested).toEqual(['llm', 'secrets:KEY', 'agent:inform'])
  })

  it('handles missing or non-array permissions', () => {
    expect(parseRequestedPermissions({})).toEqual([])
    expect(parseRequestedPermissions({ permissions: 'llm' })).toEqual([])
    expect(parseRequestedPermissions({ permissions: null })).toEqual([])
  })
})

describe('Granted permission column parsing', () => {
  it('parses a JSON string array', () => {
    expect(parseGrantedPermissions('["llm","secrets:K"]')).toEqual(['llm', 'secrets:K'])
  })

  it('null/malformed → no grants', () => {
    expect(parseGrantedPermissions(null)).toEqual([])
    expect(parseGrantedPermissions(undefined)).toEqual([])
    expect(parseGrantedPermissions('{not json')).toEqual([])
    expect(parseGrantedPermissions('"llm"')).toEqual([])
  })

  it('filters non-string entries', () => {
    expect(parseGrantedPermissions('["llm", 42, null]')).toEqual(['llm'])
  })
})

describe('Grant flow semantics', () => {
  it('only requested permissions can be granted; grants are additive', () => {
    const requested = ['llm', 'secrets:K']
    const current = ['llm']
    const grant = ['secrets:K', 'agent:task', 'bogus'] // agent:task not requested

    const invalid: string[] = []
    const accepted: string[] = []
    for (const p of grant) {
      if (!isKnownPermission(p) || !requested.includes(p)) invalid.push(p)
      else accepted.push(p)
    }
    const granted = [...new Set([...current, ...accepted])]

    expect(accepted).toEqual(['secrets:K'])
    expect(invalid).toEqual(['agent:task', 'bogus'])
    expect(granted).toEqual(['llm', 'secrets:K'])
  })

  it('grants not present in the manifest anymore are ignored at load', () => {
    // loadBackend filters granted ∩ requested — a stale grant for a permission
    // the app no longer requests must not survive into the ctx.
    const requested = ['llm']
    const grantedRaw = ['llm', 'secrets:OLD']
    const effective = grantedRaw.filter((p) => requested.includes(p))
    expect(effective).toEqual(['llm'])
  })
})

// ─── SSRF host blocking (replicated) ─────────────────────────────────────────

function isBlockedHost(hostname: string): boolean {
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) return true

  const parts = hostname.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = parseInt(parts[0]!, 10)
    const b = parseInt(parts[1]!, 10)
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
  }
  return false
}

describe('SSRF host blocking (ctx.fetch guard)', () => {
  it('blocks loopback and internal hostnames', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'nas.local', 'db.internal']) {
      expect(isBlockedHost(h)).toBe(true)
    }
  })

  it('blocks private ranges', () => {
    for (const h of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.5.5.5', '169.254.1.1', '0.1.2.3']) {
      expect(isBlockedHost(h)).toBe(true)
    }
  })

  it('allows public hosts', () => {
    for (const h of ['api.github.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', 'example.com']) {
      expect(isBlockedHost(h)).toBe(false)
    }
  })
})

// ─── _data path containment (ctx.files guard) ────────────────────────────────

function resolveDataPath(appDir: string, relativePath: string): string {
  const base = resolve(join(appDir, '_data'))
  const target = resolve(base, relativePath)
  if (!target.startsWith(base + '/') && target !== base) {
    throw new Error('files: path traversal detected')
  }
  return target
}

describe('ctx.files path containment', () => {
  const appDir = '/data/mini-apps/agent/app'

  it('resolves nested relative paths inside _data', () => {
    expect(resolveDataPath(appDir, 'cache/feed.json')).toBe('/data/mini-apps/agent/app/_data/cache/feed.json')
  })

  it('blocks traversal out of _data', () => {
    expect(() => resolveDataPath(appDir, '../index.html')).toThrow('path traversal')
    expect(() => resolveDataPath(appDir, '../../other-app/secret')).toThrow('path traversal')
    expect(() => resolveDataPath(appDir, '/etc/passwd')).toThrow('path traversal')
  })

  it('escaping into the app source dir is blocked (cannot rewrite _server.js)', () => {
    expect(() => resolveDataPath(appDir, '../_server.js')).toThrow('path traversal')
  })
})
