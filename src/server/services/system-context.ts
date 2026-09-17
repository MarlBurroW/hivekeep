import { execSync } from 'child_process'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import os from 'os'
import { createLogger } from '@/server/logger'

const log = createLogger('system-context')

export interface RuntimeAvailability {
  name: string
  version: string
}

export interface SystemContext {
  platform: string
  arch: string
  runtimes: RuntimeAvailability[]
}

let cached: SystemContext | null = null

// CLIs commonly needed by sub-Agents for builds, tests, version control and
// language tooling. Probed once per server lifetime. We deliberately probe
// through several PATH augmentation passes so non-login-shell deployments
// (systemd user services, Docker, supervisord …) still pick up the runtimes
// installed under the operator's profile.
const PROBED_TOOLS = [
  'bun',
  'node',
  'npm',
  'pnpm',
  'yarn',
  'git',
  'python3',
  'docker',
  'rg',
  'curl',
  'gh',
]

interface ProbeResult {
  version: string
  binDir: string
}

/**
 * Augment `process.env.PATH` with directories that frequently hold language
 * runtimes when the host's default PATH is the minimal systemd default
 * (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`).
 *
 * Three sources, in priority order:
 *   1. `dirname(process.execPath)` — the binary running Hivekeep itself. When
 *      this server is launched by Bun, this is the path to Bun.
 *   2. `HIVEKEEP_AUGMENT_PATH` env var (operator-controlled). Colon-separated
 *      list of directories prepended to PATH.
 *   3. A short list of well-known user-local bin dirs that exist on the
 *      filesystem (`~/.bun/bin`, `~/.local/bin`, `~/.nvm/versions/node/*\/bin`).
 *
 * All additions are deduped against the current PATH. The augmentation is
 * idempotent — calling `getSystemContext()` twice does not double-augment
 * because `cached` short-circuits the call.
 */
function augmentPath(): string[] {
  const additions: string[] = []
  const seen = new Set((process.env.PATH ?? '').split(':').filter(Boolean))

  const push = (dir: string) => {
    if (!dir) return
    if (seen.has(dir)) return
    if (!existsSync(dir)) return
    seen.add(dir)
    additions.push(dir)
  }

  // 1. Runtime self — `process.execPath` is the binary serving the request.
  try {
    push(dirname(process.execPath))
  } catch {
    // ignore
  }

  // 2. Operator override.
  const operatorPaths = process.env.HIVEKEEP_AUGMENT_PATH
  if (operatorPaths) {
    for (const p of operatorPaths.split(':')) {
      push(p.trim())
    }
  }

  // 3. Well-known user-local bin dirs.
  const home = os.homedir()
  if (home) {
    push(join(home, '.bun', 'bin'))
    push(join(home, '.local', 'bin'))
    // Glob ~/.nvm/versions/node/*/bin — pick the first node bin we find.
    try {
      const nvmRoot = join(home, '.nvm', 'versions', 'node')
      if (existsSync(nvmRoot)) {
        const { readdirSync } = require('fs') as typeof import('fs')
        for (const v of readdirSync(nvmRoot)) {
          push(join(nvmRoot, v, 'bin'))
        }
      }
    } catch {
      // ignore — nvm not installed
    }
  }

  if (additions.length > 0) {
    const existing = process.env.PATH ?? ''
    process.env.PATH = [...additions, existing].filter(Boolean).join(':')
  }
  return additions
}

function probe(tool: string): ProbeResult | null {
  // `bash -lc` reads the operator's login profile (`~/.profile` / `~/.bash_profile`)
  // so PATH additions from those files (typical of bun / nvm installers) are
  // picked up. Interactive shells (which would source `~/.bashrc`) are
  // intentionally not used — we don't want to inherit aliases.
  try {
    const out = execSync(
      `bash -lc 'p=$(command -v ${tool} 2>/dev/null) && echo "$p" && "${tool}" --version 2>&1 | head -n1'`,
      {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length < 2) return null
    const binPath = lines[0]!
    const version = lines[1]!
    if (!binPath.startsWith('/')) return null
    return { version, binDir: dirname(binPath) }
  } catch {
    return null
  }
}

/**
 * Get the host system context (platform, arch, available CLIs).
 *
 * Side effect on first call: augments `process.env.PATH` with `process.execPath`,
 * operator-defined `HIVEKEEP_AUGMENT_PATH`, and well-known user-local bin
 * dirs, THEN probes each tool. The augmentation is what fixes the prod
 * scenario observed on prod task `e6c9d6f1`: the systemd user
 * service started with the default PATH and `bun` lived in `~/.bun/bin`,
 * which neither the inherited PATH nor `bash -lc`'s login profile knew
 * about, so the agent burned ~10 calls re-discovering it.
 *
 * Cached after the first call — these values do not change at runtime.
 */
export function getSystemContext(): SystemContext {
  if (cached) return cached
  const pathAdditions = augmentPath()
  if (pathAdditions.length > 0) {
    log.info({ added: pathAdditions }, 'PATH augmented before probe')
  }

  const runtimes: RuntimeAvailability[] = []
  const probedDirs = new Set<string>()
  for (const t of PROBED_TOOLS) {
    const result = probe(t)
    if (!result) continue
    runtimes.push({ name: t, version: result.version })
    probedDirs.add(result.binDir)
  }

  // A tool's resolved bin dir may itself be a new directory the augmentation
  // step missed (e.g. `bash -lc` sourced a profile that prepended something).
  // Fold those in too so `run_shell` (which inherits process.env) finds the
  // same binaries.
  const existing = new Set((process.env.PATH ?? '').split(':').filter(Boolean))
  const postProbeAdditions: string[] = []
  for (const dir of probedDirs) {
    if (!existing.has(dir)) postProbeAdditions.push(dir)
  }
  if (postProbeAdditions.length > 0) {
    process.env.PATH = [...postProbeAdditions, ...existing].join(':')
    log.info({ added: postProbeAdditions }, 'PATH augmented with detected tool dirs')
  }

  cached = {
    platform: os.platform(),
    arch: os.arch(),
    runtimes,
  }
  log.info(
    { platform: cached.platform, arch: cached.arch, runtimes: runtimes.map((r) => r.name) },
    'System context probed',
  )
  return cached
}

/** Reset the cache. Test-only. */
export function _resetSystemContextCache(): void {
  cached = null
}
