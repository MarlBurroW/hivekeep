import { Hono } from 'hono'
import {
  listContactsWithDetails,
  getContactWithDetails,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  addContactIdentifier,
  updateContactIdentifier,
  removeContactIdentifier,
  replaceContactIdentifiers,
  addContactNickname,
  updateContactNickname,
  removeContactNickname,
  replaceContactNicknames,
  setContactNote,
  updateContactNote,
  deleteContactNote,
} from '@/server/services/contacts'
import {
  listContactPlatformIds,
  removeContactPlatformId,
  addContactPlatformId,
} from '@/server/services/channels'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:contacts')
const contactRoutes = new Hono()

// GET /api/contacts — list all contacts with identifiers and notes (admin view)
contactRoutes.get('/', async (c) => {
  const contactsWithDetails = await listContactsWithDetails()
  return c.json({ contacts: contactsWithDetails })
})

// GET /api/contacts/:id — full contact detail (identifiers + all notes for admin view)
contactRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const contact = await getContactWithDetails(id) // no kinId → admin view shows all notes
  if (!contact) {
    return c.json({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } }, 404)
  }
  return c.json({ contact })
})

const NAME_FIELD_MAX = 100

function validateNameField(value: unknown, field: string) {
  if (value === undefined || value === null) return { ok: true as const, value: null }
  if (typeof value !== 'string') {
    return { ok: false as const, message: `${field} must be a string` }
  }
  const trimmed = value.trim()
  if (trimmed.length > NAME_FIELD_MAX) {
    return { ok: false as const, message: `${field} must be ${NAME_FIELD_MAX} characters or less` }
  }
  return { ok: true as const, value: trimmed || null }
}

// POST /api/contacts — create a new contact
contactRoutes.post('/', async (c) => {
  const { firstName, lastName, nicknames, linkedUserId, identifiers } = (await c.req.json()) as {
    firstName?: string | null
    lastName?: string | null
    nicknames?: string[]
    linkedUserId?: string
    identifiers?: Array<{ label: string; value: string }>
  }

  const firstCheck = validateNameField(firstName, 'firstName')
  if (!firstCheck.ok) {
    return c.json({ error: { code: 'INVALID_INPUT', message: firstCheck.message } }, 400)
  }
  const lastCheck = validateNameField(lastName, 'lastName')
  if (!lastCheck.ok) {
    return c.json({ error: { code: 'INVALID_INPUT', message: lastCheck.message } }, 400)
  }

  const cleanNicknames = Array.isArray(nicknames)
    ? nicknames.map((n) => (typeof n === 'string' ? n.trim() : '')).filter((n) => n.length > 0)
    : []

  for (const nick of cleanNicknames) {
    if (nick.length > NAME_FIELD_MAX) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: `Nickname must be ${NAME_FIELD_MAX} characters or less` } },
        400,
      )
    }
  }

  if (!firstCheck.value && !lastCheck.value && cleanNicknames.length === 0) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'At least one of firstName, lastName, or a nickname is required' } },
      400,
    )
  }

  const result = await createContact({
    firstName: firstCheck.value,
    lastName: lastCheck.value,
    nicknames: cleanNicknames,
    linkedUserId,
    identifiers,
  })
  if ('error' in result) {
    return c.json(
      { error: { code: 'USER_ALREADY_LINKED', message: `This user is already linked to contact "${result.linkedContactName}"` } },
      409,
    )
  }
  log.info({ contactId: result.id }, 'Contact created')
  return c.json({ contact: result }, 201)
})

// PATCH /api/contacts/:id — update basic info
contactRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json()) as {
    firstName?: string | null
    lastName?: string | null
    linkedUserId?: string | null
  }

  const updates: { firstName?: string | null; lastName?: string | null; linkedUserId?: string | null } = {}

  if (body.firstName !== undefined) {
    const check = validateNameField(body.firstName, 'firstName')
    if (!check.ok) {
      return c.json({ error: { code: 'INVALID_INPUT', message: check.message } }, 400)
    }
    updates.firstName = check.value
  }

  if (body.lastName !== undefined) {
    const check = validateNameField(body.lastName, 'lastName')
    if (!check.ok) {
      return c.json({ error: { code: 'INVALID_INPUT', message: check.message } }, 400)
    }
    updates.lastName = check.value
  }

  if (body.linkedUserId !== undefined) {
    updates.linkedUserId = body.linkedUserId
  }

  const result = await updateContact(id, updates)
  if (!result) {
    return c.json({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } }, 404)
  }
  if ('error' in result && result.error === 'USER_ALREADY_LINKED') {
    return c.json({ error: { code: 'USER_ALREADY_LINKED', message: `This user is already linked to contact "${result.linkedContactName}"` } }, 409)
  }

  return c.json({ contact: result })
})

// DELETE /api/contacts/:id — delete a contact (cascades identifiers + nicknames + notes)
contactRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')

  const deleted = await deleteContact(id)
  if (!deleted) {
    return c.json({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } }, 404)
  }

  log.info({ contactId: id }, 'Contact deleted')
  return c.json({ success: true })
})

// ─── Nicknames ───────────────────────────────────────────────────────────────

// PUT /api/contacts/:id/nicknames — atomically replace all nicknames
contactRoutes.put('/:id/nicknames', async (c) => {
  const contactId = c.req.param('id')
  const { nicknames } = (await c.req.json()) as { nicknames: string[] }

  if (!Array.isArray(nicknames)) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'nicknames must be an array' } },
      400,
    )
  }

  const cleaned: string[] = []
  for (const raw of nicknames) {
    if (typeof raw !== 'string') {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: 'Each nickname must be a string' } },
        400,
      )
    }
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.length > NAME_FIELD_MAX) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: `Nickname must be ${NAME_FIELD_MAX} characters or less` } },
        400,
      )
    }
    cleaned.push(trimmed)
  }

  const result = replaceContactNicknames(contactId, cleaned)
  if (result === null) {
    return c.json({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } }, 404)
  }

  return c.json({ nicknames: result })
})

// POST /api/contacts/:id/nicknames — add a nickname
contactRoutes.post('/:id/nicknames', async (c) => {
  const contactId = c.req.param('id')
  const { nickname } = (await c.req.json()) as { nickname: string }
  const trimmed = nickname?.trim()

  if (!trimmed) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Nickname is required' } },
      400,
    )
  }
  if (trimmed.length > NAME_FIELD_MAX) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: `Nickname must be ${NAME_FIELD_MAX} characters or less` } },
      400,
    )
  }

  const added = addContactNickname(contactId, trimmed)
  return c.json({ nickname: added }, 201)
})

// PATCH /api/contacts/:id/nicknames/:nickId — update a nickname
contactRoutes.patch('/:id/nicknames/:nickId', async (c) => {
  const contactId = c.req.param('id')
  const nickId = c.req.param('nickId')
  const { nickname } = (await c.req.json()) as { nickname: string }
  const trimmed = nickname?.trim()

  if (!trimmed) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'Nickname cannot be empty' } }, 400)
  }
  if (trimmed.length > NAME_FIELD_MAX) {
    return c.json({ error: { code: 'INVALID_INPUT', message: `Nickname must be ${NAME_FIELD_MAX} characters or less` } }, 400)
  }

  const updated = updateContactNickname(nickId, trimmed, contactId)
  if (!updated) {
    return c.json({ error: { code: 'NICKNAME_NOT_FOUND', message: 'Nickname not found' } }, 404)
  }
  return c.json({ nickname: updated })
})

// DELETE /api/contacts/:id/nicknames/:nickId — remove a nickname
contactRoutes.delete('/:id/nicknames/:nickId', async (c) => {
  const contactId = c.req.param('id')
  const nickId = c.req.param('nickId')

  const removed = removeContactNickname(nickId, contactId)
  if (!removed) {
    return c.json({ error: { code: 'NICKNAME_NOT_FOUND', message: 'Nickname not found' } }, 404)
  }
  return c.json({ success: true })
})

// ─── Identifiers ─────────────────────────────────────────────────────────────

// PUT /api/contacts/:id/identifiers — atomically replace all identifiers
contactRoutes.put('/:id/identifiers', async (c) => {
  const contactId = c.req.param('id')
  const { identifiers } = (await c.req.json()) as {
    identifiers: Array<{ label: string; value: string }>
  }

  if (!Array.isArray(identifiers)) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'identifiers must be an array' } },
      400,
    )
  }

  for (const ident of identifiers) {
    const trimmedLabel = ident.label?.trim()
    const trimmedValue = ident.value?.trim()
    if (!trimmedLabel || !trimmedValue) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: 'Each identifier must have a non-empty label and value' } },
        400,
      )
    }
    if (trimmedLabel.length > 100) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: 'Label must be 100 characters or less' } },
        400,
      )
    }
    if (trimmedValue.length > 500) {
      return c.json(
        { error: { code: 'INVALID_INPUT', message: 'Value must be 500 characters or less' } },
        400,
      )
    }
    ident.label = trimmedLabel
    ident.value = trimmedValue
  }

  const result = replaceContactIdentifiers(contactId, identifiers)
  if (result === null) {
    return c.json({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } }, 404)
  }

  return c.json({ identifiers: result })
})

// POST /api/contacts/:id/identifiers — add an identifier
contactRoutes.post('/:id/identifiers', async (c) => {
  const contactId = c.req.param('id')
  const { label, value } = (await c.req.json()) as { label: string; value: string }

  const trimmedLabel = label?.trim()
  const trimmedValue = value?.trim()

  if (!trimmedLabel || !trimmedValue) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Label and value are required and cannot be whitespace-only' } },
      400,
    )
  }

  if (trimmedLabel.length > 100) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Label must be 100 characters or less' } },
      400,
    )
  }

  if (trimmedValue.length > 500) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Value must be 500 characters or less' } },
      400,
    )
  }

  const identifier = addContactIdentifier(contactId, trimmedLabel, trimmedValue)
  return c.json({ identifier }, 201)
})

// PATCH /api/contacts/:id/identifiers/:identifierId — update an identifier
contactRoutes.patch('/:id/identifiers/:identifierId', async (c) => {
  const contactId = c.req.param('id')
  const identifierId = c.req.param('identifierId')
  const body = (await c.req.json()) as { label?: string; value?: string }

  if (body.label !== undefined) {
    const trimmed = body.label.trim()
    if (!trimmed) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Label cannot be empty' } }, 400)
    }
    if (trimmed.length > 100) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Label must be 100 characters or less' } }, 400)
    }
    body.label = trimmed
  }

  if (body.value !== undefined) {
    const trimmed = body.value.trim()
    if (!trimmed) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Value cannot be empty' } }, 400)
    }
    if (trimmed.length > 500) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Value must be 500 characters or less' } }, 400)
    }
    body.value = trimmed
  }

  const updated = updateContactIdentifier(identifierId, body, contactId)
  if (!updated) {
    return c.json({ error: { code: 'IDENTIFIER_NOT_FOUND', message: 'Identifier not found' } }, 404)
  }

  return c.json({ identifier: updated })
})

// DELETE /api/contacts/:id/identifiers/:identifierId — remove an identifier
contactRoutes.delete('/:id/identifiers/:identifierId', async (c) => {
  const contactId = c.req.param('id')
  const identifierId = c.req.param('identifierId')

  const removed = removeContactIdentifier(identifierId, contactId)
  if (!removed) {
    return c.json(
      { error: { code: 'IDENTIFIER_NOT_FOUND', message: 'Identifier not found' } },
      404,
    )
  }

  return c.json({ success: true })
})

// ─── Platform IDs (channel authorization) ───────────────────────────────────

// GET /api/contacts/:id/platform-ids — list platform IDs for a contact
contactRoutes.get('/:id/platform-ids', async (c) => {
  const contactId = c.req.param('id')
  const platformIds = listContactPlatformIds(contactId)
  return c.json({
    platformIds: platformIds.map((p) => ({
      id: p.id,
      contactId: p.contactId,
      platform: p.platform,
      platformId: p.platformId,
      createdAt: new Date(p.createdAt).getTime(),
    })),
  })
})

// POST /api/contacts/:id/platform-ids — add a platform ID to a contact
contactRoutes.post('/:id/platform-ids', async (c) => {
  const contactId = c.req.param('id')
  const { platform, platformId } = (await c.req.json()) as { platform: string; platformId: string }

  if (!platform || !platformId) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'platform and platformId are required' } },
      400,
    )
  }

  const contact = await getContact(contactId)
  if (!contact) {
    return c.json(
      { error: { code: 'CONTACT_NOT_FOUND', message: 'Contact not found' } },
      404,
    )
  }

  try {
    const entry = addContactPlatformId(contactId, platform, platformId)
    return c.json({ platformId: entry }, 201)
  } catch (err) {
    return c.json(
      { error: { code: 'DUPLICATE_PLATFORM_ID', message: 'This platform ID is already assigned to a contact' } },
      409,
    )
  }
})

// DELETE /api/contacts/:id/platform-ids/:pidId — remove a platform ID (revoke access)
contactRoutes.delete('/:id/platform-ids/:pidId', async (c) => {
  const contactId = c.req.param('id')
  const pidId = c.req.param('pidId')

  const removed = removeContactPlatformId(pidId, contactId)
  if (!removed) {
    return c.json(
      { error: { code: 'NOT_FOUND', message: 'Platform ID not found' } },
      404,
    )
  }

  return c.json({ success: true })
})

// ─── Notes ──────────────────────────────────────────────────────────────────

// POST /api/contacts/:id/notes — create/upsert a note (admin creates on behalf of a kin)
contactRoutes.post('/:id/notes', async (c) => {
  const contactId = c.req.param('id')
  const { kinId, scope, content } = (await c.req.json()) as {
    kinId: string
    scope: 'private' | 'global'
    content: string
  }

  if (!kinId || !scope || !content?.trim()) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'kinId, scope and content are required' } },
      400,
    )
  }

  const trimmedContent = content.trim()
  if (trimmedContent.length > 10000) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Note content must be 10,000 characters or less' } },
      400,
    )
  }

  const note = setContactNote(contactId, kinId, scope, trimmedContent)
  return c.json({ note }, 201)
})

// PATCH /api/contacts/:id/notes/:noteId — update a note's content
contactRoutes.patch('/:id/notes/:noteId', async (c) => {
  const contactId = c.req.param('id')
  const noteId = c.req.param('noteId')
  const { content } = (await c.req.json()) as { content: string }

  if (!content?.trim()) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Content is required' } },
      400,
    )
  }

  const trimmedContent = content.trim()
  if (trimmedContent.length > 10000) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Note content must be 10,000 characters or less' } },
      400,
    )
  }

  const updated = updateContactNote(noteId, trimmedContent, contactId)
  if (!updated) {
    return c.json({ error: { code: 'NOTE_NOT_FOUND', message: 'Note not found' } }, 404)
  }

  return c.json({ note: updated })
})

// DELETE /api/contacts/:id/notes/:noteId — delete a note
contactRoutes.delete('/:id/notes/:noteId', async (c) => {
  const contactId = c.req.param('id')
  const noteId = c.req.param('noteId')

  const deleted = deleteContactNote(noteId, contactId)
  if (!deleted) {
    return c.json({ error: { code: 'NOTE_NOT_FOUND', message: 'Note not found' } }, 404)
  }

  return c.json({ success: true })
})

export { contactRoutes }
