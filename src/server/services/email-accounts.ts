/**
 * Email accounts service.
 *
 * An email account is a row in the `providers` table with capability `email`
 * (type = 'gmail' | future). Credentials (the OAuth refresh token) live in the
 * row's encrypted config; we never expose them to the provider implementation —
 * the email tools resolve an account, inject a fresh access token, and hand the
 * provider a ProviderConfig with just what it needs.
 */
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { encrypt, decrypt } from '@/server/services/encryption'
import { generateProviderSlug } from '@/server/services/provider-slug'
import { getEmailProvider } from '@/server/email/registry'
import { getFreshAccessToken, invalidateAccessToken } from '@/server/services/email-token-manager'
import { getDefaultEmailProviderId } from '@/server/services/app-settings'
import { createLogger } from '@/server/logger'
import type { EmailProvider } from '@/server/email/types'
import type { ProviderConfig } from '@gezy/sdk'

const log = createLogger('email-accounts')

export type SendMode = 'direct' | 'approval'

/** Decrypted shape stored in `providers.config_encrypted` for an email account. */
interface EmailAccountConfig {
  email_address: string
  /** OAuth providers only — the durable refresh token. */
  refresh_token?: string
  scopes?: string[]
  /** Non-OAuth providers (IMAP/SMTP) — the connection credentials declared by
   *  the provider's `configSchema` (host/port/username/password, …). Never
   *  exposed in prompts; spread into the ProviderConfig at resolve time. */
  credentials?: Record<string, string>
  send_mode?: SendMode
  /** null / absent / empty = global (any Agent with the email toolbox). A
   *  non-empty list restricts the account to those Agent ids. */
  allowed_agent_ids?: string[] | null
}

/** Public, secret-free view of an email account. */
export interface EmailAccount {
  id: string
  slug: string
  name: string
  type: string
  emailAddress: string
  sendMode: SendMode
  allowedAgentIds: string[] | null
  isValid: boolean
  lastError: string | null
}

type ProviderRow = typeof providers.$inferSelect

function hasEmailCapability(row: ProviderRow): boolean {
  try {
    return (JSON.parse(row.capabilities) as string[]).includes('email')
  } catch {
    return false
  }
}

function loadEmailRows(): ProviderRow[] {
  return db.select().from(providers).all().filter(hasEmailCapability)
}

async function decryptConfig(row: ProviderRow): Promise<EmailAccountConfig> {
  return JSON.parse(await decrypt(row.configEncrypted)) as EmailAccountConfig
}

function toAccount(row: ProviderRow, cfg: EmailAccountConfig): EmailAccount {
  const allowed = cfg.allowed_agent_ids && cfg.allowed_agent_ids.length > 0 ? cfg.allowed_agent_ids : null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    emailAddress: cfg.email_address,
    sendMode: cfg.send_mode ?? 'direct',
    allowedAgentIds: allowed,
    isValid: row.isValid,
    lastError: row.lastError,
  }
}

/** An Agent may use an account when it's global, or when its id is on the
 *  account's allow-list. */
function agentAllowed(cfg: EmailAccountConfig, agentId?: string): boolean {
  if (!cfg.allowed_agent_ids || cfg.allowed_agent_ids.length === 0) return true
  return agentId != null && cfg.allowed_agent_ids.includes(agentId)
}

/** List email accounts. With a `agentId`, only the accounts that Agent may use. */
export async function listEmailAccounts(agentId?: string): Promise<EmailAccount[]> {
  const out: EmailAccount[] = []
  for (const row of loadEmailRows()) {
    const cfg = await decryptConfig(row)
    if (!agentAllowed(cfg, agentId)) continue
    out.push(toAccount(row, cfg))
  }
  return out
}

export interface ResolvedEmail {
  account: EmailAccount
  provider: EmailProvider
  /** ProviderConfig handed to the provider: a fresh access token + the address.
   *  Never carries the refresh token. */
  config: ProviderConfig
  sendMode: SendMode
}

/**
 * Resolve an email account for a tool call: pick the account (explicit slug →
 * default → first valid), enforce the allow-list, and inject a fresh access
 * token. Throws with a clear message when nothing usable resolves.
 */
export async function resolveEmailProvider(opts: { slug?: string; agentId?: string }): Promise<ResolvedEmail> {
  const rows = loadEmailRows()
  if (rows.length === 0) throw new Error('No email account is connected')

  let row: ProviderRow | undefined
  if (opts.slug) {
    row = rows.find((r) => r.slug === opts.slug || r.id === opts.slug)
    if (!row) throw new Error(`Email account not found: ${opts.slug}`)
  } else {
    const defaultId = await getDefaultEmailProviderId()
    row = (defaultId ? rows.find((r) => r.id === defaultId) : undefined) ?? rows.find((r) => r.isValid) ?? rows[0]
  }
  if (!row) throw new Error('No usable email account')

  const cfg = await decryptConfig(row)
  if (!agentAllowed(cfg, opts.agentId)) {
    throw new Error(`This Agent is not allowed to use the email account "${row.slug}"`)
  }
  const provider = getEmailProvider(row.type)
  if (!provider) throw new Error(`Email provider not registered: ${row.type}`)

  const config: ProviderConfig = { email_address: cfg.email_address }
  if (provider.oauth) {
    config.accessToken = await getFreshAccessToken({
      id: row.id,
      type: row.type,
      refreshToken: cfg.refresh_token ?? '',
    })
  } else if (cfg.credentials) {
    // Non-OAuth (IMAP/SMTP): hand the provider its connection fields.
    Object.assign(config, cfg.credentials)
  }
  return { account: toAccount(row, cfg), provider, config, sendMode: cfg.send_mode ?? 'direct' }
}

/**
 * Resolve an email account by its provider-row id, WITHOUT the agent allow-list.
 * Used by account-scoped machinery (the trigger poller, the folder picker) where
 * access is governed by the account itself, not a calling Agent.
 */
export async function resolveEmailProviderByAccountId(accountId: string): Promise<ResolvedEmail> {
  const row = loadEmailRows().find((r) => r.id === accountId)
  if (!row) throw new Error(`Email account not found: ${accountId}`)

  const cfg = await decryptConfig(row)
  const provider = getEmailProvider(row.type)
  if (!provider) throw new Error(`Email provider not registered: ${row.type}`)

  const config: ProviderConfig = { email_address: cfg.email_address }
  if (provider.oauth) {
    config.accessToken = await getFreshAccessToken({
      id: row.id,
      type: row.type,
      refreshToken: cfg.refresh_token ?? '',
    })
  } else if (cfg.credentials) {
    Object.assign(config, cfg.credentials)
  }
  return { account: toAccount(row, cfg), provider, config, sendMode: cfg.send_mode ?? 'direct' }
}

/** Create (or update, when the same type+address already exists) an email
 *  account from a completed OAuth flow. */
function rowCapabilities(row: ProviderRow): string[] {
  try {
    return JSON.parse(row.capabilities) as string[]
  } catch {
    return []
  }
}

/** Union of two capability lists, order-stable. */
function mergeCapabilities(existing: string[], add: string[]): string[] {
  const out = [...existing]
  for (const c of add) if (!out.includes(c)) out.push(c)
  return out
}

export async function createOAuthEmailAccount(opts: {
  type: string
  emailAddress: string
  refreshToken: string
  scopes?: string[]
  /** Capabilities this connection grants. Default ['email']. Merged into the
   *  row when re-connecting, so one identity can serve email + contacts + … */
  capabilities?: string[]
  name?: string
}): Promise<EmailAccount> {
  const capabilities = opts.capabilities ?? ['email']
  // Re-auth of an existing account? Match on type + address (config is
  // encrypted, so we decrypt to compare — small list, fine).
  let matched: ProviderRow | undefined
  for (const r of loadEmailRows()) {
    if (r.type !== opts.type) continue
    const cfg = await decryptConfig(r)
    if (cfg.email_address === opts.emailAddress) {
      matched = r
      break
    }
  }

  const now = new Date()
  if (matched) {
    const cfg = await decryptConfig(matched)
    cfg.refresh_token = opts.refreshToken
    if (opts.scopes) cfg.scopes = opts.scopes
    const merged = mergeCapabilities(rowCapabilities(matched), capabilities)
    await db
      .update(providers)
      .set({
        configEncrypted: await encrypt(JSON.stringify(cfg)),
        capabilities: JSON.stringify(merged),
        isValid: true,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(providers.id, matched.id))
    invalidateAccessToken(matched.id)
    log.info({ id: matched.id, type: opts.type, email: opts.emailAddress, capabilities: merged }, 'Email account re-authorized')
    return toAccount({ ...matched, isValid: true, lastError: null }, cfg)
  }

  const id = uuid()
  const slug = generateProviderSlug(opts.name ?? opts.emailAddress)
  const cfg: EmailAccountConfig = {
    email_address: opts.emailAddress,
    refresh_token: opts.refreshToken,
    scopes: opts.scopes,
    send_mode: 'direct',
    allowed_agent_ids: null,
  }
  await db.insert(providers).values({
    id,
    slug,
    name: opts.name ?? opts.emailAddress,
    type: opts.type,
    configEncrypted: await encrypt(JSON.stringify(cfg)),
    capabilities: JSON.stringify(capabilities),
    isValid: true,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  })
  log.info({ id, slug, type: opts.type, email: opts.emailAddress, capabilities }, 'Email account connected')
  return toAccount({ id, slug, name: opts.name ?? opts.emailAddress, type: opts.type, configEncrypted: '', capabilities: '[]', isValid: true, lastError: null, createdAt: now, updatedAt: now }, cfg)
}

/** Create (or update, when the same type+address already exists) a non-OAuth
 *  email account from validated configSchema credentials (IMAP/SMTP). */
export async function createConfigEmailAccount(opts: {
  type: string
  emailAddress: string
  credentials: Record<string, string>
  name?: string
}): Promise<EmailAccount> {
  let matched: ProviderRow | undefined
  for (const r of loadEmailRows()) {
    if (r.type !== opts.type) continue
    const cfg = await decryptConfig(r)
    if (cfg.email_address === opts.emailAddress) {
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
    log.info({ id: matched.id, type: opts.type, email: opts.emailAddress }, 'Email account credentials updated')
    return toAccount({ ...matched, isValid: true, lastError: null }, cfg)
  }

  const id = uuid()
  const slug = generateProviderSlug(opts.name ?? opts.emailAddress)
  const cfg: EmailAccountConfig = {
    email_address: opts.emailAddress,
    credentials: opts.credentials,
    send_mode: 'direct',
    allowed_agent_ids: null,
  }
  await db.insert(providers).values({
    id,
    slug,
    name: opts.name ?? opts.emailAddress,
    type: opts.type,
    configEncrypted: await encrypt(JSON.stringify(cfg)),
    capabilities: JSON.stringify(['email']),
    isValid: true,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  })
  log.info({ id, slug, type: opts.type, email: opts.emailAddress }, 'Email account connected (config)')
  return toAccount(
    { id, slug, name: opts.name ?? opts.emailAddress, type: opts.type, configEncrypted: '', capabilities: '[]', isValid: true, lastError: null, createdAt: now, updatedAt: now },
    cfg,
  )
}

export async function deleteEmailAccount(id: string): Promise<void> {
  await db.delete(providers).where(eq(providers.id, id))
  invalidateAccessToken(id)
}

async function mutateConfig(id: string, mutate: (cfg: EmailAccountConfig) => void): Promise<EmailAccount> {
  const row = loadEmailRows().find((r) => r.id === id)
  if (!row) throw new Error(`Email account not found: ${id}`)
  const cfg = await decryptConfig(row)
  mutate(cfg)
  await db
    .update(providers)
    .set({ configEncrypted: await encrypt(JSON.stringify(cfg)), updatedAt: new Date() })
    .where(eq(providers.id, id))
  return toAccount(row, cfg)
}

export function setSendMode(id: string, mode: SendMode): Promise<EmailAccount> {
  return mutateConfig(id, (cfg) => {
    cfg.send_mode = mode
  })
}

export function setAllowList(id: string, agentIds: string[] | null): Promise<EmailAccount> {
  return mutateConfig(id, (cfg) => {
    cfg.allowed_agent_ids = agentIds && agentIds.length > 0 ? agentIds : null
  })
}
