import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { vaultSecrets } from '@/server/db/schema'
import {
  listSecrets,
  createSecret,
  updateSecret,
  deleteSecret,
  listEntries,
  createEntry,
  getEntryValue,
  updateEntry,
  deleteEntry,
  addAttachment,
  getAttachment,
  deleteAttachment,
  listAttachments,
} from '@/server/services/vault'
import {
  listTypes,
  createType,
  updateType,
  deleteType,
} from '@/server/services/vault-types'
import { createLogger } from '@/server/logger'
import { VAULT_BUILTIN_TYPES } from '@/shared/constants'
import type { VaultFieldType, VaultTypeField } from '@/shared/types'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:vault')
const vaultRoutes = new Hono()

// Platform configuration: every route in this family is admin-only.
vaultRoutes.use('*', requireAdmin)

// GET /api/vault — list all secrets (keys only, never values)
vaultRoutes.get('/', async (c) => {
  const secrets = await listSecrets()
  return c.json({ secrets })
})

// POST /api/vault — create a new secret
vaultRoutes.post('/', async (c) => {
  const { key, value, description } = (await c.req.json()) as {
    key: string
    value: string
    description?: string
  }

  if (!key || !value) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Both key and value are required' } },
      400,
    )
  }

  // Check for duplicate key
  const existing = await db
    .select()
    .from(vaultSecrets)
    .where(eq(vaultSecrets.key, key))
    .get()

  if (existing) {
    return c.json(
      { error: { code: 'DUPLICATE_KEY', message: `Secret with key "${key}" already exists` } },
      409,
    )
  }

  const secret = await createSecret(key, value, undefined, description)
  log.info({ secretId: secret.id, key }, 'Vault secret created')
  return c.json({ secret }, 201)
})

// PATCH /api/vault/:id — update a secret
vaultRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json()) as { key?: string; value?: string; description?: string }

  const updated = await updateSecret(id, body)
  if (!updated) {
    return c.json({ error: { code: 'SECRET_NOT_FOUND', message: 'Secret not found' } }, 404)
  }

  return c.json({ secret: updated })
})

// DELETE /api/vault/:id — delete a secret
vaultRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id')

  const deleted = await deleteSecret(id)
  if (!deleted) {
    return c.json({ error: { code: 'SECRET_NOT_FOUND', message: 'Secret not found' } }, 404)
  }

  log.info({ secretId: id }, 'Vault secret deleted')
  return c.json({ success: true })
})

// ─── Typed Entry Routes ───────────────────────────────────────────────────────

// GET /api/vault/entries — list entries with optional filters
vaultRoutes.get('/entries', async (c) => {
  const entryType = c.req.query('type') || undefined
  const favoriteParam = c.req.query('favorite')
  const favorite = favoriteParam === 'true' ? true : favoriteParam === 'false' ? false : undefined

  const entries = await listEntries({ entryType, favorite })
  return c.json({ entries })
})

// POST /api/vault/entries — create a typed entry
vaultRoutes.post('/entries', async (c) => {
  const body = (await c.req.json()) as {
    key: string
    entryType: string
    value: string | Record<string, unknown>
    description?: string
    isFavorite?: boolean
    allowedTools?: string[] | null
    allowedHosts?: string[] | null
  }

  if (!body.key || !body.entryType || body.value === undefined) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'key, entryType, and value are required' } },
      400,
    )
  }

  // Check for duplicate key
  const existing = await db
    .select()
    .from(vaultSecrets)
    .where(eq(vaultSecrets.key, body.key))
    .get()

  if (existing) {
    return c.json(
      { error: { code: 'DUPLICATE_KEY', message: `Entry with key "${body.key}" already exists` } },
      409,
    )
  }

  const entry = await createEntry({
    key: body.key,
    entryType: body.entryType,
    value: body.value,
    description: body.description,
    isFavorite: body.isFavorite,
    allowedTools: body.allowedTools,
    allowedHosts: body.allowedHosts,
  })

  return c.json({ entry }, 201)
})

// GET /api/vault/entries/:id — get decrypted entry value
vaultRoutes.get('/entries/:id', async (c) => {
  const id = c.req.param('id')
  const result = await getEntryValue(id)

  if (!result) {
    return c.json({ error: { code: 'ENTRY_NOT_FOUND', message: 'Entry not found' } }, 404)
  }

  return c.json(result)
})

// PATCH /api/vault/entries/:id — update entry
vaultRoutes.patch('/entries/:id', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json()) as {
    key?: string
    value?: string | Record<string, unknown>
    description?: string
    entryType?: string
    isFavorite?: boolean
    allowedTools?: string[] | null
    allowedHosts?: string[] | null
  }

  const updated = await updateEntry(id, body)
  if (!updated) {
    return c.json({ error: { code: 'ENTRY_NOT_FOUND', message: 'Entry not found' } }, 404)
  }

  return c.json({ entry: updated })
})

// DELETE /api/vault/entries/:id — delete entry + cascade attachments
vaultRoutes.delete('/entries/:id', async (c) => {
  const id = c.req.param('id')
  const deleted = await deleteEntry(id)

  if (!deleted) {
    return c.json({ error: { code: 'ENTRY_NOT_FOUND', message: 'Entry not found' } }, 404)
  }

  return c.json({ success: true })
})

// ─── Attachment Routes ────────────────────────────────────────────────────────

// GET /api/vault/entries/:id/attachments — list attachments for an entry
vaultRoutes.get('/entries/:id/attachments', async (c) => {
  const entryId = c.req.param('id')
  const attachments = await listAttachments(entryId)
  return c.json({ attachments })
})

// POST /api/vault/entries/:id/attachments — upload encrypted attachment
vaultRoutes.post('/entries/:id/attachments', async (c) => {
  const entryId = c.req.param('id')

  const formData = await c.req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'File is required' } },
      400,
    )
  }

  try {
    const attachment = await addAttachment(entryId, file)
    return c.json({ attachment }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return c.json(
      { error: { code: 'UPLOAD_FAILED', message } },
      400,
    )
  }
})

// GET /api/vault/attachments/:id — download decrypted attachment
vaultRoutes.get('/attachments/:id', async (c) => {
  const attachmentId = c.req.param('id')
  const result = await getAttachment(attachmentId)

  if (!result) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }

  return new Response(result.data as unknown as BodyInit, {
    headers: {
      'Content-Type': result.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(result.name)}"`,
      'Content-Length': String(result.data.byteLength),
    },
  })
})

// DELETE /api/vault/attachments/:id — delete attachment
vaultRoutes.delete('/attachments/:id', async (c) => {
  const attachmentId = c.req.param('id')
  const deleted = await deleteAttachment(attachmentId)

  if (!deleted) {
    return c.json({ error: { code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found' } }, 404)
  }

  return c.json({ success: true })
})

// ─── Type Routes ──────────────────────────────────────────────────────────────

// GET /api/vault/types — list custom types
vaultRoutes.get('/types', async (c) => {
  const types = await listTypes()
  return c.json({ types })
})

// POST /api/vault/types — create custom type
vaultRoutes.post('/types', async (c) => {
  const body = (await c.req.json()) as {
    name: string
    slug: string
    icon?: string
    fields: VaultTypeField[]
  }

  if (!body.name || !body.slug || !body.fields || body.fields.length === 0) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'name, slug, and fields are required' } },
      400,
    )
  }

  // Prevent collision with built-in type slugs
  if ((VAULT_BUILTIN_TYPES as readonly string[]).includes(body.slug)) {
    return c.json(
      { error: { code: 'RESERVED_SLUG', message: `"${body.slug}" is a built-in type` } },
      409,
    )
  }

  try {
    const type = await createType({
      name: body.name,
      slug: body.slug,
      icon: body.icon,
      fields: body.fields,
    })
    return c.json({ type }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create type'
    return c.json({ error: { code: 'CREATE_FAILED', message } }, 400)
  }
})

// PATCH /api/vault/types/:id — update custom type
vaultRoutes.patch('/types/:id', async (c) => {
  const id = c.req.param('id')
  const body = (await c.req.json()) as {
    name?: string
    icon?: string
    fields?: VaultTypeField[]
  }

  try {
    const updated = await updateType(id, body)
    if (!updated) {
      return c.json({ error: { code: 'TYPE_NOT_FOUND', message: 'Type not found' } }, 404)
    }
    return c.json({ type: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update type'
    return c.json({ error: { code: 'UPDATE_FAILED', message } }, 400)
  }
})

// DELETE /api/vault/types/:id — delete custom type (fail if entries exist)
vaultRoutes.delete('/types/:id', async (c) => {
  const id = c.req.param('id')

  try {
    const deleted = await deleteType(id)
    if (!deleted) {
      return c.json({ error: { code: 'TYPE_NOT_FOUND', message: 'Type not found' } }, 404)
    }
    return c.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete type'
    return c.json({ error: { code: 'DELETE_FAILED', message } }, 400)
  }
})

export { vaultRoutes }
