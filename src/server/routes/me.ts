import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { userProfiles, user } from '@/server/db/schema'
import { getUnreadCountsForUser } from '@/server/services/kin-read-state'
import { THEME_MODES, CONTRAST_MODES, PALETTE_IDS } from '@/shared/constants'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import { sseManager } from '@/server/sse/index'

const log = createLogger('routes:me')
const meRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/me — get current user profile
meRoutes.get('/', async (c) => {
  const sessionUser = c.get('user') as { id: string }

  const profile = await db
    .select({
      id: user.id,
      email: user.email,
      firstName: userProfiles.firstName,
      lastName: userProfiles.lastName,
      pseudonym: userProfiles.pseudonym,
      language: userProfiles.language,
      role: userProfiles.role,
      avatarUrl: user.image,
      kinOrder: userProfiles.kinOrder,
      cronOrder: userProfiles.cronOrder,
      onboardingModalDismissed: userProfiles.onboardingModalDismissed,
      theme: userProfiles.theme,
      palette: userProfiles.palette,
      contrastMode: userProfiles.contrastMode,
      createdAt: user.createdAt,
    })
    .from(user)
    .leftJoin(userProfiles, eq(user.id, userProfiles.userId))
    .where(eq(user.id, sessionUser.id))
    .get()

  if (!profile) {
    return c.json(
      { error: { code: 'USER_NOT_FOUND', message: 'User not found' } },
      404,
    )
  }

  return c.json({
    ...profile,
    onboardingModalDismissed: profile.onboardingModalDismissed ?? false,
    createdAt: profile.createdAt instanceof Date ? profile.createdAt.getTime() : profile.createdAt,
    serverTimezone: config.timezone,
  })
})

// PATCH /api/me — update current user profile
meRoutes.patch('/', async (c) => {
  const sessionUser = c.get('user') as { id: string }
  const body = await c.req.json()

  // Input validation
  const SUPPORTED_LANGUAGES = ['en', 'fr', 'de']
  const MAX_NAME_LENGTH = 100
  const MAX_PSEUDONYM_LENGTH = 30
  const PSEUDONYM_REGEX = /^[a-zA-Z0-9_-]+$/

  const errors: string[] = []

  if (body.firstName !== undefined) {
    if (typeof body.firstName !== 'string') errors.push('firstName must be a string')
    else body.firstName = body.firstName.trim()
    if (typeof body.firstName === 'string' && body.firstName.length > MAX_NAME_LENGTH) errors.push(`firstName must be under ${MAX_NAME_LENGTH} characters`)
  }
  if (body.lastName !== undefined) {
    if (typeof body.lastName !== 'string') errors.push('lastName must be a string')
    else body.lastName = body.lastName.trim()
    if (typeof body.lastName === 'string' && body.lastName.length > MAX_NAME_LENGTH) errors.push(`lastName must be under ${MAX_NAME_LENGTH} characters`)
  }
  if (body.pseudonym !== undefined) {
    if (typeof body.pseudonym !== 'string') errors.push('pseudonym must be a string')
    else body.pseudonym = body.pseudonym.trim()
    if (typeof body.pseudonym === 'string' && body.pseudonym.length > MAX_PSEUDONYM_LENGTH) errors.push(`pseudonym must be under ${MAX_PSEUDONYM_LENGTH} characters`)
    if (typeof body.pseudonym === 'string' && body.pseudonym.length > 0 && !PSEUDONYM_REGEX.test(body.pseudonym)) errors.push('pseudonym can only contain letters, numbers, underscores, and hyphens')
  }
  if (body.language !== undefined) {
    if (!SUPPORTED_LANGUAGES.includes(body.language)) errors.push(`language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)
  }
  if (body.onboardingModalDismissed !== undefined) {
    if (typeof body.onboardingModalDismissed !== 'boolean') errors.push('onboardingModalDismissed must be a boolean')
  }
  // Appearance preferences (null clears the saved value → client default).
  if (body.theme !== undefined && body.theme !== null) {
    if (!(THEME_MODES as readonly string[]).includes(body.theme)) errors.push(`theme must be one of: ${THEME_MODES.join(', ')}`)
  }
  if (body.palette !== undefined && body.palette !== null) {
    if (!(PALETTE_IDS as readonly string[]).includes(body.palette)) errors.push('palette must be a valid palette id')
  }
  if (body.contrastMode !== undefined && body.contrastMode !== null) {
    if (!(CONTRAST_MODES as readonly string[]).includes(body.contrastMode)) errors.push(`contrastMode must be one of: ${CONTRAST_MODES.join(', ')}`)
  }
  if (body.kinOrder !== undefined) {
    if (!Array.isArray(body.kinOrder) || !body.kinOrder.every((id: unknown) => typeof id === 'string')) {
      errors.push('kinOrder must be an array of strings')
    } else if (body.kinOrder.length > 200) {
      errors.push('kinOrder exceeds maximum length')
    }
  }
  if (body.cronOrder !== undefined) {
    if (!Array.isArray(body.cronOrder) || !body.cronOrder.every((id: unknown) => typeof id === 'string')) {
      errors.push('cronOrder must be an array of strings')
    } else if (body.cronOrder.length > 200) {
      errors.push('cronOrder exceeds maximum length')
    }
  }

  if (errors.length > 0) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: errors.join('; ') } },
      400,
    )
  }

  const updates: Record<string, unknown> = {}
  if (body.firstName !== undefined) updates.firstName = body.firstName
  if (body.lastName !== undefined) updates.lastName = body.lastName
  if (body.pseudonym !== undefined) updates.pseudonym = body.pseudonym
  if (body.language !== undefined) updates.language = body.language
  if (body.kinOrder !== undefined) updates.kinOrder = body.kinOrder
  if (body.cronOrder !== undefined) updates.cronOrder = body.cronOrder
  if (body.onboardingModalDismissed !== undefined) updates.onboardingModalDismissed = body.onboardingModalDismissed
  if (body.theme !== undefined) updates.theme = body.theme
  if (body.palette !== undefined) updates.palette = body.palette
  if (body.contrastMode !== undefined) updates.contrastMode = body.contrastMode

  if (Object.keys(updates).length > 0) {
    // Use upsert to handle the case where the profile row doesn't exist yet
    // (e.g. user created via auth but onboarding profile step was skipped)
    await db
      .insert(userProfiles)
      .values({
        userId: sessionUser.id,
        firstName: body.firstName ?? '',
        lastName: body.lastName ?? '',
        pseudonym: body.pseudonym ?? '',
        language: body.language ?? 'en',
        ...updates,
      })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: updates,
      })
  }

  // Update name in Better Auth user table
  if (body.firstName !== undefined || body.lastName !== undefined) {
    const profile = await db
      .select({ firstName: userProfiles.firstName, lastName: userProfiles.lastName })
      .from(userProfiles)
      .where(eq(userProfiles.userId, sessionUser.id))
      .get()

    if (profile) {
      await db
        .update(user)
        .set({ name: `${profile.firstName} ${profile.lastName}`, updatedAt: new Date() })
        .where(eq(user.id, sessionUser.id))
    }
  }

  log.debug({ userId: sessionUser.id, updatedFields: Object.keys(updates) }, 'Profile updated')

  // Notify all of this user's connected tabs/devices when kinOrder or cronOrder
  // changes, so a reorder in one tab is immediately reflected in others without
  // requiring a manual refresh.
  if (updates.kinOrder !== undefined || updates.cronOrder !== undefined) {
    sseManager.sendToUser(sessionUser.id, {
      type: 'profile:updated',
      data: {
        ...(updates.kinOrder !== undefined && { kinOrder: updates.kinOrder }),
        ...(updates.cronOrder !== undefined && { cronOrder: updates.cronOrder }),
      },
    })
  }

  // Return updated profile
  const updated = await db
    .select({
      id: user.id,
      email: user.email,
      firstName: userProfiles.firstName,
      lastName: userProfiles.lastName,
      pseudonym: userProfiles.pseudonym,
      language: userProfiles.language,
      role: userProfiles.role,
      avatarUrl: user.image,
      kinOrder: userProfiles.kinOrder,
      cronOrder: userProfiles.cronOrder,
      theme: userProfiles.theme,
      palette: userProfiles.palette,
      contrastMode: userProfiles.contrastMode,
      createdAt: user.createdAt,
    })
    .from(user)
    .leftJoin(userProfiles, eq(user.id, userProfiles.userId))
    .where(eq(user.id, sessionUser.id))
    .get()

  return c.json(updated ? {
    ...updated,
    createdAt: updated.createdAt instanceof Date ? updated.createdAt.getTime() : updated.createdAt,
  } : updated)
})

// POST /api/me/avatar — upload avatar
meRoutes.post('/avatar', async (c) => {
  const sessionUser = c.get('user') as { id: string }
  const body = await c.req.parseBody()
  const file = body['file']

  if (!file || !(file instanceof File)) {
    return c.json(
      { error: { code: 'INVALID_FILE', message: 'No file provided' } },
      400,
    )
  }

  // Safety-net file size limit (client already crops to 512x512 JPEG ~50-150KB)
  const MAX_AVATAR_SIZE = 2 * 1024 * 1024
  if (file.size > MAX_AVATAR_SIZE) {
    return c.json(
      { error: { code: 'FILE_TOO_LARGE', message: 'Avatar must be under 2MB' } },
      400,
    )
  }

  // Validate file type
  const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp']
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return c.json(
      { error: { code: 'INVALID_FILE_TYPE', message: 'Avatar must be PNG, JPEG, GIF, or WebP' } },
      400,
    )
  }

  // Store avatar in data/uploads/avatars/
  const { config } = await import('@/server/config')
  const { mkdirSync, existsSync } = await import('fs')
  const avatarDir = `${config.upload.dir}/avatars`
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true })
  }

  const rawExt = (file.name.split('.').pop() ?? '').toLowerCase()
  const ext = ALLOWED_EXTENSIONS.includes(rawExt) ? rawExt : 'png'
  const filename = `${sessionUser.id}.${ext}`
  const filePath = `${avatarDir}/${filename}`
  const buffer = await file.arrayBuffer()
  await Bun.write(filePath, buffer)

  const avatarUrl = `/api/uploads/avatars/${filename}?v=${Date.now()}`

  await db
    .update(user)
    .set({ image: avatarUrl, updatedAt: new Date() })
    .where(eq(user.id, sessionUser.id))

  return c.json({ avatarUrl })
})

// GET /api/me/unread-counts — per-Kin unread assistant message counts for the current user
meRoutes.get('/unread-counts', async (c) => {
  const sessionUser = c.get('user') as { id: string }
  const counts = getUnreadCountsForUser(sessionUser.id)
  return c.json({ counts })
})

export { meRoutes }
