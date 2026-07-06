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
  it('rejects a 401 from the chat probe as an invalid key with response details', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ error: { message: 'bad token' } }), { status: 401 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid Kilo Gateway API key (HTTP 401)')
    expect(result.error).toContain('bad token')
    // GET /models is anonymous on Kilo, so auth must probe the authenticated
    // POST /chat/completions endpoint with a bearer token.
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://api.kilo.ai/api/gateway/chat/completions')
    expect((init as RequestInit)?.method).toBe('POST')
    expect((init as RequestInit)?.headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('rejects a 403 from the chat probe as an invalid key', async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid Kilo Gateway API key (HTTP 403)')
  })

  it('probes with a non-existent model so a valid key never spends generation tokens', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    // A model error (not 401/403) means the key was accepted.
    expect(result).toEqual({ valid: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit)?.body as string) as { model: string }
    expect(body.model).toBe('__hivekeep_auth_probe__')
  })

  it('accepts a 200 chat probe as a valid key', async () => {
    mockFetch(new Response(JSON.stringify({ choices: [] }), { status: 200 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    expect(result).toEqual({ valid: true })
  })

  it('treats a 5xx from the probe as an accepted key rather than a spurious rejection', async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: 'maintenance window' } }), { status: 503 }))

    const result = await kiloProvider.authenticate({ apiKey: 'test-key' })

    // Only 401/403 indicate a bad key; a transient server error should not block setup.
    expect(result.valid).toBe(true)
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
