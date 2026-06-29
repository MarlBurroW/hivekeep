import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from '@/server/config'
import { join } from 'path'
import { existsSync } from 'fs'
import type { AppVariables } from '@/server/app'
import {
  createMiniApp,
  getMiniApp,
  getMiniAppBySlug,
  listMiniApps,
  updateMiniApp,
  setMiniAppMaintainer,
  deleteMiniApp,
  writeAppFile,
  readAppFile,
  deleteAppFile,
  listAppFiles,
  getMiniAppRow,
  getAppDir,
  guessMimeType,
  storageGet,
  storageSet,
  storageDelete,
  storageList,
  storageClear,
  createSnapshot,
  listSnapshots,
  rollbackToSnapshot,
  generateMiniAppIcon,
  getMiniAppPermissions,
  grantMiniAppPermissions,
} from '@/server/services/mini-apps'
import { ImageGenerationError } from '@/server/services/image-generation'
import { handleBackendRequest, handleClientEvent, getAppEmitter } from '@/server/services/mini-app-backend'
import { isBlockedHost, resolvePlatformResource, checkPlatformAccess } from '@/server/services/mini-app-capabilities'
import { pushConsoleEntry, getConsoleEntries, clearConsoleEntries, markServed } from '@/server/services/mini-app-console'
import {
  buildDefaultManifest,
  findBareModuleImports,
  htmlHasInlineImportMap,
  mergeDependenciesIntoManifest,
} from '@/server/services/mini-app-deps'
import { searchMemories, createMemory } from '@/server/services/memory'
import { sseManager } from '@/server/sse/index'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { enqueueMessage } from '@/server/services/queue'
import { formatMiniAppImproveRequest } from '@/server/services/mini-app-improve'
import { MAX_MESSAGE_LENGTH } from '@/shared/constants'

export const miniAppRoutes = new Hono<{ Variables: AppVariables }>()

// The hardened iframe runs at an opaque origin (Origin: null) and authenticates
// with the app token (header), not cookies — so its calls to its own namespace
// are cross-origin and need CORS. No credentials are used, so a permissive
// origin is safe; the app-token + namespace scoping is what authorizes the call.
miniAppRoutes.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-hivekeep-app-token'],
  maxAge: 600,
}))

// ─── Lookup by slug ─────────────────────────────────────────────────────────

miniAppRoutes.get('/by-slug/:agentId/:slug', async (c) => {
  const { agentId, slug } = c.req.param()
  const found = await getMiniAppBySlug(agentId, slug)
  if (!found) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }
  return c.json({ app: found })
})

// Generate icon for a mini-app using AI image generation
miniAppRoutes.post('/:id/generate-icon', async (c) => {
  const body = await c.req.json<{ providerId?: string; modelId?: string }>().catch(() => ({} as { providerId?: string; modelId?: string }))
  try {
    const app = await generateMiniAppIcon(c.req.param('id'), {
      providerId: body.providerId,
      modelId: body.modelId,
    })
    sseManager.broadcast({ type: 'miniapp:updated', agentId: app.maintainerAgentId, data: { app } })
    return c.json({ app })
  } catch (err) {
    if (err instanceof ImageGenerationError) {
      if (err.code === 'NO_IMAGE_PROVIDER') {
        return c.json({ error: { code: 'NO_IMAGE_PROVIDER', message: err.message } }, 422)
      }
      return c.json({ error: { code: 'IMAGE_GENERATION_FAILED', message: err.message } }, 502)
    }
    const message = err instanceof Error ? err.message : 'Failed to generate icon'
    if (message === 'Mini-app not found') {
      return c.json({ error: { code: 'NOT_FOUND', message } }, 404)
    }
    return c.json({ error: { code: 'IMAGE_GENERATION_FAILED', message } }, 502)
  }
})

// ─── CRUD ────────────────────────────────────────────────────────────────────

// List apps for an agent
miniAppRoutes.get('/', async (c) => {
  const agentId = c.req.query('agentId')
  if (agentId) {
    const apps = await listMiniApps(agentId)
    return c.json({ apps })
  }
  // No agentId → return all apps across all Agents
  const { listAllMiniApps } = await import('@/server/services/mini-apps')
  const apps = await listAllMiniApps()
  return c.json({ apps })
})

// Get app details
miniAppRoutes.get('/:id', async (c) => {
  const app = await getMiniApp(c.req.param('id'))
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }
  return c.json({ app })
})

// Create app
miniAppRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    agentId: string
    name: string
    slug: string
    description?: string
    icon?: string
    html?: string
    files?: Record<string, string>
    dependencies?: Record<string, string>
  }>()

  if (!body.agentId || !body.name || !body.slug) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'agentId, name, and slug are required' } }, 400)
  }

  try {
    // Assemble the file set in memory (precedence: files > html).
    const fileset: Record<string, string> = { ...(body.files ?? {}) }
    if (body.html && fileset['index.html'] === undefined) fileset['index.html'] = body.html

    let warning: string | undefined
    if (body.dependencies && Object.keys(body.dependencies).length > 0) {
      fileset['app.json'] = mergeDependenciesIntoManifest(fileset['app.json'], body.dependencies)
    }

    const entryHtml = fileset['index.html']
    if (
      entryHtml !== undefined &&
      fileset['app.json'] === undefined &&
      !htmlHasInlineImportMap(entryHtml) &&
      findBareModuleImports(entryHtml).length > 0
    ) {
      fileset['app.json'] = buildDefaultManifest()
      warning =
        'No app.json or import map was provided, but your HTML imports bare ES modules. ' +
        'A default app.json (react, react-dom/client, @hivekeep/react, @hivekeep/components) was created automatically.'
    }

    const app = await createMiniApp({
      agentId: body.agentId,
      name: body.name,
      slug: body.slug,
      description: body.description,
      icon: body.icon,
    })

    for (const [filePath, content] of Object.entries(fileset)) {
      await writeAppFile(app.id, filePath, content)
    }

    sseManager.broadcast({ type: 'miniapp:created', agentId: body.agentId, data: { app } })
    return c.json({ app, warning }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create app'
    return c.json({ error: { code: 'CREATE_FAILED', message } }, 400)
  }
})

// Update app metadata (and optionally reassign the maintainer Agent)
miniAppRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    name?: string
    description?: string | null
    icon?: string | null
    entryFile?: string
    isActive?: boolean
    maintainerAgentId?: string
  }>()

  // Reassign maintainer first (this also moves the app's on-disk directory).
  if (body.maintainerAgentId !== undefined) {
    const targetAgentId = resolveAgentId(body.maintainerAgentId)
    if (!targetAgentId) {
      return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Target Agent not found' } }, 400)
    }
    try {
      const moved = await setMiniAppMaintainer(id, targetAgentId)
      if (!moved) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
      sseManager.broadcast({ type: 'miniapp:updated', agentId: moved.maintainerAgentId, data: { app: moved } })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reassign maintainer'
      return c.json({ error: { code: 'REASSIGN_FAILED', message } }, 400)
    }
  }

  const app = await updateMiniApp(id, body)
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  sseManager.broadcast({ type: 'miniapp:updated', agentId: app.maintainerAgentId, data: { app } })
  return c.json({ app })
})

// Delete app — any Agent / the user can delete any app (decoupled)
miniAppRoutes.delete('/:id', async (c) => {
  const existing = await getMiniApp(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  await deleteMiniApp(c.req.param('id'))
  sseManager.broadcast({ type: 'miniapp:deleted', agentId: existing.maintainerAgentId, data: { appId: existing.id } })
  return c.body(null, 204)
})

// Improve this app — send the user's improvement request into the maintainer
// Agent's MAIN conversation so it does the work.
miniAppRoutes.post('/:id/improve', async (c) => {
  const user = c.get('user') as { id: string; name: string }
  const app = await getMiniApp(c.req.param('id'))
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  const body = await c.req.json<{ description?: string }>().catch(() => ({} as { description?: string }))
  const description = (body.description ?? '').trim()
  if (!description) {
    return c.json({ error: { code: 'EMPTY_DESCRIPTION', message: 'A description of the change is required' } }, 400)
  }
  if (description.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: { code: 'DESCRIPTION_TOO_LONG', message: `Description exceeds ${MAX_MESSAGE_LENGTH} characters` } }, 400)
  }

  const content = formatMiniAppImproveRequest({
    appName: app.name,
    appSlug: app.slug,
    appId: app.id,
    description,
    requesterName: user.name,
  })

  await enqueueMessage({
    agentId: app.maintainerAgentId,
    messageType: 'user',
    content,
    sourceType: 'user',
    sourceId: user.id,
  })

  return c.json({ maintainerAgentId: app.maintainerAgentId, maintainerAgentName: app.maintainerAgentName })
})

// ─── File management ────────────────────────────────────────────────────────

// List files
miniAppRoutes.get('/:id/files', async (c) => {
  try {
    const files = await listAppFiles(c.req.param('id'))
    return c.json({ files })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list files'
    return c.json({ error: { code: 'LIST_FAILED', message } }, 400)
  }
})

// Read a file (raw content)
miniAppRoutes.get('/:id/files/*', async (c) => {
  const filePath = c.req.path.replace(`/api/mini-apps/${c.req.param('id')}/files/`, '')
  if (!filePath) {
    return c.json({ error: { code: 'MISSING_PATH', message: 'File path is required' } }, 400)
  }

  try {
    const buffer = await readAppFile(c.req.param('id'), filePath)
    return new Response(new Uint8Array(buffer), {
      headers: { 'Content-Type': guessMimeType(filePath) },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read file'
    return c.json({ error: { code: 'READ_FAILED', message } }, 404)
  }
})

// Write a file
miniAppRoutes.put('/:id/files/*', async (c) => {
  const filePath = c.req.path.replace(`/api/mini-apps/${c.req.param('id')}/files/`, '')
  if (!filePath) {
    return c.json({ error: { code: 'MISSING_PATH', message: 'File path is required' } }, 400)
  }

  try {
    const contentType = c.req.header('Content-Type') ?? ''
    let content: string | Buffer
    if (contentType.includes('application/json')) {
      const body = await c.req.json<{ content: string; isBase64?: boolean }>()
      content = body.isBase64 ? Buffer.from(body.content, 'base64') : body.content
    } else {
      content = Buffer.from(await c.req.arrayBuffer())
    }

    const result = await writeAppFile(c.req.param('id'), filePath, content)

    // Get updated app for version
    const app = await getMiniAppRow(c.req.param('id'))
    if (app) {
      sseManager.broadcast({
        type: 'miniapp:file-updated',
        agentId: app.agentId,
        data: { appId: app.id, path: filePath, version: app.version },
      })
    }

    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to write file'
    return c.json({ error: { code: 'WRITE_FAILED', message } }, 400)
  }
})

// Delete a file
miniAppRoutes.delete('/:id/files/*', async (c) => {
  const filePath = c.req.path.replace(`/api/mini-apps/${c.req.param('id')}/files/`, '')
  if (!filePath) {
    return c.json({ error: { code: 'MISSING_PATH', message: 'File path is required' } }, 400)
  }

  try {
    const deleted = await deleteAppFile(c.req.param('id'), filePath)
    if (!deleted) {
      return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404)
    }

    const app = await getMiniAppRow(c.req.param('id'))
    if (app) {
      sseManager.broadcast({
        type: 'miniapp:file-updated',
        agentId: app.agentId,
        data: { appId: app.id, path: filePath, version: app.version },
      })
    }

    return c.body(null, 204)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete file'
    return c.json({ error: { code: 'DELETE_FAILED', message } }, 400)
  }
})

// ─── Key-Value Storage ──────────────────────────────────────────────────────

// List all keys
miniAppRoutes.get('/:id/storage', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  try {
    const keys = await storageList(app.id)
    return c.json({ keys })
  } catch (err) {
    return c.json({ error: { code: 'STORAGE_ERROR', message: String(err) } }, 500)
  }
})

// Get a value
miniAppRoutes.get('/:id/storage/:key', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const value = await storageGet(app.id, c.req.param('key'))
  if (value === null) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Key not found' } }, 404)
  }
  return c.json({ key: c.req.param('key'), value: JSON.parse(value) })
})

// Set a value
miniAppRoutes.put('/:id/storage/:key', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  try {
    const body = await c.req.json<{ value: unknown }>()
    await storageSet(app.id, c.req.param('key'), JSON.stringify(body.value))
    return c.json({ key: c.req.param('key'), ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Storage error'
    return c.json({ error: { code: 'STORAGE_ERROR', message } }, 400)
  }
})

// Delete a key
miniAppRoutes.delete('/:id/storage/:key', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const deleted = await storageDelete(app.id, c.req.param('key'))
  if (!deleted) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Key not found' } }, 404)
  }
  return c.body(null, 204)
})

// Clear all storage
miniAppRoutes.delete('/:id/storage', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const count = await storageClear(app.id)
  return c.json({ cleared: count })
})

// ─── Snapshots ──────────────────────────────────────────────────────────────

// List snapshots for an app
miniAppRoutes.get('/:id/snapshots', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  try {
    const snapshots = await listSnapshots(app.id)
    return c.json({
      currentVersion: app.version,
      snapshots: snapshots.map((s) => ({
        version: s.version,
        label: s.label,
        fileCount: s.files.length,
        files: s.files.map((f: { path: string }) => f.path),
        createdAt: new Date(s.createdAt).toISOString(),
      })),
    })
  } catch (err) {
    return c.json({ error: { code: 'SNAPSHOT_ERROR', message: String(err) } }, 500)
  }
})

// Create a snapshot
miniAppRoutes.post('/:id/snapshots', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const body = await c.req.json<{ label?: string }>().catch(() => ({ label: undefined }))
  try {
    const snapshot = await createSnapshot(app.id, body.label)
    if (!snapshot) return c.json({ error: { code: 'NO_FILES', message: 'No files to snapshot' } }, 400)
    return c.json({ snapshot: { version: snapshot.version, label: snapshot.label, fileCount: snapshot.files.length } }, 201)
  } catch (err) {
    return c.json({ error: { code: 'SNAPSHOT_ERROR', message: String(err) } }, 500)
  }
})

// Rollback to a snapshot version
miniAppRoutes.post('/:id/snapshots/:version/rollback', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const version = parseInt(c.req.param('version'), 10)
  if (isNaN(version) || version < 1) {
    return c.json({ error: { code: 'INVALID_VERSION', message: 'Invalid version number' } }, 400)
  }

  try {
    const result = await rollbackToSnapshot(app.id, version)
    if (!result.success) {
      return c.json({ error: { code: 'ROLLBACK_FAILED', message: result.message } }, 400)
    }

    const updated = await getMiniApp(app.id)
    if (updated) {
      sseManager.broadcast({ type: 'miniapp:updated', agentId: app.agentId, data: { app: updated } })
    }

    return c.json({ message: result.message })
  } catch (err) {
    return c.json({ error: { code: 'ROLLBACK_ERROR', message: String(err) } }, 500)
  }
})

// ─── HTTP Proxy ─────────────────────────────────────────────────────────────

// Rate-limit state: appId → { count, resetAt }
const httpProxyLimits = new Map<string, { count: number; resetAt: number }>()
const HTTP_PROXY_MAX_PER_MINUTE = 60
const HTTP_PROXY_MAX_RESPONSE_BYTES = 5 * 1024 * 1024 // 5 MB
const HTTP_PROXY_TIMEOUT_MS = 15_000

/**
 * HTTP proxy for mini-apps — lets them fetch external APIs without CORS issues.
 * POST /api/mini-apps/:id/http
 * Body: { url, method?, headers?, body? }
 * Returns: { status, statusText, headers, body }
 */
miniAppRoutes.post('/:id/http', async (c) => {
  const appId = c.req.param('id')
  const app = await getMiniAppRow(appId)
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  // Rate limiting
  const now = Date.now()
  let limit = httpProxyLimits.get(appId)
  if (!limit || now > limit.resetAt) {
    limit = { count: 0, resetAt: now + 60_000 }
    httpProxyLimits.set(appId, limit)
  }
  limit.count++
  if (limit.count > HTTP_PROXY_MAX_PER_MINUTE) {
    return c.json({ error: { code: 'RATE_LIMITED', message: `Rate limited: max ${HTTP_PROXY_MAX_PER_MINUTE} requests per minute` } }, 429)
  }

  let body: { url: string; method?: string; headers?: Record<string, string>; body?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: { code: 'INVALID_BODY', message: 'Request body must be JSON with a "url" field' } }, 400)
  }

  if (!body.url || typeof body.url !== 'string') {
    return c.json({ error: { code: 'MISSING_URL', message: '"url" field is required' } }, 400)
  }

  // Validate URL
  let parsedUrl: URL
  try {
    parsedUrl = new URL(body.url)
  } catch {
    return c.json({ error: { code: 'INVALID_URL', message: 'Invalid URL' } }, 400)
  }

  // Only allow http(s)
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return c.json({ error: { code: 'INVALID_PROTOCOL', message: 'Only http and https URLs are allowed' } }, 400)
  }

  // Block private IPs
  if (isBlockedHost(parsedUrl.hostname)) {
    return c.json({ error: { code: 'BLOCKED_HOST', message: 'Requests to private/internal hosts are not allowed' } }, 403)
  }

  // Validate method
  const method = (body.method || 'GET').toUpperCase()
  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
  if (!allowedMethods.includes(method)) {
    return c.json({ error: { code: 'INVALID_METHOD', message: `Method "${method}" is not allowed` } }, 400)
  }

  // Build headers (strip dangerous ones)
  const outHeaders: Record<string, string> = {}
  if (body.headers && typeof body.headers === 'object') {
    for (const [k, v] of Object.entries(body.headers)) {
      const lower = k.toLowerCase()
      // Block hop-by-hop and dangerous headers
      if (['host', 'cookie', 'set-cookie', 'transfer-encoding', 'connection', 'upgrade'].includes(lower)) continue
      if (typeof v === 'string') outHeaders[k] = v
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HTTP_PROXY_TIMEOUT_MS)

    const resp = await fetch(body.url, {
      method,
      headers: outHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? body.body : undefined,
      signal: controller.signal,
      redirect: 'follow',
    })

    clearTimeout(timeout)

    // Read response with size limit
    const chunks: Uint8Array[] = []
    let totalSize = 0

    if (resp.body) {
      const reader = resp.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        totalSize += value.byteLength
        if (totalSize > HTTP_PROXY_MAX_RESPONSE_BYTES) {
          reader.cancel()
          return c.json({ error: { code: 'RESPONSE_TOO_LARGE', message: `Response exceeds ${HTTP_PROXY_MAX_RESPONSE_BYTES / 1024 / 1024}MB limit` } }, 502)
        }
        chunks.push(value)
      }
    }

    // Combine chunks and encode to base64 or text
    const combined = new Uint8Array(totalSize)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    const contentType = resp.headers.get('content-type') || ''
    const isText = contentType.includes('text') || contentType.includes('json') || contentType.includes('xml') || contentType.includes('javascript') || contentType.includes('html')

    // Extract response headers (skip set-cookie and other sensitive ones)
    const respHeaders: Record<string, string> = {}
    resp.headers.forEach((v, k) => {
      const lower = k.toLowerCase()
      if (!['set-cookie', 'transfer-encoding', 'connection'].includes(lower)) {
        respHeaders[k] = v
      }
    })

    return c.json({
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      body: isText ? new TextDecoder().decode(combined) : Buffer.from(combined).toString('base64'),
      isBase64: !isText,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy request failed'
    if (message.includes('abort')) {
      return c.json({ error: { code: 'TIMEOUT', message: `Request timed out after ${HTTP_PROXY_TIMEOUT_MS / 1000}s` } }, 504)
    }
    return c.json({ error: { code: 'PROXY_ERROR', message } }, 502)
  }
})

// ─── Memory Access ──────────────────────────────────────────────────────────

// GET /api/mini-apps/:id/memories/search?q=...&limit=N — semantic search memories
miniAppRoutes.get('/:id/memories/search', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const query = c.req.query('q')
  if (!query) return c.json({ error: { code: 'MISSING_QUERY', message: 'q query parameter is required' } }, 400)

  const limit = Math.min(Math.max(1, Number(c.req.query('limit') ?? 20)), 50)

  const results = await searchMemories(app.agentId, query, limit)
  return c.json({
    memories: results.map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      subject: m.subject,
      score: m.score,
      updatedAt: m.updatedAt,
    })),
  })
})

// POST /api/mini-apps/:id/memories — store a new memory
miniAppRoutes.post('/:id/memories', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const body = await c.req.json<{ content: string; category?: string; subject?: string }>().catch(() => null)
  if (!body || !body.content || typeof body.content !== 'string') {
    return c.json({ error: { code: 'INVALID_BODY', message: 'content (string) is required' } }, 400)
  }
  if (body.content.length > 2000) {
    return c.json({ error: { code: 'CONTENT_TOO_LONG', message: 'content must be 2000 characters or less' } }, 400)
  }

  const validCategories = ['fact', 'preference', 'decision', 'knowledge'] as const
  const category = validCategories.includes(body.category as any) ? (body.category as typeof validCategories[number]) : 'knowledge'

  const memory = await createMemory(app.agentId, {
    content: body.content,
    category,
    subject: body.subject || null,
    sourceChannel: 'explicit',
  })

  return c.json({
    memory: { id: memory.id, content: memory.content, category: memory.category, subject: memory.subject, createdAt: memory.createdAt },
  }, 201)
})

// ─── Backend SSE Events ─────────────────────────────────────────────────────

// SSE endpoint for real-time events from mini-app backends
miniAppRoutes.get('/:id/events', async (c) => {
  const appId = c.req.param('id')
  const app = await getMiniAppRow(appId)
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  const user = c.get('user') as { id: string } | undefined
  const emitter = getAppEmitter(appId)

  // Create a readable stream that pushes SSE events
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      // Send initial connection event
      controller.enqueue(encoder.encode(`event: connected\ndata: ${JSON.stringify({ appId })}\n\n`))

      // Keep-alive ping every 30s
      const pingInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`))
        } catch {
          clearInterval(pingInterval)
        }
      }, 30_000)

      // Subscribe to app events, tagged with the session user so the backend
      // can target a single user via ctx.events.emit(event, data, { userId })
      const unsubscribe = emitter._subscribe((event: string, data: unknown) => {
        try {
          const payload = JSON.stringify({ event, data, timestamp: Date.now() })
          controller.enqueue(encoder.encode(`event: app-event\ndata: ${payload}\n\n`))
        } catch {
          // Client disconnected
          clearInterval(pingInterval)
          unsubscribe()
        }
      }, user?.id)

      // Clean up when the client disconnects
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(pingInterval)
        unsubscribe()
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// ─── Capability permissions ──────────────────────────────────────────────────

// Permission state: requested in app.json vs granted by the user
miniAppRoutes.get('/:id/permissions', async (c) => {
  const state = await getMiniAppPermissions(c.req.param('id'))
  if (!state) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  return c.json(state)
})

// Grant requested permissions (additive). Body: { grant: string[] }
miniAppRoutes.post('/:id/permissions', async (c) => {
  const body = await c.req.json<{ grant?: string[] }>().catch(() => null)
  if (!body || !Array.isArray(body.grant) || body.grant.length === 0) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'grant (non-empty string[]) is required' } }, 400)
  }

  const result = await grantMiniAppPermissions(c.req.param('id'), body.grant)
  if (!result) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const app = await getMiniApp(c.req.param('id'))
  if (app) {
    sseManager.broadcast({ type: 'miniapp:updated', agentId: app.maintainerAgentId, data: { app } })
  }

  return c.json(result)
})

// ─── Platform API gateway ────────────────────────────────────────────────────
//
// Permission-gated proxy to Hivekeep's OWN REST API, so a mini-app UI can manage
// any platform resource the way the settings pages do (a contacts manager, a
// crons board…) without us hand-wrapping each resource. The call is re-dispatched
// to the real /api/<resource> route carrying the user's session, after checking
// the app's granted `platform:<resource>:<read|write>` permission.
//
// The platform gateway: the iframe (opaque origin, app-token auth) calls this
// route, which re-dispatches to the real REST API server-side AS the user. The
// iframe never reaches /api/<resource> itself: with allow-same-origin dropped it
// has no cookie, and the app token is scoped to /api/mini-apps/<id>/* only.
miniAppRoutes.all('/:id/platform/*', async (c) => {
  const appId = c.req.param('id')
  const app = await getMiniAppRow(appId)
  if (!app) return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)

  const subPath = c.req.path.replace(`/api/mini-apps/${appId}/platform`, '') || '/'
  const resolved = resolvePlatformResource(subPath, c.req.method)
  if (!resolved) {
    return c.json({ error: { code: 'INVALID_PATH', message: 'A platform resource path is required, e.g. /contacts' } }, 400)
  }

  const perms = await getMiniAppPermissions(appId)
  const denial = checkPlatformAccess(perms?.granted ?? [], resolved.resource, resolved.mode)
  if (denial) {
    return c.json({ error: denial }, 403)
  }

  const actor = c.get('user') as { id: string } | undefined
  if (!actor?.id) return c.json({ error: { code: 'UNAUTHORIZED', message: 'No actor for gateway' } }, 401)

  // Re-dispatch to the real REST route AS the user, via the in-process internal
  // actor header (the iframe has no cookie). Strip the app token + iframe
  // Referer/Sec-Fetch so the inner request authenticates purely as the actor.
  const url = new URL(c.req.url)
  url.pathname = `/api/${subPath.replace(/^\/+/, '')}`
  const isBodyless = c.req.method === 'GET' || c.req.method === 'HEAD'
  const innerHeaders = new Headers(c.req.raw.headers)
  innerHeaders.set('x-hivekeep-internal-actor', actor.id)
  innerHeaders.delete('x-hivekeep-app-token')
  innerHeaders.delete('referer')
  innerHeaders.delete('sec-fetch-site')
  innerHeaders.delete('sec-fetch-dest')
  innerHeaders.delete('sec-fetch-mode')
  const innerReq = new Request(url.toString(), {
    method: c.req.method,
    headers: innerHeaders,
    body: isBodyless ? undefined : c.req.raw.body,
    // @ts-ignore - duplex needed for streaming bodies in Bun
    duplex: 'half',
  })

  const { app: honoApp } = await import('@/server/app')
  return honoApp.fetch(innerReq)
})

// Upstream client events: frontend Hivekeep.events.send() → backend onClientEvent()
miniAppRoutes.post('/:id/client-event', async (c) => {
  const appId = c.req.param('id')
  const app = await getMiniAppRow(appId)
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }
  if (!app.hasBackend) {
    return c.json({ error: { code: 'NO_BACKEND', message: 'This app has no backend. Write a _server.js file to add one.' } }, 404)
  }

  const body = await c.req.json<{ event?: string; data?: unknown }>().catch(() => null)
  if (!body || typeof body.event !== 'string' || !body.event.trim()) {
    return c.json({ error: { code: 'INVALID_BODY', message: 'event (string) is required' } }, 400)
  }

  const user = c.get('user') as { id: string; name?: string }
  const result = await handleClientEvent(appId, body.event, body.data, {
    userId: user.id,
    userName: user.name ?? null,
  })

  if (result.error) {
    return c.json({ error: { code: 'CLIENT_EVENT_ERROR', message: result.error } }, 500)
  }
  return c.json({ handled: result.handled, result: result.result ?? null })
})

// ─── Backend API proxy ──────────────────────────────────────────────────────

// Proxy requests to mini-app _server.js backends
miniAppRoutes.all('/:id/api/*', async (c) => {
  const appId = c.req.param('id')
  const app = await getMiniAppRow(appId)
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }
  if (!app.hasBackend) {
    return c.json({ error: { code: 'NO_BACKEND', message: 'This app has no backend. Write a _server.js file to add one.' } }, 404)
  }

  // Extract the path after /api/mini-apps/:id/api/
  const apiPath = c.req.path.replace(`/api/mini-apps/${appId}/api`, '') || '/'

  const response = await handleBackendRequest(appId, c.req.raw, apiPath)
  if (!response) {
    return c.json({ error: { code: 'BACKEND_UNAVAILABLE', message: 'Backend failed to load' } }, 500)
  }

  return response
})

// ─── Serve (for iframe) ────────────────────────────────────────────────────

// Theme sync script injected into served HTML. The iframe runs at an opaque
// origin (no allow-same-origin), so it CANNOT read parent.document — the parent
// (MiniAppViewer) pushes the theme via postMessage on load and on change.
const THEME_SYNC_SCRIPT = `<script>
(function(){
  function apply(t){
    try{
      var r=document.documentElement;
      r.classList.toggle('dark',!!t.dark);
      if(t.palette)r.setAttribute('data-palette',t.palette);else r.removeAttribute('data-palette');
      if(t.contrast)r.setAttribute('data-contrast',t.contrast);else r.removeAttribute('data-contrast');
    }catch(e){}
  }
  window.addEventListener('message',function(ev){
    var m=ev.data;
    if(m&&m.source==='gezy-parent'&&m.type==='theme'&&m.data)apply(m.data);
  });
})();
</script>`

const SDK_LINK = '<link rel="stylesheet" href="/api/mini-apps/sdk/gezy-sdk.css">'
const SDK_SCRIPT = '<script src="/api/mini-apps/sdk/gezy-sdk.js"></script>'

/** Base tag so relative paths (src="app.js", import "./utils.js") resolve to the static directory */
function baseTag(appId: string): string {
  return `<base href="/api/mini-apps/${appId}/static/">`
}

// Content-Security-Policy for mini-app iframes.
// The iframe runs at an OPAQUE origin (sandbox without allow-same-origin), so
// `'self'` no longer designates the app host — every directive that must reach
// the app host (loading the SDK + static assets, fetching its own /api namespace)
// gets the concrete origin instead. Allows inline scripts/styles (SDK injection
// + app code), the app origin, popular CDNs, and data:/blob:.
function buildMiniAppCsp(origins: string[]): string {
  // `origin` here is a space-separated list of the app host origin(s). The iframe
  // is an opaque document, so `'self'` no longer designates the host — directives
  // that must reach it carry the explicit origin(s). We include both the
  // request-derived origin AND config.publicUrl so a reverse proxy that doesn't
  // set x-forwarded-proto (wrong scheme) can't break SDK/module loading.
  const origin = [...new Set(origins.filter(Boolean))].join(' ')
  return [
    `default-src 'self' ${origin}`,
    `script-src 'self' ${origin} 'unsafe-inline' 'unsafe-eval' https://esm.sh https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com`,
    `style-src 'self' ${origin} 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com`,
    `img-src 'self' ${origin} data: blob: https:`,
    `font-src 'self' ${origin} data: https://fonts.gstatic.com https://cdn.jsdelivr.net`,
    `connect-src 'self' ${origin} https://esm.sh https://cdn.jsdelivr.net https://unpkg.com`,
    `media-src 'self' ${origin} blob: data:`,
    "frame-src 'none'",
    "object-src 'none'",
    `base-uri 'self' ${origin}`,
  ].join('; ')
}

/** Try to read and parse app.json manifest from the app directory */
async function readAppManifest(dir: string): Promise<Record<string, unknown> | null> {
  const manifestPath = join(dir, 'app.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(await Bun.file(manifestPath).text())
  } catch {
    return null
  }
}

/** Build an importmap script tag from app.json manifest */
function buildImportMapTag(manifest: Record<string, unknown>): string {
  // Support either full "importmap" object or shorthand "dependencies" map
  let importmap: Record<string, unknown> | null = null

  if (manifest.importmap && typeof manifest.importmap === 'object') {
    importmap = manifest.importmap as Record<string, unknown>
  } else if (manifest.dependencies && typeof manifest.dependencies === 'object') {
    // Convert shorthand { "react": "https://esm.sh/react@19" } to importmap format
    importmap = { imports: manifest.dependencies }
  }

  if (!importmap) return ''

  // Validate: must have "imports" at minimum
  if (!importmap.imports || typeof importmap.imports !== 'object') return ''

  return `<script type="importmap">${JSON.stringify(importmap)}</script>`
}

// ─── JSX transpilation (Bun built-in) ────────────────────────────────────────

const JSX_TSCONFIG = JSON.stringify({
  compilerOptions: { jsx: 'react', jsxFactory: 'React.createElement', jsxFragmentFactory: 'React.Fragment' },
})
const jsxTranspiler = new Bun.Transpiler({ loader: 'jsx', tsconfig: JSX_TSCONFIG })
const tsxTranspiler = new Bun.Transpiler({ loader: 'tsx', tsconfig: JSX_TSCONFIG })

/** Ensure `import React from 'react'` is present (needed for classic JSX transform). */
function ensureReactImport(code: string): string {
  // Check if React is already imported as default or namespace
  if (/import\s+React[\s,{]/m.test(code) || /import\s+\*\s+as\s+React/m.test(code)) return code
  return "import React from 'react';\n" + code
}

/**
 * Find <script type="text/jsx"> blocks in HTML and transpile them to ES modules.
 * Uses Bun's built-in transpiler in classic mode (React.createElement).
 */
function transpileInlineJsx(html: string): string {
  return html.replace(
    /<script\s+type="text\/jsx">([\s\S]*?)<\/script>/gi,
    (_, code: string) => {
      try {
        const transpiled = jsxTranspiler.transformSync(ensureReactImport(code))
        return `<script type="module">${transpiled}</script>`
      } catch (err) {
        console.error('[mini-app] JSX transpilation failed:', err)
        return `<script type="module">console.error('[Hivekeep] JSX transpilation failed — check your JSX syntax');</script>`
      }
    },
  )
}

// Serve the entry point HTML with injected SDK
miniAppRoutes.get('/:id/serve', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  const dir = getAppDir(app.agentId, app.id)
  const entryPath = join(dir, app.entryFile)

  if (!existsSync(entryPath)) {
    return new Response('<html><body><p>App entry file not found.</p></body></html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      status: 404,
    })
  }

  let html = await Bun.file(entryPath).text()

  // Transpile inline JSX blocks: <script type="text/jsx"> → <script type="module">
  html = transpileInlineJsx(html)

  // Read app.json manifest for import maps
  const manifest = await readAppManifest(dir)
  const importMapTag = manifest ? buildImportMapTag(manifest) : ''

  // If the app uses bare ES imports but no import map could be built, surface a clear,
  // actionable error in the console (the cryptic "Failed to resolve module specifier" would
  // otherwise be all the Agent sees). This message flows into the console buffer.
  let moduleHelpTag = ''
  if (!importMapTag && !htmlHasInlineImportMap(html) && findBareModuleImports(html).length > 0) {
    const help =
      "[Hivekeep] This mini-app imports ES modules (e.g. 'react') but no import map was found. " +
      'Add an app.json with a "dependencies" map (or pass `dependencies` to create_mini_app). ' +
      "See get_mini_app_docs('getting-started')."
    moduleHelpTag = `<script>console.error(${JSON.stringify(help)})</script>`
  }

  // Track the (re)load so tools can tell whether the iframe picked up recent changes.
  markServed(app.id)

  // Mint a per-load iframe token bound to (appId, user). The iframe is served
  // with the cookie (navigation), but its opaque-origin JS has none — the SDK
  // uses this token to reach the app's own /api/mini-apps/<id>/* namespace.
  const serveUser = c.get('user') as { id: string } | undefined
  let tokenScript = ''
  if (serveUser?.id) {
    const { mintAppToken } = await import('@/server/services/mini-app-token')
    const token = mintAppToken(app.id, serveUser.id)
    tokenScript = `<script>window.__HK_APP_TOKEN__=${JSON.stringify(token)};</script>`
  }

  // Build injection: base tag first (for relative path resolution), token before
  // the SDK (so it can read it), then importmap before module scripts.
  const headInjection = [baseTag(app.id), tokenScript, SDK_LINK, importMapTag, moduleHelpTag, SDK_SCRIPT, THEME_SYNC_SCRIPT].filter(Boolean).join('\n')

  // Inject SDK CSS and theme sync script into <head>
  if (html.includes('<head>')) {
    html = html.replace('<head>', `<head>\n${headInjection}`)
  } else if (html.includes('<html>')) {
    html = html.replace('<html>', `<html>\n<head>\n${headInjection}\n</head>`)
  } else {
    // No HTML structure — wrap everything
    html = `<!DOCTYPE html>\n<html>\n<head>\n${headInjection}\n</head>\n<body>\n${html}\n</body>\n</html>`
  }

  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '')
  const selfOrigin = `${proto}://${c.req.header('host') ?? 'localhost'}`

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': buildMiniAppCsp([selfOrigin, config.publicUrl]),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), clipboard-read=(self), clipboard-write=(self), autoplay=(self)',
    },
  })
})

// Serve static assets (CSS, JS, images)
miniAppRoutes.get('/:id/static/*', async (c) => {
  const app = await getMiniAppRow(c.req.param('id'))
  if (!app) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'App not found' } }, 404)
  }

  const assetPath = c.req.path.replace(`/api/mini-apps/${c.req.param('id')}/static/`, '')
  if (!assetPath) {
    return c.json({ error: { code: 'MISSING_PATH', message: 'Asset path is required' } }, 400)
  }

  const dir = getAppDir(app.agentId, app.id)
  const absoluteDir = join(process.cwd(), dir)
  const fullPath = join(absoluteDir, assetPath)

  // Path traversal check
  if (!fullPath.startsWith(absoluteDir + '/')) {
    return c.json({ error: { code: 'INVALID_PATH', message: 'Path traversal detected' } }, 400)
  }

  if (!existsSync(fullPath)) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'File not found' } }, 404)
  }

  // Transpile .jsx/.tsx files on-the-fly before serving
  if (assetPath.endsWith('.jsx') || assetPath.endsWith('.tsx')) {
    try {
      const source = ensureReactImport(await Bun.file(fullPath).text())
      const transpiler = assetPath.endsWith('.tsx') ? tsxTranspiler : jsxTranspiler
      const transpiled = transpiler.transformSync(source)
      return new Response(transpiled, {
        headers: {
          'Content-Type': 'application/javascript',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (err) {
      console.error('[mini-app] JSX/TSX transpilation failed for', assetPath, err)
      return new Response(`console.error('[Hivekeep] Failed to transpile ${assetPath}');`, {
        headers: { 'Content-Type': 'application/javascript' },
        status: 500,
      })
    }
  }

  const file = Bun.file(fullPath)
  return new Response(file, {
    headers: {
      'Content-Type': guessMimeType(assetPath),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

// ─── SDK CSS endpoint (no auth needed — only CSS tokens) ────────────────────

export const miniAppSdkRoutes = new Hono()

// CORS for the SDK assets. The hardened iframe runs at an opaque origin, and the
// app imports @hivekeep/react / @hivekeep/components as ES MODULES — module
// imports are CORS-governed (unlike a classic <script src>), so without this the
// opaque-origin iframe can't load the SDK and every app that uses the React layer
// breaks. Public static files, no credentials → permissive origin is safe.
miniAppSdkRoutes.use('*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], maxAge: 86400 }))

// SDK assets, each served under its canonical `hivekeep-*` name AND a legacy
// `kinbot-*` alias. Mini-apps authored before the Hivekeep rebrand carry an
// app.json import map pointing at `/api/mini-apps/sdk/kinbot-react.js` &
// `kinbot-components.js`; without the alias those URLs miss this router, fall
// through to the SPA catch-all (which returns index.html as `text/html`), and
// the browser refuses the module — leaving every legacy mini-app blank.
const SDK_ASSETS: { file: string; type: string; missing: string }[] = [
  { file: 'gezy-sdk.js', type: 'application/javascript', missing: '/* Gezy SDK JS not found */' },
  { file: 'hivekeep-react.js', type: 'application/javascript', missing: '/* Hivekeep React SDK not found */' },
  { file: 'hivekeep-components.js', type: 'application/javascript', missing: '/* Hivekeep Components not found */' },
  { file: 'gezy-sdk.css', type: 'text/css', missing: '/* Gezy SDK CSS not found */' },
  { file: 'gezy-sdk.d.ts', type: 'application/typescript', missing: '// Type definitions not found' },
  { file: 'hivekeep-react.d.ts', type: 'application/typescript', missing: '// Type definitions not found' },
  { file: 'hivekeep-components.d.ts', type: 'application/typescript', missing: '// Type definitions not found' },
]

function serveSdkAsset(file: string, type: string, missing: string) {
  return async () => {
    const p = join(import.meta.dir, '../mini-app-sdk', file)
    const body = existsSync(p) ? await Bun.file(p).text() : missing
    return new Response(body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' },
    })
  }
}

for (const asset of SDK_ASSETS) {
  const handler = serveSdkAsset(asset.file, asset.type, asset.missing)
  miniAppSdkRoutes.get(`/${asset.file}`, handler)
  // Legacy alias: hivekeep-react.js → also served at kinbot-react.js, etc.
  miniAppSdkRoutes.get(`/${asset.file.replace(/^hivekeep-/, 'kinbot-')}`, handler)
}

// ─── Console entries ────────────────────────────────────────────────────────

// POST console entry from the parent UI (MiniAppViewer forwards SDK console messages here)
miniAppRoutes.post('/:id/console', async (c) => {
  const { id } = c.req.param()
  const body = await c.req.json<{ level: string; args: string[]; stack?: string; timestamp?: number }>()
  const level = body.level as 'log' | 'warn' | 'error'
  if (!['log', 'warn', 'error'].includes(level)) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'Invalid level' } }, 400)
  }
  pushConsoleEntry(id, {
    level,
    args: Array.isArray(body.args) ? body.args.map(String).slice(0, 20) : [String(body.args)],
    stack: body.stack ? String(body.stack).slice(0, 2000) : null,
    timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
  })
  return c.json({ ok: true })
})

// GET console entries for a mini-app (used by the get_mini_app_console tool)
miniAppRoutes.get('/:id/console', async (c) => {
  const { id } = c.req.param()
  const level = c.req.query('level')
  const entries = getConsoleEntries(id, level)
  return c.json({ entries })
})

// DELETE console entries for a mini-app
miniAppRoutes.delete('/:id/console', async (c) => {
  const { id } = c.req.param()
  clearConsoleEntries(id)
  return c.json({ ok: true })
})
