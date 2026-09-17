import { Hono } from 'hono'
import type { Context } from 'hono'
import { resolveAgentByIdOrSlug } from '@/server/services/agent-resolver'
import {
  WorkspaceFilesError,
  listWorkspaceDir,
  readWorkspaceFile,
  statWorkspaceFileForRaw,
  writeWorkspaceFile,
  mkdirWorkspace,
  moveWorkspaceEntry,
  copyWorkspaceEntry,
  deleteWorkspaceEntry,
  uploadWorkspaceFiles,
  searchWorkspaceFiles,
  resolveWorkspacePaths,
} from '@/server/services/workspace-files'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { isInlineSafeMime } from '@/server/services/file-kind'
import type { AppVariables } from '@/server/app'

/**
 * Workspace files API — the user-facing Files section (see files.md § 6).
 * Mounted on /api/agents/:agentId/workspace.
 */
const workspaceFilesRoutes = new Hono<{ Variables: AppVariables }>()

const ERROR_STATUS: Record<string, 400 | 404 | 409 | 413> = {
  PATH_FORBIDDEN: 400,
  INVALID_NAME: 400,
  IS_DIRECTORY: 400,
  NOT_A_DIRECTORY: 400,
  FILE_NOT_FOUND: 404,
  DEST_EXISTS: 409,
  CONFLICT: 409,
  FILE_TOO_LARGE: 413,
  COPY_TOO_LARGE: 413,
}

function handleError(c: Context, err: unknown) {
  if (err instanceof WorkspaceFilesError) {
    return c.json({ error: { code: err.code, message: err.message } }, ERROR_STATUS[err.code] ?? 400)
  }
  throw err
}

/** Resolve :agentId (uuid or slug) or answer 404 — same convention as the other agent-nested routes. */
function requireAgent(c: Context) {
  const agent = resolveAgentByIdOrSlug(c.req.param('agentId') as string)
  if (!agent) return null
  return agent
}

const agentNotFound = (c: Context) =>
  c.json({ error: { code: 'AGENT_NOT_FOUND', message: 'Agent not found' } }, 404)

// GET /api/agents/:agentId/workspace/ls?path=docs — list one directory
workspaceFilesRoutes.get('/ls', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const result = await listWorkspaceDir(agent.id, c.req.query('path') ?? '')
    return c.json(result)
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/agents/:agentId/workspace/file?path=… — read file metadata + text content
workspaceFilesRoutes.get('/file', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const file = await readWorkspaceFile(agent.id, c.req.query('path') ?? '')
    return c.json(file)
  } catch (err) {
    return handleError(c, err)
  }
})

// PUT /api/agents/:agentId/workspace/file — write text content (files.md § 6.4)
workspaceFilesRoutes.put('/file', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const body = await c.req.json<{ path?: string; content?: string; baseModifiedAt?: number; createOnly?: boolean }>()
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'path and content are required' } }, 400)
  }
  try {
    const result = await writeWorkspaceFile(agent.id, body.path, body.content, {
      baseModifiedAt: typeof body.baseModifiedAt === 'number' ? body.baseModifiedAt : undefined,
      createOnly: body.createOnly === true,
    })
    return c.json(result)
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/agents/:agentId/workspace/mkdir — create a folder
workspaceFilesRoutes.post('/mkdir', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const body = await c.req.json<{ path?: string }>()
  if (typeof body.path !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'path is required' } }, 400)
  }
  try {
    return c.json(await mkdirWorkspace(agent.id, body.path))
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/agents/:agentId/workspace/move — rename / move (cross-workspace via fromAgentId)
workspaceFilesRoutes.post('/move', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const body = await c.req.json<{ from?: string; to?: string; fromAgentId?: string }>()
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'from and to are required' } }, 400)
  }
  const fromAgentId = body.fromAgentId ? resolveAgentId(body.fromAgentId) : undefined
  if (body.fromAgentId && !fromAgentId) return agentNotFound(c)
  try {
    return c.json(await moveWorkspaceEntry({ agentId: agent.id, from: body.from, to: body.to, fromAgentId: fromAgentId ?? undefined }))
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/agents/:agentId/workspace/copy — copy (collision → " (copy N)" suffix)
workspaceFilesRoutes.post('/copy', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const body = await c.req.json<{ from?: string; to?: string; fromAgentId?: string }>()
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'from and to are required' } }, 400)
  }
  const fromAgentId = body.fromAgentId ? resolveAgentId(body.fromAgentId) : undefined
  if (body.fromAgentId && !fromAgentId) return agentNotFound(c)
  try {
    return c.json(await copyWorkspaceEntry({ agentId: agent.id, from: body.from, to: body.to, fromAgentId: fromAgentId ?? undefined }))
  } catch (err) {
    return handleError(c, err)
  }
})

// DELETE /api/agents/:agentId/workspace/file?path=… — delete file or folder (recursive)
workspaceFilesRoutes.delete('/file', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const result = await deleteWorkspaceEntry(agent.id, c.req.query('path') ?? '')
    return c.json({ deleted: true, path: result.path })
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/agents/:agentId/workspace/upload — multipart upload into a folder
workspaceFilesRoutes.post('/upload', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const formData = await c.req.formData()
  const dirPath = (formData.get('path') as string | null) ?? ''
  const entries = formData.getAll('file').filter((f): f is File => f instanceof File)
  if (entries.length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'At least one file is required' } }, 400)
  }
  try {
    const files = await Promise.all(
      entries.map(async (f) => ({ name: f.name, buffer: Buffer.from(await f.arrayBuffer()) })),
    )
    const result = await uploadWorkspaceFiles(agent.id, dirPath, files)
    return c.json(result, 201)
  } catch (err) {
    return handleError(c, err)
  }
})

// GET /api/agents/:agentId/workspace/search?q=…&limit=20 — filename search
workspaceFilesRoutes.get('/search', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const q = c.req.query('q') ?? ''
  const limit = Number(c.req.query('limit') ?? 20)
  try {
    const hits = await searchWorkspaceFiles(agent.id, q, Number.isFinite(limit) ? limit : 20)
    return c.json({ hits })
  } catch (err) {
    return handleError(c, err)
  }
})

// POST /api/agents/:agentId/workspace/resolve-paths — batched existence check (chat chips)
workspaceFilesRoutes.post('/resolve-paths', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  const body = await c.req.json<{ paths?: string[] }>()
  if (!Array.isArray(body.paths)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'paths must be an array' } }, 400)
  }
  const existing = await resolveWorkspacePaths(
    agent.id,
    body.paths.filter((p): p is string => typeof p === 'string'),
  )
  return c.json({ existing })
})

// GET /api/agents/:agentId/workspace/raw?path=…&inline=1 — stream raw bytes
workspaceFilesRoutes.get('/raw', async (c) => {
  const agent = requireAgent(c)
  if (!agent) return agentNotFound(c)
  try {
    const file = await statWorkspaceFileForRaw(agent.id, c.req.query('path') ?? '')
    const inline = c.req.query('inline') === '1' && isInlineSafeMime(file.mimeType)
    const headers: Record<string, string> = {
      'Content-Type': file.mimeType,
      'Content-Length': String(file.size),
      // MIME is guessed from the extension — never let the browser sniff its way around the allowlist.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    }
    if (inline) headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
    return new Response(Bun.file(file.abs), { headers })
  } catch (err) {
    return handleError(c, err)
  }
})

export { workspaceFilesRoutes }
