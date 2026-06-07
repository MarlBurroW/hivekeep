import { describe, it, expect, afterEach } from 'bun:test'
import { getPublicUrlMismatch } from './public-url'

function setOrigin(origin: string | undefined) {
  if (origin === undefined) {
    // @ts-expect-error test teardown
    delete globalThis.window
    return
  }
  // @ts-expect-error minimal window stub for the origin read
  globalThis.window = { location: { origin } }
}

afterEach(() => setOrigin(undefined))

describe('getPublicUrlMismatch', () => {
  it('warns when reached at a domain but configured for localhost', () => {
    setOrigin('https://hivekeep.example.com')
    expect(getPublicUrlMismatch('http://localhost:3000')).toEqual({
      actual: 'https://hivekeep.example.com',
      configured: 'http://localhost:3000',
    })
  })

  it('warns on LAN-IP access while still configured for localhost', () => {
    setOrigin('http://192.168.1.50:3000')
    expect(getPublicUrlMismatch('http://localhost:3000')).toEqual({
      actual: 'http://192.168.1.50:3000',
      configured: 'http://localhost:3000',
    })
  })

  it('no warning when the origins match (ignores path/trailing slash)', () => {
    setOrigin('https://hivekeep.example.com')
    expect(getPublicUrlMismatch('https://hivekeep.example.com/')).toBeNull()
  })

  it('no warning during localhost access', () => {
    setOrigin('http://localhost:5173')
    expect(getPublicUrlMismatch('https://hivekeep.example.com')).toBeNull()
  })

  it('no warning during 127.0.0.1 access', () => {
    setOrigin('http://127.0.0.1:3000')
    expect(getPublicUrlMismatch('https://hivekeep.example.com')).toBeNull()
  })

  it('returns null for an unparseable public URL', () => {
    setOrigin('https://hivekeep.example.com')
    expect(getPublicUrlMismatch('not a url')).toBeNull()
  })

  it('returns null when public URL is empty or missing', () => {
    setOrigin('https://hivekeep.example.com')
    expect(getPublicUrlMismatch(null)).toBeNull()
    expect(getPublicUrlMismatch('')).toBeNull()
    expect(getPublicUrlMismatch(undefined)).toBeNull()
  })

  it('returns null when window is unavailable (SSR-safe)', () => {
    setOrigin(undefined)
    expect(getPublicUrlMismatch('https://hivekeep.example.com')).toBeNull()
  })
})
