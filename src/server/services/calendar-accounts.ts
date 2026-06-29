/**
 * Calendar accounts service — resolves a connected account that carries the
 * `calendar` capability into a CalendarProvider + ProviderConfig. Mirrors the
 * email/contacts resolvers and reads the SAME shared account config (a single
 * row may serve email + contacts + calendar).
 */
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { decrypt } from '@/server/services/encryption'
import { getCalendarProvider } from '@/server/calendar/registry'
import { getFreshAccessToken } from '@/server/services/email-token-manager'
import type { CalendarProvider } from '@/server/calendar/types'
import type { ProviderConfig } from '@gezy/sdk'

interface AccountConfig {
  account_label?: string
  email_address?: string
  refresh_token?: string
  credentials?: Record<string, string>
  allowed_agent_ids?: string[] | null
}

export interface CalendarAccount {
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

function hasCalendarCapability(row: ProviderRow): boolean {
  try {
    return (JSON.parse(row.capabilities) as string[]).includes('calendar')
  } catch {
    return false
  }
}

function loadCalendarRows(): ProviderRow[] {
  return db.select().from(providers).all().filter(hasCalendarCapability)
}

async function decryptConfig(row: ProviderRow): Promise<AccountConfig> {
  return JSON.parse(await decrypt(row.configEncrypted)) as AccountConfig
}

function labelOf(cfg: AccountConfig): string {
  return cfg.account_label || cfg.email_address || ''
}

function agentAllowed(cfg: AccountConfig, agentId?: string): boolean {
  if (!cfg.allowed_agent_ids || cfg.allowed_agent_ids.length === 0) return true
  return agentId != null && cfg.allowed_agent_ids.includes(agentId)
}

function toAccount(row: ProviderRow, cfg: AccountConfig): CalendarAccount {
  const allowed = cfg.allowed_agent_ids && cfg.allowed_agent_ids.length > 0 ? cfg.allowed_agent_ids : null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    accountLabel: labelOf(cfg),
    allowedAgentIds: allowed,
    isValid: row.isValid,
    lastError: row.lastError,
  }
}

/** List calendar accounts. With a `agentId`, only the accounts that Agent may use. */
export async function listCalendarAccounts(agentId?: string): Promise<CalendarAccount[]> {
  const out: CalendarAccount[] = []
  for (const row of loadCalendarRows()) {
    const cfg = await decryptConfig(row)
    if (!agentAllowed(cfg, agentId)) continue
    out.push(toAccount(row, cfg))
  }
  return out
}

export interface ResolvedCalendar {
  account: CalendarAccount
  provider: CalendarProvider
  config: ProviderConfig
}

/** Resolve a calendar account for a tool call (explicit slug → first valid),
 *  enforce the allow-list, inject a fresh access token or the credentials. */
export async function resolveCalendarProvider(opts: { slug?: string; agentId?: string }): Promise<ResolvedCalendar> {
  const rows = loadCalendarRows()
  if (rows.length === 0) throw new Error('No calendar account is connected')

  let row: ProviderRow | undefined
  if (opts.slug) {
    row = rows.find((r) => r.slug === opts.slug || r.id === opts.slug)
    if (!row) throw new Error(`Calendar account not found: ${opts.slug}`)
  } else {
    row = rows.find((r) => r.isValid) ?? rows[0]
  }
  if (!row) throw new Error('No usable calendar account')

  const cfg = await decryptConfig(row)
  if (!agentAllowed(cfg, opts.agentId)) {
    throw new Error(`This Agent is not allowed to use the calendar account "${row.slug}"`)
  }
  const provider = getCalendarProvider(row.type)
  if (!provider) throw new Error(`Calendar provider not registered: ${row.type}`)

  const config: ProviderConfig = { account_label: labelOf(cfg) }
  if (cfg.email_address) config.email_address = cfg.email_address
  if (provider.oauth) {
    config.accessToken = await getFreshAccessToken({ id: row.id, type: row.type, refreshToken: cfg.refresh_token ?? '' })
  } else if (cfg.credentials) {
    Object.assign(config, cfg.credentials)
  }
  return { account: toAccount(row, cfg), provider, config }
}
