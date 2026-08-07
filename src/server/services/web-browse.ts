import * as cheerio from 'cheerio'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { config } from '@/server/config'
import { normalizeIpLiteral, isPrivateIp } from '@/server/services/ip-guard'
import { createLogger } from '@/server/logger'

const log = createLogger('web-browse')

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrowseResult {
  url: string
  title: string | null
  content: string
  contentLength: number
  extractMode: string
  fetchTimeMs: number
}

export interface LinkResult {
  text: string
  url: string
}

export type ExtractMode = 'readability' | 'markdown' | 'raw'

// ─── SSRF Protection ────────────────────────────────────────────────────────

export async function isBlockedUrl(url: string): Promise<{ blocked: boolean; reason?: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { blocked: true, reason: 'Invalid URL' }
  }

  // Only allow http(s)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { blocked: true, reason: `Scheme "${parsed.protocol}" not allowed. Only http and https are supported.` }
  }

  const hostname = parsed.hostname.toLowerCase()

  // Block localhost + cloud metadata by name
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
    return { blocked: true, reason: 'Requests to localhost or cloud metadata endpoints are blocked' }
  }

  // IP-literal hostnames (any form: dotted, decimal, hex, bracketed v6) are
  // validated without DNS. String comparisons alone are bypassable —
  // `http://2130706433/` is 127.0.0.1.
  const literal = normalizeIpLiteral(hostname)
  if (literal) {
    if (isPrivateIp(literal)) {
      return { blocked: true, reason: `IP ${literal} is in a private, loopback, or link-local range` }
    }
  }

  // Check configured blocked domains
  const { blockedDomains } = config.webBrowsing
  if (blockedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) {
    return { blocked: true, reason: `Domain "${hostname}" is blocked by configuration` }
  }

  // DNS resolution to catch private IPs behind hostnames. Fails CLOSED: a
  // resolver error or timeout blocks the request — failing open turns any
  // unresolvable-then-resolvable name (or a stalled resolver) into an SSRF
  // bypass.
  if (!literal) {
    try {
      const lookupPromise = Bun.dns.lookup(hostname, { family: 0 })
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
      const results = await Promise.race([lookupPromise, timeoutPromise])
      if (!results) {
        log.warn({ hostname }, 'DNS lookup timed out during SSRF check — blocking request')
        return { blocked: true, reason: `DNS lookup for "${hostname}" timed out` }
      }
      for (const record of results) {
        if (isPrivateIp(record.address)) {
          return { blocked: true, reason: `Domain "${hostname}" resolves to private IP ${record.address}` }
        }
      }
    } catch {
      log.warn({ hostname }, 'DNS lookup failed during SSRF check — blocking request')
      return { blocked: true, reason: `DNS lookup for "${hostname}" failed` }
    }
  }

  return { blocked: false }
}

// ─── Concurrency Semaphore ──────────────────────────────────────────────────

let activeFetches = 0
const waitQueue: Array<() => void> = []

async function acquireSemaphore(): Promise<void> {
  if (activeFetches < config.webBrowsing.maxConcurrentFetches) {
    activeFetches++
    return
  }
  await new Promise<void>((resolve) => waitQueue.push(resolve))
  activeFetches++
}

function releaseSemaphore(): void {
  activeFetches--
  const next = waitQueue.shift()
  if (next) next()
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

const MAX_REDIRECT_HOPS = 5

async function fetchPage(url: string): Promise<{ html: string; finalUrl: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.webBrowsing.pageTimeout)

  try {
    const fetchOptions: RequestInit = {
      signal: controller.signal,
      headers: {
        'User-Agent': config.webBrowsing.userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
      },
      // Redirects are followed manually so every hop re-passes the SSRF
      // check — with 'follow', an allowed public URL can 302 straight into
      // 169.254.169.254 or an internal service.
      redirect: 'manual',
    }

    let currentUrl = url
    let response: Response
    for (let hop = 0; ; hop++) {
      response = await fetch(currentUrl, fetchOptions)
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('location')
      if (!location) break
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new Error(`Too many redirects (more than ${MAX_REDIRECT_HOPS})`)
      }
      const nextUrl = new URL(location, currentUrl).toString()
      const blocked = await isBlockedUrl(nextUrl)
      if (blocked.blocked) {
        throw new Error(`Redirect target blocked: ${blocked.reason}`)
      }
      currentUrl = nextUrl
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    // Verify content type is HTML-like
    const contentType = response.headers.get('content-type') ?? ''
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('application/xhtml') &&
      !contentType.includes('text/plain')
    ) {
      throw new Error(`Unsupported content type: ${contentType}. Expected HTML.`)
    }

    let html = await response.text()
    if (html.length > config.webBrowsing.maxContentLength * 2) {
      // Truncate raw HTML before parsing to avoid memory issues
      html = html.slice(0, config.webBrowsing.maxContentLength * 2)
    }

    return { html, finalUrl: response.url }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Content Extractors ─────────────────────────────────────────────────────

/**
 * Extract content from raw HTML using the specified mode.
 * Exported for use by the headless browser path.
 */
export function extractContent(
  html: string,
  url: string,
  mode: ExtractMode,
): { title: string | null; content: string } {
  switch (mode) {
    case 'readability':
      return extractReadability(html, url)
    case 'markdown':
      return extractMarkdown(html, url)
    case 'raw':
      return extractRawInternal(html)
  }
}

function extractReadability(html: string, url: string): { title: string | null; content: string } {
  const { document } = parseHTML(html)
  const reader = new Readability(document as unknown as Document, { charThreshold: 50 })
  const article = reader.parse()

  if (!article) {
    // Fallback to raw extraction if Readability can't parse
    return extractRawInternal(html)
  }

  return {
    title: article.title || null,
    content: (article.textContent ?? '').trim(),
  }
}

function extractMarkdown(html: string, url: string): { title: string | null; content: string } {
  const $ = cheerio.load(html)

  // Remove non-content elements
  $('script, style, nav, footer, header, aside, .sidebar, .nav, .menu, .ad, .advertisement, [role="navigation"]').remove()

  const title = $('title').first().text().trim() || $('h1').first().text().trim() || null
  const parts: string[] = []

  // Process main content areas first, fall back to body
  const mainContent = $('main, article, [role="main"], .content, .post, .entry').first()
  const root = mainContent.length ? mainContent : $('body')

  root.find('h1, h2, h3, h4, h5, h6, p, li, pre, code, blockquote, table, tr, th, td, a, img').each((_, el) => {
    const $el = $(el)
    const tag = el.type === 'tag' ? el.name : ''

    switch (tag) {
      case 'h1':
        parts.push(`\n# ${$el.text().trim()}\n`)
        break
      case 'h2':
        parts.push(`\n## ${$el.text().trim()}\n`)
        break
      case 'h3':
        parts.push(`\n### ${$el.text().trim()}\n`)
        break
      case 'h4':
      case 'h5':
      case 'h6':
        parts.push(`\n#### ${$el.text().trim()}\n`)
        break
      case 'p': {
        const text = $el.text().trim()
        if (text) parts.push(`${text}\n`)
        break
      }
      case 'li': {
        const text = $el.text().trim()
        if (text) parts.push(`- ${text}`)
        break
      }
      case 'pre':
      case 'code': {
        if (tag === 'pre' || !$el.parent('pre').length) {
          const code = $el.text().trim()
          if (code) parts.push(`\n\`\`\`\n${code}\n\`\`\`\n`)
        }
        break
      }
      case 'blockquote': {
        const text = $el.text().trim()
        if (text) parts.push(`> ${text}\n`)
        break
      }
      default:
        break
    }
  })

  let content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (content.length > config.webBrowsing.maxContentLength) {
    content = content.slice(0, config.webBrowsing.maxContentLength)
  }

  return { title, content }
}

function extractRawInternal(html: string): { title: string | null; content: string } {
  const $ = cheerio.load(html)

  // Remove non-content elements
  $('script, style, nav, footer, header, aside, noscript, svg, [hidden]').remove()

  const title = $('title').first().text().trim() || null
  let content = $('body').text().replace(/\s+/g, ' ').trim()

  if (content.length > config.webBrowsing.maxContentLength) {
    content = content.slice(0, config.webBrowsing.maxContentLength)
  }

  return { title, content }
}

// ─── Link Extraction ────────────────────────────────────────────────────────

export function extractLinksFromHtml(
  html: string,
  baseUrl: string,
  filterPattern?: string,
  maxResults = 50,
): { links: LinkResult[]; totalFound: number } {
  const $ = cheerio.load(html)
  const allLinks: LinkResult[] = []
  const seen = new Set<string>()

  let filterRe: RegExp | null = null
  if (filterPattern) {
    try {
      filterRe = new RegExp(filterPattern, 'i')
    } catch {
      throw new Error(`Invalid filter_pattern regex: ${filterPattern}`)
    }
  }

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const lowerHref = href.toLowerCase().trim()
    if (lowerHref.startsWith('#') || lowerHref.startsWith('javascript:') || lowerHref.startsWith('vbscript:') || lowerHref.startsWith('data:') || lowerHref.startsWith('mailto:') || lowerHref.startsWith('file:')) return

    let absoluteUrl: string
    try {
      absoluteUrl = new URL(href, baseUrl).href
    } catch {
      return
    }

    if (seen.has(absoluteUrl)) return
    seen.add(absoluteUrl)

    if (filterRe && !filterRe.test(absoluteUrl)) return

    const text = $(el).text().trim() || absoluteUrl
    allLinks.push({ text, url: absoluteUrl })
  })

  return {
    links: allLinks.slice(0, maxResults),
    totalFound: allLinks.length,
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function browseUrl(
  url: string,
  mode: ExtractMode = 'readability',
): Promise<BrowseResult> {
  const blocked = await isBlockedUrl(url)
  if (blocked.blocked) {
    throw new Error(`URL blocked: ${blocked.reason}`)
  }

  await acquireSemaphore()
  const start = Date.now()

  try {
    const { html, finalUrl } = await fetchPage(url)
    let result: { title: string | null; content: string }

    switch (mode) {
      case 'readability':
        result = extractReadability(html, finalUrl)
        break
      case 'markdown':
        result = extractMarkdown(html, finalUrl)
        break
      case 'raw':
        result = extractRawInternal(html)
        break
    }

    return {
      url: finalUrl,
      title: result.title,
      content: result.content,
      contentLength: result.content.length,
      extractMode: mode,
      fetchTimeMs: Date.now() - start,
    }
  } finally {
    releaseSemaphore()
  }
}

export async function extractLinks(
  url: string,
  filterPattern?: string,
  maxResults = 50,
): Promise<{ url: string; links: LinkResult[]; totalFound: number }> {
  const blocked = await isBlockedUrl(url)
  if (blocked.blocked) {
    throw new Error(`URL blocked: ${blocked.reason}`)
  }

  await acquireSemaphore()
  try {
    const { html, finalUrl } = await fetchPage(url)
    const { links, totalFound } = extractLinksFromHtml(html, finalUrl, filterPattern, maxResults)
    return { url: finalUrl, links, totalFound }
  } finally {
    releaseSemaphore()
  }
}
