import { readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export interface BackupStatus { lastVerifiedAt: string | null; backupCreatedAt: string | null }
const unknownStatus: BackupStatus = { lastVerifiedAt: null, backupCreatedAt: null }

/** Only the CLI calls this, after verification has succeeded. */
export async function recordVerifiedBackup(dataDir: string, sourceDataDir: string, createdAt: string): Promise<boolean> {
  let current: string
  try { current = await realpath(resolve(dataDir)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (current !== sourceDataDir) return false
  const marker = join(current, '.backup-status.json')
  const temporary = `${marker}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ dataDir: current, lastVerifiedAt: new Date().toISOString(), backupCreatedAt: createdAt }), { mode: 0o600 })
  await rename(temporary, marker)
  return true
}

/** Never return local paths, keys or archive locations to the browser. */
export async function getBackupStatus(dataDir: string): Promise<BackupStatus> {
  try {
    const current = await realpath(resolve(dataDir))
    const marker = JSON.parse(await readFile(join(current, '.backup-status.json'), 'utf8'))
    if (marker.dataDir !== current || typeof marker.lastVerifiedAt !== 'string' || typeof marker.backupCreatedAt !== 'string') return unknownStatus
    if (!Number.isFinite(Date.parse(marker.lastVerifiedAt)) || !Number.isFinite(Date.parse(marker.backupCreatedAt))) return unknownStatus
    return { lastVerifiedAt: marker.lastVerifiedAt, backupCreatedAt: marker.backupCreatedAt }
  } catch { return unknownStatus }
}
