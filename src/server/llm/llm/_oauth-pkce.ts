/**
 * Generic OAuth2 **PKCE public-client** authorization-code flow.
 *
 * This is the PKCE counterpart to `src/server/services/oauth.ts` (which is a
 * confidential-client flow driven by an `OAuthProfile` and a client secret).
 * The subscription LLM providers — Anthropic (Claude Max) and OpenAI (Codex) —
 * are *public clients*: they ship a fixed `client_id` and have NO client
 * secret, authenticating the token exchange with a `code_verifier` instead.
 *
 * The host runs the dance in a CLI-free "paste the code" shape:
 *   1. `generatePkce()` mints a verifier + challenge.
 *   2. `buildPkceAuthorizeUrl()` builds the URL the user opens in a browser.
 *   3. The provider's redirect page shows the user an authorization code
 *      (Anthropic renders `<code>#<state>`; the OpenAI loopback redirect puts
 *      `code`/`state` in the URL query). The user pastes it back.
 *   4. `exchangePkceCode()` swaps the code (+ verifier) for tokens.
 *
 * Nothing here is Anthropic- or OpenAI-specific — each provider supplies its
 * own endpoints / client id / scopes / redirect uri via `PkceClient`.
 */
import { createHash, randomBytes } from 'crypto'
// PkceClient / PkceTokenResponse are declared in the SDK (single source of
// truth) so plugin providers can declare an `oauth` descriptor too. The runtime
// dance (mint/build/exchange) stays host-side, here.
import type { PkceClient, PkceTokenResponse } from '@gezy/sdk'

export type { PkceClient, PkceTokenResponse }

export interface PkcePair {
  verifier: string
  challenge: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Mint a fresh code_verifier (43-char base64url) + its S256 challenge. */
export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** Build the browser authorize URL for a PKCE public client. */
export function buildPkceAuthorizeUrl(opts: {
  client: PkceClient
  challenge: string
  state: string
}): string {
  const url = new URL(opts.client.authorizeUrl)
  url.searchParams.set('client_id', opts.client.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', opts.client.redirectUri)
  url.searchParams.set('scope', opts.client.scopes.join(' '))
  url.searchParams.set('code_challenge', opts.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', opts.state)
  for (const [k, v] of Object.entries(opts.client.authorizeParams ?? {})) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

/**
 * Normalise whatever the user pasted back into a bare `{ code, state? }`.
 *
 * Accepts three shapes seen in the wild:
 *   - a bare code: `abc123`
 *   - Anthropic's `<code>#<state>` fragment
 *   - a full redirect URL whose query carries `code` (+ `state`)
 */
export function parsePastedCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim()
  if (!trimmed) return { code: '' }
  // Full URL form (OpenAI loopback redirect the browser couldn't load).
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed)
      return {
        code: u.searchParams.get('code') ?? '',
        state: u.searchParams.get('state') ?? undefined,
      }
    } catch {
      // fall through to fragment parsing
    }
  }
  // Anthropic `<code>#<state>` form.
  const hashIdx = trimmed.indexOf('#')
  if (hashIdx >= 0) {
    return { code: trimmed.slice(0, hashIdx), state: trimmed.slice(hashIdx + 1) || undefined }
  }
  return { code: trimmed }
}

interface RawTokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  [key: string]: unknown
}

/** Exchange an authorization code (+ verifier) for tokens. */
export async function exchangePkceCode(opts: {
  client: PkceClient
  code: string
  verifier: string
  /** Provider may echo state back in the token request (Anthropic does). */
  state?: string
}): Promise<PkceTokenResponse> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.client.clientId,
    redirect_uri: opts.client.redirectUri,
    code_verifier: opts.verifier,
  }
  // Only providers that accept `state` in the token request get it (Anthropic);
  // OpenAI/Codex rejects it with a 400 invalid_request.
  if (opts.state && opts.client.includeStateInExchange) body.state = opts.state

  const res = await fetch(opts.client.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`OAuth token endpoint ${res.status}: ${text.slice(0, 300)}`)
  }
  let json: RawTokenResponse
  try {
    json = JSON.parse(text) as RawTokenResponse
  } catch {
    throw new Error(`OAuth token endpoint returned non-JSON: ${text.slice(0, 200)}`)
  }
  if (!json.access_token) throw new Error('OAuth token endpoint returned no access_token')
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in != null ? Date.now() + json.expires_in * 1000 : undefined,
    idToken: json.id_token,
    raw: json,
  }
}

/** Decode a JWT payload without verifying the signature (claims read-only). */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>
  } catch {
    return null
  }
}
