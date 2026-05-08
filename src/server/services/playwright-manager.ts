import { v4 as uuid } from 'uuid'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ExtractMode } from '@/server/services/web-browse'
import type { Browser, BrowserContext, Page, Cookie } from 'playwright'

const log = createLogger('playwright-manager')

// ─── Types ──────────────────────────────────────────────────────────────────

interface BrowserEntry {
  browser: Browser
  lastUsed: number
  inUse: number
}

export interface BrowserBrowseResult {
  url: string
  title: string | null
  html: string
}

export interface ScreenshotResult {
  buffer: Buffer
  width: number
  height: number
}

export interface CookieSpec {
  name: string
  value: string
  domain?: string
  path?: string
  url?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

/** Playwright's storageState shape (re-typed locally to avoid leaking the
 *  playwright dependency through this module's public types). */
export interface BrowserStorageState {
  cookies?: unknown[]
  origins?: unknown[]
}

/** What's in the JSON file on disk. Note: `sizeBytes` is intentionally NOT
 *  stored in the file — it's always computed from fs.stat at read time so
 *  saveSessionState and listSavedStates report the same number. */
export interface SavedStateFile {
  name: string
  savedAt: number
  savedFromUrl: string | null
  savedFromTitle: string | null
  description: string | null
  storageState: BrowserStorageState
}

/** API-shape returned to callers — same fields as SavedStateFile minus the
 *  storageState payload, plus the on-disk file size. */
export interface SavedStateMeta {
  name: string
  savedAt: number
  savedFromUrl: string | null
  savedFromTitle: string | null
  description: string | null
  sizeBytes: number
}

export interface SessionOptions {
  kinId: string
  taskId?: string
  startUrl?: string
  cookies?: CookieSpec[]
  /** Pre-load a previously-saved storageState (cookies + localStorage). */
  storageState?: BrowserStorageState
  viewport?: { width: number; height: number }
  userAgent?: string
}

export interface BrowserSessionState {
  sessionId: string
  kinId: string
  taskId?: string
  url: string
  title: string | null
  createdAt: number
  lastUsedAt: number
}

interface BrowserSessionInternal extends BrowserSessionState {
  browser: Browser
  context: BrowserContext
  page: Page
  /** Cleanup hook to release the underlying BrowserEntry slot */
  release: () => void
}

const MAX_PAGES_PER_BROWSER = 3
const IDLE_CHECK_INTERVAL_MS = 15_000

// ─── Manager ────────────────────────────────────────────────────────────────

class PlaywrightManager {
  private browsers: BrowserEntry[] = []
  private idleTimer: ReturnType<typeof setInterval> | null = null
  private waitQueue: Array<(entry: BrowserEntry) => void> = []
  private shuttingDown = false
  private initialized = false
  private chromiumLoader: Promise<typeof import('playwright-extra').chromium> | null = null

  /** Active sessions keyed by sessionId */
  private sessions = new Map<string, BrowserSessionInternal>()

  get isEnabled(): boolean {
    return config.webBrowsing.headless.enabled
  }

  get sessionsEnabled(): boolean {
    return this.isEnabled && config.browserSessions.enabled
  }

  private async loadChromium() {
    if (!this.chromiumLoader) {
      this.chromiumLoader = (async () => {
        const playwrightExtra = await import('playwright-extra')
        const StealthPlugin = await import('puppeteer-extra-plugin-stealth')
        playwrightExtra.chromium.use(StealthPlugin.default())
        return playwrightExtra.chromium
      })()
    }
    return this.chromiumLoader
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    this.idleTimer = setInterval(() => {
      this.cleanupIdle().catch((err) => log.warn({ err }, 'Idle cleanup error'))
      this.cleanupIdleSessions().catch((err) => log.warn({ err }, 'Session GC error'))
    }, IDLE_CHECK_INTERVAL_MS)
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  private async launchBrowser(): Promise<Browser> {
    const chromium = await this.loadChromium()

    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
      ],
    }

    if (config.webBrowsing.headless.executablePath) {
      launchOptions.executablePath = config.webBrowsing.headless.executablePath
    }

    if (config.webBrowsing.proxy) {
      launchOptions.proxy = { server: config.webBrowsing.proxy }
    }

    const browser = await chromium.launch(launchOptions)
    log.info('Headless browser launched')

    browser.on('disconnected', () => {
      log.info('Browser disconnected, removing from pool')
      this.browsers = this.browsers.filter((e) => e.browser !== browser)
    })

    return browser
  }

  private async acquireEntry(): Promise<BrowserEntry> {
    const available = this.browsers.find((e) => e.inUse < MAX_PAGES_PER_BROWSER)
    if (available) {
      available.inUse++
      available.lastUsed = Date.now()
      return available
    }

    if (this.browsers.length < config.webBrowsing.headless.maxBrowsers) {
      const browser = await this.launchBrowser()
      const entry: BrowserEntry = { browser, lastUsed: Date.now(), inUse: 1 }
      this.browsers.push(entry)
      return entry
    }

    return new Promise((resolve) => {
      this.waitQueue.push(resolve)
    })
  }

  private release(entry: BrowserEntry): void {
    entry.inUse--
    entry.lastUsed = Date.now()

    const waiter = this.waitQueue.shift()
    if (waiter) {
      entry.inUse++
      waiter(entry)
    }
  }

  private async cleanupIdle(): Promise<void> {
    const now = Date.now()
    const idleTimeout = config.webBrowsing.headless.idleTimeoutMs

    const toClose = this.browsers.filter(
      (e) => e.inUse === 0 && now - e.lastUsed > idleTimeout,
    )

    for (const entry of toClose) {
      this.browsers = this.browsers.filter((e) => e !== entry)
      try {
        await entry.browser.close()
        log.info('Closed idle browser')
      } catch (err) {
        log.warn({ err }, 'Error closing idle browser')
      }
    }
  }

  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now()
    const idleTimeout = config.browserSessions.idleTimeoutMs
    const ttl = config.browserSessions.ttlMs

    const toClose: string[] = []
    for (const [sid, s] of this.sessions) {
      if (now - s.lastUsedAt > idleTimeout) toClose.push(sid)
      else if (now - s.createdAt > ttl) toClose.push(sid)
    }

    for (const sid of toClose) {
      try {
        await this.closeSession(sid, { reason: 'gc' })
      } catch (err) {
        log.warn({ sessionId: sid, err }, 'Error GC-closing session')
      }
    }
  }

  private async openContext(browser: Browser, viewport: { width: number; height: number }): Promise<BrowserContext> {
    return browser.newContext({
      userAgent: config.webBrowsing.userAgent,
      viewport,
    })
  }

  // ─── One-shot pool API ────────────────────────────────────────────────────

  async browseWithBrowser(
    url: string,
    mode: ExtractMode,
  ): Promise<BrowserBrowseResult> {
    if (!this.isEnabled) {
      throw new Error(
        'Headless browser not available. Set WEB_BROWSING_HEADLESS_ENABLED=true and install Chromium.',
      )
    }

    this.ensureInitialized()
    const entry = await this.acquireEntry()

    let context: BrowserContext | null = null
    let page: Page | null = null
    try {
      context = await this.openContext(entry.browser, { width: 1280, height: 720 })
      page = await context.newPage()

      if (mode !== 'markdown') {
        await page.route('**/*', (route) => {
          const type = route.request().resourceType()
          if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
            return route.abort()
          }
          return route.continue()
        })
      }

      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: config.webBrowsing.pageTimeout,
      })

      const title = await page.title()
      const html = await page.content()

      return {
        url: page.url(),
        title: title || null,
        html,
      }
    } finally {
      if (page) await page.close().catch(() => {})
      if (context) await context.close().catch(() => {})
      this.release(entry)
    }
  }

  async screenshotPage(
    url: string,
    options: {
      width?: number
      height?: number
      fullPage?: boolean
    } = {},
  ): Promise<ScreenshotResult> {
    if (!this.isEnabled) {
      throw new Error(
        'Headless browser not available. Set WEB_BROWSING_HEADLESS_ENABLED=true and install Chromium.',
      )
    }

    this.ensureInitialized()
    const entry = await this.acquireEntry()

    const width = options.width ?? 1280
    const height = options.height ?? 720

    let context: BrowserContext | null = null
    let page: Page | null = null
    try {
      context = await this.openContext(entry.browser, { width, height })
      page = await context.newPage()

      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: config.webBrowsing.pageTimeout,
      })

      const buffer = await page.screenshot({
        type: 'png',
        fullPage: options.fullPage ?? false,
      })

      return { buffer, width, height }
    } finally {
      if (page) await page.close().catch(() => {})
      if (context) await context.close().catch(() => {})
      this.release(entry)
    }
  }

  // ─── Stateful session API ─────────────────────────────────────────────────

  countSessionsForKin(kinId: string): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.kinId === kinId) n++
    return n
  }

  async openSession(opts: SessionOptions): Promise<BrowserSessionState> {
    if (!this.sessionsEnabled) {
      throw new Error(
        'Browser sessions not available. Set WEB_BROWSING_HEADLESS_ENABLED=true and BROWSER_SESSIONS_ENABLED=true.',
      )
    }

    if (this.sessions.size >= config.browserSessions.maxTotal) {
      throw new Error(
        `Global session limit reached (${config.browserSessions.maxTotal}). Close an existing session before opening a new one.`,
      )
    }
    if (this.countSessionsForKin(opts.kinId) >= config.browserSessions.maxPerKin) {
      throw new Error(
        `This Kin already has ${config.browserSessions.maxPerKin} active session(s) (limit per Kin). Close it first via browser_close_session.`,
      )
    }

    this.ensureInitialized()
    const entry = await this.acquireEntry()

    const sessionId = uuid()
    const viewport = opts.viewport ?? config.browserSessions.defaultViewport

    let context: BrowserContext | null = null
    let page: Page | null = null
    try {
      const contextOptions: Parameters<Browser['newContext']>[0] = {
        userAgent: opts.userAgent ?? config.webBrowsing.userAgent,
        viewport,
      }
      if (opts.storageState) {
        // Cast to Playwright's expected shape — we keep the public type loose
        // intentionally (see BrowserStorageState).
        contextOptions.storageState = opts.storageState as Parameters<Browser['newContext']>[0] extends infer T
          ? T extends { storageState?: infer S } ? S : never
          : never
      }
      context = await entry.browser.newContext(contextOptions)
      if (opts.cookies && opts.cookies.length > 0) {
        await context.addCookies(opts.cookies as Parameters<BrowserContext['addCookies']>[0])
      }
      page = await context.newPage()

      if (opts.startUrl) {
        await page.goto(opts.startUrl, {
          waitUntil: 'domcontentloaded',
          timeout: config.webBrowsing.pageTimeout,
        })
      }

      const now = Date.now()
      const session: BrowserSessionInternal = {
        sessionId,
        kinId: opts.kinId,
        taskId: opts.taskId,
        url: page.url(),
        title: opts.startUrl ? (await page.title().catch(() => null)) : null,
        createdAt: now,
        lastUsedAt: now,
        browser: entry.browser,
        context,
        page,
        release: () => this.release(entry),
      }

      this.sessions.set(sessionId, session)
      log.info({ sessionId, kinId: opts.kinId, taskId: opts.taskId }, 'Browser session opened')

      return this.toState(session)
    } catch (err) {
      if (page) await page.close().catch(() => {})
      if (context) await context.close().catch(() => {})
      this.release(entry)
      throw err
    }
  }

  /**
   * Resolve a session by ID. Throws if not found or owned by a different Kin.
   * Updates lastUsedAt as a side effect.
   */
  resolveSession(sessionId: string, kinId: string): BrowserSessionInternal {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`Session ${sessionId} not found (closed, expired, or invalid).`)
    if (s.kinId !== kinId) throw new Error(`Session ${sessionId} is not owned by this Kin.`)
    s.lastUsedAt = Date.now()
    return s
  }

  async closeSession(sessionId: string, opts: { reason?: string } = {}): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return

    this.sessions.delete(sessionId)
    try { await s.page.close() } catch {}
    try { await s.context.close() } catch {}
    s.release()

    log.info({ sessionId, kinId: s.kinId, reason: opts.reason ?? 'explicit' }, 'Browser session closed')
  }

  async closeSessionsForKin(kinId: string, reason = 'kin_deleted'): Promise<number> {
    const ids: string[] = []
    for (const [sid, s] of this.sessions) if (s.kinId === kinId) ids.push(sid)
    for (const sid of ids) await this.closeSession(sid, { reason })
    return ids.length
  }

  async closeSessionsForTask(taskId: string, reason = 'task_ended'): Promise<number> {
    const ids: string[] = []
    for (const [sid, s] of this.sessions) if (s.taskId === taskId) ids.push(sid)
    for (const sid of ids) await this.closeSession(sid, { reason })
    return ids.length
  }

  listSessions(kinId?: string): BrowserSessionState[] {
    const out: BrowserSessionState[] = []
    for (const s of this.sessions.values()) {
      if (!kinId || s.kinId === kinId) out.push(this.toState(s))
    }
    return out
  }

  private toState(s: BrowserSessionInternal): BrowserSessionState {
    return {
      sessionId: s.sessionId,
      kinId: s.kinId,
      taskId: s.taskId,
      url: s.url,
      title: s.title,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }
  }

  /** Refresh the cached url/title on a session. Call after any nav/action. */
  async refreshSessionMeta(s: BrowserSessionInternal): Promise<void> {
    s.url = s.page.url()
    s.title = await s.page.title().catch(() => null)
    s.lastUsedAt = Date.now()
  }

  // ─── Cookie helpers ───────────────────────────────────────────────────────

  async setCookies(sessionId: string, kinId: string, cookies: CookieSpec[]): Promise<number> {
    const s = this.resolveSession(sessionId, kinId)
    if (cookies.length === 0) return 0
    await s.context.addCookies(cookies as Parameters<BrowserContext['addCookies']>[0])
    return cookies.length
  }

  async getCookies(sessionId: string, kinId: string, urls?: string[]): Promise<Cookie[]> {
    const s = this.resolveSession(sessionId, kinId)
    return s.context.cookies(urls)
  }

  async clearCookies(sessionId: string, kinId: string): Promise<void> {
    const s = this.resolveSession(sessionId, kinId)
    await s.context.clearCookies()
  }

  // ─── Saved state persistence (cross-session) ──────────────────────────────

  private statesDirForKin(kinId: string): string {
    return join(config.browserSessions.statesDir, kinId)
  }

  private statePathForKin(kinId: string, name: string): string {
    return join(this.statesDirForKin(kinId), `${name}.json`)
  }

  private validateStateName(name: string): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
      throw new Error(
        `Invalid state name "${name}". Must be 1-64 characters, alphanumeric + dash + underscore, starting with a letter or digit.`,
      )
    }
  }

  async saveSessionState(
    sessionId: string,
    kinId: string,
    name: string,
    description?: string,
  ): Promise<SavedStateMeta> {
    this.validateStateName(name)
    const session = this.resolveSession(sessionId, kinId)

    const storageState = await session.context.storageState()
    const url = session.page.url()
    const title = await session.page.title().catch(() => null)
    const file: SavedStateFile = {
      name,
      savedAt: Date.now(),
      savedFromUrl: url || null,
      savedFromTitle: title || null,
      description: description ?? null,
      storageState: storageState as BrowserStorageState,
    }
    const json = JSON.stringify(file)
    if (json.length > config.browserSessions.maxStateSizeBytes) {
      throw new Error(
        `Saved state would exceed max size (${json.length} bytes > ${config.browserSessions.maxStateSizeBytes}). Try saving from a page with less localStorage data.`,
      )
    }

    const dir = this.statesDirForKin(kinId)
    await mkdir(dir, { recursive: true })

    // Enforce per-Kin cap (only when creating a new entry)
    const existingPath = this.statePathForKin(kinId, name)
    const isNew = !existsSync(existingPath)
    if (isNew) {
      const existing = await this.listSavedStates(kinId)
      if (existing.length >= config.browserSessions.maxStatesPerKin) {
        throw new Error(
          `This Kin already has ${existing.length} saved states (limit: ${config.browserSessions.maxStatesPerKin}). Delete one first via browser_delete_state.`,
        )
      }
    }

    await writeFile(existingPath, json, { mode: 0o600 })
    // Read back the actual on-disk size so saveSessionState and listSavedStates
    // report the same number (otherwise embedding sizeBytes in the file caused
    // a small chicken-and-egg drift between the two).
    const stats = await stat(existingPath)
    log.info({ kinId, name, sizeBytes: stats.size, fromUrl: url }, 'Browser state saved')

    return {
      name: file.name,
      savedAt: file.savedAt,
      savedFromUrl: file.savedFromUrl,
      savedFromTitle: file.savedFromTitle,
      description: file.description,
      sizeBytes: stats.size,
    }
  }

  async loadSavedState(kinId: string, name: string): Promise<SavedStateFile> {
    this.validateStateName(name)
    const path = this.statePathForKin(kinId, name)
    if (!existsSync(path)) {
      throw new Error(`Saved state "${name}" not found for this Kin. Use browser_list_states to see what's available.`)
    }
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as SavedStateFile
    return parsed
  }

  async listSavedStates(kinId: string): Promise<SavedStateMeta[]> {
    const dir = this.statesDirForKin(kinId)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir)
    const out: SavedStateMeta[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const path = join(dir, entry)
      try {
        const stats = await stat(path)
        const raw = await readFile(path, 'utf-8')
        const parsed = JSON.parse(raw) as SavedStateFile
        out.push({
          name: parsed.name,
          savedAt: parsed.savedAt,
          savedFromUrl: parsed.savedFromUrl,
          savedFromTitle: parsed.savedFromTitle,
          description: parsed.description,
          sizeBytes: stats.size,
        })
      } catch (err) {
        log.warn({ kinId, entry, err }, 'Skipping unreadable browser state file')
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }

  async deleteSavedState(kinId: string, name: string): Promise<boolean> {
    this.validateStateName(name)
    const path = this.statePathForKin(kinId, name)
    if (!existsSync(path)) return false
    await unlink(path)
    log.info({ kinId, name }, 'Browser state deleted')
    return true
  }

  /** Called by deleteKin — remove all saved states for a Kin. */
  async deleteAllSavedStatesForKin(kinId: string): Promise<number> {
    const dir = this.statesDirForKin(kinId)
    if (!existsSync(dir)) return 0
    const entries = await readdir(dir)
    let removed = 0
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        await unlink(join(dir, entry))
        removed++
      } catch (err) {
        log.warn({ kinId, entry, err }, 'Failed to remove browser state file')
      }
    }
    return removed
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true

    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }

    log.info({ browsers: this.browsers.length, sessions: this.sessions.size }, 'Shutting down Playwright manager')

    // Close all sessions first
    const sessionIds = Array.from(this.sessions.keys())
    for (const sid of sessionIds) {
      try { await this.closeSession(sid, { reason: 'shutdown' }) } catch {}
    }

    const closePromises = this.browsers.map(async (entry) => {
      try {
        await entry.browser.close()
      } catch (err) {
        log.warn({ err }, 'Error closing browser during shutdown')
      }
    })

    await Promise.allSettled(closePromises)
    this.browsers = []
    log.info('Playwright manager shut down')
  }
}

export const playwrightManager = new PlaywrightManager()

// ─── Cookie input parsing (exported for tools) ──────────────────────────────

/**
 * Parse cookies from either a JSON array (Playwright/Puppeteer-style) or a
 * cookie header string ("name1=value1; name2=value2; ...").
 *
 * For header strings, `defaultDomain` is required because the format does not
 * carry domain information.
 */
export function parseCookieInput(
  input: string | CookieSpec[] | unknown,
  defaultDomain?: string,
): CookieSpec[] {
  if (Array.isArray(input)) {
    return input.map((c, i) => {
      if (typeof c !== 'object' || c === null) {
        throw new Error(`Cookie at index ${i} must be an object`)
      }
      const cookie = c as Partial<CookieSpec>
      if (!cookie.name || typeof cookie.value !== 'string') {
        throw new Error(`Cookie at index ${i} must have non-empty "name" and string "value"`)
      }
      const domain = cookie.domain ?? defaultDomain
      if (!domain && !cookie.url) {
        throw new Error(
          `Cookie "${cookie.name}" needs either "domain", "url", or a default_cookie_domain parameter`,
        )
      }
      return {
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path ?? '/',
        url: cookie.url,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }
    })
  }
  if (typeof input === 'string') {
    if (!defaultDomain) {
      throw new Error(
        'When cookies is a header string ("name=value; ..."), default_cookie_domain is required.',
      )
    }
    return input
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf('=')
        if (eq < 0) throw new Error(`Invalid cookie pair: "${pair}"`)
        return {
          name: pair.slice(0, eq).trim(),
          value: pair.slice(eq + 1).trim(),
          domain: defaultDomain,
          path: '/',
        }
      })
  }
  throw new Error('cookies must be either a JSON array of cookie objects or a cookie header string')
}
