import { useCallback, useSyncExternalStore } from 'react'
import { useAuth } from '@/client/hooks/useAuth'

export interface PendingFile {
  localId: string
  serverId: string | null
  serverUrl: string | null
  /** Bytes are only needed until the upload completes. */
  file: File | null
  name: string
  mimeType: string
  size: number
  previewUrl: string | null
  status: 'uploading' | 'done' | 'error'
  error?: string
}

const EMPTY: PendingFile[] = []
const uploads = new Map<string, PendingFile[]>()
const listeners = new Set<() => void>()
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

function readFiles(key: string | null): PendingFile[] {
  if (!key) return EMPTY
  if (uploads.has(key)) return uploads.get(key)!
  let files: PendingFile[] = []
  try {
    const raw = localStorage.getItem(key)
    const stored = raw ? JSON.parse(raw) : null
    if (stored && Date.now() - stored.ts < MAX_AGE && Array.isArray(stored.files)) {
      files = stored.files.filter((f: PendingFile) => typeof f.name === 'string' && typeof f.localId === 'string')
        .map((f: PendingFile) => ({ ...f, file: null, previewUrl: f.mimeType.startsWith('image/') ? f.serverUrl : null }))
    } else if (raw) localStorage.removeItem(key)
  } catch { /* Browser storage is optional. */ }
  uploads.set(key, files)
  return files
}

function updateFiles(key: string, update: (files: PendingFile[]) => PendingFile[]) {
  const files = update(readFiles(key))
  uploads.set(key, files)
  try {
    // Persist references, never File bytes/object URLs. A hard reload during
    // upload shows a recoverable error instead of a forever-spinning attachment.
    const persisted = files.map(({ file: _file, previewUrl: _preview, ...entry }) => ({
      ...entry,
      status: entry.status === 'uploading' ? 'error' : entry.status,
      ...(entry.status === 'uploading' ? { error: 'Upload interrupted. Remove this file and attach it again.' } : {}),
    }))
    if (files.length) localStorage.setItem(key, JSON.stringify({ ts: Date.now(), files: persisted }))
    else localStorage.removeItem(key)
  } catch { /* Browser storage is optional. */ }
  for (const notify of listeners) notify()
}

function revoke(file: PendingFile) {
  if (file.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(file.previewUrl)
}

/** An upload belongs to the account/conversation, not the mounted composer.
 * In-flight requests finish after navigation; completed references survive reload. */
export function useFileUpload(agentId: string, conversationId = agentId) {
  const { user } = useAuth()
  const key = user ? `hivekeep:attachments:v1:${encodeURIComponent(user.id)}:${encodeURIComponent(conversationId)}` : null
  const pendingFiles = useSyncExternalStore(
    useCallback((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, []),
    useCallback(() => readFiles(key), [key]),
    () => EMPTY,
  )

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    if (!key) return
    const entries: PendingFile[] = Array.from(fileList).map((file) => ({
      localId: crypto.randomUUID(), serverId: null, serverUrl: null, file,
      name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      status: 'uploading',
    }))
    updateFiles(key, (files) => [...files, ...entries])
    await Promise.all(entries.map(async (entry) => {
      try {
        const formData = new FormData()
        formData.append('file', entry.file!)
        formData.append('agentId', agentId)
        if (conversationId.startsWith('quick-')) formData.append('sessionId', conversationId.slice(6))
        const response = await fetch('/api/files/upload', { method: 'POST', credentials: 'include', body: formData })
        const data = await response.json()
        if (!response.ok) throw new Error(data?.error?.message ?? 'Upload failed')
        updateFiles(key, (files) => files.map((f) => f.localId === entry.localId
          ? { ...f, file: null, status: 'done', serverId: data.file.id, serverUrl: data.file.url } : f))
      } catch (error) {
        updateFiles(key, (files) => files.map((f) => f.localId === entry.localId
          ? { ...f, file: null, status: 'error', error: error instanceof Error ? error.message : 'Upload failed' } : f))
      }
    }))
  }, [agentId, conversationId, key])

  const removeFile = useCallback((localId: string) => {
    if (!key) return
    updateFiles(key, (files) => files.filter((file) => {
      if (file.localId !== localId) return true
      revoke(file)
      return false
    }))
  }, [key])

  const clearFiles = useCallback(() => {
    if (!key) return
    updateFiles(key, (files) => { files.forEach(revoke); return [] })
  }, [key])

  return { pendingFiles, addFiles, removeFile, clearFiles, isUploading: pendingFiles.some((file) => file.status === 'uploading') }
}
