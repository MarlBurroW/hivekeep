/**
 * Mini-App Backend Runner
 *
 * Loads and manages _server.js backends for mini-apps.
 * Each backend module exports a default function that receives a context
 * and returns a Hono app (or compatible handler).
 *
 * Example _server.js:
 *
 *   export default function(ctx) {
 *     const app = new ctx.Hono()
 *     app.get('/hello', (c) => c.json({ message: 'Hello!' }))
 *     return app
 *   }
 */

import { Hono } from 'hono'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '@/server/logger'
import {
  getMiniAppRow,
  getAppDir,
  storageGet,
  storageSet,
  storageDelete,
  storageList,
  storageClear,
} from '@/server/services/mini-apps'

const log = createLogger('mini-app-backend')

// ─── Event Emitter for SSE ──────────────────────────────────────────────────

type SSESubscriber = (event: string, data: unknown) => void

class AppEventEmitter {
  private subscribers = new Set<SSESubscriber>()

  /** Emit an event to all connected SSE clients */
  emit(event: string, data?: unknown): void {
    for (const sub of this.subscribers) {
      try { sub(event, data) } catch { /* ignore dead subscribers */ }
    }
  }

  /** Internal: add a subscriber (used by SSE route) */
  _subscribe(fn: SSESubscriber): () => void {
    this.subscribers.add(fn)
    return () => { this.subscribers.delete(fn) }
  }

  /** Number of active subscribers */
  get subscriberCount(): number {
    return this.subscribers.size
  }
}

/** Per-app event emitters, created lazily */
const appEmitters = new Map<string, AppEventEmitter>()

/** Get or create the event emitter for an app */
export function getAppEmitter(appId: string): AppEventEmitter {
  let emitter = appEmitters.get(appId)
  if (!emitter) {
    emitter = new AppEventEmitter()
    appEmitters.set(appId, emitter)
  }
  return emitter
}

/** Clean up emitter when backend is invalidated */
function cleanupEmitter(appId: string): void {
  appEmitters.delete(appId)
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Context passed to the backend module's default export */
export interface MiniAppBackendContext {
  /** App ID */
  appId: string
  /** Kin ID that owns this app */
  kinId: string
  /** App name */
  appName: string
  /** Hono constructor for creating routes */
  Hono: typeof Hono
  /** Key-value storage scoped to this app */
  storage: {
    get: (key: string) => Promise<unknown | null>
    set: (key: string, value: unknown) => Promise<void>
    delete: (key: string) => Promise<boolean>
    list: () => Promise<{ key: string; size: number }[]>
    clear: () => Promise<number>
  }
  /** Push real-time events to connected frontend clients via SSE */
  events: {
    /** Emit a named event with optional data to all connected clients */
    emit: (event: string, data?: unknown) => void
    /** Number of currently connected SSE clients */
    readonly subscriberCount: number
  }
  /** Simple logger */
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
    debug: (...args: unknown[]) => void
  }
}

interface CachedBackend {
  handler: Hono
  version: number
  loadedAt: number
}

// ─── Cache ──────────────────────────────────────────────────────────────────

const backendCache = new Map<string, CachedBackend>()

/** Clear a specific backend from cache (e.g. after _server.js update) */
export function invalidateBackend(appId: string): void {
  if (backendCache.has(appId)) {
    backendCache.delete(appId)
    cleanupEmitter(appId)
    log.info({ appId }, 'Backend cache invalidated')
  }
}

// ─── Build context ──────────────────────────────────────────────────────────

function buildContext(appId: string, kinId: string, appName: string): MiniAppBackendContext {
  const appLog = createLogger(`mini-app:${appId.slice(0, 8)}`)
  const emitter = getAppEmitter(appId)

  return {
    appId,
    kinId,
    appName,
    Hono,
    storage: {
      get: async (key: string) => {
        const raw = await storageGet(appId, key)
        if (raw === null) return null
        try { return JSON.parse(raw) } catch { return raw }
      },
      set: async (key: string, value: unknown) => {
        await storageSet(appId, key, JSON.stringify(value))
      },
      delete: (key: string) => storageDelete(appId, key),
      list: () => storageList(appId),
      clear: () => storageClear(appId),
    },
    events: {
      emit: (event: string, data?: unknown) => emitter.emit(event, data),
      get subscriberCount() { return emitter.subscriberCount },
    },
    log: {
      info: (...args: unknown[]) => appLog.info({ appId }, String(args[0]), ...args.slice(1)),
      warn: (...args: unknown[]) => appLog.warn({ appId }, String(args[0]), ...args.slice(1)),
      error: (...args: unknown[]) => appLog.error({ appId }, String(args[0]), ...args.slice(1)),
      debug: (...args: unknown[]) => appLog.debug({ appId }, String(args[0]), ...args.slice(1)),
    },
  }
}

// ─── Load backend ───────────────────────────────────────────────────────────

async function loadBackend(appId: string): Promise<Hono | null> {
  const app = await getMiniAppRow(appId)
  if (!app || !app.hasBackend) return null

  // Check cache - use version for invalidation
  const cached = backendCache.get(appId)
  if (cached && cached.version === app.version) {
    return cached.handler
  }

  const dir = getAppDir(app.kinId, appId)
  const serverJsPath = resolve(join(dir, '_server.js'))
  const serverTsPath = resolve(join(dir, '_server.ts'))

  const serverPath = existsSync(serverJsPath) ? serverJsPath : existsSync(serverTsPath) ? serverTsPath : null
  if (!serverPath) {
    log.warn({ appId }, 'hasBackend=true but no _server.js found')
    return null
  }

  try {
    // Use a cache-busting query to force re-import on version change
    const moduleUrl = `${serverPath}?v=${app.version}&t=${Date.now()}`
    const mod = await import(moduleUrl)

    const factory = mod.default ?? mod
    if (typeof factory !== 'function') {
      log.error({ appId }, '_server.js must export a default function')
      return null
    }

    const ctx = buildContext(appId, app.kinId, app.name)
    const handler = factory(ctx)

    if (!handler || typeof handler.fetch !== 'function') {
      log.error({ appId }, '_server.js factory must return a Hono app (or object with .fetch)')
      return null
    }

    backendCache.set(appId, { handler, version: app.version, loadedAt: Date.now() })
    log.info({ appId, version: app.version }, 'Backend loaded successfully')
    return handler
  } catch (err) {
    log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Failed to load backend')
    return null
  }
}

// ─── Handle request ─────────────────────────────────────────────────────────

/**
 * Handle an incoming API request for a mini-app backend.
 * Returns a Response or null if no backend is available.
 */
export async function handleBackendRequest(
  appId: string,
  request: Request,
  apiPath: string,
): Promise<Response | null> {
  const handler = await loadBackend(appId)
  if (!handler) return null

  try {
    // Rewrite the URL so the handler sees paths relative to /
    const url = new URL(request.url)
    url.pathname = apiPath.startsWith('/') ? apiPath : `/${apiPath}`

    const rewrittenRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // @ts-ignore - duplex needed for streaming bodies in Bun
      duplex: 'half',
    })

    return await handler.fetch(rewrittenRequest)
  } catch (err) {
    log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Backend request error')
    return new Response(JSON.stringify({ error: { code: 'BACKEND_ERROR', message: 'Internal backend error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
