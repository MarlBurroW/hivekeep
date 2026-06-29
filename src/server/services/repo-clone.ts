/**
 * Local-clone orchestrator for the per-project worktree pipeline.
 *
 * Maintains a single canonical clone of each project's GitHub repo under
 * `${config.repos.baseDir}/<slug>/`. Sub-task worktrees (sub-ticket 3) will
 * be linked off this clone so they share git objects without re-cloning.
 *
 * Status lifecycle on `projects.clone_status`:
 *
 *     none ──save──> cloning ──ok──> ready
 *                            └──fail─> error ──retry──> cloning ...
 *
 * Each transition broadcasts a `project:updated` SSE event via
 * `setCloneStatus` so the UI (header badge, list view) updates without
 * polling.
 *
 * Security: the PAT is resolved from the vault on every clone, injected
 * into the child process via `GEZY_GH_TOKEN`, and read by an inline
 * credential helper. It never touches the clone URL, the on-disk
 * `.git/config`, or any log line. See the credential helper string below.
 */

import { resolve } from 'node:path'
import { mkdir, rm, access } from 'node:fs/promises'
import { eq } from 'drizzle-orm'

import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { db } from '@/server/db/index'
import { projects } from '@/server/db/schema'
import { setCloneStatus } from '@/server/services/projects'
import { resolvePat } from '@/server/services/github'
import { GITHUB_REPO_REGEX } from '@/shared/constants'

const log = createLogger('repo-clone')

/**
 * Inline git credential helper. Git invokes the value after `!` via
 * `/bin/sh -c`; the shell inherits the env we pass to Bun.spawn, so
 * `$GEZY_GH_TOKEN` expands to the PAT. The helper ignores stdin and
 * unconditionally returns the GitHub bot username + the token — which is
 * fine because the clone URL is always github.com in this code path.
 *
 * Exported so the worktree service can re-use the same helper string when
 * it explicitly needs to (worktrees inherit the credential helper from
 * their parent clone's `.git/config` by default, but keeping the string
 * in a single source of truth lets sub-ticket 5 set it on remote-only
 * branches without re-deriving the format).
 */
export const CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GEZY_GH_TOKEN"; }; f'

/**
 * Persist the GitHub credential helper inside the freshly-cloned repo so
 * post-clone network operations (fetch, pull, push from worktrees) reuse
 * the same env-driven PAT injection. Scoped to `https://github.com` to
 * avoid sending the PAT to any other host the user might add as a remote.
 *
 * Called once at the end of `runClone`. Worktrees inherit `.git/config`
 * from the parent clone by default, so they pick up this helper for free.
 */
async function persistCredentialHelper(cloneDir: string): Promise<void> {
  const proc = Bun.spawn(
    [
      'git', '-C', cloneDir,
      'config',
      'credential.https://github.com.helper',
      CREDENTIAL_HELPER,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const exit = await proc.exited
  if (exit !== 0) {
    const stderr = await new Response(proc.stderr).text()
    // Don't bubble this up to the user as a clone failure — the clone
    // itself succeeded; the helper just isn't pinned in .git/config.
    // Future network ops will fail with a clear auth error and the user
    // can retry the clone to re-set it.
    log.warn({ cloneDir, exit, stderr: stderr.slice(0, 200) }, 'Failed to persist credential helper')
  }
}

/** In-flight clones, keyed by project id. Prevents stacked clones when
 *  the user spams "save" or hits the retry route repeatedly. */
const inFlight = new Set<string>()

/** Absolute path to the local clone for a given project slug. Pure. */
export function getCloneDir(slug: string): string {
  return resolve(config.repos.baseDir, slug)
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Remove the local clone from disk. No-op when the directory is missing.
 * Does NOT touch the DB — call `setCloneStatus(_, { status: 'none' })`
 * separately when detaching the repo from the project.
 */
export async function deleteClone(slug: string): Promise<void> {
  const dir = getCloneDir(slug)
  if (!(await dirExists(dir))) return
  await rm(dir, { recursive: true, force: true })
  log.info({ slug }, 'Deleted local clone')
}

export interface StartCloneOptions {
  /** Wipe the existing clone dir before re-cloning. Used by the retry
   *  route. When false (the default), an existing dir flips status to
   *  'ready' immediately without re-cloning. */
  force?: boolean
}

/**
 * Kick off a clone in the background. Fire-and-forget: this function
 * never throws to the caller — every preflight or runtime failure is
 * surfaced as `clone_status='error'` on the project (the UI listens on
 * SSE and updates the header badge / list view accordingly).
 *
 * Short-circuits to a no-op (no status change) when:
 *   - a clone is already in flight for this project
 *   - the project row is missing (shouldn't happen, logged as a warn)
 *
 * Status transitions:
 *   - missing githubRepo → status reset to 'none' (defensive)
 *   - bad slug / repo shape / missing PAT → 'error' with message
 *   - dir already present and `force=false` → 'ready' (idempotent attach)
 *   - otherwise → 'cloning', then 'ready' | 'error' from `runClone`
 */
export async function startClone(projectId: string, opts: StartCloneOptions = {}): Promise<void> {
  if (inFlight.has(projectId)) {
    log.debug({ projectId }, 'Clone already in flight, skipping')
    return
  }

  const row = db.select().from(projects).where(eq(projects.id, projectId)).get()
  if (!row) {
    log.warn({ projectId }, 'startClone called for unknown project')
    return
  }
  if (!row.githubRepo) {
    await setCloneStatus(projectId, { status: 'none', error: null, clonedAt: null })
    return
  }
  if (!row.slug) {
    await setCloneStatus(projectId, {
      status: 'error',
      error: 'Project has no slug — cannot derive a clone path.',
    })
    return
  }
  if (!GITHUB_REPO_REGEX.test(row.githubRepo)) {
    await setCloneStatus(projectId, {
      status: 'error',
      error: `Invalid repo "${row.githubRepo}", expected "owner/name".`,
    })
    return
  }

  const pat = await resolvePat(row.githubPatVaultKey)
  if (!pat) {
    await setCloneStatus(projectId, {
      status: 'error',
      error: 'No GitHub token configured for this project. Set one in project settings.',
    })
    return
  }

  const dir = getCloneDir(row.slug)
  if (!opts.force && (await dirExists(dir))) {
    log.debug({ projectId, slug: row.slug }, 'Clone dir already present, marking ready')
    await setCloneStatus(projectId, { status: 'ready', error: null, clonedAt: new Date() })
    return
  }

  inFlight.add(projectId)
  await setCloneStatus(projectId, { status: 'cloning', error: null })

  // Detached: caller returns immediately. Lifecycle ownership is in the
  // inFlight guard so concurrent saves don't stack clones.
  void runClone(projectId, row.slug, row.githubRepo, pat, dir).finally(() => {
    inFlight.delete(projectId)
  })
}

async function runClone(
  projectId: string,
  slug: string,
  repo: string,
  pat: string,
  dir: string,
): Promise<void> {
  try {
    await mkdir(resolve(config.repos.baseDir), { recursive: true })

    // Force-clean any leftover dir (partial clone from a previous failure,
    // or stale clone of a different repo if the user changed githubRepo).
    if (await dirExists(dir)) {
      await rm(dir, { recursive: true, force: true })
    }

    const url = `https://github.com/${repo}.git`
    const proc = Bun.spawn(
      [
        'git',
        '-c',
        `credential.helper=${CREDENTIAL_HELPER}`,
        'clone',
        url,
        dir,
      ],
      {
        env: { ...process.env, GEZY_GH_TOKEN: pat },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const timeoutMs = config.repos.cloneTimeoutSec * 1000
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      try { proc.kill() } catch { /* already exited */ }
    }, timeoutMs)

    const exitCode = await proc.exited
    clearTimeout(timeout)

    if (exitCode === 0) {
      // Pin the credential helper inside the new clone's .git/config so
      // worktrees + future network ops auth without re-passing -c.
      await persistCredentialHelper(dir)
      await setCloneStatus(projectId, { status: 'ready', error: null, clonedAt: new Date() })
      log.info({ projectId, slug, repo }, 'Clone completed')
      return
    }

    const stderr = await new Response(proc.stderr).text()
    const sanitized = sanitizeError(stderr, pat)
    const message = timedOut
      ? `git clone timed out after ${config.repos.cloneTimeoutSec}s`
      : `git clone failed (exit ${exitCode}): ${sanitized.slice(0, 500)}`
    await setCloneStatus(projectId, { status: 'error', error: message })
    log.warn({ projectId, slug, exitCode, timedOut }, 'Clone failed')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await setCloneStatus(projectId, { status: 'error', error: message.slice(0, 500) })
    log.error({ projectId, slug, err }, 'Clone errored unexpectedly')
  }
}

/** Defensive: should never appear in stderr (we use a credential helper,
 *  not URL-embedded creds), but cheap to scrub before surfacing the error
 *  to the API + UI. */
function sanitizeError(text: string, pat: string): string {
  if (!text) return ''
  return text.split(pat).join('***')
}
