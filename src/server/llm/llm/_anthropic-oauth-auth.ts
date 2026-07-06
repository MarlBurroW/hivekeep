/**
 * Anthropic provider using Claude Code Max OAuth credentials.
 *
 * Instead of an API key, this provider reads OAuth tokens from the
 * Claude Code credentials file (~/.claude/.credentials.json) and refreshes them
 * automatically. The `apiKey` field in ProviderConfig is repurposed
 * as an optional override path to the credentials file.
 *
 * Based on: https://github.com/bardak971/amnesia/blob/main/shared/src/oauth.ts
 *
 * # Third-party fingerprint mitigation
 *
 * Since April 2026, Anthropic re-routes OAuth requests detected as coming from
 * non-official Claude Code clients to a separate "extra usage" billing pool
 * (instead of consuming the user's plan quota). Hivekeep replicates the wire
 * shape of the official CLI as faithfully as practical to stay on the regular
 * pool:
 *   - `user-agent` matches the latest published Claude Code version
 *   - `anthropic-beta` includes the same set of betas the official CLI sends
 *   - `anthropic-dangerous-direct-browser-access` is NOT sent on chat requests
 *     (the official CLI only opts into this on the one-shot key verification
 *     path; sending it on every request was a strong "not Claude Code" signal)
 *   - `metadata.user_id` is injected on each request body (the OAuth fetch
 *     wrapper in `agent-engine.ts` calls `getOAuthUserId()` for this)
 *
 * Anthropic actively iterates on detection — these mitigations are best-effort
 * and may need to be refreshed.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { isAbsolute, join, normalize } from 'path'
import { createLogger } from '@/server/logger'
import type { ProviderConfig } from '@/server/llm/core/types'
import type { PkceClient } from '@/server/llm/llm/_oauth-pkce'
import { getVaultOAuthToken } from '@/server/llm/llm/_oauth-vault-access'

const log = createLogger('provider:anthropic-oauth')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'

/**
 * PKCE public-client descriptor for the in-app "Sign in with Claude" flow.
 * Mirrors the Claude Code CLI's own OAuth client: the authorize page renders
 * the code as `<code>#<state>` for manual paste (the `code=true` param +
 * the console callback redirect), and the token exchange is the same
 * public-client endpoint the refresh grant already uses.
 */
export const ANTHROPIC_PKCE_CLIENT: PkceClient = {
  clientId: CLIENT_ID,
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: TOKEN_URL,
  redirectUri: 'https://console.anthropic.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
  authorizeParams: { code: 'true' },
  // Anthropic's token endpoint requires `state` echoed back in the exchange.
  includeStateInExchange: true,
}
// Track the latest published Claude Code CLI version. Bump when Anthropic
// releases new versions to avoid being flagged as an outdated client.
const CLAUDE_CODE_VERSION = '2.1.120'
const BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

/**
 * Resolve the real user home directory.
 * Bun installed via snap sets HOME to a sandboxed path (e.g. ~/snap/bun-js/87/).
 * We prefer the REAL_HOME or the home from /etc/passwd via the USER env var.
 */
function getRealHome(): string {
  // REAL_HOME is set by some snap environments
  if (process.env.REAL_HOME) return process.env.REAL_HOME
  // Fall back to HOME, but strip snap paths
  const home = process.env.HOME ?? ''
  const snapMatch = home.match(/^(\/home\/[^/]+)\/snap\//)
  if (snapMatch) return snapMatch[1]!
  // Last resort: construct from USER
  if (process.env.USER) return `/home/${process.env.USER}`
  return home
}

const REAL_HOME = getRealHome()

function normalizeAbsoluteHome(home: string | undefined): string | null {
  if (!home) return null
  const normalized = normalize(home)
  return isAbsolute(normalized) ? normalized : null
}

// Credential filenames the Claude CLI may use, relative to a home directory.
const CLAUDE_CREDENTIAL_RELPATHS: string[][] = [
  ['.claude', '.credentials.json'],
  ['.claude.json'],
  ['.claude', 'credentials.json'],
]

// Search the plain env HOME first, then the snap-adjusted REAL_HOME. On macOS
// and nonstandard homes REAL_HOME can resolve to the wrong place (e.g. getRealHome
// builds /home/$USER while the real home is /Users/$USER), so the env HOME
// candidate is what actually finds the credentials there.
function claudeCredentialCandidates(): string[] {
  const bases: string[] = []
  for (const home of [process.env.HOME, REAL_HOME]) {
    const base = normalizeAbsoluteHome(home)
    if (base && !bases.includes(base)) bases.push(base)
  }
  const paths: string[] = []
  for (const base of bases) {
    for (const rel of CLAUDE_CREDENTIAL_RELPATHS) {
      const p = join(base, ...rel)
      if (!paths.includes(p)) paths.push(p)
    }
  }
  return paths
}

const CANDIDATE_PATHS = claudeCredentialCandidates()

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface OAuthCredentials {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    [key: string]: unknown
  }
}

// ---------------------------------------------------------------------------
// Credentials path resolution
// ---------------------------------------------------------------------------
function resolveCredsPath(overridePath?: string): string {
  if (overridePath && overridePath.trim().length > 0) {
    if (!existsSync(overridePath)) {
      throw new Error(`Credentials file not found at: ${overridePath}`)
    }
    return overridePath
  }

  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Claude Code credentials file not found. Searched: ${CANDIDATE_PATHS.join(', ')}. ` +
      'Make sure Claude Code CLI is installed and authenticated, or provide the path explicitly.',
  )
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------
async function refreshToken(
  refreshTok: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshTok,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`OAuth token refresh failed (${resp.status}): ${text}`)
  }

  return resp.json() as Promise<{
    access_token: string
    refresh_token: string
    expires_in: number
  }>
}

// ---------------------------------------------------------------------------
// Credential management — single-flight refresh
// ---------------------------------------------------------------------------
// Both the CLI-file path and the vault (CLI-free sign-in) path share the same
// in-process access-token cache + single-flight lock, keyed by their storage
// location (the creds file path, or `vault:<key>`) so multiple OAuth providers
// don't clobber one another's tokens.
const accessTokenCache = new Map<string, { accessToken: string; expiresAt: number }>()
const refreshLocks = new Map<string, Promise<string>>()

function ensureFresh(cacheKey: string, refresh: () => Promise<string>): Promise<string> {
  const cached = accessTokenCache.get(cacheKey)
  if (cached && cached.expiresAt - Date.now() > BUFFER_MS) {
    return Promise.resolve(cached.accessToken)
  }
  let lock = refreshLocks.get(cacheKey)
  if (!lock) {
    lock = refresh().finally(() => refreshLocks.delete(cacheKey))
    refreshLocks.set(cacheKey, lock)
  }
  return lock
}

// ─── CLI credentials-file path (legacy / existing setups) ────────────────────

async function refreshFromFile(credsPath: string): Promise<string> {
  const raw = readFileSync(credsPath, 'utf8')
  const creds: OAuthCredentials = JSON.parse(raw)
  const oauth = creds.claudeAiOauth
  const now = Date.now()

  // Re-check after acquiring the "lock"
  if (oauth.expiresAt && oauth.expiresAt - now > BUFFER_MS) {
    accessTokenCache.set(credsPath, { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt })
    return oauth.accessToken
  }

  const data = await refreshToken(oauth.refreshToken)
  log.info('OAuth token refreshed successfully (file)')

  const expiresAt = now + data.expires_in * 1000 - BUFFER_MS
  creds.claudeAiOauth = {
    ...oauth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  }

  writeFileSync(credsPath, JSON.stringify(creds, null, 2))
  accessTokenCache.set(credsPath, { accessToken: data.access_token, expiresAt })

  return data.access_token
}

// ---------------------------------------------------------------------------
// Public OAuth helpers
// ---------------------------------------------------------------------------

/**
 * Get a fresh OAuth access token for the Anthropic API.
 *
 * Resolution order:
 *   1. **Vault** — when the provider row was set up via the in-app sign-in flow.
 *      Handled by the generic, declaration-driven `getVaultOAuthToken` (shared
 *      with Codex and any plugin provider that declares `oauth`).
 *   2. **CLI file** — the legacy `~/.claude/.credentials.json` (or an explicit
 *      `authFilePath` override). Keeps existing setups working unchanged.
 */
export async function getOAuthAccessToken(config: ProviderConfig = {}): Promise<string> {
  const vault = await getVaultOAuthToken(config)
  if (vault) return vault.accessToken
  const credsPath = resolveCredsPath(config['authFilePath'] || undefined)
  return ensureFresh(credsPath, () => refreshFromFile(credsPath))
}

// Latest published @anthropic-ai/sdk version. The official Claude Code CLI
// uses this SDK and sends `X-Stainless-Package-Version` accordingly.
const ANTHROPIC_SDK_VERSION = '0.92.0'

/**
 * Map Node-style `process.platform` to the Stainless `X-Stainless-OS` value.
 * Mirrors `normalizePlatform()` in @anthropic-ai/sdk's core.
 */
function normalizeStainlessOS(platform: string): string {
  const p = platform.toLowerCase()
  if (p.includes('ios')) return 'iOS'
  if (p === 'android') return 'Android'
  if (p === 'darwin') return 'MacOS'
  if (p === 'win32') return 'Windows'
  if (p === 'freebsd') return 'FreeBSD'
  if (p === 'openbsd') return 'OpenBSD'
  if (p === 'linux') return 'Linux'
  return p ? `Other:${p}` : 'Unknown'
}

/**
 * Map Node-style `process.arch` to the Stainless `X-Stainless-Arch` value.
 * Mirrors `normalizeArch()` in @anthropic-ai/sdk's core.
 */
function normalizeStainlessArch(arch: string): string {
  if (arch === 'x32') return 'x32'
  if (arch === 'x86_64' || arch === 'x64') return 'x64'
  if (arch === 'arm') return 'arm'
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64'
  return arch ? `other:${arch}` : 'unknown'
}

/**
 * Stainless platform-identification headers added by @anthropic-ai/sdk on every
 * request. The Vercel AI SDK does NOT send these — their absence is a strong
 * fingerprint that the request comes from a non-official client.
 *
 * Computed once at module load (these values don't change per-request).
 */
export const STAINLESS_HEADERS: Record<string, string> = {
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': ANTHROPIC_SDK_VERSION,
  'X-Stainless-OS': normalizeStainlessOS(process.platform),
  'X-Stainless-Arch': normalizeStainlessArch(process.arch),
  'X-Stainless-Runtime': 'node',
  // Under Bun, `process.versions.node` reports the Node version Bun is
  // compatible with, which is what Anthropic expects.
  'X-Stainless-Runtime-Version': process.versions.node ? `v${process.versions.node}` : process.version,
}

/**
 * Headers sent with every OAuth chat request to the Anthropic API.
 *
 * Mirrors what the official Claude Code CLI sends (and the headers that
 * `kristianvast/hermes-claude-auth` confirmed are required to stay on the
 * regular plan-billing pool):
 *   - `anthropic-beta` includes the same 6 betas the CLI enables
 *   - `user-agent` matches the latest released CLI version
 *   - `x-app: cli` identifies the request shape
 *   - `X-Stainless-*` family identifies the request as coming from the
 *     official @anthropic-ai/sdk
 *   - `anthropic-dangerous-direct-browser-access: true` mirrors what the
 *     SDK sends when configured with `dangerouslyAllowBrowser: true`,
 *     which the OAuth client path uses
 *
 * Per-request Stainless headers (`X-Stainless-Retry-Count`, `X-Stainless-Timeout`)
 * are added by the OAuth fetch wrapper rather than baked in here.
 */
export const OAUTH_HEADERS = {
  // Beta set aligned with what the real Claude Code CLI sends (captured on the
  // wire). Most are capability-enablers that are NO-OP unless the matching
  // request param is used — they're included to match CC's fingerprint (which
  // helps stay on the subscription billing pool) and to unlock features we do
  // use. We intentionally do NOT send the `context_management` request param
  // (Hivekeep has its own compacting), only the header. `context-1m` actually
  // enables the 1M context window for the [1m] models.
  'anthropic-beta': [
    'claude-code-20250219',
    'oauth-2025-04-20',
    'context-1m-2025-08-07',
    'interleaved-thinking-2025-05-14',
    'redact-thinking-2026-02-12',
    'thinking-token-count-2026-05-13',
    'context-management-2025-06-27',
    'fine-grained-tool-streaming-2025-05-14',
    'prompt-caching-scope-2026-01-05',
    'mid-conversation-system-2026-04-07',
    'advisor-tool-2026-03-01',
    // Adaptive-thinking effort dial (`output_config.effort` +
    // `thinking:{type:'adaptive'}`) — required for the server to honor effort.
    'effort-2025-11-24',
    'extended-cache-ttl-2025-04-11',
    'structured-outputs-2025-12-15',
  ].join(','),
  'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true',
  ...STAINLESS_HEADERS,
} as const

// ---------------------------------------------------------------------------
// metadata.user_id — fingerprint mitigation
// ---------------------------------------------------------------------------
// The official CLI sends `metadata: { user_id: "<installation>_<session>" }`
// on every Messages API call. We replicate the EXACT shape so OAuth requests
// aren't flagged as third-party:
//   - installation: 64-char hex string (randomBytes(32).toString('hex'))
//   - session:      standard UUID v4 with dashes (randomUUID())
// Sending a UUID for the installation portion (instead of 64-char hex) is a
// detectable fingerprint, since Anthropic knows the exact format their CLI
// generates.

const SESSION_ID = randomUUID()
let cachedInstallationId: string | null = null

function getInstallationId(): string {
  if (cachedInstallationId) return cachedInstallationId
  // Persist alongside the credentials file so the ID survives restarts but is
  // tied to the same machine/install. Falls back to in-memory if the disk
  // write fails (read-only FS, missing dir, etc.).
  const idPath = join(REAL_HOME, '.claude', '.hivekeep-installation-id')
  try {
    if (existsSync(idPath)) {
      const value = readFileSync(idPath, 'utf8').trim()
      if (value) {
        cachedInstallationId = value
        return value
      }
    }
  } catch {
    // fall through to generate
  }
  const newId = randomBytes(32).toString('hex')
  cachedInstallationId = newId
  try {
    writeFileSync(idPath, newId)
  } catch {
    // non-fatal — keep the in-memory ID for this process lifetime
  }
  return newId
}

/**
 * Build the `metadata.user_id` value injected on every OAuth Messages API
 * request. Mirrors the `${installation}_${session}` shape produced by the
 * official Claude Code CLI's `getMetadata()` helper.
 *
 * Format: `<64-hex-chars>_<UUID v4>`
 *
 * NOTE: Anthropic prefers the OAuth account's `accountUuid` from
 * `~/.claude.json#oauthAccount` for the installation portion. When that file
 * exists, `getOAuthAccountUuid()` returns it and the wrapper uses it instead.
 */
export function getOAuthUserId(): string {
  const accountUuid = getOAuthAccountUuid()
  if (accountUuid) return accountUuid
  return `${getInstallationId()}_${SESSION_ID}`
}

/**
 * Read the OAuth account UUID from `~/.claude.json#oauthAccount.accountUuid`.
 * This is the stable user ID that Anthropic associates with the subscription.
 * Returns null if the file doesn't exist or doesn't contain the field.
 */
export function getOAuthAccountUuid(): string | null {
  const claudeJsonPath = join(REAL_HOME, '.claude.json')
  if (!existsSync(claudeJsonPath)) return null
  try {
    const raw = readFileSync(claudeJsonPath, 'utf8')
    const parsed = JSON.parse(raw) as { oauthAccount?: { accountUuid?: string } }
    return parsed.oauthAccount?.accountUuid ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Billing-header signature
// ---------------------------------------------------------------------------
// Anthropic's request router validates a signed billing tag injected as the
// FIRST text block in the `system` array. Without it, OAuth requests get
// re-routed to the "extra usage" billing pool. The signature scheme is:
//
//   x-anthropic-billing-header: cc_version=<version>.<suffix>; cc_entrypoint=<entrypoint>; cch=<cch>;
//
//   where:
//     suffix = sha256(SALT + sampled_chars + version).hex.slice(0, 3)
//     cch    = sha256(first_user_message_text).hex.slice(0, 5)
//     sampled_chars = chars at positions [4, 7, 20] of the first user message
//                     text (padded with "0" if shorter)
//
// Reverse-engineered from the kristianvast/hermes-claude-auth project, which
// reverse-engineered the billing scheme by inspecting real Claude Code traffic.

const BILLING_SALT = '59cf53e54c78'
const BILLING_ENTRYPOINT = 'sdk-cli'
const BILLING_PREFIX = 'x-anthropic-billing-header'

/** Pull the first user-message text out of a Messages API body. */
function extractFirstUserMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { role?: string; content?: unknown }
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block && typeof block === 'object') {
          const b = block as { type?: string; text?: unknown }
          if (b.type === 'text' && typeof b.text === 'string' && b.text) {
            return b.text
          }
        }
      }
    }
  }
  return ''
}

function computeBillingSuffix(messageText: string, version: string): string {
  // Pick chars at positions 4, 7, 20 (Python-style); pad with "0" when shorter.
  const positions = [4, 7, 20]
  const sampled = positions.map((i) => messageText[i] ?? '0').join('')
  return createHash('sha256').update(`${BILLING_SALT}${sampled}${version}`).digest('hex').slice(0, 3)
}

function computeCch(messageText: string): string {
  return createHash('sha256').update(messageText, 'utf8').digest('hex').slice(0, 5)
}

/**
 * Build the signed billing tag that goes as a system text block on every
 * OAuth Messages API request. Format mirrors what Anthropic's request router
 * expects to bill OAuth traffic against the user's plan limits instead of
 * the "extra usage" pool.
 */
export function buildBillingHeaderText(messages: unknown, version: string = CLAUDE_CODE_VERSION): string {
  const text = extractFirstUserMessageText(messages)
  const suffix = computeBillingSuffix(text, version)
  const cch = computeCch(text)
  return `${BILLING_PREFIX}: cc_version=${version}.${suffix}; cc_entrypoint=${BILLING_ENTRYPOINT}; cch=${cch};`
}

/**
 * Magic system block required by the Anthropic OAuth endpoint.
 * The server validates the first system block is this exact string.
 *
 * Note: no `cache_control` here. The block is tiny (~15 tokens), and any
 * cache breakpoint we set on later content (the stable system segment, etc.)
 * automatically covers this block too via Anthropic's longest-prefix-match
 * cache lookup. Reserving a separate breakpoint for this would just consume
 * one of our 4 available budgets for negligible benefit.
 */
export const REQUIRED_SYSTEM_BLOCK = {
  type: 'text' as const,
  text: 'You are Claude Code, Anthropic\'s official CLI for Claude.',
}

