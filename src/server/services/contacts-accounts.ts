/**
 * Contacts accounts service.
 *
 * A contacts account is a row in the `providers` table with capability
 * `contacts` (type = 'icloud' | future Google/Microsoft). Read-only external
 * address books — these never enter Hivekeep's own contacts store. Credentials
 * live encrypted in the row's config; the tools resolve an account and hand the
 * provider a ProviderConfig with just what it needs.
 */
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { encrypt, decrypt } from '@/server/services/encryption'
import { generateProviderSlug } from '@/server/services/provider-slug'
import { getContactsProvider } from '@/server/contacts/registry'
import { getFreshAccessToken } from '@/server/services/email-token-manager'
import { createLogger } from '@/server/logger'
import type { ContactsProvider } from '@/server/contacts/types'
import type { ProviderConfig } from '@gezy/sdk'

const log = createLogger('contacts-accounts')

/**
 * Decrypted shape stored in `providers.config_encrypted`. This is the SHARED
 * connected-account shape — a single row may serve several capabilities
 * (email + contacts + …), so a contacts account created via OAuth (Google /
 * Microsoft) carries `email_address` + `refresh_token`, while a CardDAV account
 * carries `account_label` + `credentials`.
 */
interface ContactsAccountConfig {
  /** Display label. Falls back to `email_address` for OAuth identities. */
  account_label?: string
  email_address?: string
  /** OAuth identities — durable refresh token. */
  refresh_token?: string
  scopes?: string[]
  /** Non-OAuth (CardDAV) connection credentials declared by `configSchema`. */
  credentials?: Record<string, string>
  /** null / absent / empty = global (any Agent with the contacts toolbox). A
   *  non-empty list restricts the account to those Agent ids. */
  allowed_agent_ids?: string[] | null
}

function accountLabelOf(cfg: ContactsAccountConfig): string {
  return cfg.account_label || cfg.email_address || ''
}

/** Public, secret-free view of a contacts account. */
export interface ContactsAccount {
  id: string
  slug: string
  name: string
  type: string
  accountLabel: string
  allowedAgentIds: string[] | null
  isValid: boolean
  lastError: string | null
}

type ProviderRow = typeof providers.$inferSelect

function hasContactsCapability(row: ProviderRow): boolean {
  try {
    return (JSON.parse(row.capabilities) as string[]).includes('contacts')
  } catch {
    return false
  }
}

function loadContactsRows(): ProviderRow[] {
  return db.select().from(providers).all().filter(hasContactsCapability)
}

async function decryptConfig(row: ProviderRow): Promise<ContactsAccountConfig> {
  return JSON.parse(await decrypt(row.configEncrypted)) as ContactsAccountConfig
}

function toAccount(row: ProviderRow, cfg: ContactsAccountConfig): ContactsAccount {
  const allowed = cfg.allowed_agent_ids && cfg.allowed_agent_ids.length > 0 ? cfg.allowed_agent_ids : null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    accountLabel: accountLabelOf(cfg),
    allowedAgentIds: allowed,
    isValid: row.isValid,
    lastError: row.lastError,
  }
}

function agentAllowed(cfg: ContactsAccountConfig, agentId?: string): boolean {
  if (!cfg.allowed_agent_ids || cfg.allowed_agent_ids.length === 0) return true
  return agentId != null && cfg.allowed_agent_ids.includes(agentId)
}

/** List contacts accounts. With a `agentId`, only the accounts that Agent may use. */
export async function listContactsAccounts(agentId?: string): Promise<ContactsAccount[]> {
  const out: ContactsAccount[] = []
  for (const row of loadContactsRows()) {
    const cfg = await decryptConfig(row)
    if (!agentAllowed(cfg, agentId)) continue
    out.push(toAccount(row, cfg))
  }
  return out
}

export interface ResolvedContacts {
  account: ContactsAccount
  provider: ContactsProvider
  config: ProviderConfig
}

/**
 * Resolve a contacts account for a tool call: pick the account (explicit slug →
 * first valid), enforce the allow-list, inject credentials. Throws with a clear
 * message when nothing usable resolves.
 */
export async function resolveContactsProvider(opts: { slug?: string; agentId?: string }): Promise<ResolvedContacts> {
  const rows = loadContactsRows()
  if (rows.length === 0) throw new Error('No contacts account is connected')

  let row: ProviderRow | undefined
  if (opts.slug) {
    row = rows.find((r) => r.slug === opts.slug || r.id === opts.slug)
    if (!row) throw new Error(`Contacts account not found: ${opts.slug}`)
  } else {
    row = rows.find((r) => r.isValid) ?? rows[0]
  }
  if (!row) throw new Error('No usable contacts account')

  const cfg = await decryptConfig(row)
  if (!agentAllowed(cfg, opts.agentId)) {
    throw new Error(`This Agent is not allowed to use the contacts account "${row.slug}"`)
  }
  const provider = getContactsProvider(row.type)
  if (!provider) throw new Error(`Contacts provider not registered: ${row.type}`)

  const config: ProviderConfig = { account_label: accountLabelOf(cfg) }
  if (cfg.email_address) config.email_address = cfg.email_address
  if (provider.oauth) {
    // OAuth identity (Google / Microsoft): inject a fresh access token. The
    // token covers contacts because the connect flow requested contacts scopes.
    config.accessToken = await getFreshAccessToken({
      id: row.id,
      type: row.type,
      refreshToken: cfg.refresh_token ?? '',
    })
  } else if (cfg.credentials) {
    // Non-OAuth (CardDAV): hand the provider its connection fields.
    Object.assign(config, cfg.credentials)
  }
  return { account: toAccount(row, cfg), provider, config }
}

/** Create (or update, when the same type+label already exists) a contacts
 *  account from validated configSchema credentials. */
export async function createConfigContactsAccount(opts: {
  type: string
  accountLabel: string
  credentials: Record<string, string>
  name?: string
}): Promise<ContactsAccount> {
  let matched: ProviderRow | undefined
  for (const r of loadContactsRows()) {
    if (r.type !== opts.type) continue
    const cfg = await decryptConfig(r)
    if (accountLabelOf(cfg) === opts.accountLabel) {
      matched = r
      break
    }
  }

  const now = new Date()
  if (matched) {
    const cfg = await decryptConfig(matched)
    cfg.credentials = opts.credentials
    await db
      .update(providers)
      .set({ configEncrypted: await encrypt(JSON.stringify(cfg)), isValid: true, lastError: null, updatedAt: now })
      .where(eq(providers.id, matched.id))
    log.info({ id: matched.id, type: opts.type, label: opts.accountLabel }, 'Contacts account credentials updated')
    return toAccount({ ...matched, isValid: true, lastError: null }, cfg)
  }

  const id = uuid()
  const slug = generateProviderSlug(opts.name ?? opts.accountLabel)
  const cfg: ContactsAccountConfig = {
    account_label: opts.accountLabel,
    credentials: opts.credentials,
    allowed_agent_ids: null,
  }
  await db.insert(providers).values({
    id,
    slug,
    name: opts.name ?? opts.accountLabel,
    type: opts.type,
    configEncrypted: await encrypt(JSON.stringify(cfg)),
    capabilities: JSON.stringify(['contacts']),
    isValid: true,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  })
  log.info({ id, slug, type: opts.type, label: opts.accountLabel }, 'Contacts account connected')
  return toAccount(
    { id, slug, name: opts.name ?? opts.accountLabel, type: opts.type, configEncrypted: '', capabilities: '[]', isValid: true, lastError: null, createdAt: now, updatedAt: now },
    cfg,
  )
}

export async function deleteContactsAccount(id: string): Promise<void> {
  await db.delete(providers).where(eq(providers.id, id))
}

export function setAllowList(id: string, agentIds: string[] | null): Promise<ContactsAccount> {
  return mutateConfig(id, (cfg) => {
    cfg.allowed_agent_ids = agentIds && agentIds.length > 0 ? agentIds : null
  })
}

async function mutateConfig(id: string, mutate: (cfg: ContactsAccountConfig) => void): Promise<ContactsAccount> {
  const row = loadContactsRows().find((r) => r.id === id)
  if (!row) throw new Error(`Contacts account not found: ${id}`)
  const cfg = await decryptConfig(row)
  mutate(cfg)
  await db
    .update(providers)
    .set({ configEncrypted: await encrypt(JSON.stringify(cfg)), updatedAt: new Date() })
    .where(eq(providers.id, id))
  return toAccount(row, cfg)
}
