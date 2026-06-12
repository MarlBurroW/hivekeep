/**
 * Mini-App Backend Runner
 *
 * Loads and manages _server.js backends for mini-apps, with a full lifecycle:
 *
 *   export default function (ctx) {        // optional — HTTP routes
 *     const app = new ctx.Hono()
 *     app.get('/hello', (c) => c.json({ message: 'Hello!' }))
 *     return app
 *   }
 *   export async function onStart(ctx) {}  // optional — called when the backend loads
 *   export async function onStop(ctx) {}   // optional — called before unload/reload
 *
 * Backends are loaded lazily on first request, or eagerly at server boot when the
 * app's `app.json` manifest declares `"background": true`. Each loaded backend is a
 * tracked instance: managed timers (ctx.timers) and the abort signal (ctx.signal)
 * are cleaned up deterministically when the instance stops, so an edited backend
 * never leaves zombie intervals behind.
 *
 * The per-app SSE emitter intentionally survives reloads: connected clients keep
 * receiving events from the new instance. It is only dropped when the app is deleted.
 */

import { Hono } from 'hono'
import { Cron } from 'croner'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import { createNotification } from '@/server/services/notifications'
import {
  getMiniAppRow,
  getAppDir,
  listBackendAppIds,
  readAppManifest,
  storageGet,
  storageSet,
  storageDelete,
  storageList,
  storageClear,
} from '@/server/services/mini-apps'
import { pushConsoleEntry } from '@/server/services/mini-app-console'
import {
  buildFilesApi,
  buildSecretsApi,
  buildLlmApi,
  buildAgentApi,
  guardedFetch,
  parseGrantedPermissions,
  parseRequestedPermissions,
  type MiniAppFilesApi,
  type MiniAppSecretsApi,
  type MiniAppLlmApi,
  type MiniAppAgentApi,
} from '@/server/services/mini-app-capabilities'

const log = createLogger('mini-app-backend')

const ON_STOP_TIMEOUT_MS = 5_000
const MAX_TIMERS_PER_APP = 100
const MIN_INTERVAL_MS = 1_000
const MAX_JOBS_PER_APP = 10
/** Runtime guard: a scheduled job never runs more often than this */
const MIN_JOB_SPACING_MS = 15_000
const NOTIFY_MAX_PER_HOUR = 10

/** Per-app notification timestamps for rate limiting (survives backend reloads) */
const notifyTimestamps = new Map<string, number[]>()

// ─── Event Emitter for SSE ──────────────────────────────────────────────────

type SSESubscriber = (event: string, data: unknown) => void

class AppEventEmitter {
  private subscribers = new Map<SSESubscriber, string | null>() // fn → userId (null = unknown)

  /** Emit an event to connected SSE clients, optionally targeting a single user */
  emit(event: string, data?: unknown, opts?: { userId?: string }): void {
    for (const [sub, userId] of this.subscribers) {
      if (opts?.userId && userId !== opts.userId) continue
      try { sub(event, data) } catch { /* ignore dead subscribers */ }
    }
  }

  /** Internal: add a subscriber (used by SSE route), tagged with the session user */
  _subscribe(fn: SSESubscriber, userId?: string): () => void {
    this.subscribers.set(fn, userId ?? null)
    return () => { this.subscribers.delete(fn) }
  }

  /** Number of active subscribers */
  get subscriberCount(): number {
    return this.subscribers.size
  }
}

/** Per-app event emitters, created lazily. Stable across backend reloads. */
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

// ─── Types ──────────────────────────────────────────────────────────────────

type TimerId = ReturnType<typeof setTimeout>

/** Context passed to the backend module's default export and lifecycle hooks */
export interface MiniAppBackendContext {
  /** App ID */
  appId: string
  /** Agent ID that maintains this app */
  agentId: string
  /** App name */
  appName: string
  /** App version this instance was loaded from */
  version: number
  /** True when the app declares `"background": true` in app.json */
  background: boolean
  /** Hono constructor for creating routes */
  Hono: typeof Hono
  /** Aborted when this backend instance is stopped (reload, edit, shutdown) */
  signal: AbortSignal
  /** Managed timers — automatically cleared when the instance stops */
  timers: {
    setTimeout: (fn: () => void, ms: number) => TimerId
    setInterval: (fn: () => void, ms: number) => TimerId
    clearTimeout: (id: TimerId) => void
    clearInterval: (id: TimerId) => void
  }
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
    /**
     * Emit a named event with optional data to connected clients.
     * Pass { userId } to deliver only to that user's connections.
     */
    emit: (event: string, data?: unknown, opts?: { userId?: string }) => void
    /** Number of currently connected SSE clients */
    readonly subscriberCount: number
  }
  /**
   * Register a named cron job (croner pattern, e.g. "*\/15 * * * *").
   * Jobs are stopped automatically when the instance stops. Re-registering an
   * existing name replaces the previous job. Runs are spaced at least 15s apart.
   */
  schedule: (name: string, cronExpr: string, handler: () => void | Promise<void>) => { stop: () => void }
  /**
   * Send a platform notification to users (notification center + SSE +
   * configured external channels). Rate-limited per app.
   */
  notify: (title: string, body?: string) => Promise<void>
  /** Permission introspection: what the app requested vs what the user granted */
  permissions: {
    readonly requested: string[]
    readonly granted: string[]
    has: (permission: string) => boolean
  }
  /** Vault secrets — gated per secret by the "secrets:<NAME>" permission */
  secrets: MiniAppSecretsApi
  /** One-shot LLM completion via platform providers — gated by "llm" */
  llm: MiniAppLlmApi
  /** Bridge to the maintainer Agent — gated by "agent:inform" / "agent:task" */
  agent: MiniAppAgentApi
  /** SSRF-guarded fetch (http/https only, private hosts blocked, 30s timeout) */
  fetch: (url: string, options?: RequestInit) => Promise<Response>
  /** Scoped file storage under the app's `_data/` dir (excluded from snapshots) */
  files: MiniAppFilesApi
  /** Logger — entries also land in the app console (get_mini_app_console) */
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
    debug: (...args: unknown[]) => void
  }
}

/** Sender info passed to onClientEvent */
export interface ClientEventMeta {
  userId: string
  userName: string | null
}

interface BackendModule {
  default?: (ctx: MiniAppBackendContext) => Hono
  onStart?: (ctx: MiniAppBackendContext) => void | Promise<void>
  onStop?: (ctx: MiniAppBackendContext) => void | Promise<void>
  /** Receives events sent from the frontend via Hivekeep.events.send() */
  onClientEvent?: (ctx: MiniAppBackendContext, event: string, data: unknown, meta: ClientEventMeta) => unknown
}

interface BackendInstance {
  handler: Hono | null
  version: number
  loadedAt: number
  background: boolean
  controller: AbortController
  timers: Set<TimerId>
  jobs: Map<string, Cron>
  module: BackendModule
  ctx: MiniAppBackendContext
}

// ─── Instance registry ──────────────────────────────────────────────────────

const instances = new Map<string, BackendInstance>()
/** Dedupe concurrent loads of the same app */
const loading = new Map<string, Promise<BackendInstance | null>>()

/** Stop a backend instance: stop jobs, clear timers, abort signal, run onStop (bounded). */
async function stopInstance(appId: string, inst: BackendInstance): Promise<void> {
  for (const job of inst.jobs.values()) {
    try { job.stop() } catch { /* already stopped */ }
  }
  inst.jobs.clear()

  for (const id of inst.timers) {
    clearTimeout(id)
    clearInterval(id)
  }
  inst.timers.clear()

  try { inst.controller.abort() } catch { /* listeners may throw */ }

  if (typeof inst.module.onStop === 'function') {
    try {
      await Promise.race([
        Promise.resolve(inst.module.onStop(inst.ctx)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`onStop timed out after ${ON_STOP_TIMEOUT_MS}ms`)), ON_STOP_TIMEOUT_MS)),
      ])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ appId, error: message }, 'Backend onStop failed')
      pushBackendConsole(appId, 'warn', [`onStop failed: ${message}`])
    }
  }

  log.info({ appId, version: inst.version }, 'Backend instance stopped')
}

/**
 * Clear a specific backend from cache (e.g. after _server.js update).
 * The previous instance is stopped asynchronously (timers are cleared synchronously
 * inside stopInstance before any await).
 */
export function invalidateBackend(appId: string): void {
  const inst = instances.get(appId)
  if (!inst) return
  instances.delete(appId)
  void stopInstance(appId, inst)
}

/** Stop the backend and drop the SSE emitter. Used when the app is deleted. */
export function removeBackend(appId: string): void {
  invalidateBackend(appId)
  appEmitters.delete(appId)
}

// ─── Console bridge ─────────────────────────────────────────────────────────

function pushBackendConsole(appId: string, level: 'log' | 'warn' | 'error', args: unknown[]): void {
  try {
    pushConsoleEntry(appId, {
      level,
      args: args.map((a) => {
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      }),
      stack: null,
      timestamp: Date.now(),
      source: 'backend',
    })
  } catch { /* console buffer must never break the backend */ }
}

// ─── Build context ──────────────────────────────────────────────────────────

function buildContext(params: {
  appId: string
  agentId: string
  appName: string
  appDir: string
  version: number
  background: boolean
  requested: string[]
  granted: string[]
  controller: AbortController
  timers: Set<TimerId>
  jobs: Map<string, Cron>
}): MiniAppBackendContext {
  const { appId, agentId, appName, appDir, version, background, requested, granted, controller, timers, jobs } = params
  const appLog = createLogger(`mini-app:${appId.slice(0, 8)}`)
  const emitter = getAppEmitter(appId)
  const capabilityParams = { appId, agentId, appName, appDir, granted }
  const grantedSet = new Set(granted)

  return {
    appId,
    agentId,
    appName,
    version,
    background,
    Hono,
    signal: controller.signal,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        if (timers.size >= MAX_TIMERS_PER_APP) throw new Error(`Too many active timers (max ${MAX_TIMERS_PER_APP})`)
        const id = setTimeout(() => {
          timers.delete(id)
          try { fn() } catch (err) {
            pushBackendConsole(appId, 'error', [`Timer callback failed: ${err instanceof Error ? err.message : String(err)}`])
          }
        }, ms)
        timers.add(id)
        return id
      },
      setInterval: (fn: () => void, ms: number) => {
        if (timers.size >= MAX_TIMERS_PER_APP) throw new Error(`Too many active timers (max ${MAX_TIMERS_PER_APP})`)
        if (ms < MIN_INTERVAL_MS) throw new Error(`Interval too short: minimum ${MIN_INTERVAL_MS}ms`)
        const id = setInterval(() => {
          try { fn() } catch (err) {
            pushBackendConsole(appId, 'error', [`Interval callback failed: ${err instanceof Error ? err.message : String(err)}`])
          }
        }, ms)
        timers.add(id)
        return id
      },
      clearTimeout: (id: TimerId) => { clearTimeout(id); timers.delete(id) },
      clearInterval: (id: TimerId) => { clearInterval(id); timers.delete(id) },
    },
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
      emit: (event: string, data?: unknown, opts?: { userId?: string }) => emitter.emit(event, data, opts),
      get subscriberCount() { return emitter.subscriberCount },
    },
    schedule: (name: string, cronExpr: string, handler: () => void | Promise<void>) => {
      if (controller.signal.aborted) throw new Error('Backend instance is stopped')
      if (!name || typeof name !== 'string') throw new Error('schedule: name is required')
      if (typeof handler !== 'function') throw new Error('schedule: handler must be a function')

      const existing = jobs.get(name)
      if (existing) {
        try { existing.stop() } catch { /* already stopped */ }
        jobs.delete(name)
      } else if (jobs.size >= MAX_JOBS_PER_APP) {
        throw new Error(`Too many scheduled jobs (max ${MAX_JOBS_PER_APP})`)
      }

      let lastStartedAt = 0
      let job: Cron
      try {
        job = new Cron(cronExpr, { timezone: config.timezone, protect: true }, async () => {
          const now = Date.now()
          if (now - lastStartedAt < MIN_JOB_SPACING_MS) {
            pushBackendConsole(appId, 'warn', [`Job "${name}" skipped: runs must be at least ${MIN_JOB_SPACING_MS / 1000}s apart`])
            return
          }
          lastStartedAt = now
          try {
            await handler()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            appLog.error({ appId, job: name }, `Job failed: ${message}`)
            pushBackendConsole(appId, 'error', [`Job "${name}" failed: ${message}`])
          }
        })
      } catch (err) {
        throw new Error(`schedule: invalid cron pattern "${cronExpr}" — ${err instanceof Error ? err.message : String(err)}`)
      }

      jobs.set(name, job)
      return {
        stop: () => {
          try { job.stop() } catch { /* already stopped */ }
          jobs.delete(name)
        },
      }
    },
    notify: async (title: string, body?: string) => {
      if (typeof title !== 'string' || !title.trim()) throw new Error('notify: title is required')
      const now = Date.now()
      const recent = (notifyTimestamps.get(appId) ?? []).filter((t) => now - t < 3_600_000)
      if (recent.length >= NOTIFY_MAX_PER_HOUR) {
        throw new Error(`notify: rate limit reached (max ${NOTIFY_MAX_PER_HOUR} notifications per hour)`)
      }
      recent.push(now)
      notifyTimestamps.set(appId, recent)

      await createNotification({
        type: 'miniapp:notify',
        title: `${appName}: ${title}`.slice(0, 200),
        body: body ? String(body).slice(0, 1000) : undefined,
        agentId,
        relatedId: appId,
        relatedType: 'miniapp',
      })
    },
    permissions: {
      requested,
      granted,
      has: (permission: string) => grantedSet.has(permission),
    },
    secrets: buildSecretsApi(capabilityParams),
    llm: buildLlmApi(capabilityParams),
    agent: buildAgentApi(capabilityParams),
    fetch: (url: string, options?: RequestInit) => guardedFetch(url, options),
    files: buildFilesApi(appDir),
    log: {
      info: (...args: unknown[]) => {
        appLog.info({ appId }, String(args[0]), ...args.slice(1))
        pushBackendConsole(appId, 'log', args)
      },
      warn: (...args: unknown[]) => {
        appLog.warn({ appId }, String(args[0]), ...args.slice(1))
        pushBackendConsole(appId, 'warn', args)
      },
      error: (...args: unknown[]) => {
        appLog.error({ appId }, String(args[0]), ...args.slice(1))
        pushBackendConsole(appId, 'error', args)
      },
      debug: (...args: unknown[]) => appLog.debug({ appId }, String(args[0]), ...args.slice(1)),
    },
  }
}

// ─── Load backend ───────────────────────────────────────────────────────────

async function loadBackend(appId: string): Promise<BackendInstance | null> {
  const app = await getMiniAppRow(appId)
  if (!app || !app.hasBackend || !app.isActive) return null

  // Fast path: cached instance at the current version
  const cached = instances.get(appId)
  if (cached && cached.version === app.version) return cached

  // Dedupe concurrent (re)loads
  const pending = loading.get(appId)
  if (pending) return pending

  const promise = (async (): Promise<BackendInstance | null> => {
    // Stop the outdated instance BEFORE importing the new module, so the old
    // background work never overlaps the new instance.
    const outdated = instances.get(appId)
    if (outdated) {
      instances.delete(appId)
      await stopInstance(appId, outdated)
    }

    const dir = getAppDir(app.agentId, appId)
    const serverJsPath = resolve(join(dir, '_server.js'))
    const serverTsPath = resolve(join(dir, '_server.ts'))

    const serverPath = existsSync(serverJsPath) ? serverJsPath : existsSync(serverTsPath) ? serverTsPath : null
    if (!serverPath) {
      log.warn({ appId }, 'hasBackend=true but no _server.js found')
      return null
    }

    try {
      const manifest = await readAppManifest(appId)
      const background = manifest.background === true
      const requested = parseRequestedPermissions(manifest)
      const granted = parseGrantedPermissions(app.grantedPermissions).filter((p) => requested.includes(p))
      const missing = requested.filter((p) => !granted.includes(p))
      if (missing.length > 0) {
        pushBackendConsole(appId, 'warn', [
          `Requested permissions not granted yet: ${missing.join(', ')} — the matching ctx capabilities will throw until the user approves them.`,
        ])
      }

      // Use a cache-busting query to force re-import on version change
      const moduleUrl = `${serverPath}?v=${app.version}&t=${Date.now()}`
      const mod = (await import(moduleUrl)) as BackendModule

      const factory = mod.default
      const hasLifecycle = typeof mod.onStart === 'function' || typeof mod.onStop === 'function'
      if (typeof factory !== 'function' && !hasLifecycle) {
        log.error({ appId }, '_server.js must export a default function (and/or onStart/onStop)')
        pushBackendConsole(appId, 'error', ['_server.js must export a default function returning a Hono app, and/or onStart/onStop lifecycle hooks'])
        return null
      }

      const controller = new AbortController()
      const timers = new Set<TimerId>()
      const jobs = new Map<string, Cron>()
      const ctx = buildContext({
        appId,
        agentId: app.agentId,
        appName: app.name,
        appDir: dir,
        version: app.version,
        background,
        requested,
        granted,
        controller,
        timers,
        jobs,
      })

      let handler: Hono | null = null
      if (typeof factory === 'function') {
        const result = factory(ctx)
        if (!result || typeof (result as Hono).fetch !== 'function') {
          log.error({ appId }, '_server.js factory must return a Hono app (or object with .fetch)')
          pushBackendConsole(appId, 'error', ['_server.js default export must return a Hono app (or object with .fetch)'])
          return null
        }
        handler = result
      }

      const instance: BackendInstance = {
        handler,
        version: app.version,
        loadedAt: Date.now(),
        background,
        controller,
        timers,
        jobs,
        module: mod,
        ctx,
      }
      instances.set(appId, instance)

      if (typeof mod.onStart === 'function') {
        try {
          await mod.onStart(ctx)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.error({ appId, error: message }, 'Backend onStart failed')
          pushBackendConsole(appId, 'error', [`onStart failed: ${message}`])
          // Keep the instance: HTTP routes still work even if onStart failed.
        }
      }

      log.info({ appId, version: app.version, background, lifecycle: hasLifecycle }, 'Backend loaded')
      return instance
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ appId, error: message }, 'Failed to load backend')
      pushBackendConsole(appId, 'error', [`Failed to load _server.js: ${message}`])
      return null
    }
  })()

  loading.set(appId, promise)
  try {
    return await promise
  } finally {
    loading.delete(appId)
  }
}

// ─── File-change + boot hooks ───────────────────────────────────────────────

/**
 * React to a mini-app file change. Called by the file-write/delete service layer
 * (single choke point for both REST routes and Agent tools).
 * `_server.js`/`_server.ts`/`app.json` changes stop the running instance; background
 * apps are restarted immediately so their live part never silently stays down.
 */
export function handleAppFilesChanged(appId: string, relativePath: string): void {
  if (relativePath !== '_server.js' && relativePath !== '_server.ts' && relativePath !== 'app.json') return
  void restartBackend(appId)
}

/** Stop the current instance and reload it right away if the app runs in background. */
export async function restartBackend(appId: string): Promise<void> {
  invalidateBackend(appId)
  try {
    const app = await getMiniAppRow(appId)
    if (!app || !app.hasBackend || !app.isActive) return
    const manifest = await readAppManifest(appId)
    if (manifest.background === true) {
      await loadBackend(appId)
    }
  } catch (err) {
    log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Backend restart failed')
  }
}

/**
 * Boot-time loader: eagerly start every active app whose manifest declares
 * `"background": true`. Lazy apps keep loading on first request.
 */
export async function initMiniAppBackends(): Promise<void> {
  try {
    const appIds = await listBackendAppIds()
    let started = 0
    for (const appId of appIds) {
      try {
        const manifest = await readAppManifest(appId)
        if (manifest.background !== true) continue
        const inst = await loadBackend(appId)
        if (inst) started++
      } catch (err) {
        log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Failed to boot background backend')
      }
    }
    if (started > 0) log.info({ started }, 'Background mini-app backends started')
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to init mini-app backends')
  }
}

/** Graceful shutdown: stop all running instances (best-effort, bounded by onStop timeout). */
export async function stopAllBackends(): Promise<void> {
  const entries = [...instances.entries()]
  instances.clear()
  await Promise.allSettled(entries.map(([appId, inst]) => stopInstance(appId, inst)))
}

/** Introspection for tools/UI: status of a backend instance. */
export function getBackendStatus(appId: string): {
  loaded: boolean
  version: number | null
  background: boolean
  loadedAt: number | null
  activeTimers: number
  sseSubscribers: number
  jobs: { name: string; pattern: string; nextRunAt: number | null }[]
} {
  const inst = instances.get(appId)
  return {
    loaded: !!inst,
    version: inst?.version ?? null,
    background: inst?.background ?? false,
    loadedAt: inst?.loadedAt ?? null,
    activeTimers: inst?.timers.size ?? 0,
    sseSubscribers: appEmitters.get(appId)?.subscriberCount ?? 0,
    jobs: inst
      ? [...inst.jobs.entries()].map(([name, job]) => ({
          name,
          pattern: job.getPattern() ?? '',
          nextRunAt: job.nextRun()?.getTime() ?? null,
        }))
      : [],
  }
}

// ─── Client events (frontend → backend) ─────────────────────────────────────

const ON_CLIENT_EVENT_TIMEOUT_MS = 10_000

/**
 * Deliver an event sent by the app's frontend (Hivekeep.events.send) to the
 * backend's onClientEvent export. Returns whether a handler ran and its result.
 */
export async function handleClientEvent(
  appId: string,
  event: string,
  data: unknown,
  meta: ClientEventMeta,
): Promise<{ handled: boolean; result?: unknown; error?: string }> {
  const instance = await loadBackend(appId)
  if (!instance || typeof instance.module.onClientEvent !== 'function') {
    return { handled: false }
  }

  try {
    const result = await Promise.race([
      Promise.resolve(instance.module.onClientEvent(instance.ctx, event, data, meta)),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`onClientEvent timed out after ${ON_CLIENT_EVENT_TIMEOUT_MS}ms`)), ON_CLIENT_EVENT_TIMEOUT_MS)),
    ])
    return { handled: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    pushBackendConsole(appId, 'error', [`onClientEvent("${event}") failed: ${message}`])
    return { handled: true, error: message }
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
  const instance = await loadBackend(appId)
  if (!instance) return null
  if (!instance.handler) {
    return new Response(JSON.stringify({ error: { code: 'NO_HTTP_ROUTES', message: 'This backend only has lifecycle hooks. Export a default function returning a Hono app to add HTTP routes.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

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

    return await instance.handler.fetch(rewrittenRequest)
  } catch (err) {
    log.error({ appId, error: err instanceof Error ? err.message : String(err) }, 'Backend request error')
    return new Response(JSON.stringify({ error: { code: 'BACKEND_ERROR', message: 'Internal backend error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
