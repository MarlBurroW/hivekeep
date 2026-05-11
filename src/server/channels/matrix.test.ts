import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

// ─── Mock dependencies before importing the module ─────────────────────────

mock.module('@/server/services/vault', () => ({
  getSecretValue: async (key: string) => {
    if (key === 'valid-token-key') return 'syt_test_token_123'
    if (key === 'empty-key') return null
    return null
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// We need to import the module to access the class and to test splitMessage.
// splitMessage is not exported, so we test it indirectly through sendMessage behavior,
// and also directly by re-implementing the logic check.

import { MatrixAdapter } from '@/server/channels/matrix'

// ─── Helpers ────────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = handler as typeof fetch
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MatrixAdapter', () => {
  let adapter: MatrixAdapter

  beforeEach(() => {
    adapter = new MatrixAdapter()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('has platform set to "matrix"', () => {
    expect(adapter.platform).toBe('matrix')
  })

  // ─── validateConfig ─────────────────────────────────────────────────────

  describe('validateConfig', () => {
    it('returns valid when whoami succeeds', async () => {
      mockFetch(async (url) => {
        if (url.includes('/account/whoami')) {
          return jsonResponse({ user_id: '@bot:matrix.org' })
        }
        return new Response('Not found', { status: 404 })
      })

      const result = await adapter.validateConfig({
        accessTokenVaultKey: 'valid-token-key',
        homeserverUrl: 'https://matrix.example.com',
      })

      expect(result).toEqual({ valid: true })
    })

    it('returns invalid when vault key not found', async () => {
      const result = await adapter.validateConfig({
        accessTokenVaultKey: 'nonexistent-key',
        homeserverUrl: 'https://matrix.example.com',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('returns invalid when homeserverUrl is missing', async () => {
      const result = await adapter.validateConfig({
        accessTokenVaultKey: 'valid-token-key',
        homeserverUrl: '',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toContain('homeserverUrl')
    })

    it('returns invalid when API returns error', async () => {
      mockFetch(async () => {
        return new Response('{"errcode":"M_UNKNOWN_TOKEN"}', { status: 401, headers: { 'Content-Type': 'text/plain' } })
      })

      const result = await adapter.validateConfig({
        accessTokenVaultKey: 'valid-token-key',
        homeserverUrl: 'https://matrix.example.com',
      })

      expect(result.valid).toBe(false)
      expect(result.error).toContain('401')
    })
  })

  // ─── getBotInfo ─────────────────────────────────────────────────────────

  describe('getBotInfo', () => {
    it('returns bot name and username from whoami + profile', async () => {
      mockFetch(async (url) => {
        if (url.includes('/account/whoami')) {
          return jsonResponse({ user_id: '@mybot:matrix.org' })
        }
        if (url.includes('/profile/')) {
          return jsonResponse({ displayname: 'My Bot' })
        }
        return new Response('Not found', { status: 404 })
      })

      const info = await adapter.getBotInfo({
        accessTokenVaultKey: 'valid-token-key',
        homeserverUrl: 'https://matrix.example.com',
      })

      expect(info).toEqual({ name: 'My Bot', username: '@mybot:matrix.org' })
    })

    it('falls back to user_id when profile fails', async () => {
      mockFetch(async (url) => {
        if (url.includes('/account/whoami')) {
          return jsonResponse({ user_id: '@mybot:matrix.org' })
        }
        if (url.includes('/profile/')) {
          return new Response('Not found', { status: 404 })
        }
        return new Response('Not found', { status: 404 })
      })

      const info = await adapter.getBotInfo({
        accessTokenVaultKey: 'valid-token-key',
        homeserverUrl: 'https://matrix.example.com',
      })

      expect(info).toEqual({ name: '@mybot:matrix.org', username: '@mybot:matrix.org' })
    })

    it('returns null when vault key is missing', async () => {
      const info = await adapter.getBotInfo({
        accessTokenVaultKey: 'nonexistent-key',
        homeserverUrl: 'https://matrix.example.com',
      })

      expect(info).toBeNull()
    })
  })

  // ─── sendMessage ────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('sends a simple message and returns event_id', async () => {
      const sentRequests: { url: string; body: unknown }[] = []

      mockFetch(async (url, init) => {
        sentRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
        return jsonResponse({ event_id: '$event123' })
      })

      const result = await adapter.sendMessage(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        { chatId: '!room:matrix.org', content: 'Hello world' },
      )

      expect(result.platformMessageId).toBe('$event123')
      expect(sentRequests).toHaveLength(1)
      expect(sentRequests[0]!.body).toMatchObject({ msgtype: 'm.text', body: 'Hello world' })
    })

    it('includes reply threading when replyToMessageId is provided', async () => {
      const sentRequests: { url: string; body: unknown }[] = []

      mockFetch(async (url, init) => {
        sentRequests.push({ url, body: init?.body ? JSON.parse(init.body as string) : null })
        return jsonResponse({ event_id: '$reply456' })
      })

      const result = await adapter.sendMessage(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        { chatId: '!room:matrix.org', content: 'Reply text', replyToMessageId: '$original789' },
      )

      expect(result.platformMessageId).toBe('$reply456')
      const body = sentRequests[0]!.body as Record<string, unknown>
      expect(body.msgtype).toBe('m.text')
      expect(body.body).toBe('Reply text')
      const relates = body['m.relates_to'] as Record<string, unknown>
      expect(relates).toBeDefined()
      const inReplyTo = relates['m.in_reply_to'] as Record<string, unknown>
      expect(inReplyTo.event_id).toBe('$original789')
    })

    it('splits long messages into chunks', async () => {
      const sentRequests: { body: unknown }[] = []

      mockFetch(async (_url, init) => {
        sentRequests.push({ body: init?.body ? JSON.parse(init.body as string) : null })
        return jsonResponse({ event_id: `$evt${sentRequests.length}` })
      })

      // Create a message longer than 4096 chars
      const longContent = 'A'.repeat(4096) + '\n\n' + 'B'.repeat(100)

      const result = await adapter.sendMessage(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        { chatId: '!room:matrix.org', content: longContent },
      )

      // Should have sent 2 chunks
      expect(sentRequests.length).toBe(2)
      // Returns the last event_id
      expect(result.platformMessageId).toBe('$evt2')
    })

    it('only adds reply threading to the first chunk', async () => {
      const sentBodies: Record<string, unknown>[] = []

      mockFetch(async (_url, init) => {
        const body = init?.body ? JSON.parse(init.body as string) : {}
        sentBodies.push(body)
        return jsonResponse({ event_id: `$e${sentBodies.length}` })
      })

      // Build content that definitely exceeds 4096: two blocks separated by \n\n
      const block1 = 'A'.repeat(4000)
      const block2 = 'B'.repeat(4000)
      const longContent = block1 + '\n\n' + block2

      await adapter.sendMessage(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        { chatId: '!room:matrix.org', content: longContent, replyToMessageId: '$orig' },
      )

      expect(sentBodies.length).toBeGreaterThanOrEqual(2)

      // First chunk has reply (use bracket notation — key contains a dot)
      expect('m.relates_to' in sentBodies[0]!).toBe(true)
      // Second chunk does NOT
      expect('m.relates_to' in sentBodies[1]!).toBe(false)
    })

    it('strips trailing slashes from homeserver URL', async () => {
      let capturedUrl = ''

      mockFetch(async (url) => {
        capturedUrl = url
        return jsonResponse({ event_id: '$e1' })
      })

      await adapter.sendMessage(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com///' },
        { chatId: '!room:matrix.org', content: 'test' },
      )

      expect(capturedUrl).toContain('https://matrix.example.com/_matrix/')
      expect(capturedUrl).not.toContain('///_matrix')
    })
  })

  // ─── sendTypingIndicator ────────────────────────────────────────────────

  describe('sendTypingIndicator', () => {
    it('sends a typing PUT request', async () => {
      const sentRequests: { url: string; method: string; body: unknown }[] = []

      mockFetch(async (url, init) => {
        sentRequests.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        })
        if (url.includes('/account/whoami')) {
          return jsonResponse({ user_id: '@bot:matrix.org' })
        }
        if (url.includes('/typing/')) {
          return jsonResponse({})
        }
        return new Response('Not found', { status: 404 })
      })

      await adapter.sendTypingIndicator(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        '!room:matrix.org',
      )

      const typingReq = sentRequests.find((r) => r.url.includes('/typing/'))
      expect(typingReq).toBeDefined()
      expect(typingReq!.method).toBe('PUT')
      expect(typingReq!.body).toMatchObject({ typing: true, timeout: 10000 })
    })

    it('does not throw when typing indicator fails', async () => {
      mockFetch(async () => {
        return new Response('Server error', { status: 500 })
      })

      // Should not throw
      await adapter.sendTypingIndicator(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        '!room:matrix.org',
      )
    })
  })

  // ─── onIdentityChange (native identity switch) ──────────────────────────

  describe('onIdentityChange', () => {
    it('declares identitySwitchMode "native"', () => {
      expect(adapter.identitySwitchMode).toBe('native')
    })

    it('PUTs the new displayname on the homeserver profile API', async () => {
      const sentRequests: { url: string; method: string; body: unknown }[] = []
      mockFetch(async (url, init) => {
        sentRequests.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null,
        })
        if (url.includes('/account/whoami')) return jsonResponse({ user_id: '@bot:matrix.org' })
        if (url.includes('/displayname')) return jsonResponse({})
        return new Response('Not found', { status: 404 })
      })

      await adapter.onIdentityChange!(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        { kinSlug: 'kube-master', kinName: 'Kube Master' },
      )

      const displaynameReq = sentRequests.find((r) => r.url.includes('/displayname'))
      expect(displaynameReq).toBeDefined()
      expect(displaynameReq!.method).toBe('PUT')
      expect(displaynameReq!.body).toMatchObject({ displayname: 'Kube Master' })
    })

    it('uploads and points the avatar when avatarUrl is provided', async () => {
      const sentRequests: { url: string; method: string }[] = []
      mockFetch(async (url, init) => {
        sentRequests.push({ url, method: init?.method ?? 'GET' })
        if (url.includes('/account/whoami')) return jsonResponse({ user_id: '@bot:matrix.org' })
        if (url.includes('/displayname')) return jsonResponse({})
        if (url.startsWith('https://kinbot.example.com/api/uploads/')) {
          return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
        }
        if (url.includes('/_matrix/media/v3/upload')) {
          return jsonResponse({ content_uri: 'mxc://matrix.example.com/abc123' })
        }
        if (url.includes('/avatar_url')) return jsonResponse({})
        return new Response('Not found', { status: 404 })
      })

      await adapter.onIdentityChange!(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        {
          kinSlug: 'kube-master',
          kinName: 'Kube Master',
          avatarUrl: 'https://kinbot.example.com/api/uploads/kins/abc/avatar.png',
        },
      )

      // Avatar was uploaded then pointed at
      expect(sentRequests.some((r) => r.url.includes('/_matrix/media/v3/upload') && r.method === 'POST')).toBe(true)
      expect(sentRequests.some((r) => r.url.includes('/avatar_url') && r.method === 'PUT')).toBe(true)
    })

    it('does not throw when avatar fetch fails (display name still updated)', async () => {
      const sentRequests: { url: string; method: string }[] = []
      mockFetch(async (url, init) => {
        sentRequests.push({ url, method: init?.method ?? 'GET' })
        if (url.includes('/account/whoami')) return jsonResponse({ user_id: '@bot:matrix.org' })
        if (url.includes('/displayname')) return jsonResponse({})
        if (url.startsWith('https://broken/')) return new Response('not found', { status: 404 })
        if (url.includes('/avatar_url')) return jsonResponse({})
        return new Response('Not found', { status: 404 })
      })

      // Should not throw
      await adapter.onIdentityChange!(
        'ch1',
        { accessTokenVaultKey: 'valid-token-key', homeserverUrl: 'https://matrix.example.com' },
        { kinSlug: 'kube-master', kinName: 'Kube Master', avatarUrl: 'https://broken/avatar.png' },
      )

      // Display name was still updated, avatar_url was NOT (fetch failed)
      expect(sentRequests.some((r) => r.url.includes('/displayname') && r.method === 'PUT')).toBe(true)
      expect(sentRequests.some((r) => r.url.includes('/avatar_url'))).toBe(false)
    })
  })

  // ─── start / stop lifecycle ─────────────────────────────────────────────

  describe('start', () => {
    it('identifies the bot and starts sync loop', async () => {
      let syncCalled = false

      mockFetch(async (url) => {
        if (url.includes('/account/whoami')) {
          return jsonResponse({ user_id: '@bot:matrix.org' })
        }
        if (url.includes('/sync')) {
          syncCalled = true
          // Return a response that won't loop forever — abort will stop it
          await new Promise((r) => setTimeout(r, 50))
          return jsonResponse({ next_batch: 'batch1', rooms: {} })
        }
        return new Response('Not found', { status: 404 })
      })

      const onMessage = async () => {}

      await adapter.start('ch1', {
        accessTokenVaultKey: 'valid-token-key',
        homeserverUrl: 'https://matrix.example.com',
      }, onMessage)

      // Give sync loop a tick to start
      await new Promise((r) => setTimeout(r, 100))

      expect(syncCalled).toBe(true)

      // Clean up
      await adapter.stop('ch1')
    })

    it('throws when whoami fails', async () => {
      mockFetch(async () => {
        return new Response('Unauthorized', { status: 401 })
      })

      await expect(
        adapter.start('ch1', {
          accessTokenVaultKey: 'valid-token-key',
          homeserverUrl: 'https://matrix.example.com',
        }, async () => {}),
      ).rejects.toThrow()
    })
  })

  describe('stop', () => {
    it('can be called safely even if not started', async () => {
      // Should not throw
      await adapter.stop('nonexistent-channel')
    })
  })
})
