import { Hono } from 'hono'
import { createLogger } from '@/server/logger'
import { getContactsProvider, listContactsProviders } from '@/server/contacts/registry'
import {
  listContactsAccounts,
  createConfigContactsAccount,
  deleteContactsAccount,
  setAllowList,
} from '@/server/services/contacts-accounts'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:contacts-accounts')
const contactsAccountRoutes = new Hono()

// Platform configuration: every route in this family is admin-only.
contactsAccountRoutes.use('*', requireAdmin)

// GET /api/contacts-accounts — list connected contacts accounts.
contactsAccountRoutes.get('/', async (c) => {
  return c.json({ accounts: await listContactsAccounts() })
})

// GET /api/contacts-accounts/providers — available contacts providers + the
// form fields to render in the Add dialog.
contactsAccountRoutes.get('/providers', (c) => {
  const out = listContactsProviders().map((p) => ({
    type: p.type,
    displayName: p.displayName,
    usesOAuth: !!p.oauth,
    reactIcon: p.reactIcon ?? null,
    brandColor: p.brandColor ?? null,
    consoleUrl: p.apiKeyUrl ?? null,
    configSchema: p.oauth ? [] : p.configSchema,
  }))
  return c.json({ providers: out })
})

// POST /api/contacts-accounts/connect-config/:type — connect a config-based
// account (CardDAV). Validates the submitted fields via authenticate() before
// storing them encrypted.
contactsAccountRoutes.post('/connect-config/:type', async (c) => {
  const type = c.req.param('type')
  const provider = getContactsProvider(type)
  if (!provider) {
    return c.json({ error: { code: 'UNKNOWN_PROVIDER', message: `Unknown contacts provider: ${type}` } }, 404)
  }
  if (provider.oauth) {
    return c.json({ error: { code: 'IS_OAUTH', message: `${type} uses OAuth` } }, 400)
  }

  const body = await c.req.json<{ fields?: Record<string, string>; name?: string }>()
  const fields = body.fields ?? {}

  const missing = provider.configSchema
    .filter((f) => f.required && !fields[f.key]?.trim())
    .map((f) => f.label)
  if (missing.length > 0) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: `Missing required field(s): ${missing.join(', ')}` } },
      400,
    )
  }

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
    // Prefer the provider's reported label, else the first credential value.
    const accountLabel = auth.accountLabel || config[provider.configSchema[0]?.key ?? ''] || type
    const account = await createConfigContactsAccount({ type, accountLabel, credentials: config, name: body.name })
    return c.json({ account })
  } catch (err) {
    log.error({ err, type }, 'Config contacts connect failed')
    return c.json({ error: { code: 'CONNECT_FAILED', message: err instanceof Error ? err.message : 'Failed' } }, 400)
  }
})

// PATCH /api/contacts-accounts/:id — update the allow-list.
contactsAccountRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ allowedAgentIds?: string[] | null }>()
  try {
    if (body.allowedAgentIds === undefined) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'Nothing to update' } }, 400)
    }
    const account = await setAllowList(id, body.allowedAgentIds)
    return c.json({ account })
  } catch (err) {
    return c.json({ error: { code: 'NOT_FOUND', message: err instanceof Error ? err.message : 'Not found' } }, 404)
  }
})

// DELETE /api/contacts-accounts/:id — disconnect an account.
contactsAccountRoutes.delete('/:id', async (c) => {
  await deleteContactsAccount(c.req.param('id'))
  return c.json({ ok: true })
})

export { contactsAccountRoutes }
