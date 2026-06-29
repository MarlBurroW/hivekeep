/**
 * Google contacts provider (People API `people/me/connections`).
 *
 * Same identity (`type: 'gmail'`) as the Gmail EmailProvider — one connected
 * Google account serves mail + contacts. Declares the contacts OAuth scope
 * (`contacts.readonly`); the host unions it with the Gmail scopes at connect.
 */
import type {
  ContactsProvider,
  ContactListOptions,
  ContactListResult,
  Contact,
  ContactPhone,
  ContactEmailAddress,
  ContactSearchQuery,
} from '@/server/contacts/types'
import type { ProviderConfig, AuthResult } from '@gezy/sdk'

const PEOPLE = 'https://people.googleapis.com/v1'
const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations'

// ─── Pure mapping (exported for tests) ───────────────────────────────────────

interface GooglePerson {
  resourceName?: string
  names?: Array<{ displayName?: string; givenName?: string; familyName?: string }>
  emailAddresses?: Array<{ value?: string; type?: string }>
  phoneNumbers?: Array<{ value?: string; type?: string; formattedType?: string }>
  organizations?: Array<{ name?: string }>
}

function normalizePhoneType(type?: string): string | undefined {
  const t = type?.toLowerCase()
  if (!t) return undefined
  if (t === 'cell' || t === 'mobile') return 'mobile'
  return t
}

export function personToContact(p: GooglePerson): Contact {
  const name = p.names?.[0]
  const phones: ContactPhone[] = (p.phoneNumbers ?? [])
    .filter((n) => n.value)
    .map((n) => ({ number: n.value!, type: normalizePhoneType(n.type) }))
  const emails: ContactEmailAddress[] = (p.emailAddresses ?? [])
    .filter((e) => e.value)
    .map((e) => ({ email: e.value!, type: e.type }))
  const displayName =
    name?.displayName || [name?.givenName, name?.familyName].filter(Boolean).join(' ').trim() || '(no name)'
  return {
    id: p.resourceName ?? '',
    displayName,
    givenName: name?.givenName,
    familyName: name?.familyName,
    organization: p.organizations?.[0]?.name || undefined,
    phones,
    emails,
  }
}

export function contactMatches(c: Contact, term: string): boolean {
  if (!term) return true
  const t = term.toLowerCase()
  const digits = term.replace(/\D/g, '')
  return (
    c.displayName.toLowerCase().includes(t) ||
    !!c.organization?.toLowerCase().includes(t) ||
    c.emails.some((e) => e.email.toLowerCase().includes(t)) ||
    (digits.length >= 3 && c.phones.some((p) => p.number.replace(/\D/g, '').includes(digits)))
  )
}

// ─── People API plumbing ─────────────────────────────────────────────────────

async function peopleFetch(config: ProviderConfig, path: string): Promise<unknown> {
  const token = config.accessToken
  if (!token) throw new Error('Google: missing access token')
  const res = await fetch(path.startsWith('http') ? path : `${PEOPLE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Google People ${res.status} on ${path}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const googleContactsProvider: ContactsProvider = {
  type: 'gmail',
  displayName: 'Gmail',
  reactIcon: 'si/SiGmail',
  brandColor: '#EA4335',
  configSchema: [],
  capabilities: { supportsOAuth: true, supportsServerSearch: false },
  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/contacts.readonly',
    ],
    authorizeParams: { access_type: 'offline', prompt: 'select_account consent' },
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      await peopleFetch(config, `/people/me/connections?personFields=names&pageSize=1`)
      return { valid: true, accountLabel: config.email_address ?? config.account_label }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Google contacts auth failed' }
    }
  },

  async listContacts(options: ContactListOptions, config: ProviderConfig): Promise<ContactListResult> {
    const size = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const params = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: String(size), sortOrder: 'FIRST_NAME_ASCENDING' })
    if (options.pageToken) params.set('pageToken', options.pageToken)
    const page = (await peopleFetch(config, `/people/me/connections?${params.toString()}`)) as {
      connections?: GooglePerson[]
      nextPageToken?: string
    }
    return {
      contacts: (page.connections ?? []).map(personToContact),
      nextPageToken: page.nextPageToken,
    }
  },

  async getContact(id: string, config: ProviderConfig): Promise<Contact> {
    const p = (await peopleFetch(config, `/${id}?personFields=${PERSON_FIELDS}`)) as GooglePerson
    return personToContact({ ...p, resourceName: p.resourceName ?? id })
  },

  async searchContacts(query: ContactSearchQuery, config: ProviderConfig): Promise<Contact[]> {
    // People searchContacts needs a warmup + readMask dance; list + filter is
    // simpler and reliable for personal address books.
    const term = (query.raw || query.text || '').trim()
    const all: Contact[] = []
    let pageToken: string | undefined
    do {
      const res = await this.listContacts({ limit: 200, pageToken }, config)
      all.push(...res.contacts)
      pageToken = res.nextPageToken
    } while (pageToken && all.length < 1000)
    return all.filter((c) => contactMatches(c, term))
  },
}
