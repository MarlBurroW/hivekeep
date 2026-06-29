/**
 * iCloud contacts provider (CardDAV) — preset Apple endpoint, app-specific
 * password auth. Shares the CardDAV core with the generic provider. Keyed
 * `icloud`, the same type as the iCloud EmailProvider, so one iCloud account
 * serves mail + contacts.
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

// Re-exported so existing tests (and callers) keep their import path.
export { parseVCard, vcardToContact, contactMatches } from '@/server/contacts/providers/carddav-core'

export const ICLOUD_CARDDAV_URL = 'https://contacts.icloud.com'

/** Shared iCloud config fields (apple_id + app password) — identical for the
 *  iCloud email and contacts providers so the unified Add form shows one set. */
export const ICLOUD_CONFIG_SCHEMA = [
  {
    key: 'apple_id',
    type: 'text' as const,
    label: 'Apple ID',
    required: true,
    placeholder: 'you@example.com',
    description: 'Your Apple ID (any email — used for Contacts & Calendar).',
  },
  {
    key: 'app_password',
    type: 'secret' as const,
    label: 'App-specific password',
    required: true,
    placeholder: 'xxxx-xxxx-xxxx-xxxx',
    description: 'Generate at appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
  },
  {
    key: 'icloud_email',
    type: 'text' as const,
    label: 'iCloud email (for Mail)',
    placeholder: 'you@icloud.com',
    description: 'Only if you enable Mail: your @icloud.com mailbox address (the IMAP login). Leave blank if your Apple ID is already an @icloud.com address.',
  },
]

function ops(config: ProviderConfig) {
  return cardDavOps(
    { serverUrl: ICLOUD_CARDDAV_URL, username: config.apple_id ?? '', password: config.app_password ?? '' },
    config.apple_id,
  )
}

export const icloudContactsProvider: ContactsProvider = {
  type: 'icloud',
  displayName: 'iCloud',
  reactIcon: 'si/SiIcloud',
  brandColor: '#3693F3',
  apiKeyUrl: 'https://appleid.apple.com/account/manage',
  configSchema: ICLOUD_CONFIG_SCHEMA,
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
