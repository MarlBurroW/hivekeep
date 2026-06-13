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
export const MINI_APP_STATIC_PERMISSIONS = ['llm', 'agent:inform', 'agent:task', 'channels:send'] as const

const SECRET_PERMISSION_RE = /^secrets:[A-Za-z0-9_.-]{1,128}$/

/** `platform:<resource>:<read|write>` — gates the platform REST API gateway. */
const PLATFORM_PERMISSION_RE = /^platform:[a-z][a-z0-9-]*:(read|write)$/

/** `events:<prefix>` — gates subscribing to platform events (ctx.on). */
const EVENTS_PERMISSION_RE = /^events:[a-z][a-z0-9-]*$/

/**
 * Event-type prefixes a mini-app may subscribe to via ctx.on(). The prefix is
 * the part before the first colon of an SSE event type. High-frequency / noisy
 * streams (chat:token, queue:update, *-token-usage, compacting:*, *-progress)
 * are deliberately excluded — a background handler firing per LLM token would be
 * a footgun. Subscribing to `task:done` requires the `events:task` permission.
 */
export const MINI_APP_SUBSCRIBABLE_EVENT_PREFIXES = new Set([
  'chat',       // chat:message, chat:done, chat:messages-deleted (NOT chat:token)
  'task',       // task:status, task:done, task:deleted
  'cron',       // cron:triggered, cron:created/updated/deleted
  'channel',    // channel:message-received/sent, channel:user-*, channel:*
  'notification',
  'contact',    // contact:created/updated/deleted
  'project',    // project:*, project-tag handled under its own prefix below
  'ticket',     // ticket:*
  'memory',     // memory:created/updated/deleted
  'trigger',    // trigger:fired/created/updated/deleted
  'webhook',    // webhook:triggered/created/updated/deleted
  'workspace',  // workspace:changed
  'miniapp',    // miniapp:created/updated/deleted/file-updated
  'agent',      // agent:created/updated/deleted/error (NOT agent token streams)
])

/** Event types never deliverable to a mini-app even if the prefix is allowed (noisy/internal). */
const EVENT_TYPE_DENYLIST = new Set([
  'chat:token',
  'chat:reasoning-token',
  'chat:reasoning-done',
  'chat:tool-call-start',
  'chat:tool-call',
  'chat:tool-result',
  'chat:token-usage',
  'task:token-usage',
  'task:todos',
  'queue:update',
  'agent:read',
  'agent:active-project',
])

/** The prefix of an SSE event type (part before the first colon). */
export function eventPrefix(eventType: string): string {
  return eventType.split(':')[0] ?? ''
}

/** True when a mini-app is allowed to subscribe to this event type at all. */
export function isSubscribableEvent(eventType: string): boolean {
  if (EVENT_TYPE_DENYLIST.has(eventType)) return false
  return MINI_APP_SUBSCRIBABLE_EVENT_PREFIXES.has(eventPrefix(eventType))
}

/**
 * Decide whether granted permissions allow subscribing to an event type.
 * Returns the denial reason, or null when allowed.
 */
export function checkEventAccess(
  granted: string[],
  eventType: string,
): { code: string; message: string } | null {
  if (!isSubscribableEvent(eventType)) {
    return {
      code: 'EVENT_NOT_SUBSCRIBABLE',
      message: `Event "${eventType}" is not subscribable from a mini-app (unknown or high-frequency/internal).`,
    }
  }
  if (!granted.includes(`events:${eventPrefix(eventType)}`)) {
    return {
      code: 'PERMISSION_REQUIRED',
      message: `This app needs the "events:${eventPrefix(eventType)}" permission to subscribe to "${eventType}". Declare it in app.json and have the user approve it.`,
    }
  }
  return null
}

/**
 * Resources that must NEVER be reachable through the generic platform gateway,
 * regardless of granted permissions. Covers auth/account internals, secret
 * VALUES, raw SQL, user/admin management, and — critically — `mini-apps` itself
 * (so an app can't grant ITSELF permissions or rewrite apps via the gateway).
 */
export const PLATFORM_GATEWAY_DENIED_RESOURCES = new Set([
  'auth',
  'onboarding',
  'vault',
  'database',
  'mini-apps',
  'users',
  'sse',
  'health',
  'uploads',
])

/** True when the string is a well-formed permission id. */
export function isKnownPermission(permission: string): boolean {
  return (
    (MINI_APP_STATIC_PERMISSIONS as readonly string[]).includes(permission) ||
    SECRET_PERMISSION_RE.test(permission) ||
    PLATFORM_PERMISSION_RE.test(permission) ||
    EVENTS_PERMISSION_RE.test(permission)
  )
}

/**
 * Map an incoming platform-gateway sub-path + method to its (resource, mode).
 * The resource is the first path segment; GET/HEAD are reads, everything else
 * is a write. Returns null when no resource can be derived.
 */
export function resolvePlatformResource(
  subPath: string,
  method: string,
): { resource: string; mode: 'read' | 'write' } | null {
  const resource = subPath.replace(/^\/+/, '').split('/')[0]?.split('?')[0] ?? ''
  if (!resource) return null
  const mode = method === 'GET' || method === 'HEAD' ? 'read' : 'write'
  return { resource, mode }
}

/**
 * Decide whether a set of granted permissions allows a gateway call.
 * A `:write` grant implies `:read` (if you can edit contacts, you can list them).
 * Returns the denial reason, or null when allowed.
 */
export function checkPlatformAccess(
  granted: string[],
  resource: string,
  mode: 'read' | 'write',
): { code: string; message: string } | null {
  if (PLATFORM_GATEWAY_DENIED_RESOURCES.has(resource)) {
    return {
      code: 'RESOURCE_FORBIDDEN',
      message: `The "${resource}" API is not accessible through the mini-app platform gateway.`,
    }
  }
  const allowed =
    mode === 'read'
      ? granted.includes(`platform:${resource}:read`) || granted.includes(`platform:${resource}:write`)
      : granted.includes(`platform:${resource}:write`)
  if (!allowed) {
    return {
      code: 'PERMISSION_REQUIRED',
      message: `This app needs the "platform:${resource}:${mode}" permission. Declare it in app.json under "permissions" and have the user approve it.`,
    }
  }
  return null
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
  'channels:send': { max: 20, windowMs: 3_600_000 },
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
      const { noteHotSecret } = await import('@/server/services/secret-substitution')
      const value = await getSecretValue(name)
      // Feed the output-redaction hot cache: if the mini-app ever echoes the
      // value somewhere an agent later reads through a tool (its console
      // logs, an endpoint response), the scrubber maps it back to
      // {{secret:NAME}} instead of letting it re-enter LLM context.
      if (value !== null) noteHotSecret(name, value)
      return value
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

// ─── Channels (platform messaging) ───────────────────────────────────────────

const CHANNEL_TEXT_MAX_LENGTH = 2_000

export interface MiniAppChannelsApi {
  /** List the platform's messaging channels (id, name, platform, status, owner). */
  list: () => Promise<{
    id: string
    name: string
    platform: string
    status: string
    ownerAgentName: string | null
    ownedByMaintainer: boolean
  }[]>
  /** Send a message through a channel to a known platform chat/user id. */
  send: (channelId: string, chatId: string, text: string) => Promise<{ platformMessageId: string }>
  /**
   * Send to a contact on a platform: resolves the contact (id or name), its
   * platform identifier, and an active channel of that platform automatically.
   */
  sendToContact: (contact: string, platform: string, text: string) => Promise<{
    platformMessageId: string
    sentTo: { contactId: string; displayName: string; chatId: string }
  }>
}

/**
 * ctx.channels — gated by the "channels:send" permission. Sends go through the
 * shared sendToChannelAs path (audit trail via sentByAgentId = the maintainer
 * Agent, cross-Agent prefixing, channel stats), exactly like Agent tools do.
 */
export function buildChannelsApi(params: BuildCapabilitiesParams): MiniAppChannelsApi {
  const grantedSet = new Set(params.granted)
  const requireGrant = () => {
    if (!grantedSet.has('channels:send')) throw permissionError('channels:send')
  }
  const validText = (text: string, member: string): string => {
    if (typeof text !== 'string' || !text.trim()) throw new Error(`${member}: text is required`)
    if (text.length > CHANNEL_TEXT_MAX_LENGTH) throw new Error(`${member}: text exceeds ${CHANNEL_TEXT_MAX_LENGTH} characters`)
    return text.trim()
  }

  return {
    list: async () => {
      requireGrant()
      const { listChannelsWithOwners } = await import('@/server/services/channels')
      const rows = await listChannelsWithOwners()
      return rows.map((c) => ({
        id: c.id,
        name: c.name,
        platform: c.platform,
        status: c.status,
        ownerAgentName: c.ownerAgentName ?? null,
        ownedByMaintainer: c.agentId === params.agentId,
      }))
    },

    send: async (channelId: string, chatId: string, text: string) => {
      requireGrant()
      if (typeof channelId !== 'string' || !channelId.trim()) throw new Error('channels.send: channelId is required')
      if (typeof chatId !== 'string' || !chatId.trim()) throw new Error('channels.send: chatId is required')
      const content = validText(text, 'channels.send')
      checkRateLimit(params.appId, 'channels:send')

      const { sendToChannelAs } = await import('@/server/services/channels')
      const sent = await sendToChannelAs({
        channelId,
        senderAgentId: params.agentId,
        chatId,
        content,
      })
      if (!sent.ok) throw new Error(`channels.send: ${sent.error}`)
      log.info({ appId: params.appId, channelId }, 'Mini-app sent a channel message')
      return { platformMessageId: sent.result.platformMessageId }
    },

    sendToContact: async (contact: string, platform: string, text: string) => {
      requireGrant()
      if (typeof contact !== 'string' || !contact.trim()) throw new Error('channels.sendToContact: contact is required')
      if (typeof platform !== 'string' || !platform.trim()) throw new Error('channels.sendToContact: platform is required')
      const content = validText(text, 'channels.sendToContact')
      checkRateLimit(params.appId, 'channels:send')

      const { getContactWithDetails, searchContacts } = await import('@/server/services/contacts')
      const { listChannels, sendToChannelAs } = await import('@/server/services/channels')

      // 1) Resolve the contact: id first, then unambiguous fuzzy match.
      let contactRecord = await getContactWithDetails(contact)
      if (!contactRecord) {
        const matches = await searchContacts(contact)
        if (matches.length === 0) throw new Error(`channels.sendToContact: no contact matches "${contact}"`)
        if (matches.length > 1) {
          throw new Error(`channels.sendToContact: ambiguous contact "${contact}" (${matches.length} matches) — use a contact id`)
        }
        contactRecord = matches[0]!
      }

      // 2) The contact's identifier on that platform.
      const platformLink = contactRecord.platformIds.find((p) => p.platform === platform)
      if (!platformLink) {
        const available = contactRecord.platformIds.map((p) => p.platform).join(', ') || '(none)'
        throw new Error(`channels.sendToContact: contact "${contactRecord.displayName}" has no identifier for platform "${platform}". Available: ${available}`)
      }

      // 3) An active channel for the platform — prefer the maintainer Agent's own.
      const allChannels = await listChannels()
      const candidates = allChannels.filter((c) => c.platform === platform && c.status === 'active')
      const channel = candidates.find((c) => c.agentId === params.agentId) ?? candidates[0]
      if (!channel) throw new Error(`channels.sendToContact: no active channel for platform "${platform}"`)

      const sent = await sendToChannelAs({
        channelId: channel.id,
        senderAgentId: params.agentId,
        chatId: platformLink.platformId,
        content,
      })
      if (!sent.ok) throw new Error(`channels.sendToContact: ${sent.error}`)
      log.info({ appId: params.appId, channelId: channel.id, contactId: contactRecord.id, platform }, 'Mini-app sent a message to a contact')
      return {
        platformMessageId: sent.result.platformMessageId,
        sentTo: { contactId: contactRecord.id, displayName: contactRecord.displayName, chatId: platformLink.platformId },
      }
    },
  }
}
