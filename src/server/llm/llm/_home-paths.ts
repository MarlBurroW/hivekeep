/**
 * Shared home-directory resolution for the OAuth/CLI provider helpers.
 *
 * Underscore-prefixed so the provider registry's `import.meta.glob` skips it.
 * Keeping this in one place avoids the three credential/cache path resolvers
 * (openai-codex, _codex-auth, _anthropic-oauth-auth) drifting apart.
 */
import { isAbsolute, normalize } from 'path'

/**
 * Resolve the real user home directory.
 * Bun installed via snap sets HOME to a sandboxed path (e.g. ~/snap/bun-js/87/).
 * We prefer REAL_HOME, strip snap paths from HOME, and only construct
 * /home/$USER as a last resort.
 */
function getRealHome(): string {
  // REAL_HOME is set by some snap environments.
  if (process.env.REAL_HOME) return process.env.REAL_HOME
  // Fall back to HOME, but strip snap paths.
  const home = process.env.HOME ?? ''
  const snapMatch = home.match(/^(\/home\/[^/]+)\/snap\//)
  if (snapMatch) return snapMatch[1]!
  // Last resort: construct from USER.
  if (process.env.USER) return `/home/${process.env.USER}`
  return home
}

/** The snap-adjusted home directory, resolved once at process start. */
export const REAL_HOME = getRealHome()

/**
 * Normalize a home path and return it only when absolute, else null. Used to
 * keep credential/cache path candidates from ever being built off a relative or
 * empty home value.
 */
export function normalizeAbsoluteHome(home: string | undefined): string | null {
  if (!home) return null
  const normalized = normalize(home)
  return isAbsolute(normalized) ? normalized : null
}
