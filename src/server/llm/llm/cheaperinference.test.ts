import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ProviderServerError } from '@/server/llm/core/types'
import { cheaperInferenceProvider, mapModel, type CheaperInferenceModel } from './cheaperinference'

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

describe('Cheaper Inference authenticate', () => {
  it('rejects a 401 from GET /v1/models as an invalid key with response details', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({ error: { message: 'Invalid API key.' } }), { status: 401 }))

    const result = await cheaperInferenceProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid Cheaper Inference API key (HTTP 401)')
    expect(result.error).toContain('Invalid API key.')
    // GET /v1/models needs a valid key on Cheaper Inference, so it is the probe.
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('https://api.cheaperinference.com/v1/models')
    expect((init as RequestInit)?.headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('rejects a 403 as an invalid key', async () => {
    mockFetch(new Response(JSON.stringify({ error: { message: 'forbidden' } }), { status: 403 }))

    const result = await cheaperInferenceProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Invalid Cheaper Inference API key (HTTP 403)')
  })

  it('accepts a 200 from GET /v1/models as a valid key', async () => {
    mockFetch(new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }))

    const result = await cheaperInferenceProvider.authenticate({ apiKey: 'test-key' })

    expect(result).toEqual({ valid: true })
  })

  it('reports other statuses with response details instead of accepting the key', async () => {
    mockFetch(new Response('temporarily overloaded', { status: 502 }))

    const result = await cheaperInferenceProvider.authenticate({ apiKey: 'test-key' })

    expect(result.valid).toBe(false)
    expect(result.error).toContain('HTTP 502')
    expect(result.error).toContain('temporarily overloaded')
  })

  it('rejects a missing key without a request', async () => {
    const fetchMock = mockFetch(new Response('{}', { status: 200 }))

    const result = await cheaperInferenceProvider.authenticate({ apiKey: '  ' })

    expect(result.valid).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Cheaper Inference listModels', () => {
  it('reads the public catalog and keeps only streaming chat models', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({
      models: [
        {
          id: 'gpt-5.4-mini',
          model_type: 'text',
          supported_endpoints: ['/v1/chat/completions', '/v1/responses'],
          supports_streaming: true,
          context_length: 400000,
          max_output_tokens: 128000,
          features: ['image-input', 'tool-use'],
        },
        { id: 'text-embedding-3-small', model_type: 'embedding', supported_endpoints: ['/v1/embeddings'] },
      ],
    }), { status: 200 }))

    const models = await cheaperInferenceProvider.listModels({ apiKey: 'test-key' })

    expect(models.map((m) => m.id)).toEqual(['gpt-5.4-mini'])
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.cheaperinference.com/public/models')
  })

  it('maps unexpected catalog errors to provider server errors with response details', async () => {
    mockFetch(new Response('temporarily overloaded', { status: 502 }))

    try {
      await cheaperInferenceProvider.listModels({ apiKey: 'test-key' })
      throw new Error('Expected listModels to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderServerError)
      expect((err as Error).message).toContain('temporarily overloaded')
    }
  })
})

describe('Cheaper Inference mapModel', () => {
  const sonnet: CheaperInferenceModel = {
    id: 'claude-sonnet-5',
    model_type: 'text',
    supported_endpoints: ['/v1/chat/completions', '/v1/messages'],
    supports_streaming: true,
    supports_vision: true,
    context_length: 1000000,
    max_output_tokens: 128000,
    features: ['image-input', 'tool-use', 'reasoning', 'explicit-caching'],
    input_per_million: '3.000000',
    output_per_million: '15.000000',
    cache_read_per_million: '0.300000',
  }

  it('maps catalog metadata', () => {
    const m = mapModel(sonnet)!
    expect(m.id).toBe('claude-sonnet-5')
    expect(m.name).toBe('claude-sonnet-5')
    expect(m.contextWindow).toBe(1000000)
    expect(m.maxOutput).toBe(128000)
    expect(m.supportsImageInput).toBe(true)
    expect(m.supportsPromptCaching).toBe(true)
    expect(m.supportsParallelTools).toBe(true)
    expect(m.maxTools).toBeUndefined()
    expect(m.pricing).toEqual({ input: 3, output: 15, cacheRead: 0.3 })
  })

  it('does not advertise thinking efforts the catalog does not document', () => {
    expect(mapModel(sonnet)?.thinking).toBeUndefined()
  })

  it('marks models without tool-use with maxTools 0', () => {
    expect(mapModel({ ...sonnet, features: ['reasoning'] })?.maxTools).toBe(0)
  })

  it('drops non-chat, non-streaming, hidden and id-less entries', () => {
    expect(mapModel({ id: 'gpt-image-2', model_type: 'image' })).toBeNull()
    expect(mapModel({ ...sonnet, supported_endpoints: ['/v1/responses'] })).toBeNull()
    expect(mapModel({ ...sonnet, supports_streaming: false })).toBeNull()
    expect(mapModel({ ...sonnet, is_visible: false })).toBeNull()
    expect(mapModel({ id: '' })).toBeNull()
  })
})
