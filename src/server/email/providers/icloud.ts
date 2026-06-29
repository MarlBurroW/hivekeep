/**
 * iCloud email provider — IMAP/SMTP against Apple's preset servers, app-specific
 * password auth. Reuses the generic IMAP provider's logic; the user only enters
 * an Apple ID + app password (no host/port). Keyed `icloud`, the same type as
 * the iCloud ContactsProvider, so one iCloud account serves mail + contacts.
 */
import { imapProvider } from '@/server/email/providers/imap'
import { ICLOUD_CONFIG_SCHEMA } from '@/server/contacts/providers/icloud'
import type {
  EmailProvider,
  EmailListOptions,
  EmailListResult,
  EmailFull,
  EmailSearchQuery,
  EmailSummary,
  SendEmailParams,
  SendEmailResult,
} from '@/server/email/types'
import type { ProviderConfig, AuthResult } from '@gezy/sdk'

/** Map the iCloud credentials onto the generic IMAP provider's config keys,
 *  with Apple's well-known mail servers. */
function imapConfig(config: ProviderConfig): ProviderConfig {
  // iCloud Mail logs in with the @icloud.com mailbox address, which may differ
  // from the Apple ID (e.g. a Hotmail Apple ID). Fall back to the Apple ID when
  // the Apple ID is itself an @icloud.com address.
  const id = config.icloud_email || config.apple_id || config.email || config.email_address || ''
  return {
    ...config,
    email: id,
    username: id,
    password: config.app_password ?? config.password ?? '',
    imap_host: 'imap.mail.me.com',
    imap_port: '993',
    smtp_host: 'smtp.mail.me.com',
    smtp_port: '587',
  }
}

export const icloudEmailProvider: EmailProvider = {
  type: 'icloud',
  displayName: 'iCloud',
  reactIcon: 'si/SiIcloud',
  brandColor: '#3693F3',
  apiKeyUrl: 'https://appleid.apple.com/account/manage',
  configSchema: ICLOUD_CONFIG_SCHEMA,
  capabilities: imapProvider.capabilities,

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    // Label the account by the Apple ID (the stable identity shared with the
    // iCloud contacts/calendar providers) so one iCloud account stays one row.
    const result = await imapProvider.authenticate(imapConfig(config))
    return { ...result, accountLabel: config.apple_id ?? result.accountLabel }
  },
  listMessages(options: EmailListOptions, config: ProviderConfig): Promise<EmailListResult> {
    return imapProvider.listMessages(options, imapConfig(config))
  },
  getMessage(id: string, config: ProviderConfig): Promise<EmailFull> {
    return imapProvider.getMessage(id, imapConfig(config))
  },
  searchMessages(query: EmailSearchQuery, config: ProviderConfig): Promise<EmailSummary[]> {
    return imapProvider.searchMessages!(query, imapConfig(config))
  },
  sendMessage(params: SendEmailParams, config: ProviderConfig): Promise<SendEmailResult> {
    return imapProvider.sendMessage(params, imapConfig(config))
  },
  getAttachment(messageId: string, attachmentId: string, config: ProviderConfig) {
    return imapProvider.getAttachment!(messageId, attachmentId, imapConfig(config))
  },
}
