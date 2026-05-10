import { eq, and, like, or } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import {
  contacts,
  contactIdentifiers,
  contactNicknames,
  contactNotes,
  contactPlatformIds,
  user,
  userProfiles,
} from '@/server/db/schema'
import { sseManager } from '@/server/sse/index'
import { getContactDisplayName } from '@/shared/contact-display'

// ─── Types ───────────────────────────────────────────────────────────────────

type NoteScope = 'private' | 'global'

interface CreateContactInput {
  firstName?: string | null
  lastName?: string | null
  nicknames?: string[]
  linkedUserId?: string | null
  identifiers?: Array<{ label: string; value: string }>
}

interface UpdateContactInput {
  firstName?: string | null
  lastName?: string | null
  linkedUserId?: string | null
}

interface ContactWithDetails {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string
  linkedUserId: string | null
  linkedUserName: string | null
  createdAt: Date
  updatedAt: Date
  nicknames: Array<{ id: string; nickname: string }>
  identifiers: Array<{ id: string; label: string; value: string }>
  notes: Array<{ id: string; kinId: string; scope: string; content: string; createdAt: Date; updatedAt: Date }>
  platformIds: Array<{ id: string; contactId: string; platform: string; platformId: string; createdAt: number }>
}

interface ContactSummary {
  id: string
  displayName: string
  firstName: string | null
  lastName: string | null
  nicknames: string[]
  linkedUserName?: string | null
  identifierSummary?: string
}

// ─── Contact CRUD ────────────────────────────────────────────────────────────

export async function listContacts() {
  return db.select().from(contacts).all()
}

export async function getContact(contactId: string) {
  return db.select().from(contacts).where(eq(contacts.id, contactId)).get()
}

export async function getContactWithDetails(
  contactId: string,
  kinId?: string,
): Promise<ContactWithDetails | null> {
  const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get()
  if (!contact) return null

  const identifiers = db
    .select({ id: contactIdentifiers.id, label: contactIdentifiers.label, value: contactIdentifiers.value })
    .from(contactIdentifiers)
    .where(eq(contactIdentifiers.contactId, contactId))
    .all()

  const nicknames = db
    .select({ id: contactNicknames.id, nickname: contactNicknames.nickname })
    .from(contactNicknames)
    .where(eq(contactNicknames.contactId, contactId))
    .all()

  let notes
  if (kinId) {
    // Global notes from all Kins + private notes from requesting Kin only
    notes = db
      .select()
      .from(contactNotes)
      .where(
        and(
          eq(contactNotes.contactId, contactId),
          or(eq(contactNotes.scope, 'global'), eq(contactNotes.kinId, kinId)),
        ),
      )
      .all()
  } else {
    // Admin view: all notes
    notes = db.select().from(contactNotes).where(eq(contactNotes.contactId, contactId)).all()
  }

  const pids = db
    .select({
      id: contactPlatformIds.id,
      contactId: contactPlatformIds.contactId,
      platform: contactPlatformIds.platform,
      platformId: contactPlatformIds.platformId,
      createdAt: contactPlatformIds.createdAt,
    })
    .from(contactPlatformIds)
    .where(eq(contactPlatformIds.contactId, contactId))
    .all()

  let linkedUserName: string | null = null
  if (contact.linkedUserId) {
    const u = db.select({ name: user.name }).from(user).where(eq(user.id, contact.linkedUserId)).get()
    linkedUserName = u?.name ?? null
  }

  return {
    ...contact,
    displayName: getContactDisplayName({
      firstName: contact.firstName,
      lastName: contact.lastName,
      nicknames,
    }),
    linkedUserName,
    nicknames,
    identifiers,
    platformIds: pids.map((p) => ({
      id: p.id,
      contactId: p.contactId,
      platform: p.platform,
      platformId: p.platformId,
      createdAt: new Date(p.createdAt).getTime(),
    })),
    notes: notes.map((n) => ({
      id: n.id,
      kinId: n.kinId,
      scope: n.scope,
      content: n.content,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    })),
  }
}

export async function listContactsWithDetails(): Promise<ContactWithDetails[]> {
  const allContacts = db.select().from(contacts).all()
  if (allContacts.length === 0) return []

  const allIdentifiers = db
    .select({ id: contactIdentifiers.id, contactId: contactIdentifiers.contactId, label: contactIdentifiers.label, value: contactIdentifiers.value })
    .from(contactIdentifiers)
    .all()

  const allNicknames = db
    .select({ id: contactNicknames.id, contactId: contactNicknames.contactId, nickname: contactNicknames.nickname })
    .from(contactNicknames)
    .all()

  const allNotes = db.select().from(contactNotes).all()

  const allPids = db
    .select({
      id: contactPlatformIds.id,
      contactId: contactPlatformIds.contactId,
      platform: contactPlatformIds.platform,
      platformId: contactPlatformIds.platformId,
      createdAt: contactPlatformIds.createdAt,
    })
    .from(contactPlatformIds)
    .all()

  const linkedUserIds = allContacts.map((c) => c.linkedUserId).filter(Boolean) as string[]
  const userNames = new Map<string, string>()
  if (linkedUserIds.length > 0) {
    for (const uid of linkedUserIds) {
      const u = db.select({ name: user.name }).from(user).where(eq(user.id, uid)).get()
      if (u?.name) userNames.set(uid, u.name)
    }
  }

  const identifiersByContact = new Map<string, typeof allIdentifiers>()
  for (const i of allIdentifiers) {
    const list = identifiersByContact.get(i.contactId) ?? []
    list.push(i)
    identifiersByContact.set(i.contactId, list)
  }

  const nicknamesByContact = new Map<string, typeof allNicknames>()
  for (const n of allNicknames) {
    const list = nicknamesByContact.get(n.contactId) ?? []
    list.push(n)
    nicknamesByContact.set(n.contactId, list)
  }

  const notesByContact = new Map<string, typeof allNotes>()
  for (const n of allNotes) {
    const list = notesByContact.get(n.contactId) ?? []
    list.push(n)
    notesByContact.set(n.contactId, list)
  }

  const pidsByContact = new Map<string, typeof allPids>()
  for (const p of allPids) {
    const list = pidsByContact.get(p.contactId) ?? []
    list.push(p)
    pidsByContact.set(p.contactId, list)
  }

  return allContacts.map((contact) => {
    const nicknames = (nicknamesByContact.get(contact.id) ?? []).map((n) => ({ id: n.id, nickname: n.nickname }))
    return {
      ...contact,
      displayName: getContactDisplayName({
        firstName: contact.firstName,
        lastName: contact.lastName,
        nicknames,
      }),
      linkedUserName: contact.linkedUserId ? (userNames.get(contact.linkedUserId) ?? null) : null,
      nicknames,
      identifiers: (identifiersByContact.get(contact.id) ?? []).map((i) => ({ id: i.id, label: i.label, value: i.value })),
      notes: (notesByContact.get(contact.id) ?? []).map((n) => ({
        id: n.id, kinId: n.kinId, scope: n.scope, content: n.content, createdAt: n.createdAt, updatedAt: n.updatedAt,
      })),
      platformIds: (pidsByContact.get(contact.id) ?? []).map((p) => ({
        id: p.id, contactId: p.contactId, platform: p.platform, platformId: p.platformId,
        createdAt: new Date(p.createdAt).getTime(),
      })),
    }
  })
}

export async function createContact(input: CreateContactInput) {
  if (input.linkedUserId) {
    const existing = findContactByLinkedUserId(input.linkedUserId)
    if (existing) {
      const linkedContactName = getContactDisplayName({
        firstName: existing.firstName,
        lastName: existing.lastName,
      })
      return { error: 'USER_ALREADY_LINKED' as const, linkedContactName }
    }
  }

  const id = uuid()
  const now = new Date()

  const firstName = input.firstName?.trim() || null
  const lastName = input.lastName?.trim() || null
  const cleanNicknames = (input.nicknames ?? [])
    .map((n) => n.trim())
    .filter((n) => n.length > 0)

  db.insert(contacts).values({
    id,
    firstName,
    lastName,
    linkedUserId: input.linkedUserId ?? null,
    createdAt: now,
    updatedAt: now,
  }).run()

  for (const nickname of cleanNicknames) {
    db.insert(contactNicknames).values({
      id: uuid(),
      contactId: id,
      nickname,
      createdAt: now,
      updatedAt: now,
    }).run()
  }

  if (input.identifiers?.length) {
    for (const ident of input.identifiers) {
      db.insert(contactIdentifiers).values({
        id: uuid(),
        contactId: id,
        label: ident.label,
        value: ident.value,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  }

  const created = db.select().from(contacts).where(eq(contacts.id, id)).get()!
  const displayName = getContactDisplayName({
    firstName: created.firstName,
    lastName: created.lastName,
    nicknames: cleanNicknames,
  })

  sseManager.broadcast({
    type: 'contact:created',
    data: { contactId: id, displayName },
  })

  return created
}

export async function updateContact(contactId: string, updates: UpdateContactInput) {
  const existing = db.select().from(contacts).where(eq(contacts.id, contactId)).get()
  if (!existing) return null

  if (updates.linkedUserId) {
    const linked = findContactByLinkedUserId(updates.linkedUserId)
    if (linked && linked.id !== contactId) {
      const linkedContactName = getContactDisplayName({
        firstName: linked.firstName,
        lastName: linked.lastName,
      })
      return { error: 'USER_ALREADY_LINKED' as const, linkedContactName }
    }
  }

  db.update(contacts)
    .set({
      ...(updates.firstName !== undefined ? { firstName: updates.firstName?.trim() || null } : {}),
      ...(updates.lastName !== undefined ? { lastName: updates.lastName?.trim() || null } : {}),
      ...(updates.linkedUserId !== undefined ? { linkedUserId: updates.linkedUserId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, contactId))
    .run()

  const updated = db.select().from(contacts).where(eq(contacts.id, contactId)).get()!
  const displayName = getContactDisplayName({
    firstName: updated.firstName,
    lastName: updated.lastName,
  })

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId, displayName },
  })

  return updated
}

export async function deleteContact(contactId: string): Promise<boolean> {
  const existing = db.select().from(contacts).where(eq(contacts.id, contactId)).get()
  if (!existing) return false

  db.delete(contacts).where(eq(contacts.id, contactId)).run()

  sseManager.broadcast({
    type: 'contact:deleted',
    data: { contactId },
  })

  return true
}

// ─── Search ──────────────────────────────────────────────────────────────────

export async function searchContacts(
  query: string,
  kinId?: string,
): Promise<ContactWithDetails[]> {
  const pattern = `%${query}%`

  const byName = db
    .select({ id: contacts.id })
    .from(contacts)
    .where(or(like(contacts.firstName, pattern), like(contacts.lastName, pattern)))
    .all()

  const byNickname = db
    .select({ id: contactNicknames.contactId })
    .from(contactNicknames)
    .where(like(contactNicknames.nickname, pattern))
    .all()

  const byIdentifier = db
    .select({ id: contactIdentifiers.contactId })
    .from(contactIdentifiers)
    .where(or(like(contactIdentifiers.value, pattern), like(contactIdentifiers.label, pattern)))
    .all()

  let byNote
  if (kinId) {
    byNote = db
      .select({ id: contactNotes.contactId })
      .from(contactNotes)
      .where(
        and(
          like(contactNotes.content, pattern),
          or(eq(contactNotes.scope, 'global'), eq(contactNotes.kinId, kinId)),
        ),
      )
      .all()
  } else {
    byNote = db
      .select({ id: contactNotes.contactId })
      .from(contactNotes)
      .where(like(contactNotes.content, pattern))
      .all()
  }

  const uniqueIds = [...new Set([
    ...byName.map((r) => r.id),
    ...byNickname.map((r) => r.id),
    ...byIdentifier.map((r) => r.id),
    ...byNote.map((r) => r.id),
  ])]

  const results: ContactWithDetails[] = []
  for (const id of uniqueIds) {
    const detail = await getContactWithDetails(id, kinId)
    if (detail) results.push(detail)
  }

  return results
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

export function addContactIdentifier(contactId: string, label: string, value: string) {
  const existing = db.select().from(contactIdentifiers)
    .where(and(
      eq(contactIdentifiers.contactId, contactId),
      eq(contactIdentifiers.label, label),
      eq(contactIdentifiers.value, value),
    )).get()
  if (existing) return existing

  const now = new Date()
  const id = uuid()
  db.insert(contactIdentifiers).values({
    id,
    contactId,
    label,
    value,
    createdAt: now,
    updatedAt: now,
  }).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId },
  })

  return { id, contactId, label, value, createdAt: now, updatedAt: now }
}

export function updateContactIdentifier(identifierId: string, updates: { label?: string; value?: string }, contactId?: string) {
  const existing = db.select().from(contactIdentifiers).where(eq(contactIdentifiers.id, identifierId)).get()
  if (!existing) return null
  if (contactId && existing.contactId !== contactId) return null

  db.update(contactIdentifiers)
    .set({
      ...(updates.label !== undefined ? { label: updates.label } : {}),
      ...(updates.value !== undefined ? { value: updates.value } : {}),
      updatedAt: new Date(),
    })
    .where(eq(contactIdentifiers.id, identifierId))
    .run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId: existing.contactId },
  })

  return db.select().from(contactIdentifiers).where(eq(contactIdentifiers.id, identifierId)).get()!
}

export function removeContactIdentifier(identifierId: string, contactId?: string): boolean {
  const existing = db.select().from(contactIdentifiers).where(eq(contactIdentifiers.id, identifierId)).get()
  if (!existing) return false
  if (contactId && existing.contactId !== contactId) return false

  db.delete(contactIdentifiers).where(eq(contactIdentifiers.id, identifierId)).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId: existing.contactId },
  })

  return true
}

/**
 * Atomically replace all identifiers for a contact in a single SQLite transaction.
 */
export function replaceContactIdentifiers(
  contactId: string,
  identifiers: Array<{ label: string; value: string }>,
) {
  const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get()
  if (!contact) return null

  const now = new Date()
  const txn = sqlite.transaction(() => {
    db.delete(contactIdentifiers)
      .where(eq(contactIdentifiers.contactId, contactId))
      .run()

    for (const ident of identifiers) {
      db.insert(contactIdentifiers).values({
        id: uuid(),
        contactId,
        label: ident.label,
        value: ident.value,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
  txn()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId },
  })

  return db
    .select({ id: contactIdentifiers.id, label: contactIdentifiers.label, value: contactIdentifiers.value })
    .from(contactIdentifiers)
    .where(eq(contactIdentifiers.contactId, contactId))
    .all()
}

export function findContactByIdentifier(label: string, value: string) {
  const row = db
    .select({ contactId: contactIdentifiers.contactId })
    .from(contactIdentifiers)
    .where(and(eq(contactIdentifiers.label, label), eq(contactIdentifiers.value, value)))
    .get()

  return row ? db.select().from(contacts).where(eq(contacts.id, row.contactId)).get() : null
}

export function findContactByLinkedUserId(userId: string) {
  return db.select().from(contacts).where(eq(contacts.linkedUserId, userId)).get() ?? null
}

export function listContactIdentifiers(contactId: string) {
  return db
    .select({ id: contactIdentifiers.id, label: contactIdentifiers.label, value: contactIdentifiers.value })
    .from(contactIdentifiers)
    .where(eq(contactIdentifiers.contactId, contactId))
    .all()
}

// ─── Nicknames ───────────────────────────────────────────────────────────────

export function listContactNicknames(contactId: string) {
  return db
    .select({ id: contactNicknames.id, nickname: contactNicknames.nickname })
    .from(contactNicknames)
    .where(eq(contactNicknames.contactId, contactId))
    .all()
}

export function addContactNickname(contactId: string, nickname: string) {
  const existing = db.select().from(contactNicknames)
    .where(and(
      eq(contactNicknames.contactId, contactId),
      eq(contactNicknames.nickname, nickname),
    )).get()
  if (existing) return existing

  const now = new Date()
  const id = uuid()
  db.insert(contactNicknames).values({
    id,
    contactId,
    nickname,
    createdAt: now,
    updatedAt: now,
  }).run()

  sseManager.broadcast({ type: 'contact:updated', data: { contactId } })

  return { id, contactId, nickname, createdAt: now, updatedAt: now }
}

export function updateContactNickname(nicknameId: string, nickname: string, contactId?: string) {
  const existing = db.select().from(contactNicknames).where(eq(contactNicknames.id, nicknameId)).get()
  if (!existing) return null
  if (contactId && existing.contactId !== contactId) return null

  db.update(contactNicknames)
    .set({ nickname, updatedAt: new Date() })
    .where(eq(contactNicknames.id, nicknameId))
    .run()

  sseManager.broadcast({ type: 'contact:updated', data: { contactId: existing.contactId } })

  return db.select().from(contactNicknames).where(eq(contactNicknames.id, nicknameId)).get()!
}

export function removeContactNickname(nicknameId: string, contactId?: string): boolean {
  const existing = db.select().from(contactNicknames).where(eq(contactNicknames.id, nicknameId)).get()
  if (!existing) return false
  if (contactId && existing.contactId !== contactId) return false

  db.delete(contactNicknames).where(eq(contactNicknames.id, nicknameId)).run()

  sseManager.broadcast({ type: 'contact:updated', data: { contactId: existing.contactId } })

  return true
}

/**
 * Atomically replace all nicknames for a contact in a single SQLite transaction.
 */
export function replaceContactNicknames(contactId: string, nicknames: string[]) {
  const contact = db.select().from(contacts).where(eq(contacts.id, contactId)).get()
  if (!contact) return null

  const now = new Date()
  const txn = sqlite.transaction(() => {
    db.delete(contactNicknames).where(eq(contactNicknames.contactId, contactId)).run()
    for (const nickname of nicknames) {
      db.insert(contactNicknames).values({
        id: uuid(),
        contactId,
        nickname,
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
  txn()

  sseManager.broadcast({ type: 'contact:updated', data: { contactId } })

  return db
    .select({ id: contactNicknames.id, nickname: contactNicknames.nickname })
    .from(contactNicknames)
    .where(eq(contactNicknames.contactId, contactId))
    .all()
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export function setContactNote(contactId: string, kinId: string, scope: NoteScope, content: string) {
  const now = new Date()
  const existing = db
    .select()
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.contactId, contactId),
        eq(contactNotes.kinId, kinId),
        eq(contactNotes.scope, scope),
      ),
    )
    .get()

  if (existing) {
    db.update(contactNotes)
      .set({ content, updatedAt: now })
      .where(eq(contactNotes.id, existing.id))
      .run()

    sseManager.broadcast({
      type: 'contact:updated',
      data: { contactId },
    })

    return { ...existing, content, updatedAt: now }
  }

  const id = uuid()
  db.insert(contactNotes).values({
    id,
    contactId,
    kinId,
    scope,
    content,
    createdAt: now,
    updatedAt: now,
  }).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId },
  })

  return { id, contactId, kinId, scope, content, createdAt: now, updatedAt: now }
}

export function updateContactNote(noteId: string, content: string, contactId?: string) {
  const now = new Date()
  const existing = db.select().from(contactNotes).where(eq(contactNotes.id, noteId)).get()
  if (!existing) return null
  if (contactId && existing.contactId !== contactId) return null
  db.update(contactNotes).set({ content, updatedAt: now }).where(eq(contactNotes.id, noteId)).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId: existing.contactId },
  })

  return { ...existing, content, updatedAt: now }
}

export function deleteContactNote(noteId: string, contactId?: string) {
  const existing = db.select().from(contactNotes).where(eq(contactNotes.id, noteId)).get()
  if (!existing) return false
  if (contactId && existing.contactId !== contactId) return false
  db.delete(contactNotes).where(eq(contactNotes.id, noteId)).run()

  sseManager.broadcast({
    type: 'contact:updated',
    data: { contactId: existing.contactId },
  })

  return true
}

export function getVisibleNotes(contactId: string, kinId: string) {
  return db
    .select()
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.contactId, contactId),
        or(eq(contactNotes.scope, 'global'), eq(contactNotes.kinId, kinId)),
      ),
    )
    .all()
}

export function deleteNotesByKin(kinId: string) {
  db.delete(contactNotes).where(eq(contactNotes.kinId, kinId)).run()
}

// ─── Prompt helpers ──────────────────────────────────────────────────────────

export async function listContactsForPrompt(): Promise<ContactSummary[]> {
  const allContacts = db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      linkedUserId: contacts.linkedUserId,
    })
    .from(contacts)
    .all()

  return Promise.all(
    allContacts.map(async (c) => {
      let linkedUserName: string | null = null
      if (c.linkedUserId) {
        const profile = db.select({ pseudonym: userProfiles.pseudonym }).from(userProfiles)
          .where(eq(userProfiles.userId, c.linkedUserId)).get()
        linkedUserName = profile?.pseudonym ?? null
      }

      const nicknames = db
        .select({ nickname: contactNicknames.nickname })
        .from(contactNicknames)
        .where(eq(contactNicknames.contactId, c.id))
        .all()
        .map((n) => n.nickname)

      const identifiers = db
        .select({ label: contactIdentifiers.label })
        .from(contactIdentifiers)
        .where(eq(contactIdentifiers.contactId, c.id))
        .all()

      const identifierSummary = identifiers.map((i) => i.label).join(', ') || undefined

      return {
        id: c.id,
        displayName: getContactDisplayName({ firstName: c.firstName, lastName: c.lastName, nicknames }),
        firstName: c.firstName,
        lastName: c.lastName,
        nicknames,
        linkedUserName,
        identifierSummary,
      }
    }),
  )
}

// ─── User contact backfill ──────────────────────────────────────────────────

export async function ensureUserContactsExist() {
  const allUsers = db
    .select({
      id: user.id,
      email: user.email,
      firstName: userProfiles.firstName,
      lastName: userProfiles.lastName,
      pseudonym: userProfiles.pseudonym,
    })
    .from(user)
    .innerJoin(userProfiles, eq(user.id, userProfiles.userId))
    .all()

  for (const u of allUsers) {
    const existing = findContactByLinkedUserId(u.id)
    if (!existing) {
      await createContact({
        firstName: u.firstName,
        lastName: u.lastName,
        nicknames: u.pseudonym ? [u.pseudonym] : undefined,
        linkedUserId: u.id,
        identifiers: u.email ? [{ label: 'email', value: u.email }] : undefined,
      })
    }
  }
}
