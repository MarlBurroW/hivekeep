import { describe, it, expect } from 'bun:test'
import { isHostAllowed, PluginPermissionError } from '@/server/services/plugins'

describe('isHostAllowed', () => {
  it('rejects any hostname when permissions are empty', () => {
    expect(isHostAllowed('api.example.com', [])).toBe(false)
    expect(isHostAllowed('localhost', [])).toBe(false)
  })

  it('ignores non-http permissions', () => {
    expect(isHostAllowed('api.example.com', ['storage', 'cards'])).toBe(false)
  })

  it('matches an exact hostname declaration', () => {
    const perms = ['http:api.example.com']
    expect(isHostAllowed('api.example.com', perms)).toBe(true)
    expect(isHostAllowed('example.com', perms)).toBe(false)
    expect(isHostAllowed('other.example.com', perms)).toBe(false)
  })

  it('matches subdomain wildcards (`http:*.example.com`)', () => {
    const perms = ['http:*.example.com']
    expect(isHostAllowed('api.example.com', perms)).toBe(true)
    expect(isHostAllowed('cdn.api.example.com', perms)).toBe(true)
    // The apex domain is also covered by the same declaration so plugin
    // authors don't need both entries.
    expect(isHostAllowed('example.com', perms)).toBe(true)
    expect(isHostAllowed('other.com', perms)).toBe(false)
    expect(isHostAllowed('fakeexample.com', perms)).toBe(false)
  })

  it('matches the catch-all `http:*`', () => {
    const perms = ['http:*']
    expect(isHostAllowed('api.example.com', perms)).toBe(true)
    expect(isHostAllowed('localhost', perms)).toBe(true)
    expect(isHostAllowed('192.168.1.10', perms)).toBe(true)
  })

  it('combines multiple permission entries (any match wins)', () => {
    const perms = ['http:api.first.com', 'http:*.second.com']
    expect(isHostAllowed('api.first.com', perms)).toBe(true)
    expect(isHostAllowed('cdn.second.com', perms)).toBe(true)
    expect(isHostAllowed('second.com', perms)).toBe(true)
    expect(isHostAllowed('third.com', perms)).toBe(false)
  })

  it('hostname comparison is case-sensitive (URL.hostname always normalizes to lowercase already)', () => {
    expect(isHostAllowed('API.example.com', ['http:api.example.com'])).toBe(false)
  })
})

describe('PluginPermissionError', () => {
  it('has a stable `code` and carries the plugin + host context', () => {
    const err = new PluginPermissionError('my-plugin', 'api.example.com')
    expect(err.code).toBe('PLUGIN_PERMISSION_DENIED')
    expect(err.pluginName).toBe('my-plugin')
    expect(err.hostname).toBe('api.example.com')
    expect(err.message).toContain('my-plugin')
    expect(err.message).toContain('api.example.com')
    expect(err.name).toBe('PluginPermissionError')
  })

  it('suggests both exact and wildcard declarations in the message', () => {
    const err = new PluginPermissionError('my-plugin', 'api.example.com')
    expect(err.message).toContain('http:api.example.com')
    expect(err.message).toContain('http:*.example.com')
    expect(err.message).toContain('http:*')
  })
})
