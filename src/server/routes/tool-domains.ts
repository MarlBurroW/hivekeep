import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  listToolDomains,
  getToolDomain,
  createToolDomain,
  updateToolDomain,
  deleteToolDomain,
} from '@/server/services/tool-domains'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'
import { requireAdmin } from '@/server/auth/require-admin'

const log = createLogger('routes:tool-domains')

/**
 * CRUD over the global tool domains. Built-in domains (the 26 seeded from
 * TOOL_DOMAIN_META) are read-only; custom ones can be created/edited/deleted.
 * A domain in use by a custom tool cannot be deleted (TOOL_DOMAIN_IN_USE).
 */
export const toolDomainRoutes = new Hono<{ Variables: AppVariables }>()

// Reads stay member-accessible (pickers, list views); mutations are platform
// configuration and admin-only.
toolDomainRoutes.use('*', (c, next) => (c.req.method === 'GET' ? next() : requireAdmin(c, next)))

function mapDomainError(code: string): { status: 400 | 404 | 409; message: string } {
  switch (code) {
    case 'TOOL_DOMAIN_NOT_FOUND':
      return { status: 404, message: 'Tool domain not found' }
    case 'TOOL_DOMAIN_BUILTIN_READONLY':
      return { status: 400, message: 'Built-in domains cannot be edited or deleted' }
    case 'TOOL_DOMAIN_SLUG_TAKEN':
      return { status: 409, message: 'A domain with this slug already exists' }
    case 'TOOL_DOMAIN_SLUG_INVALID':
      return { status: 400, message: 'Slug must be lowercase letters, digits and hyphens' }
    case 'TOOL_DOMAIN_LABEL_REQUIRED':
      return { status: 400, message: 'Label is required' }
    case 'TOOL_DOMAIN_ICON_REQUIRED':
      return { status: 400, message: 'Icon is required' }
    case 'TOOL_DOMAIN_COLOR_INVALID':
      return { status: 400, message: 'Color must be one of the curated tokens' }
    case 'TOOL_DOMAIN_IN_USE':
      return { status: 409, message: 'This domain is used by one or more custom tools' }
    default:
      return { status: 400, message: code }
  }
}

// GET /api/tool-domains — list all domains (built-in + custom).
toolDomainRoutes.get('/', (c) => {
  return c.json({ domains: listToolDomains() })
})

// GET /api/tool-domains/:slug — fetch one.
toolDomainRoutes.get('/:slug', (c) => {
  const d = getToolDomain(c.req.param('slug'))
  if (!d) {
    return c.json({ error: { code: 'TOOL_DOMAIN_NOT_FOUND', message: 'Tool domain not found' } }, 404)
  }
  return c.json({ domain: d })
})

// POST /api/tool-domains — create a custom domain.
toolDomainRoutes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: unknown
    label?: unknown
    icon?: unknown
    color?: unknown
    description?: unknown
  }
  if (typeof body.slug !== 'string') {
    return c.json({ error: { code: 'TOOL_DOMAIN_SLUG_INVALID', message: 'slug is required' } }, 400)
  }
  if (typeof body.label !== 'string') {
    return c.json({ error: { code: 'TOOL_DOMAIN_LABEL_REQUIRED', message: 'label is required' } }, 400)
  }
  if (typeof body.icon !== 'string') {
    return c.json({ error: { code: 'TOOL_DOMAIN_ICON_REQUIRED', message: 'icon is required' } }, 400)
  }
  if (typeof body.color !== 'string') {
    return c.json({ error: { code: 'TOOL_DOMAIN_COLOR_INVALID', message: 'color is required' } }, 400)
  }
  const description = typeof body.description === 'string' ? body.description : null
  try {
    const domain = createToolDomain({ slug: body.slug, label: body.label, icon: body.icon, color: body.color, description })
    return c.json({ domain }, 201)
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapDomainError(code)
    log.warn({ code }, 'createToolDomain failed')
    return c.json({ error: { code, message } }, status)
  }
})

async function handleUpdate(c: Context<{ Variables: AppVariables }>) {
  const slug = c.req.param('slug')
  if (!slug) {
    return c.json({ error: { code: 'TOOL_DOMAIN_NOT_FOUND', message: 'Tool domain not found' } }, 404)
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    label?: unknown
    icon?: unknown
    color?: unknown
    description?: unknown
  }
  const patch: { label?: string; icon?: string; color?: string; description?: string | null } = {}
  if (body.label !== undefined) {
    if (typeof body.label !== 'string') {
      return c.json({ error: { code: 'TOOL_DOMAIN_LABEL_REQUIRED', message: 'label must be a string' } }, 400)
    }
    patch.label = body.label
  }
  if (body.icon !== undefined) {
    if (typeof body.icon !== 'string') {
      return c.json({ error: { code: 'TOOL_DOMAIN_ICON_REQUIRED', message: 'icon must be a string' } }, 400)
    }
    patch.icon = body.icon
  }
  if (body.color !== undefined) {
    if (typeof body.color !== 'string') {
      return c.json({ error: { code: 'TOOL_DOMAIN_COLOR_INVALID', message: 'color must be a string' } }, 400)
    }
    patch.color = body.color
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return c.json({ error: { code: 'INVALID_DESCRIPTION', message: 'description must be a string' } }, 400)
    }
    patch.description = body.description as string | null
  }
  try {
    const domain = updateToolDomain(slug, patch)
    return c.json({ domain })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapDomainError(code)
    log.warn({ code, slug }, 'updateToolDomain failed')
    return c.json({ error: { code, message } }, status)
  }
}

toolDomainRoutes.put('/:slug', handleUpdate)
toolDomainRoutes.patch('/:slug', handleUpdate)

toolDomainRoutes.delete('/:slug', (c) => {
  const slug = c.req.param('slug')
  if (!slug) {
    return c.json({ error: { code: 'TOOL_DOMAIN_NOT_FOUND', message: 'Tool domain not found' } }, 404)
  }
  try {
    deleteToolDomain(slug)
    return c.json({ success: true })
  } catch (err) {
    const code = err instanceof Error ? err.message : 'INTERNAL'
    const { status, message } = mapDomainError(code)
    log.warn({ code, slug }, 'deleteToolDomain failed')
    return c.json({ error: { code, message } }, status)
  }
})
