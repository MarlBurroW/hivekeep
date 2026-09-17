import { describe, expect, it } from 'bun:test'
import { mapModel, openrouterEmbeddingProvider, type OpenRouterEmbeddingModel } from './openrouter'

describe('OpenRouter embedding mapModel', () => {
  const embeddingModel: OpenRouterEmbeddingModel = {
    id: 'openai/text-embedding-3-small',
    name: 'OpenAI: Text Embedding 3 Small',
    context_length: 8191,
    architecture: { output_modalities: ['embeddings'] },
    pricing: { prompt: '0.00000002' },
  }

  it('maps embedding-output models and converts metadata', () => {
    const m = mapModel(embeddingModel)!
    expect(m.id).toBe('openai/text-embedding-3-small')
    expect(m.name).toBe('OpenAI: Text Embedding 3 Small')
    expect(m.maxInputTokens).toBe(8191)
    expect(m.pricing?.input).toBe(0.02)
  })

  it('accepts singular embedding modality spelling too', () => {
    expect(mapModel({ ...embeddingModel, architecture: { output_modalities: ['embedding'] } })?.id)
      .toBe('openai/text-embedding-3-small')
  })

  it('drops chat/image/audio-only models', () => {
    expect(mapModel({ id: 'anthropic/claude-sonnet-4.5', architecture: { output_modalities: ['text'] } })).toBeNull()
    expect(mapModel({ id: 'google/nano-banana-pro', architecture: { output_modalities: ['image'] } })).toBeNull()
    expect(mapModel({ id: 'unknown-no-modalities' })).toBeNull()
  })

  it('drops entries without an id', () => {
    expect(mapModel({ id: '', architecture: { output_modalities: ['embeddings'] } })).toBeNull()
  })
})

describe('openrouterEmbeddingProvider.listModels', () => {
  it('uses the dedicated /embeddings/models endpoint and maps returned models', async () => {
    const originalFetch = globalThis.fetch
    const embeddingModel: OpenRouterEmbeddingModel = {
      id: 'openai/text-embedding-3-small',
      name: 'OpenAI: Text Embedding 3 Small',
      context_length: 8191,
      architecture: { output_modalities: ['embeddings'] },
      pricing: { prompt: '0.00000002' },
    }
    const calls: Array<{ url: string; auth: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), auth: headers.get('authorization') })
      return new Response(JSON.stringify({ data: [embeddingModel] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const models = await openrouterEmbeddingProvider.listModels({ apiKey: 'sk-or-test' })
      expect(calls[0]).toEqual({ url: 'https://openrouter.ai/api/v1/embeddings/models', auth: 'Bearer sk-or-test' })
      expect(models.map((m) => m.id)).toEqual(['openai/text-embedding-3-small'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
