/**
 * Generic CardDAV contacts provider — any CardDAV server (OVH, Fastmail, Nextcloud,
 * …) by URL + username + password. Shares the CardDAV core with iCloud.
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
  return cardDavOps(
    {
      serverUrl: config.server_url ?? '',
      username: config.username ?? '',
      password: config.password ?? '',
    },
    config.username,
  )
}

export const genericCardDavProvider: ContactsProvider = {
  type: 'carddav',
  displayName: 'CardDAV',
  reactIcon: 'md/MdContacts',
  brandColor: '#64748b',
  configSchema: [
    {
      key: 'server_url',
      type: 'url',
      label: 'CardDAV server URL',
      required: true,
      placeholder: 'https://carddav.example.com',
      description: 'The CardDAV endpoint of your provider (e.g. OVH, Fastmail, Nextcloud).',
    },
    { key: 'username', type: 'text', label: 'Username', required: true, placeholder: 'you@example.com' },
    {
      key: 'password',
      type: 'secret',
      label: 'Password',
      required: true,
      placeholder: 'password or app password',
      description: 'Many providers require an app-specific password.',
    },
  ],
  capabilities: { supportsOAuth: false, supportsServerSearch: false },

  authenticate(config: ProviderConfig): Promise<AuthResult> {
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
