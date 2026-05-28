import { eq, like, or, lt, and, isNotNull, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { join, extname } from 'path'
import { mkdir, unlink, copyFile, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { fileStorage } from '@/server/db/schema'
import { config } from '@/server/config'

const log = createLogger('file-storage')

// 0 (or negative) means "no limit" — uploads of any size are accepted.
const MAX_FILE_SIZE =
  config.fileStorage.maxFileSizeMb > 0
    ? config.fileStorage.maxFileSizeMb * 1024 * 1024
    : Infinity

type FileStorageRow = typeof fileStorage.$inferSelect

// ─── Helpers ────────────────────────────────────────────────────────────────

function getExtension(filename: string): string {
  const ext = extname(filename)
  return ext ? ext.slice(1) : ''
}

function storageDirForKin(kinId: string): string {
  return join(config.fileStorage.dir, kinId)
}

function storedFileName(id: string, originalName: string): string {
  const ext = getExtension(originalName)
  return `${id}${ext ? `.${ext}` : ''}`
}

export function buildShareUrl(accessToken: string): string {
  return `${config.publicUrl.replace(/\/+$/, '')}/s/${accessToken}`
}

function serializeFileMetadata(f: FileStorageRow) {
  return {
    id: f.id,
    kinId: f.kinId,
    name: f.name,
    description: f.description,
    originalName: f.originalName,
    mimeType: f.mimeType,
    size: f.size,
    isPublic: f.isPublic,
    hasPassword: !!f.passwordHash,
    readAndBurn: f.readAndBurn,
    expiresAt: f.expiresAt ? f.expiresAt.getTime() : null,
    downloadCount: f.downloadCount,
    url: buildShareUrl(f.accessToken),
    createdByKinId: f.createdByKinId,
    createdAt: f.createdAt.getTime(),
    updatedAt: f.updatedAt.getTime(),
  }
}

// ─── Create ─────────────────────────────────────────────────────────────────

export interface CreateFileParams {
  kinId: string
  name: string
  originalName: string
  buffer: Buffer | ArrayBuffer
  mimeType: string
  description?: string
  isPublic?: boolean
  password?: string
  expiresIn?: number // minutes
  readAndBurn?: boolean
  createdByKinId?: string
}

export async function createFile(params: CreateFileParams) {
  const {
    kinId, name, originalName, buffer, mimeType,
    description, isPublic = true, password, expiresIn, readAndBurn = false, createdByKinId,
  } = params

  const size = buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.length
  if (size > MAX_FILE_SIZE) {
    throw new Error(`File too large: max ${config.fileStorage.maxFileSizeMb} MB`)
  }
  if (size === 0) {
    throw new Error('File is empty')
  }

  const id = uuid()
  const accessToken = uuid()
  const dir = storageDirForKin(kinId)
  const fileName = storedFileName(id, originalName)
  const storedPath = join(dir, fileName)

  await mkdir(dir, { recursive: true })
  await Bun.write(storedPath, buffer)

  const now = new Date()
  const expiresAt = expiresIn ? new Date(now.getTime() + expiresIn * 60 * 1000) : null
  const passwordHash = password ? await Bun.password.hash(password) : null

  await db.insert(fileStorage).values({
    id,
    kinId,
    name,
    description: description ?? null,
    originalName,
    storedPath,
    mimeType,
    size,
    accessToken,
    passwordHash,
    isPublic,
    readAndBurn,
    expiresAt,
    downloadCount: 0,
    createdByKinId: createdByKinId ?? null,
    createdAt: now,
    updatedAt: now,
  })

  log.info({ kinId, fileId: id, name, size, mimeType }, 'File stored')

  return {
    id,
    name,
    originalName,
    mimeType,
    size,
    url: buildShareUrl(accessToken),
    isPublic,
    hasPassword: !!passwordHash,
    readAndBurn,
    expiresAt: expiresAt ? expiresAt.getTime() : null,
  }
}

// ─── Create from content (for Kin tools) ────────────────────────────────────

export async function createFileFromContent(
  kinId: string,
  name: string,
  content: string,
  mimeType: string,
  options: {
    isBase64?: boolean
    description?: string
    isPublic?: boolean
    password?: string
    expiresIn?: number
    readAndBurn?: boolean
    createdByKinId?: string
  } = {},
) {
  const buffer = options.isBase64
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf-8')

  const ext = mimeTypeToExt(mimeType) || 'bin'
  const originalName = `${name}.${ext}`

  return createFile({
    kinId,
    name,
    originalName,
    buffer,
    mimeType,
    ...options,
  })
}

// ─── Create from workspace file ─────────────────────────────────────────────

export async function createFileFromWorkspace(
  kinId: string,
  workspacePath: string,
  name: string,
  options: {
    description?: string
    isPublic?: boolean
    password?: string
    expiresIn?: number
    readAndBurn?: boolean
    createdByKinId?: string
  } = {},
) {
  const workspaceBase = join(config.workspace.baseDir, kinId)
  const resolvedPath = join(workspaceBase, workspacePath)

  // Prevent path traversal
  if (!resolvedPath.startsWith(workspaceBase)) {
    throw new Error('Invalid workspace path: path traversal detected')
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found in workspace: ${workspacePath}`)
  }

  const fileStat = await stat(resolvedPath)
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: max ${config.fileStorage.maxFileSizeMb} MB`)
  }

  const originalName = workspacePath.split('/').pop() || 'file'
  const id = uuid()
  const accessToken = uuid()
  const dir = storageDirForKin(kinId)
  const storedName = storedFileName(id, originalName)
  const storedPath = join(dir, storedName)

  await mkdir(dir, { recursive: true })
  await copyFile(resolvedPath, storedPath)

  const mimeType = guessMimeType(originalName)
  const now = new Date()
  const expiresAt = options.expiresIn ? new Date(now.getTime() + options.expiresIn * 60 * 1000) : null
  const passwordHash = options.password ? await Bun.password.hash(options.password) : null

  await db.insert(fileStorage).values({
    id,
    kinId,
    name,
    description: options.description ?? null,
    originalName,
    storedPath,
    mimeType,
    size: fileStat.size,
    accessToken,
    passwordHash,
    isPublic: options.isPublic ?? true,
    readAndBurn: options.readAndBurn ?? false,
    expiresAt,
    downloadCount: 0,
    createdByKinId: options.createdByKinId ?? null,
    createdAt: now,
    updatedAt: now,
  })

  log.info({ kinId, fileId: id, name, size: fileStat.size }, 'File stored from workspace')

  return {
    id,
    name,
    originalName,
    mimeType,
    size: fileStat.size,
    url: buildShareUrl(accessToken),
    isPublic: options.isPublic ?? true,
    hasPassword: !!passwordHash,
    readAndBurn: options.readAndBurn ?? false,
    expiresAt: expiresAt ? expiresAt.getTime() : null,
  }
}

// ─── Create from URL ────────────────────────────────────────────────────────

export async function createFileFromUrl(
  kinId: string,
  url: string,
  name: string,
  options: {
    description?: string
    isPublic?: boolean
    password?: string
    expiresIn?: number
    readAndBurn?: boolean
    createdByKinId?: string
  } = {},
) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: max ${config.fileStorage.maxFileSizeMb} MB`)
  }

  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const mimeType = (contentType.split(';')[0] ?? contentType).trim()

  // Try to extract original filename from URL or Content-Disposition
  const disposition = response.headers.get('content-disposition')
  let originalName = name
  if (disposition) {
    const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
    if (match?.[1]) originalName = match[1].replace(/['"]/g, '')
  } else {
    const urlPath = new URL(url).pathname
    const urlFileName = urlPath.split('/').pop()
    if (urlFileName && urlFileName.includes('.')) originalName = urlFileName
  }

  return createFile({
    kinId,
    name,
    originalName,
    buffer,
    mimeType,
    ...options,
  })
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function getFileById(id: string) {
  const file = await db.select().from(fileStorage).where(eq(fileStorage.id, id)).get()
  return file ? serializeFileMetadata(file) : null
}

export async function getFileByToken(token: string) {
  const file = await db.select().from(fileStorage).where(eq(fileStorage.accessToken, token)).get()
  return file ?? null
}

export async function getFileByName(kinId: string, name: string) {
  const file = await db.select().from(fileStorage)
    .where(and(eq(fileStorage.kinId, kinId), eq(fileStorage.name, name)))
    .get()
  return file ? serializeFileMetadata(file) : null
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listFiles(kinId?: string) {
  const query = kinId
    ? db.select().from(fileStorage).where(eq(fileStorage.kinId, kinId)).orderBy(desc(fileStorage.createdAt))
    : db.select().from(fileStorage).orderBy(desc(fileStorage.createdAt))

  const rows = await query.all()
  return rows.map(serializeFileMetadata)
}

// ─── Search ─────────────────────────────────────────────────────────────────

export async function searchFiles(query: string, kinId?: string) {
  const pattern = `%${query}%`
  const nameOrDesc = or(like(fileStorage.name, pattern), like(fileStorage.description, pattern))

  const condition = kinId
    ? and(eq(fileStorage.kinId, kinId), nameOrDesc)
    : nameOrDesc

  const rows = await db.select().from(fileStorage)
    .where(condition!)
    .orderBy(desc(fileStorage.createdAt))
    .all()

  return rows.map(serializeFileMetadata)
}

// ─── Update ─────────────────────────────────────────────────────────────────

export interface UpdateFileParams {
  name?: string
  description?: string | null
  isPublic?: boolean
  password?: string | null // null to remove password
  expiresIn?: number | null // null to remove expiry
  readAndBurn?: boolean
}

export async function updateFile(id: string, params: UpdateFileParams) {
  const existing = await db.select().from(fileStorage).where(eq(fileStorage.id, id)).get()
  if (!existing) return null

  const updates: Record<string, unknown> = { updatedAt: new Date() }

  if (params.name !== undefined) updates.name = params.name
  if (params.description !== undefined) updates.description = params.description
  if (params.isPublic !== undefined) updates.isPublic = params.isPublic
  if (params.readAndBurn !== undefined) updates.readAndBurn = params.readAndBurn

  if (params.password !== undefined) {
    updates.passwordHash = params.password ? await Bun.password.hash(params.password) : null
  }

  if (params.expiresIn !== undefined) {
    updates.expiresAt = params.expiresIn
      ? new Date(Date.now() + params.expiresIn * 60 * 1000)
      : null
  }

  await db.update(fileStorage).set(updates).where(eq(fileStorage.id, id))

  log.info({ fileId: id }, 'File metadata updated')
  return getFileById(id)
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteFile(id: string) {
  const file = await db.select().from(fileStorage).where(eq(fileStorage.id, id)).get()
  if (!file) return false

  // Delete from disk
  try {
    if (existsSync(file.storedPath)) {
      await unlink(file.storedPath)
    }
  } catch (err) {
    log.warn({ fileId: id, path: file.storedPath, error: err }, 'Failed to delete file from disk')
  }

  // Delete from DB
  await db.delete(fileStorage).where(eq(fileStorage.id, id))
  log.info({ fileId: id, name: file.name }, 'File deleted')
  return true
}

// ─── Download (public access) ───────────────────────────────────────────────

export interface DownloadResult {
  filePath: string
  originalName: string
  mimeType: string
  size: number
}

export async function downloadFile(
  token: string,
  password?: string,
): Promise<{ error: string; status: number } | { file: DownloadResult; needsPassword: boolean }> {
  const file = await getFileByToken(token)
  if (!file) {
    return { error: 'File not found', status: 404 }
  }

  // Check expiry
  if (file.expiresAt && file.expiresAt.getTime() < Date.now()) {
    // Clean up expired file
    await deleteFile(file.id)
    return { error: 'File has expired', status: 410 }
  }

  // Check password
  if (file.passwordHash) {
    if (!password) {
      return { file: { filePath: '', originalName: '', mimeType: '', size: 0 }, needsPassword: true }
    }
    const valid = await Bun.password.verify(password, file.passwordHash)
    if (!valid) {
      return { error: 'Invalid password', status: 403 }
    }
  }

  // Check file exists on disk
  if (!existsSync(file.storedPath)) {
    log.error({ fileId: file.id, path: file.storedPath }, 'Stored file not found on disk')
    return { error: 'File not found on disk', status: 500 }
  }

  // Increment download count
  await db.update(fileStorage)
    .set({ downloadCount: file.downloadCount + 1 })
    .where(eq(fileStorage.id, file.id))

  const result: DownloadResult = {
    filePath: file.storedPath,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.size,
  }

  // Handle read-and-burn: schedule deletion after serving
  if (file.readAndBurn) {
    // Delete after a short delay to ensure the file is served
    setTimeout(async () => {
      await deleteFile(file.id)
      log.info({ fileId: file.id, name: file.name }, 'Read-and-burn file deleted after download')
    }, 5000)
  }

  return { file: result, needsPassword: false }
}

// ─── Cleanup expired files ──────────────────────────────────────────────────

export async function cleanExpiredFiles() {
  const now = new Date()
  const expired = await db.select().from(fileStorage)
    .where(and(isNotNull(fileStorage.expiresAt), lt(fileStorage.expiresAt, now)))
    .all()

  if (expired.length === 0) return 0

  for (const file of expired) {
    await deleteFile(file.id)
  }

  log.info({ count: expired.length }, 'Expired files cleaned up')
  return expired.length
}

// ─── MIME type helpers ──────────────────────────────────────────────────────

const MIME_TO_EXT: Record<string, string> = {
  'text/plain': 'txt',
  'text/html': 'html',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
}

function mimeTypeToExt(mimeType: string): string | null {
  return MIME_TO_EXT[mimeType] ?? null
}

const EXT_TO_MIME: Record<string, string> = {
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  js: 'application/javascript',
  ts: 'text/typescript',
  py: 'text/x-python',
}

function guessMimeType(filename: string): string {
  const ext = getExtension(filename).toLowerCase()
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}
