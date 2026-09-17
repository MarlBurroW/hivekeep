import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFullBackup, restoreFullBackup, verifyFullBackup } from './backup-files'
import { getBackupStatus, recordVerifiedBackup } from './backup-status'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hivekeep-backup-test-'))
  directories.push(root)
  const dataDir = join(root, 'data')
  await mkdir(join(dataDir, 'plugins', 'fixture'), { recursive: true })
  await mkdir(join(dataDir, 'uploads'))
  await writeFile(join(dataDir, '.encryption-key'), 'ab'.repeat(32), { mode: 0o600 })
  await writeFile(join(dataDir, 'plugins', 'fixture', 'index.js'), 'module.exports = "restored"')
  await writeFile(join(dataDir, 'uploads', 'attachment.txt'), 'important attachment')
  await symlink('attachment.txt', join(dataDir, 'uploads', 'latest'))
  const dbPath = join(dataDir, 'hivekeep.db')
  const db = new Database(dbPath)
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE vault (id TEXT PRIMARY KEY, encrypted TEXT)')
  const key = await crypto.subtle.importKey('raw', Buffer.from('ab'.repeat(32), 'hex'), 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('fixture-secret'))
  db.query('INSERT INTO vault VALUES (?, ?)').run('test', Buffer.concat([iv, Buffer.from(encrypted)]).toString('base64'))
  db.close()
  return { root, dataDir, dbPath, destination: join(root, 'backup'), appVersion: 'test', instanceStopped: true }
}

describe('full backup and isolated restore', () => {
  it('restores DB, encrypted secrets, attachments, plugin code and internal links', async () => {
    const options = await fixture()
    const sourceDb = new Database(options.dbPath)
    sourceDb.exec('CREATE TABLE files (id TEXT PRIMARY KEY, stored_path TEXT); CREATE TABLE agents (id TEXT PRIMARY KEY, workspace_path TEXT)')
    sourceDb.query('INSERT INTO files VALUES (?, ?)').run('attachment', join(options.dataDir, 'uploads', 'attachment.txt'))
    sourceDb.query('INSERT INTO agents VALUES (?, ?)').run('agent', join(options.dataDir, 'plugins', 'fixture'))
    sourceDb.close()
    await createFullBackup(options)
    const target = join(options.root, 'restored')
    await restoreFullBackup(options.destination, target)
    const db = new Database(join(target, 'data', 'hivekeep.db'), { readonly: true })
    const row = db.query('SELECT encrypted FROM vault WHERE id = ?').get('test') as { encrypted: string }
    const restoredFile = db.query('SELECT stored_path FROM files').get() as { stored_path: string }
    expect(restoredFile.stored_path).toBe(join(target, 'data', 'uploads', 'attachment.txt'))
    expect(await readFile(restoredFile.stored_path, 'utf8')).toBe('important attachment')
    db.close()
    const restoredKey = (await readFile(join(target, 'data', '.encryption-key'), 'utf8')).trim()
    const key = await crypto.subtle.importKey('raw', Buffer.from(restoredKey, 'hex'), 'AES-GCM', false, ['decrypt'])
    const combined = Buffer.from(row.encrypted, 'base64')
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.subarray(0, 12) }, key, combined.subarray(12))
    expect(new TextDecoder().decode(decrypted)).toBe('fixture-secret')
    expect(await readFile(join(target, 'data', 'uploads', 'latest'), 'utf8')).toBe('important attachment')
    expect(require(join(target, 'data', 'plugins', 'fixture', 'index.js'))).toBe('restored')
    expect((await lstat(options.destination)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(options.destination, 'data', '.encryption-key'))).mode & 0o777).toBe(0o600)
  })

  it('captures committed WAL pages even when a database connection stays open', async () => {
    const options = await fixture()
    const reader = new Database(options.dbPath)
    reader.exec("INSERT INTO vault VALUES ('wal', 'committed')")
    try {
      await createFullBackup(options)
      const restored = new Database(join(options.destination, 'data', 'hivekeep.db'), { readonly: true })
      expect((restored.query("SELECT encrypted FROM vault WHERE id='wal'").get() as { encrypted: string }).encrypted).toBe('committed')
      restored.close()
    } finally { reader.close() }
  })

  it('includes configured storage outside dataDir and an environment-provided key', async () => {
    const options = await fixture()
    const external = join(options.root, 'external-uploads')
    await mkdir(external)
    await writeFile(join(external, 'outside.txt'), 'external storage')
    await createFullBackup({ ...options, encryptionKey: 'cd'.repeat(32), externalDirectories: { UPLOAD_DIR: external } })
    const target = join(options.root, 'restored')
    await restoreFullBackup(options.destination, target)
    expect(await readFile(join(target, 'external', 'UPLOAD_DIR', 'outside.txt'), 'utf8')).toBe('external storage')
    expect(await readFile(join(target, 'data', '.encryption-key'), 'utf8')).toBe('cd'.repeat(32))
    expect(JSON.parse(await readFile(join(target, 'restore-env.json'), 'utf8')).UPLOAD_DIR).toBe(join(target, 'external', 'UPLOAD_DIR'))
  })

  it('refuses live-style backup, recursive output and replacing an existing installation', async () => {
    const options = await fixture()
    await expect(createFullBackup({ ...options, instanceStopped: false })).rejects.toThrow('--stopped')
    await expect(createFullBackup({ ...options, destination: join(options.dataDir, 'backup') })).rejects.toThrow('outside')
    await createFullBackup(options)
    await expect(restoreFullBackup(options.destination, options.dataDir)).rejects.toThrow('must not exist')
    expect(await readFile(join(options.dataDir, 'uploads', 'attachment.txt'), 'utf8')).toBe('important attachment')
  })

  it('rejects corrupt files and links that escape a storage root', async () => {
    const options = await fixture()
    await createFullBackup(options)
    await writeFile(join(options.destination, 'data', 'uploads', 'attachment.txt'), 'corrupt')
    await expect(verifyFullBackup(options.destination)).rejects.toThrow('checksum mismatch')
    await symlink('/etc/passwd', join(options.dataDir, 'escape'))
    await expect(createFullBackup({ ...options, destination: join(options.root, 'second-backup') })).rejects.toThrow('outside its storage root')
  })

  it('requires explicit inclusion of registered folders outside managed storage', async () => {
    const options = await fixture()
    const folder = join(options.root, 'user-folder')
    await mkdir(folder)
    await writeFile(join(folder, 'work.txt'), 'registered work')
    const db = new Database(options.dbPath)
    db.exec('CREATE TABLE workspace_folders (id TEXT PRIMARY KEY, path TEXT)')
    db.query('INSERT INTO workspace_folders VALUES (?, ?)').run('folder-1', folder)
    db.close()
    await expect(createFullBackup(options)).rejects.toThrow('--include-folders')
    await createFullBackup({ ...options, includeFolders: true })
    const target = join(options.root, 'restored')
    await restoreFullBackup(options.destination, target)
    const restored = new Database(join(target, 'data', 'hivekeep.db'), { readonly: true })
    const row = restored.query('SELECT path FROM workspace_folders').get() as { path: string }
    restored.close()
    expect(await readFile(join(row.path, 'work.txt'), 'utf8')).toBe('registered work')
  })

  it('records verification for the current installation and resets status on isolated restore', async () => {
    const options = await fixture()
    expect((await getBackupStatus(options.dataDir)).lastVerifiedAt).toBeNull()
    const manifest = await createFullBackup(options)
    await verifyFullBackup(options.destination)
    await recordVerifiedBackup(options.dataDir, manifest.roots.data!, manifest.createdAt)
    const status = await getBackupStatus(options.dataDir)
    expect(status.lastVerifiedAt).not.toBeNull()
    expect(Object.keys(status).sort()).toEqual(['backupCreatedAt', 'lastVerifiedAt'])
    const target = join(options.root, 'restored')
    await restoreFullBackup(options.destination, target)
    expect((await getBackupStatus(join(target, 'data'))).lastVerifiedAt).toBeNull()
    expect(await recordVerifiedBackup(join(target, 'data'), manifest.roots.data!, manifest.createdAt)).toBe(false)
  })
})
