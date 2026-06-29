/**
 * CardDAV contacts for a generic IMAP account — keyed `imap`, the same type as
 * the generic IMAP email provider, so one IMAP/SMTP connection can also serve
 * contacts when the user supplies a CardDAV server URL. Reads `carddav_url` +
 * the shared username/password from the account config; the connect form is
 * driven by the IMAP email provider's schema (this provider declares none).
 */
import { cardDavOps } from '@/server/contacts/providers/carddav-core'
import type {
  ContactsProvider,
  ContactListOptions,
  ContactListResult,
  Contact,
  ContactSearchQuery,
} from '@/server/contacts/types'
import type { ProviderConfig, AuthResult } from '@gezy/sdk'

function ops(config: ProviderConfig) {
  const serverUrl = config.carddav_url ?? ''
  if (!serverUrl) throw new Error('CardDAV server URL (carddav_url) is required to read contacts for this account')
  return cardDavOps(
    { serverUrl, username: config.username ?? config.email ?? '', password: config.password ?? '' },
    config.username ?? config.email,
  )
}

export const imapContactsProvider: ContactsProvider = {
  type: 'imap',
  displayName: 'IMAP / CardDAV',
  reactIcon: 'md/MdEmail',
  brandColor: '#64748b',
  configSchema: [],
  capabilities: { supportsOAuth: false, supportsServerSearch: false },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    if (!config.carddav_url) {
      return { valid: false, error: 'Enter a CardDAV server URL to enable contacts for this account.' }
    }
    return ops(config).authenticate()
  },
  listContacts(options: ContactListOptions, config: ProviderConfig): Promise<ContactListResult> {
    return ops(config).listContacts(options)
  },
  getContact(id: string, config: ProviderConfig): Promise<Contact> {
    return ops(config).getContact(id)
  },
  searchContacts(query: ContactSearchQuery, config: ProviderConfig): Promise<Contact[]> {
    return ops(config).searchContacts(query)
  },
}
