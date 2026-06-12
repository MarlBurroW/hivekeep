/**
 * Mini-App backend capabilities — the permission-gated bridge between a
 * mini-app's _server.js and the platform core (vault secrets, LLM completion,
 * Agent messaging/tasks), plus ungated-but-guarded helpers (SSRF-safe fetch,
 * scoped file storage under the app's `_data/` directory).
 *
 * Permission model:
 * - The app declares what it needs in app.json: `"permissions": ["llm", "secrets:MY_KEY", "agent:inform"]`
 * - The user approves (additively) via POST /api/mini-apps/:id/permissions —
 *   approved entries are stored in `mini_apps.granted_permissions`.
 * - A gated ctx member throws a descriptive error until its permission is granted.
 */

import { join, resolve, dirname } from 'path'
import { mkdir, unlink, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'

const log = createLogger('mini-app-capabilities')

// ─── Permission model ────────────────────────────────────────────────────────

/** Static permission ids a mini-app may request (plus dynamic `secrets:<KEY>`). */
export const MINI_APP_STATIC_PERMISSIONS = ['llm', 'agent:inform', 'agent:task'] as const

const SECRET_PERMISSION_RE = /^secrets:[A-Za-z0-9_.-]{1,128}$/

/** True when the string is a well-formed permission id. */
export function isKnownPermission(permission: string): boolean {
  return (
    (MINI_APP_STATIC_PERMISSIONS as readonly string[]).includes(permission) ||
    SECRET_PERMISSION_RE.test(permission)
  )
}

/** Parse the `permissions` array of an app.json manifest: well-formed entries only. */
export function parseRequestedPermissions(manifest: { permissions?: unknown }): string[] {
  if (!Array.isArray(manifest.permissions)) return []
  const seen = new Set<string>()
  for (const entry of manifest.permissions) {
    if (typeof entry === 'string' && isKnownPermission(entry)) seen.add(entry)
  }
  return [...seen]
}

/** Parse the `granted_permissions` DB column (JSON string[], null = none). */
export function parseGrantedPermissions(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string')
  } catch {
    // malformed — treat as no grants
  }
  return []
}

function permissionError(permission: string): Error {
  return new Error(
    `Permission "${permission}" not granted. Declare it in app.json under "permissions" ` +
      `and ask the user to approve it from the app panel (or via POST /api/mini-apps/:id/permissions).`,
  )
}

// ─── SSRF guard (shared with the /http proxy route) ──────────────────────────

/** Check if a hostname is a private/internal target that outbound calls must not reach */
export function isBlockedHost(hostname: string): boolean {
  // Block obvious private/internal hostnames
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) return true

  // Block private IP ranges
  const parts = hostname.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = parseInt(parts[0]!, 10)
    const b = parseInt(parts[1]!, 10)
    if (a === 10) return true                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true   // 172.16.0.0/12
    if (a === 192 && b === 168) return true            // 192.168.0.0/16
    if (a === 127) return true                         // 127.0.0.0/8
    if (a === 169 && b === 254) return true            // link-local
    if (a === 0) return true                           // 0.0.0.0/8
  }

  return false
}

const GUARDED_FETCH_TIMEOUT_MS = 30_000

/**
 * SSRF-guarded fetch for backend code (ctx.fetch): http(s) only, private hosts
 * blocked, bounded by a timeout unless the caller provides its own signal.
 */
export async function guardedFetch(url: string, options?: RequestInit): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`fetch: invalid URL "${url}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('fetch: only http and https URLs are allowed')
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('fetch: requests to private/internal hosts are not allowed')
  }

  if (options?.signal) return fetch(url, options)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`fetch timed out after ${GUARDED_FETCH_TIMEOUT_MS}ms`)), GUARDED_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

// ─── Rate limiting (per app, in-memory, survives backend reloads) ────────────

const RATE_LIMITS: Record<string, { max: number; windowMs: number }> = {
  llm: { max: 30, windowMs: 3_600_000 },
  'agent:inform': { max: 10, windowMs: 3_600_000 },
  'agent:task': { max: 5, windowMs: 3_600_000 },
}

const rateBuckets = new Map<string, number[]>() // `${appId}:${kind}` → timestamps

function checkRateLimit(appId: string, kind: keyof typeof RATE_LIMITS): void {
  const { max, windowMs } = RATE_LIMITS[kind]!
  const key = `${appId}:${kind}`
  const now = Date.now()
  const recent = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (recent.length >= max) {
    throw new Error(`${kind}: rate limit reached (max ${max} per hour for this app)`)
  }
  recent.push(now)
  rateBuckets.set(key, recent)
}

// ─── Scoped file storage (_data/) ────────────────────────────────────────────

const DATA_DIR_NAME = '_data'
const MAX_DATA_FILES_PER_APP = 1_000

function resolveDataPath(appDir: string, relativePath: string): string {
  const base = resolve(join(appDir, DATA_DIR_NAME))
  const target = resolve(base, relativePath)
  if (!target.startsWith(base + '/') && target !== base) {
    throw new Error('files: path traversal detected')
  }
  return target
}

export interface MiniAppFilesApi {
  read: (path: string) => Promise<string | null>
  write: (path: string, content: string | Uint8Array) => Promise<{ path: string; size: number }>
  delete: (path: string) => Promise<boolean>
  list: () => Promise<{ path: string; size: number }[]>
  exists: (path: string) => Promise<boolean>
}

/** Build the ctx.files API rooted at `<appDir>/_data/` (excluded from snapshots). */
export function buildFilesApi(appDir: string): MiniAppFilesApi {
  const maxBytes = config.miniApps.maxFileSizeMb * 1024 * 1024
  const base = () => join(appDir, DATA_DIR_NAME)

  async function walk(dir: string, root: string, out: { path: string; size: number }[]): Promise<void> {
    if (!existsSync(dir)) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, root, out)
      else {
        const s = await stat(full)
        out.push({ path: full.slice(root.length + 1), size: s.size })
      }
    }
  }

  return {
    read: async (path: string) => {
      const target = resolveDataPath(appDir, path)
      if (!existsSync(target)) return null
      return Bun.file(target).text()
    },
    write: async (path: string, content: string | Uint8Array) => {
      const target = resolveDataPath(appDir, path)
      const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content)
      if (buffer.length > maxBytes) {
        throw new Error(`files: file too large (max ${config.miniApps.maxFileSizeMb} MB)`)
      }
      if (!existsSync(target)) {
        const all: { path: string; size: number }[] = []
        await walk(base(), base(), all)
        if (all.length >= MAX_DATA_FILES_PER_APP) {
          throw new Error(`files: too many files (max ${MAX_DATA_FILES_PER_APP})`)
        }
      }
      await mkdir(dirname(target), { recursive: true })
      await Bun.write(target, buffer)
      return { path, size: buffer.length }
    },
    delete: async (path: string) => {
      const target = resolveDataPath(appDir, path)
      if (!existsSync(target)) return false
      await unlink(target)
      return true
    },
    list: async () => {
      const out: { path: string; size: number }[] = []
      await walk(base(), base(), out)
      return out
    },
    exists: async (path: string) => existsSync(resolveDataPath(appDir, path)),
  }
}

// ─── Gated capabilities ──────────────────────────────────────────────────────

export interface MiniAppSecretsApi {
  /** Read a vault secret. Requires the "secrets:<NAME>" permission. */
  get: (name: string) => Promise<string | null>
}

export interface MiniAppLlmApi {
  /** One-shot text completion via the platform's providers. Requires "llm". */
  complete: (prompt: string, opts?: { model?: string; providerId?: string; maxTokens?: number }) => Promise<string>
}

export interface MiniAppAgentApi {
  /** Drop an informational message into the maintainer Agent's queue. Requires "agent:inform". */
  inform: (text: string) => Promise<void>
  /** Spawn an async sub-task on the maintainer Agent. Requires "agent:task". */
  task: (description: string, opts?: { title?: string }) => Promise<{ taskId: string }>
}

export interface BuildCapabilitiesParams {
  appId: string
  agentId: string
  appName: string
  appDir: string
  granted: string[]
}

export function buildSecretsApi(params: BuildCapabilitiesParams): MiniAppSecretsApi {
  const grantedSet = new Set(params.granted)
  return {
    get: async (name: string) => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('secrets.get: name is required')
      const permission = `secrets:${name}`
      if (!SECRET_PERMISSION_RE.test(permission)) throw new Error(`secrets.get: invalid secret name "${name}"`)
      if (!grantedSet.has(permission)) throw permissionError(permission)
      const { getSecretValue } = await import('@/server/services/vault')
      return getSecretValue(name)
    },
  }
}

const LLM_TIMEOUT_MS = 60_000
const LLM_MAX_OUTPUT_TOKENS = 4_096

export function buildLlmApi(params: BuildCapabilitiesParams): MiniAppLlmApi {
  const grantedSet = new Set(params.granted)
  return {
    complete: async (prompt: string, opts?: { model?: string; providerId?: string; maxTokens?: number }) => {
      if (!grantedSet.has('llm')) throw permissionError('llm')
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('llm.complete: prompt is required')
      checkRateLimit(params.appId, 'llm')

      const { resolveLLM, pickAnyLLMModel } = await import('@/server/llm/core/resolve')
      const { safeGenerateText } = await import('@/server/services/llm-helpers')

      let resolved: import('@/server/llm/core/resolve').ResolvedLLM | null = null
      if (opts?.model) {
        resolved = await resolveLLM({ modelId: opts.model, providerId: opts.providerId ?? null })
      } else {
        // Default to the maintainer Agent's configured model, then any model.
        const { db } = await import('@/server/db/index')
        const { agents } = await import('@/server/db/schema')
        const { eq } = await import('drizzle-orm')
        const agent = db.select().from(agents).where(eq(agents.id, params.agentId)).get()
        if (agent?.model) {
          try {
            resolved = await resolveLLM({ modelId: agent.model, providerId: agent.providerId ?? null })
          } catch {
            resolved = null
          }
        }
        if (!resolved) resolved = await pickAnyLLMModel()
      }
      if (!resolved) throw new Error('llm.complete: no usable LLM provider configured')

      const maxTokens = Math.min(Math.max(1, opts?.maxTokens ?? 1_024), LLM_MAX_OUTPUT_TOKENS)
      const result = await safeGenerateText({
        resolved,
        prompt,
        maxTokens,
        timeoutMs: LLM_TIMEOUT_MS,
        callSite: 'mini-app-backend',
        agentId: params.agentId,
      })
      return result.text
    },
  }
}

const AGENT_TEXT_MAX_LENGTH = 4_000

export function buildAgentApi(params: BuildCapabilitiesParams): MiniAppAgentApi {
  const grantedSet = new Set(params.granted)
  return {
    inform: async (text: string) => {
      if (!grantedSet.has('agent:inform')) throw permissionError('agent:inform')
      if (typeof text !== 'string' || !text.trim()) throw new Error('agent.inform: text is required')
      if (text.length > AGENT_TEXT_MAX_LENGTH) throw new Error(`agent.inform: text exceeds ${AGENT_TEXT_MAX_LENGTH} characters`)
      checkRateLimit(params.appId, 'agent:inform')

      const { enqueueMessage } = await import('@/server/services/queue')
      await enqueueMessage({
        agentId: params.agentId,
        messageType: 'user',
        content:
          `📦 Message from the mini-app "${params.appName}" (id: ${params.appId}) backend:\n\n${text.trim()}`,
        sourceType: 'system',
        sourceId: params.appId,
      })
      log.info({ appId: params.appId, agentId: params.agentId }, 'Mini-app informed its maintainer Agent')
    },
    task: async (description: string, opts?: { title?: string }) => {
      if (!grantedSet.has('agent:task')) throw permissionError('agent:task')
      if (typeof description !== 'string' || !description.trim()) throw new Error('agent.task: description is required')
      if (description.length > AGENT_TEXT_MAX_LENGTH) throw new Error(`agent.task: description exceeds ${AGENT_TEXT_MAX_LENGTH} characters`)
      checkRateLimit(params.appId, 'agent:task')

      const { spawnTask } = await import('@/server/services/tasks')
      const { taskId } = await spawnTask({
        parentAgentId: params.agentId,
        title: opts?.title ?? `Mini-app "${params.appName}" task`,
        description:
          `Task requested by the mini-app "${params.appName}" (id: ${params.appId}) backend:\n\n${description.trim()}`,
        mode: 'async',
        spawnType: 'self',
      })
      log.info({ appId: params.appId, agentId: params.agentId, taskId }, 'Mini-app spawned a task')
      return { taskId }
    },
  }
}
