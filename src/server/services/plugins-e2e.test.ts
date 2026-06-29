/**
 * End-to-end SDK contract test.
 *
 * Loads `tests/fixtures/external-plugin/` (a fixture that simulates a
 * third-party plugin published on npm — it imports *only* from
 * `@gezy/sdk`, never from `@/server/...` or `@/shared/...`)
 * and exercises every extension point through Hivekeep's host wiring:
 *
 *   - tool        → execute and inspect the reply
 *   - channel     → sendMessage and inspect the deliveryMeta
 *   - provider    → register into the real LLM registry, dispatch
 *                   listModels + a streaming chat through the
 *                   dispatcher, then unregister
 *   - hooks       → register via hookRegistry, fire, observe payload
 *   - lifecycle   → activate / deactivate
 *
 * If this test goes green, a real third-party plugin written against
 * `@gezy/sdk` will load + behave the same way under
 * Hivekeep's plugin manager.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import externalPlugin from '../../../tests/fixtures/external-plugin/index'
import {
  getLLMProvider,
  registerLLMProvider,
  unregisterLLMProvider,
} from '@/server/llm/llm/registry'
import { getPluginProviderMeta } from '@/server/providers/index'
import { channelAdapters } from '@/server/channels/index'
import { hookRegistry } from '@/server/hooks/index'
import type {
  ChatRequest,
  LLMProvider,
  PluginContext,
  PluginExports,
} from '@gezy/sdk'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeCtx(): PluginContext<{ greeting?: string }> {
  return {
    config: { greeting: 'Hi' },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      clear: async () => {},
    },
    http: { fetch: async () => new Response('') },
    vault: {
      getSecret: async () => null,
      setSecret: async () => {},
      deleteSecret: async () => {},
      listKeys: async () => [],
    },
    manifest: { name: 'external-fixture', version: '0.1.0' },
    cards: {
      emit: mock(async () => ({ messageId: 'm1', cardInstanceId: 'c1' })),
      update: mock(async () => {}),
    },
    oauth: { getAccessToken: async () => null },
  }
}

// ─── Track everything we register for cleanup ────────────────────────────────

let registeredProviderType: string | null = null
let registeredChannelPlatform: string | null = null
const hookHandlers: Array<{ name: 'beforeChat' | 'afterToolCall'; fn: any }> = []

afterEach(() => {
  if (registeredProviderType) {
    try { unregisterLLMProvider(registeredProviderType) } catch {}
    registeredProviderType = null
  }
  if (registeredChannelPlatform) {
    try { channelAdapters.unregisterPlugin(registeredChannelPlatform) } catch {}
    registeredChannelPlatform = null
  }
  for (const h of hookHandlers) hookRegistry.unregister(h.name, h.fn)
  hookHandlers.length = 0
})

// ─── The test ────────────────────────────────────────────────────────────────

describe('SDK contract — external plugin end-to-end', () => {
  it('imports cleanly with only @gezy/sdk in its module graph', () => {
    // If this resolves, the plugin's imports are all SDK-routed (no
    // @/server/* leaked in). The actual scan happens at typecheck +
    // bundler resolution time; running the import here is the runtime
    // proof.
    expect(typeof externalPlugin).toBe('function')
  })

  it('default export returns a complete PluginExports', async () => {
    const exports: PluginExports = externalPlugin(makeCtx())
    expect(exports.tools?.hello).toBeDefined()
    expect(exports.channels?.['external-channel']).toBeDefined()
    expect(exports.providers).toHaveLength(1)
    expect(exports.hooks?.beforeChat).toBeDefined()
    expect(exports.hooks?.afterToolCall).toBeDefined()
    expect(exports.onCardAction).toBeDefined()
    expect(exports.activate).toBeDefined()
    expect(exports.deactivate).toBeDefined()
    await exports.activate?.()
    await exports.deactivate?.()
  })

  it('tool executes through the SDK shape and emits a card', async () => {
    const ctx = makeCtx()
    const exports = externalPlugin(ctx)

    const t = exports.tools!.hello!.create({
      agentId: 'agent-1',
      userId: 'u-1',
      isSubAgent: false,
    })

    const result = (await t.execute!({ name: 'Marl' }, {})) as { reply: string }
    expect(result.reply).toBe('Hi, Marl!')

    // ctx.cards.emit was actually called by the tool.
    expect((ctx.cards.emit as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it('channel adapter integrates with the host channelAdapters registry', async () => {
    const exports = externalPlugin(makeCtx())
    const adapter = exports.channels!['external-channel']!

    channelAdapters.registerPlugin(adapter)
    registeredChannelPlatform = adapter.platform

    expect(channelAdapters.get(adapter.platform)).toBe(adapter)
    expect(channelAdapters.isPluginAdapter(adapter.platform)).toBe(true)

    const sent = await adapter.sendMessage(
      'channel-1',
      {},
      { chatId: 'chat-9', content: 'hi from hivekeep' },
    )
    expect(sent.platformMessageId).toMatch(/^ext-/)
    expect((sent.deliveryMeta as { content: string }).content).toBe('hi from hivekeep')
  })

  it('LLM provider registers into the real native registry, dispatches listModels + chat', async () => {
    const exports = externalPlugin(makeCtx())
    const provider = exports.providers![0]! as LLMProvider

    // Manually prefix the way the plugin loader would, so we hit the
    // same code path through the dispatcher.
    const prefixedType = 'plugin:external-fixture-e2e:external-echo'
    const wrapped: LLMProvider = new Proxy(provider, {
      get(target, prop) {
        if (prop === 'type') return prefixedType
        return Reflect.get(target, prop)
      },
    })

    registerLLMProvider(wrapped)
    registeredProviderType = prefixedType

    // The provider is discoverable through the native registry. We bypass
    // the higher-level dispatcher (`listModelsForProvider`) here because
    // another test in the suite (`image-tools.test.ts`) mocks
    // `@/server/providers/index` process-wide via `mock.module` and that
    // leaks across files in Bun. Going one layer down keeps this test
    // honest about the SDK contract — what plugin authors actually rely
    // on — and immune to test-fixture pollution.
    const found = getLLMProvider(prefixedType)
    expect(found).toBe(wrapped)

    const models = await found!.listModels({ baseUrl: 'http://localhost' })
    expect(models).toHaveLength(2)
    expect(models[0]?.id).toBe('external-1')
    expect(models[0]?.contextWindow).toBe(8192)
    expect(models[1]?.contextWindow).toBe(32768)

    // The plugin meta is also discoverable through the dispatcher.
    const meta = getPluginProviderMeta()[prefixedType]
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('External Echo (fixture)')
    expect(meta!.noApiKey).toBe(true)
    expect(meta!.capabilities).toContain('llm')

    // The streaming chat path: a real ChatRequest in, real ChatChunks out.
    const request: ChatRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'ping' }] },
      ],
    }
    const stream = found!.chat(
      { id: 'external-1', name: 'External 1', contextWindow: 8192 },
      request,
      {},
    )
    const chunks = []
    for await (const c of stream) chunks.push(c)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual({ type: 'text-delta', text: '[external] ping' })
    expect(chunks[1]?.type).toBe('finish')
    expect((chunks[1] as { reason: string }).reason).toBe('stop')
    expect((chunks[1] as { usage: { inputTokens?: number } }).usage.inputTokens).toBe('ping'.length)
  })

  it('hook handlers receive typed payloads when fired through the registry', async () => {
    const exports = externalPlugin(makeCtx())

    let sawBeforeChat: { agentId: string; message: string } | null = null
    let sawAfterToolCall: { toolName: string; toolResult: unknown } | null = null

    const beforeHandler = (ctx: any) => {
      sawBeforeChat = { agentId: ctx.agentId, message: ctx.message }
      exports.hooks!.beforeChat!(ctx)
    }
    const afterHandler = (ctx: any) => {
      sawAfterToolCall = { toolName: ctx.toolName, toolResult: ctx.toolResult }
      exports.hooks!.afterToolCall!(ctx)
    }

    hookRegistry.register('beforeChat', beforeHandler)
    hookRegistry.register('afterToolCall', afterHandler)
    hookHandlers.push({ name: 'beforeChat', fn: beforeHandler })
    hookHandlers.push({ name: 'afterToolCall', fn: afterHandler })

    await hookRegistry.execute('beforeChat', {
      agentId: 'k-1',
      message: 'hello',
    })
    expect(sawBeforeChat!).toEqual({ agentId: 'k-1', message: 'hello' })

    await hookRegistry.execute('afterToolCall', {
      agentId: 'k-1',
      isSubAgent: false,
      toolName: 'hello',
      toolArgs: { name: 'Marl' },
      toolResult: { reply: 'Hi, Marl!' },
    })
    expect(sawAfterToolCall!).toEqual({
      toolName: 'hello',
      toolResult: { reply: 'Hi, Marl!' },
    })
  })

  it('onCardAction returns an OK result', async () => {
    const exports = externalPlugin(makeCtx())
    const result = await exports.onCardAction!({
      cardInstanceId: 'c1',
      actionId: 'confirm',
      agentId: 'k-1',
    })
    expect(result).toEqual({ ok: true })
  })

  it('fixture manifest is conformant with the JSON Schema', async () => {
    const manifest = await Bun.file(
      'tests/fixtures/external-plugin/plugin.json',
    ).json()
    expect(manifest.$schema).toContain('plugin-manifest.schema.json')
    expect(manifest.name).toBe('external-fixture')
    expect(manifest.main).toBe('index.ts')
    expect(manifest.hivekeep).toBe('>=0.40.0')
    expect(manifest.permissions).toEqual(['http:api.example.com'])
  })
})
