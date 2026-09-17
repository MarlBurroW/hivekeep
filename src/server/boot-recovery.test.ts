import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { runMigrations } from './db/run-migrations'

async function bootFixture(failSweep: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'hivekeep-boot-recovery-'))
  const dbPath = join(directory, 'fixture.db')
  const sqlite = new Database(dbPath)
  runMigrations(sqlite, drizzle(sqlite), resolve(import.meta.dir, 'db/migrations'))
  sqlite.run(`INSERT INTO agents (id, name, role, character, expertise, model, workspace_path, created_at, updated_at)
    VALUES ('fixture', 'Fixture', 'helper', 'test', 'test', 'fake-model', '/unused', 0, 0)`)
  sqlite.run(`INSERT INTO messages (id, agent_id, role, source_type, content, metadata, redact_pending, created_at)
    VALUES ('carrier', 'fixture', 'user', 'system', 'synthetic-test-value', '{}', 1, 0)`)
  sqlite.run(`INSERT INTO queue_items (id, agent_id, message_type, content, source_type, created_at)
    VALUES ('waiting', 'fixture', 'user', 'pending question', 'user', 0)`)
  if (failSweep) sqlite.run(`CREATE TRIGGER fail_sweep BEFORE UPDATE OF content ON messages
    WHEN old.id = 'carrier' BEGIN SELECT RAISE(ABORT, 'fixture sweep failure'); END`)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
  const port = probe.port!
  await probe.stop(true)
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'index.ts')], {
    stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
      HIVEKEEP_DATA_DIR: directory, DB_PATH: dbPath, ENCRYPTION_KEY: '00'.repeat(32),
      VERSION_CHECK_ENABLED: 'false', LOG_LEVEL: 'error', QUEUE_POLL_INTERVAL: '60000',
      SHUTDOWN_DRAIN_TIMEOUT_MS: '100', SHUTDOWN_CLEANUP_TIMEOUT_MS: '1000',
      BUN_INSTALL_CACHE_DIR: join(directory, 'bun-cache'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(directory, 'bun-runtime-cache'),
      XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_CONFIG_HOME: join(directory, 'config'),
    },
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const deadline = setTimeout(() => child.kill('SIGKILL'), 8000)
  try {
    let healthy = false
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      try { healthy = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok } catch { /* starting */ }
      if (healthy) break
      await Bun.sleep(40)
    }
    if (child.exitCode === null) child.kill('SIGTERM')
    const exitCode = await child.exited
    const output = await stderr
    await stdout
    return {
      healthy, exitCode, output,
      carrier: sqlite.query<{ content: string; redact_pending: number }, []>(
        'SELECT content, redact_pending FROM messages WHERE id = \'carrier\'',
      ).get()!,
      queueStatus: sqlite.query<{ status: string }, []>('SELECT status FROM queue_items WHERE id = \'waiting\'').get()!.status,
    }
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('server boot recovery barrier', () => {
  it('redacts stale carriers before serving and exits cleanly on SIGTERM', async () => {
    const result = await bootFixture(false)
    expect(result.healthy).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.carrier.redact_pending).toBe(0)
    expect(result.carrier.content).not.toContain('synthetic-test-value')
    expect(result.queueStatus).toBe('pending')
  })

  it('fails startup without admitting work when the recovery sweep fails', async () => {
    const result = await bootFixture(true)
    expect(result.healthy).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain('fixture sweep failure')
    expect(result.carrier.redact_pending).toBe(1)
    expect(result.queueStatus).toBe('pending')
  })
})
