import type { Context, Next } from 'hono'
import { createLogger } from '@/server/logger'

const log = createLogger('mini-app-guard')

/**
 * Defense-in-depth: keep a mini-app iframe's requests inside its own namespace.
 *
 * Mini-app iframes are served same-origin with `allow-same-origin`, so their JS
 * carries the user's session cookie to ANY `/api/*` path — meaning an app could
 * call `/api/contacts`, `/api/vault/...` etc. directly, bypassing the per-app
 * permission model. This guard inspects the `Referer`: a request that originated
 * inside `/api/mini-apps/<id>/(serve|static)` may only target that same app's
 * namespace (`/api/mini-apps/<id>/*`) or the shared SDK assets — anything else
 * is rejected.
 *
 * LIMITATION (documented): a hostile app can suppress its Referer
 * (`referrerPolicy: no-referrer`) and evade this. The complete barrier is to
 * stop relying on the session cookie inside the iframe (scoped token + dropping
 * `allow-same-origin`); this guard is the non-breaking first layer that closes
 * the accidental/naive path and sandboxes well-behaved apps.
 */

/** Match the iframe entry/asset paths that identify a mini-app origin. */
const MINI_APP_REFERER_RE = /\/api\/mini-apps\/([^/]+)\/(?:serve|static)\b/

/**
 * Decide whether a request is allowed, given the referer and the target path.
 * Pure for testing. Returns the violating appId when blocked, or null to allow.
 */
export function classifyMiniAppRequest(referer: string | undefined, targetPath: string): { blocked: false } | { blocked: true; appId: string } {
  if (!referer) return { blocked: false }

  let refPath: string
  try {
    refPath = new URL(referer).pathname
  } catch {
    // Referer that isn't a full URL — can't classify, let auth handle it.
    return { blocked: false }
  }

  const match = MINI_APP_REFERER_RE.exec(refPath)
  if (!match) return { blocked: false }

  const appId = match[1]!
  const allowed =
    targetPath.startsWith(`/api/mini-apps/${appId}/`) ||
    targetPath.startsWith('/api/mini-apps/sdk/')
  return allowed ? { blocked: false } : { blocked: true, appId }
}

/**
 * Hono middleware enforcing the rule above on `/api/*`. Mounted before auth so a
 * scope violation is rejected regardless of the (valid) session.
 */
export async function miniAppOriginGuard(c: Context, next: Next) {
  const path = c.req.path
  if (!path.startsWith('/api/')) return next()

  const verdict = classifyMiniAppRequest(c.req.header('referer'), path)
  if (verdict.blocked) {
    log.warn({ appId: verdict.appId, path, method: c.req.method }, 'Blocked cross-namespace request from a mini-app iframe')
    return c.json(
      {
        error: {
          code: 'MINIAPP_SCOPE_VIOLATION',
          message: 'A mini-app may only call its own /api/mini-apps/<id>/* namespace. Use Hivekeep.platform / ctx.platform (gated) to reach platform resources.',
        },
      },
      403,
    )
  }
  return next()
}
