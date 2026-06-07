/**
 * Public-URL misconfiguration detection.
 *
 * Absolute links Hivekeep builds — invitation links, channel webhooks, OAuth
 * callbacks, the CORS/Better-Auth allowlist — are derived from the configured
 * `PUBLIC_URL`. When the browser reaches the app at a different origin than the
 * one configured (and it isn't local access), those links point at the wrong
 * host and silently break. This compares the two origins so the UI can warn.
 */
export function getPublicUrlMismatch(
  publicUrl: string | null | undefined,
): { actual: string; configured: string } | null {
  if (!publicUrl || typeof window === 'undefined') return null

  let configured: string
  try {
    configured = new URL(publicUrl).origin
  } catch {
    return null
  }

  const actual = window.location.origin

  // Local access is the "just trying it on my machine" case — nothing to warn
  // about, and invites to localhost wouldn't reach anyone else anyway.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(actual)) return null

  if (configured === actual) return null
  return { actual, configured }
}
