import { describe, test, expect, afterEach } from 'bun:test'
import {
  registerLLMProvider,
  unregisterLLMProvider,
  getLLMProvider,
} from '@/server/llm/llm/registry'
import { getPluginProviderMeta, getCapabilitiesForType } from '@/server/providers/index'
import { channelAdapters } from '@/server/channels/index'
import type { LLMProvider, ChatRequest, ChatChunk } from '@gezy/sdk'

describe('Plugin LLM provider registration (native shape)', () => {
  const fakeType = 'plugin:fake-test-plugin:test-llm'

  afterEach(() => {
    unregisterLLMProvider(fakeType)
  })

  test('registers, exposes meta, and unregisters a plugin LLM provider', () => {
    const provider: LLMProvider = {
      type: fakeType,
      displayName: 'Fake Test LLM',
      apiKeyUrl: 'https://example.com/keys',
      configSchema: [{ key: 'apiKey', type: 'secret', label: 'API Key', required: true }],
      async authenticate() { return { valid: true } },
      async listModels() {
        return [{ id: 'fake-1', name: 'Fake One', contextWindow: 4096 }]
      },
      // eslint-disable-next-line require-yield
      async *chat(_model, _request: ChatRequest): AsyncIterable<ChatChunk> {
        // never invoked in this test — registration shape check only
      },
    }

    registerLLMProvider(provider)

    expect(getLLMProvider(fakeType)).toBe(provider)
    expect(getCapabilitiesForType(fakeType)).toEqual(['llm'])

    const meta = getPluginProviderMeta()[fakeType]
    expect(meta).toBeDefined()
    expect(meta!.displayName).toBe('Fake Test LLM')
    expect(meta!.apiKeyUrl).toBe('https://example.com/keys')

    unregisterLLMProvider(fakeType)
    expect(getLLMProvider(fakeType)).toBeUndefined()
    expect(getPluginProviderMeta()[fakeType]).toBeUndefined()
  })

  test('cannot register the same provider type twice', () => {
    const provider: LLMProvider = {
      type: fakeType,
      displayName: 'Fake',
      configSchema: [],
      async authenticate() { return { valid: true } },
      async listModels() { return [] },
      // eslint-disable-next-line require-yield
      async *chat(_model, _request: ChatRequest): AsyncIterable<ChatChunk> {},
    }

    registerLLMProvider(provider)
    expect(() => registerLLMProvider(provider)).toThrow(`LLM provider already registered: ${fakeType}`)
  })
})

describe('Plugin channel registration', () => {
  const testPlatform = 'test-platform'

  test('registers and unregisters a plugin channel', () => {
    const adapter = {
      platform: testPlatform as any,
      start: async () => {},
      stop: async () => {},
      sendMessage: async () => ({ platformMessageId: '123' }),
      validateConfig: async () => ({ valid: true }),
      getBotInfo: async () => ({ name: 'TestBot' }),
    }

    channelAdapters.registerPlugin(adapter)
    expect(channelAdapters.get(testPlatform)).toBe(adapter)
    expect(channelAdapters.isPluginAdapter(testPlatform)).toBe(true)

    channelAdapters.unregisterPlugin(testPlatform)
    expect(channelAdapters.get(testPlatform)).toBeUndefined()
    expect(channelAdapters.isPluginAdapter(testPlatform)).toBe(false)
  })
})
