/**
 * End-of-task finalization for a ticket sub-task's git worktree.
 *
 * Spec (V1, "never auto-merge"):
 *
 *   completed + commits + clean rebase → push, delete worktree, branch stays on remote
 *   completed + commits + rebase conflict → push pre-rebase, KEEP worktree (TTL sweep cleans later)
 *   completed + no commits → delete worktree (nothing to push)
 *   failed → KEEP worktree (TTL sweep), no push
 *
 * "Auto-merge" is deliberately off in V1 — the human reviews and merges from
 * GitHub. The branch is the artefact the sub-task leaves behind.
 *
 * Returns an enrichment string the caller appends to the ticket auto-comment,
 * plus a `keepWorktree` flag the caller honors. Best-effort: any failure here
 * is surfaced as text in the suffix and never throws (the task is already
 * resolved by the time we get here; the worktree status shouldn't break the
 * task lifecycle).
 */

import { resolve as resolvePath } from 'node:path'
import { eq } from 'drizzle-orm'

import { createLogger } from '@/server/logger'
import { db } from '@/server/db/index'
import { projects, tickets } from '@/server/db/schema'
import { resolvePat } from '@/server/services/github'
import { getCloneDir } from '@/server/services/repo-clone'
import {
  getWorktreePath,
  getWorktreeBranch,
  deleteWorktree,
} from '@/server/services/worktree'

const log = createLogger('worktree-finalize')

interface FinalizeInput {
  taskId: string
  ticketId: string
  status: 'completed' | 'failed'
}

export interface FinalizeOutcome {
  /** Markdown block to append to the ticket auto-comment. Empty string if
   *  there's nothing worktree-related to say (non-git project, no worktree
   *  on disk, etc.) — the existing auto-comment is fine on its own. */
  contentSuffix: string
  /** When true the caller leaves the worktree alone (so the human can
   *  debug or finish the rebase). When false the caller removes it
   *  immediately. */
  keepWorktree: boolean
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function gitIn(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<GitResult> {
  const proc = Bun.spawn(['git', '-C', cwd, ...args], {
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

function shortenTaskId(taskId: string): string {
  return taskId.replace(/-/g, '').slice(0, 8)
}

function gitHttpsUrl(repo: string): string {
  return `https://github.com/${repo}`
}

function gitBranchUrl(repo: string, branch: string): string {
  // GitHub URL-encodes `/` in branch names inside paths, which is the only
  // special char we allow per `getWorktreeBranch` (slash separator).
  return `https://github.com/${repo}/tree/${encodeURIComponent(branch).replaceAll('%2F', '/')}`
}

/**
 * Run the post-task git pipeline for a ticket sub-task. See file-level
 * doc for the decision matrix.
 */
export async function finalizeTicketSubTaskWorktree(input: FinalizeInput): Promise<FinalizeOutcome> {
  const neutral: FinalizeOutcome = { contentSuffix: '', keepWorktree: false }

  const ticketRow = db
    .select({
      number: tickets.number,
      projectId: tickets.projectId,
    })
    .from(tickets)
    .where(eq(tickets.id, input.ticketId))
    .get()
  if (!ticketRow || typeof ticketRow.number !== 'number') return neutral

  const projectRow = db.select().from(projects).where(eq(projects.id, ticketRow.projectId)).get()
  if (!projectRow || !projectRow.slug || !projectRow.githubRepo) return neutral

  const shortId = shortenTaskId(input.taskId)
  const wtPath = getWorktreePath(projectRow.slug, shortId)
  const branch = getWorktreeBranch(projectRow.slug, ticketRow.number, shortId)
  const baseBranch = projectRow.defaultBranch ?? 'main'

  // Was a worktree actually created for this task? createWorktree only runs
  // when cloneStatus was 'ready' at executeSubAgent time. Without a worktree
  // there's nothing to finalize.
  if (!(await dirExists(wtPath))) {
    return neutral
  }

  const branchUrl = gitBranchUrl(projectRow.githubRepo, branch)
  const repoUrl = gitHttpsUrl(projectRow.githubRepo)

  // ─── Failure path ────────────────────────────────────────────────────────
  if (input.status === 'failed') {
    log.info({ taskId: input.taskId, wtPath }, 'Task failed — keeping worktree for debug')
    return {
      keepWorktree: true,
      contentSuffix:
        `\n\n---\n\n` +
        `**Worktree kept for debug:** \`${wtPath}\`\n` +
        `Branch \`${branch}\` was not pushed.`,
    }
  }

  // ─── Completed path ──────────────────────────────────────────────────────
  // Did the sub-task actually commit anything? Compare HEAD to the
  // pre-task base (origin/<baseBranch> at worktree-add time). We use
  // `merge-base` against current origin so a moved-on remote still gives
  // us the right diff.
  await gitIn(wtPath, ['fetch', '--quiet', 'origin', baseBranch], await taskEnv(projectRow))
  const baseRefResult = await gitIn(wtPath, ['merge-base', 'HEAD', `origin/${baseBranch}`])
  const baseSha = baseRefResult.exitCode === 0 ? baseRefResult.stdout.trim() : null
  const countResult = baseSha
    ? await gitIn(wtPath, ['rev-list', '--count', `${baseSha}..HEAD`])
    : { exitCode: 1, stdout: '0', stderr: '' }
  const commitCount = countResult.exitCode === 0 ? Number(countResult.stdout.trim()) || 0 : 0

  if (commitCount === 0) {
    log.info({ taskId: input.taskId, wtPath, branch }, 'Completed — no commits, dropping worktree')
    return {
      keepWorktree: false,
      contentSuffix:
        `\n\n---\n\n` +
        `Branch [\`${branch}\`](${branchUrl}) had no commits to push. Worktree cleaned up.`,
    }
  }

  // Try a fast-forward rebase onto the latest remote base. If it merges
  // cleanly, push the rebased branch. If it conflicts, abort, push the
  // pre-rebase HEAD, and leave the worktree for human triage.
  const rebase = await gitIn(wtPath, ['rebase', `origin/${baseBranch}`])
  let rebaseConflict = false
  if (rebase.exitCode !== 0) {
    rebaseConflict = true
    // Best-effort abort — leaves the worktree on the pre-rebase commit
    // so a human can pick up where the rebase failed.
    await gitIn(wtPath, ['rebase', '--abort'])
    log.warn(
      { taskId: input.taskId, branch, stderr: rebase.stderr.slice(0, 200) },
      'Rebase failed; pushing pre-rebase branch',
    )
  }

  // Push. After a clean rebase the branch may need --force-with-lease
  // (history rewrote); the pre-rebase case is a fresh branch (no force).
  const pushArgs = rebaseConflict
    ? ['push', '--set-upstream', 'origin', branch]
    : ['push', '--force-with-lease', '--set-upstream', 'origin', branch]
  const push = await gitIn(wtPath, pushArgs, await taskEnv(projectRow))
  if (push.exitCode !== 0) {
    log.warn(
      { taskId: input.taskId, branch, stderr: push.stderr.slice(0, 200) },
      'git push failed',
    )
    return {
      keepWorktree: true,
      contentSuffix:
        `\n\n---\n\n` +
        `Could not push branch \`${branch}\` to ${repoUrl}: ${push.stderr.slice(0, 200) || `exit ${push.exitCode}`}.\n` +
        `Worktree kept at \`${wtPath}\` for inspection.`,
    }
  }

  if (rebaseConflict) {
    log.info({ taskId: input.taskId, branch }, 'Pushed pre-rebase branch (needs manual merge)')
    return {
      keepWorktree: true,
      contentSuffix:
        `\n\n---\n\n` +
        `Branch [\`${branch}\`](${branchUrl}) pushed (**${commitCount}** commit${commitCount > 1 ? 's' : ''}).\n` +
        `⚠️ **Needs manual merge:** the auto-rebase onto \`${baseBranch}\` hit a conflict. ` +
        `Worktree kept at \`${wtPath}\` so you can finish the rebase by hand.`,
    }
  }

  log.info({ taskId: input.taskId, branch, commitCount }, 'Branch pushed, worktree clean — removing')
  return {
    keepWorktree: false,
    contentSuffix:
      `\n\n---\n\n` +
      `Branch [\`${branch}\`](${branchUrl}) pushed (**${commitCount}** commit${commitCount > 1 ? 's' : ''}), rebased on \`${baseBranch}\`. ` +
      `Open it on GitHub to review and merge.`,
  }
}

/**
 * Convenience wrapper used by `resolveTask`: if the outcome says the
 * worktree should not be kept, remove it. No-op when there's nothing
 * worktree-related to do.
 */
export async function maybeRemoveFinalizedWorktree(
  taskId: string,
  ticketId: string,
  outcome: FinalizeOutcome,
): Promise<void> {
  if (outcome.keepWorktree) return

  const ticketRow = db
    .select({ projectId: tickets.projectId, number: tickets.number })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .get()
  if (!ticketRow || typeof ticketRow.number !== 'number') return

  const projectRow = db
    .select({ slug: projects.slug, id: projects.id })
    .from(projects)
    .where(eq(projects.id, ticketRow.projectId))
    .get()
  if (!projectRow || !projectRow.slug) return

  const shortId = shortenTaskId(taskId)
  const wtPath = getWorktreePath(projectRow.slug, shortId)
  const branch = getWorktreeBranch(projectRow.slug, ticketRow.number, shortId)
  await deleteWorktree({
    projectId: projectRow.id,
    path: wtPath,
    branch,
    force: true,
  })
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function dirExists(path: string): Promise<boolean> {
  try {
    const { access } = await import('node:fs/promises')
    await access(path)
    return true
  } catch {
    return false
  }
}

async function taskEnv(projectRow: { githubPatVaultKey: string | null }): Promise<Record<string, string>> {
  const pat = await resolvePat(projectRow.githubPatVaultKey)
  return pat ? { GEZY_GH_TOKEN: pat } : {}
}

/** Exposed for tests / sub-ticket-tooling. */
export function _worktreePathFor(slug: string, taskId: string): string {
  return resolvePath(getWorktreePath(slug, shortenTaskId(taskId)))
}
