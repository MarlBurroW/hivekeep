import { describe, it, expect } from 'bun:test'
import { classifyMiniAppRequest } from '@/server/auth/mini-app-origin-guard'

const APP = 'app-123'
const serveRef = `https://host.example/api/mini-apps/${APP}/serve`
const staticRef = `https://host.example/api/mini-apps/${APP}/static/index.js`

describe('classifyMiniAppRequest', () => {
  it('allows requests with no referer (cannot classify)', () => {
    expect(classifyMiniAppRequest(undefined, '/api/contacts')).toEqual({ blocked: false })
    expect(classifyMiniAppRequest('', '/api/contacts')).toEqual({ blocked: false })
  })

  it('allows non-mini-app referers (the main app UI)', () => {
    expect(classifyMiniAppRequest('https://host.example/agents', '/api/contacts')).toEqual({ blocked: false })
    expect(classifyMiniAppRequest('https://host.example/', '/api/agents')).toEqual({ blocked: false })
  })

  it('allows a mini-app iframe to call its OWN namespace', () => {
    expect(classifyMiniAppRequest(serveRef, `/api/mini-apps/${APP}/storage/x`)).toEqual({ blocked: false })
    expect(classifyMiniAppRequest(serveRef, `/api/mini-apps/${APP}/platform/contacts`)).toEqual({ blocked: false })
    expect(classifyMiniAppRequest(staticRef, `/api/mini-apps/${APP}/api/hello`)).toEqual({ blocked: false })
    expect(classifyMiniAppRequest(serveRef, `/api/mini-apps/${APP}/events`)).toEqual({ blocked: false })
  })

  it('allows shared SDK assets', () => {
    expect(classifyMiniAppRequest(serveRef, '/api/mini-apps/sdk/hivekeep-sdk.js')).toEqual({ blocked: false })
  })

  it('BLOCKS a mini-app iframe reaching platform routes directly', () => {
    expect(classifyMiniAppRequest(serveRef, '/api/contacts')).toEqual({ blocked: true, appId: APP })
    expect(classifyMiniAppRequest(serveRef, '/api/vault/secrets')).toEqual({ blocked: true, appId: APP })
    expect(classifyMiniAppRequest(staticRef, '/api/agents')).toEqual({ blocked: true, appId: APP })
  })

  it('BLOCKS one app reaching ANOTHER app’s namespace', () => {
    expect(classifyMiniAppRequest(serveRef, '/api/mini-apps/other-app/storage/secret')).toEqual({ blocked: true, appId: APP })
  })

  it('ignores malformed referers', () => {
    expect(classifyMiniAppRequest('not a url', '/api/contacts')).toEqual({ blocked: false })
  })

  it('only matches serve/static referers, not arbitrary mini-app paths', () => {
    // A referer pointing at a non-serve/static mini-app path doesn't trigger the guard.
    expect(classifyMiniAppRequest(`https://host.example/api/mini-apps/${APP}/files/x`, '/api/contacts')).toEqual({ blocked: false })
  })
})
