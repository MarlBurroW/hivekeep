/**
 * Microsoft 365 / Outlook contacts provider (Microsoft Graph `/me/contacts`).
 *
 * Same identity (`type: 'microsoft'`) as the Microsoft EmailProvider — one
 * connected account serves mail + contacts. Declares the contacts OAuth scope
 * (`Contacts.Read`); the host unions it with the email scopes at connect time.
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

const GRAPH = 'https://graph.microsoft.com/v1.0'

// ─── Pure mapping (exported for tests) ───────────────────────────────────────

interface GraphContact {
  id: string
  displayName?: string
  givenName?: string
  surname?: string
  companyName?: string
  emailAddresses?: Array<{ address?: string; name?: string }>
  mobilePhone?: string
  homePhones?: string[]
  businessPhones?: string[]
}

export function graphContactToContact(c: GraphContact): Contact {
  const phones: ContactPhone[] = []
  if (c.mobilePhone) phones.push({ number: c.mobilePhone, type: 'mobile' })
  for (const p of c.homePhones ?? []) if (p) phones.push({ number: p, type: 'home' })
  for (const p of c.businessPhones ?? []) if (p) phones.push({ number: p, type: 'work' })
  const emails: ContactEmailAddress[] = (c.emailAddresses ?? [])
    .filter((e) => e.address)
    .map((e) => ({ email: e.address! }))
  const displayName =
    c.displayName || [c.givenName, c.surname].filter(Boolean).join(' ').trim() || '(no name)'
  return {
    id: c.id,
    displayName,
    givenName: c.givenName,
    familyName: c.surname,
    organization: c.companyName || undefined,
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

// ─── Graph plumbing ──────────────────────────────────────────────────────────

async function graphFetch(config: ProviderConfig, path: string): Promise<unknown> {
  const token = config.accessToken
  if (!token) throw new Error('Microsoft: missing access token')
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Microsoft Graph ${res.status} on ${path}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const SELECT = '$select=id,displayName,givenName,surname,companyName,emailAddresses,mobilePhone,homePhones,businessPhones'

// ─── Provider ────────────────────────────────────────────────────────────────

export const microsoftContactsProvider: ContactsProvider = {
  type: 'microsoft',
  displayName: 'Outlook',
  reactIcon: 'bi/BiLogoMicrosoft',
  brandColor: '#0078D4',
  configSchema: [],
  capabilities: { supportsOAuth: true, supportsServerSearch: false },
  oauth: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'openid',
      'email',
      'offline_access',
      'https://graph.microsoft.com/Contacts.Read',
      'https://graph.microsoft.com/User.Read',
    ],
    authorizeParams: { prompt: 'select_account' },
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      await graphFetch(config, '/me/contacts?$top=1')
      return { valid: true, accountLabel: config.email_address ?? config.account_label }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Microsoft contacts auth failed' }
    }
  },

  async listContacts(options: ContactListOptions, config: ProviderConfig): Promise<ContactListResult> {
    const path = options.pageToken
      ? options.pageToken
      : `/me/contacts?${SELECT}&$top=${Math.min(Math.max(options.limit ?? 50, 1), 100)}&$orderby=displayName`
    const page = (await graphFetch(config, path)) as { value?: GraphContact[]; '@odata.nextLink'?: string }
    return {
      contacts: (page.value ?? []).map(graphContactToContact),
      nextPageToken: page['@odata.nextLink'],
    }
  },

  async getContact(id: string, config: ProviderConfig): Promise<Contact> {
    const c = (await graphFetch(config, `/me/contacts/${id}?${SELECT}`)) as GraphContact
    return graphContactToContact(c)
  },

  async searchContacts(query: ContactSearchQuery, config: ProviderConfig): Promise<Contact[]> {
    // Graph contact $search is quirky; list a page and filter client-side.
    const term = (query.raw || query.text || '').trim()
    const page = (await graphFetch(config, `/me/contacts?${SELECT}&$top=100&$orderby=displayName`)) as {
      value?: GraphContact[]
    }
    return (page.value ?? []).map(graphContactToContact).filter((c) => contactMatches(c, term))
  },
}
