import { Hono } from 'hono'
import { pluginManager } from '@/server/services/plugins'
import { createLogger } from '@/server/logger'
import type { PluginRoute } from '@hivekeep/sdk'

const log = createLogger('routes:plugin-hooks')

// Dispatcher for plugin-declared HTTP routes, mounted publicly under
// `/api/plugin-hooks/:pluginName/*` (see the auth middleware allowlist).
// Public is the point: these routes receive webhooks and callbacks from
// external services that have no Hivekeep session. Authentication is the
// plugin handler's responsibility, and the SDK docs say so in bold.

/**
 * Match a declared route against an incoming method + path. Segments starting
 * with `:` capture a parameter; matching is exact otherwise. Returns the
 * captured params, or null when the route does not match.
 */
export function matchPluginRoute(
  route: Pick<PluginRoute, 'method' | 'path'>,
  method: string,
  path: string,
): Record<string, string> | null {
  if (route.method !== method) return null

  const wanted = route.path.split('/').filter(Boolean)
  const given = path.split('/').filter(Boolean)
  if (wanted.length !== given.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < wanted.length; i++) {
    const segment = wanted[i]!
    const value = given[i]!
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(value)
    } else if (segment !== value) {
      return null
    }
  }
  return params
}

export const pluginHookRoutes = new Hono()

pluginHookRoutes.all('/:pluginName/*', async (c) => {
  const pluginName = c.req.param('pluginName')

  const plugin = pluginManager.getPlugin(pluginName)
  if (!plugin || !plugin.enabled || !plugin.exports?.routes?.length) {
    return c.json(
      { error: { code: 'PLUGIN_ROUTE_NOT_FOUND', message: 'No such plugin route' } },
      404,
    )
  }

  // Path relative to the plugin's mount point, query string excluded.
  const prefix = `/api/plugin-hooks/${pluginName}`
  const subPath = new URL(c.req.url).pathname.slice(prefix.length) || '/'

  for (const route of plugin.exports.routes) {
    const params = matchPluginRoute(route, c.req.method, subPath)
    if (!params) continue

    try {
      return await route.handler(c.req.raw, params)
    } catch (err) {
      log.error(
        { plugin: pluginName, path: subPath, err: err instanceof Error ? err.message : String(err) },
        'Plugin route handler threw',
      )
      return c.json(
        { error: { code: 'PLUGIN_ROUTE_ERROR', message: 'Plugin route handler failed' } },
        500,
      )
    }
  }

  return c.json(
    { error: { code: 'PLUGIN_ROUTE_NOT_FOUND', message: 'No such plugin route' } },
    404,
  )
})
