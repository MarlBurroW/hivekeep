import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'hivekeep-queue-recovery-'))
afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }))

async function fixture(dbName: string, action: string, lane = 'main') {
  const child = Bun.spawn([
    process.execPath, '--no-env-file', join(import.meta.dir, 'queue-recovery.fixture.ts'),
    join(temporaryDirectory, `${dbName}.db`), action, lane,
  ], {
    stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HIVEKEEP_DATA_DIR: temporaryDirectory, ENCRYPTION_KEY: '00'.repeat(32), BUN_INSTALL_CACHE_DIR: join(temporaryDirectory, 'bun-cache'), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(temporaryDirectory, 'bun-runtime-cache') },
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (status !== 0) throw new Error(`Fixture ${action} failed (${status}): ${stderr}`)
  return JSON.parse(stdout)
}

describe('durable inbound queue', () => {
  it('atomically reserves an upload against racing public/private sends', async () => {
    const result = await fixture('attachment-race', 'reserve-race', 'quick')
    expect(result.accepted).toBe(1)
    expect(result.rejected).toBe(11)
    expect(result.rows).toEqual([{ id: 'competing-0', session_id: 'private-session' }])
    expect(result.file.session_id).toBe('private-session')
  })
  for (const lane of ['main', 'quick']) {
    it(`retains attachments, metadata and reconciliation token across ${lane} worker restarts`, async () => {
      await fixture(lane, 'enqueue', lane)
      if (lane === 'quick') {
        expect(await fixture(lane, 'inspect-main', lane)).toEqual({ items: [], size: 0, removed: false })
      }
      const first = await fixture(lane, 'dequeue', lane)
      const recovered = await fixture(lane, 'dequeue', lane)
      expect(recovered.item.id).toBe(first.item.id)
      expect(recovered.item.content).toBe('A durable question')
      expect(recovered.item.fileIds).toEqual(['attachment-one', 'attachment-two'])
      expect(recovered.item.clientMessageId).toBe('optimistic-token')
      expect(recovered.metadata).toEqual({ channel: { modality: 'audio', context: 'durable context' } })
      expect(recovered.item.sessionId).toBe(lane === 'quick' ? 'private-session' : null)

      const persisted = await fixture(lane, 'persist', lane)
      const replayed = await fixture(lane, 'persist', lane)
      expect(replayed.messageId).toBe(persisted.messageId)
      expect(replayed.receipt).toBe(persisted.messageId)
      expect(replayed.messageCount).toBe(1)
      expect(replayed.item.fileIds).toEqual(first.item.fileIds)
      expect(replayed.metadata).toEqual(first.metadata)
    })
  }

  it('rolls back the message if recording its queue receipt fails', async () => {
    await fixture('rollback', 'enqueue')
    const failed = await fixture('rollback', 'fail-receipt')
    expect(failed.rolledBack).toBe(true)
    expect(failed.messageCount).toBe(0)
    expect(failed.receipt).toBeNull()
    const retried = await fixture('rollback', 'persist')
    expect(retried.messageCount).toBe(1)
    expect(retried.messageId).toBe(retried.receipt)
  })
})
