import { tool } from 'ai'
import { z } from 'zod'
import {
  getContactWithDetails,
  searchContacts,
  createContact,
  updateContact,
  deleteContact,
  addContactIdentifier,
  addContactNickname,
  setContactNote,
  findContactByIdentifier,
} from '@/server/services/contacts'
import { createLogger } from '@/server/logger'
import { getContactDisplayName } from '@/shared/contact-display'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:contacts')

/**
 * get_contact — retrieve full details of a contact.
 */
export const getContactTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  create: (ctx) =>
    tool({
      description:
        'Retrieve full details of a contact including identifiers, nicknames, and notes.',
      inputSchema: z.object({
        contact_id: z.string(),
      }),
      execute: async ({ contact_id }) => {
        const contact = await getContactWithDetails(contact_id, ctx.kinId)
        if (!contact) {
          return { error: 'Contact not found' }
        }
        return {
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          displayName: contact.displayName,
          nicknames: contact.nicknames.map((n) => n.nickname),
          identifiers: contact.identifiers,
          notes: contact.notes.map((n) => ({
            kinId: n.kinId,
            scope: n.scope,
            content: n.content,
          })),
          linkedUserId: contact.linkedUserId,
          createdAt: contact.createdAt.toISOString(),
          updatedAt: contact.updatedAt.toISOString(),
        }
      },
    }),
}

/**
 * search_contacts — search contacts by name, nickname, identifier or note content.
 */
export const searchContactsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  create: (ctx) =>
    tool({
      description:
        'Search contacts by first/last name, nickname, identifier value, or keywords in notes.',
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        const results = await searchContacts(query, ctx.kinId)
        return {
          contacts: results.map((c) => ({
            id: c.id,
            displayName: c.displayName,
            firstName: c.firstName,
            lastName: c.lastName,
            nicknames: c.nicknames.map((n) => n.nickname),
            identifiers: c.identifiers,
            notes: c.notes.map((n) => ({
              kinId: n.kinId,
              scope: n.scope,
              content: n.content,
            })),
          })),
        }
      },
    }),
}

/**
 * create_contact — create a new global contact with optional nicknames + identifiers.
 */
export const createContactTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Create a new contact in the shared registry. All Kins will see this contact. ' +
        'At least one of firstName, lastName, or a nickname must be provided.',
      inputSchema: z.object({
        firstName: z.string().optional().describe('Given name'),
        lastName: z.string().optional().describe('Family name'),
        nicknames: z
          .array(z.string())
          .optional()
          .describe('Alternative names / handles / pseudonyms the contact goes by'),
        identifiers: z
          .array(
            z.object({
              label: z.string().describe('e.g. "email", "phone", "WhatsApp", "Twitter"'),
              value: z.string(),
            }),
          )
          .optional(),
      }),
      execute: async ({ firstName, lastName, nicknames, identifiers }) => {
        log.debug({ kinId: ctx.kinId, firstName, lastName }, 'Contact creation requested')
        const result = await createContact({ firstName, lastName, nicknames, identifiers })
        if ('error' in result) {
          return { error: `User is already linked to contact "${result.linkedContactName}"` }
        }
        return {
          id: result.id,
          firstName: result.firstName,
          lastName: result.lastName,
          displayName: getContactDisplayName({
            firstName: result.firstName,
            lastName: result.lastName,
            nicknames,
          }),
        }
      },
    }),
}

/**
 * update_contact — update names and/or add nicknames + identifiers (additive).
 */
export const updateContactTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        "Update a contact's first/last name and/or append nicknames and identifiers. Nicknames and identifiers are additive only.",
      inputSchema: z.object({
        contact_id: z.string(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        nicknames: z
          .array(z.string())
          .optional()
          .describe('Nicknames to append (existing nicknames are preserved)'),
        identifiers: z
          .array(
            z.object({
              label: z.string().describe('e.g. "email", "mobile", "WhatsApp"'),
              value: z.string(),
            }),
          )
          .optional(),
      }),
      execute: async ({ contact_id, firstName, lastName, nicknames, identifiers }) => {
        const updated = await updateContact(contact_id, { firstName, lastName })
        if (!updated) {
          return { error: 'Contact not found' }
        }
        if ('error' in updated) {
          return { error: `Cannot update: user is already linked to contact "${updated.linkedContactName}"` }
        }
        if (nicknames?.length) {
          for (const nick of nicknames) {
            const trimmed = nick.trim()
            if (trimmed) addContactNickname(contact_id, trimmed)
          }
        }
        if (identifiers?.length) {
          for (const ident of identifiers) {
            addContactIdentifier(contact_id, ident.label, ident.value)
          }
        }
        return {
          id: updated.id,
          firstName: updated.firstName,
          lastName: updated.lastName,
          displayName: getContactDisplayName({
            firstName: updated.firstName,
            lastName: updated.lastName,
          }),
        }
      },
    }),
}

/**
 * delete_contact — permanently delete a contact and all its identifiers, nicknames and notes.
 */
export const deleteContactTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Permanently delete a contact and all its identifiers, nicknames and notes. Only use when explicitly asked.',
      inputSchema: z.object({
        contact_id: z.string(),
      }),
      execute: async ({ contact_id }) => {
        log.debug({ kinId: ctx.kinId, contactId: contact_id }, 'Contact deletion requested')
        const deleted = await deleteContact(contact_id)
        if (!deleted) {
          return { error: 'Contact not found' }
        }
        return { success: true }
      },
    }),
}

/**
 * set_contact_note — write or replace a private or global note on a contact.
 */
export const setContactNoteTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Write or replace a note on a contact. One private and one global note per Kin per contact.',
      inputSchema: z.object({
        contact_id: z.string(),
        scope: z.enum(['private', 'global']).describe('"private" = only you; "global" = all Kins'),
        content: z.string().describe('Replaces any existing note of the same scope'),
      }),
      execute: async ({ contact_id, scope, content }) => {
        log.debug({ kinId: ctx.kinId, contactId: contact_id, scope }, 'Contact note set')
        const note = setContactNote(contact_id, ctx.kinId, scope, content)
        return {
          contactId: note.contactId,
          scope: note.scope,
          content: note.content,
        }
      },
    }),
}

/**
 * find_contact_by_identifier — look up a contact by identifier label and value.
 */
export const findContactByIdentifierTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  create: (ctx) =>
    tool({
      description:
        'Find a contact by identifier (exact match). Use to check for duplicates before creating.',
      inputSchema: z.object({
        label: z.string().describe('e.g. "email", "phone", "whatsapp", "discord"'),
        value: z.string(),
      }),
      execute: async ({ label, value }) => {
        const contact = findContactByIdentifier(label, value)
        if (!contact) {
          return { found: false, message: `No contact found with ${label}: ${value}` }
        }
        return {
          found: true,
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          displayName: getContactDisplayName({
            firstName: contact.firstName,
            lastName: contact.lastName,
          }),
        }
      },
    }),
}
