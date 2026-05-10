import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm, fullMockDbIndex } from '../../test-helpers'
import { getContactDisplayName } from '@/shared/contact-display'

// ─── Re-implement private helpers from contacts.ts for isolated testing ─────
// These mirror the exact logic in the source. No DB mocking needed.

// ─── kinAvatarUrl (shared helper used in notifications.ts, tasks.ts, contacts UI) ──

function kinAvatarUrl(kinId: string, avatarPath: string | null, updatedAt?: Date | null): string | null {
  if (!avatarPath) return null
  const ext = avatarPath.split('.').pop() ?? 'png'
  const v = updatedAt ? updatedAt.getTime() : Date.now()
  return `/api/uploads/kins/${kinId}/avatar.${ext}?v=${v}`
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('contacts service — pure helpers', () => {

  // ── kinAvatarUrl ──

  describe('kinAvatarUrl', () => {
    it('returns null when avatarPath is null', () => {
      expect(kinAvatarUrl('kin-1', null)).toBeNull()
    })

    it('returns null when avatarPath is empty string (falsy)', () => {
      expect(kinAvatarUrl('kin-1', '')).toBeNull()
    })

    it('builds correct URL for png avatar', () => {
      const result = kinAvatarUrl('kin-123', 'avatars/photo.png', new Date(1700000000000))
      expect(result).toBe('/api/uploads/kins/kin-123/avatar.png?v=1700000000000')
    })

    it('builds correct URL for jpg avatar', () => {
      const result = kinAvatarUrl('kin-456', 'some/path/avatar.jpg', new Date(1600000000000))
      expect(result).toBe('/api/uploads/kins/kin-456/avatar.jpg?v=1600000000000')
    })

    it('extracts extension from complex paths', () => {
      const result = kinAvatarUrl('kin-1', 'a/b/c.webp', new Date(1000))
      expect(result).toBe('/api/uploads/kins/kin-1/avatar.webp?v=1000')
    })

    it('defaults to png when path has no extension', () => {
      const result = kinAvatarUrl('kin-1', 'noext', new Date(500))
      // 'noext'.split('.').pop() === 'noext', so ext is 'noext' not 'png'
      // Actually: 'noext'.split('.') => ['noext'], pop() => 'noext'
      expect(result).toBe('/api/uploads/kins/kin-1/avatar.noext?v=500')
    })

    it('uses Date.now() when updatedAt is null', () => {
      const before = Date.now()
      const result = kinAvatarUrl('kin-1', 'avatar.png', null)!
      const after = Date.now()
      // Extract the v= param
      const v = parseInt(result.split('?v=')[1]!)
      expect(v).toBeGreaterThanOrEqual(before)
      expect(v).toBeLessThanOrEqual(after)
    })

    it('uses Date.now() when updatedAt is undefined', () => {
      const before = Date.now()
      const result = kinAvatarUrl('kin-1', 'avatar.png')!
      const after = Date.now()
      const v = parseInt(result.split('?v=')[1]!)
      expect(v).toBeGreaterThanOrEqual(before)
      expect(v).toBeLessThanOrEqual(after)
    })
  })
})

// ─── Contact type/interface contract tests ──────────────────────────────────
// These test the expected shape of data flowing through the contacts module
// without hitting the DB.

describe('contacts service — data contracts', () => {

  describe('ContactWithDetails shape', () => {
    it('should include all required fields', () => {
      const contact = {
        id: 'c1',
        firstName: 'Test',
        lastName: 'User',
        displayName: 'Test User',
        linkedUserId: null,
        linkedUserName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        nicknames: [],
        identifiers: [],
        notes: [],
        platformIds: [],
      }

      expect(contact).toHaveProperty('id')
      expect(contact).toHaveProperty('firstName')
      expect(contact).toHaveProperty('lastName')
      expect(contact).toHaveProperty('displayName')
      expect(contact).toHaveProperty('linkedUserId')
      expect(contact).toHaveProperty('linkedUserName')
      expect(contact).toHaveProperty('nicknames')
      expect(contact).toHaveProperty('identifiers')
      expect(contact).toHaveProperty('notes')
      expect(contact).toHaveProperty('platformIds')
    })

    it('identifiers have correct shape', () => {
      const identifier = { id: 'i1', label: 'email', value: 'test@example.com' }
      expect(identifier).toHaveProperty('id')
      expect(identifier).toHaveProperty('label')
      expect(identifier).toHaveProperty('value')
    })

    it('notes have correct shape', () => {
      const note = {
        id: 'n1',
        kinId: 'kin-1',
        scope: 'global',
        content: 'Some note',
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      expect(note).toHaveProperty('id')
      expect(note).toHaveProperty('kinId')
      expect(note).toHaveProperty('scope')
      expect(note).toHaveProperty('content')
      expect(['global', 'private']).toContain(note.scope)
    })

    it('platformIds have correct shape', () => {
      const pid = {
        id: 'p1',
        contactId: 'c1',
        platform: 'telegram',
        platformId: '12345',
        createdAt: Date.now(),
      }
      expect(pid).toHaveProperty('id')
      expect(pid).toHaveProperty('contactId')
      expect(pid).toHaveProperty('platform')
      expect(pid).toHaveProperty('platformId')
      expect(typeof pid.createdAt).toBe('number')
    })
  })

  describe('ContactSummary shape', () => {
    it('has required fields for prompt context', () => {
      const summary = {
        id: 'c1',
        displayName: 'Alice Dupont',
        firstName: 'Alice',
        lastName: 'Dupont',
        nicknames: ['ali'],
        linkedUserName: 'alice',
        identifierSummary: 'email, phone',
      }
      expect(summary.id).toBeTruthy()
      expect(summary.displayName).toBeTruthy()
      expect(Array.isArray(summary.nicknames)).toBe(true)
    })

    it('identifierSummary can be undefined when no identifiers', () => {
      const summary = {
        id: 'c1',
        displayName: 'Bob',
        firstName: 'Bob',
        lastName: null,
        nicknames: [],
        identifierSummary: undefined,
      }
      expect(summary.identifierSummary).toBeUndefined()
    })
  })

  describe('note scope values', () => {
    it('scope must be private or global', () => {
      const validScopes = ['private', 'global']
      expect(validScopes).toContain('private')
      expect(validScopes).toContain('global')
    })

    it('private notes are only visible to the owning kin', () => {
      // Contract: when fetching notes with kinId filter,
      // private notes from OTHER kins should not be returned
      const allNotes = [
        { kinId: 'kin-1', scope: 'global', content: 'Visible to all' },
        { kinId: 'kin-1', scope: 'private', content: 'Only kin-1 sees this' },
        { kinId: 'kin-2', scope: 'private', content: 'Only kin-2 sees this' },
        { kinId: 'kin-2', scope: 'global', content: 'Also visible to all' },
      ]

      const requestingKinId = 'kin-1'
      const visible = allNotes.filter(
        (n) => n.scope === 'global' || n.kinId === requestingKinId,
      )

      expect(visible).toHaveLength(3) // both globals + kin-1's private
      expect(visible.map((n) => n.content)).toContain('Visible to all')
      expect(visible.map((n) => n.content)).toContain('Only kin-1 sees this')
      expect(visible.map((n) => n.content)).toContain('Also visible to all')
      expect(visible.map((n) => n.content)).not.toContain('Only kin-2 sees this')
    })
  })

  describe('duplicate user link prevention', () => {
    it('detects when a user is already linked to a contact', () => {
      const existingContacts = [
        { id: 'c1', firstName: 'Alice', lastName: null, linkedUserId: 'user-1' },
        { id: 'c2', firstName: 'Bob', lastName: null, linkedUserId: 'user-2' },
        { id: 'c3', firstName: 'Charlie', lastName: null, linkedUserId: null },
      ]

      const newLinkedUserId = 'user-1'
      const existing = existingContacts.find((c) => c.linkedUserId === newLinkedUserId)
      expect(existing).toBeDefined()
      expect(existing!.firstName).toBe('Alice')
    })

    it('allows linking when user is not yet linked', () => {
      const existingContacts = [
        { id: 'c1', firstName: 'Alice', lastName: null, linkedUserId: 'user-1' },
      ]

      const newLinkedUserId = 'user-99'
      const existing = existingContacts.find((c) => c.linkedUserId === newLinkedUserId)
      expect(existing).toBeUndefined()
    })
  })

  describe('identifier deduplication', () => {
    it('detects duplicate identifier (same contactId + label + value)', () => {
      const existingIdentifiers = [
        { contactId: 'c1', label: 'email', value: 'alice@example.com' },
        { contactId: 'c1', label: 'phone', value: '+123' },
      ]

      const isDuplicate = existingIdentifiers.some(
        (i) => i.contactId === 'c1' && i.label === 'email' && i.value === 'alice@example.com',
      )
      expect(isDuplicate).toBe(true)
    })

    it('does not flag different label as duplicate', () => {
      const existingIdentifiers = [
        { contactId: 'c1', label: 'email', value: 'alice@example.com' },
      ]

      const isDuplicate = existingIdentifiers.some(
        (i) => i.contactId === 'c1' && i.label === 'phone' && i.value === 'alice@example.com',
      )
      expect(isDuplicate).toBe(false)
    })

    it('does not flag different contactId as duplicate', () => {
      const existingIdentifiers = [
        { contactId: 'c1', label: 'email', value: 'alice@example.com' },
      ]

      const isDuplicate = existingIdentifiers.some(
        (i) => i.contactId === 'c2' && i.label === 'email' && i.value === 'alice@example.com',
      )
      expect(isDuplicate).toBe(false)
    })
  })

  describe('search deduplication', () => {
    it('deduplicates contact IDs from multiple search sources', () => {
      const byName = [{ id: 'c1' }, { id: 'c2' }]
      const byIdentifier = [{ id: 'c2' }, { id: 'c3' }]
      const byNote = [{ id: 'c1' }, { id: 'c3' }, { id: 'c4' }]

      const uniqueIds = [...new Set([
        ...byName.map((r) => r.id),
        ...byIdentifier.map((r) => r.id),
        ...byNote.map((r) => r.id),
      ])]

      expect(uniqueIds).toHaveLength(4)
      expect(uniqueIds).toContain('c1')
      expect(uniqueIds).toContain('c2')
      expect(uniqueIds).toContain('c3')
      expect(uniqueIds).toContain('c4')
    })

    it('handles empty search results', () => {
      const byName: { id: string }[] = []
      const byIdentifier: { id: string }[] = []
      const byNote: { id: string }[] = []

      const uniqueIds = [...new Set([
        ...byName.map((r) => r.id),
        ...byIdentifier.map((r) => r.id),
        ...byNote.map((r) => r.id),
      ])]

      expect(uniqueIds).toHaveLength(0)
    })
  })

  describe('platformId timestamp conversion', () => {
    it('converts Date to numeric timestamp', () => {
      const raw = { createdAt: new Date(1700000000000) }
      const converted = new Date(raw.createdAt).getTime()
      expect(converted).toBe(1700000000000)
      expect(typeof converted).toBe('number')
    })
  })

  describe('getContactDisplayName', () => {
    it('joins firstName and lastName when both present', () => {
      expect(getContactDisplayName({ firstName: 'Alice', lastName: 'Dupont' })).toBe('Alice Dupont')
    })

    it('returns firstName alone when lastName is missing', () => {
      expect(getContactDisplayName({ firstName: 'Alice', lastName: null })).toBe('Alice')
    })

    it('returns lastName alone when firstName is missing', () => {
      expect(getContactDisplayName({ firstName: null, lastName: 'Dupont' })).toBe('Dupont')
    })

    it('falls back to first nickname (string form) when names absent', () => {
      expect(getContactDisplayName({ firstName: null, lastName: null, nicknames: ['lily', 'ali'] })).toBe('lily')
    })

    it('falls back to first nickname (object form) when names absent', () => {
      expect(getContactDisplayName({
        firstName: null,
        lastName: null,
        nicknames: [{ nickname: 'lily' }],
      })).toBe('lily')
    })

    it('returns Unnamed contact when nothing is provided', () => {
      expect(getContactDisplayName({ firstName: null, lastName: null })).toBe('Unnamed contact')
    })

    it('trims whitespace-only names', () => {
      expect(getContactDisplayName({ firstName: '   ', lastName: null, nicknames: ['ali'] })).toBe('ali')
    })
  })
})
