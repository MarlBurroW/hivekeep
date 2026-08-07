/**
 * Mini-app iframe tokens.
 *
 * The hardened iframe runs at an OPAQUE origin (sandbox without
 * `allow-same-origin`), so the user's session cookie never reaches its JS — it
 * therefore cannot call `/api/*` with the user's identity at all. To let the app
 * reach its OWN namespace (`/api/mini-apps/<id>/*`), the `/serve` route (which is
 * still loaded with the cookie via iframe navigation) mints a short-lived token
 * bound to (appId, userId) and injects it into the document. The SDK sends it as
 * the `x-hivekeep-app-token` header (or `?_t=` for the EventSource, which can't
 * set headers). authMiddleware accepts it ONLY for that app's namespace.
 *
 * In-memory + TTL: tokens are ephemeral (a fresh one is minted on every iframe
 * load), so losing them on restart just means open iframes re-mint on reload.
 */

import { randomBytes } from 'crypto'

interface AppTokenEntry {
  appId: string
  userId: string
  expiresAt: number
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000 // 12h — re-minted on every iframe load
const tokens = new Map<string, AppTokenEntry>()

/** Mint a token for (appId, userId). Returns the opaque token string. */
export function mintAppToken(appId: string, userId: string): string {
  const token = randomBytes(32).toString('base64url')
  tokens.set(token, { appId, userId, expiresAt: Date.now() + TOKEN_TTL_MS })
  // Opportunistic cleanup so the map can't grow unbounded across reloads.
  if (tokens.size > 5000) {
    const now = Date.now()
    for (const [t, e] of tokens) if (e.expiresAt < now) tokens.delete(t)
  }
  return token
}

/** Resolve a token to its (appId, userId), or null if unknown/expired. */
export function resolveAppToken(token: string): { appId: string; userId: string } | null {
  const entry = tokens.get(token)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token)
    return null
  }
  return { appId: entry.appId, userId: entry.userId }
}

/**
 * Endpoint allowlist for app-token requests. The token is readable by the
 * app's own (untrusted) JS, so it must only unlock the runtime SDK surface.
 * Without this, app JS could PUT its own `_server.js` (the backend is
 * import()ed into the server process) or POST /permissions to self-grant
 * everything its app.json requested — the approval model would be advisory.
 * File writes, permission grants, snapshots, console reads and app CRUD stay
 * cookie-session-only.
 */
export function isMiniAppTokenPathAllowed(method: string, path: string, appId: string): boolean {
  const prefix = `/api/mini-apps/${appId}`
  if (!path.startsWith(prefix)) return false
  const rest = path.slice(prefix.length) || '/'

  // The app's own backend API + platform proxy accept any method (both are
  // permission-gated downstream).
  if (rest.startsWith('/api/') || rest === '/api' || rest.startsWith('/platform/')) return true
  // Per-app storage is the SDK's read-write surface.
  if (rest === '/storage' || rest.startsWith('/storage/')) return true

  if (method === 'GET') {
    return (
      rest === '/files' ||
      rest.startsWith('/files/') ||
      rest === '/memories/search' ||
      rest === '/events' ||
      rest === '/permissions' ||
      rest === '/serve' ||
      rest.startsWith('/static/')
    )
  }
  if (method === 'POST') {
    return rest === '/http' || rest === '/memories' || rest === '/client-event' || rest === '/console'
  }
  return false
}
