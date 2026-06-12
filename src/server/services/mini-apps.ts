import { eq, and, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { join, resolve, extname, dirname } from 'path'
import { mkdir, unlink, readdir, stat, rm, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { miniApps, miniAppStorage, miniAppSnapshots, agents } from '@/server/db/schema'
import { config } from '@/server/config'
import { buildMiniAppIconPrompt, generateImage, ImageGenerationError } from '@/server/services/image-generation'
import type { MiniAppSummary } from '@/shared/types'

const log = createLogger('mini-apps')

const MAX_FILE_SIZE = config.miniApps.maxFileSizeMb * 1024 * 1024

type MiniAppRow = typeof miniApps.$inferSelect

// ─── Helpers ────────────────────────────────────────────────────────────────

function appDir(agentId: string, appId: string): string {
  return join(config.miniApps.dir, agentId, appId)
}

/** Validate that a resolved path stays within the app directory */
function validatePath(base: string, relativePath: string): string {
  const absoluteBase = resolve(base)
  const resolved = resolve(base, relativePath)
  if (!resolved.startsWith(absoluteBase + '/') && resolved !== absoluteBase) {
    throw new Error('Invalid path: path traversal detected')
  }
  return resolved
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase()
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html',
    css: 'text/css', js: 'application/javascript',
    json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    txt: 'text/plain', md: 'text/markdown', xml: 'application/xml',
    mp3: 'audio/mpeg', mp4: 'video/mp4', pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Notify the backend runtime that app files changed, without a static import
 * (mini-app-backend.ts imports this module — a static import would be a cycle).
 */
function notifyBackendFilesChanged(appId: string, relativePath: string): void {
  void import('@/server/services/mini-app-backend')
    .then((m) => m.handleAppFilesChanged(appId, relativePath))
    .catch(() => {})
}

function notifyBackendRestart(appId: string): void {
  void import('@/server/services/mini-app-backend')
    .then((m) => m.restartBackend(appId))
    .catch(() => {})
}

function serializeApp(row: MiniAppRow, agentName: string, agentAvatarUrl: string | null): MiniAppSummary {
  return {
    id: row.id,
    maintainerAgentId: row.agentId,
    maintainerAgentName: agentName,
    maintainerAgentAvatarUrl: agentAvatarUrl,
    // Backward-compat aliases (pre-decoupling field names) so a client still
    // running a stale bundle doesn't crash on `app.agentName.slice(...)`. Safe to
    // remove once all clients have reloaded the new bundle.
    agentId: row.agentId,
    agentName,
    agentAvatarUrl,
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
    iconUrl: row.iconUrl ?? null,
    entryFile: row.entryFile,
    hasBackend: row.hasBackend,
    isActive: row.isActive,
    version: row.version,
    createdAt: (row.createdAt as unknown as Date).getTime(),
    updatedAt: (row.updatedAt as unknown as Date).getTime(),
  } as MiniAppSummary // cast: object carries extra backward-compat alias keys
}

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateMiniAppParams {
  agentId: string
  name: string
  slug: string
  description?: string
  icon?: string
  entryFile?: string
}

export async function createMiniApp(params: CreateMiniAppParams): Promise<MiniAppSummary> {
  const { agentId, name, slug, description, icon, entryFile } = params

  // Check max apps per agent
  const existing = await db.select().from(miniApps).where(eq(miniApps.agentId, agentId)).all()
  if (existing.length >= config.miniApps.maxAppsPerAgent) {
    throw new Error(`Maximum of ${config.miniApps.maxAppsPerAgent} apps per Agent reached`)
  }

  // Check slug uniqueness within agent
  const slugExists = await db.select().from(miniApps)
    .where(and(eq(miniApps.agentId, agentId), eq(miniApps.slug, slug)))
    .get()
  if (slugExists) {
    throw new Error(`An app with slug "${slug}" already exists for this Agent`)
  }

  const id = uuid()
  const dir = appDir(agentId, id)
  await mkdir(dir, { recursive: true })

  const now = new Date()
  await db.insert(miniApps).values({
    id,
    agentId,
    name,
    slug,
    description: description ?? null,
    icon: icon ?? null,
    entryFile: entryFile ?? 'index.html',
    hasBackend: false,
    isActive: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  })

  log.info({ agentId, appId: id, name, slug }, 'Mini-app created')

  const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get()
  return serializeApp(
    (await db.select().from(miniApps).where(eq(miniApps.id, id)).get())!,
    agent?.name ?? 'Unknown',
    agent?.avatarPath ? `/api/uploads/agents/${agentId}/avatar${extname(agent.avatarPath)}` : null,
  )
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function getMiniApp(id: string): Promise<MiniAppSummary | null> {
  const row = await db.select().from(miniApps).where(eq(miniApps.id, id)).get()
  if (!row) return null
  const agent = await db.select().from(agents).where(eq(agents.id, row.agentId)).get()
  return serializeApp(row, agent?.name ?? 'Unknown', agent?.avatarPath ? `/api/uploads/agents/${row.agentId}/avatar${extname(agent.avatarPath)}` : null)
}

export async function getMiniAppBySlug(agentId: string, slug: string): Promise<MiniAppSummary | null> {
  const row = await db.select().from(miniApps)
    .where(and(eq(miniApps.agentId, agentId), eq(miniApps.slug, slug)))
    .get()
  if (!row) return null
  const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get()
  return serializeApp(row, agent?.name ?? 'Unknown', agent?.avatarPath ? `/api/uploads/agents/${agentId}/avatar${extname(agent.avatarPath)}` : null)
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listMiniApps(agentId: string): Promise<MiniAppSummary[]> {
  const rows = await db.select().from(miniApps)
    .where(eq(miniApps.agentId, agentId))
    .orderBy(desc(miniApps.createdAt))
    .all()

  if (rows.length === 0) return []

  const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get()
  const agentName = agent?.name ?? 'Unknown'
  const agentAvatarUrl = agent?.avatarPath ? `/api/uploads/agents/${agentId}/avatar${extname(agent.avatarPath)}` : null

  return rows.map((row) => serializeApp(row, agentName, agentAvatarUrl))
}

// ─── Update ─────────────────────────────────────────────────────────────────

export interface UpdateMiniAppParams {
  name?: string
  description?: string | null
  icon?: string | null
  iconUrl?: string | null
  entryFile?: string
  isActive?: boolean
}

export async function updateMiniApp(id: string, params: UpdateMiniAppParams): Promise<MiniAppSummary | null> {
  const existing = await db.select().from(miniApps).where(eq(miniApps.id, id)).get()
  if (!existing) return null

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (params.name !== undefined) updates.name = params.name
  if (params.description !== undefined) updates.description = params.description
  if (params.icon !== undefined) updates.icon = params.icon
  if (params.iconUrl !== undefined) updates.iconUrl = params.iconUrl
  if (params.entryFile !== undefined) updates.entryFile = params.entryFile
  if (params.isActive !== undefined) updates.isActive = params.isActive

  await db.update(miniApps).set(updates).where(eq(miniApps.id, id))
  log.info({ appId: id }, 'Mini-app updated')

  // Activation changes affect the running backend: stop when deactivated,
  // (re)start background apps when reactivated.
  if (params.isActive !== undefined) notifyBackendRestart(id)

  return getMiniApp(id)
}

// ─── Reassign maintainer ──────────────────────────────────────────────────────

/**
 * Reassign the maintainer Agent of a mini-app. Because app files live on disk at
 * `dir/<maintainerAgentId>/<appId>/`, the directory is moved to the new
 * maintainer's namespace so file/serve/snapshot paths keep resolving.
 * Returns the updated summary, or null if the app doesn't exist.
 */
export async function setMiniAppMaintainer(appId: string, newMaintainerAgentId: string): Promise<MiniAppSummary | null> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) return null
  if (app.agentId === newMaintainerAgentId) return getMiniApp(appId)

  // Validate the target Agent exists.
  const targetAgent = await db.select().from(agents).where(eq(agents.id, newMaintainerAgentId)).get()
  if (!targetAgent) throw new Error('Target Agent not found')

  // Move the on-disk directory to the new namespace (best-effort: an app with no
  // files yet simply has no source dir).
  const oldDir = appDir(app.agentId, appId)
  const newDir = appDir(newMaintainerAgentId, appId)
  if (existsSync(oldDir) && oldDir !== newDir) {
    await mkdir(dirname(newDir), { recursive: true })
    if (existsSync(newDir)) await rm(newDir, { recursive: true, force: true })
    await rename(oldDir, newDir)
  }

  await db.update(miniApps).set({ agentId: newMaintainerAgentId, updatedAt: new Date() }).where(eq(miniApps.id, appId))
  log.info({ appId, fromAgentId: app.agentId, toAgentId: newMaintainerAgentId }, 'Mini-app maintainer reassigned')

  // The on-disk dir moved: the cached backend module points at the old path.
  notifyBackendRestart(appId)

  return getMiniApp(appId)
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteMiniApp(id: string): Promise<boolean> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, id)).get()
  if (!app) return false

  // Delete files from disk
  const dir = appDir(app.agentId, id)
  try {
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true })
    }
  } catch (err) {
    log.warn({ appId: id, dir, error: err }, 'Failed to delete app directory from disk')
  }

  await db.delete(miniApps).where(eq(miniApps.id, id))

  // Stop any running backend instance and drop the SSE emitter.
  void import('@/server/services/mini-app-backend')
    .then((m) => m.removeBackend(id))
    .catch(() => {})

  log.info({ appId: id, name: app.name }, 'Mini-app deleted')
  return true
}

// ─── File operations ────────────────────────────────────────────────────────

export async function writeAppFile(
  appId: string,
  relativePath: string,
  content: string | Buffer,
): Promise<{ path: string; size: number }> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) throw new Error('App not found')

  const dir = appDir(app.agentId, appId)
  const filePath = validatePath(dir, relativePath)

  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: max ${config.miniApps.maxFileSizeMb} MB`)
  }

  // Ensure parent directory exists
  await mkdir(dirname(filePath), { recursive: true })
  await Bun.write(filePath, buffer)

  // Increment version + update hasBackend if _server.js
  const updates: Record<string, unknown> = {
    version: app.version + 1,
    updatedAt: new Date(),
  }
  if (relativePath === '_server.js' || relativePath === '_server.ts') {
    updates.hasBackend = true
  }
  await db.update(miniApps).set(updates).where(eq(miniApps.id, appId))

  notifyBackendFilesChanged(appId, relativePath)

  log.debug({ appId, path: relativePath, size: buffer.length }, 'App file written')
  return { path: relativePath, size: buffer.length }
}

export async function readAppFile(appId: string, relativePath: string): Promise<Buffer> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) throw new Error('App not found')

  const dir = appDir(app.agentId, appId)
  const filePath = validatePath(dir, relativePath)

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${relativePath}`)
  }

  return Buffer.from(await Bun.file(filePath).arrayBuffer())
}

export async function deleteAppFile(appId: string, relativePath: string): Promise<boolean> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) throw new Error('App not found')

  const dir = appDir(app.agentId, appId)
  const filePath = validatePath(dir, relativePath)

  if (!existsSync(filePath)) return false

  await unlink(filePath)

  // If deleting _server.js, update hasBackend
  const updates: Record<string, unknown> = {
    version: app.version + 1,
    updatedAt: new Date(),
  }
  if (relativePath === '_server.js' || relativePath === '_server.ts') {
    updates.hasBackend = false
  }
  await db.update(miniApps).set(updates).where(eq(miniApps.id, appId))

  notifyBackendFilesChanged(appId, relativePath)

  log.debug({ appId, path: relativePath }, 'App file deleted')
  return true
}

export interface AppFileInfo {
  path: string
  size: number
  mimeType: string
}

export async function listAppFiles(appId: string): Promise<AppFileInfo[]> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) throw new Error('App not found')

  const dir = appDir(app.agentId, appId)
  if (!existsSync(dir)) return []

  const files: AppFileInfo[] = []
  await walkDir(dir, dir, files)
  return files
}

async function walkDir(base: string, current: string, results: AppFileInfo[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) {
      await walkDir(base, fullPath, results)
    } else {
      const fileStat = await stat(fullPath)
      results.push({
        path: fullPath.slice(base.length + 1), // relative path
        size: fileStat.size,
        mimeType: guessMimeType(entry.name),
      })
    }
  }
}

// ─── Serve helpers ──────────────────────────────────────────────────────────

/** Get the absolute path of the app directory on disk */
export function getAppDir(agentId: string, appId: string): string {
  return appDir(agentId, appId)
}

/** Get the raw DB row (for routes that need agentId) */
export async function getMiniAppRow(id: string): Promise<MiniAppRow | null> {
  return db.select().from(miniApps).where(eq(miniApps.id, id)).get() ?? null
}

// ─── Manifest (app.json) ─────────────────────────────────────────────────────

/** Parsed `app.json` manifest fields the host cares about. */
export interface MiniAppManifest {
  dependencies?: Record<string, string>
  importmap?: { imports?: Record<string, string> }
  /** When true, the backend is loaded at server boot and restarted on edits. */
  background?: boolean
  /** Capabilities the backend requests (granted by the user, see mini-app permissions). */
  permissions?: string[]
  [key: string]: unknown
}

/** Read and parse the app's `app.json`. Returns {} when absent or malformed. */
export async function readAppManifest(appId: string): Promise<MiniAppManifest> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) return {}
  const manifestPath = join(appDir(app.agentId, appId), 'app.json')
  if (!existsSync(manifestPath)) return {}
  try {
    const parsed = JSON.parse(await Bun.file(manifestPath).text())
    return parsed && typeof parsed === 'object' ? (parsed as MiniAppManifest) : {}
  } catch {
    return {}
  }
}

// ─── Capability permissions ──────────────────────────────────────────────────

/**
 * Grant capability permissions to a mini-app (additive — grants are never
 * silently revoked here). Only permissions actually requested in app.json can
 * be granted. The backend is restarted so the new grants take effect.
 */
export async function grantMiniAppPermissions(
  appId: string,
  grant: string[],
): Promise<{ requested: string[]; granted: string[]; invalid: string[] } | null> {
  const { parseRequestedPermissions, parseGrantedPermissions, isKnownPermission } = await import('@/server/services/mini-app-capabilities')

  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) return null

  const manifest = await readAppManifest(appId)
  const requested = parseRequestedPermissions(manifest)
  const current = parseGrantedPermissions(app.grantedPermissions)

  const invalid: string[] = []
  const accepted: string[] = []
  for (const p of grant) {
    if (typeof p !== 'string' || !isKnownPermission(p) || !requested.includes(p)) invalid.push(String(p))
    else accepted.push(p)
  }

  const granted = [...new Set([...current, ...accepted])]
  await db.update(miniApps)
    .set({ grantedPermissions: JSON.stringify(granted), updatedAt: new Date() })
    .where(eq(miniApps.id, appId))

  if (accepted.length > 0) notifyBackendRestart(appId)

  log.info({ appId, accepted, invalid }, 'Mini-app permissions granted')
  return { requested, granted, invalid }
}

/** Current permission state of an app: requested (manifest) vs granted (DB). */
export async function getMiniAppPermissions(
  appId: string,
): Promise<{ requested: string[]; granted: string[]; missing: string[] } | null> {
  const { parseRequestedPermissions, parseGrantedPermissions } = await import('@/server/services/mini-app-capabilities')

  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) return null

  const manifest = await readAppManifest(appId)
  const requested = parseRequestedPermissions(manifest)
  const granted = parseGrantedPermissions(app.grantedPermissions).filter((p) => requested.includes(p))
  return { requested, granted, missing: requested.filter((p) => !granted.includes(p)) }
}

/** Ids of all active apps that have a backend (for boot-time background loading). */
export async function listBackendAppIds(): Promise<string[]> {
  const rows = await db.select({ id: miniApps.id })
    .from(miniApps)
    .where(and(eq(miniApps.hasBackend, true), eq(miniApps.isActive, true)))
    .all()
  return rows.map((r) => r.id)
}

export { guessMimeType }

// ─── Gallery (cross-agent browsing & cloning) ─────────────────────────────────

export async function listAllMiniApps(): Promise<MiniAppSummary[]> {
  const rows = await db.select().from(miniApps)
    .where(eq(miniApps.isActive, true))
    .orderBy(desc(miniApps.createdAt))
    .all()

  if (rows.length === 0) return []

  // Batch-load agent info
  const agentIds = [...new Set(rows.map((r) => r.agentId))]
  const agentRows = await Promise.all(agentIds.map((id) => db.select().from(agents).where(eq(agents.id, id)).get()))
  const agentMap = new Map<string, { name: string; avatarUrl: string | null }>()
  for (let i = 0; i < agentIds.length; i++) {
    const agentId = agentIds[i]!
    const agent = agentRows[i]
    const avatarPath = agent?.avatarPath ?? null
    agentMap.set(agentId, {
      name: agent?.name ?? 'Unknown',
      avatarUrl: avatarPath ? `/api/uploads/agents/${agentId}/avatar${extname(avatarPath)}` : null,
    })
  }

  return rows.map((row) => {
    const info = agentMap.get(row.agentId) ?? { name: 'Unknown', avatarUrl: null }
    return serializeApp(row, info.name, info.avatarUrl)
  })
}

// ─── Key-Value Storage ──────────────────────────────────────────────────────

const MAX_STORAGE_KEY_LENGTH = 256
const MAX_STORAGE_VALUE_SIZE = 64 * 1024 // 64 KB per value
const MAX_STORAGE_KEYS_PER_APP = 500

export async function storageGet(appId: string, key: string): Promise<string | null> {
  const row = await db.select()
    .from(miniAppStorage)
    .where(and(eq(miniAppStorage.appId, appId), eq(miniAppStorage.key, key)))
    .get()
  return row?.value ?? null
}

export async function storageSet(appId: string, key: string, value: string): Promise<void> {
  if (key.length > MAX_STORAGE_KEY_LENGTH) {
    throw new Error(`Key too long: max ${MAX_STORAGE_KEY_LENGTH} characters`)
  }
  if (value.length > MAX_STORAGE_VALUE_SIZE) {
    throw new Error(`Value too large: max ${MAX_STORAGE_VALUE_SIZE} bytes`)
  }

  const existing = await db.select()
    .from(miniAppStorage)
    .where(and(eq(miniAppStorage.appId, appId), eq(miniAppStorage.key, key)))
    .get()

  if (existing) {
    await db.update(miniAppStorage)
      .set({ value, updatedAt: new Date() })
      .where(eq(miniAppStorage.id, existing.id))
  } else {
    // Check max keys
    const count = await db.select({ id: miniAppStorage.id })
      .from(miniAppStorage)
      .where(eq(miniAppStorage.appId, appId))
      .all()
    if (count.length >= MAX_STORAGE_KEYS_PER_APP) {
      throw new Error(`Maximum of ${MAX_STORAGE_KEYS_PER_APP} storage keys per app reached`)
    }
    await db.insert(miniAppStorage).values({
      appId,
      key,
      value,
      updatedAt: new Date(),
    })
  }
}

export async function storageDelete(appId: string, key: string): Promise<boolean> {
  const result = await db.delete(miniAppStorage)
    .where(and(eq(miniAppStorage.appId, appId), eq(miniAppStorage.key, key)))
  return (result as any).changes > 0
}

export async function storageList(appId: string): Promise<{ key: string; size: number }[]> {
  const rows = await db.select({ key: miniAppStorage.key, value: miniAppStorage.value })
    .from(miniAppStorage)
    .where(eq(miniAppStorage.appId, appId))
    .all()
  return rows.map((r) => ({ key: r.key, size: r.value.length }))
}

export async function storageClear(appId: string): Promise<number> {
  const result = await db.delete(miniAppStorage)
    .where(eq(miniAppStorage.appId, appId))
  return (result as any).changes ?? 0
}

// ─── Version Snapshots ──────────────────────────────────────────────────────

const MAX_SNAPSHOTS_PER_APP = 20

export interface SnapshotSummary {
  id: number
  version: number
  label: string | null
  files: { path: string; size: number }[]
  createdAt: number
}

function snapshotDir(agentId: string, appId: string, version: number): string {
  return join(config.miniApps.dir, agentId, appId, '.snapshots', String(version))
}

/**
 * Create a snapshot of all current app files at the current version.
 * Called automatically before destructive operations (file writes/deletes).
 */
export async function createSnapshot(appId: string, label?: string): Promise<SnapshotSummary | null> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) return null

  const dir = appDir(app.agentId, appId)
  if (!existsSync(dir)) return null

  // Collect current files (excluding .snapshots dir)
  const files: { path: string; size: number }[] = []
  await walkDirForSnapshot(dir, dir, files)

  if (files.length === 0) return null

  // Copy files to snapshot directory
  const snapDir = snapshotDir(app.agentId, appId, app.version)
  await mkdir(snapDir, { recursive: true })

  for (const file of files) {
    const srcPath = join(dir, file.path)
    const destPath = join(snapDir, file.path)
    await mkdir(dirname(destPath), { recursive: true })
    const content = await Bun.file(srcPath).arrayBuffer()
    await Bun.write(destPath, content)
  }

  // Record in DB
  const now = new Date()
  const result = await db.insert(miniAppSnapshots).values({
    appId,
    version: app.version,
    label: label ?? null,
    fileManifest: JSON.stringify(files),
    createdAt: now,
  })

  const insertedId = Number((result as any).lastInsertRowid)

  // Auto-prune oldest snapshots if over limit
  const allSnapshots = await db.select({ id: miniAppSnapshots.id, version: miniAppSnapshots.version })
    .from(miniAppSnapshots)
    .where(eq(miniAppSnapshots.appId, appId))
    .orderBy(desc(miniAppSnapshots.version))
    .all()

  if (allSnapshots.length > MAX_SNAPSHOTS_PER_APP) {
    const toDelete = allSnapshots.slice(MAX_SNAPSHOTS_PER_APP)
    for (const snap of toDelete) {
      await db.delete(miniAppSnapshots).where(eq(miniAppSnapshots.id, snap.id))
      // Remove snapshot files
      const oldSnapDir = snapshotDir(app.agentId, appId, snap.version)
      if (existsSync(oldSnapDir)) {
        await rm(oldSnapDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  log.debug({ appId, version: app.version, fileCount: files.length }, 'Snapshot created')

  return {
    id: insertedId,
    version: app.version,
    label: label ?? null,
    files,
    createdAt: now.getTime(),
  }
}

/**
 * List all snapshots for an app, newest first.
 */
export async function listSnapshots(appId: string): Promise<SnapshotSummary[]> {
  const rows = await db.select()
    .from(miniAppSnapshots)
    .where(eq(miniAppSnapshots.appId, appId))
    .orderBy(desc(miniAppSnapshots.version))
    .all()

  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    label: row.label,
    files: JSON.parse(row.fileManifest),
    createdAt: (row.createdAt as unknown as Date).getTime(),
  }))
}

/**
 * Rollback an app to a specific snapshot version.
 * Creates a snapshot of the current state first (so rollback is reversible).
 */
export async function rollbackToSnapshot(appId: string, targetVersion: number): Promise<{ success: boolean; message: string }> {
  const app = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!app) return { success: false, message: 'App not found' }

  const snapshot = await db.select()
    .from(miniAppSnapshots)
    .where(and(eq(miniAppSnapshots.appId, appId), eq(miniAppSnapshots.version, targetVersion)))
    .get()

  if (!snapshot) return { success: false, message: `Snapshot for version ${targetVersion} not found` }

  const snapDir = snapshotDir(app.agentId, appId, targetVersion)
  if (!existsSync(snapDir)) return { success: false, message: 'Snapshot files not found on disk' }

  // Create a snapshot of current state first (auto-backup)
  await createSnapshot(appId, `auto-backup before rollback to v${targetVersion}`)

  // Clear current app files (except .snapshots)
  const dir = appDir(app.agentId, appId)
  const currentFiles: { path: string; size: number }[] = []
  await walkDirForSnapshot(dir, dir, currentFiles)
  for (const file of currentFiles) {
    const filePath = join(dir, file.path)
    await unlink(filePath).catch(() => {})
  }

  // Copy snapshot files back
  const manifest: { path: string; size: number }[] = JSON.parse(snapshot.fileManifest)
  let hasBackend = false
  for (const file of manifest) {
    const srcPath = join(snapDir, file.path)
    const destPath = join(dir, file.path)
    if (existsSync(srcPath)) {
      await mkdir(dirname(destPath), { recursive: true })
      const content = await Bun.file(srcPath).arrayBuffer()
      await Bun.write(destPath, content)
      if (file.path === '_server.js' || file.path === '_server.ts') hasBackend = true
    }
  }

  // Update app version
  const newVersion = app.version + 1
  await db.update(miniApps).set({
    version: newVersion,
    hasBackend,
    updatedAt: new Date(),
  }).where(eq(miniApps.id, appId))

  // The restored file set may carry a different _server.js / app.json.
  notifyBackendRestart(appId)

  log.info({ appId, fromVersion: app.version, toVersion: targetVersion, newVersion }, 'App rolled back')

  return {
    success: true,
    message: `Rolled back to version ${targetVersion}. New version: ${newVersion}. ${manifest.length} files restored.`,
  }
}

/** Walk directory excluding .snapshots and the runtime data dir (_data) */
async function walkDirForSnapshot(base: string, current: string, results: { path: string; size: number }[]): Promise<void> {
  if (!existsSync(current)) return
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.snapshots') continue
    // ctx.files runtime data is not source code: never snapshotted/rolled back
    if (current === base && entry.name === '_data') continue
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) {
      await walkDirForSnapshot(base, fullPath, results)
    } else {
      const fileStat = await stat(fullPath)
      results.push({
        path: fullPath.slice(base.length + 1),
        size: fileStat.size,
      })
    }
  }
}

// ─── Icon generation ─────────────────────────────────────────────────────────

export async function generateMiniAppIcon(
  appId: string,
  options?: { providerId?: string; modelId?: string },
): Promise<MiniAppSummary> {
  const row = await db.select().from(miniApps).where(eq(miniApps.id, appId)).get()
  if (!row) throw new Error('Mini-app not found')

  const prompt = await buildMiniAppIconPrompt({
    name: row.name,
    description: row.description,
    icon: row.icon,
  })

  const result = await generateImage(prompt, {
    providerId: options?.providerId,
    modelId: options?.modelId,
  })

  // Save icon file to app directory
  const dir = appDir(row.agentId, appId)
  await mkdir(dir, { recursive: true })
  const ext = result.mediaType === 'image/webp' ? 'webp' : 'png'
  const iconPath = join(dir, `_icon.${ext}`)
  const buffer = Buffer.from(result.base64, 'base64')
  await Bun.write(iconPath, buffer)

  // Update DB with icon URL
  const iconUrl = `/api/mini-apps/${appId}/static/_icon.${ext}?v=${Date.now()}`
  await db.update(miniApps).set({ iconUrl, updatedAt: new Date() }).where(eq(miniApps.id, appId))

  log.info({ appId, iconUrl }, 'Mini-app icon generated')
  return (await getMiniApp(appId))!
}
