import { describe, expect, test } from 'bun:test'
import { matchPluginRoute } from './plugin-hooks'
import { validatePluginExports } from '@/server/services/plugins'

describe('matchPluginRoute', () => {
  test('matches an exact path', () => {
    expect(matchPluginRoute({ method: 'POST', path: '/webhook' }, 'POST', '/webhook')).toEqual({})
  })

  test('captures :param segments and decodes them', () => {
    expect(
      matchPluginRoute({ method: 'POST', path: '/webhook/:key' }, 'POST', '/webhook/a%20b'),
    ).toEqual({ key: 'a b' })
  })

  test('rejects a method mismatch', () => {
    expect(matchPluginRoute({ method: 'POST', path: '/webhook' }, 'GET', '/webhook')).toBeNull()
  })

  test('rejects a length mismatch instead of prefix-matching', () => {
    expect(
      matchPluginRoute({ method: 'POST', path: '/webhook' }, 'POST', '/webhook/extra'),
    ).toBeNull()
    expect(matchPluginRoute({ method: 'POST', path: '/webhook/:key' }, 'POST', '/webhook')).toBeNull()
  })

  test('rejects a literal segment mismatch', () => {
    expect(matchPluginRoute({ method: 'POST', path: '/a/:x/c' }, 'POST', '/a/b/d')).toBeNull()
  })
})

describe('validatePluginExports routes', () => {
  const handler = () => new Response('ok')

  test('accepts a well-formed routes array', () => {
    const result = validatePluginExports(
      { routes: [{ method: 'POST', path: '/webhook/:key', handler }] },
      'p',
    )
    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual([])
  })

  test('rejects a bad method, a traversal path and a missing handler', () => {
    const result = validatePluginExports(
      {
        routes: [
          { method: 'FETCH', path: '/x', handler },
          { method: 'GET', path: '/../etc', handler },
          { method: 'GET', path: '/ok' },
        ],
      },
      'p',
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(3)
  })

  test('rejects routes that is not an array', () => {
    const result = validatePluginExports({ routes: {} }, 'p')
    expect(result.valid).toBe(false)
  })
})
