import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
// Sync fs API on purpose: image-tools.test.ts mock.module()s 'fs/promises'
// process-globally (mkdir becomes a no-op) and Bun cannot un-mock it — the
// sync 'node:fs' surface is not covered by that mock. See the custom-tools
// mock.module gotcha.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'

// Other suites mock.module('@/server/config') and Bun's module mocks are
// process-global — pin our own full config so test order can't starve the
// service of config.workspaceFiles (same gotcha as fs/promises above).
const testConfig = JSON.parse(JSON.stringify(fullMockConfig)) as typeof fullMockConfig
mock.module('@/server/config', () => ({ config: testConfig }))

import {
  resolveInRoot,
  writeWorkspaceFile,
  mkdirWorkspace,
  moveWorkspaceEntry,
  copyWorkspaceEntry,
  deleteWorkspaceEntry,
  uploadWorkspaceFiles,
  normalizeRelPath,
  validateEntryName,
  WorkspaceFilesError,
  writeInTarget,
  listInTarget,
  deleteInTarget,
  type WorkspaceTarget,
} from '@/server/services/workspace-files'

/**
 * Security tests for the Files section containment helper (files.md § 7.8).
 * These are BLOCKING for P1: every vector here was identified by the
 * adversarial spec review.
 */

let root: string
let outside: string

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'hivekeep-wsfiles-'))
  root = join(base, 'workspace')
  outside = join(base, 'outside')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  writeFileSync(join(root, 'hello.txt'), 'hello')
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'guide.md'), '# guide')
})

afterEach(() => {
  rmSync(join(root, '..'), { recursive: true, force: true })
})

const expectForbidden = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toThrow(WorkspaceFilesError)
  try {
    await promise
  } catch (err) {
    expect((err as WorkspaceFilesError).code).toBe('PATH_FORBIDDEN')
  }
}

describe('normalizeRelPath', () => {
  test('accepts normal relative paths', () => {
    expect(normalizeRelPath('docs/guide.md')).toBe('docs/guide.md')
    expect(normalizeRelPath('./docs//guide.md')).toBe('docs/guide.md')
    expect(normalizeRelPath('')).toBe('')
  })

  test('rejects traversal, absolute paths, control chars', () => {
    expect(() => normalizeRelPath('../etc/passwd')).toThrow(WorkspaceFilesError)
    expect(() => normalizeRelPath('docs/../../etc')).toThrow(WorkspaceFilesError)
    expect(() => normalizeRelPath('/etc/passwd')).toThrow(WorkspaceFilesError)
    expect(() => normalizeRelPath('C:/windows')).toThrow(WorkspaceFilesError)
    expect(() => normalizeRelPath('docs\\guide.md')).toThrow(WorkspaceFilesError)
    expect(() => normalizeRelPath('docs/\x00evil')).toThrow(WorkspaceFilesError)
    expect(() => normalizeRelPath('~/secrets')).toThrow(WorkspaceFilesError)
  })

  test('URL-decoded traversal still caught (route decodes %2e%2e to ..)', () => {
    expect(() => normalizeRelPath(decodeURIComponent('%2e%2e/etc'))).toThrow(WorkspaceFilesError)
  })
})

describe('resolveInRoot — containment', () => {
  test('resolves the root itself (ls of the workspace root must not be rejected)', async () => {
    const resolved = await resolveInRoot(root, '')
    expect(resolved.exists).toBe(true)
    expect(resolved.abs).toBe(realpathSync(root))
  })

  test('resolves a normal nested file', async () => {
    const resolved = await resolveInRoot(root, 'docs/guide.md')
    expect(resolved.exists).toBe(true)
    expect(resolved.rel).toBe('docs/guide.md')
  })

  test('nonexistent path resolves with exists=false (for writes)', async () => {
    const resolved = await resolveInRoot(root, 'new/sub/file.txt', { forWrite: true })
    expect(resolved.exists).toBe(false)
  })

  test('BLOCKS symlink LEAF pointing outside (read)', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak'))
    await expectForbidden(resolveInRoot(root, 'leak'))
  })

  test('BLOCKS symlink leaf for WRITE even when target is inside', async () => {
    symlinkSync(join(root, 'hello.txt'), join(root, 'self-link'))
    await expectForbidden(resolveInRoot(root, 'self-link', { forWrite: true }))
  })

  test('ALLOWS reading through a symlink that stays confined', async () => {
    symlinkSync(join(root, 'hello.txt'), join(root, 'alias.txt'))
    const resolved = await resolveInRoot(root, 'alias.txt')
    expect(resolved.exists).toBe(true)
    expect(resolved.abs).toBe(realpathSync(join(root, 'hello.txt')))
  })

  test('BLOCKS symlinked PARENT directory escaping the root', async () => {
    symlinkSync(outside, join(root, 'evil-dir'))
    await expectForbidden(resolveInRoot(root, 'evil-dir/secret.txt'))
  })

  test('BLOCKS path through symlinked parent even when leaf does not exist (write)', async () => {
    symlinkSync(outside, join(root, 'evil-dir'))
    await expectForbidden(resolveInRoot(root, 'evil-dir/new-file.txt', { forWrite: true }))
  })

  test('broken symlink is forbidden, not a crash', async () => {
    symlinkSync(join(outside, 'does-not-exist'), join(root, 'dangling'))
    await expectForbidden(resolveInRoot(root, 'dangling'))
  })
})

describe('writeWorkspaceFile', () => {
  // Point the real config at the temp dir so workspaceRootFor('agent-w') = root.
  beforeEach(() => {
    ;(testConfig.workspace as { baseDir: string }).baseDir = join(root, '..')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  })

  const AGENT = 'workspace' // root = <base>/workspace from the shared fixture

  test('creates a file (and parents) and returns mtime', async () => {
    const result = await writeWorkspaceFile(AGENT, 'notes/new/file.txt', 'hello')
    expect(result.path).toBe('notes/new/file.txt')
    expect(result.size).toBe(5)
    expect(readFileSync(join(root, 'notes/new/file.txt'), 'utf8')).toBe('hello')
  })

  test('createOnly refuses to overwrite (DEST_EXISTS)', async () => {
    await writeWorkspaceFile(AGENT, 'a.txt', 'one')
    try {
      await writeWorkspaceFile(AGENT, 'a.txt', 'two', { createOnly: true })
      expect.unreachable()
    } catch (err) {
      expect((err as WorkspaceFilesError).code).toBe('DEST_EXISTS')
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one')
  })

  test('optimistic concurrency: stale baseModifiedAt → CONFLICT', async () => {
    const first = await writeWorkspaceFile(AGENT, 'b.txt', 'v1')
    await writeWorkspaceFile(AGENT, 'b.txt', 'v2') // concurrent writer (the agent)
    // Same-millisecond writes share an mtime — bump it like a real later write.
    const bumped = new Date(first.modifiedAt + 50)
    utimesSync(join(root, 'b.txt'), bumped, bumped)
    try {
      await writeWorkspaceFile(AGENT, 'b.txt', 'v3', { baseModifiedAt: first.modifiedAt })
      expect.unreachable()
    } catch (err) {
      expect((err as WorkspaceFilesError).code).toBe('CONFLICT')
    }
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('v2')
  })

  test('matching baseModifiedAt writes fine', async () => {
    const first = await writeWorkspaceFile(AGENT, 'c.txt', 'v1')
    const second = await writeWorkspaceFile(AGENT, 'c.txt', 'v2', { baseModifiedAt: first.modifiedAt })
    expect(second.size).toBe(2)
  })

  test('refuses to write through a symlink leaf', async () => {
    writeFileSync(join(outside, 'target.txt'), 'x')
    symlinkSync(join(outside, 'target.txt'), join(root, 'link.txt'))
    await expectForbidden(writeWorkspaceFile(AGENT, 'link.txt', 'pwned'))
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('x')
  })

  test('rejects invalid new-file names (INVALID_NAME)', async () => {
    try {
      await writeWorkspaceFile(AGENT, 'dir/' + 'x'.repeat(256), 'data')
      expect.unreachable()
    } catch (err) {
      expect((err as WorkspaceFilesError).code).toBe('INVALID_NAME')
    }
  })
})

describe('mutations (mkdir / move / copy / delete / upload)', () => {
  beforeEach(() => {
    ;(testConfig.workspace as { baseDir: string }).baseDir = join(root, '..')
  })
  const AGENT = 'workspace'

  test('mkdir creates, DEST_EXISTS on retry', async () => {
    await mkdirWorkspace(AGENT, 'reports/2026')
    expect(existsSync(join(root, 'reports/2026'))).toBe(true)
    try {
      await mkdirWorkspace(AGENT, 'reports/2026')
      expect.unreachable()
    } catch (err) {
      expect((err as WorkspaceFilesError).code).toBe('DEST_EXISTS')
    }
  })

  test('move renames within the workspace and refuses collisions', async () => {
    await moveWorkspaceEntry({ agentId: AGENT, from: 'hello.txt', to: 'docs/hi.txt' })
    expect(readFileSync(join(root, 'docs/hi.txt'), 'utf8')).toBe('hello')
    writeFileSync(join(root, 'other.txt'), 'x')
    try {
      await moveWorkspaceEntry({ agentId: AGENT, from: 'other.txt', to: 'docs/hi.txt' })
      expect.unreachable()
    } catch (err) {
      expect((err as WorkspaceFilesError).code).toBe('DEST_EXISTS')
    }
  })

  test('move across workspaces validates each side against its own root', async () => {
    const otherRoot = join(root, '..', 'agent-b')
    mkdirSync(otherRoot, { recursive: true })
    writeFileSync(join(otherRoot, 'from-b.txt'), 'b content')
    const result = await moveWorkspaceEntry({ agentId: AGENT, fromAgentId: 'agent-b', from: 'from-b.txt', to: 'imported.txt' })
    expect(result.to).toBe('imported.txt')
    expect(readFileSync(join(root, 'imported.txt'), 'utf8')).toBe('b content')
    expect(existsSync(join(otherRoot, 'from-b.txt'))).toBe(false)
  })

  test('copy suffixes on collision: name (copy).ext', async () => {
    const first = await copyWorkspaceEntry({ agentId: AGENT, from: 'hello.txt', to: 'hello.txt' })
    expect(first.to).toBe('hello (copy).txt')
    const second = await copyWorkspaceEntry({ agentId: AGENT, from: 'hello.txt', to: 'hello.txt' })
    expect(second.to).toBe('hello (copy 2).txt')
  })

  test('recursive copy aborts over the entry budget and cleans up', async () => {
    mkdirSync(join(root, 'big'))
    for (let i = 0; i < 20; i++) writeFileSync(join(root, 'big', `f${i}.txt`), 'x')
    ;(testConfig.workspaceFiles as { maxCopyEntries: number }).maxCopyEntries = 5
    try {
      await copyWorkspaceEntry({ agentId: AGENT, from: 'big', to: 'big-copy' })
      expect.unreachable()
    } catch (err) {
      expect((err as WorkspaceFilesError).code).toBe('COPY_TOO_LARGE')
    } finally {
      ;(testConfig.workspaceFiles as { maxCopyEntries: number }).maxCopyEntries = 5000
    }
    expect(existsSync(join(root, 'big-copy'))).toBe(false)
  })

  test('copy never follows symlinks (escape + cycles)', async () => {
    mkdirSync(join(root, 'src-dir'))
    writeFileSync(join(root, 'src-dir', 'ok.txt'), 'ok')
    symlinkSync(outside, join(root, 'src-dir', 'evil'))
    const result = await copyWorkspaceEntry({ agentId: AGENT, from: 'src-dir', to: 'dst-dir' })
    expect(readFileSync(join(root, 'dst-dir', 'ok.txt'), 'utf8')).toBe('ok')
    expect(existsSync(join(root, result.to, 'evil'))).toBe(false)
  })

  test('delete removes folders recursively, and symlinks WITHOUT following', async () => {
    await deleteWorkspaceEntry(AGENT, 'docs')
    expect(existsSync(join(root, 'docs'))).toBe(false)
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out'))
    await deleteWorkspaceEntry(AGENT, 'link-out')
    expect(existsSync(join(root, 'link-out'))).toBe(false)
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret') // target untouched
  })

  test('upload sanitizes smuggled paths, suffixes collisions, reports per-file errors', async () => {
    const result = await uploadWorkspaceFiles(AGENT, 'incoming', [
      { name: '../../etc/evil.txt', buffer: Buffer.from('payload') },
      { name: 'hello.txt', buffer: Buffer.from('A') },
      { name: 'hello.txt', buffer: Buffer.from('B') },
      { name: 'x'.repeat(300), buffer: Buffer.from('too long') },
    ])
    // "../../etc/evil.txt" → basename "evil.txt" lands INSIDE incoming/
    expect(result.files.map((f) => f.path)).toEqual([
      'incoming/evil.txt',
      'incoming/hello.txt',
      'incoming/hello (copy).txt',
    ])
    expect(existsSync(join(root, '..', 'etc'))).toBe(false)
    expect(result.errors).toEqual([{ name: 'x'.repeat(300), code: 'INVALID_NAME' }])
  })
})

describe('target-based ops on a non-agent root (folder / mini-app sources)', () => {
  // Confinement and mutations must work identically for an arbitrary root, not
  // just `data/workspaces/<agentId>` — that is the whole point of generalizing
  // the service for mini-app dirs and FS folders.
  const folderTarget = (): WorkspaceTarget => ({ root, source: { type: 'folder', id: 'f1' } })

  test('write + list + delete on an arbitrary folder root', async () => {
    const written = await writeInTarget(folderTarget(), 'sub/note.txt', 'hi')
    expect(written.path).toBe('sub/note.txt')
    expect(readFileSync(join(root, 'sub/note.txt'), 'utf8')).toBe('hi')

    const listed = await listInTarget(folderTarget(), 'sub')
    expect(listed.entries.map((e) => e.name)).toContain('note.txt')

    await deleteInTarget(folderTarget(), 'sub')
    expect(existsSync(join(root, 'sub'))).toBe(false)
  })

  test('still confines: symlink escape rejected on a folder root', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak'))
    await expectForbidden(writeInTarget(folderTarget(), 'leak', 'pwned'))
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
  })
})

describe('validateEntryName', () => {
  test('accepts normal names including spaces and accents', () => {
    expect(() => validateEntryName('Rapport final.md')).not.toThrow()
    expect(() => validateEntryName('synthèse.md')).not.toThrow()
  })

  test('rejects empty, reserved, separators, control chars, oversized', () => {
    expect(() => validateEntryName('')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('   ')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('.')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('..')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('a/b')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('a\\b')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('a\x00b')).toThrow(WorkspaceFilesError)
    expect(() => validateEntryName('x'.repeat(256))).toThrow(WorkspaceFilesError)
  })
})
