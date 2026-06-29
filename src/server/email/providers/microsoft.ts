/**
 * Native Microsoft 365 / Outlook email provider (Microsoft Graph).
 *
 * Same EmailProvider contract as Gmail, but a JSON message model instead of raw
 * MIME — Graph's /me/sendMail takes a structured message + base64 fileAttachments.
 * Auth rides the host's generic OAuth2 flow (the provider only declares its
 * endpoints + scopes); the host injects a fresh `config.accessToken`.
 */
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

const GRAPH = 'https://graph.microsoft.com/v1.0'

// ─── Pure helpers (exported for tests) ───────────────────────────────────────

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string }
}

export function graphToAddr(r: GraphRecipient | undefined): EmailAddress | undefined {
  const a = r?.emailAddress
  if (!a?.address) return undefined
  return { email: a.address, name: a.name || undefined }
}

export function addrToGraph(a: EmailAddress): GraphRecipient {
  return { emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } }
}

/** Build the JSON body for POST /me/sendMail. */
export function buildSendPayload(params: SendEmailParams): Record<string, unknown> {
  const message: Record<string, unknown> = {
    subject: params.subject,
    body: params.bodyHtml
      ? { contentType: 'HTML', content: params.bodyHtml }
      : { contentType: 'Text', content: params.body },
    toRecipients: params.to.map(addrToGraph),
  }
  if (params.cc?.length) message.ccRecipients = params.cc.map(addrToGraph)
  if (params.bcc?.length) message.bccRecipients = params.bcc.map(addrToGraph)
  if (params.attachments?.length) {
    message.attachments = params.attachments.map((att) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: att.mimeType,
      contentBytes: att.contentBase64,
    }))
  }
  return { message, saveToSentItems: true }
}

/** Translate a structured query into a Graph KQL `$search` string. `raw` wins. */
export function buildGraphSearch(q: EmailSearchQuery | undefined): string {
  if (!q) return ''
  if (q.raw) return q.raw
  const parts: string[] = []
  if (q.from) parts.push(`from:${q.from}`)
  if (q.to) parts.push(`to:${q.to}`)
  if (q.subject) parts.push(`subject:${q.subject}`)
  if (q.text) parts.push(q.text)
  return parts.join(' ')
}

const FOLDER_ALIASES: Record<string, string> = {
  inbox: 'inbox',
  sent: 'sentitems',
  drafts: 'drafts',
  spam: 'junkemail',
  junk: 'junkemail',
  trash: 'deleteditems',
}

function resolveFolder(folder: string | undefined): string {
  if (!folder) return 'inbox'
  return FOLDER_ALIASES[folder.toLowerCase()] ?? folder
}

interface GraphMessage {
  id: string
  conversationId?: string
  subject?: string
  bodyPreview?: string
  receivedDateTime?: string
  isRead?: boolean
  hasAttachments?: boolean
  from?: GraphRecipient
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  bccRecipients?: GraphRecipient[]
  body?: { contentType?: string; content?: string }
  attachments?: Array<{ id: string; name?: string; contentType?: string; size?: number }>
}

export function graphMessageToSummary(m: GraphMessage): EmailSummary {
  return {
    id: m.id,
    threadId: m.conversationId,
    from: graphToAddr(m.from),
    to: (m.toRecipients ?? []).map(graphToAddr).filter((a): a is EmailAddress => !!a),
    subject: m.subject ?? '(no subject)',
    snippet: m.bodyPreview,
    date: m.receivedDateTime ? Date.parse(m.receivedDateTime) : 0,
    unread: m.isRead === false,
    hasAttachments: m.hasAttachments,
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ─── Graph plumbing ──────────────────────────────────────────────────────────

async function graphFetch(config: ProviderConfig, pathOrUrl: string, init?: RequestInit): Promise<unknown> {
  const token = config.accessToken
  if (!token) throw new Error('Microsoft: missing access token')
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Microsoft Graph ${res.status} on ${pathOrUrl}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const SUMMARY_SELECT =
  '$select=id,conversationId,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,from,toRecipients'

// ─── Provider ────────────────────────────────────────────────────────────────

export const microsoftProvider: EmailProvider = {
  type: 'microsoft',
  displayName: 'Outlook',
  reactIcon: 'bi/BiLogoMicrosoft',
  brandColor: '#0078D4',
  apiKeyUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  configSchema: [],
  capabilities: {
    supportsOAuth: true,
    supportsServerSearch: true,
    supportsLabels: false,
    supportsThreads: false,
    maxAttachmentMb: 25,
  },
  oauth: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'openid',
      'email',
      'offline_access',
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.Send',
      'https://graph.microsoft.com/User.Read',
    ],
    authorizeParams: { prompt: 'select_account' },
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      const me = (await graphFetch(config, '/me')) as { mail?: string; userPrincipalName?: string }
      return { valid: true, accountLabel: me.mail ?? me.userPrincipalName }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Microsoft auth failed' }
    }
  },

  async listMessages(options: EmailListOptions, config: ProviderConfig): Promise<EmailListResult> {
    if (options.pageToken) {
      const page = (await graphFetch(config, options.pageToken)) as {
        value?: GraphMessage[]
        '@odata.nextLink'?: string
      }
      return {
        messages: (page.value ?? []).map(graphMessageToSummary),
        nextPageToken: page['@odata.nextLink'],
      }
    }

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
    const search = buildGraphSearch(options.query)
    const params = [`$top=${limit}`, SUMMARY_SELECT]
    if (search) {
      // $search can't combine with $orderby — results come back by relevance.
      params.push(`$search="${encodeURIComponent(search)}"`)
    } else {
      params.push('$orderby=receivedDateTime desc')
    }
    const folder = resolveFolder(options.folder)
    const page = (await graphFetch(config, `/me/mailFolders/${folder}/messages?${params.join('&')}`)) as {
      value?: GraphMessage[]
      '@odata.nextLink'?: string
    }
    let messages = (page.value ?? []).map(graphMessageToSummary)
    // Graph $search has no unread predicate — apply it client-side when asked.
    if (options.query?.unread) messages = messages.filter((m) => m.unread)
    return { messages, nextPageToken: page['@odata.nextLink'] }
  },

  async getMessage(id: string, config: ProviderConfig): Promise<EmailFull> {
    const m = (await graphFetch(
      config,
      `/me/messages/${id}?$expand=attachments($select=id,name,contentType,size)`,
    )) as GraphMessage
    const summary = graphMessageToSummary(m)
    const isHtml = m.body?.contentType?.toLowerCase() === 'html'
    const content = m.body?.content ?? ''
    const attachments: EmailAttachment[] = (m.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.name ?? a.id,
      mimeType: a.contentType ?? 'application/octet-stream',
      size: a.size,
    }))
    return {
      ...summary,
      cc: (m.ccRecipients ?? []).map(graphToAddr).filter((a): a is EmailAddress => !!a),
      bcc: (m.bccRecipients ?? []).map(graphToAddr).filter((a): a is EmailAddress => !!a),
      body: isHtml ? htmlToText(content) : content,
      bodyHtml: isHtml ? content : undefined,
      hasAttachments: attachments.length > 0,
      attachments,
    }
  },

  async searchMessages(query: EmailSearchQuery, config: ProviderConfig): Promise<EmailSummary[]> {
    const res = await this.listMessages({ query, limit: 25 }, config)
    return res.messages
  },

  async listFolders(config: ProviderConfig): Promise<EmailFolder[]> {
    const res = (await graphFetch(config, '/me/mailFolders?$top=100')) as {
      value?: Array<{ id: string; displayName?: string }>
    }
    return (res.value ?? [])
      .filter((f) => f.id)
      .map((f) => ({ id: f.id, name: f.displayName || f.id, type: 'folder' as const }))
  },

  async sendMessage(params: SendEmailParams, config: ProviderConfig): Promise<SendEmailResult> {
    await graphFetch(config, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify(buildSendPayload(params)),
    })
    // Graph's sendMail returns 202 with no message id.
    return { id: '' }
  },

  async getAttachment(messageId: string, attachmentId: string, config: ProviderConfig) {
    const att = (await graphFetch(config, `/me/messages/${messageId}/attachments/${attachmentId}`)) as {
      contentBytes?: string
    }
    if (!att.contentBytes) throw new Error('Microsoft: attachment has no content')
    return { contentBase64: att.contentBytes }
  },
}
