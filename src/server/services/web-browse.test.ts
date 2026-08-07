import { describe, it, expect, mock, afterEach, afterAll } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'

// Mock config before importing the module
mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    webBrowsing: {
      ...fullMockConfig.webBrowsing,
      blockedDomains: ['blocked.example.com'],
      maxConcurrentFetches: 3,
      maxContentLength: 50000,
      pageTimeout: 10000,
      userAgent: 'TestBot/1.0',
    },
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

import { isBlockedUrl, extractContent, extractLinksFromHtml } from './web-browse'
import type { ExtractMode } from '@/server/services/web-browse'

// The guard now fails CLOSED on DNS errors/timeouts, so tests stub the
// resolver to a public address for determinism (no network in CI).
const originalDnsLookup = Bun.dns.lookup
;(Bun.dns as { lookup: unknown }).lookup = async () => [{ address: '93.184.216.34', family: 4 }]
afterAll(() => {
  ;(Bun.dns as { lookup: unknown }).lookup = originalDnsLookup
})

// ─── isBlockedUrl ───────────────────────────────────────────────────────────

describe('isBlockedUrl', () => {
  it('blocks invalid URLs', async () => {
    const result = await isBlockedUrl('not a url')
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('Invalid URL')
  })

  it('blocks non-http schemes', async () => {
    const ftp = await isBlockedUrl('ftp://example.com/file')
    expect(ftp.blocked).toBe(true)
    expect(ftp.reason).toContain('not allowed')

    const file = await isBlockedUrl('file:///etc/passwd')
    expect(file.blocked).toBe(true)

    const data = await isBlockedUrl('data:text/html,<h1>hi</h1>')
    expect(data.blocked).toBe(true)
  })

  it('blocks localhost variants', async () => {
    // 'localhost' is blocked by name; IP-literal loopback forms (including
    // decimal and hex encodings) are normalized and blocked by range.
    for (const host of ['localhost', '127.0.0.1', '[::1]', '127.1', '2130706433', '0x7f000001', '[::ffff:127.0.0.1]']) {
      const result = await isBlockedUrl(`http://${host}/path`)
      expect(result.blocked).toBe(true)
    }
  })

  it('blocks bare ::1 as invalid URL', async () => {
    // http://::1/path is not a valid URL (needs brackets)
    const result = await isBlockedUrl('http://::1/path')
    expect(result.blocked).toBe(true)
  })

  it('blocks cloud metadata endpoints', async () => {
    const aws = await isBlockedUrl('http://169.254.169.254/latest/meta-data/')
    expect(aws.blocked).toBe(true)
    expect(aws.reason).toContain('link-local')

    const gcp = await isBlockedUrl('http://metadata.google.internal/computeMetadata/v1/')
    expect(gcp.blocked).toBe(true)
    expect(gcp.reason).toContain('metadata')
  })

  it('allows valid http URLs', async () => {
    const result = await isBlockedUrl('https://example.com/page')
    expect(result.blocked).toBe(false)
  })

  it('allows valid http (non-TLS) URLs', async () => {
    const result = await isBlockedUrl('http://example.com/')
    expect(result.blocked).toBe(false)
  })

  it('is case-insensitive for localhost', async () => {
    const result = await isBlockedUrl('http://LOCALHOST/path')
    expect(result.blocked).toBe(true)
  })

  it('blocks javascript: scheme', async () => {
    const result = await isBlockedUrl('javascript:alert(1)')
    expect(result.blocked).toBe(true)
  })

  it('blocks configured blocked domains', async () => {
    const result = await isBlockedUrl('https://blocked.example.com/page')
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('blocked')
  })

  it('blocks subdomains of blocked domains', async () => {
    const result = await isBlockedUrl('https://sub.blocked.example.com/page')
    expect(result.blocked).toBe(true)
  })
})

// ─── extractContent ─────────────────────────────────────────────────────────

describe('extractContent', () => {
  const simpleHtml = `
    <!DOCTYPE html>
    <html>
    <head><title>Test Page</title></head>
    <body>
      <h1>Hello World</h1>
      <p>This is a test paragraph with some content.</p>
      <p>Another paragraph here.</p>
    </body>
    </html>
  `

  describe('readability mode', () => {
    it('extracts text content from HTML', () => {
      const result = extractContent(simpleHtml, 'https://example.com', 'readability')
      expect(result.content).toContain('test paragraph')
      expect(result.content).toContain('Another paragraph')
    })

    it('returns a title', () => {
      const result = extractContent(simpleHtml, 'https://example.com', 'readability')
      // Readability may extract title from <title> or <h1>
      expect(result.title).toBeTruthy()
    })

    it('handles empty body gracefully', () => {
      const html = '<html><head><title>Empty</title></head><body></body></html>'
      const result = extractContent(html, 'https://example.com', 'readability')
      // Should not throw
      expect(result).toBeDefined()
    })
  })

  describe('markdown mode', () => {
    it('converts headings to markdown', () => {
      const html = `
        <html><body>
          <h1>Title</h1>
          <h2>Section</h2>
          <h3>Subsection</h3>
          <p>Content here.</p>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('# Title')
      expect(result.content).toContain('## Section')
      expect(result.content).toContain('### Subsection')
      expect(result.content).toContain('Content here.')
    })

    it('converts list items to markdown', () => {
      const html = `
        <html><body>
          <ul>
            <li>Item one</li>
            <li>Item two</li>
          </ul>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('- Item one')
      expect(result.content).toContain('- Item two')
    })

    it('converts code blocks', () => {
      const html = `
        <html><body>
          <pre><code>const x = 42;</code></pre>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('```')
      expect(result.content).toContain('const x = 42;')
    })

    it('converts blockquotes', () => {
      const html = `
        <html><body>
          <blockquote>Famous quote here</blockquote>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('> Famous quote here')
    })

    it('removes script and style tags', () => {
      const html = `
        <html><body>
          <script>alert("evil")</script>
          <style>.hidden { display: none; }</style>
          <p>Visible content</p>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).not.toContain('alert')
      expect(result.content).not.toContain('.hidden')
      expect(result.content).toContain('Visible content')
    })

    it('removes navigation elements', () => {
      const html = `
        <html><body>
          <nav><a href="/">Home</a><a href="/about">About</a></nav>
          <p>Main content</p>
          <footer>Footer stuff</footer>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('Main content')
      // Nav and footer should be removed
      expect(result.content).not.toContain('Footer stuff')
    })

    it('extracts title from <title> tag', () => {
      const html = '<html><head><title>My Title</title></head><body><p>Text</p></body></html>'
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.title).toBe('My Title')
    })

    it('falls back to h1 for title when no <title> tag', () => {
      const html = '<html><body><h1>Heading Title</h1><p>Text</p></body></html>'
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.title).toBe('Heading Title')
    })

    it('prefers main/article content areas', () => {
      const html = `
        <html><body>
          <div class="sidebar">Sidebar junk</div>
          <main>
            <h2>Main Content</h2>
            <p>Important stuff</p>
          </main>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('Main Content')
      expect(result.content).toContain('Important stuff')
    })

    it('skips empty paragraphs', () => {
      const html = `
        <html><body>
          <p></p>
          <p>   </p>
          <p>Real content</p>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'markdown')
      expect(result.content).toContain('Real content')
    })
  })

  describe('raw mode', () => {
    it('extracts plain text from body', () => {
      const result = extractContent(simpleHtml, 'https://example.com', 'raw')
      expect(result.content).toContain('Hello World')
      expect(result.content).toContain('test paragraph')
    })

    it('removes scripts and styles', () => {
      const html = `
        <html><body>
          <script>var x = 1;</script>
          <style>body { color: red; }</style>
          <p>Visible</p>
        </body></html>
      `
      const result = extractContent(html, 'https://example.com', 'raw')
      expect(result.content).not.toContain('var x')
      expect(result.content).not.toContain('color: red')
      expect(result.content).toContain('Visible')
    })

    it('collapses whitespace', () => {
      const html = '<html><body><p>  lots   of    spaces  </p></body></html>'
      const result = extractContent(html, 'https://example.com', 'raw')
      expect(result.content).not.toContain('   ')
    })

    it('extracts title from <title> tag', () => {
      const html = '<html><head><title>Raw Title</title></head><body><p>Body</p></body></html>'
      const result = extractContent(html, 'https://example.com', 'raw')
      expect(result.title).toBe('Raw Title')
    })

    it('returns null title when none present', () => {
      const html = '<html><body><p>No title</p></body></html>'
      const result = extractContent(html, 'https://example.com', 'raw')
      expect(result.title).toBeNull()
    })

    it('removes hidden elements', () => {
      const html = '<html><body><div hidden>Secret</div><p>Visible</p></body></html>'
      const result = extractContent(html, 'https://example.com', 'raw')
      expect(result.content).not.toContain('Secret')
      expect(result.content).toContain('Visible')
    })
  })
})

// ─── extractLinksFromHtml ───────────────────────────────────────────────────

describe('extractLinksFromHtml', () => {
  const baseUrl = 'https://example.com'

  it('extracts absolute links', () => {
    const html = `
      <html><body>
        <a href="https://other.com/page">Other Page</a>
        <a href="https://example.com/about">About</a>
      </body></html>
    `
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(2)
    expect(result.links[0]!.url).toBe('https://other.com/page')
    expect(result.links[0]!.text).toBe('Other Page')
    expect(result.links[1]!.url).toBe('https://example.com/about')
  })

  it('resolves relative links against base URL', () => {
    const html = '<html><body><a href="/docs/guide">Guide</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(1)
    expect(result.links[0]!.url).toBe('https://example.com/docs/guide')
  })

  it('skips hash-only links', () => {
    const html = '<html><body><a href="#section">Jump</a><a href="/real">Real</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(1)
    expect(result.links[0]!.url).toBe('https://example.com/real')
  })

  it('skips javascript: links', () => {
    const html = '<html><body><a href="javascript:void(0)">Click</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(0)
  })

  it('skips mailto: links', () => {
    const html = '<html><body><a href="mailto:test@example.com">Email</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(0)
  })

  it('deduplicates links', () => {
    const html = `
      <html><body>
        <a href="/page">First</a>
        <a href="/page">Second</a>
        <a href="/page">Third</a>
      </body></html>
    `
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(1)
    expect(result.totalFound).toBe(1)
  })

  it('uses URL as text when link text is empty', () => {
    const html = '<html><body><a href="/page"></a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links[0]!.text).toBe('https://example.com/page')
  })

  it('applies filter pattern', () => {
    const html = `
      <html><body>
        <a href="/docs/file.pdf">PDF</a>
        <a href="/docs/page.html">HTML</a>
        <a href="/docs/other.pdf">Another PDF</a>
      </body></html>
    `
    const result = extractLinksFromHtml(html, baseUrl, '\\.pdf$')
    expect(result.links).toHaveLength(2)
    expect(result.links.every(l => l.url.endsWith('.pdf'))).toBe(true)
  })

  it('filter pattern is case-insensitive', () => {
    const html = '<html><body><a href="/doc.PDF">File</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl, '\\.pdf$')
    expect(result.links).toHaveLength(1)
  })

  it('throws on invalid filter pattern regex', () => {
    const html = '<html><body><a href="/page">Link</a></body></html>'
    expect(() => extractLinksFromHtml(html, baseUrl, '[invalid')).toThrow('Invalid filter_pattern regex')
  })

  it('respects maxResults limit', () => {
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/page${i}">Page ${i}</a>`).join('')
    const html = `<html><body>${links}</body></html>`
    const result = extractLinksFromHtml(html, baseUrl, undefined, 3)
    expect(result.links).toHaveLength(3)
    expect(result.totalFound).toBe(10)
  })

  it('returns totalFound even when limited', () => {
    const links = Array.from({ length: 5 }, (_, i) => `<a href="/p${i}">P${i}</a>`).join('')
    const html = `<html><body>${links}</body></html>`
    const result = extractLinksFromHtml(html, baseUrl, undefined, 2)
    expect(result.links).toHaveLength(2)
    expect(result.totalFound).toBe(5)
  })

  it('handles links without href attribute', () => {
    const html = '<html><body><a>No href</a><a href="/real">Real</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    expect(result.links).toHaveLength(1)
  })

  it('handles empty HTML', () => {
    const result = extractLinksFromHtml('<html><body></body></html>', baseUrl)
    expect(result.links).toHaveLength(0)
    expect(result.totalFound).toBe(0)
  })

  it('handles malformed href gracefully', () => {
    const html = '<html><body><a href="://bad">Bad</a><a href="/good">Good</a></body></html>'
    const result = extractLinksFromHtml(html, baseUrl)
    // The malformed one might resolve or be skipped - either way should not throw
    expect(result.links.length).toBeGreaterThanOrEqual(1)
  })
})
