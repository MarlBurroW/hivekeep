/**
 * Connected accounts — the unified view over email + contacts (+ future
 * calendar) accounts. One `providers` row can carry several capabilities, so a
 * single connected identity (Google, Microsoft, iCloud) is listed once with its
 * capability set, and providers are merged by `type` across the email and
 * contacts registries.
 *
 * Mutations (connect, delete, send-mode, allow-list) still go through the
 * per-family services / routes; this module is the read model that powers the
 * single "Connected accounts" settings section.
 */
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { decrypt, encrypt } from '@/server/services/encryption'
import { getOAuthClient } from '@/server/services/app-settings'
import { invalidateAccessToken } from '@/server/services/email-token-manager'
import { generateProviderSlug } from '@/server/services/provider-slug'
import { listEmailProviders } from '@/server/email/registry'
import { listContactsProviders } from '@/server/contacts/registry'
import { listCalendarProviders } from '@/server/calendar/registry'
import { createLogger } from '@/server/logger'
import type { ConfigField } from '@gezy/sdk'

const log = createLogger('connected-accounts')

const ACCOUNT_CAPABILITIES = ['email', 'contacts', 'calendar']

type ProviderRow = typeof providers.$inferSelect

function rowCapabilities(row: ProviderRow): string[] {
  try {
    return (JSON.parse(row.capabilities) as string[]).filter((c) => ACCOUNT_CAPABILITIES.includes(c))
  } catch {
    return []
  }
}

export interface ConnectedAccount {
  id: string
  slug: string
  name: string
  type: string
  /** Display label — the email address or account label. */
  label: string
  capabilities: string[]
  /** Email send mode when the account serves email; null otherwise. */
  sendMode: 'direct' | 'approval' | null
  allowedAgentIds: string[] | null
  isValid: boolean
  lastError: string | null
}

interface StoredConfig {
  email_address?: string
  account_label?: string
  send_mode?: 'direct' | 'approval'
  allowed_agent_ids?: string[] | null
}

/** List every connected account (any account capability) with its capability set. */
export async function listConnectedAccounts(): Promise<ConnectedAccount[]> {
  const out: ConnectedAccount[] = []
  for (const row of db.select().from(providers).all()) {
    const caps = rowCapabilities(row)
    if (caps.length === 0) continue
    let cfg: StoredConfig = {}
    try {
      cfg = JSON.parse(await decrypt(row.configEncrypted)) as StoredConfig
    } catch {
      // Unreadable config — still surface the account so it can be removed.
    }
    const allowed = cfg.allowed_agent_ids && cfg.allowed_agent_ids.length > 0 ? cfg.allowed_agent_ids : null
    out.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      label: cfg.email_address || cfg.account_label || row.name,
      capabilities: caps,
      sendMode: caps.includes('email') ? cfg.send_mode ?? 'direct' : null,
      allowedAgentIds: allowed,
      isValid: row.isValid,
      lastError: row.lastError,
    })
  }
  return out
}

export interface ConnectedProviderInfo {
  type: string
  displayName: string
  usesOAuth: boolean
  oauthConfigured: boolean
  reactIcon: string | null
  brandColor: string | null
  consoleUrl: string | null
  /** Capabilities this provider can serve (union across registries by type). */
  capabilities: string[]
  /** Non-OAuth connection fields (empty for OAuth providers). */
  configSchema: ConfigField[]
}

/** Merge the email + contacts provider registries by `type` into one list. */
export async function listConnectedProviders(): Promise<ConnectedProviderInfo[]> {
  const byType = new Map<string, ConnectedProviderInfo>()

  const add = (
    type: string,
    info: { displayName: string; oauth: boolean; reactIcon?: string; brandColor?: string; apiKeyUrl?: string; configSchema: ConfigField[] },
    capability: string,
  ) => {
    const existing = byType.get(type)
    if (existing) {
      if (!existing.capabilities.includes(capability)) existing.capabilities.push(capability)
      // An OAuth family wins for the connect path; keep richer config schema.
      if (info.oauth) existing.usesOAuth = true
      if (existing.configSchema.length === 0 && info.configSchema.length > 0) existing.configSchema = info.configSchema
      return
    }
    byType.set(type, {
      type,
      displayName: info.displayName,
      usesOAuth: info.oauth,
      oauthConfigured: false,
      reactIcon: info.reactIcon ?? null,
      brandColor: info.brandColor ?? null,
      consoleUrl: info.apiKeyUrl ?? null,
      capabilities: [capability],
      configSchema: info.oauth ? [] : info.configSchema,
    })
  }

  for (const p of listEmailProviders()) {
    add(p.type, { displayName: p.displayName, oauth: !!p.oauth, reactIcon: p.reactIcon, brandColor: p.brandColor, apiKeyUrl: p.apiKeyUrl, configSchema: [...p.configSchema] }, 'email')
  }
  for (const p of listContactsProviders()) {
    add(p.type, { displayName: p.displayName, oauth: !!p.oauth, reactIcon: p.reactIcon, brandColor: p.brandColor, apiKeyUrl: p.apiKeyUrl, configSchema: [...p.configSchema] }, 'contacts')
  }
  for (const p of listCalendarProviders()) {
    add(p.type, { displayName: p.displayName, oauth: !!p.oauth, reactIcon: p.reactIcon, brandColor: p.brandColor, apiKeyUrl: p.apiKeyUrl, configSchema: [...p.configSchema] }, 'calendar')
  }

  const list = [...byType.values()]
  for (const info of list) {
    info.oauthConfigured = info.usesOAuth ? !!(await getOAuthClient(info.type)) : true
  }
  return list
}

// ─── Capability-agnostic mutations (operate on any account row by id) ────────

export async function deleteConnectedAccount(id: string): Promise<void> {
  await db.delete(providers).where(eq(providers.id, id))
  invalidateAccessToken(id)
}

async function mutateRowConfig(id: string, mutate: (cfg: Record<string, unknown>) => void): Promise<void> {
  const row = db.select().from(providers).where(eq(providers.id, id)).get()
  if (!row) throw new Error(`Account not found: ${id}`)
  const cfg = JSON.parse(await decrypt(row.configEncrypted)) as Record<string, unknown>
  mutate(cfg)
  await db
    .update(providers)
    .set({ configEncrypted: await encrypt(JSON.stringify(cfg)), updatedAt: new Date() })
    .where(eq(providers.id, id))
}

export function setAccountSendMode(id: string, mode: 'direct' | 'approval'): Promise<void> {
  return mutateRowConfig(id, (cfg) => {
    cfg.send_mode = mode
  })
}

export function setAccountAllowList(id: string, agentIds: string[] | null): Promise<void> {
  return mutateRowConfig(id, (cfg) => {
    cfg.allowed_agent_ids = agentIds && agentIds.length > 0 ? agentIds : null
  })
}

function mergeCapabilities(existing: string[], add: string[]): string[] {
  const out = [...existing]
  for (const c of add) if (!out.includes(c)) out.push(c)
  return out
}

/**
 * Create (or augment) a non-OAuth account from validated config credentials,
 * setting ALL requested capabilities on ONE row. Used by the unified config
 * connect (e.g. iCloud = email + contacts with the same app password).
 */
export async function createConfigAccount(opts: {
  type: string
  label: string
  credentials: Record<string, string>
  capabilities: string[]
  name?: string
}): Promise<{ id: string }> {
  const servesEmail = opts.capabilities.includes('email')
  let matched: ProviderRow | undefined
  for (const row of db.select().from(providers).all()) {
    if (row.type !== opts.type) continue
    try {
      const cfg = JSON.parse(await decrypt(row.configEncrypted)) as StoredConfig
      if ((cfg.email_address || cfg.account_label) === opts.label) {
        matched = row
        break
      }
    } catch {
      /* skip unreadable */
    }
  }

  const now = new Date()
  if (matched) {
    const cfg = JSON.parse(await decrypt(matched.configEncrypted)) as Record<string, unknown>
    cfg.credentials = opts.credentials
    if (servesEmail && !cfg.send_mode) cfg.send_mode = 'direct'
    const caps = mergeCapabilities(rowCapabilities(matched), opts.capabilities)
    await db
      .update(providers)
      .set({
        configEncrypted: await encrypt(JSON.stringify(cfg)),
        capabilities: JSON.stringify(caps),
        isValid: true,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(providers.id, matched.id))
    log.info({ id: matched.id, type: opts.type, label: opts.label, capabilities: caps }, 'Config account updated')
    return { id: matched.id }
  }

  const id = uuid()
  const cfg: StoredConfig & { credentials: Record<string, string> } = {
    email_address: servesEmail ? opts.label : undefined,
    account_label: opts.label,
    credentials: opts.credentials,
    send_mode: servesEmail ? 'direct' : undefined,
    allowed_agent_ids: null,
  }
  await db.insert(providers).values({
    id,
    slug: generateProviderSlug(opts.name ?? opts.label),
    name: opts.name ?? opts.label,
    type: opts.type,
    configEncrypted: await encrypt(JSON.stringify(cfg)),
    capabilities: JSON.stringify(opts.capabilities),
    isValid: true,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  })
  log.info({ id, type: opts.type, label: opts.label, capabilities: opts.capabilities }, 'Config account connected')
  return { id }
}
