/**
 * iCloud contacts provider (CardDAV).
 *
 * Read-only address-book access over Apple's CardDAV endpoint. Auth is an
 * Apple ID + an **app-specific password** (generated at appleid.apple.com) —
 * iCloud has no OAuth/REST for contacts. CardDAV plumbing is handled by
 * `tsdav`; vCards are parsed by the pure `parseVCard` helper below.
 *
 * A contact id is the vCard's CardDAV href (stable within the account).
 */
import { createDAVClient } from 'tsdav'
import type {
  ContactsProvider,
  ContactListOptions,
  ContactListResult,
  Contact,
  ContactPhone,
  ContactEmailAddress,
  ContactSearchQuery,
} from '@/server/contacts/types'
import type { ProviderConfig, AuthResult } from '@kinbot-developer/sdk'

const ICLOUD_CARDDAV_URL = 'https://contacts.icloud.com'

// ─── Pure vCard parsing (exported for tests) ─────────────────────────────────

interface ParsedVCard {
  fn?: string
  family?: string
  given?: string
  org?: string
  phones: ContactPhone[]
  emails: ContactEmailAddress[]
}

function unescapeValue(v: string): string {
  return v
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/** RFC 6350 line unfolding: a leading space/tab continues the previous line. */
function unfoldLines(raw: string): string[] {
  const physical = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

function normalizeType(types: string[]): string | undefined {
  const t = types.map((s) => s.toLowerCase())
  if (t.some((x) => ['cell', 'iphone', 'mobile'].includes(x))) return 'mobile'
  if (t.includes('home')) return 'home'
  if (t.includes('work')) return 'work'
  if (t.includes('main')) return 'main'
  return t.find((x) => x !== 'voice' && x !== 'pref' && x !== 'internet') || undefined
}

export function parseVCard(raw: string): ParsedVCard {
  const result: ParsedVCard = { phones: [], emails: [] }
  for (const line of unfoldLines(raw)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const left = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const segments = left.split(';')
    let name = segments[0] ?? ''
    // Strip a group prefix (iCloud uses `item1.TEL`, `item2.EMAIL`, …).
    const dot = name.lastIndexOf('.')
    if (dot >= 0) name = name.slice(dot + 1)
    name = name.toUpperCase()

    const types: string[] = []
    for (const p of segments.slice(1)) {
      const eq = p.indexOf('=')
      if (eq >= 0) {
        const key = p.slice(0, eq).toUpperCase()
        if (key === 'TYPE') types.push(...p.slice(eq + 1).split(',').map((s) => s.replace(/"/g, '')))
      } else {
        types.push(p) // vCard 3 bare param, e.g. TEL;CELL;VOICE:
      }
    }

    switch (name) {
      case 'FN':
        result.fn = unescapeValue(value).trim()
        break
      case 'N': {
        const comps = value.split(';')
        result.family = unescapeValue(comps[0] ?? '').trim() || undefined
        result.given = unescapeValue(comps[1] ?? '').trim() || undefined
        break
      }
      case 'ORG':
        result.org = unescapeValue(value.split(';')[0] ?? '').trim() || undefined
        break
      case 'TEL': {
        const number = value.trim()
        if (number) result.phones.push({ number, type: normalizeType(types) })
        break
      }
      case 'EMAIL': {
        const email = value.trim()
        if (email) result.emails.push({ email, type: normalizeType(types) })
        break
      }
    }
  }
  return result
}

export function vcardToContact(url: string, raw: string, addressBook?: string): Contact {
  const p = parseVCard(raw)
  const displayName = p.fn || [p.given, p.family].filter(Boolean).join(' ').trim() || '(no name)'
  return {
    id: url,
    displayName,
    givenName: p.given,
    familyName: p.family,
    organization: p.org,
    phones: p.phones,
    emails: p.emails,
    addressBook,
  }
}

const onlyDigits = (s: string) => s.replace(/\D/g, '')

/** Client-side match for a free-text term (iCloud CardDAV server search is
 *  unreliable, so we list + filter). */
export function contactMatches(c: Contact, term: string): boolean {
  if (!term) return true
  const t = term.toLowerCase()
  if (c.displayName.toLowerCase().includes(t)) return true
  if (c.organization?.toLowerCase().includes(t)) return true
  if (c.emails.some((e) => e.email.toLowerCase().includes(t))) return true
  const digits = onlyDigits(term)
  if (digits.length >= 3 && c.phones.some((p) => onlyDigits(p.number).includes(digits))) return true
  return false
}

// ─── CardDAV plumbing ────────────────────────────────────────────────────────

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>

async function withClient<T>(config: ProviderConfig, fn: (client: DAVClient) => Promise<T>): Promise<T> {
  const client = await createDAVClient({
    serverUrl: ICLOUD_CARDDAV_URL,
    credentials: { username: config.apple_id ?? '', password: config.app_password ?? '' },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  })
  return fn(client)
}

interface DAVBook {
  url: string
  displayName?: string | Record<string, unknown>
}

function bookName(book: DAVBook): string | undefined {
  return typeof book.displayName === 'string' ? book.displayName : undefined
}

function cardToContact(card: { url: string; data?: unknown }, book: DAVBook): Contact | null {
  if (typeof card.data !== 'string' || !card.data.includes('BEGIN:VCARD')) return null
  return vcardToContact(card.url, card.data, bookName(book))
}

async function collectContacts(client: DAVClient): Promise<Contact[]> {
  const books = (await client.fetchAddressBooks()) as DAVBook[]
  const out: Contact[] = []
  for (const book of books) {
    const cards = await client.fetchVCards({ addressBook: book as never })
    for (const card of cards) {
      const c = cardToContact(card, book)
      if (c) out.push(c)
    }
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return out
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const icloudContactsProvider: ContactsProvider = {
  type: 'icloud',
  displayName: 'iCloud',
  reactIcon: 'si/SiIcloud',
  brandColor: '#3693F3',
  apiKeyUrl: 'https://appleid.apple.com/account/manage',
  configSchema: [
    {
      key: 'apple_id',
      type: 'text',
      label: 'Apple ID',
      required: true,
      placeholder: 'you@icloud.com',
      description: 'The Apple ID email of the iCloud account.',
    },
    {
      key: 'app_password',
      type: 'secret',
      label: 'App-specific password',
      required: true,
      placeholder: 'xxxx-xxxx-xxxx-xxxx',
      description: 'Generate at appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
    },
  ],
  capabilities: {
    supportsOAuth: false,
    supportsServerSearch: false,
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      await withClient(config, async (client) => {
        await client.fetchAddressBooks()
      })
      return { valid: true, accountLabel: config.apple_id }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'iCloud authentication failed' }
    }
  },

  async listContacts(options: ContactListOptions, config: ProviderConfig): Promise<ContactListResult> {
    return withClient(config, async (client) => {
      const all = await collectContacts(client)
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
      const offset = options.pageToken ? parseInt(options.pageToken, 10) || 0 : 0
      const page = all.slice(offset, offset + limit)
      const nextPageToken = offset + limit < all.length ? String(offset + limit) : undefined
      return { contacts: page, nextPageToken }
    })
  },

  async getContact(id: string, config: ProviderConfig): Promise<Contact> {
    return withClient(config, async (client) => {
      const books = (await client.fetchAddressBooks()) as DAVBook[]
      const book = books.find((b) => id.startsWith(b.url)) ?? books[0]
      if (!book) throw new Error('No iCloud address book found')
      const cards = await client.fetchVCards({ addressBook: book as never, objectUrls: [id] })
      const card = cards.find((c) => c.url === id) ?? cards[0]
      const contact = card ? cardToContact(card, book) : null
      if (!contact) throw new Error(`Contact not found: ${id}`)
      return contact
    })
  },

  async searchContacts(query: ContactSearchQuery, config: ProviderConfig): Promise<Contact[]> {
    const term = (query.raw || query.text || '').trim()
    return withClient(config, async (client) => {
      const all = await collectContacts(client)
      return all.filter((c) => contactMatches(c, term)).slice(0, 50)
    })
  },
}
