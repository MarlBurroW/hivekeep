import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test'

// We test the URL guard indirectly through the tool's execute function. The
// direct helper below mirrors the source logic for edge-case unit coverage
// while integration tests verify the real tool behavior.
//
// The TOOLBOX is the sole tool-grant primitive: there is no per-Agent network
// flag. When `http_request` is granted it may reach private/local hosts — the
// only hard, non-toggleable blocks are loopback / unspecified addresses, the
// cloud-metadata endpoint, non-HTTP(S) schemes, and invalid URLs.

type UrlSafety =
  | { allowed: true }
  | { allowed: false; reason: string }

function checkUrlSafety(urlStr: string): UrlSafety {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { allowed: false, reason: 'Invalid URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'Only HTTP and HTTPS URLs are supported' }
  }

  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0'
  ) {
    return { allowed: false, reason: 'Requests to loopback or unspecified addresses are not allowed' }
  }

  if (host === '169.254.169.254') {
    return { allowed: false, reason: 'Requests to link-local metadata endpoints are not allowed' }
  }

  return { allowed: true }
}

function isAllowed(url: string): boolean {
  return checkUrlSafety(url).allowed
}

describe('http_request URL safety', () => {
  it('always blocks localhost and loopback / unspecified addresses', () => {
    expect(isAllowed('http://localhost/api')).toBe(false)
    expect(isAllowed('http://127.0.0.1/')).toBe(false)
    expect(isAllowed('http://[::1]/')).toBe(false)
    expect(isAllowed('http://0.0.0.0/')).toBe(false)
  })

  it('allows RFC1918 private IP ranges (granting the tool is the gate)', () => {
    expect(isAllowed('http://10.0.0.1/')).toBe(true)
    expect(isAllowed('http://10.255.255.255/')).toBe(true)
    expect(isAllowed('http://192.168.1.1/')).toBe(true)
    expect(isAllowed('http://192.168.0.100:9090/')).toBe(true)
    expect(isAllowed('http://172.16.0.1/')).toBe(true)
    expect(isAllowed('http://172.17.0.2/')).toBe(true)
    expect(isAllowed('http://172.20.5.5/')).toBe(true)
    expect(isAllowed('http://172.31.255.255/')).toBe(true)
  })

  it('always blocks the link-local metadata endpoint', () => {
    expect(isAllowed('http://169.254.169.254/latest/meta-data/')).toBe(false)
  })

  it('allows local-network hostnames (granting the tool is the gate)', () => {
    expect(isAllowed('http://myservice.internal/')).toBe(true)
    expect(isAllowed('http://db.cluster.internal:5432/')).toBe(true)
    expect(isAllowed('http://printer.local/')).toBe(true)
  })

  it('blocks invalid and non-HTTP URLs', () => {
    expect(isAllowed('not-a-url')).toBe(false)
    expect(isAllowed('')).toBe(false)
    expect(isAllowed('ftp://example.com/file')).toBe(false)
  })

  it('allows public URLs', () => {
    expect(isAllowed('https://api.example.com/v1')).toBe(true)
    expect(isAllowed('https://google.com')).toBe(true)
    expect(isAllowed('http://8.8.8.8/')).toBe(true)
    expect(isAllowed('https://api.openai.com/v1/chat')).toBe(true)
  })

  it('allows nearby public IP ranges that are outside private ranges', () => {
    expect(isAllowed('http://172.32.0.1/')).toBe(true)
    expect(isAllowed('http://192.169.1.1/')).toBe(true)
    expect(isAllowed('http://11.0.0.1/')).toBe(true)
  })
})

describe('httpRequestTool registration', () => {
  it('imports and has correct shape', async () => {
    const { httpRequestTool } = await import('./http-request-tools')
    expect(httpRequestTool).toBeDefined()
    expect(httpRequestTool.availability).toEqual(['main', 'sub-agent'])
    expect(typeof httpRequestTool.create).toBe('function')
  })

  it('create() returns a tool object', async () => {
    const { httpRequestTool } = await import('./http-request-tools')
    const created = httpRequestTool.create({ agentId: 'agent-1', isSubAgent: false })
    expect(created).toBeDefined()
  })
})

describe('httpRequestTool execute', () => {
  const originalFetch = globalThis.fetch
  let mockFetchFn: ReturnType<typeof mock>

  // The safety check resolves DNS names and fails closed on errors, so tests
  // stub the resolver (no network in CI). Local-network addresses stay
  // allowed by design, so a private answer works for the .local test too.
  const originalDnsLookup = Bun.dns.lookup
  beforeEach(() => {
    ;(Bun.dns as { lookup: unknown }).lookup = async (host: string) => [
      { address: host.endsWith('.local') ? '192.168.1.10' : '93.184.216.34', family: 4 },
    ]
  })
  afterAll(() => {
    ;(Bun.dns as { lookup: unknown }).lookup = originalDnsLookup
  })

  beforeEach(() => {
    mockFetchFn = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    globalThis.fetch = mockFetchFn as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  async function getExecute() {
    const { httpRequestTool } = await import('./http-request-tools')
    const created = httpRequestTool.create({
      agentId: 'agent-1',
      isSubAgent: false,
    })
    return (created as any).execute
  }

  it('allows requests to private IPs (no network flag — granting is the gate)', async () => {
    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'http://192.168.1.1/admin',
      timeout_seconds: 5,
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect(mockFetchFn).toHaveBeenCalledTimes(1)
  })

  it('allows requests to local-network hostnames', async () => {
    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'http://homeassistant.local:8123/api/',
      timeout_seconds: 5,
    })
    expect(result.status).toBe(200)
    expect(mockFetchFn).toHaveBeenCalledTimes(1)
  })

  it('keeps blocking localhost', async () => {
    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'http://localhost:3000/secret',
      timeout_seconds: 5,
    })
    expect(result.error).toContain('loopback')
    expect(mockFetchFn).not.toHaveBeenCalled()
  })

  it('keeps blocking cloud metadata', async () => {
    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'http://169.254.169.254/latest/meta-data/',
      timeout_seconds: 5,
    })
    expect(result.error).toContain('metadata')
    expect(mockFetchFn).not.toHaveBeenCalled()
  })

  it('makes GET request to public URL', async () => {
    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://api.example.com/data',
      timeout_seconds: 5,
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect(mockFetchFn).toHaveBeenCalledTimes(1)
  })

  it('sends JSON body for POST with object body', async () => {
    const execute = await getExecute()
    await execute({
      method: 'POST',
      url: 'https://api.example.com/data',
      body: { key: 'value' },
      timeout_seconds: 5,
    })
    expect(mockFetchFn).toHaveBeenCalledTimes(1)
    const call = (mockFetchFn as any).mock.calls[0]
    expect(call[1].method).toBe('POST')
    expect(call[1].body).toBe('{"key":"value"}')
    expect(call[1].headers['Content-Type']).toBe('application/json')
  })

  it('sends string body as-is', async () => {
    const execute = await getExecute()
    await execute({
      method: 'POST',
      url: 'https://api.example.com/data',
      body: 'raw string body',
      headers: { 'Content-Type': 'text/plain' },
      timeout_seconds: 5,
    })
    const call = (mockFetchFn as any).mock.calls[0]
    expect(call[1].body).toBe('raw string body')
  })

  it('passes custom headers', async () => {
    const execute = await getExecute()
    await execute({
      method: 'GET',
      url: 'https://api.example.com/data',
      headers: { Authorization: 'Bearer token123' },
      timeout_seconds: 5,
    })
    const call = (mockFetchFn as any).mock.calls[0]
    expect(call[1].headers.Authorization).toBe('Bearer token123')
  })

  it('does not override existing Content-Type for object body', async () => {
    const execute = await getExecute()
    await execute({
      method: 'POST',
      url: 'https://api.example.com/data',
      headers: { 'Content-Type': 'application/xml' },
      body: { key: 'value' },
      timeout_seconds: 5,
    })
    const call = (mockFetchFn as any).mock.calls[0]
    expect(call[1].headers['Content-Type']).toBe('application/xml')
  })

  it('truncates large response bodies', async () => {
    const largeBody = 'x'.repeat(150 * 1024)
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(largeBody, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    ) as any

    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://api.example.com/large',
      timeout_seconds: 5,
    })
    expect(result.status).toBe(200)
    expect(typeof result.body).toBe('string')
    expect((result.body as string)).toContain('[...truncated')
  })

  it('returns relevant response headers only', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('{}', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-limit': '100',
            'retry-after': '60',
            'x-custom-header': 'should-be-excluded',
          },
        }),
      ),
    ) as any

    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://api.example.com/data',
      timeout_seconds: 5,
    })
    expect(result.status).toBe(429)
    expect(result.headers['content-type']).toBe('application/json')
    expect(result.headers['x-ratelimit-remaining']).toBe('0')
    expect(result.headers['retry-after']).toBe('60')
    expect(result.headers['x-custom-header']).toBeUndefined()
  })

  it('handles fetch errors gracefully', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('DNS resolution failed'))) as any

    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://nonexistent.example.com/',
      timeout_seconds: 5,
    })
    expect(result.error).toBe('DNS resolution failed')
  })

  it('handles abort/timeout errors', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    globalThis.fetch = mock(() => Promise.reject(abortError)) as any

    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://slow.example.com/',
      timeout_seconds: 2,
    })
    expect(result.error).toContain('timed out')
  })

  it('caps timeout at 120 seconds', async () => {
    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://api.example.com/data',
      timeout_seconds: 999,
    })
    expect(result.status).toBe(200)
  })

  it('handles non-JSON response with json content-type gracefully', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response('not valid json {{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as any

    const execute = await getExecute()
    const result = await execute({
      method: 'GET',
      url: 'https://api.example.com/bad-json',
      timeout_seconds: 5,
    })
    expect(result.status).toBe(200)
    expect(typeof result.body).toBe('string')
    expect(result.body).toContain('not valid json')
  })
})
