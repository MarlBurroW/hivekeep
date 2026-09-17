import { describe, expect, it } from 'bun:test'
import { mapModel, messagesToOllama, ollamaProvider, type OllamaTagModel } from './ollama'
import type { HivekeepMessage } from '@/server/llm/llm/types'

describe('Ollama Cloud mapModel', () => {
  it('maps native /api/tags model entries', () => {
    const raw: OllamaTagModel = { model: 'gpt-oss:120b', name: 'ignored' }
    const m = mapModel(raw)!
    expect(m.id).toBe('gpt-oss:120b')
    expect(m.name).toBe('gpt-oss:120b')
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
  })

  it('falls back to name and drops id-less entries', () => {
    expect(mapModel({ name: 'qwen3-coder:480b-cloud' })?.id).toBe('qwen3-coder:480b-cloud')
    expect(mapModel({})).toBeNull()
  })
})

describe('Ollama messagesToOllama tool-result correlation', () => {
  it('maps tool_name back to the original function name, not the suffixed tool-use id', () => {
    // Two parallel calls to the same tool get distinct (suffixed) ids, but Ollama
    // correlates results by function name, so tool_name must be the bare name.
    const messages: HivekeepMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-use', id: 'get_weather_0', name: 'get_weather', args: { city: 'Paris' } },
          { type: 'tool-use', id: 'get_weather_1', name: 'get_weather', args: { city: 'Berlin' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', toolUseId: 'get_weather_0', content: '18°C' },
          { type: 'tool-result', toolUseId: 'get_weather_1', content: '15°C' },
        ],
      },
    ]
    const out = messagesToOllama(messages)
    const toolMsgs = out.filter((m) => m['role'] === 'tool')
    expect(toolMsgs).toEqual([
      { role: 'tool', content: '18°C', tool_name: 'get_weather' },
      { role: 'tool', content: '15°C', tool_name: 'get_weather' },
    ])
  })
})

describe('ollamaProvider.listModels', () => {
  it('uses Ollama Cloud /api/tags with bearer auth and optional base URL override', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), auth: headers.get('authorization') })
      return new Response(JSON.stringify({ models: [{ model: 'gpt-oss:120b' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const models = await ollamaProvider.listModels({ apiKey: 'ollama-test', baseUrl: 'https://example.test/api/' })
      expect(calls[0]).toEqual({ url: 'https://example.test/api/tags', auth: 'Bearer ollama-test' })
      expect(models.map((m) => m.id)).toEqual(['gpt-oss:120b'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
