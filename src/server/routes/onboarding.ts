import { Hono } from 'hono'
import { db } from '@/server/db/index'
import { userProfiles, providers, user } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import { auth } from '@/server/auth/index'
import { createLogger } from '@/server/logger'
import { createContact, findContactByLinkedUserId } from '@/server/services/contacts'
import { validateInvitation, markInvitationUsed } from '@/server/services/invitations'
import { SUPPORTED_LANGUAGES } from '@/shared/constants'

const log = createLogger('routes:onboarding')
const onboardingRoutes = new Hono()

// GET /api/onboarding/status — check if onboarding is complete
onboardingRoutes.get('/status', async (c) => {
  // Check if an admin user exists
  const admin = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.role, 'admin'))
    .get()

  const hasAdmin = !!admin

  // Check provider capabilities
  const allProviders = await db.select().from(providers).all()

  let hasLlm = false
  let hasEmbedding = false

  for (const provider of allProviders) {
    try {
      const capabilities = JSON.parse(provider.capabilities) as string[]
      if (capabilities.includes('llm')) hasLlm = true
      if (capabilities.includes('embedding')) hasEmbedding = true
    } catch {
      // Skip invalid JSON
    }
  }

  const completed = hasAdmin && hasLlm && hasEmbedding

  return c.json({ completed, hasAdmin, hasLlm, hasEmbedding })
})

// POST /api/onboarding/profile — create user profile during onboarding
onboardingRoutes.post('/profile', async (c) => {
  // Verify session manually (onboarding routes skip auth middleware)
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  })

  if (!session) {
    return c.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      401,
    )
  }

  const userId = session.user.id

  // Check if profile already exists
  const existing = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .get()

  if (existing) {
    return c.json(
      { error: { code: 'PROFILE_EXISTS', message: 'Profile already exists' } },
      409,
    )
  }

  const body = await c.req.json()
  const { firstName, lastName, pseudonym, language, invitationToken } = body as {
    firstName: string
    lastName: string
    pseudonym: string
    language: string
    invitationToken?: string
  }

  if (!firstName || !lastName || !pseudonym) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'firstName, lastName, and pseudonym are required' } },
      400,
    )
  }

  // Validate and sanitize fields (same rules as PATCH /api/me)
  const MAX_NAME_LENGTH = 100
  const MAX_PSEUDONYM_LENGTH = 30
  const PSEUDONYM_REGEX = /^[a-zA-Z0-9_-]+$/

  const trimmedFirstName = String(firstName).trim()
  const trimmedLastName = String(lastName).trim()
  const trimmedPseudonym = String(pseudonym).trim()

  const validationErrors: string[] = []

  if (!trimmedFirstName) validationErrors.push('firstName cannot be empty')
  if (trimmedFirstName.length > MAX_NAME_LENGTH) validationErrors.push(`firstName must be under ${MAX_NAME_LENGTH} characters`)
  if (!trimmedLastName) validationErrors.push('lastName cannot be empty')
  if (trimmedLastName.length > MAX_NAME_LENGTH) validationErrors.push(`lastName must be under ${MAX_NAME_LENGTH} characters`)
  if (!trimmedPseudonym || trimmedPseudonym.length < 2) validationErrors.push('pseudonym must be at least 2 characters')
  if (trimmedPseudonym.length > MAX_PSEUDONYM_LENGTH) validationErrors.push(`pseudonym must be under ${MAX_PSEUDONYM_LENGTH} characters`)
  if (trimmedPseudonym.length > 0 && !PSEUDONYM_REGEX.test(trimmedPseudonym)) validationErrors.push('pseudonym can only contain letters, numbers, underscores, and hyphens')
  if (language && !SUPPORTED_LANGUAGES.includes(language as typeof SUPPORTED_LANGUAGES[number])) validationErrors.push(`language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`)

  if (validationErrors.length > 0) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: validationErrors.join('; ') } },
      400,
    )
  }

  // Check if this is the first user or an invited user
  const adminExists = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.role, 'admin'))
    .get()

  // If not the first user, require a valid invitation token
  if (adminExists && invitationToken) {
    const validation = validateInvitation(invitationToken)
    if (!validation.valid) {
      return c.json(
        { error: { code: 'INVALID_INVITATION', message: `Invalid invitation: ${validation.reason}` } },
        400,
      )
    }
  } else if (adminExists && !invitationToken) {
    return c.json(
      { error: { code: 'INVITATION_REQUIRED', message: 'An invitation token is required to create an account' } },
      403,
    )
  }

  // All users are admin
  const role = 'admin'

  await db.insert(userProfiles).values({
    userId,
    firstName: trimmedFirstName,
    lastName: trimmedLastName,
    pseudonym: trimmedPseudonym,
    language: language || 'en',
    role,
  })

  // Update name in Better Auth user table
  await db
    .update(user)
    .set({ name: `${trimmedFirstName} ${trimmedLastName}`, updatedAt: new Date() })
    .where(eq(user.id, userId))

  // Auto-create a contact for this user
  const existingContact = findContactByLinkedUserId(userId)
  if (!existingContact) {
    const userEmail = session.user.email
    const result = await createContact({
      firstName: trimmedFirstName,
      lastName: trimmedLastName,
      nicknames: trimmedPseudonym ? [trimmedPseudonym] : undefined,
      linkedUserId: userId,
      identifiers: userEmail ? [{ label: 'email', value: userEmail }] : undefined,
    })
    if ('error' in result) {
      log.warn({ userId }, 'User already linked to a contact during onboarding')
    }
  }

  // Mark invitation as used if provided
  if (invitationToken) {
    markInvitationUsed(invitationToken, userId)
  }

  log.info({ userId, role, pseudonym: trimmedPseudonym }, 'Onboarding completed')

  return c.json({
    userId,
    firstName: trimmedFirstName,
    lastName: trimmedLastName,
    pseudonym: trimmedPseudonym,
    language: language || 'en',
    role,
  }, 201)
})

export { onboardingRoutes }
