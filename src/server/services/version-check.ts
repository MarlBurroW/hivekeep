/**
 * Platform update checker.
 *
 * Two channels:
 *  - stable: follows GitHub releases (tags). Changelog = cumulative release
 *    notes between the running version and the latest release.
 *  - edge: follows the HEAD of main. Changelog = commits between the running
 *    sha and origin/main (GitHub compare API).
 *
 * The check result is cached in app_settings so every client request doesn't
 * hit the GitHub API (unauthenticated rate limit: 60 req/h). A croner job
 * refreshes the cache periodically and broadcasts `version:update-available`.
 *
 * Applying an update is the job of `self-update.ts` — this module only
 * answers "is there something newer, and what's in it?".
 */
import { Cron } from 'croner'
import { existsSync } from 'fs'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { getSetting, setSetting } from '@/server/services/app-settings'
import { sseManager } from '@/server/sse/index'
import { compareSemver } from '@/server/update/semver'
import type { ChangelogEntry, UpdateChannel, VersionInfo } from '@/shared/types'

const log = createLogger('version-check')

/** Returns true if the version string is unknown/fallback and should not be compared. */
function isUnknownVersion(version: string): boolean {
  return !version || version === '0.0.0'
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

/** Lazily-resolved short sha of the running code. Docker images have no .git:
 *  the release CI bakes HIVEKEEP_GIT_SHA into the image instead. */
let cachedSha: string | null | undefined

export function getCurrentSha(): string | null {
  if (cachedSha !== undefined) return cachedSha
  const fromEnv = process.env.HIVEKEEP_GIT_SHA
  if (fromEnv) {
    cachedSha = fromEnv.slice(0, 7)
    return cachedSha
  }
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short=7', 'HEAD'], { cwd: process.cwd() })
    cachedSha = proc.exitCode === 0 ? proc.stdout.toString().trim() || null : null
  } catch {
    cachedSha = null
  }
  return cachedSha
}

export function isGitInstall(): boolean {
  // .git is a directory in normal clones and a file in worktrees — both count.
  return existsSync(`${process.cwd()}/.git`)
}

// ─── Channel setting ─────────────────────────────────────────────────────────

const CHANNEL_SETTING_KEY = 'update_channel'

export async function getUpdateChannel(): Promise<UpdateChannel> {
  const value = await getSetting(CHANNEL_SETTING_KEY)
  return value === 'edge' ? 'edge' : 'stable'
}

export async function setUpdateChannel(channel: UpdateChannel): Promise<void> {
  await setSetting(CHANNEL_SETTING_KEY, channel)
  // The cached check result belongs to the previous channel — invalidate it
  // so the next read triggers a fresh check instead of comparing apples to shas.
  await invalidateVersionCheckCache()
}

/** Drop the cached check result so the next read re-fetches from GitHub. Used
 *  after a self-update completes: the running version/sha just changed, so the
 *  pre-update cache would still report "update available" (the edge channel in
 *  particular keys availability off the cached changelog, not the version). */
export async function invalidateVersionCheckCache(): Promise<void> {
  await setSetting(CACHE_KEY, '')
  await setSetting(LAST_TIME_KEY, '0')
}

// ─── Self-update capability ──────────────────────────────────────────────────

export function getSelfUpdateCapability(): {
  canSelfUpdate: boolean
  reason: VersionInfo['selfUpdateBlockedReason']
} {
  if (config.isDocker) return { canSelfUpdate: false, reason: 'docker' }
  if (!isGitInstall()) return { canSelfUpdate: false, reason: 'not-git' }
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.HIVEKEEP_ALLOW_DEV_SELF_UPDATE !== 'true'
  ) {
    return { canSelfUpdate: false, reason: 'dev-mode' }
  }
  return { canSelfUpdate: true, reason: null }
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

interface GitHubRelease {
  tag_name: string
  name: string | null
  html_url: string
  body: string | null
  published_at: string
  prerelease: boolean
  draft: boolean
}

interface GitHubCompare {
  ahead_by: number
  behind_by: number
  html_url: string
  commits: Array<{
    sha: string
    html_url: string
    commit: { message: string; committer: { date: string } | null }
  }>
}

async function githubGet<T>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Hivekeep-VersionCheck',
    }
    // Optional token to lift the unauthenticated 60 req/h rate limit
    const token = process.env.VERSION_CHECK_GITHUB_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`

    const response = await fetch(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      log.warn({ path, status: response.status }, 'GitHub API returned non-OK status')
      return null
    }
    return (await response.json()) as T
  } catch (err) {
    log.warn({ path, err }, 'GitHub API request failed')
    return null
  }
}

// ─── Check result cache (app_settings) ───────────────────────────────────────

const CACHE_KEY = 'version_check_cache'
const LAST_TIME_KEY = 'version_check_last_time'

interface CheckCache {
  channel: UpdateChannel
  latestVersion: string | null
  releaseUrl: string | null
  changelog: ChangelogEntry[]
  publishedAt: number | null
}

async function readCache(): Promise<CheckCache | null> {
  const raw = await getSetting(CACHE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as CheckCache
  } catch {
    return null
  }
}

async function writeCache(cache: CheckCache): Promise<void> {
  await setSetting(CACHE_KEY, JSON.stringify(cache))
}

// ─── Core logic ──────────────────────────────────────────────────────────────

const MAX_CHANGELOG_ENTRIES = 50

/** Stable channel: latest non-prerelease release + cumulative notes. */
async function checkStable(currentVersion: string): Promise<CheckCache | null> {
  const releases = await githubGet<GitHubRelease[]>(
    `/repos/${config.versionCheck.repo}/releases?per_page=30`,
  )
  if (!releases) return null

  const published = releases.filter((r) => !r.draft && !r.prerelease)
  if (published.length === 0) {
    return { channel: 'stable', latestVersion: null, releaseUrl: null, changelog: [], publishedAt: null }
  }

  // Releases come newest-first, but don't rely on it — sort by semver.
  published.sort((a, b) => compareSemver(b.tag_name, a.tag_name))
  const latest = published[0]!
  const latestVersion = latest.tag_name.replace(/^v/, '')

  // Cumulative changelog: every release strictly newer than the running
  // version (when it's unknown, just show the latest release's notes).
  const newer = isUnknownVersion(currentVersion)
    ? [latest]
    : published.filter((r) => compareSemver(currentVersion, r.tag_name) < 0)

  const changelog: ChangelogEntry[] = newer.slice(0, MAX_CHANGELOG_ENTRIES).map((r) => ({
    version: r.tag_name.replace(/^v/, ''),
    title: r.name ?? r.tag_name,
    notes: r.body ?? null,
    url: r.html_url,
    publishedAt: r.published_at ? new Date(r.published_at).getTime() : null,
  }))

  return {
    channel: 'stable',
    latestVersion,
    releaseUrl: latest.html_url,
    changelog,
    publishedAt: latest.published_at ? new Date(latest.published_at).getTime() : null,
  }
}

/** Edge channel: commits between the running sha and origin/main HEAD. */
async function checkEdge(currentSha: string | null): Promise<CheckCache | null> {
  if (!currentSha) {
    log.warn('Edge channel selected but the running sha is unknown — cannot compare')
    return { channel: 'edge', latestVersion: null, releaseUrl: null, changelog: [], publishedAt: null }
  }

  const compare = await githubGet<GitHubCompare>(
    `/repos/${config.versionCheck.repo}/compare/${currentSha}...${config.versionCheck.branch}`,
  )
  if (!compare) return null

  // Guard on the commits list, not just ahead_by — a truncated/malformed
  // compare response must not crash the check.
  if (compare.ahead_by === 0 || compare.commits.length === 0) {
    return {
      channel: 'edge',
      latestVersion: currentSha,
      releaseUrl: null,
      changelog: [],
      publishedAt: null,
    }
  }

  // commits[] is oldest-first — newest first reads better in a changelog.
  const commits = [...compare.commits].reverse().slice(0, MAX_CHANGELOG_ENTRIES)
  const head = commits[0]!
  const changelog: ChangelogEntry[] = commits.map((c) => ({
    version: c.sha.slice(0, 7),
    title: c.commit.message.split('\n')[0] ?? c.sha.slice(0, 7),
    notes: null,
    url: c.html_url,
    publishedAt: c.commit.committer?.date ? new Date(c.commit.committer.date).getTime() : null,
  }))

  return {
    channel: 'edge',
    latestVersion: head.sha.slice(0, 7),
    releaseUrl: compare.html_url,
    changelog,
    publishedAt: changelog[0]?.publishedAt ?? null,
  }
}

function buildVersionInfo(
  channel: UpdateChannel,
  cache: CheckCache | null,
  lastCheckedAt: number | null,
): VersionInfo {
  const currentVersion = config.version
  const currentSha = getCurrentSha()
  const capability = getSelfUpdateCapability()

  // A cache written for another channel must not be interpreted
  const usable = cache && cache.channel === channel ? cache : null

  let isUpdateAvailable = false
  if (usable?.latestVersion) {
    if (channel === 'stable') {
      isUpdateAvailable = isUnknownVersion(currentVersion)
        ? false
        : compareSemver(currentVersion, usable.latestVersion) < 0
    } else {
      isUpdateAvailable = usable.changelog.length > 0
    }
  }

  return {
    currentVersion,
    currentSha,
    channel,
    installationType: config.environment.installationType,
    latestVersion: usable?.latestVersion ?? null,
    isUpdateAvailable,
    canSelfUpdate: capability.canSelfUpdate,
    selfUpdateBlockedReason: capability.reason,
    releaseUrl: usable?.releaseUrl ?? null,
    changelog: usable?.changelog ?? [],
    publishedAt: usable?.publishedAt ?? null,
    lastCheckedAt,
  }
}

export async function getCachedVersionInfo(): Promise<VersionInfo> {
  const [channel, cache, lastCheckedRaw] = await Promise.all([
    getUpdateChannel(),
    readCache(),
    getSetting(LAST_TIME_KEY),
  ])
  const lastCheckedAt = lastCheckedRaw ? Number(lastCheckedRaw) : null

  // Stale (or never run / channel switched) → refresh in the background so
  // this request stays fast; the SSE broadcast will update clients.
  const maxAge = config.versionCheck.intervalHours * 60 * 60 * 1000
  if (!cache || cache.channel !== channel || Date.now() - (lastCheckedAt ?? 0) > maxAge) {
    checkForUpdates().catch((err) => log.warn({ err }, 'Background version check failed'))
  }

  return buildVersionInfo(channel, cache, lastCheckedAt)
}

export async function checkForUpdates(): Promise<VersionInfo> {
  const channel = await getUpdateChannel()
  const result =
    channel === 'stable' ? await checkStable(config.version) : await checkEdge(getCurrentSha())

  if (!result) {
    // GitHub unreachable: keep the previous cache, don't bump last_time so
    // the next read retries sooner.
    log.warn('Version check failed, will retry on next interval')
    const [cache, lastCheckedRaw] = await Promise.all([readCache(), getSetting(LAST_TIME_KEY)])
    return buildVersionInfo(channel, cache, lastCheckedRaw ? Number(lastCheckedRaw) : null)
  }

  const now = Date.now()
  const previous = await readCache()
  await Promise.all([writeCache(result), setSetting(LAST_TIME_KEY, String(now))])

  const info = buildVersionInfo(channel, result, now)

  // Broadcast only when the available version is new (first time we see it),
  // so clients aren't re-notified every interval.
  const isNewlyAvailable =
    info.isUpdateAvailable &&
    (previous?.channel !== channel || previous?.latestVersion !== result.latestVersion)
  if (isNewlyAvailable) {
    sseManager.broadcast({
      type: 'version:update-available',
      data: {
        channel,
        latestVersion: info.latestVersion,
        releaseUrl: info.releaseUrl,
        publishedAt: info.publishedAt,
      },
    })
    log.info(
      { channel, currentVersion: info.currentVersion, currentSha: info.currentSha, latestVersion: info.latestVersion },
      'Update available',
    )
  }

  return info
}

// ─── Cron ────────────────────────────────────────────────────────────────────

let versionCron: Cron | null = null
let initialVersionTimer: ReturnType<typeof setTimeout> | null = null
export function startVersionCheckCron(): void {
  stopVersionCheckCron()
  if (!config.versionCheck.enabled) {
    log.info('Version check disabled')
    return
  }

  const { intervalHours } = config.versionCheck

  // Initial check after a short delay to let the server finish booting
  initialVersionTimer = setTimeout(() => {
    checkForUpdates().catch((err) => log.error({ err }, 'Initial version check failed'))
  }, 30_000)

  // Periodic check
  versionCron = new Cron(`0 */${intervalHours} * * *`, async () => {
    log.debug('Running scheduled version check')
    await checkForUpdates().catch((err) => log.error({ err }, 'Scheduled version check failed'))
  })

  log.info({ intervalHours }, 'Version check cron started')
}

export function stopVersionCheckCron(): void {
  versionCron?.stop()
  if (initialVersionTimer) clearTimeout(initialVersionTimer)
  versionCron = null
  initialVersionTimer = null
}
