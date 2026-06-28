import { describe, expect, it } from 'bun:test'
import { ProviderServerError } from '@/server/llm/core/types'
import { imageModelEndpointsPath, mapModel, mapParamSpec, openrouterImageProvider, type OpenRouterImageModel } from './openrouter'

const gptImage: OpenRouterImageModel = {
  id: 'openai/gpt-image-1',
  name: 'OpenAI: GPT Image 1',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  supported_parameters: {
    quality: { type: 'enum', values: ['auto', 'low', 'medium', 'high'] },
    n: { type: 'range', min: 1, max: 10 },
    input_references: { type: 'range', min: 0, max: 16 },
    output_compression: { type: 'range', min: 0, max: 100 },
  },
}

describe('OpenRouter image mapModel', () => {
  it('maps image models and max image inputs from input_references', () => {
    const m = mapModel(gptImage)!
    expect(m.id).toBe('openai/gpt-image-1')
    expect(m.name).toBe('OpenAI: GPT Image 1')
    expect(m.maxImageInputs).toBe(16)
  })

  it('drops non-image output, missing modality, and id-less models', () => {
    expect(mapModel({ id: 'text', architecture: { output_modalities: ['text'] } })).toBeNull()
    expect(mapModel({ id: 'unknown-no-modalities' })).toBeNull()
    expect(mapModel({ id: '' })).toBeNull()
  })

  it('maps per-image pricing from endpoint records', () => {
    const m = mapModel(gptImage, [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }])!
    expect(m.pricing).toEqual({ perImage: 0.04 })
  })
})

describe('OpenRouter image endpoint paths', () => {
  it('keeps author/slug path structure while encoding unsafe segment characters', () => {
    expect(imageModelEndpointsPath('openai/gpt-image-1')).toBe('https://openrouter.ai/api/v1/images/models/openai/gpt-image-1/endpoints')
    expect(imageModelEndpointsPath('vendor/model:free')).toBe('https://openrouter.ai/api/v1/images/models/vendor/model%3Afree/endpoints')
  })
})

describe('OpenRouter image parameter mapping', () => {
  it('maps enum, integer range, numeric range, and boolean descriptors', () => {
    expect(mapParamSpec({ type: 'enum', values: ['1:1', '16:9'] })).toEqual({ type: 'string', enum: ['1:1', '16:9'] })
    expect(mapParamSpec({ type: 'range', min: 1, max: 10 })).toEqual({ type: 'integer', minimum: 1, maximum: 10 })
    expect(mapParamSpec({ type: 'range', min: 0.1, max: 2.5 })).toEqual({ type: 'number', minimum: 0.1, maximum: 2.5 })
    expect(mapParamSpec({ type: 'boolean' })).toEqual({ type: 'boolean' })
  })
})

describe('openrouterImageProvider.generate', () => {
  it('posts to the dedicated /images endpoint and decodes base64 data', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA', media_type: 'image/webp' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await openrouterImageProvider.generate(
        { id: 'openai/gpt-image-1', name: 'GPT Image', maxImageInputs: 1 },
        {
          prompt: 'a cat',
          size: '1024x1024',
          params: { quality: 'high' },
          imageInputs: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
        },
        { apiKey: 'sk-or-test' },
      )
      expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/images')
      expect(calls[0]?.body.model).toBe('openai/gpt-image-1')
      expect(calls[0]?.body.prompt).toBe('a cat')
      expect(calls[0]?.body.n).toBe(1)
      expect(calls[0]?.body.quality).toBe('high')
      expect(calls[0]?.body.input_references).toEqual(['data:image/png;base64,AQID'])
      expect(result.mediaType).toBe('image/webp')
      expect(result.data.length).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps HTTP errors to provider errors', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'upstream empty' } }), { status: 500 })) as unknown as typeof fetch
    try {
      await expect(
        openrouterImageProvider.generate(
          { id: 'x/image', name: 'Image' },
          { prompt: 'x' },
          { apiKey: 'sk-or-test' },
        ),
      ).rejects.toBeInstanceOf(ProviderServerError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
