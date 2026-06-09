import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import * as realContacts from '@/server/services/contacts'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockGetSession: ReturnType<typeof mock>
let mockDbSelect: ReturnType<typeof mock>
let mockDbInsert: ReturnType<typeof mock>
let mockDbUpdate: ReturnType<typeof mock>
let mockValidateInvitation: ReturnType<typeof mock>
let mockMarkInvitationUsed: ReturnType<typeof mock>
let mockFindContactByLinkedUserId: ReturnType<typeof mock>
let mockCreateContact: ReturnType<typeof mock>

// Store inserted profiles in-memory to simulate DB state
let insertedProfiles: Array<{
  userId: string
  firstName: string
  lastName: string
  pseudonym: string
  language: string
  role: string
}>

// Track what the DB "contains" for select queries
let dbAdminProfile: Record<string, unknown> | null
let dbProviders: Array<{ capabilities: string }>
let dbExistingProfile: Record<string, unknown> | null

mock.module('@/server/auth/index', () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}))

// Mock DB with chainable query builders
mock.module('@/server/db/index', () => {
  const makeChain = (result: unknown) => {
    const chain: Record<string, unknown> = {}
    chain.from = mock(() => chain)
    chain.where = mock(() => chain)
    chain.set = mock(() => chain)
    chain.values = mock(() => chain)
    chain.get = mock(() => result)
    chain.all = mock(() => (Array.isArray(result) ? result : []))
    return chain
  }

  return {
    db: {
      select: (...args: unknown[]) => mockDbSelect(...args),
      insert: (...args: unknown[]) => mockDbInsert(...args),
      update: (...args: unknown[]) => mockDbUpdate(...args),
    },
    sqlite: {},
    initVirtualTables: () => {},
  }
})

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  userProfiles: { role: 'role', userId: 'user_id' },
  agents: { id: 'id', toolboxIds: 'toolboxIds' },
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

mock.module('@/server/services/contacts', () => ({
  ...realContacts,
  createContact: (...args: unknown[]) => mockCreateContact(...args),
  findContactByLinkedUserId: (...args: unknown[]) => mockFindContactByLinkedUserId(...args),
}))

mock.module('@/server/services/invitations', () => ({
  validateInvitation: (...args: unknown[]) => mockValidateInvitation(...args),
  markInvitationUsed: (...args: unknown[]) => mockMarkInvitationUsed(...args),
  createInvitation: () => ({}),
  buildInvitationUrl: () => '',
  listInvitations: () => [],
  revokeInvitation: () => ({ success: true }),
}))

// ─── Import after mocking ───────────────────────────────────────────────────

const { onboardingRoutes } = await import('@/server/routes/onboarding')

// ─── Test app factory ───────────────────────────────────────────────────────

function createTestApp() {
  const app = new Hono()
  app.route('/api/onboarding', onboardingRoutes)
  return app
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {}
  chain.from = mock(() => chain)
  chain.where = mock(() => chain)
  chain.set = mock(() => chain)
  chain.values = mock(() => chain)
  chain.get = mock(() => result)
  chain.all = mock(() => (Array.isArray(result) ? result : []))
  return chain
}

const fakeSession = {
  session: { id: 'sess-1', userId: 'user-1' },
  user: { id: 'user-1', name: 'Test User', email: 'test@example.com' },
}

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('onboarding routes', () => {
  let app: ReturnType<typeof createTestApp>

  beforeEach(() => {
    app = createTestApp()
    insertedProfiles = []
    dbAdminProfile = null
    dbProviders = []
    dbExistingProfile = null

    mockGetSession = mock(() => Promise.resolve(null))
    mockValidateInvitation = mock(() => ({ valid: true }))
    mockMarkInvitationUsed = mock(() => true)
    mockFindContactByLinkedUserId = mock(() => null)
    mockCreateContact = mock(() => Promise.resolve({ id: 'contact-1' }))

    // Default: select returns based on context
    // We use a call counter to differentiate successive select() calls
    let selectCallCount = 0
    mockDbSelect = mock(() => {
      selectCallCount++
      const callNum = selectCallCount
      // For GET /status: call 1 = admin check, call 2 = providers
      // For POST /profile: call 1 = session profile check, call 2 = admin check
      // We handle this per-test by resetting the mock
      return makeChain(null)
    })

    mockDbInsert = mock(() => makeChain(null))
    mockDbUpdate = mock(() => makeChain(null))
  })

  // ── GET /api/onboarding/status ──────────────────────────────────────────

  describe('GET /status', () => {
    it('returns all false when no admin and no providers', async () => {
      // select 1: admin check → null, select 2: providers → []
      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain(null) // no admin
        return makeChain([]) // no providers
      })

      const res = await app.request('/api/onboarding/status')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body).toEqual({
        completed: false,
        hasAdmin: false,
        hasLlm: false,
        hasEmbedding: false,
      })
    })

    it('returns completed=true when admin exists, regardless of providers', async () => {
      // Phase 1 of the onboarding redesign decoupled `completed` from
      // provider configuration — `completed` now mirrors `hasAdmin`.
      // Provider state stays in the response for informational use
      // (the dashboard checklist + Settings can surface it) but no
      // longer gates entry to the app.
      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain({ userId: 'u1', role: 'admin' })
        return makeChain([])
      })

      const res = await app.request('/api/onboarding/status')
      const body = await res.json()

      expect(body.hasAdmin).toBe(true)
      expect(body.hasLlm).toBe(false)
      expect(body.hasEmbedding).toBe(false)
      expect(body.completed).toBe(true)
    })

    it('returns completed=true when admin + llm + embedding providers exist', async () => {
      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain({ userId: 'u1', role: 'admin' })
        return makeChain([
          { capabilities: '["llm"]' },
          { capabilities: '["embedding"]' },
        ])
      })

      const res = await app.request('/api/onboarding/status')
      const body = await res.json()

      expect(body).toEqual({
        completed: true,
        hasAdmin: true,
        hasLlm: true,
        hasEmbedding: true,
      })
    })

    it('handles provider with multiple capabilities', async () => {
      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain({ userId: 'u1', role: 'admin' })
        return makeChain([
          { capabilities: '["llm","embedding"]' },
        ])
      })

      const res = await app.request('/api/onboarding/status')
      const body = await res.json()

      expect(body.completed).toBe(true)
      expect(body.hasLlm).toBe(true)
      expect(body.hasEmbedding).toBe(true)
    })

    it('skips providers with invalid JSON capabilities', async () => {
      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain({ userId: 'u1', role: 'admin' })
        return makeChain([
          { capabilities: 'not-json' },
          { capabilities: '["llm"]' },
        ])
      })

      const res = await app.request('/api/onboarding/status')
      const body = await res.json()

      expect(body.hasLlm).toBe(true)
      expect(body.hasEmbedding).toBe(false)
    })
  })

  // ── POST /api/onboarding/profile ────────────────────────────────────────

  describe('POST /profile', () => {
    it('returns 401 when not authenticated', async () => {
      mockGetSession = mock(() => Promise.resolve(null))

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
          pseudonym: 'johnd',
        }),
      )

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error.code).toBe('UNAUTHORIZED')
    })

    it('returns 409 when profile already exists', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))

      // select 1: existing profile check → found
      mockDbSelect = mock(() =>
        makeChain({ userId: 'user-1', firstName: 'Existing' }),
      )

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
          pseudonym: 'johnd',
        }),
      )

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error.code).toBe('PROFILE_EXISTS')
    })

    it('returns 400 when firstName is missing', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockDbSelect = mock(() => makeChain(null))

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          lastName: 'Doe',
          pseudonym: 'johnd',
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('allows a missing last name (now optional)', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockDbSelect = mock(() => makeChain(null))

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          pseudonym: 'johnd',
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.lastName).toBe('')
      expect(mockDbInsert).toHaveBeenCalled()
    })

    it('returns 400 when pseudonym is missing', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockDbSelect = mock(() => makeChain(null))

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
    })

    it('creates admin profile for first user (no admin exists)', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))

      // select 1: existing profile → null, select 2: admin check → null (first user)
      let call = 0
      mockDbSelect = mock(() => {
        call++
        return makeChain(null)
      })

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
          pseudonym: 'johnd',
          language: 'fr',
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body).toEqual({
        userId: 'user-1',
        firstName: 'John',
        lastName: 'Doe',
        pseudonym: 'johnd',
        language: 'fr',
        role: 'admin',
      })

      // Verify insert was called
      expect(mockDbInsert).toHaveBeenCalled()
      // Verify user table was updated
      expect(mockDbUpdate).toHaveBeenCalled()
      // Verify contact was created
      expect(mockCreateContact).toHaveBeenCalled()
    })

    it('defaults language to en when not provided', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockDbSelect = mock(() => makeChain(null))

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
          pseudonym: 'johnd',
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.language).toBe('en')
    })

    it('returns 403 when admin exists and no invitation token provided', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))

      // select 1: existing profile → null, select 2: admin check → found
      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain(null)
        return makeChain({ userId: 'admin-1', role: 'admin' })
      })

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'Jane',
          lastName: 'Doe',
          pseudonym: 'janed',
        }),
      )

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error.code).toBe('INVITATION_REQUIRED')
    })

    it('returns 400 when invitation token is invalid', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockValidateInvitation = mock(() => ({ valid: false, reason: 'EXPIRED' }))

      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain(null)
        return makeChain({ userId: 'admin-1', role: 'admin' })
      })

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'Jane',
          lastName: 'Doe',
          pseudonym: 'janed',
          invitationToken: 'bad-token',
        }),
      )

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('INVALID_INVITATION')
      expect(body.error.message).toContain('EXPIRED')
    })

    it('creates profile with valid invitation token', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockValidateInvitation = mock(() => ({ valid: true }))

      let call = 0
      mockDbSelect = mock(() => {
        call++
        if (call === 1) return makeChain(null)
        return makeChain({ userId: 'admin-1', role: 'admin' })
      })

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'Jane',
          lastName: 'Doe',
          pseudonym: 'janed',
          language: 'en',
          invitationToken: 'valid-token',
        }),
      )

      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.firstName).toBe('Jane')
      expect(body.role).toBe('admin')

      // Verify invitation was marked as used
      expect(mockMarkInvitationUsed).toHaveBeenCalledWith('valid-token', 'user-1')
    })

    it('does not create duplicate contact if one exists', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockFindContactByLinkedUserId = mock(() => ({ id: 'existing-contact' }))
      mockDbSelect = mock(() => makeChain(null))

      const res = await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
          pseudonym: 'johnd',
        }),
      )

      expect(res.status).toBe(201)
      expect(mockCreateContact).not.toHaveBeenCalled()
    })

    it('does not mark invitation as used when no token provided (first user)', async () => {
      mockGetSession = mock(() => Promise.resolve(fakeSession))
      mockDbSelect = mock(() => makeChain(null))

      await app.request(
        jsonRequest('/api/onboarding/profile', {
          firstName: 'John',
          lastName: 'Doe',
          pseudonym: 'johnd',
        }),
      )

      expect(mockMarkInvitationUsed).not.toHaveBeenCalled()
    })
  })
})
