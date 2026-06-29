import { Hono } from 'hono'
import type { Context } from 'hono'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { getEmailProvider } from '@/server/email/registry'
import { getContactsProvider } from '@/server/contacts/registry'
import { getCalendarProvider } from '@/server/calendar/registry'
import {
  listConnectedAccounts,
  listConnectedProviders,
  createConfigAccount,
  deleteConnectedAccount,
  setAccountSendMode,
  setAccountAllowList,
} from '@/server/services/connected-accounts'
import { sseManager } from '@/server/sse/index'
import type { ConfigField, ProviderConfig } from '@gezy/sdk'

const log = createLogger('routes:connected-accounts')
const connectedAccountRoutes = new Hono()

interface ConfigProviderLike {
  configSchema: readonly ConfigField[]
  oauth?: unknown
  authenticate(config: ProviderConfig): Promise<{ valid: boolean; error?: string; accountLabel?: string }>
}

/** Resolve the config (non-OAuth) provider that serves a capability for a type. */
function configProviderFor(type: string, capability: string): ConfigProviderLike | null {
  const p =
    capability === 'email'
      ? getEmailProvider(type)
      : capability === 'contacts'
        ? getContactsProvider(type)
        : capability === 'calendar'
          ? getCalendarProvider(type)
          : undefined
  if (!p || p.oauth) return null
  return p as ConfigProviderLike
}

/** Public origin for OAuth redirect URIs (PUBLIC_URL → X-Forwarded → req).
 *  Mirrors the email-accounts route — the OAuth connect/callback live there. */
function publicOrigin(c: Context): string {
  if (process.env.PUBLIC_URL) return new URL(config.publicUrl).origin
  const fwdProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const fwdHost = (c.req.header('x-forwarded-host') ?? c.req.header('host'))?.split(',')[0]?.trim()
  if (fwdHost) return `${fwdProto || 'https'}://${fwdHost}`
  return new URL(c.req.url).origin
}

// GET /api/connected-accounts — every connected account with its capabilities.
connectedAccountRoutes.get('/', async (c) => {
  return c.json({ accounts: await listConnectedAccounts() })
})

// GET /api/connected-accounts/providers — providers merged by type across the
// email + contacts registries, plus the OAuth redirect URI to register.
connectedAccountRoutes.get('/providers', async (c) => {
  return c.json({
    providers: await listConnectedProviders(),
    redirectUri: `${publicOrigin(c)}/api/email-accounts/oauth/callback`,
  })
})

// POST /api/connected-accounts/connect-config/:type — connect a non-OAuth
// account for one or more capabilities (e.g. iCloud = email + contacts with the
// same app password). Validates EVERY requested capability before storing.
connectedAccountRoutes.post('/connect-config/:type', async (c) => {
  const type = c.req.param('type')
  const body = await c.req.json<{ capabilities?: string[]; fields?: Record<string, string>; name?: string }>()
  const capabilities = body.capabilities?.length ? body.capabilities : ['email']
  const fields = body.fields ?? {}

  // Resolve a config provider per requested capability.
  const selected: { capability: string; provider: ConfigProviderLike }[] = []
  for (const cap of capabilities) {
    const provider = configProviderFor(type, cap)
    if (!provider) {
      return c.json({ error: { code: 'UNSUPPORTED', message: `${type} has no config provider for ${cap}` } }, 400)
    }
    selected.push({ capability: cap, provider })
  }

  // Union the config schemas (providers of the same identity share fields).
  const schemaByKey = new Map<string, ConfigField>()
  for (const { provider } of selected) for (const f of provider.configSchema) if (!schemaByKey.has(f.key)) schemaByKey.set(f.key, f)
  const schema = [...schemaByKey.values()]

  const missing = schema.filter((f) => f.required && !fields[f.key]?.trim()).map((f) => f.label)
  if (missing.length > 0) {
    return c.json({ error: { code: 'INVALID_INPUT', message: `Missing required field(s): ${missing.join(', ')}` } }, 400)
  }

  const providerConfig: Record<string, string> = {}
  for (const f of schema) {
    const v = fields[f.key]?.trim()
    if (v) providerConfig[f.key] = v
    else if ('default' in f && f.default) providerConfig[f.key] = f.default
  }

  try {
    let label: string | undefined
    for (const { capability, provider } of selected) {
      const auth = await provider.authenticate(providerConfig)
      if (!auth.valid) {
        return c.json({ error: { code: 'AUTH_FAILED', message: `${capability}: ${auth.error ?? 'authentication failed'}` } }, 400)
      }
      label = label ?? auth.accountLabel
    }
    label = label || providerConfig.email || providerConfig.apple_id || providerConfig.username || providerConfig.email_address || type
    const account = await createConfigAccount({ type, label, credentials: providerConfig, capabilities, name: body.name })
    sseManager.broadcast({ type: 'connected-account:created', data: account as unknown as Record<string, unknown> })
    return c.json({ account })
  } catch (err) {
    log.error({ err, type, capabilities }, 'Config connect failed')
    return c.json({ error: { code: 'CONNECT_FAILED', message: err instanceof Error ? err.message : 'Failed' } }, 400)
  }
})

// PATCH /api/connected-accounts/:id — send mode (email) / allow-list.
connectedAccountRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ sendMode?: 'direct' | 'approval'; allowedAgentIds?: string[] | null }>()
  try {
    if (body.sendMode) await setAccountSendMode(id, body.sendMode)
    if (body.allowedAgentIds !== undefined) await setAccountAllowList(id, body.allowedAgentIds)
    if (!body.sendMode && body.allowedAgentIds === undefined) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Nothing to update' } }, 400)
    }
    sseManager.broadcast({ type: 'connected-account:updated', data: { accountId: id } })
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: { code: 'NOT_FOUND', message: err instanceof Error ? err.message : 'Not found' } }, 404)
  }
})

// DELETE /api/connected-accounts/:id — disconnect (removes all capabilities).
connectedAccountRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await deleteConnectedAccount(id)
  sseManager.broadcast({ type: 'connected-account:deleted', data: { accountId: id } })
  return c.json({ ok: true })
})

export { connectedAccountRoutes }
