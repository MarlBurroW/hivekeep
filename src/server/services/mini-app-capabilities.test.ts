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

const STATIC_PERMISSIONS = ['llm', 'agent:inform', 'agent:task', 'channels:send'] as const
const SECRET_PERMISSION_RE = /^secrets:[A-Za-z0-9_.-]{1,128}$/
const PLATFORM_PERMISSION_RE = /^platform:[a-z][a-z0-9-]*:(read|write)$/
const EVENTS_PERMISSION_RE = /^events:[a-z][a-z0-9-]*$/

const PLATFORM_GATEWAY_DENIED_RESOURCES = new Set([
  'auth', 'onboarding', 'vault', 'database', 'mini-apps', 'users', 'sse', 'health', 'uploads',
])

const SUBSCRIBABLE_EVENT_PREFIXES = new Set([
  'chat', 'task', 'cron', 'channel', 'notification', 'contact', 'project',
  'ticket', 'memory', 'trigger', 'webhook', 'workspace', 'miniapp', 'agent',
])
const EVENT_TYPE_DENYLIST = new Set([
  'chat:token', 'chat:reasoning-token', 'chat:reasoning-done', 'chat:tool-call-start',
  'chat:tool-call', 'chat:tool-result', 'chat:token-usage', 'task:token-usage',
  'task:todos', 'queue:update', 'agent:read', 'agent:active-project',
])

function isKnownPermission(permission: string): boolean {
  return (
    (STATIC_PERMISSIONS as readonly string[]).includes(permission) ||
    SECRET_PERMISSION_RE.test(permission) ||
    PLATFORM_PERMISSION_RE.test(permission) ||
    EVENTS_PERMISSION_RE.test(permission)
  )
}

function eventPrefix(eventType: string): string {
  return eventType.split(':')[0] ?? ''
}
function isSubscribableEvent(eventType: string): boolean {
  if (EVENT_TYPE_DENYLIST.has(eventType)) return false
  return SUBSCRIBABLE_EVENT_PREFIXES.has(eventPrefix(eventType))
}
function checkEventAccess(granted: string[], eventType: string): { code: string } | null {
  if (!isSubscribableEvent(eventType)) return { code: 'EVENT_NOT_SUBSCRIBABLE' }
  if (!granted.includes(`events:${eventPrefix(eventType)}`)) return { code: 'PERMISSION_REQUIRED' }
  return null
}

function resolvePlatformResource(subPath: string, method: string): { resource: string; mode: 'read' | 'write' } | null {
  const resource = subPath.replace(/^\/+/, '').split('/')[0]?.split('?')[0] ?? ''
  if (!resource) return null
  const mode = method === 'GET' || method === 'HEAD' ? 'read' : 'write'
  return { resource, mode }
}

function checkPlatformAccess(granted: string[], resource: string, mode: 'read' | 'write'): { code: string } | null {
  if (PLATFORM_GATEWAY_DENIED_RESOURCES.has(resource)) return { code: 'RESOURCE_FORBIDDEN' }
  const allowed = mode === 'read'
    ? granted.includes(`platform:${resource}:read`) || granted.includes(`platform:${resource}:write`)
    : granted.includes(`platform:${resource}:write`)
  return allowed ? null : { code: 'PERMISSION_REQUIRED' }
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
    expect(isKnownPermission('channels:send')).toBe(true)
  })

  it('channel permission is global, not parameterized', () => {
    expect(isKnownPermission('channels:telegram')).toBe(false)
    expect(isKnownPermission('channels:')).toBe(false)
  })

  it('accepts platform gateway permissions', () => {
    expect(isKnownPermission('platform:contacts:read')).toBe(true)
    expect(isKnownPermission('platform:contacts:write')).toBe(true)
    expect(isKnownPermission('platform:crons:read')).toBe(true)
  })

  it('rejects malformed platform permissions', () => {
    expect(isKnownPermission('platform:contacts')).toBe(false)
    expect(isKnownPermission('platform:contacts:delete')).toBe(false)
    expect(isKnownPermission('platform::read')).toBe(false)
    expect(isKnownPermission('platform:Contacts:read')).toBe(false)
  })
})

describe('Platform gateway: resource + mode resolution', () => {
  it('maps GET/HEAD to read, mutations to write', () => {
    expect(resolvePlatformResource('/contacts', 'GET')).toEqual({ resource: 'contacts', mode: 'read' })
    expect(resolvePlatformResource('/contacts/c-1', 'HEAD')).toEqual({ resource: 'contacts', mode: 'read' })
    expect(resolvePlatformResource('/contacts', 'POST')).toEqual({ resource: 'contacts', mode: 'write' })
    expect(resolvePlatformResource('/contacts/c-1', 'DELETE')).toEqual({ resource: 'contacts', mode: 'write' })
    expect(resolvePlatformResource('/contacts/c-1', 'PATCH')).toEqual({ resource: 'contacts', mode: 'write' })
  })

  it('takes the first path segment as the resource, ignoring sub-path and query', () => {
    expect(resolvePlatformResource('/crons/c-1/approve', 'POST')?.resource).toBe('crons')
    expect(resolvePlatformResource('/contacts?q=alice', 'GET')?.resource).toBe('contacts')
    expect(resolvePlatformResource('contacts', 'GET')?.resource).toBe('contacts')
  })

  it('returns null for an empty path', () => {
    expect(resolvePlatformResource('/', 'GET')).toBeNull()
    expect(resolvePlatformResource('', 'GET')).toBeNull()
  })
})

describe('Platform gateway: access decision', () => {
  it('allows a read with a read grant', () => {
    expect(checkPlatformAccess(['platform:contacts:read'], 'contacts', 'read')).toBeNull()
  })

  it('a write grant implies read', () => {
    expect(checkPlatformAccess(['platform:contacts:write'], 'contacts', 'read')).toBeNull()
    expect(checkPlatformAccess(['platform:contacts:write'], 'contacts', 'write')).toBeNull()
  })

  it('a read grant does NOT allow writes', () => {
    expect(checkPlatformAccess(['platform:contacts:read'], 'contacts', 'write')?.code).toBe('PERMISSION_REQUIRED')
  })

  it('denies when no matching grant', () => {
    expect(checkPlatformAccess([], 'contacts', 'read')?.code).toBe('PERMISSION_REQUIRED')
    expect(checkPlatformAccess(['platform:crons:read'], 'contacts', 'read')?.code).toBe('PERMISSION_REQUIRED')
  })

  it('hard-blocks denied resources even with a (bogus) grant', () => {
    // mini-apps is the critical one: an app must not grant ITSELF permissions.
    expect(checkPlatformAccess(['platform:mini-apps:write'], 'mini-apps', 'write')?.code).toBe('RESOURCE_FORBIDDEN')
    expect(checkPlatformAccess(['platform:vault:read'], 'vault', 'read')?.code).toBe('RESOURCE_FORBIDDEN')
    expect(checkPlatformAccess(['platform:database:write'], 'database', 'write')?.code).toBe('RESOURCE_FORBIDDEN')
    expect(checkPlatformAccess(['platform:users:read'], 'users', 'read')?.code).toBe('RESOURCE_FORBIDDEN')
  })
})

describe('Event subscription: permission form + allowlist', () => {
  it('accepts events:<prefix> permissions', () => {
    expect(isKnownPermission('events:task')).toBe(true)
    expect(isKnownPermission('events:contact')).toBe(true)
    expect(isKnownPermission('events:channel')).toBe(true)
  })

  it('rejects malformed event permissions', () => {
    expect(isKnownPermission('events:')).toBe(false)
    expect(isKnownPermission('events:Task')).toBe(false)
    expect(isKnownPermission('events:task:done')).toBe(false)
  })

  it('maps an event type to its prefix', () => {
    expect(eventPrefix('task:done')).toBe('task')
    expect(eventPrefix('channel:message-received')).toBe('channel')
  })

  it('allows lifecycle events, blocks high-frequency/internal ones', () => {
    expect(isSubscribableEvent('task:done')).toBe(true)
    expect(isSubscribableEvent('contact:created')).toBe(true)
    expect(isSubscribableEvent('channel:message-received')).toBe(true)
    // Firehose / internal — never subscribable even though prefix is allowed
    expect(isSubscribableEvent('chat:token')).toBe(false)
    expect(isSubscribableEvent('queue:update')).toBe(false)
    expect(isSubscribableEvent('task:token-usage')).toBe(false)
    // Unknown prefix
    expect(isSubscribableEvent('provider:created')).toBe(false)
  })
})

describe('Event subscription: access decision', () => {
  it('allows when the prefix permission is granted', () => {
    expect(checkEventAccess(['events:task'], 'task:done')).toBeNull()
    expect(checkEventAccess(['events:contact'], 'contact:created')).toBeNull()
  })

  it('denies a non-subscribable event before checking permission', () => {
    expect(checkEventAccess(['events:chat'], 'chat:token')?.code).toBe('EVENT_NOT_SUBSCRIBABLE')
    expect(checkEventAccess(['events:queue'], 'queue:update')?.code).toBe('EVENT_NOT_SUBSCRIBABLE')
  })

  it('denies a subscribable event without the matching permission', () => {
    expect(checkEventAccess([], 'task:done')?.code).toBe('PERMISSION_REQUIRED')
    expect(checkEventAccess(['events:contact'], 'task:done')?.code).toBe('PERMISSION_REQUIRED')
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
