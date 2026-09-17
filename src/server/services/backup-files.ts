/** Offline, portable backups. No application imports: never initialize a live DB. */
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

type BackupEntry = { path: string; type: 'directory' | 'file' | 'link'; mode: number; sha256?: string; target?: string }
export interface BackupManifest {
  format: 1
  createdAt: string
  appVersion: string
  database: string
  roots: Record<string, string>
  sourceCwd: string
  storage: Record<string, string>
  entries: BackupEntry[]
}
export interface BackupOptions {
  dataDir: string
  dbPath: string
  destination: string
  appVersion: string
  instanceStopped: boolean
  encryptionKey?: string
  externalDirectories?: Record<string, string>
  includeFolders?: boolean
}

function within(root: string, file: string) {
  const rel = relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Inventory links without following them; outside-root links cannot be restored portably. */
async function inventory(root: string, prefix: string, omit = new Set<string>()): Promise<BackupEntry[]> {
  const entries: BackupEntry[] = []
  async function visit(name: string) {
    const absolute = join(root, name)
    if (omit.has(absolute)) return
    const stat = await lstat(absolute)
    const path = join(prefix, name)
    const mode = stat.mode & 0o777
    if (stat.isSymbolicLink()) {
      const target = resolve(dirname(absolute), await readlink(absolute))
      if (!within(root, target)) throw new Error(`Backup cannot include a link outside its storage root: ${path}`)
      entries.push({ path, type: 'link', mode, target: relative(dirname(absolute), target) || '.' })
    } else if (stat.isDirectory()) {
      entries.push({ path, type: 'directory', mode })
      for (const entry of (await readdir(absolute)).sort()) await visit(join(name, entry))
    } else if (stat.isFile()) entries.push({ path, type: 'file', mode, sha256: await digest(absolute) })
    else throw new Error(`Backup cannot include a socket or special file: ${path}`)
  }
  await visit('')
  return entries
}

function validateEntry(entry: BackupEntry, destination: string) {
  if (!entry.path || entry.path !== relative(destination, resolve(destination, entry.path)) || isAbsolute(entry.path) || !within(destination, resolve(destination, entry.path))) throw new Error('Invalid backup entry path')
  if (!['directory', 'file', 'link'].includes(entry.type)) throw new Error('Invalid backup entry type')
  if (entry.type === 'file' && !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error('Invalid backup file checksum')
  if (entry.type === 'link' && (!entry.target || isAbsolute(entry.target) || !within(destination, resolve(destination, dirname(entry.path), entry.target)))) throw new Error('Invalid backup link target')
}

export async function createFullBackup(options: BackupOptions): Promise<BackupManifest> {
  if (!options.instanceStopped) throw new Error('Stop Hivekeep and its external writers, then pass --stopped to create a coherent full backup')
  const dataDir = await realpath(resolve(options.dataDir))
  const database = await realpath(resolve(options.dbPath))
  let destination = resolve(options.destination)
  const roots: Record<string, string> = { data: dataDir }
  const storage: Record<string, string> = {}
  for (const [name, directory] of Object.entries(options.externalDirectories ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid storage variable: ${name}`)
    const absolute = await realpath(resolve(directory))
    if (!within(dataDir, absolute)) {
      roots[`external/${name}`] = absolute
      storage[name] = `external/${name}`
    } else storage[name] = join('data', relative(dataDir, absolute))
  }
  if (Object.values(roots).some((source) => within(source, destination))) throw new Error('Backup destination must be outside every source directory')
  if (await exists(destination)) throw new Error('Backup destination already exists')
  if (options.encryptionKey && !/^[a-fA-F0-9]{64}$/.test(options.encryptionKey)) throw new Error('ENCRYPTION_KEY must contain 64 hexadecimal characters')
  const key = options.encryptionKey ?? (await readFile(join(dataDir, '.encryption-key'), 'utf8')).trim()
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('No valid encryption key is available for this backup')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  destination = join(await realpath(dirname(destination)), basename(destination))
  if (Object.values(roots).some((source) => within(source, destination))) throw new Error('Backup destination must be outside every source directory')
  const staging = await mkdtemp(join(dirname(destination), '.hivekeep-backup-'))
  await chmod(staging, 0o700)
  const dbRelative = within(dataDir, database) ? join('data', relative(dataDir, database)) : 'external/database/hivekeep.db'
  const omitted = new Set([database, `${database}-wal`, `${database}-shm`, join(dataDir, '.encryption-key'), join(dataDir, '.backup-status.json')])
  let db: Database | undefined
  try {
    db = new Database(database, { readwrite: true, create: false })
    db.exec('PRAGMA busy_timeout = 1000')
    db.exec('BEGIN IMMEDIATE') // Reject active writers; keep DB stable during the copy.
    const hasFolders = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_folders'").get()
    if (hasFolders) {
      const folders = db.query('SELECT id, path FROM workspace_folders').all() as Array<{ id: string; path: string }>
      for (const folder of folders) {
        const absolute = await realpath(resolve(folder.path))
        if (Object.values(roots).some((source) => within(source, absolute))) continue
        if (!options.includeFolders) throw new Error(`Registered folder outside managed storage: ${folder.path}. Pass --include-folders to include registered folders.`)
        if (!/^[a-zA-Z0-9_-]+$/.test(folder.id)) throw new Error('Invalid registered folder id')
        if (within(absolute, destination)) throw new Error('Backup destination must be outside registered folders')
        roots[`folders/${folder.id}`] = absolute
      }
    }
    const before = (await Promise.all(Object.entries(roots).map(([prefix, source]) => inventory(source, prefix, omitted)))).flat()
    for (const entry of before) {
      const output = join(staging, entry.path)
      if (entry.type === 'directory') await mkdir(output, { recursive: true, mode: 0o700 })
      else if (entry.type === 'link') await symlink(entry.target!, output)
      else {
        const prefix = Object.keys(roots).sort((a, b) => b.length - a.length).find((value) => entry.path.startsWith(`${value}/`))!
        await copyFile(join(roots[prefix]!, relative(prefix, entry.path)), output)
        await chmod(output, 0o600)
      }
    }
    const after = (await Promise.all(Object.entries(roots).map(([prefix, source]) => inventory(source, prefix, omitted)))).flat()
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Storage changed during backup; stop all writers and retry')
    await mkdir(dirname(join(staging, dbRelative)), { recursive: true, mode: 0o700 })
    // serialize includes committed WAL pages, so the backup never depends on
    // copying a changing -wal sidecar or on optional virtual-table extensions.
    await writeFile(join(staging, dbRelative), db.serialize(), { mode: 0o600 })
    await writeFile(join(staging, 'data', '.encryption-key'), key, { mode: 0o600 })
    const entries = await inventory(staging, '')
    const manifest: BackupManifest = {
      format: 1, createdAt: new Date().toISOString(), appVersion: options.appVersion,
      database: dbRelative, roots, sourceCwd: process.cwd(), storage, entries: entries.filter((entry) => entry.path !== '.'),
    }
    // Restore executable bits from source even though the backup itself is private.
    for (const entry of manifest.entries) {
      const original = before.find((item) => item.path === entry.path)
      if (original) entry.mode = original.mode
    }
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    await verifyFullBackup(staging)
    await rename(staging, destination)
    return manifest
  } finally {
    if (db?.inTransaction) db.exec('ROLLBACK')
    db?.close()
    await rm(staging, { recursive: true, force: true })
  }
}

export async function verifyFullBackup(directory: string): Promise<BackupManifest> {
  const root = await realpath(resolve(directory))
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as BackupManifest
  if (manifest.format !== 1 || !Array.isArray(manifest.entries) || typeof manifest.database !== 'string') throw new Error('Unsupported backup manifest')
  if (!manifest.roots || typeof manifest.roots !== 'object' || !manifest.storage || typeof manifest.storage !== 'object' || typeof manifest.sourceCwd !== 'string') throw new Error('Invalid backup storage mapping')
  for (const [prefix, original] of Object.entries(manifest.roots)) {
    validateEntry({ path: prefix, type: 'directory', mode: 0o700 }, root)
    if (typeof original !== 'string' || !isAbsolute(original)) throw new Error('Invalid backup source root')
  }
  for (const [variable, storagePath] of Object.entries(manifest.storage)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(variable)) throw new Error('Invalid backup storage variable')
    validateEntry({ path: storagePath, type: 'directory', mode: 0o700 }, root)
  }
  const names = new Set<string>()
  for (const entry of manifest.entries) {
    validateEntry(entry, root)
    if (names.has(entry.path)) throw new Error('Duplicate backup entry')
    names.add(entry.path)
    const absolute = join(root, entry.path)
    const stat = await lstat(absolute)
    // No entry may traverse a symlink, even if a crafted manifest labels it as
    // a directory. Link files themselves are read with readlink, never followed.
    if (entry.type === 'directory' && !stat.isDirectory()) throw new Error(`Invalid backup directory: ${entry.path}`)
    if (entry.type === 'file') {
      if (!stat.isFile() || !within(root, await realpath(absolute))) throw new Error(`Invalid backup file: ${entry.path}`)
      if (await digest(absolute) !== entry.sha256) throw new Error(`Backup checksum mismatch: ${entry.path}`)
    }
    if (entry.type === 'link' && (!stat.isSymbolicLink() || await readlink(absolute) !== entry.target)) throw new Error(`Invalid backup link: ${entry.path}`)
  }
  validateEntry({ path: manifest.database, type: 'file', mode: 0o600, sha256: '0'.repeat(64) }, root)
  if (!names.has(manifest.database) || !names.has('data/.encryption-key')) throw new Error('Backup lacks its database or encryption key')
  const db = new Database(join(root, manifest.database), { readonly: true })
  try {
    const result = db.query('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    if (result.some((row) => row.quick_check !== 'ok')) throw new Error('Backup database integrity check failed')
  } finally { db.close() }
  return manifest
}

/** Restore only into a new directory. Never replace or delete a live installation. */
export async function restoreFullBackup(directory: string, destination: string): Promise<BackupManifest> {
  const source = await realpath(resolve(directory))
  const target = resolve(destination)
  if (await exists(target)) throw new Error('Restore destination must not exist; choose a new isolated directory')
  if (within(source, target)) throw new Error('Restore destination must be outside the backup')
  const manifest = await verifyFullBackup(source)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(dirname(target), '.hivekeep-restore-'))
  try {
    for (const entry of manifest.entries.filter((item) => item.type !== 'link')) {
      const output = join(staging, entry.path)
      if (entry.type === 'directory') await mkdir(output, { recursive: true, mode: 0o700 })
      else {
        await mkdir(dirname(output), { recursive: true, mode: 0o700 })
        await copyFile(join(source, entry.path), output)
        // The destination root stays private, executable plugin assets keep their bits.
        await chmod(output, entry.path.endsWith('.encryption-key') ? 0o600 : entry.mode & 0o700)
      }
    }
    for (const entry of manifest.entries.filter((item) => item.type === 'link')) await symlink(entry.target!, join(staging, entry.path))
    // Files and workspaces are stored as absolute or cwd-relative paths in
    // SQLite. Rebase only known filesystem columns; never rewrite conversation
    // content, provider URLs or arbitrary configuration values.
    const mappings = Object.entries(manifest.roots).sort((a, b) => b[1].length - a[1].length)
    const rebase = (value: string) => {
      const absolute = resolve(manifest.sourceCwd, value)
      const mapping = mappings.find(([, original]) => within(original, absolute))
      return mapping ? join(target, mapping[0], relative(mapping[1], absolute)) : value
    }
    const db = new Database(join(staging, manifest.database))
    try {
      db.transaction(() => {
        const columns: Record<string, string[]> = {
          agents: ['workspace_path', 'avatar_path'], files: ['stored_path'],
          vault_attachments: ['stored_path'], file_storage: ['stored_path'],
          workspace_folders: ['path'], terminal_sessions: ['last_cwd'], terminal_presets: ['cwd'],
        }
        for (const [table, candidates] of Object.entries(columns)) {
          const existing = new Set((db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((row) => row.name))
          for (const column of candidates.filter((name) => existing.has(name))) {
            const rows = db.query(`SELECT id, "${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`).all() as Array<{ id: string; value: string }>
            for (const row of rows) {
              const next = rebase(row.value)
              if (next !== row.value) db.query(`UPDATE "${table}" SET "${column}" = ? WHERE id = ?`).run(next, row.id)
            }
          }
        }
        const taskColumns = db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
        if (taskColumns.some((column) => column.name === 'prompt_context_snapshot')) {
          const rows = db.query('SELECT id, prompt_context_snapshot AS value FROM tasks WHERE prompt_context_snapshot IS NOT NULL').all() as Array<{ id: string; value: string }>
          for (const row of rows) {
            let snapshot: { agent?: { workspacePath?: string } }
            try { snapshot = JSON.parse(row.value) } catch { continue }
            if (typeof snapshot.agent?.workspacePath === 'string') {
              snapshot.agent.workspacePath = rebase(snapshot.agent.workspacePath)
              db.query('UPDATE tasks SET prompt_context_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), row.id)
            }
          }
        }
      })()
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { db.close() }
    const env: Record<string, string> = { HIVEKEEP_DATA_DIR: join(target, 'data'), DB_PATH: join(target, manifest.database) }
    for (const [variable, relativePath] of Object.entries(manifest.storage)) env[variable] = join(target, relativePath)
    await writeFile(join(staging, 'restore-env.json'), JSON.stringify(env, null, 2), { mode: 0o600 })
    await rename(staging, target)
    return manifest
  } finally { await rm(staging, { recursive: true, force: true }) }
}
