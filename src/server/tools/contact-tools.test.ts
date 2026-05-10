import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockContacts = {
  getContactWithDetails: mock(() => Promise.resolve(null as any)),
  searchContacts: mock(() => Promise.resolve([] as any[])),
  createContact: mock(() => Promise.resolve({ id: 'c-1', firstName: 'Alice' as string | null, lastName: null as string | null })),
  updateContact: mock(() => Promise.resolve(null as any)),
  deleteContact: mock(() => Promise.resolve(false)),
  addContactIdentifier: mock(() => {}),
  addContactNickname: mock(() => {}),
  setContactNote: mock(() => ({ contactId: 'c-1', scope: 'private', content: 'test note' })),
  findContactByIdentifier: mock(() => null as any),
  // Stubs for exports used by other modules (bun mock.module is global)
  findContactByLinkedUserId: mock(() => null as any),
  listContacts: mock(() => Promise.resolve([])),
  getContact: mock(() => Promise.resolve(null as any)),
  removeContactIdentifier: mock(() => false),
  updateContactIdentifier: mock(() => null as any),
  listContactIdentifiers: mock(() => []),
  replaceContactIdentifiers: mock(() => []),
  listContactNicknames: mock(() => []),
  updateContactNickname: mock(() => null as any),
  removeContactNickname: mock(() => false),
  replaceContactNicknames: mock(() => []),
  listContactsForPrompt: mock(() => Promise.resolve([])),
  ensureUserContactsExist: mock(() => Promise.resolve()),
  deleteContactNote: mock(() => {}),
  deleteNotesByKin: mock(() => {}),
  getVisibleNotes: mock(() => []),
  updateContactNote: mock(() => null as any),
  listContactsWithDetails: mock(() => Promise.resolve([])),
}

mock.module('@/server/services/contacts', () => mockContacts)
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

// Import after mocks
const {
  getContactTool,
  searchContactsTool,
  createContactTool,
  updateContactTool,
  deleteContactTool,
  setContactNoteTool,
  findContactByIdentifierTool,
} = await import('@/server/tools/contact-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = { kinId: 'kin-test', isSubKin: false }

function execute(registration: any, args: any) {
  const t = registration.create(ctx)
  return t.execute(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

function resetMocks() {
  Object.values(mockContacts).forEach((m) => {
    if (typeof m.mockReset === 'function') m.mockReset()
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('contact-tools', () => {
  beforeEach(resetMocks)

  // ── Registration shape ──────────────────────────────────────────────────

  describe('registration shape', () => {
    it('all tools are available to main agents only', () => {
      const tools = [
        getContactTool,
        searchContactsTool,
        createContactTool,
        updateContactTool,
        deleteContactTool,
        setContactNoteTool,
        findContactByIdentifierTool,
      ]
      for (const t of tools) {
        expect(t.availability).toEqual(['main'])
        expect(typeof t.create).toBe('function')
      }
    })

    it('create() returns a tool with description and execute', () => {
      const t = getContactTool.create(ctx)
      expect(typeof t.description).toBe('string')
      expect(t.description!.length).toBeGreaterThan(0)
      expect(typeof t.execute).toBe('function')
    })
  })

  // ── get_contact ─────────────────────────────────────────────────────────

  describe('get_contact', () => {
    it('returns error when contact not found', async () => {
      mockContacts.getContactWithDetails.mockResolvedValue(null)
      const result = await execute(getContactTool, { contact_id: 'nonexistent' })
      expect(result).toEqual({ error: 'Contact not found' })
      expect(mockContacts.getContactWithDetails).toHaveBeenCalledWith('nonexistent', 'kin-test')
    })

    it('returns formatted contact with nicknames, identifiers and notes', async () => {
      mockContacts.getContactWithDetails.mockResolvedValue({
        id: 'c-1',
        firstName: 'Alice',
        lastName: 'Dupont',
        displayName: 'Alice Dupont',
        nicknames: [{ id: 'nk1', nickname: 'ali' }, { id: 'nk2', nickname: 'lily' }],
        identifiers: [{ label: 'email', value: 'alice@example.com' }],
        notes: [
          { kinId: 'kin-test', scope: 'private', content: 'My friend' },
          { kinId: 'kin-other', scope: 'global', content: 'VIP customer' },
        ],
        linkedUserId: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-02'),
      })

      const result = await execute(getContactTool, { contact_id: 'c-1' })

      expect(result.id).toBe('c-1')
      expect(result.firstName).toBe('Alice')
      expect(result.lastName).toBe('Dupont')
      expect(result.displayName).toBe('Alice Dupont')
      expect(result.nicknames).toEqual(['ali', 'lily'])
      expect(result.identifiers).toHaveLength(1)
      expect(result.identifiers[0].value).toBe('alice@example.com')
      expect(result.notes).toHaveLength(2)
      expect(result.notes[0].scope).toBe('private')
      expect(result.notes[1].content).toBe('VIP customer')
      expect(result.linkedUserId).toBeNull()
    })

    it('returns contact with empty arrays', async () => {
      mockContacts.getContactWithDetails.mockResolvedValue({
        id: 'c-2',
        firstName: 'Bob',
        lastName: null,
        displayName: 'Bob',
        nicknames: [],
        identifiers: [],
        notes: [],
        linkedUserId: 'u-1',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      })

      const result = await execute(getContactTool, { contact_id: 'c-2' })
      expect(result.nicknames).toEqual([])
      expect(result.identifiers).toEqual([])
      expect(result.notes).toEqual([])
      expect(result.linkedUserId).toBe('u-1')
    })
  })

  // ── search_contacts ─────────────────────────────────────────────────────

  describe('search_contacts', () => {
    it('returns empty array when no matches', async () => {
      mockContacts.searchContacts.mockResolvedValue([])
      const result = await execute(searchContactsTool, { query: 'nobody' })
      expect(result.contacts).toEqual([])
      expect(mockContacts.searchContacts).toHaveBeenCalledWith('nobody', 'kin-test')
    })

    it('returns formatted search results', async () => {
      mockContacts.searchContacts.mockResolvedValue([
        {
          id: 'c-1',
          firstName: 'Alice',
          lastName: null,
          displayName: 'Alice',
          nicknames: [{ id: 'nk1', nickname: 'ali' }],
          identifiers: [{ label: 'phone', value: '+33612345678' }],
          notes: [{ kinId: 'kin-test', scope: 'global', content: 'Friend' }],
        },
        {
          id: 'c-2',
          firstName: 'Alice',
          lastName: 'Corp',
          displayName: 'Alice Corp',
          nicknames: [],
          identifiers: [],
          notes: [],
        },
      ])

      const result = await execute(searchContactsTool, { query: 'alice' })
      expect(result.contacts).toHaveLength(2)
      expect(result.contacts[0].displayName).toBe('Alice')
      expect(result.contacts[0].nicknames).toEqual(['ali'])
      expect(result.contacts[0].identifiers[0].value).toBe('+33612345678')
      expect(result.contacts[1].notes).toEqual([])
    })
  })

  // ── create_contact ──────────────────────────────────────────────────────

  describe('create_contact', () => {
    it('creates a contact with firstName + lastName', async () => {
      mockContacts.createContact.mockResolvedValue({ id: 'c-new', firstName: 'Bob', lastName: 'Smith' })
      const result = await execute(createContactTool, { firstName: 'Bob', lastName: 'Smith' })
      expect(result.id).toBe('c-new')
      expect(result.displayName).toBe('Bob Smith')
      expect(mockContacts.createContact).toHaveBeenCalledWith({
        firstName: 'Bob',
        lastName: 'Smith',
        nicknames: undefined,
        identifiers: undefined,
      })
    })

    it('creates a contact with nicknames and identifiers', async () => {
      mockContacts.createContact.mockResolvedValue({ id: 'c-new', firstName: 'Eve', lastName: null })
      const identifiers = [{ label: 'email', value: 'eve@test.com' }]
      const nicknames = ['evie']
      const result = await execute(createContactTool, { firstName: 'Eve', nicknames, identifiers })
      expect(result.id).toBe('c-new')
      expect(mockContacts.createContact).toHaveBeenCalledWith({
        firstName: 'Eve',
        lastName: undefined,
        nicknames,
        identifiers,
      })
    })
  })

  // ── update_contact ──────────────────────────────────────────────────────

  describe('update_contact', () => {
    it('returns error when contact not found', async () => {
      mockContacts.updateContact.mockResolvedValue(null)
      const result = await execute(updateContactTool, { contact_id: 'bad-id', firstName: 'New Name' })
      expect(result).toEqual({ error: 'Contact not found' })
    })

    it('returns error when user is already linked to another contact', async () => {
      mockContacts.updateContact.mockResolvedValue({ error: true, linkedContactName: 'Other Person' })
      const result = await execute(updateContactTool, { contact_id: 'c-1', firstName: 'Renamed' })
      expect(result).toEqual({ error: 'Cannot update: user is already linked to contact "Other Person"' })
    })

    it('updates contact names without nicknames or identifiers', async () => {
      mockContacts.updateContact.mockResolvedValue({ id: 'c-1', firstName: 'Renamed', lastName: null })
      const result = await execute(updateContactTool, { contact_id: 'c-1', firstName: 'Renamed' })
      expect(result.id).toBe('c-1')
      expect(result.firstName).toBe('Renamed')
      expect(mockContacts.addContactIdentifier).not.toHaveBeenCalled()
      expect(mockContacts.addContactNickname).not.toHaveBeenCalled()
    })

    it('adds nicknames when provided', async () => {
      mockContacts.updateContact.mockResolvedValue({ id: 'c-1', firstName: 'Alice', lastName: null })
      await execute(updateContactTool, { contact_id: 'c-1', nicknames: ['ali', 'lily'] })
      expect(mockContacts.addContactNickname).toHaveBeenCalledTimes(2)
      expect(mockContacts.addContactNickname).toHaveBeenCalledWith('c-1', 'ali')
      expect(mockContacts.addContactNickname).toHaveBeenCalledWith('c-1', 'lily')
    })

    it('adds identifiers when provided', async () => {
      mockContacts.updateContact.mockResolvedValue({ id: 'c-1', firstName: 'Alice', lastName: null })
      const identifiers = [
        { label: 'email', value: 'alice@new.com' },
        { label: 'phone', value: '+1234567890' },
      ]
      await execute(updateContactTool, { contact_id: 'c-1', identifiers })
      expect(mockContacts.addContactIdentifier).toHaveBeenCalledTimes(2)
      expect(mockContacts.addContactIdentifier).toHaveBeenCalledWith('c-1', 'email', 'alice@new.com')
      expect(mockContacts.addContactIdentifier).toHaveBeenCalledWith('c-1', 'phone', '+1234567890')
    })

    it('does not add identifiers when empty array', async () => {
      mockContacts.updateContact.mockResolvedValue({ id: 'c-1', firstName: 'Alice', lastName: null })
      await execute(updateContactTool, { contact_id: 'c-1', identifiers: [] })
      expect(mockContacts.addContactIdentifier).not.toHaveBeenCalled()
    })
  })

  // ── delete_contact ──────────────────────────────────────────────────────

  describe('delete_contact', () => {
    it('returns error when contact not found', async () => {
      mockContacts.deleteContact.mockResolvedValue(false)
      const result = await execute(deleteContactTool, { contact_id: 'bad-id' })
      expect(result).toEqual({ error: 'Contact not found' })
    })

    it('returns success when contact deleted', async () => {
      mockContacts.deleteContact.mockResolvedValue(true)
      const result = await execute(deleteContactTool, { contact_id: 'c-1' })
      expect(result).toEqual({ success: true })
      expect(mockContacts.deleteContact).toHaveBeenCalledWith('c-1')
    })
  })

  // ── set_contact_note ────────────────────────────────────────────────────

  describe('set_contact_note', () => {
    it('sets a private note', async () => {
      mockContacts.setContactNote.mockReturnValue({
        contactId: 'c-1',
        scope: 'private',
        content: 'secret stuff',
      })
      const result = await execute(setContactNoteTool, {
        contact_id: 'c-1',
        scope: 'private',
        content: 'secret stuff',
      })
      expect(result).toEqual({
        contactId: 'c-1',
        scope: 'private',
        content: 'secret stuff',
      })
      expect(mockContacts.setContactNote).toHaveBeenCalledWith('c-1', 'kin-test', 'private', 'secret stuff')
    })

    it('sets a global note', async () => {
      mockContacts.setContactNote.mockReturnValue({
        contactId: 'c-1',
        scope: 'global',
        content: 'public info',
      })
      const result = await execute(setContactNoteTool, {
        contact_id: 'c-1',
        scope: 'global',
        content: 'public info',
      })
      expect(result.scope).toBe('global')
      expect(mockContacts.setContactNote).toHaveBeenCalledWith('c-1', 'kin-test', 'global', 'public info')
    })
  })

  // ── find_contact_by_identifier ──────────────────────────────────────────

  describe('find_contact_by_identifier', () => {
    it('returns found:false when no match', async () => {
      mockContacts.findContactByIdentifier.mockReturnValue(null)
      const result = await execute(findContactByIdentifierTool, {
        label: 'email',
        value: 'unknown@test.com',
      })
      expect(result.found).toBe(false)
      expect(result.message).toContain('email')
      expect(result.message).toContain('unknown@test.com')
      expect(mockContacts.findContactByIdentifier).toHaveBeenCalledWith('email', 'unknown@test.com')
    })

    it('returns contact when found', async () => {
      mockContacts.findContactByIdentifier.mockReturnValue({
        id: 'c-1',
        firstName: 'Alice',
        lastName: 'Dupont',
      })
      const result = await execute(findContactByIdentifierTool, {
        label: 'phone',
        value: '+33612345678',
      })
      expect(result.found).toBe(true)
      expect(result.id).toBe('c-1')
      expect(result.firstName).toBe('Alice')
      expect(result.lastName).toBe('Dupont')
      expect(result.displayName).toBe('Alice Dupont')
    })
  })
})
