/**
 * OpenAI provider using Codex CLI OAuth credentials.
 *
 * Instead of an API key, this provider reads OAuth tokens from the
 * Codex CLI auth file (~/.codex/auth.json) and refreshes them
 * automatically. The `apiKey` field in ProviderConfig is repurposed
 * as an optional override path to the credentials file.
 *
 * The Codex backend uses the OpenAI Responses API at
 * https://chatgpt.com/backend-api/codex/responses and is billed
 * against the user's ChatGPT subscription (Plus/Pro).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { REAL_HOME, normalizeAbsoluteHome } from '@/server/llm/llm/_home-paths'
import { createLogger } from '@/server/logger'
import type { ProviderConfig } from '@/server/llm/core/types'
import { decodeJwtClaims, type PkceClient, type PkceTokenResponse } from '@/server/llm/llm/_oauth-pkce'
import { getVaultOAuthToken } from '@/server/llm/llm/_oauth-vault-access'

const log = createLogger('provider:openai-codex')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

/**
 * PKCE public-client descriptor for the in-app "Sign in with ChatGPT" flow.
 * Mirrors the Codex CLI's own OAuth client. The registered redirect is a fixed
 * loopback URL the headless server can't actually serve — instead the user
 * copies the `code`/`state` out of the failed-to-load redirect URL and pastes
 * it back (parsePastedCode handles the full-URL form).
 */
export const CODEX_PKCE_CLIENT: PkceClient = {
  clientId: CLIENT_ID,
  authorizeUrl: 'https://auth.openai.com/oauth/authorize',
  tokenUrl: TOKEN_URL,
  redirectUri: 'http://localhost:1455/auth/callback',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  authorizeParams: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true' },
}

/**
 * Pull the stable ChatGPT account id out of the OIDC id_token claims — the
 * value the Codex backend expects in the `ChatGPT-Account-ID` header. Stored in
 * the vault bundle's `extra` since the refresh grant does not echo it back.
 */
export function codexAccountIdFromTokens(tokens: PkceTokenResponse): Record<string, string> | undefined {
  if (!tokens.idToken) return undefined
  const claims = decodeJwtClaims(tokens.idToken)
  const auth = claims?.['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined
  const accountId = auth?.chatgpt_account_id
  return accountId ? { accountId } : undefined
}

// Search the plain env HOME first, then the snap-adjusted REAL_HOME. On macOS
// and nonstandard homes REAL_HOME can resolve to the wrong place (e.g. getRealHome
// builds /home/$USER while the real home is /Users/$USER), so the env HOME
// candidate is what actually finds the file there.
function codexAuthCandidates(): string[] {
  const paths: string[] = []
  for (const home of [process.env.HOME, REAL_HOME]) {
    const base = normalizeAbsoluteHome(home)
    if (!base) continue
    const p = join(base, '.codex', 'auth.json')
    if (!paths.includes(p)) paths.push(p)
  }
  return paths
}

const CANDIDATE_PATHS = codexAuthCandidates()


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CodexAuthFile {
  auth_mode: string
  tokens: {
    access_token: string
    refresh_token: string
    id_token: string
    account_id: string
  }
  last_refresh: string
}

// ---------------------------------------------------------------------------
// Credentials path resolution
// ---------------------------------------------------------------------------
function resolveCredsPath(overridePath?: string): string {
  if (overridePath && overridePath.trim().length > 0) {
    if (!existsSync(overridePath)) {
      throw new Error(`Codex credentials file not found at: ${overridePath}`)
    }
    return overridePath
  }

  for (const candidate of CANDIDATE_PATHS) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Codex CLI credentials file not found. Searched: ${CANDIDATE_PATHS.join(', ')}. ` +
      'Make sure Codex CLI is installed and authenticated (codex login), or provide the path explicitly.',
  )
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------
function decodeJwtExpiry(token: string): number {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return 0
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())
    return (payload.exp ?? 0) * 1000 // convert to ms
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------
async function refreshToken(
  refreshTok: string,
): Promise<{ access_token: string; refresh_token: string; id_token?: string }> {
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
    throw new Error(`Codex OAuth token refresh failed (${resp.status}): ${text}`)
  }

  return resp.json() as Promise<{
    access_token: string
    refresh_token: string
    id_token?: string
  }>
}

// ---------------------------------------------------------------------------
// Credential management — single-flight refresh
// ---------------------------------------------------------------------------
// Shared in-process cache + single-flight lock, keyed by storage location (the
// creds file path, or the vault key) so multiple Codex providers don't clobber
// one another. Expiry is always derived from the access_token JWT.
interface CodexCreds {
  accessToken: string
  accountId: string
}
const credsCache = new Map<string, { accessToken: string; accountId: string; expiresAt: number }>()
const refreshLocks = new Map<string, Promise<CodexCreds>>()

function ensureFresh(cacheKey: string, refresh: () => Promise<CodexCreds>): Promise<CodexCreds> {
  const cached = credsCache.get(cacheKey)
  if (cached && cached.expiresAt - Date.now() > BUFFER_MS) {
    return Promise.resolve({ accessToken: cached.accessToken, accountId: cached.accountId })
  }
  let lock = refreshLocks.get(cacheKey)
  if (!lock) {
    lock = refresh().finally(() => refreshLocks.delete(cacheKey))
    refreshLocks.set(cacheKey, lock)
  }
  return lock
}

// ─── CLI credentials-file path (legacy / existing setups) ────────────────────

async function refreshFromFile(credsPath: string): Promise<CodexCreds> {
  const raw = readFileSync(credsPath, 'utf8')
  const creds: CodexAuthFile = JSON.parse(raw)
  const tokens = creds.tokens
  const now = Date.now()
  const accountId = tokens.account_id

  const expiresAt = decodeJwtExpiry(tokens.access_token)
  if (expiresAt && expiresAt - now > BUFFER_MS) {
    credsCache.set(credsPath, { accessToken: tokens.access_token, accountId, expiresAt })
    return { accessToken: tokens.access_token, accountId }
  }

  const data = await refreshToken(tokens.refresh_token)
  log.info('Codex OAuth token refreshed successfully (file)')
  const newExpiresAt = decodeJwtExpiry(data.access_token)

  // Write back to auth.json so the Codex CLI also sees the refreshed token
  creds.tokens = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    ...(data.id_token ? { id_token: data.id_token } : {}),
  }
  creds.last_refresh = new Date().toISOString()
  writeFileSync(credsPath, JSON.stringify(creds, null, 2))
  credsCache.set(credsPath, { accessToken: data.access_token, accountId, expiresAt: newExpiresAt })
  return { accessToken: data.access_token, accountId }
}

// ---------------------------------------------------------------------------
// Public OAuth helpers
// ---------------------------------------------------------------------------

/**
 * Get a fresh OAuth access token + ChatGPT account id for the Codex backend.
 *
 * Resolution order:
 *   1. **Vault** — tokens from the in-app sign-in flow, via the generic,
 *      declaration-driven `getVaultOAuthToken` (shared with Anthropic + plugin
 *      providers). The ChatGPT account id rides in the bundle's `extra`.
 *   2. **CLI file** — `~/.codex/auth.json` (or an explicit `authFilePath`).
 */
export async function getCodexOAuthCredentials(config: ProviderConfig = {}): Promise<CodexCreds> {
  const vault = await getVaultOAuthToken(config)
  if (vault) return { accessToken: vault.accessToken, accountId: vault.extra?.accountId ?? '' }
  const credsPath = resolveCredsPath(config['authFilePath'] || undefined)
  return ensureFresh(credsPath, () => refreshFromFile(credsPath))
}
