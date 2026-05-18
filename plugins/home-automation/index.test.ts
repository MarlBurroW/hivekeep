import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import createPlugin from './index'

// --- Helpers ---

function makeCtx(overrides?: { haUrl?: string; haToken?: string; areaFilter?: string }) {
  return {
    config: {
      haUrl: overrides?.haUrl ?? 'http://ha.local:8123',
      haToken: overrides?.haToken ?? 'test-token',
      areaFilter: overrides?.areaFilter ?? '',
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    // The plugin now routes its Home Assistant calls through ctx.http.fetch
    // so the manifest's `http:*` permission is enforced. In tests we hand
    // the global fetch (which the test's global mocks intercept) straight
    // through — no permission check, no auditing, just network IO.
    http: { fetch: (url: any, init?: any) => fetch(url, init) },
  }
}

function makeState(
  entityId: string,
  state: string,
  attrs: Record<string, unknown> = {},
): { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed: string } {
  return {
    entity_id: entityId,
    state,
    attributes: { friendly_name: entityId.replace(/\./g, ' '), ...attrs },
    last_changed: '2026-03-09T07:00:00Z',
  }
}

function getToolExecute(plugin: ReturnType<typeof createPlugin>, toolName: string) {
  const reg = (plugin.tools as Record<string, any>)[toolName]
  if (!reg) throw new Error(`Tool ${toolName} not found`)
  const t = reg.create()
  return t.execute as (...args: any[]) => Promise<any>
}

// --- Tests ---

describe('home-automation plugin', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('plugin creation', () => {
    it('returns tools, activate, and deactivate', () => {
      const plugin = createPlugin(makeCtx())
      expect(plugin.tools).toBeDefined()
      expect(plugin.activate).toBeInstanceOf(Function)
      expect(plugin.deactivate).toBeInstanceOf(Function)
      expect(Object.keys(plugin.tools)).toContain('list_entities')
      expect(Object.keys(plugin.tools)).toContain('get_entity_state')
      expect(Object.keys(plugin.tools)).toContain('toggle_entity')
      expect(Object.keys(plugin.tools)).toContain('call_service')
      expect(Object.keys(plugin.tools)).toContain('list_areas')
      expect(Object.keys(plugin.tools)).toContain('run_automation')
      expect(Object.keys(plugin.tools)).toContain('run_scene')
    })

    it('all tools have correct availability', () => {
      const plugin = createPlugin(makeCtx())
      const tools = plugin.tools as Record<string, any>

      // Read-only tools available to sub-kin
      expect(tools.list_entities.availability).toContain('sub-kin')
      expect(tools.get_entity_state.availability).toContain('sub-kin')
      expect(tools.list_areas.availability).toContain('sub-kin')

      // Write tools are main-only
      expect(tools.toggle_entity.availability).toEqual(['main'])
      expect(tools.call_service.availability).toEqual(['main'])
      expect(tools.run_automation.availability).toEqual(['main'])
      expect(tools.run_scene.availability).toEqual(['main'])
    })
  })

  describe('config validation', () => {
    it('throws when haUrl is missing', async () => {
      const plugin = createPlugin(makeCtx({ haUrl: '' }))
      const execute = getToolExecute(plugin, 'list_entities')
      await expect(execute({ limit: 10 })).rejects.toThrow(/not configured/)
    })

    it('throws when haToken is missing', async () => {
      const plugin = createPlugin(makeCtx({ haToken: '' }))
      const execute = getToolExecute(plugin, 'list_entities')
      await expect(execute({ limit: 10 })).rejects.toThrow(/not configured/)
    })
  })

  describe('list_entities', () => {
    it('returns all entities with summary fields', async () => {
      const states = [
        makeState('light.kitchen', 'on', { friendly_name: 'Kitchen Light' }),
        makeState('sensor.temp', '22.5', { friendly_name: 'Temperature', unit_of_measurement: '°C' }),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ limit: 50 })

      expect(result.total).toBe(2)
      expect(result.returned).toBe(2)
      expect(result.entities).toHaveLength(2)
      expect(result.entities[0]).toHaveProperty('entity_id')
      expect(result.entities[0]).toHaveProperty('name')
      expect(result.entities[0]).toHaveProperty('state')
    })

    it('filters by domain', async () => {
      const states = [
        makeState('light.kitchen', 'on'),
        makeState('sensor.temp', '22.5'),
        makeState('light.bedroom', 'off'),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ domain: 'light', limit: 50 })

      expect(result.total).toBe(2)
      expect(result.entities.every((e: any) => e.entity_id.startsWith('light.'))).toBe(true)
    })

    it('filters by query (case-insensitive)', async () => {
      const states = [
        makeState('light.kitchen', 'on', { friendly_name: 'Kitchen Light' }),
        makeState('light.bedroom', 'off', { friendly_name: 'Bedroom Light' }),
        makeState('sensor.kitchen_temp', '22', { friendly_name: 'Kitchen Temp' }),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ query: 'KITCHEN', limit: 50 })

      expect(result.total).toBe(2)
      expect(result.entities.map((e: any) => e.entity_id).sort()).toEqual([
        'light.kitchen',
        'sensor.kitchen_temp',
      ])
    })

    it('filters by area when areaFilter is set', async () => {
      const states = [
        makeState('light.kitchen', 'on', { friendly_name: 'Kitchen Light', area: 'Kitchen' }),
        makeState('light.bedroom', 'off', { friendly_name: 'Bedroom Light', area: 'Bedroom' }),
        makeState('sensor.outdoor', '15', { friendly_name: 'Outdoor', area: 'Garden' }),
        makeState('sensor.no_area', '10', { friendly_name: 'No Area' }),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx({ areaFilter: 'kitchen, bedroom' }))
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ limit: 50 })

      // Kitchen, Bedroom match; No Area has no area so it passes; Garden is excluded
      expect(result.total).toBe(3)
      expect(result.entities.map((e: any) => e.entity_id).sort()).toEqual([
        'light.bedroom',
        'light.kitchen',
        'sensor.no_area',
      ])
    })

    it('sorts unavailable entities last', async () => {
      const states = [
        makeState('light.dead', 'unavailable', { friendly_name: 'AAA Dead' }),
        makeState('light.alive', 'on', { friendly_name: 'ZZZ Alive' }),
        makeState('light.also_alive', 'off', { friendly_name: 'BBB Also Alive' }),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ limit: 50 })

      // Available entities sorted alphabetically first, then unavailable
      expect(result.entities[0].name).toBe('BBB Also Alive')
      expect(result.entities[1].name).toBe('ZZZ Alive')
      expect(result.entities[2].name).toBe('AAA Dead')
    })

    it('respects limit parameter', async () => {
      const states = Array.from({ length: 20 }, (_, i) =>
        makeState(`sensor.s${i}`, String(i), { friendly_name: `Sensor ${String(i).padStart(2, '0')}` }),
      )

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ limit: 5 })

      expect(result.total).toBe(20)
      expect(result.returned).toBe(5)
      expect(result.entities).toHaveLength(5)
    })

    it('combines domain and query filters', async () => {
      const states = [
        makeState('light.kitchen', 'on', { friendly_name: 'Kitchen Light' }),
        makeState('sensor.kitchen', '22', { friendly_name: 'Kitchen Sensor' }),
        makeState('light.bedroom', 'off', { friendly_name: 'Bedroom Light' }),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ domain: 'light', query: 'kitchen', limit: 50 })

      expect(result.total).toBe(1)
      expect(result.entities[0].entity_id).toBe('light.kitchen')
    })

    it('uses entity_id as name when friendly_name is missing', async () => {
      const states = [
        { entity_id: 'sensor.raw', state: '42', attributes: {}, last_changed: '2026-01-01T00:00:00Z' },
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ limit: 50 })

      expect(result.entities[0].name).toBe('sensor.raw')
    })

    it('includes unit_of_measurement when present', async () => {
      const states = [
        makeState('sensor.temp', '22.5', { friendly_name: 'Temp', unit_of_measurement: '°C' }),
        makeState('sensor.plain', 'ok', { friendly_name: 'Plain' }),
      ]

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(states), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_entities')
      const result = await execute({ limit: 50 })

      const temp = result.entities.find((e: any) => e.entity_id === 'sensor.temp')
      const plain = result.entities.find((e: any) => e.entity_id === 'sensor.plain')
      expect(temp.unit).toBe('°C')
      expect(plain.unit).toBeUndefined()
    })
  })

  describe('get_entity_state', () => {
    it('returns entity details', async () => {
      const state = makeState('light.kitchen', 'on', {
        friendly_name: 'Kitchen Light',
        brightness: 200,
        color_temp: 350,
      })

      globalThis.fetch = mock(async () =>
        new Response(JSON.stringify(state), { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'get_entity_state')
      const result = await execute({ entity_id: 'light.kitchen' })

      expect(result.entity_id).toBe('light.kitchen')
      expect(result.name).toBe('Kitchen Light')
      expect(result.state).toBe('on')
      expect(result.attributes.brightness).toBe(200)
      expect(result.last_changed).toBe('2026-03-09T07:00:00Z')
    })

    it('handles API error', async () => {
      globalThis.fetch = mock(async () =>
        new Response('Not Found', { status: 404 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'get_entity_state')
      await expect(execute({ entity_id: 'light.nonexistent' })).rejects.toThrow(/404/)
    })
  })

  describe('toggle_entity', () => {
    it('calls the correct service and returns new state', async () => {
      const calls: { url: string; method: string }[] = []

      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        calls.push({ url: url.toString(), method: init?.method ?? 'GET' })
        // First call: POST to service; second call: GET new state
        if (init?.method === 'POST') {
          return new Response('[]', { status: 200 })
        }
        return new Response(
          JSON.stringify(makeState('light.kitchen', 'off', { friendly_name: 'Kitchen Light' })),
          { status: 200 },
        )
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'toggle_entity')
      const result = await execute({ entity_id: 'light.kitchen', action: 'turn_off' })

      expect(result.success).toBe(true)
      expect(result.new_state).toBe('off')
      expect(result.action).toBe('turn_off')
      expect(calls[0].url).toContain('/api/services/light/turn_off')
      expect(calls[0].method).toBe('POST')
    })

    it('uses correct domain from entity_id', async () => {
      const calls: string[] = []

      globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
        calls.push(url.toString())
        if (init?.method === 'POST') return new Response('[]', { status: 200 })
        return new Response(
          JSON.stringify(makeState('switch.plug', 'on')),
          { status: 200 },
        )
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'toggle_entity')
      await execute({ entity_id: 'switch.plug', action: 'toggle' })

      expect(calls[0]).toContain('/api/services/switch/toggle')
    })
  })

  describe('call_service', () => {
    it('calls the service with data and returns result', async () => {
      let capturedBody: any

      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return new Response(JSON.stringify([{ entity_id: 'light.desk' }]), { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'call_service')
      const result = await execute({
        domain: 'light',
        service: 'turn_on',
        data: { entity_id: 'light.desk', brightness: 128 },
      })

      expect(result.success).toBe(true)
      expect(result.domain).toBe('light')
      expect(result.service).toBe('turn_on')
      expect(result.affected).toBe(1)
      expect(capturedBody.entity_id).toBe('light.desk')
      expect(capturedBody.brightness).toBe(128)
    })

    it('sends empty object when data is omitted', async () => {
      let capturedBody: any

      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string)
        return new Response('[]', { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'call_service')
      await execute({ domain: 'script', service: 'morning_routine' })

      expect(capturedBody).toEqual({})
    })
  })

  describe('run_automation', () => {
    it('triggers the automation and returns success', async () => {
      let calledUrl = ''

      globalThis.fetch = mock(async (url: string) => {
        calledUrl = url.toString()
        return new Response('[]', { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'run_automation')
      const result = await execute({ entity_id: 'automation.morning_lights' })

      expect(result.success).toBe(true)
      expect(result.entity_id).toBe('automation.morning_lights')
      expect(calledUrl).toContain('/api/services/automation/trigger')
    })
  })

  describe('run_scene', () => {
    it('activates the scene and returns success', async () => {
      let calledUrl = ''

      globalThis.fetch = mock(async (url: string) => {
        calledUrl = url.toString()
        return new Response('[]', { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'run_scene')
      const result = await execute({ entity_id: 'scene.movie_time' })

      expect(result.success).toBe(true)
      expect(result.entity_id).toBe('scene.movie_time')
      expect(calledUrl).toContain('/api/services/scene/turn_on')
    })
  })

  describe('list_areas', () => {
    it('parses template response into areas', async () => {
      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          // HA template API returns the rendered string as JSON
          return new Response(JSON.stringify('Kitchen|kitchen\nBedroom|bedroom\nGarage|garage'), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_areas')
      const result = await execute({})

      expect(result.count).toBe(3)
      expect(result.areas).toEqual([
        { id: 'kitchen', name: 'Kitchen' },
        { id: 'bedroom', name: 'Bedroom' },
        { id: 'garage', name: 'Garage' },
      ])
    })

    it('returns error when template API fails', async () => {
      globalThis.fetch = mock(async () => {
        return new Response('Internal Server Error', { status: 500 })
      }) as any

      const plugin = createPlugin(makeCtx())
      const execute = getToolExecute(plugin, 'list_areas')
      const result = await execute({})

      expect(result.error).toBeDefined()
    })
  })

  describe('activate', () => {
    it('verifies connection on activation', async () => {
      globalThis.fetch = mock(async () =>
        new Response('{}', { status: 200 }),
      ) as any

      const plugin = createPlugin(makeCtx())
      await expect(plugin.activate()).resolves.toBeUndefined()
    })

    it('warns but does not throw on connection failure', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('Connection refused')
      }) as any

      const warnings: any[] = []
      const ctx = makeCtx()
      ctx.log.warn = (...args: any[]) => warnings.push(args)

      const plugin = createPlugin(ctx)
      await expect(plugin.activate()).resolves.toBeUndefined()
      expect(warnings.length).toBeGreaterThan(0)
    })
  })

  describe('haFetch authentication', () => {
    it('sends Authorization header with Bearer token', async () => {
      let capturedHeaders: Record<string, string> = {}

      globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
        const h = init?.headers as Record<string, string>
        capturedHeaders = h
        return new Response('[]', { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx({ haToken: 'my-secret-token' }))
      const execute = getToolExecute(plugin, 'list_entities')
      await execute({ limit: 1 })

      expect(capturedHeaders['Authorization']).toBe('Bearer my-secret-token')
    })

    it('strips trailing slash from haUrl', async () => {
      let capturedUrl = ''

      globalThis.fetch = mock(async (url: string) => {
        capturedUrl = url.toString()
        return new Response('[]', { status: 200 })
      }) as any

      const plugin = createPlugin(makeCtx({ haUrl: 'http://ha.local:8123/' }))
      const execute = getToolExecute(plugin, 'list_entities')
      await execute({ limit: 1 })

      expect(capturedUrl).toBe('http://ha.local:8123/api/states')
      // Ensure no double slash after host (excluding protocol)
      expect(capturedUrl.replace('http://', '')).not.toContain('//')
    })
  })
})
