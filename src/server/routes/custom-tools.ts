import { Hono } from 'hono'
import {
  listCustomTools,
  getCustomTool,
  createCustomTool,
  updateCustomTool,
  deleteCustomTool,
  writeCustomToolFile,
  readCustomToolFile,
  deleteCustomToolFile,
  listCustomToolFiles,
  runToolSetup,
  executeCustomTool,
  toCustomToolDTO,
} from '@/server/services/custom-tools'
import {
  buildCustomToolRenderer,
  customToolHasRenderer,
  validateCustomToolRenderer,
} from '@/server/services/custom-tool-renderer'
import type { CustomToolTranslations } from '@/shared/types'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import type { AppVariables } from '@/server/app'

const log = createLogger('routes:custom-tools')

/**
 * CRUD + authoring REST for GLOBAL custom tools. The UI (CustomToolsSettings)
 * consumes these; UI-created tools are `createdBy='user'` and active immediately.
 * The on-disk script + deps live under config.customTools.baseDir/<slug>/.
 */
export const customToolRoutes = new Hono<{ Variables: AppVariables }>()

function fail(c: any, err: unknown, status: 400 | 404 = 400) {
  const message = err instanceof Error ? err.message : 'Unknown error'
  log.warn({ message }, 'custom-tools route error')
  return c.json({ error: { code: 'CUSTOM_TOOL_ERROR', message } }, status)
}

// GET /api/custom-tools — list all (DTOs carry parsed `translations`).
customToolRoutes.get('/', (c) => {
  return c.json({ tools: listCustomTools().map(toCustomToolDTO) })
})

// GET /api/custom-tools/:slug — metadata + file listing.
customToolRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const tool = getCustomTool(slug)
  if (!tool) return c.json({ error: { code: 'CUSTOM_TOOL_NOT_FOUND', message: 'Not found' } }, 404)
  let files: string[] = []
  try {
    files = await listCustomToolFiles(slug)
  } catch {
    /* dir may not exist yet */
  }
  return c.json({ tool: toCustomToolDTO(tool), files })
})

// GET /api/custom-tools/:slug/renderer.js — the server-bundled ESM result
// renderer (default export = a React component). 404 when the tool ships no
// renderer file; 500 (with the build error message) when bundling fails. Served
// as ESM with an mtime-derived ETag so the browser can revalidate cheaply.
//
// Caching: when the request carries a `?v=` query (the version-addressed URL the
// client builds from the renderer file's mtime), the response is immutable —
// `Cache-Control: public, max-age=31536000, immutable` — so the browser caches it
// forever and never refetches (instant cross-session). A renderer edit changes the
// mtime → a NEW `?v=` URL → a fresh fetch, so this is always correct. Without a
// `?v=`, the legacy ETag/no-cache revalidation path is kept.
//
// Host-context: the module shares the page's React instance (window.__GEZY_REACT__)
// and renders with full host privileges. Trusted-by-design (custom tools are
// user/Agent-authored on a self-hosted instance) and authed like every /api/* route.
customToolRoutes.get('/:slug/renderer.js', async (c) => {
  const slug = c.req.param('slug')
  let js: string | null
  try {
    js = await buildCustomToolRenderer(slug)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Renderer build failed'
    log.warn({ slug, message }, 'custom-tool renderer build error')
    // Surface the build error as an ESM module that throws on import, so the
    // client ErrorBoundary catches it and falls back to the JSON viewer.
    return new Response(
      `throw new Error(${JSON.stringify(message)});\nexport default function () { return null; }`,
      {
        status: 500,
        headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      },
    )
  }
  if (js === null) {
    return c.json({ error: { code: 'NO_RENDERER', message: 'This tool has no renderer' } }, 404)
  }
  // Version-addressed request (`?v=<mtime>`): the URL is content-addressed, so the
  // module can be cached forever — an edit yields a new mtime → a new URL → a fresh
  // fetch. Serve immutable so repeat/cross-session opens are instant (no revalidate).
  if (c.req.query('v') !== undefined) {
    return new Response(js, {
      headers: {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  // Unversioned request: weak ETag over the built bytes — small + stable, lets the
  // browser 304 on repeat opens. The build itself is mtime-cached server-side.
  const etag = `W/"${js.length.toString(16)}-${Bun.hash(js).toString(16)}"`
  if (c.req.header('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } })
  }
  return new Response(js, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

// GET /api/custom-tools/:slug/file?path=… — read one file's content.
customToolRoutes.get('/:slug/file', async (c) => {
  const slug = c.req.param('slug')
  const path = c.req.query('path')
  if (!path) return c.json({ error: { code: 'PATH_REQUIRED', message: 'path query param required' } }, 400)
  try {
    const content = await readCustomToolFile(slug, path)
    return c.json({ content })
  } catch (err) {
    return fail(c, err, 404)
  }
})

// POST /api/custom-tools — create (createdBy 'user').
customToolRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const created = await createCustomTool({
      slug: String(body.slug ?? ''),
      name: String(body.name ?? ''),
      description: String(body.description ?? ''),
      parameters: String(body.parameters ?? '{}'),
      entrypoint: String(body.entrypoint ?? 'index.ts'),
      language: (body.language as string | null) ?? null,
      domainSlug: (body.domainSlug as string | null) ?? null,
      timeoutMs: (body.timeoutMs as number | null) ?? null,
      translations: (body.translations as CustomToolTranslations | string | null) ?? null,
      createdBy: 'user',
    })
    // Optional inline entrypoint content.
    if (typeof body.code === 'string') {
      await writeCustomToolFile(created.slug, created.entrypoint, body.code)
    }
    const dto = toCustomToolDTO(created)
    sseManager.broadcast({ type: 'custom-tool:created', data: dto as unknown as Record<string, unknown> })
    return c.json({ tool: dto }, 201)
  } catch (err) {
    return fail(c, err)
  }
})

// PATCH /api/custom-tools/:slug — update metadata / toggle enabled.
customToolRoutes.patch('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const updated = updateCustomTool(slug, {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      parameters: body.parameters as string | undefined,
      entrypoint: body.entrypoint as string | undefined,
      language: body.language as string | null | undefined,
      domainSlug: body.domainSlug as string | undefined,
      timeoutMs: body.timeoutMs as number | null | undefined,
      enabled: body.enabled as boolean | undefined,
      translations: body.translations as CustomToolTranslations | string | null | undefined,
    })
    const dto = toCustomToolDTO(updated)
    sseManager.broadcast({ type: 'custom-tool:updated', data: dto as unknown as Record<string, unknown> })
    return c.json({ tool: dto })
  } catch (err) {
    return fail(c, err, 404)
  }
})

// DELETE /api/custom-tools/:slug
customToolRoutes.delete('/:slug', async (c) => {
  const slug = c.req.param('slug')
  const ok = await deleteCustomTool(slug)
  if (!ok) return c.json({ error: { code: 'CUSTOM_TOOL_NOT_FOUND', message: 'Not found' } }, 404)
  sseManager.broadcast({ type: 'custom-tool:deleted', data: { slug } })
  return c.json({ success: true })
})

// PUT /api/custom-tools/:slug/files — write a file { path, content }.
customToolRoutes.put('/:slug/files', async (c) => {
  const slug = c.req.param('slug')
  const body = (await c.req.json().catch(() => ({}))) as { path?: string; content?: string }
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return c.json({ error: { code: 'INVALID_FILE', message: 'path and content are required strings' } }, 400)
  }
  try {
    await writeCustomToolFile(slug, body.path, body.content)
    return c.json({ success: true })
  } catch (err) {
    return fail(c, err)
  }
})

// DELETE /api/custom-tools/:slug/files?path=…
customToolRoutes.delete('/:slug/files', async (c) => {
  const slug = c.req.param('slug')
  const path = c.req.query('path')
  if (!path) return c.json({ error: { code: 'PATH_REQUIRED', message: 'path query param required' } }, 400)
  try {
    await deleteCustomToolFile(slug, path)
    return c.json({ success: true })
  } catch (err) {
    return fail(c, err)
  }
})

// POST /api/custom-tools/:slug/setup — install dependencies.
customToolRoutes.post('/:slug/setup', async (c) => {
  const slug = c.req.param('slug')
  try {
    const result = await runToolSetup(slug)
    return c.json(result)
  } catch (err) {
    return fail(c, err)
  }
})

// POST /api/custom-tools/:slug/test — run with sample args. When the tool ships
// a renderer.tsx, also validate it server-side (build + initial SSR render) and
// include the outcome under `renderer` so the Settings modal can surface renderer
// health alongside the execution output. Best-effort: a validator-internal error
// never fails the whole test.
customToolRoutes.post('/:slug/test', async (c) => {
  const slug = c.req.param('slug')
  const body = (await c.req.json().catch(() => ({}))) as { args?: Record<string, unknown>; timeout?: number }
  const args = body.args ?? {}
  const result = await executeCustomTool(slug, args, body.timeout)
  if (customToolHasRenderer(slug)) {
    try {
      const renderer = await validateCustomToolRenderer(slug, result, args)
      return c.json({ ...result, renderer })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Renderer validation failed'
      log.warn({ slug, message }, 'custom-tool renderer validation error')
      return c.json({ ...result, renderer: { ok: false, error: message } })
    }
  }
  return c.json(result)
})
