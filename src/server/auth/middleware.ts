import type { Context, Next } from 'hono'
import { eq } from 'drizzle-orm'
import { auth } from '@/server/auth/index'
import { db } from '@/server/db/index'
import { userProfiles } from '@/server/db/schema'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('auth')

/**
 * Hono middleware that verifies the session on all /api/* routes
 * except /api/auth/* and /api/onboarding/*.
 *
 * Additionally, authenticated users without a user profile are blocked
 * from accessing any route beyond auth/onboarding. This prevents the
 * open sign-up endpoint from granting access to the workspace without
 * a valid invitation (profile creation requires an invitation token
 * when an admin already exists).
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = c.req.path

  // CORS preflight is never authenticated (no credentials are sent on it).
  if (c.req.method === 'OPTIONS') return next()

  // Skip auth for Better Auth routes, onboarding, health check, and the public
  // mini-app SDK assets (loaded by the opaque-origin iframe without credentials).
  if (path.startsWith('/api/auth/') || path.startsWith('/api/onboarding') || path === '/api/health' || path.startsWith('/api/mini-apps/sdk/') || path.startsWith('/s/') || path.startsWith('/api/webhooks/incoming/') || path.startsWith('/api/plugin-hooks/') || path.startsWith('/api/channels/telegram/') || path.startsWith('/api/channels/slack/') || path.startsWith('/api/channels/whatsapp/') || path.startsWith('/api/channels/signal/') || path.startsWith('/api/channels/plugin/') || /^\/api\/invitations\/[^/]+\/validate$/.test(path)) {
    return next()
  }

  // Skip auth for non-API routes
  if (!path.startsWith('/api/')) {
    return next()
  }

  // Internal re-dispatch actor (e.g. the platform gateway calling a REST route
  // server-side). This header is stripped from ALL inbound network requests at
  // the Bun.serve edge (see main.ts), so it can only be set in-process.
  const internalActor = c.req.header('x-hivekeep-internal-actor')
  if (internalActor) {
    c.set('user', { id: internalActor, name: '', email: '' } as never)
    c.set('session', { id: 'internal', userId: internalActor, token: 'internal' } as never)
    return next()
  }

  // External API: /api/v1/* has its own bearer scheme (NOT a cookie session and
  // NOT an auth exemption). Resolve the key to its client, enforce the per-client
  // rate limit, and run as the client's owner user.
  if (path.startsWith('/api/v1/')) {
    if (!config.externalApi.enabled) {
      return c.json({ error: { code: 'EXTERNAL_API_DISABLED', message: 'The external API is disabled' } }, 403)
    }
    const authz = c.req.header('authorization')
    const token = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined
    if (!token) {
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing bearer API key' } }, 401)
    }
    // Lazily imported (like the mini-app-token resolver above) so this module
    // does not statically pull the external-api schema tables — keeps suites
    // that stub the schema module to a subset from failing to link.
    const { resolveApiKeyToken, consumeRateLimit } = await import('@/server/services/external-api')
    const resolved = await resolveApiKeyToken(token)
    if (!resolved.ok) {
      const messages = {
        UNAUTHORIZED: 'Invalid API key',
        API_KEY_REVOKED: 'This API key has been revoked',
        CLIENT_DISABLED: 'This API client is disabled',
      } as const
      return c.json({ error: { code: resolved.code, message: messages[resolved.code] } }, resolved.status)
    }
    const limit = resolved.client.rateLimitPerMin ?? config.externalApi.defaultRateLimitPerMinute
    if (!consumeRateLimit(resolved.client.id, limit)) {
      c.header('Retry-After', '60')
      return c.json({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } }, 429)
    }
    c.set('user', { id: resolved.client.ownerUserId, name: '', email: '' } as never)
    c.set('session', { id: 'external-api', userId: resolved.client.ownerUserId, token: 'external-api' } as never)
    c.set('apiClient', resolved.client)
    return next()
  }

  // Mini-app iframe token: authorizes ONLY that app's own namespace. The opaque
  // iframe has no cookie, so this is how its SDK reaches /api/mini-apps/<id>/*.
  const miniAppMatch = /^\/api\/mini-apps\/([^/]+)(\/|$)/.exec(path)
  if (miniAppMatch) {
    const token = c.req.header('x-hivekeep-app-token') ?? c.req.query('_t')
    if (token) {
      const { resolveAppToken, isMiniAppTokenPathAllowed } = await import('@/server/services/mini-app-token')
      const resolved = resolveAppToken(token)
      if (resolved && resolved.appId === miniAppMatch[1]) {
        // The token is readable by the app's own JS, so it only unlocks the
        // runtime SDK surface — file writes, permission grants and app CRUD
        // require the parent's cookie session.
        if (!isMiniAppTokenPathAllowed(c.req.method, path, resolved.appId)) {
          return c.json(
            { error: { code: 'FORBIDDEN', message: 'This endpoint requires a signed-in session' } },
            403,
          )
        }
        c.set('user', { id: resolved.userId, name: '', email: '' } as never)
        c.set('session', { id: 'mini-app', userId: resolved.userId, token: 'mini-app' } as never)
        return next()
      }
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired mini-app token' } }, 401)
    }
    // No token: fall through to cookie auth (covers the parent app's own calls
    // to /api/mini-apps/* and the /serve navigation, which still carry the cookie).
  }

  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!session) {
    // SSE 401s are noisy by design: stale browser tabs auto-reconnect every
    // ~3s after session expiry until their circuit breaker trips. Log at debug
    // so they don't drown legitimate auth warnings.
    if (path === '/api/sse') {
      log.debug({ path, method: c.req.method }, 'Unauthorized SSE reconnect — session expired')
    } else {
      log.warn({ path, method: c.req.method }, 'Unauthorized request — no valid session')
    }
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      401,
    )
  }

  // Verify the user has a profile (invitation-gated).
  // Without this check, anyone who signs up via the open Better Auth
  // endpoint would get a valid session and access to all protected routes.
  const profile = await db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, session.user.id))
    .get()

  if (!profile) {
    log.warn({ path, userId: session.user.id }, 'Authenticated user has no profile — access denied')
    return c.json(
      { error: { code: 'PROFILE_REQUIRED', message: 'Account setup incomplete. Please complete onboarding.' } },
      403,
    )
  }

  // Attach session to context for downstream handlers
  c.set('session', session.session)
  c.set('user', session.user)

  return next()
}
