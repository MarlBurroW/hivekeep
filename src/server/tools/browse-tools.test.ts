import { describe, it, expect, beforeEach, mock, afterAll } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'
import type { ToolRegistration } from '@/server/tools/types'

// The SSRF guard resolves DNS and fails closed, so stub the resolver to a
// public address for determinism (no network in CI).
const originalDnsLookup = Bun.dns.lookup
;(Bun.dns as { lookup: unknown }).lookup = async () => [{ address: '93.184.216.34', family: 4 }]
afterAll(() => {
  ;(Bun.dns as { lookup: unknown }).lookup = originalDnsLookup
})

// ─── Mocks ───────────────────────────────────────────────────────────────────
// We avoid mock.module('@/server/services/web-browse') to prevent poisoning
// web-browse.test.ts (Bun's mock.module has global scope). Instead we mock
// only non-shared modules and let web-browse run with mocked config/logger.

const mockBrowseWithBrowser = mock(() =>
  Promise.resolve({
    url: 'https://example.com',
    title: 'Browser Title',
    html: '<html><body>JS rendered</body></html>',
  }),
)
const mockScreenshotPage = mock(() =>
  Promise.resolve({
    buffer: Buffer.from('fake-png'),
    width: 1280,
    height: 720,
  }),
)

mock.module('@/server/services/playwright-manager', () => ({
  playwrightManager: {
    browseWithBrowser: mockBrowseWithBrowser,
    screenshotPage: mockScreenshotPage,
  },
}))

const mockCreateFileFromContent = mock(() =>
  Promise.resolve({
    id: 'file-1',
    name: 'screenshot.png',
    url: '/api/files/file-1',
  }),
)

mock.module('@/server/services/file-storage', () => ({
  readStoredFile: mock(() => Promise.resolve(null)),
  createFileFromContent: mockCreateFileFromContent,
  createFileFromWorkspace: mock(() => Promise.resolve(null)),
  createFileFromUrl: mock(() => Promise.resolve(null)),
  getFileById: mock(() => Promise.resolve(null)),
  getFileByName: mock(() => Promise.resolve(null)),
  getFileByToken: mock(() => Promise.resolve(null)),
  listFiles: mock(() => Promise.resolve([])),
  searchFiles: mock(() => Promise.resolve([])),
  updateFile: mock(() => Promise.resolve(null)),
  deleteFile: mock(() => Promise.resolve(false)),
  buildShareUrl: mock((token: string) => `https://example.com/s/${token}`),
  downloadFile: mock(() => Promise.resolve(null)),
  cleanExpiredFiles: mock(() => Promise.resolve()),
}))

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    webBrowsing: {
      ...fullMockConfig.webBrowsing,
      blockedDomains: [],
      maxConcurrentFetches: 3,
      maxContentLength: 100000,
      pageTimeout: 10000,
      userAgent: 'TestBot/1.0',
    },
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

// Import after mocks — web-browse is NOT mocked, so its real code runs.
const { browseUrlTool, extractLinksTool, screenshotUrlTool } =
  await import('@/server/tools/browse-tools')

// ─── Helpers ────────────────────────────────────────────────────────────────

const ctx = { agentId: 'agent-test-123' } as any
const opts = { toolCallId: 'x', messages: [] as any[], abortSignal: undefined as any }

function createTool(reg: ToolRegistration) {
  const tool = reg.create(ctx)
  if (!tool.execute) throw new Error('Tool has no execute method')
  return tool as typeof tool & { execute: NonNullable<typeof tool.execute> }
}

// ─── browseUrlTool ──────────────────────────────────────────────────────────

describe('browseUrlTool', () => {
  beforeEach(() => {
    mockBrowseWithBrowser.mockClear()
  })

  it('has correct availability', () => {
    expect(browseUrlTool.availability).toEqual(['main', 'sub-agent'])
  })

  it('uses headless browser when wait_for_js is true', async () => {
    const t = createTool(browseUrlTool)
    await t.execute({ url: 'https://example.com', wait_for_js: true }, opts)
    expect(mockBrowseWithBrowser).toHaveBeenCalled()
  })

  it('checks blocked URL when wait_for_js is true', async () => {
    const t = createTool(browseUrlTool)
    const result = await t.execute({ url: 'https://localhost/secret', wait_for_js: true }, opts)
    expect(result).toHaveProperty('error')
    expect((result as any).error).toContain('blocked')
  })

  it('returns error on browseUrl failure', async () => {
    // Use a URL that can't be fetched (non-routable IP)
    const t = createTool(browseUrlTool)
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => Promise.reject(new Error('fetch failed'))) as any
    try {
      const result = await t.execute({ url: 'https://example.com' }, opts)
      expect(result).toHaveProperty('error')
      expect((result as any).error).toContain('fetch failed')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error string for non-Error throws', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => Promise.reject('string error')) as any
    try {
      const t = createTool(browseUrlTool)
      const result = await t.execute({ url: 'https://example.com' }, opts)
      expect(result).toHaveProperty('error')
      expect((result as any).error).toContain('string error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error on headless browser failure', async () => {
    mockBrowseWithBrowser.mockImplementationOnce(() => Promise.reject(new Error('browser crashed')))
    const t = createTool(browseUrlTool)
    const result = await t.execute({ url: 'https://example.com', wait_for_js: true }, opts)
    expect(result).toHaveProperty('error')
    expect((result as any).error).toContain('browser crashed')
  })

  it('truncates content to maxContentLength in browser mode', async () => {
    const longHtml = '<html><body>' + 'x'.repeat(200000) + '</body></html>'
    mockBrowseWithBrowser.mockImplementationOnce(() =>
      Promise.resolve({ url: 'https://example.com', title: 'Long', html: longHtml }),
    )
    const t = createTool(browseUrlTool)
    const result = await t.execute({ url: 'https://example.com', wait_for_js: true }, opts)
    const resultStr = JSON.stringify(result)
    expect(resultStr.length).toBeLessThanOrEqual(200000)
  })

  it('uses extracted title and falls back to browser title', async () => {
    mockBrowseWithBrowser.mockImplementationOnce(() =>
      Promise.resolve({ url: 'https://example.com', title: 'Browser Title', html: '<html></html>' }),
    )
    const t = createTool(browseUrlTool)
    const result = await t.execute({ url: 'https://example.com', wait_for_js: true }, opts)
    const resultStr = JSON.stringify(result)
    expect(resultStr).toContain('Browser Title')
  })
})

// ─── extractLinksTool ───────────────────────────────────────────────────────

describe('extractLinksTool', () => {
  it('has correct availability', () => {
    expect(extractLinksTool.availability).toEqual(['main', 'sub-agent'])
  })

  it('calls extractLinks with url and defaults', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('<html><body><a href="/a">A</a></body></html>', {
        headers: { 'content-type': 'text/html' },
      })),
    ) as any
    try {
      const t = createTool(extractLinksTool)
      const result = await t.execute({ url: 'https://example.com' }, opts)
      expect(result).toHaveProperty('url')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error on failure', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(() => Promise.reject(new Error('link fail'))) as any
    try {
      const t = createTool(extractLinksTool)
      const result = await t.execute({ url: 'https://example.com' }, opts)
      expect(result).toHaveProperty('error')
      expect((result as any).error).toContain('link fail')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── screenshotUrlTool ──────────────────────────────────────────────────────

describe('screenshotUrlTool', () => {
  beforeEach(() => {
    mockScreenshotPage.mockClear()
    mockCreateFileFromContent.mockClear()
  })

  it('has correct availability (main only)', () => {
    expect(screenshotUrlTool.availability).toEqual(['main'])
  })

  it('takes a screenshot and stores it as a file', async () => {
    const t = createTool(screenshotUrlTool)
    const result = await t.execute({ url: 'https://example.com' }, opts)
    expect(mockScreenshotPage).toHaveBeenCalled()
    expect(mockCreateFileFromContent).toHaveBeenCalled()
    const resultStr = JSON.stringify(result)
    expect(resultStr).toContain('file-1')
  })

  it('passes viewport dimensions and fullPage', async () => {
    const t = createTool(screenshotUrlTool)
    await t.execute({ url: 'https://example.com', viewport_width: 800, viewport_height: 600, full_page: true }, opts)
    expect(mockScreenshotPage).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ width: 800, height: 600, fullPage: true }),
    )
  })

  it('blocks screenshot of blocked URLs', async () => {
    const t = createTool(screenshotUrlTool)
    const result = await t.execute({ url: 'https://localhost/secret' }, opts)
    expect(result).toHaveProperty('error')
    expect((result as any).error).toContain('blocked')
    expect(mockScreenshotPage).not.toHaveBeenCalled()
  })

  it('returns error on screenshot failure', async () => {
    mockScreenshotPage.mockImplementationOnce(() => Promise.reject(new Error('screenshot fail')))
    const t = createTool(screenshotUrlTool)
    const result = await t.execute({ url: 'https://example.com' }, opts)
    expect(result).toHaveProperty('error')
    expect((result as any).error).toContain('screenshot fail')
  })

  it('returns error on file storage failure', async () => {
    mockCreateFileFromContent.mockImplementationOnce(() => Promise.reject(new Error('storage fail')))
    const t = createTool(screenshotUrlTool)
    const result = await t.execute({ url: 'https://example.com' }, opts)
    expect(result).toHaveProperty('error')
    expect((result as any).error).toContain('storage fail')
  })

  it('sanitizes hostname for filename', async () => {
    const t = createTool(screenshotUrlTool)
    await t.execute({ url: 'https://my-site.example.com/path' }, opts)
    const call = mockCreateFileFromContent.mock.calls[0] as unknown as any[]
    // createFileFromContent(agentId, name, content, mimeType, options)
    expect(call[1]).toContain('my-site.example.com')
  })

  it('stores file as public with correct mime type', async () => {
    const t = createTool(screenshotUrlTool)
    await t.execute({ url: 'https://example.com' }, opts)
    const call = mockCreateFileFromContent.mock.calls[0] as unknown as any[]
    // createFileFromContent(agentId, name, content, mimeType, options)
    expect(call[3]).toBe('image/png')
    expect(call[4]).toHaveProperty('isPublic', true)
  })
})
