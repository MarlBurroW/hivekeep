/**
 * Generic IMAP + SMTP email provider.
 *
 * Unlike Gmail / Microsoft this is NOT OAuth — the user supplies host/port/login
 * for an IMAP server (reading) and an SMTP server (sending), declared via
 * `configSchema`. The host validates + encrypts those fields and hands them back
 * as `ProviderConfig` on every call; there is no token to refresh.
 *
 * Reading uses `imapflow`; sending uses `nodemailer`; MIME parsing uses
 * `mailparser`. A message id is folder-scoped (`<mailbox>:<uid>`) because IMAP
 * UIDs are unique only within a mailbox.
 */
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import type {
  EmailProvider,
  EmailListOptions,
  EmailListResult,
  EmailSummary,
  EmailFull,
  EmailAddress,
  EmailAttachment,
  EmailSearchQuery,
  EmailFolder,
  SendEmailParams,
  SendEmailResult,
} from '@/server/email/types'
import type { ProviderConfig, AuthResult } from '@gezy/sdk'
import { stripMessageId } from '@/shared/account-triggers'

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

export function parsePort(value: string | undefined, fallback: number): number {
  const n = value ? parseInt(value, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** A message id is `<mailbox>:<uid>`; the mailbox may itself contain a colon
 *  (e.g. "[Gmail]/Sent"), so split on the LAST colon. */
export function formatMessageId(mailbox: string, uid: number): string {
  return `${mailbox}:${uid}`
}

export function parseMessageId(id: string): { mailbox: string; uid: number } {
  const i = id.lastIndexOf(':')
  if (i < 0) throw new Error(`Invalid IMAP message id: ${id}`)
  const uid = parseInt(id.slice(i + 1), 10)
  if (!Number.isFinite(uid)) throw new Error(`Invalid IMAP message id: ${id}`)
  return { mailbox: id.slice(0, i), uid }
}

const FOLDER_ALIASES: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  draft: 'Drafts',
  trash: 'Trash',
  spam: 'Junk',
  junk: 'Junk',
}

export function resolveFolder(folder: string | undefined): string {
  if (!folder) return 'INBOX'
  return FOLDER_ALIASES[folder.toLowerCase()] ?? folder
}

interface ImapSearchObject {
  from?: string
  to?: string
  subject?: string
  body?: string
  seen?: boolean
  since?: Date
  before?: Date
}

/** Translate a structured query into an imapflow search object. `raw` is treated
 *  as a free-text body search (IMAP has no provider-native query string). */
export function buildImapSearch(q: EmailSearchQuery | undefined): ImapSearchObject {
  const c: ImapSearchObject = {}
  if (!q) return c
  if (q.raw) {
    c.body = q.raw
    return c
  }
  if (q.from) c.from = q.from
  if (q.to) c.to = q.to
  if (q.subject) c.subject = q.subject
  if (q.text) c.body = q.text
  if (q.unread) c.seen = false
  if (q.after) c.since = new Date(q.after)
  if (q.before) c.before = new Date(q.before)
  return c
}

interface AddressObject {
  address?: string
  name?: string
}

function toAddr(a: AddressObject | undefined): EmailAddress | undefined {
  if (!a?.address) return undefined
  return { email: a.address, name: a.name || undefined }
}

function toAddrList(list: AddressObject[] | undefined): EmailAddress[] {
  return (list ?? []).map(toAddr).filter((a): a is EmailAddress => !!a)
}

interface BodyStructureNode {
  disposition?: string
  childNodes?: BodyStructureNode[]
}

/** Walk an imapflow bodyStructure looking for an attachment disposition. */
export function structureHasAttachments(node: BodyStructureNode | undefined): boolean {
  if (!node) return false
  if (node.disposition?.toLowerCase() === 'attachment') return true
  return (node.childNodes ?? []).some(structureHasAttachments)
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ─── Connection plumbing ─────────────────────────────────────────────────────

interface ImapEnvelope {
  uid: number
  envelope?: {
    subject?: string
    date?: Date
    from?: AddressObject[]
    to?: AddressObject[]
    inReplyTo?: string
  }
  internalDate?: Date
  flags?: Set<string>
  bodyStructure?: BodyStructureNode
}

function imapUsername(config: ProviderConfig): string {
  return config.username || config.email || ''
}

function makeImapClient(config: ProviderConfig): ImapFlow {
  const port = parsePort(config.imap_port, 993)
  return new ImapFlow({
    host: config.imap_host ?? '',
    port,
    secure: port === 993, // 143/587 → STARTTLS, negotiated by imapflow
    auth: { user: imapUsername(config), pass: config.password ?? '' },
    logger: false,
    // Fail fast on a wrong host/port instead of hanging the tool call.
    socketTimeout: 30_000,
    greetingTimeout: 15_000,
    connectionTimeout: 15_000,
  })
}

function makeSmtpTransport(config: ProviderConfig) {
  const port = parsePort(config.smtp_port, 587)
  return nodemailer.createTransport({
    host: config.smtp_host ?? '',
    port,
    secure: port === 465, // 587/25 → STARTTLS
    auth: { user: imapUsername(config), pass: config.password ?? '' },
  })
}

/** Open a mailbox, run `fn`, always release the lock + logout. */
async function withMailbox<T>(
  config: ProviderConfig,
  mailbox: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = makeImapClient(config)
  await client.connect()
  try {
    const lock = await client.getMailboxLock(mailbox)
    try {
      return await fn(client)
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => {})
  }
}

function envelopeToSummary(msg: ImapEnvelope, mailbox: string): EmailSummary {
  const env = msg.envelope ?? {}
  const inReplyTo = stripMessageId(env.inReplyTo)
  return {
    id: formatMessageId(mailbox, msg.uid),
    from: toAddr(env.from?.[0]),
    to: toAddrList(env.to),
    subject: env.subject || '(no subject)',
    date: env.date?.getTime() ?? msg.internalDate?.getTime() ?? 0,
    unread: msg.flags ? !msg.flags.has('\\Seen') : undefined,
    hasAttachments: structureHasAttachments(msg.bodyStructure),
    labels: [mailbox],
    ...(inReplyTo ? { inReplyTo } : {}),
  }
}

const FETCH_SUMMARY = { envelope: true, flags: true, internalDate: true, bodyStructure: true } as const

// ─── Provider ────────────────────────────────────────────────────────────────

export const imapProvider: EmailProvider = {
  type: 'imap',
  displayName: 'IMAP / SMTP',
  reactIcon: 'md/MdEmail',
  brandColor: '#64748b',
  configSchema: [
    { key: 'email', type: 'text', label: 'Email address', required: true, placeholder: 'you@example.com' },
    { key: 'imap_host', type: 'text', label: 'IMAP host', required: true, placeholder: 'imap.example.com' },
    { key: 'imap_port', type: 'text', label: 'IMAP port', default: '993', placeholder: '993' },
    { key: 'smtp_host', type: 'text', label: 'SMTP host', required: true, placeholder: 'smtp.example.com' },
    { key: 'smtp_port', type: 'text', label: 'SMTP port', default: '587', placeholder: '587' },
    {
      key: 'username',
      type: 'text',
      label: 'Username',
      placeholder: 'defaults to the email address',
      description: 'Login for both IMAP and SMTP. Leave blank to use the email address.',
    },
    {
      key: 'password',
      type: 'secret',
      label: 'Password',
      required: true,
      placeholder: 'password or app password',
      description: 'Many providers require an app-specific password.',
    },
    {
      key: 'carddav_url',
      type: 'url',
      label: 'CardDAV URL (optional)',
      placeholder: 'https://carddav.example.com',
      description: 'Only needed if you enable Contacts for this account.',
    },
    {
      key: 'caldav_url',
      type: 'url',
      label: 'CalDAV URL (optional)',
      placeholder: 'https://caldav.example.com',
      description: 'Only needed if you enable Calendar for this account.',
    },
  ],
  capabilities: {
    supportsOAuth: false,
    supportsServerSearch: true,
    supportsLabels: false,
    supportsThreads: false,
    maxAttachmentMb: 25,
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    // Probe both halves so the user learns immediately which one is misconfigured.
    const client = makeImapClient(config)
    try {
      await client.connect()
      await client.logout().catch(() => {})
    } catch (err) {
      return { valid: false, error: `IMAP: ${err instanceof Error ? err.message : 'connection failed'}` }
    }
    try {
      await makeSmtpTransport(config).verify()
    } catch (err) {
      return { valid: false, error: `SMTP: ${err instanceof Error ? err.message : 'connection failed'}` }
    }
    return { valid: true, accountLabel: config.email }
  },

  async listMessages(options: EmailListOptions, config: ProviderConfig): Promise<EmailListResult> {
    const mailbox = resolveFolder(options.folder)
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)

    return withMailbox(config, mailbox, async (client) => {
      const messages: EmailSummary[] = []

      if (options.query) {
        const uids = (await client.search(buildImapSearch(options.query), { uid: true })) || []
        // Newest first; cap to the requested page.
        const page = uids.sort((a, b) => b - a).slice(0, limit)
        if (page.length === 0) return { messages }
        for await (const msg of client.fetch(page, FETCH_SUMMARY, { uid: true })) {
          messages.push(envelopeToSummary(msg as unknown as ImapEnvelope, mailbox))
        }
        messages.sort((a, b) => b.date - a.date)
        let filtered = messages
        if (options.query.hasAttachment) filtered = filtered.filter((m) => m.hasAttachments)
        return { messages: filtered }
      }

      // No query: page by sequence number, newest first.
      const total = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.exists : 0
      const upper = options.pageToken ? parsePort(options.pageToken, total) : total
      if (!upper || upper < 1) return { messages }
      const start = Math.max(1, upper - limit + 1)
      for await (const msg of client.fetch(`${start}:${upper}`, FETCH_SUMMARY)) {
        messages.push(envelopeToSummary(msg as unknown as ImapEnvelope, mailbox))
      }
      messages.sort((a, b) => b.date - a.date)
      return { messages, nextPageToken: start > 1 ? String(start - 1) : undefined }
    })
  },

  async getMessage(id: string, config: ProviderConfig): Promise<EmailFull> {
    const { mailbox, uid } = parseMessageId(id)
    return withMailbox(config, mailbox, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true, flags: true }, { uid: true })
      if (!msg || !msg.source) throw new Error(`Message not found: ${id}`)
      const parsed = await simpleParser(msg.source)

      const attachments: EmailAttachment[] = (parsed.attachments ?? []).map((a, i) => ({
        id: String(i),
        filename: a.filename || `attachment-${i}`,
        mimeType: a.contentType || 'application/octet-stream',
        size: a.size,
      }))
      const html = typeof parsed.html === 'string' ? parsed.html : undefined
      const body = parsed.text || (html ? htmlToText(html) : '')

      return {
        id,
        from: toAddr(parsed.from?.value?.[0] as AddressObject | undefined),
        to: toAddrList(parsed.to ? ([] as AddressObject[]).concat((parsed.to as { value: AddressObject[] }).value) : []),
        cc: toAddrList(parsed.cc ? ([] as AddressObject[]).concat((parsed.cc as { value: AddressObject[] }).value) : []),
        subject: parsed.subject || '(no subject)',
        date: parsed.date?.getTime() ?? 0,
        unread: (msg.flags as Set<string> | undefined) ? !(msg.flags as Set<string>).has('\\Seen') : undefined,
        body,
        bodyHtml: html,
        hasAttachments: attachments.length > 0,
        attachments,
        labels: [mailbox],
      }
    })
  },

  async searchMessages(query: EmailSearchQuery, config: ProviderConfig): Promise<EmailSummary[]> {
    const res = await this.listMessages({ query, limit: 25 }, config)
    return res.messages
  },

  async listFolders(config: ProviderConfig): Promise<EmailFolder[]> {
    const client = makeImapClient(config)
    await client.connect()
    try {
      const boxes = await client.list()
      return boxes
        .filter((b) => b.path && !b.flags?.has('\\Noselect'))
        .map((b) => ({ id: b.path, name: b.name || b.path, type: 'folder' as const }))
    } finally {
      await client.logout().catch(() => {})
    }
  },

  async sendMessage(params: SendEmailParams, config: ProviderConfig): Promise<SendEmailResult> {
    const transport = makeSmtpTransport(config)
    const fmt = (a: EmailAddress) => (a.name ? `"${a.name}" <${a.email}>` : a.email)
    const info = await transport.sendMail({
      from: config.email,
      to: params.to.map(fmt),
      cc: params.cc?.map(fmt),
      bcc: params.bcc?.map(fmt),
      subject: params.subject,
      text: params.body,
      html: params.bodyHtml,
      attachments: params.attachments?.map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.contentBase64, 'base64'),
        contentType: att.mimeType,
      })),
    })
    return { id: info.messageId ?? '' }
  },

  async getAttachment(messageId: string, attachmentId: string, config: ProviderConfig) {
    const { mailbox, uid } = parseMessageId(messageId)
    return withMailbox(config, mailbox, async (client) => {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error(`Message not found: ${messageId}`)
      const parsed = await simpleParser(msg.source)
      const att = (parsed.attachments ?? [])[Number(attachmentId)]
      if (!att) throw new Error(`Attachment not found: ${attachmentId}`)
      return { contentBase64: Buffer.from(att.content).toString('base64') }
    })
  },
}
