import { resolve, sep } from 'node:path'
import type { WorkspaceGitStatusDTO } from '@/shared/types'

/**
 * Git helpers for the Files section: a per-file working-tree diff, the list of
 * changed files, and a lightweight status badge (branch + dirty count). All of
 * them are read-only and take a plain directory, so they work for any browse
 * source that happens to be a git repo.
 */

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode: await proc.exited, stdout, stderr }
}

/**
 * Unified working-tree diff of one file vs HEAD (or vs empty for an untracked
 * file). `isRepo` is false when `dir` is not a git work tree. The path is
 * re-confined to `dir` before it reaches git, so a `../` cannot escape.
 */
export async function gitDiffFile(dir: string, relPath: string): Promise<{ diff: string; isRepo: boolean }> {
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return { diff: '', isRepo: false }

  // Containment: dir is the workspace root — never let a relative path walk out.
  const abs = resolve(dir, relPath)
  if (abs !== dir && !abs.startsWith(dir + sep)) return { diff: '', isRepo: true }
  const rel = abs === dir ? '.' : abs.slice(dir.length + 1)

  const tracked = await runGit(dir, ['ls-files', '--error-unmatch', '--', rel])
  if (tracked.exitCode !== 0) {
    // Untracked file: show the whole content as additions (exit 1 = differs).
    const res = await runGit(dir, ['diff', '--no-index', '--', '/dev/null', rel])
    return { diff: res.stdout, isRepo: true }
  }
  const res = await runGit(dir, ['diff', 'HEAD', '--', rel])
  return { diff: res.stdout, isRepo: true }
}

/**
 * List the working-tree changes of a repo (porcelain), each with its two-letter
 * status code. `core.quotepath=false` keeps accented/UTF-8 paths literal (common
 * in French file names). Returns [] when `dir` is not a git work tree.
 */
export async function gitChangedFiles(dir: string): Promise<{ path: string; status: string }[]> {
  const inside = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return []
  const res = await runGit(dir, ['-c', 'core.quotepath=false', 'status', '--porcelain'])
  if (res.exitCode !== 0) return []
  const out: { path: string; status: string }[] = []
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue
    const status = line.slice(0, 2).trim()
    let path = line.slice(3)
    // "R  old -> new" / "C  old -> new": keep the destination path.
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    // git only wraps paths in quotes for unusual bytes; strip them when present.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    out.push({ path, status })
  }
  return out
}

/** Branch + dirty count for any directory; null when it is not a git repo. */
export async function gitStatusSummary(dir: string): Promise<WorkspaceGitStatusDTO | null> {
  const head = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (head.exitCode !== 0) return null
  const branch = head.stdout.trim() || 'HEAD'
  const status = await runGit(dir, ['status', '--porcelain'])
  const dirtyCount = status.exitCode === 0
    ? status.stdout.split('\n').filter((line) => line.trim().length > 0).length
    : 0
  return { branch, dirtyCount }
}
