import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Run after plugin-storage-smoke in the disposable Docker CI volume.
if (process.getuid?.() !== 1001) throw new Error('Expected the production runtime UID 1001')
const dataDir = resolve(process.env.HIVEKEEP_DATA_DIR ?? '/app/data')
if (await Bun.file(join(dataDir, 'hivekeep.db')).exists() || await Bun.file(join(dataDir, '.encryption-key')).exists()) {
  throw new Error('Smoke fixture requires a disposable volume without an existing database or key')
}
if (!await Bun.file(join(dataDir, 'plugins', 'local-fixture', 'plugin.json')).exists()) {
  throw new Error('Run the plugin smoke fixture in this volume first')
}
const temporary = await mkdtemp(join(tmpdir(), 'hivekeep-backup-smoke-'))
const key = randomBytes(32)
const iv = randomBytes(12)
const cipher = createCipheriv('aes-256-gcm', key, iv)
const ciphertext = Buffer.concat([cipher.update('synthetic secret', 'utf8'), cipher.final()])

async function cli(...args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/backup.ts', ...args], {
    env: { PATH: process.env.PATH, HIVEKEEP_DATA_DIR: dataDir, DB_PATH: join(dataDir, 'hivekeep.db') },
    stdout: 'inherit', stderr: 'inherit',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
  try {
    if (await child.exited !== 0) throw new Error(`Backup CLI failed: ${args[0]}`)
  } finally {
    clearTimeout(timer)
  }
}

try {
  await mkdir(join(dataDir, 'uploads'), { recursive: true })
  await writeFile(join(dataDir, '.encryption-key'), key.toString('hex'), { mode: 0o600 })
  await writeFile(join(dataDir, 'uploads', 'fixture.txt'), 'restored fixture')
  const db = new Database(join(dataDir, 'hivekeep.db'), { create: true })
  try {
    db.exec('CREATE TABLE files (id TEXT PRIMARY KEY, stored_path TEXT); CREATE TABLE smoke_secrets (value TEXT)')
    db.query('INSERT INTO files VALUES (?, ?)').run('fixture', join(dataDir, 'uploads', 'fixture.txt'))
    db.query('INSERT INTO smoke_secrets VALUES (?)').run(ciphertext.toString('hex'))
  } finally {
    db.close()
  }

  const backup = join(temporary, 'snapshot')
  const restored = join(temporary, 'restored')
  await cli('--help')
  await cli('create', '--stopped', '--to', backup)
  await cli('verify', '--from', backup)
  await cli('restore', '--from', backup, '--to', restored)
  if (((await stat(backup)).mode & 0o777) !== 0o700) throw new Error('Backup directory is not private')

  const restoredData = join(restored, 'data')
  const restoredDb = new Database(join(restoredData, 'hivekeep.db'), { readonly: true })
  try {
    const file = restoredDb.query('SELECT stored_path FROM files').get() as { stored_path: string }
    if (file.stored_path !== join(restoredData, 'uploads', 'fixture.txt')) throw new Error('Restored file path was not relocated')
    if (await readFile(file.stored_path, 'utf8') !== 'restored fixture') throw new Error('Restored file content differs')
    const secret = restoredDb.query('SELECT value FROM smoke_secrets').get() as { value: string }
    const restoredKey = Buffer.from((await readFile(join(restoredData, '.encryption-key'), 'utf8')).trim(), 'hex')
    const decipher = createDecipheriv('aes-256-gcm', restoredKey, iv)
    decipher.setAuthTag(cipher.getAuthTag())
    if (Buffer.concat([decipher.update(Buffer.from(secret.value, 'hex')), decipher.final()]).toString() !== 'synthetic secret') {
      throw new Error('Restored secret cannot be decrypted')
    }
  } finally {
    restoredDb.close()
  }
  const plugin = await import(join(restoredData, 'plugins', 'local-fixture', 'index.ts'))
  if (plugin.default().name !== 'persistent-fixture') throw new Error('Restored plugin or SDK failed')
  console.log('Production backup CLI, restored files, encryption key and plugin SDK passed as UID 1001')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
