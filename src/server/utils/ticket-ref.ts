/**
 * Ticket reference parsing and resolution.
 *
 * A ticket can be addressed via three formats (see projects.md § Slug projet + numéro):
 *
 *   1. UUID legacy            — `9ba56654-c252-4a23-afa9-d6d227f2d05b`
 *   2. Qualified slug#number  — `kinbot#42`
 *   3. Bare number            — `42` or `#42` (resolved against an active project)
 *
 * Resolution order: UUID → qualified slug → bare number with active project.
 *
 * The resolver here does NOT touch the database. It splits parsing (pure) from
 * lookup (async, defined in src/server/services/tickets.ts).
 */

import { isUUID } from '@/server/utils/slug'
import { PROJECT_SLUG_REGEX } from '@/shared/constants'

/** Strongly-typed parsed reference. */
export type TicketRef =
  | { kind: 'uuid'; id: string }
  | { kind: 'qualified'; slug: string; number: number }
  | { kind: 'bare'; number: number }
  | { kind: 'invalid'; raw: string }

/**
 * Parse a free-form ticket identifier into one of the three canonical shapes.
 *
 * Whitespace is trimmed. Leading `#` on a bare number is tolerated. Empty
 * strings and malformed inputs return `{ kind: 'invalid' }` so callers can
 * surface a clear error.
 */
export function parseTicketRef(input: string): TicketRef {
  const raw = (input ?? '').trim()
  if (!raw) return { kind: 'invalid', raw }

  // 1. UUID legacy — matched first so a UUID never accidentally gets parsed as
  //    a slug containing digits and dashes.
  if (isUUID(raw)) return { kind: 'uuid', id: raw }

  // 2. Qualified slug#number
  const qualified = /^([a-z][a-z0-9-]{1,31})#(\d{1,10})$/.exec(raw)
  if (qualified) {
    const slug = qualified[1]!
    const num = Number(qualified[2]!)
    if (PROJECT_SLUG_REGEX.test(slug) && Number.isInteger(num) && num > 0) {
      return { kind: 'qualified', slug, number: num }
    }
    return { kind: 'invalid', raw }
  }

  // 3. Bare number (with optional `#` prefix)
  const bare = /^#?(\d{1,10})$/.exec(raw)
  if (bare) {
    const num = Number(bare[1]!)
    if (Number.isInteger(num) && num > 0) return { kind: 'bare', number: num }
  }

  return { kind: 'invalid', raw }
}

/**
 * Error codes emitted by ticket resolution. UI / tools format these for the
 * end user; structured codes make tests easy.
 */
export const TICKET_RESOLUTION_ERRORS = {
  INVALID_REF: 'INVALID_TICKET_REF',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  NO_ACTIVE_PROJECT: 'NO_ACTIVE_PROJECT',
} as const

export type TicketResolutionErrorCode =
  (typeof TICKET_RESOLUTION_ERRORS)[keyof typeof TICKET_RESOLUTION_ERRORS]

/** Build the human-readable message for a resolution failure. */
export function ticketResolutionMessage(
  code: TicketResolutionErrorCode,
  context: { raw?: string; slug?: string; number?: number } = {},
): string {
  switch (code) {
    case 'INVALID_TICKET_REF':
      return `Invalid ticket reference "${context.raw ?? ''}". Expected a UUID, a qualified id like "kinbot#42", or a bare number like "#42".`
    case 'PROJECT_NOT_FOUND':
      return `Project '${context.slug ?? ''}' not found.`
    case 'NO_ACTIVE_PROJECT':
      return `No active project. Use set_active_project() first, or qualify the ticket as 'projectSlug#number'.`
    case 'TICKET_NOT_FOUND':
      if (context.slug && context.number !== undefined) {
        return `Ticket #${context.number} not found in project '${context.slug}'.`
      }
      if (context.number !== undefined) {
        return `Ticket #${context.number} not found.`
      }
      return `Ticket not found.`
    default:
      return `Ticket resolution failed (${code}).`
  }
}
