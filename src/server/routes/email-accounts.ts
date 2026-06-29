import { Hono } from 'hono'
import type { Context } from 'hono'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { getEmailProvider, listEmailProviders } from '@/server/email/registry'
import { getContactsProvider } from '@/server/contacts/registry'
import { getCalendarProvider } from '@/server/calendar/registry'
import type { OAuthProfile } from '@gezy/sdk'
import {
  getOAuthClient,
  setOAuthClient,
  setOAuthClientId,
  clearOAuthClient,
} from '@/server/services/app-settings'
import { buildAuthorizeUrl, exchangeCode, fetchAccountEmail } from '@/server/services/oauth'
import {
  listEmailAccounts,
  createOAuthEmailAccount,
  createConfigEmailAccount,
  deleteEmailAccount,
  setSendMode,
  setAllowList,
  resolveEmailProviderByAccountId,
  type SendMode,
} from '@/server/services/email-accounts'
import { sseManager } from '@/server/sse/index'

const log = createLogger('routes:email-accounts')
const emailAccountRoutes = new Hono()

// Short-lived CSRF/state store for in-flight OAuth connects (in-memory).
const pendingStates = new Map<string, { type: string; capabilities: string[]; createdAt: number }>()
const STATE_TTL_MS = 10 * 60 * 1000

/**
 * Collect the OAuth profile + the union of scopes for the requested capabilities.
 * A single identity (e.g. Microsoft) exposes both an EmailProvider and a
 * ContactsProvider under the same `type`; connecting with both capabilities
 * requests Mail + Contacts scopes at once so one account serves both.
 */
function collectOAuth(type: string, capabilities: string[]): { profile: OAuthProfile; scopes: string[] } | null {
  const scopes = new Set<string>()
  let profile: OAuthProfile | undefined
  if (capabilities.includes('email')) {
    const p = getEmailProvider(type)
    if (p?.oauth) {
      profile = p.oauth
      for (const s of p.oauth.scopes) scopes.add(s)
    }
  }
  if (capabilities.includes('contacts')) {
    const p = getContactsProvider(type)
    if (p?.oauth) {
      profile = profile ?? p.oauth
      for (const s of p.oauth.scopes) scopes.add(s)
    }
  }
  if (capabilities.includes('calendar')) {
    const p = getCalendarProvider(type)
    if (p?.oauth) {
      profile = profile ?? p.oauth
      for (const s of p.oauth.scopes) scopes.add(s)
    }
  }
  return profile ? { profile, scopes: [...scopes] } : null
}

function sweepStates() {
  const cutoff = Date.now() - STATE_TTL_MS
  for (const [k, v] of pendingStates) if (v.createdAt < cutoff) pendingStates.delete(k)
}

/**
 * Public origin for the OAuth redirect URI. MUST match what's registered in the
 * provider app exactly. Behind a TLS-terminating reverse proxy, `c.req.url` is
 * the internal http URL — wrong — so we resolve, in order:
 *   1. PUBLIC_URL (authoritative; the canonical fix for proxied deployments)
 *   2. X-Forwarded-Proto / X-Forwarded-Host (set by most reverse proxies)
 *   3. the request URL origin (direct access / dev)
 */
function publicOrigin(c: Context): string {
  if (process.env.PUBLIC_URL) return new URL(config.publicUrl).origin
  const fwdProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  const fwdHost = (c.req.header('x-forwarded-host') ?? c.req.header('host'))?.split(',')[0]?.trim()
  if (fwdHost) return `${fwdProto || 'https'}://${fwdHost}`
  return new URL(c.req.url).origin
}

function callbackUri(c: Context): string {
  return `${publicOrigin(c)}/api/email-accounts/oauth/callback`
}

// GET /api/email-accounts — list connected accounts (admin view: all accounts)
emailAccountRoutes.get('/', async (c) => {
  return c.json({ accounts: await listEmailAccounts() })
})

// GET /api/email-accounts/providers — available email providers + whether the
// operator has configured their OAuth app credentials.
emailAccountRoutes.get('/providers', async (c) => {
  const out = []
  for (const p of listEmailProviders()) {
    out.push({
      type: p.type,
      displayName: p.displayName,
      usesOAuth: !!p.oauth,
      oauthConfigured: p.oauth ? !!(await getOAuthClient(p.type)) : true,
      reactIcon: p.reactIcon ?? null,
      brandColor: p.brandColor ?? null,
      consoleUrl: p.apiKeyUrl ?? null,
      // A ContactsProvider registered under the same type means this account can
      // also serve the address book — the UI offers a "Contacts" capability.
      supportsContacts: !!getContactsProvider(p.type),
      // Non-OAuth providers (IMAP/SMTP) render this form in the Add dialog.
      configSchema: p.oauth ? [] : p.configSchema,
    })
  }
  // The exact redirect URI the server will send — so the UI shows what to
  // register in the provider app (not a client-side guess).
  return c.json({ providers: out, redirectUri: callbackUri(c) })
})

// GET /api/email-accounts/oauth-config/:type — is the OAuth app configured?
emailAccountRoutes.get('/oauth-config/:type', async (c) => {
  const client = await getOAuthClient(c.req.param('type'))
  return c.json({ configured: !!client, clientId: client?.clientId ?? null })
})

// PUT /api/email-accounts/oauth-config/:type — set the OAuth app credentials.
emailAccountRoutes.put('/oauth-config/:type', async (c) => {
  const type = c.req.param('type')
  const body = await c.req.json<{ clientId?: string; clientSecret?: string }>()
  if (!body.clientId) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'clientId is required' } }, 400)
  }
  if (body.clientSecret) {
    await setOAuthClient(type, { clientId: body.clientId, clientSecret: body.clientSecret })
  } else {
    // Editing an existing app without re-typing the (write-only) secret: keep
    // the stored secret, update only the id. Reject if no secret is stored yet.
    const existing = await getOAuthClient(type)
    if (!existing) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'clientSecret is required' } }, 400)
    }
    await setOAuthClientId(type, body.clientId)
  }
  return c.json({ ok: true })
})

// DELETE /api/email-accounts/oauth-config/:type
emailAccountRoutes.delete('/oauth-config/:type', async (c) => {
  await clearOAuthClient(c.req.param('type'))
  return c.json({ ok: true })
})

// POST /api/email-accounts/connect/:type — begin the OAuth connect flow.
// Body: { capabilities?: ['email','contacts'] } — the union of scopes for the
// selected capabilities is requested so one account can serve both.
emailAccountRoutes.post('/connect/:type', async (c) => {
  const type = c.req.param('type')
  const body = await c.req.json<{ capabilities?: string[] }>().catch(() => ({ capabilities: undefined }))
  const capabilities =
    body.capabilities && body.capabilities.length > 0 ? body.capabilities : ['email']

  const oauth = collectOAuth(type, capabilities)
  if (!oauth) {
    return c.json(
      { error: { code: 'NOT_OAUTH', message: `${type} has no OAuth provider for: ${capabilities.join(', ')}` } },
      400,
    )
  }
  const client = await getOAuthClient(type)
  if (!client) {
    return c.json(
      { error: { code: 'OAUTH_NOT_CONFIGURED', message: `OAuth app credentials not configured for ${type}` } },
      400,
    )
  }
  sweepStates()
  const state = crypto.randomUUID()
  pendingStates.set(state, { type, capabilities, createdAt: Date.now() })
  const authUrl = buildAuthorizeUrl({
    profile: { ...oauth.profile, scopes: oauth.scopes },
    clientId: client.clientId,
    redirectUri: callbackUri(c),
    state,
  })
  return c.json({ authUrl })
})

// POST /api/email-accounts/connect-config/:type — connect a non-OAuth account
// (IMAP/SMTP). Validates the submitted configSchema fields via authenticate()
// before storing them encrypted.
emailAccountRoutes.post('/connect-config/:type', async (c) => {
  const type = c.req.param('type')
  const provider = getEmailProvider(type)
  if (!provider) {
    return c.json({ error: { code: 'UNKNOWN_PROVIDER', message: `Unknown email provider: ${type}` } }, 404)
  }
  if (provider.oauth) {
    return c.json({ error: { code: 'IS_OAUTH', message: `${type} uses OAuth — use /connect/${type}` } }, 400)
  }

  const body = await c.req.json<{ fields?: Record<string, string>; name?: string }>()
  const fields = body.fields ?? {}

  // Required-field check against the provider's declared schema.
  const missing = provider.configSchema
    .filter((f) => f.required && !fields[f.key]?.trim())
    .map((f) => f.label)
  if (missing.length > 0) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: `Missing required field(s): ${missing.join(', ')}` } },
      400,
    )
  }

  // Build the ProviderConfig from declared keys only (apply schema defaults).
  const config: Record<string, string> = {}
  for (const f of provider.configSchema) {
    const v = fields[f.key]?.trim()
    if (v) config[f.key] = v
    else if ('default' in f && f.default) config[f.key] = f.default
  }

  try {
    const auth = await provider.authenticate(config)
    if (!auth.valid) {
      return c.json({ error: { code: 'AUTH_FAILED', message: auth.error ?? 'Authentication failed' } }, 400)
    }
    const emailAddress = config.email || auth.accountLabel
    if (!emailAddress) {
      return c.json({ error: { code: 'NO_EMAIL', message: 'Could not determine the account email address' } }, 400)
    }
    const account = await createConfigEmailAccount({ type, emailAddress, credentials: config, name: body.name })
    sseManager.broadcast({ type: 'email-account:created', data: account as unknown as Record<string, unknown> })
    return c.json({ account })
  } catch (err) {
    log.error({ err, type }, 'Config email connect failed')
    return c.json({ error: { code: 'CONNECT_FAILED', message: err instanceof Error ? err.message : 'Failed' } }, 400)
  }
})

// GET /api/email-accounts/oauth/callback — OAuth redirect target.
emailAccountRoutes.get('/oauth/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const oauthError = c.req.query('error')
  if (oauthError) return c.redirect(`/?email_error=${encodeURIComponent(oauthError)}`)
  if (!code || !state) return c.redirect('/?email_error=missing_code')

  const pending = state ? pendingStates.get(state) : undefined
  if (!pending) return c.redirect('/?email_error=invalid_state')
  pendingStates.delete(state)

  const oauth = collectOAuth(pending.type, pending.capabilities)
  if (!oauth) return c.redirect('/?email_error=unknown_provider')
  const client = await getOAuthClient(pending.type)
  if (!client) return c.redirect('/?email_error=oauth_not_configured')

  try {
    const tokens = await exchangeCode({
      profile: oauth.profile,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      code,
      redirectUri: callbackUri(c),
    })
    if (!tokens.refreshToken) {
      // No refresh token means we'd lose access on expiry — usually because the
      // user previously granted consent. prompt=consent (in the profile) forces
      // a fresh refresh token, so this should be rare.
      return c.redirect('/?email_error=no_refresh_token')
    }
    const email = await fetchAccountEmail(oauth.profile, tokens.accessToken)
    if (!email) return c.redirect('/?email_error=no_email')
    const oauthAccount = await createOAuthEmailAccount({
      type: pending.type,
      emailAddress: email,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scope ? tokens.scope.split(' ') : oauth.scopes,
      capabilities: pending.capabilities,
    })
    sseManager.broadcast({ type: 'email-account:created', data: oauthAccount as unknown as Record<string, unknown> })
    return c.redirect(`/?email_connected=${encodeURIComponent(email)}`)
  } catch (err) {
    log.error({ err, type: pending.type }, 'OAuth callback failed')
    return c.redirect(`/?email_error=${encodeURIComponent(err instanceof Error ? err.message : 'exchange_failed')}`)
  }
})

// PATCH /api/email-accounts/:id — update send mode / allow-list.
emailAccountRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ sendMode?: SendMode; allowedAgentIds?: string[] | null }>()
  try {
    let account
    if (body.sendMode) account = await setSendMode(id, body.sendMode)
    if (body.allowedAgentIds !== undefined) account = await setAllowList(id, body.allowedAgentIds)
    if (!account) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Nothing to update' } }, 400)
    }
    sseManager.broadcast({ type: 'email-account:updated', data: account as unknown as Record<string, unknown> })
    return c.json({ account })
  } catch (err) {
    return c.json({ error: { code: 'NOT_FOUND', message: err instanceof Error ? err.message : 'Not found' } }, 404)
  }
})

// DELETE /api/email-accounts/:id — disconnect an account.
emailAccountRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await deleteEmailAccount(id)
  sseManager.broadcast({ type: 'email-account:deleted', data: { accountId: id } })
  return c.json({ ok: true })
})

// GET /api/email-accounts/:id/folders — list folders/labels for the trigger
// folder picker. Falls back to INBOX when the provider can't enumerate folders.
emailAccountRoutes.get('/:id/folders', async (c) => {
  const id = c.req.param('id')
  try {
    const { provider, config } = await resolveEmailProviderByAccountId(id)
    if (!provider.listFolders) {
      return c.json({ folders: [{ id: 'INBOX', name: 'INBOX', type: 'folder' as const }] })
    }
    const folders = await provider.listFolders(config)
    return c.json({ folders: folders.length > 0 ? folders : [{ id: 'INBOX', name: 'INBOX', type: 'folder' as const }] })
  } catch (err) {
    log.error({ err, id }, 'Failed to list folders')
    return c.json({ error: { code: 'FOLDERS_FAILED', message: err instanceof Error ? err.message : 'Failed to list folders' } }, 400)
  }
})

export { emailAccountRoutes }
