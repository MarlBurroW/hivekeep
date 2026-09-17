import type { Context, Next } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { userProfiles } from '@/server/db/schema'

/**
 * Route guard: rejects with 403 unless the authenticated user's profile has
 * the admin role. Must run after authMiddleware (it reads c.get('user')).
 * Internal-actor and external-API requests resolve to a real user id, so the
 * profile lookup applies to them too.
 */
export async function requireAdmin(c: Context, next: Next) {
  const currentUser = c.get('user') as { id: string } | undefined
  const profile = currentUser
    ? db
        .select({ role: userProfiles.role })
        .from(userProfiles)
        .where(eq(userProfiles.userId, currentUser.id))
        .get()
    : undefined

  if (!profile || profile.role !== 'admin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403)
  }
  return next()
}
