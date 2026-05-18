import { tool, z } from '@kinbot-developer/sdk'
import type { PluginContext } from '@kinbot-developer/sdk'

/**
 * Home Automation plugin for KinBot.
 * Provides tools to interact with Home Assistant: list entities, toggle devices,
 * check sensors, call services, and run automations.
 */

interface HAState {
  entity_id: string
  state: string
  attributes: Record<string, any>
  last_changed: string
}

/**
 * Build a Home Assistant fetch helper bound to `ctx.http.fetch`. Going
 * through ctx is what enforces the plugin's `http:*` permission and feeds
 * KinBot's per-plugin network-call audit log.
 */
function buildHaFetch(httpFetch: PluginContext['http']['fetch']) {
  return async function haFetch(
    baseUrl: string,
    token: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<any> {
    const url = `${baseUrl.replace(/\/$/, '')}/api${path}`
    const res = await httpFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`Home Assistant API error ${res.status}: ${text}`)
    }
    return res.json()
  }
}

function friendlyName(state: HAState): string {
  return state.attributes?.friendly_name ?? state.entity_id
}

function summarizeEntity(state: HAState): {
  entity_id: string
  name: string
  state: string
  unit?: string
  area?: string
} {
  return {
    entity_id: state.entity_id,
    name: friendlyName(state),
    state: state.state,
    unit: state.attributes?.unit_of_measurement ?? undefined,
    area: state.attributes?.area ?? undefined,
  }
}

/** Mirrors the `config` section of plugin.json so `ctx.config` is typed. */
interface HomeAutomationConfig {
  haUrl?: string
  haToken?: string
  areaFilter?: string
}

export default function (ctx: PluginContext<HomeAutomationConfig>) {
  // Bind the HA fetch helper to ctx.http so every call goes through the
  // plugin permission check + per-plugin audit log.
  const haFetch = buildHaFetch(ctx.http.fetch)

  const getConfig = () => {
    const { haUrl, haToken } = ctx.config
    if (!haUrl || !haToken) {
      throw new Error(
        'Home Assistant is not configured. Go to Settings > Plugins > Home Automation to set the URL and access token.',
      )
    }
    return { haUrl, haToken }
  }

  const getAreaFilter = (): string[] => {
    const raw = ctx.config.areaFilter ?? ''
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  }

  return {
    tools: {
      list_entities: {
        availability: ['main', 'sub-kin'] as const,
        create: () =>
          tool({
            description:
              'List Home Assistant entities, optionally filtered by domain (light, switch, sensor, etc.) ' +
              'or search query. Returns entity IDs, friendly names, and current states.',
            inputSchema: z.object({
              domain: z
                .string()
                .optional()
                .describe('Entity domain filter (e.g. "light", "switch", "sensor", "climate", "cover")'),
              query: z.string().optional().describe('Search filter on entity name or ID'),
              limit: z.number().optional().default(50).describe('Max results (default 50)'),
            }),
            execute: async ({ domain, query, limit }) => {
              const { haUrl, haToken } = getConfig()
              const states: HAState[] = await haFetch(haUrl, haToken, '/states')
              const areaFilter = getAreaFilter()

              let filtered = states

              if (domain) {
                filtered = filtered.filter((s) => s.entity_id.startsWith(`${domain}.`))
              }

              if (query) {
                const q = query.toLowerCase()
                filtered = filtered.filter(
                  (s) =>
                    s.entity_id.toLowerCase().includes(q) ||
                    friendlyName(s).toLowerCase().includes(q),
                )
              }

              if (areaFilter.length > 0) {
                filtered = filtered.filter((s) => {
                  const area = (s.attributes?.area ?? '').toLowerCase()
                  return !area || areaFilter.some((a) => area.includes(a))
                })
              }

              // Sort: unavailable states last
              filtered.sort((a, b) => {
                if (a.state === 'unavailable' && b.state !== 'unavailable') return 1
                if (a.state !== 'unavailable' && b.state === 'unavailable') return -1
                return friendlyName(a).localeCompare(friendlyName(b))
              })

              const items = filtered.slice(0, limit).map(summarizeEntity)
              return {
                total: filtered.length,
                returned: items.length,
                entities: items,
              }
            },
          }),
      },

      get_entity_state: {
        availability: ['main', 'sub-kin'] as const,
        create: () =>
          tool({
            description:
              'Get the current state and attributes of a specific Home Assistant entity. ' +
              'Use this for detailed info about a device or sensor.',
            inputSchema: z.object({
              entity_id: z.string().describe('The entity ID (e.g. "light.living_room", "sensor.temperature")'),
            }),
            execute: async ({ entity_id }) => {
              const { haUrl, haToken } = getConfig()
              const state: HAState = await haFetch(haUrl, haToken, `/states/${entity_id}`)
              return {
                entity_id: state.entity_id,
                name: friendlyName(state),
                state: state.state,
                attributes: state.attributes,
                last_changed: state.last_changed,
              }
            },
          }),
      },

      toggle_entity: {
        availability: ['main'] as const,
        create: () =>
          tool({
            description:
              'Toggle a Home Assistant entity on or off (works for lights, switches, fans, etc.). ' +
              'Use action "toggle" to flip, or "turn_on"/"turn_off" for explicit control.',
            inputSchema: z.object({
              entity_id: z.string().describe('The entity ID to control'),
              action: z
                .enum(['toggle', 'turn_on', 'turn_off'])
                .default('toggle')
                .describe('Action to perform'),
            }),
            execute: async ({ entity_id, action }) => {
              const { haUrl, haToken } = getConfig()
              const domain = entity_id.split('.')[0]
              await haFetch(haUrl, haToken, `/services/${domain}/${action}`, 'POST', {
                entity_id,
              })
              // Fetch new state after action
              const newState: HAState = await haFetch(haUrl, haToken, `/states/${entity_id}`)
              return {
                success: true,
                entity_id,
                action,
                new_state: newState.state,
                name: friendlyName(newState),
              }
            },
          }),
      },

      call_service: {
        availability: ['main'] as const,
        create: () =>
          tool({
            description:
              'Call any Home Assistant service with custom data. Use for advanced control like ' +
              'setting brightness, color temperature, climate targets, cover positions, etc. ' +
              'Example: domain="light", service="turn_on", data={"entity_id":"light.desk","brightness":128}',
            inputSchema: z.object({
              domain: z.string().describe('Service domain (e.g. "light", "climate", "cover", "script")'),
              service: z.string().describe('Service name (e.g. "turn_on", "set_temperature")'),
              data: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Service data payload (must include entity_id if needed)'),
            }),
            execute: async ({ domain, service, data }) => {
              const { haUrl, haToken } = getConfig()
              const result = await haFetch(
                haUrl,
                haToken,
                `/services/${domain}/${service}`,
                'POST',
                data ?? {},
              )
              return {
                success: true,
                domain,
                service,
                affected: Array.isArray(result) ? result.length : 1,
              }
            },
          }),
      },

      list_areas: {
        availability: ['main', 'sub-kin'] as const,
        create: () =>
          tool({
            description: 'List all areas (rooms) registered in Home Assistant.',
            inputSchema: z.object({}),
            execute: async () => {
              const { haUrl, haToken } = getConfig()
              // Use the template API to get areas (REST API doesn't have a direct areas endpoint)
              try {
                const result = await haFetch(haUrl, haToken, '/template', 'POST', {
                  template:
                    '{% for area in areas() %}{{ area_name(area) }}|{{ area }}{% if not loop.last %}\n{% endif %}{% endfor %}',
                })
                const areas = (result as string)
                  .split('\n')
                  .filter(Boolean)
                  .map((line: string) => {
                    const [name, id] = line.split('|')
                    return { id: id?.trim(), name: name?.trim() }
                  })
                return { count: areas.length, areas }
              } catch {
                return { error: 'Could not fetch areas. The template API may not be available.' }
              }
            },
          }),
      },

      run_automation: {
        availability: ['main'] as const,
        create: () =>
          tool({
            description: 'Trigger a Home Assistant automation manually.',
            inputSchema: z.object({
              entity_id: z.string().describe('Automation entity ID (e.g. "automation.morning_lights")'),
            }),
            execute: async ({ entity_id }) => {
              const { haUrl, haToken } = getConfig()
              await haFetch(haUrl, haToken, '/services/automation/trigger', 'POST', {
                entity_id,
              })
              return { success: true, entity_id, message: `Automation "${entity_id}" triggered.` }
            },
          }),
      },

      run_scene: {
        availability: ['main'] as const,
        create: () =>
          tool({
            description: 'Activate a Home Assistant scene.',
            inputSchema: z.object({
              entity_id: z.string().describe('Scene entity ID (e.g. "scene.movie_time")'),
            }),
            execute: async ({ entity_id }) => {
              const { haUrl, haToken } = getConfig()
              await haFetch(haUrl, haToken, '/services/scene/turn_on', 'POST', {
                entity_id,
              })
              return { success: true, entity_id, message: `Scene "${entity_id}" activated.` }
            },
          }),
      },
    },

    async activate() {
      ctx.log.info('Home Automation plugin activated')
      // Validate connection on activation
      try {
        const { haUrl, haToken } = getConfig()
        await haFetch(haUrl, haToken, '/')
        ctx.log.info('Home Assistant connection verified')
      } catch (err) {
        ctx.log.warn({ err }, 'Could not connect to Home Assistant (will retry on tool use)')
      }
    },

    async deactivate() {
      ctx.log.info('Home Automation plugin deactivated')
    },
  }
}
