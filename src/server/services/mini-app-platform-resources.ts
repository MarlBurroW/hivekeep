/**
 * Mini-App background platform resources.
 *
 * The FRONTEND platform gateway (Hivekeep.platform.*) re-dispatches to the REST
 * API carrying the user's session. A BACKGROUND backend has no user session, and
 * autonomous unattended code shouldn't get the full REST surface, so background
 * `ctx.platform.*` instead routes through this explicit, service-backed REGISTRY:
 * an allowlist of resources × CRUD operations, called with the maintainer Agent's
 * identity where an identity is needed. This mirrors how crons/webhooks/channels
 * already act server-side (service layer, explicit identity — never forged auth).
 *
 * Each binding returns a REST-shaped envelope so an app author can move logic
 * between Hivekeep.platform (frontend) and ctx.platform (backend) with the same
 * expectations. Permission gating (`platform:<resource>:<read|write>`) happens in
 * the caller (mini-app-capabilities.ts); this module only knows how to execute.
 */

export type PlatformResourceMode = 'read' | 'write'

interface ResourceBinding {
  list?: (query: URLSearchParams, agentId: string) => Promise<unknown>
  get?: (id: string, agentId: string) => Promise<unknown>
  create?: (body: Record<string, unknown>, agentId: string) => Promise<unknown>
  update?: (id: string, body: Record<string, unknown>, agentId: string) => Promise<unknown>
  remove?: (id: string, agentId: string) => Promise<unknown>
}

/** Throw a NotFound-style error the app sees as a clean message. */
function notFound(what: string): never {
  throw new Error(`${what} not found`)
}

const REGISTRY: Record<string, ResourceBinding> = {
  contacts: {
    list: async () => {
      const { listContactsWithDetails } = await import('@/server/services/contacts')
      return { contacts: await listContactsWithDetails() }
    },
    get: async (id) => {
      const { getContactWithDetails } = await import('@/server/services/contacts')
      const contact = await getContactWithDetails(id)
      if (!contact) notFound('Contact')
      return { contact }
    },
    create: async (body) => {
      const { createContact } = await import('@/server/services/contacts')
      const result = await createContact(body as never)
      if (result && typeof result === 'object' && 'error' in result) throw new Error(String((result as { error: string }).error))
      return { contact: result }
    },
    update: async (id, body) => {
      const { updateContact } = await import('@/server/services/contacts')
      const result = await updateContact(id, body as never)
      if (result && typeof result === 'object' && 'error' in result) throw new Error(String((result as { error: string }).error))
      return { contact: result }
    },
    remove: async (id) => {
      const { deleteContact } = await import('@/server/services/contacts')
      return { success: await deleteContact(id) }
    },
  },

  crons: {
    list: async () => {
      const { listCrons } = await import('@/server/services/crons')
      return { crons: await listCrons() }
    },
    get: async (id) => {
      const { getCron } = await import('@/server/services/crons')
      const cron = await getCron(id)
      if (!cron) notFound('Cron')
      return { cron }
    },
    create: async (body, agentId) => {
      const { createCron } = await import('@/server/services/crons')
      // Background-created crons are Agent-created → require user approval before
      // they activate (same gate as crons an Agent makes via its tools).
      const cron = await createCron({ ...(body as Record<string, unknown>), agentId, createdBy: 'agent' } as never)
      return { cron }
    },
    update: async (id, body) => {
      const { updateCron } = await import('@/server/services/crons')
      const cron = await updateCron(id, body as never)
      if (!cron) notFound('Cron')
      return { cron }
    },
    remove: async (id) => {
      const { deleteCron } = await import('@/server/services/crons')
      return { success: await deleteCron(id) }
    },
  },
}

/** Resources reachable from a background backend via ctx.platform. */
export function isBackgroundPlatformResource(resource: string): boolean {
  return resource in REGISTRY
}

/**
 * Execute a background platform request against the service registry.
 * Method → operation: GET(no id)=list, GET(id)=get, POST=create, PUT/PATCH=update,
 * DELETE=remove. Throws a descriptive error when the op isn't supported.
 */
export async function dispatchBackgroundPlatform(params: {
  resource: string
  method: string
  id: string | null
  query: URLSearchParams
  body: Record<string, unknown> | undefined
  agentId: string
}): Promise<unknown> {
  const { resource, method, id, query, body, agentId } = params
  const binding = REGISTRY[resource]
  if (!binding) {
    throw new Error(`Resource "${resource}" is not available from a background mini-app. Available: ${Object.keys(REGISTRY).join(', ')}.`)
  }

  const unsupported = (op: string): never => {
    throw new Error(`Operation "${op}" is not supported for resource "${resource}" in a background mini-app.`)
  }

  switch (method) {
    case 'GET':
    case 'HEAD':
      if (id) return binding.get ? binding.get(id, agentId) : unsupported('get')
      return binding.list ? binding.list(query, agentId) : unsupported('list')
    case 'POST':
      return binding.create ? binding.create(body ?? {}, agentId) : unsupported('create')
    case 'PUT':
    case 'PATCH':
      if (!id) throw new Error(`${method} on "${resource}" requires an id (e.g. /${resource}/<id>).`)
      return binding.update ? binding.update(id, body ?? {}, agentId) : unsupported('update')
    case 'DELETE':
      if (!id) throw new Error(`DELETE on "${resource}" requires an id (e.g. /${resource}/<id>).`)
      return binding.remove ? binding.remove(id, agentId) : unsupported('remove')
    default:
      throw new Error(`Unsupported method "${method}".`)
  }
}
