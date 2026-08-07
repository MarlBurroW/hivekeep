import { Hono } from 'hono'
import { db } from '@/server/db/index'
import { user, userProfiles, session, account, contacts, agents } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:users')

const userRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/users/mentionables — combined list of users + agents for @mention autocomplete
userRoutes.get('/mentionables', async (c) => {
  const [users, agentList] = await Promise.all([
    db.select({
      id: user.id,
      pseudonym: userProfiles.pseudonym,
      firstName: userProfiles.firstName,
      avatarUrl: user.image,
    })
    .from(user)
    .innerJoin(userProfiles, eq(user.id, userProfiles.userId))
    .all(),
    db.select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      avatarPath: agents.avatarPath,
    })
    .from(agents)
    .all(),
  ])

  return c.json({
    users: users.map((u) => ({
      id: u.id,
      pseudonym: u.pseudonym,
      firstName: u.firstName,
      avatarUrl: u.avatarUrl,
    })),
    agents: agentList.map((k) => ({
      id: k.id,
      slug: k.slug,
      name: k.name,
      avatarUrl: k.avatarPath
        ? `/api/uploads/agents/${k.id}/avatar.${k.avatarPath.split('.').pop() ?? 'png'}`
        : null,
    })),
  })
})

// GET /api/users — list all users with full profile data (admin-only:
// exposes every member's email and role)
userRoutes.get('/', requireAdmin, async (c) => {
  const users = db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      firstName: userProfiles.firstName,
      lastName: userProfiles.lastName,
      pseudonym: userProfiles.pseudonym,
      language: userProfiles.language,
      role: userProfiles.role,
      avatarUrl: user.image,
      createdAt: user.createdAt,
    })
    .from(user)
    .innerJoin(userProfiles, eq(user.id, userProfiles.userId))
    .all()

  return c.json({ users })
})

// PATCH /api/users/:id/role — change a user's role (admin-only). Changing
// your own role is rejected, which guarantees at least one admin remains.
userRoutes.patch('/:id/role', requireAdmin, async (c) => {
  const targetId = c.req.param('id')
  if (!targetId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'User id is required' } }, 400)
  }
  const currentUser = c.get('user')
  if (targetId === currentUser.id) {
    return c.json({ error: { code: 'CANNOT_CHANGE_OWN_ROLE', message: 'You cannot change your own role' } }, 400)
  }
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const role = (body as Record<string, unknown>).role
  if (role !== 'admin' && role !== 'member') {
    return c.json({ error: { code: 'INVALID_ROLE', message: "role must be 'admin' or 'member'" } }, 400)
  }
  const profile = db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, targetId))
    .get()
  if (!profile) {
    return c.json({ error: { code: 'USER_NOT_FOUND', message: 'User not found' } }, 404)
  }
  await db.update(userProfiles).set({ role }).where(eq(userProfiles.userId, targetId))
  log.info({ targetId, role }, 'User role updated')
  return c.json({ success: true })
})

// DELETE /api/users/:id — delete a user account
userRoutes.delete('/:id', async (c) => {
  const targetId = c.req.param('id')
  const currentUser = c.get('user')

  // Only admins can delete users
  const currentProfile = db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, currentUser.id))
    .get()

  if (!currentProfile || currentProfile.role !== 'admin') {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'Only admins can delete users' } },
      403,
    )
  }

  // Cannot delete yourself
  if (targetId === currentUser.id) {
    return c.json(
      { error: { code: 'CANNOT_DELETE_SELF', message: 'You cannot delete your own account' } },
      400,
    )
  }

  // Check target user exists
  const target = db.select().from(user).where(eq(user.id, targetId)).get()
  if (!target) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'User not found' } },
      404,
    )
  }

  // Cascade delete in order to avoid FK violations
  // 1. Delete sessions
  db.delete(session).where(eq(session.userId, targetId)).run()
  // 2. Delete accounts
  db.delete(account).where(eq(account.userId, targetId)).run()
  // 3. Unlink contacts (don't delete them — Agents still know this person)
  db.update(contacts).set({ linkedUserId: null }).where(eq(contacts.linkedUserId, targetId)).run()
  // 4. Delete user profile
  db.delete(userProfiles).where(eq(userProfiles.userId, targetId)).run()
  // 5. Delete user record
  db.delete(user).where(eq(user.id, targetId)).run()

  log.info({ deletedUserId: targetId, deletedBy: currentUser.id }, 'User deleted')

  return c.json({ success: true })
})

export { userRoutes }
