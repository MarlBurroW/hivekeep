import { afterEach, describe, expect, it, mock } from 'bun:test'
import { AuthError, ProviderServerError } from '@/server/llm/core/types'
import { kiloProvider, mapModel, type KiloModel } from './kilo'

const originalFetch = globalThis.fetch

function mockFetch(response: Response): ReturnType<typeof mock> {
  const fetchMock = mock(async () => response)
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

afterEach(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

describe('Kilo Gateway authenticate', () => {
  it('rejects /models 401/403 as an invalid key with response details', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 401 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid Kilo Gateway API key (HTTP 401)')
    expect(result.error).toContain('bad token')
    expect(fetchMock).toHaveBeenCalledWith('https://api.kilo.ai/api/gateway/models', {
      headers: { Authorization: 'Bearer test-key' },
    })
  })

  it('accepts /models 200 without probing a hardcoded paid chat model', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ data: [{ id: 'kilo-auto/free' }] }), { status: 200 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result).toEqual({ valid: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.kilo.ai/api/gateway/models')
  })

  it('does not fail setup because anthropic/claude-haiku-latest would return 400', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-haiku-4.5' }] }), { status: 200 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('anthropic/claude-haiku-latest')
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('/chat/completions')
  })

  it('includes response body snippets for unexpected /models failures', async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: 'maintenance window' } }), { status: 503 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Kilo Gateway /models returned an unexpected response (HTTP 503)')
    expect(result.error).toContain('maintenance window')
  })
})

describe('Kilo Gateway listModels', () => {
  it('includes response body snippets when Kilo rejects model listing', async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: 'organization disabled' } }), { status: 403 }))

    try {
      await kiloProvider.listModels({ apiKey: 'test-key' })
      throw new Error('Expected listModels to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError)
      expect((err as Error).message).toContain('organization disabled')
    }
  })

  it('maps unexpected model-listing errors to provider server errors with response details', async () => {
    mockFetch(new Response('temporarily overloaded', { status: 502 }))

    try {
      await kiloProvider.listModels({ apiKey: 'test-key' })
      throw new Error('Expected listModels to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderServerError)
      expect((err as Error).message).toContain('temporarily overloaded')
    }
  })
})

describe('Kilo Gateway mapModel', () => {
  const sonnet: KiloModel = {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    context_length: 200000,
    top_provider: { max_completion_tokens: 64000 },
    pricing: { prompt: '0.000003', completion: '0.000015' },
  }

  it('maps Kilo model catalogue metadata', () => {
    const m = mapModel(sonnet)!
    expect(m.id).toBe('anthropic/claude-sonnet-4.6')
    expect(m.name).toBe('Claude Sonnet 4.6')
    expect(m.contextWindow).toBe(200000)
    expect(m.maxOutput).toBe(64000)
    expect(m.pricing).toEqual({ input: 3, output: 15 })
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
  })

  it('uses metadata when Kilo exposes vision, PDF, reasoning, and tool support', () => {
    const m = mapModel({
      ...sonnet,
      architecture: { input_modalities: ['text', 'image', 'pdf'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning_effort'],
    })!
    expect(m.supportsImageInput).toBe(true)
    expect(m.supportsPdfInput).toBe(true)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.maxTools).toBeUndefined()
  })

  it('marks explicit non-tool models with maxTools 0', () => {
    expect(mapModel({ ...sonnet, supported_parameters: ['temperature'] })?.maxTools).toBe(0)
  })

  it('drops non-text-output and id-less entries', () => {
    expect(mapModel({ id: 'image-only', output_modalities: ['image'] })).toBeNull()
    expect(mapModel({ id: '' })).toBeNull()
  })
})
