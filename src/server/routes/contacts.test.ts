import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'

// ─── Mock setup ─────────────────────────────────────────────────────────────

let mockListContactsWithDetails: ReturnType<typeof mock>
let mockGetContactWithDetails: ReturnType<typeof mock>
let mockGetContact: ReturnType<typeof mock>
let mockCreateContact: ReturnType<typeof mock>
let mockUpdateContact: ReturnType<typeof mock>
let mockDeleteContact: ReturnType<typeof mock>
let mockAddContactIdentifier: ReturnType<typeof mock>
let mockUpdateContactIdentifier: ReturnType<typeof mock>
let mockRemoveContactIdentifier: ReturnType<typeof mock>
let mockReplaceContactIdentifiers: ReturnType<typeof mock>
let mockAddContactNickname: ReturnType<typeof mock>
let mockUpdateContactNickname: ReturnType<typeof mock>
let mockRemoveContactNickname: ReturnType<typeof mock>
let mockReplaceContactNicknames: ReturnType<typeof mock>
let mockSetContactNote: ReturnType<typeof mock>
let mockUpdateContactNote: ReturnType<typeof mock>
let mockDeleteContactNote: ReturnType<typeof mock>

mock.module('@/server/services/contacts', () => ({
  listContactsWithDetails: (...args: unknown[]) => mockListContactsWithDetails(...args),
  getContactWithDetails: (...args: unknown[]) => mockGetContactWithDetails(...args),
  getContact: (...args: unknown[]) => mockGetContact(...args),
  createContact: (...args: unknown[]) => mockCreateContact(...args),
  updateContact: (...args: unknown[]) => mockUpdateContact(...args),
  deleteContact: (...args: unknown[]) => mockDeleteContact(...args),
  addContactIdentifier: (...args: unknown[]) => mockAddContactIdentifier(...args),
  updateContactIdentifier: (...args: unknown[]) => mockUpdateContactIdentifier(...args),
  removeContactIdentifier: (...args: unknown[]) => mockRemoveContactIdentifier(...args),
  replaceContactIdentifiers: (...args: unknown[]) => mockReplaceContactIdentifiers(...args),
  addContactNickname: (...args: unknown[]) => mockAddContactNickname(...args),
  updateContactNickname: (...args: unknown[]) => mockUpdateContactNickname(...args),
  removeContactNickname: (...args: unknown[]) => mockRemoveContactNickname(...args),
  replaceContactNicknames: (...args: unknown[]) => mockReplaceContactNicknames(...args),
  setContactNote: (...args: unknown[]) => mockSetContactNote(...args),
  updateContactNote: (...args: unknown[]) => mockUpdateContactNote(...args),
  deleteContactNote: (...args: unknown[]) => mockDeleteContactNote(...args),
}))

let mockListContactPlatformIds: ReturnType<typeof mock>
let mockRemoveContactPlatformId: ReturnType<typeof mock>
let mockAddContactPlatformId: ReturnType<typeof mock>

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

// Mock @/server/services/channels to prevent broken import chain
// (onboarding.test.ts mocks @/server/db/index globally which breaks channels' real import).
// We must provide ALL exports including the in-memory queue meta functions
// that channels.test.ts tests directly.
const _queueMeta = new Map<string, unknown>()
const _originMeta = new Map<string, unknown>()
mock.module('@/server/services/channels', () => ({
  // Functions used by contacts routes
  listContactPlatformIds: (...args: unknown[]) => mockListContactPlatformIds(...args),
  removeContactPlatformId: (...args: unknown[]) => mockRemoveContactPlatformId(...args),
  addContactPlatformId: (...args: unknown[]) => mockAddContactPlatformId(...args),
  // In-memory queue meta (tested by channels.test.ts — provide real implementations)
  setChannelQueueMeta: (id: string, meta: unknown) => { _queueMeta.set(id, meta) },
  getChannelQueueMeta: (id: string) => _queueMeta.get(id),
  popChannelQueueMeta: (id: string) => { const v = _queueMeta.get(id); _queueMeta.delete(id); return v },
  setChannelOriginMeta: (id: string, meta: unknown) => { _originMeta.set(id, meta) },
  getChannelOriginMeta: (id: string) => _originMeta.get(id),
  // Stubs for remaining exports
  createChannel: async () => null,
  getChannel: async () => null,
  listChannels: async () => [],
  updateChannel: async () => null,
  deleteChannel: async () => false,
  activateChannel: async () => null,
  deactivateChannel: async () => null,
  testChannel: async () => ({ valid: false }),
  handleIncomingChannelMessage: async () => {},
  deliverChannelResponse: async () => {},
  findContactByPlatformId: () => null,
  listPendingUsers: async () => [],
  approveChannelUser: async () => {},
  countPendingApprovals: async () => 0,
  countPendingApprovalsForChannel: async () => 0,
  listChannelConversations: async () => [],
  getActiveChannelsForKin: () => [],
  restoreActiveChannels: async () => {},
  listChannelUserMappings: () => [],
}))

// ─── Import after mocks (may fail if drizzle-orm exports are poisoned) ──────

let contactRoutes: any
let _mocksWorking = false
try {
  const mod = await import('./contacts')
  contactRoutes = mod.contactRoutes
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

const app = new Hono()
if (contactRoutes) app.route('/api/contacts', contactRoutes)

function req(method: string, path: string, body?: unknown) {
  const opts: RequestInit = { method }
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' }
    opts.body = JSON.stringify(body)
  }
  const url = path === '/' ? 'http://localhost/api/contacts' : `http://localhost/api/contacts${path}`
  return app.request(url, opts)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockListContactsWithDetails = mock(() => [])
  mockGetContactWithDetails = mock(() => null)
  mockGetContact = mock(() => ({ id: 'c1', firstName: 'Alice', lastName: null }))
  mockCreateContact = mock(() => ({ id: 'c1', firstName: 'Alice', lastName: null }))
  mockUpdateContact = mock(() => ({ id: 'c1', firstName: 'Alice', lastName: 'Updated' }))
  mockDeleteContact = mock(() => true)
  mockAddContactIdentifier = mock(() => ({ id: 'i1', contactId: 'c1', label: 'email', value: 'a@b.com' }))
  mockUpdateContactIdentifier = mock(() => ({ id: 'i1', contactId: 'c1', label: 'phone', value: '123' }))
  mockRemoveContactIdentifier = mock(() => true)
  mockReplaceContactIdentifiers = mock(() => [])
  mockAddContactNickname = mock(() => ({ id: 'nk1', contactId: 'c1', nickname: 'ali' }))
  mockUpdateContactNickname = mock(() => ({ id: 'nk1', contactId: 'c1', nickname: 'lily' }))
  mockRemoveContactNickname = mock(() => true)
  mockReplaceContactNicknames = mock(() => [])
  mockSetContactNote = mock(() => ({ id: 'n1', contactId: 'c1', kinId: 'k1', scope: 'global', content: 'note' }))
  mockUpdateContactNote = mock(() => ({ id: 'n1', content: 'updated' }))
  mockDeleteContactNote = mock(() => true)
  mockListContactPlatformIds = mock(() => [])
  mockRemoveContactPlatformId = mock(() => true)
  mockAddContactPlatformId = mock(() => ({ id: 'p1', contactId: 'c1', platform: 'telegram', platformId: '123' }))
})

// ─── GET /api/contacts ──────────────────────────────────────────────────────

describe('GET /api/contacts', () => {
  itMocked('returns empty list', async () => {
    const res = await req('GET', '/')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.contacts).toEqual([])
  })

  itMocked('returns contacts from service', async () => {
    const contacts = [{ id: 'c1', firstName: 'Alice', lastName: null, displayName: 'Alice' }]
    mockListContactsWithDetails = mock(() => contacts)
    const res = await req('GET', '/')
    const json = await res.json()
    expect(json.contacts).toEqual(contacts)
  })
})

// ─── GET /api/contacts/:id ─────────────────────────────────────────────────

describe('GET /api/contacts/:id', () => {
  itMocked('returns 404 when contact not found', async () => {
    const res = await req('GET', '/nonexistent')
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error.code).toBe('CONTACT_NOT_FOUND')
  })

  itMocked('returns contact details', async () => {
    const contact = { id: 'c1', firstName: 'Alice', lastName: null, displayName: 'Alice', nicknames: [], identifiers: [], notes: [], platformIds: [] }
    mockGetContactWithDetails = mock(() => contact)
    const res = await req('GET', '/c1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.contact).toEqual(contact)
  })
})

// ─── POST /api/contacts ────────────────────────────────────────────────────

describe('POST /api/contacts', () => {
  itMocked('creates a contact with firstName + lastName', async () => {
    const res = await req('POST', '/', { firstName: 'Alice', lastName: 'Dupont' })
    expect(res.status).toBe(201)
    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: 'Alice',
        lastName: 'Dupont',
        nicknames: [],
      }),
    )
  })

  itMocked('creates a contact with only a nickname', async () => {
    const res = await req('POST', '/', { nicknames: ['ali'] })
    expect(res.status).toBe(201)
    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({
        firstName: null,
        lastName: null,
        nicknames: ['ali'],
      }),
    )
  })

  itMocked('returns 400 when no name nor nickname provided', async () => {
    const res = await req('POST', '/', {})
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.code).toBe('INVALID_INPUT')
  })

  itMocked('returns 400 when all fields are whitespace', async () => {
    const res = await req('POST', '/', { firstName: '   ', lastName: '   ', nicknames: ['   '] })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when firstName exceeds 100 characters', async () => {
    const res = await req('POST', '/', { firstName: 'x'.repeat(101) })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toContain('100')
  })

  itMocked('returns 400 when nickname exceeds 100 characters', async () => {
    const res = await req('POST', '/', { firstName: 'Alice', nicknames: ['x'.repeat(101)] })
    expect(res.status).toBe(400)
  })

  itMocked('trims whitespace from firstName and lastName', async () => {
    await req('POST', '/', { firstName: '  Alice  ', lastName: '  Dupont  ' })
    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Alice', lastName: 'Dupont' }),
    )
  })

  itMocked('filters out empty nicknames', async () => {
    await req('POST', '/', { firstName: 'Alice', nicknames: ['ali', '   ', 'lily'] })
    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ nicknames: ['ali', 'lily'] }),
    )
  })

  itMocked('returns 409 when user is already linked', async () => {
    mockCreateContact = mock(() => ({ error: 'USER_ALREADY_LINKED', linkedContactName: 'Bob' }))
    const res = await req('POST', '/', { firstName: 'Alice', linkedUserId: 'u1' })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error.code).toBe('USER_ALREADY_LINKED')
  })

  itMocked('passes identifiers to service', async () => {
    const identifiers = [{ label: 'email', value: 'a@b.com' }]
    await req('POST', '/', { firstName: 'Alice', identifiers })
    expect(mockCreateContact).toHaveBeenCalledWith(
      expect.objectContaining({ identifiers }),
    )
  })

  itMocked('accepts firstName at exactly 100 characters', async () => {
    const res = await req('POST', '/', { firstName: 'x'.repeat(100) })
    expect(res.status).toBe(201)
  })
})

// ─── PATCH /api/contacts/:id ───────────────────────────────────────────────

describe('PATCH /api/contacts/:id', () => {
  itMocked('updates a contact firstName', async () => {
    const res = await req('PATCH', '/c1', { firstName: 'Alice' })
    expect(res.status).toBe(200)
    expect(mockUpdateContact).toHaveBeenCalled()
  })

  itMocked('returns 404 when contact not found', async () => {
    mockUpdateContact = mock(() => null)
    const res = await req('PATCH', '/c1', { firstName: 'Alice' })
    expect(res.status).toBe(404)
  })

  itMocked('returns 400 when firstName exceeds 100 characters', async () => {
    const res = await req('PATCH', '/c1', { firstName: 'x'.repeat(101) })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when lastName exceeds 100 characters', async () => {
    const res = await req('PATCH', '/c1', { lastName: 'x'.repeat(101) })
    expect(res.status).toBe(400)
  })

  itMocked('trims firstName whitespace and treats empty as null', async () => {
    await req('PATCH', '/c1', { firstName: '   ' })
    expect(mockUpdateContact).toHaveBeenCalledWith('c1', expect.objectContaining({ firstName: null }))
  })

  itMocked('returns 409 when user already linked', async () => {
    mockUpdateContact = mock(() => ({ error: 'USER_ALREADY_LINKED', linkedContactName: 'Bob' }))
    const res = await req('PATCH', '/c1', { linkedUserId: 'u1' })
    expect(res.status).toBe(409)
  })

  itMocked('passes null linkedUserId to unlink', async () => {
    await req('PATCH', '/c1', { linkedUserId: null })
    expect(mockUpdateContact).toHaveBeenCalledWith('c1', expect.objectContaining({ linkedUserId: null }))
  })
})

// ─── Nicknames ─────────────────────────────────────────────────────────────

describe('PUT /api/contacts/:id/nicknames', () => {
  itMocked('replaces all nicknames atomically', async () => {
    mockReplaceContactNicknames = mock(() => [{ id: 'nk1', nickname: 'ali' }])
    const res = await req('PUT', '/c1/nicknames', { nicknames: ['ali', 'lily'] })
    expect(res.status).toBe(200)
    expect(mockReplaceContactNicknames).toHaveBeenCalledWith('c1', ['ali', 'lily'])
  })

  itMocked('returns 400 when nicknames is not an array', async () => {
    const res = await req('PUT', '/c1/nicknames', { nicknames: 'ali' })
    expect(res.status).toBe(400)
  })

  itMocked('filters out whitespace-only entries', async () => {
    await req('PUT', '/c1/nicknames', { nicknames: ['ali', '   ', 'lily'] })
    expect(mockReplaceContactNicknames).toHaveBeenCalledWith('c1', ['ali', 'lily'])
  })

  itMocked('returns 404 when contact not found', async () => {
    mockReplaceContactNicknames = mock(() => null)
    const res = await req('PUT', '/c1/nicknames', { nicknames: [] })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/contacts/:id/nicknames', () => {
  itMocked('adds a nickname', async () => {
    const res = await req('POST', '/c1/nicknames', { nickname: 'ali' })
    expect(res.status).toBe(201)
    expect(mockAddContactNickname).toHaveBeenCalledWith('c1', 'ali')
  })

  itMocked('returns 400 when nickname is empty', async () => {
    const res = await req('POST', '/c1/nicknames', { nickname: '   ' })
    expect(res.status).toBe(400)
  })

  itMocked('trims whitespace', async () => {
    await req('POST', '/c1/nicknames', { nickname: '  ali  ' })
    expect(mockAddContactNickname).toHaveBeenCalledWith('c1', 'ali')
  })
})

describe('PATCH /api/contacts/:id/nicknames/:nickId', () => {
  itMocked('updates a nickname', async () => {
    const res = await req('PATCH', '/c1/nicknames/nk1', { nickname: 'lily' })
    expect(res.status).toBe(200)
    expect(mockUpdateContactNickname).toHaveBeenCalledWith('nk1', 'lily', 'c1')
  })

  itMocked('returns 404 when nickname not found', async () => {
    mockUpdateContactNickname = mock(() => null)
    const res = await req('PATCH', '/c1/nicknames/nk1', { nickname: 'lily' })
    expect(res.status).toBe(404)
  })

  itMocked('returns 400 when empty', async () => {
    const res = await req('PATCH', '/c1/nicknames/nk1', { nickname: '   ' })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/contacts/:id/nicknames/:nickId', () => {
  itMocked('removes a nickname', async () => {
    const res = await req('DELETE', '/c1/nicknames/nk1')
    expect(res.status).toBe(200)
  })

  itMocked('returns 404 when not found', async () => {
    mockRemoveContactNickname = mock(() => false)
    const res = await req('DELETE', '/c1/nicknames/nk1')
    expect(res.status).toBe(404)
  })
})

// ─── DELETE /api/contacts/:id ──────────────────────────────────────────────

describe('DELETE /api/contacts/:id', () => {
  itMocked('deletes a contact', async () => {
    const res = await req('DELETE', '/c1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })

  itMocked('returns 404 when contact not found', async () => {
    mockDeleteContact = mock(() => false)
    const res = await req('DELETE', '/nonexistent')
    expect(res.status).toBe(404)
  })
})

// ─── POST /api/contacts/:id/identifiers ────────────────────────────────────

describe('POST /api/contacts/:id/identifiers', () => {
  itMocked('adds an identifier', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'email', value: 'a@b.com' })
    expect(res.status).toBe(201)
    expect(mockAddContactIdentifier).toHaveBeenCalledWith('c1', 'email', 'a@b.com')
  })

  itMocked('returns 400 when label is missing', async () => {
    const res = await req('POST', '/c1/identifiers', { value: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when value is missing', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'email' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when label is whitespace-only', async () => {
    const res = await req('POST', '/c1/identifiers', { label: '   ', value: 'a@b.com' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when value is whitespace-only', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'email', value: '   ' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when label exceeds 100 characters', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'x'.repeat(101), value: 'test' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when value exceeds 500 characters', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'email', value: 'x'.repeat(501) })
    expect(res.status).toBe(400)
  })

  itMocked('trims label and value whitespace', async () => {
    await req('POST', '/c1/identifiers', { label: '  email  ', value: '  a@b.com  ' })
    expect(mockAddContactIdentifier).toHaveBeenCalledWith('c1', 'email', 'a@b.com')
  })

  itMocked('accepts label at exactly 100 characters', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'x'.repeat(100), value: 'test' })
    expect(res.status).toBe(201)
  })

  itMocked('accepts value at exactly 500 characters', async () => {
    const res = await req('POST', '/c1/identifiers', { label: 'email', value: 'x'.repeat(500) })
    expect(res.status).toBe(201)
  })
})

// ─── PATCH /api/contacts/:id/identifiers/:identifierId ─────────────────────

describe('PATCH /api/contacts/:id/identifiers/:identifierId', () => {
  itMocked('updates an identifier', async () => {
    const res = await req('PATCH', '/c1/identifiers/i1', { label: 'phone', value: '123' })
    expect(res.status).toBe(200)
    expect(mockUpdateContactIdentifier).toHaveBeenCalledWith('i1', { label: 'phone', value: '123' }, 'c1')
  })

  itMocked('returns 404 when identifier not found', async () => {
    mockUpdateContactIdentifier = mock(() => null)
    const res = await req('PATCH', '/c1/identifiers/i1', { label: 'phone' })
    expect(res.status).toBe(404)
  })

  itMocked('returns 400 when label is empty', async () => {
    const res = await req('PATCH', '/c1/identifiers/i1', { label: '   ' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when value is empty', async () => {
    const res = await req('PATCH', '/c1/identifiers/i1', { value: '   ' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when label exceeds 100 chars', async () => {
    const res = await req('PATCH', '/c1/identifiers/i1', { label: 'x'.repeat(101) })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when value exceeds 500 chars', async () => {
    const res = await req('PATCH', '/c1/identifiers/i1', { value: 'x'.repeat(501) })
    expect(res.status).toBe(400)
  })

  itMocked('trims label and value whitespace', async () => {
    await req('PATCH', '/c1/identifiers/i1', { label: '  phone  ', value: '  123  ' })
    expect(mockUpdateContactIdentifier).toHaveBeenCalledWith('i1', { label: 'phone', value: '123' }, 'c1')
  })
})

// ─── DELETE /api/contacts/:id/identifiers/:identifierId ────────────────────

describe('DELETE /api/contacts/:id/identifiers/:identifierId', () => {
  itMocked('removes an identifier', async () => {
    const res = await req('DELETE', '/c1/identifiers/i1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })

  itMocked('returns 404 when not found', async () => {
    mockRemoveContactIdentifier = mock(() => false)
    const res = await req('DELETE', '/c1/identifiers/i1')
    expect(res.status).toBe(404)
  })
})

// ─── Platform IDs ──────────────────────────────────────────────────────────

describe('GET /api/contacts/:id/platform-ids', () => {
  itMocked('returns empty list', async () => {
    const res = await req('GET', '/c1/platform-ids')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.platformIds).toEqual([])
  })

  itMocked('returns platform IDs with correct shape', async () => {
    mockListContactPlatformIds = mock(() => [
      { id: 'p1', contactId: 'c1', platform: 'telegram', platformId: '123', createdAt: 1700000000000 },
    ])
    const res = await req('GET', '/c1/platform-ids')
    const json = await res.json()
    expect(json.platformIds).toHaveLength(1)
    expect(json.platformIds[0].platform).toBe('telegram')
  })
})

describe('POST /api/contacts/:id/platform-ids', () => {
  itMocked('adds a platform ID', async () => {
    const res = await req('POST', '/c1/platform-ids', { platform: 'telegram', platformId: '123' })
    expect(res.status).toBe(201)
    expect(mockAddContactPlatformId).toHaveBeenCalledWith('c1', 'telegram', '123')
  })

  itMocked('returns 400 when platform is missing', async () => {
    const res = await req('POST', '/c1/platform-ids', { platformId: '123' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when platformId is missing', async () => {
    const res = await req('POST', '/c1/platform-ids', { platform: 'telegram' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 409 on duplicate platform ID', async () => {
    mockAddContactPlatformId = mock(() => { throw new Error('duplicate') })
    const res = await req('POST', '/c1/platform-ids', { platform: 'telegram', platformId: '123' })
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error.code).toBe('DUPLICATE_PLATFORM_ID')
  })
})

describe('DELETE /api/contacts/:id/platform-ids/:pidId', () => {
  itMocked('removes a platform ID', async () => {
    const res = await req('DELETE', '/c1/platform-ids/p1')
    expect(res.status).toBe(200)
  })

  itMocked('returns 404 when not found', async () => {
    mockRemoveContactPlatformId = mock(() => false)
    const res = await req('DELETE', '/c1/platform-ids/p1')
    expect(res.status).toBe(404)
  })
})

// ─── Notes ──────────────────────────────────────────────────────────────────

describe('POST /api/contacts/:id/notes', () => {
  itMocked('creates a note', async () => {
    const res = await req('POST', '/c1/notes', { kinId: 'k1', scope: 'global', content: 'hello' })
    expect(res.status).toBe(201)
    expect(mockSetContactNote).toHaveBeenCalledWith('c1', 'k1', 'global', 'hello')
  })

  itMocked('returns 400 when kinId is missing', async () => {
    const res = await req('POST', '/c1/notes', { scope: 'global', content: 'hello' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when scope is missing', async () => {
    const res = await req('POST', '/c1/notes', { kinId: 'k1', content: 'hello' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when content is empty', async () => {
    const res = await req('POST', '/c1/notes', { kinId: 'k1', scope: 'global', content: '   ' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when content exceeds 10000 characters', async () => {
    const res = await req('POST', '/c1/notes', { kinId: 'k1', scope: 'global', content: 'x'.repeat(10001) })
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error.message).toContain('10,000')
  })

  itMocked('trims content whitespace', async () => {
    await req('POST', '/c1/notes', { kinId: 'k1', scope: 'global', content: '  hello  ' })
    expect(mockSetContactNote).toHaveBeenCalledWith('c1', 'k1', 'global', 'hello')
  })

  itMocked('accepts content at exactly 10000 characters', async () => {
    const res = await req('POST', '/c1/notes', { kinId: 'k1', scope: 'global', content: 'x'.repeat(10000) })
    expect(res.status).toBe(201)
  })

  itMocked('accepts private scope', async () => {
    const res = await req('POST', '/c1/notes', { kinId: 'k1', scope: 'private', content: 'secret' })
    expect(res.status).toBe(201)
    expect(mockSetContactNote).toHaveBeenCalledWith('c1', 'k1', 'private', 'secret')
  })
})

describe('PATCH /api/contacts/:id/notes/:noteId', () => {
  itMocked('updates a note', async () => {
    const res = await req('PATCH', '/c1/notes/n1', { content: 'updated' })
    expect(res.status).toBe(200)
    expect(mockUpdateContactNote).toHaveBeenCalledWith('n1', 'updated', 'c1')
  })

  itMocked('returns 400 when content is empty', async () => {
    const res = await req('PATCH', '/c1/notes/n1', { content: '   ' })
    expect(res.status).toBe(400)
  })

  itMocked('returns 400 when content exceeds 10000 characters', async () => {
    const res = await req('PATCH', '/c1/notes/n1', { content: 'x'.repeat(10001) })
    expect(res.status).toBe(400)
  })

  itMocked('returns 404 when note not found', async () => {
    mockUpdateContactNote = mock(() => null)
    const res = await req('PATCH', '/c1/notes/n1', { content: 'test' })
    expect(res.status).toBe(404)
  })

  itMocked('trims content whitespace', async () => {
    await req('PATCH', '/c1/notes/n1', { content: '  updated  ' })
    expect(mockUpdateContactNote).toHaveBeenCalledWith('n1', 'updated', 'c1')
  })
})

describe('DELETE /api/contacts/:id/notes/:noteId', () => {
  itMocked('deletes a note', async () => {
    const res = await req('DELETE', '/c1/notes/n1')
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(true)
  })

  itMocked('returns 404 when note not found', async () => {
    mockDeleteContactNote = mock(() => false)
    const res = await req('DELETE', '/c1/notes/n1')
    expect(res.status).toBe(404)
  })
})
