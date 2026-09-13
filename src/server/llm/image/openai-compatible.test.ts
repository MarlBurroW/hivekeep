import { describe, expect, it, mock, beforeEach } from 'bun:test'
import {
  isLikelyImageModelId,
  inferMaxImageInputs,
  mapModel,
  parseImageModelIds,
} from './openai-compatible'
import { InvalidRequestError, ProviderServerError } from '@/server/llm/core/types'

// Capture the calls/responses the production code makes against the
// mocked `openai` SDK. Reset before each test so assertions stay local.
let lastClientOpts: { apiKey?: string; baseURL?: string } | undefined
type ImageApiItem = { b64_json?: string; url?: string }
const mockImagesGenerate = mock(() => Promise.resolve({ data: [{ b64_json: 'AAAA' }] as ImageApiItem[] }))
const mockImagesEdit = mock(() => Promise.resolve({ data: [{ b64_json: 'BBBB' }] as ImageApiItem[] }))

mock.module('openai', () => {
  class APIError extends Error {
    status: number
    headers: Record<string, string>
    constructor(status: number, message: string) {
      super(message)
      this.name = 'APIError'
      this.status = status
      this.headers = {}
    }
  }
  function OpenAI(opts: { apiKey: string; baseURL?: string }) {
    lastClientOpts = opts
    return {
      images: { generate: mockImagesGenerate, edit: mockImagesEdit },
    }
  }
  return {
    default: OpenAI,
    APIError,
    toFile: async (data: Uint8Array, name: string, _opts?: { type?: string }) => ({ data, name }),
  }
})

// Import AFTER the module mock so generate() picks up our fakes.
const { openaiCompatibleImageProvider } = await import('./openai-compatible')

const CONFIG = { baseUrl: 'http://localhost:8000/v1', apiKey: 'sk-test' }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function withFetch<T>(
  impl: (url: string, init?: RequestInit) => Promise<Response> | Response,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch
  ;(globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => impl(String(input), init)) as typeof fetch
  return body().finally(() => {
    globalThis.fetch = original
  })
}

beforeEach(() => {
  lastClientOpts = undefined
  mockImagesGenerate.mockReset()
  mockImagesEdit.mockReset()
  mockImagesGenerate.mockImplementation(() => Promise.resolve({ data: [{ b64_json: 'AAAA' }] }))
  mockImagesEdit.mockImplementation(() => Promise.resolve({ data: [{ b64_json: 'BBBB' }] }))
})

// ─── Heuristics ──────────────────────────────────────────────────────────────

describe('isLikelyImageModelId', () => {
  it('keeps well-known image generation families', () => {
    for (const id of [
      'dall-e-3',
      'dall-e-2',
      'gpt-image-1',
      'black-forest-labs/flux-schnell',
      'flux.1-dev',
      'stable-diffusion-xl',
      'sdxl',
      'imagen-3.0-generate-002',
      'gemini-2.5-flash-image',
      'qwen-image',
      'midjourney',
      'recraft-v3',
    ]) {
      expect(isLikelyImageModelId(id)).toBe(true)
    }
  })

  it('drops chat, embed, speech, and vision-language ids', () => {
    for (const id of [
      'gpt-4o',
      'gpt-4o-mini',
      'claude-sonnet-4-6',
      'text-embedding-3-small',
      'nomic-embed-text',
      'whisper-1',
      'tts-1',
      'llama3.3:70b',
      'qwen2.5-vl',
      'llama-3.2-vision',
      'llava',
      'bakllava',
      'moondream',
      'pixtral-12b',
    ]) {
      expect(isLikelyImageModelId(id)).toBe(false)
    }
  })
})

describe('inferMaxImageInputs', () => {
  it('marks gpt-image and dall-e-2 as single-input, dall-e-3 as text-only', () => {
    expect(inferMaxImageInputs('gpt-image-1')).toBe(1)
    expect(inferMaxImageInputs('dall-e-2')).toBe(1)
    expect(inferMaxImageInputs('dall-e-3')).toBe(0)
  })

  it('treats edit / kontext families as single-input and unknown ids as text-only', () => {
    expect(inferMaxImageInputs('flux-kontext-pro')).toBe(1)
    expect(inferMaxImageInputs('seededit')).toBe(1)
    expect(inferMaxImageInputs('my-image-edit')).toBe(1)
    expect(inferMaxImageInputs('flux-schnell')).toBe(0)
    expect(inferMaxImageInputs('custom-art-v2')).toBe(0)
  })
})

describe('mapModel', () => {
  it('returns null for chat ids unless force is set', () => {
    expect(mapModel({ id: 'gpt-4o' })).toBeNull()
    expect(mapModel({ id: 'gpt-4o' }, { force: true })?.id).toBe('gpt-4o')
  })

  it('attaches known sizes and maxImageInputs for OpenAI families', () => {
    const gpt = mapModel({ id: 'gpt-image-1' })!
    expect(gpt.maxImageInputs).toBe(1)
    expect(gpt.supportedSizes).toContain('1024x1024')
    expect(mapModel({ id: 'flux-schnell' })?.supportedSizes).toBeUndefined()
  })

  it('returns null for entries without an id', () => {
    expect(mapModel({ id: '' })).toBeNull()
  })
})

describe('parseImageModelIds', () => {
  it('splits on commas, whitespace and semicolons, dropping empties and dupes', () => {
    expect(parseImageModelIds('flux-schnell, dall-e-3\nflux-schnell; my-art')).toEqual([
      'flux-schnell',
      'dall-e-3',
      'my-art',
    ])
  })

  it('returns [] for empty / missing input', () => {
    expect(parseImageModelIds(undefined)).toEqual([])
    expect(parseImageModelIds('  ')).toEqual([])
  })
})

// ─── authenticate ────────────────────────────────────────────────────────────

describe('openaiCompatibleImageProvider.authenticate', () => {
  it('returns valid:true when GET /models is 200', async () => {
    const result = await withFetch(
      () => jsonResponse({ data: [] }),
      () => openaiCompatibleImageProvider.authenticate(CONFIG),
    )
    expect(result.valid).toBe(true)
  })

  it('returns valid:false when the key is rejected', async () => {
    const result = await withFetch(
      () => jsonResponse({ error: { message: 'nope' } }, 401),
      () => openaiCompatibleImageProvider.authenticate(CONFIG),
    )
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/rejected/i)
  })

  it('tells the user a key is required when 401 lands with no key configured', async () => {
    const result = await withFetch(
      () => jsonResponse({}, 401),
      () => openaiCompatibleImageProvider.authenticate({ baseUrl: CONFIG.baseUrl }),
    )
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/requires an API key/i)
  })

  it('returns valid:false when baseUrl is missing', async () => {
    const result = await openaiCompatibleImageProvider.authenticate({})
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/base URL/i)
  })
})

// ─── listModels ──────────────────────────────────────────────────────────────

describe('openaiCompatibleImageProvider.listModels', () => {
  it('keeps only image-looking ids from a mixed /models catalogue', async () => {
    const models = await withFetch(
      () => jsonResponse({
        data: [
          { id: 'gpt-4o' },
          { id: 'text-embedding-3-small' },
          { id: 'gpt-image-1' },
          { id: 'dall-e-3' },
          { id: 'flux-schnell' },
          { id: 'whisper-1' },
          { id: 'llava' },
        ],
      }),
      () => openaiCompatibleImageProvider.listModels(CONFIG),
    )
    const ids = models.map((m) => m.id)
    expect(ids).toEqual(['gpt-image-1', 'dall-e-3', 'flux-schnell'])
  })

  it('does not invent a static fallback catalogue when /models lists no image ids', async () => {
    const models = await withFetch(
      () => jsonResponse({ data: [{ id: 'llama3.3:70b' }] }),
      () => openaiCompatibleImageProvider.listModels(CONFIG),
    )
    expect(models).toEqual([])
  })

  it('merges configured imageModels even when they fail the heuristic', async () => {
    const models = await withFetch(
      () => jsonResponse({ data: [{ id: 'gpt-4o' }, { id: 'my-art-v2' }] }),
      () => openaiCompatibleImageProvider.listModels({ ...CONFIG, imageModels: 'my-art-v2, extra-id' }),
    )
    const ids = models.map((m) => m.id)
    expect(ids).toContain('my-art-v2')
    expect(ids).toContain('extra-id')
    expect(ids).not.toContain('gpt-4o')
  })

  it('does not duplicate an id that is both listed and configured', async () => {
    const models = await withFetch(
      () => jsonResponse({ data: [{ id: 'dall-e-3' }] }),
      () => openaiCompatibleImageProvider.listModels({ ...CONFIG, imageModels: 'dall-e-3' }),
    )
    expect(models.filter((m) => m.id === 'dall-e-3')).toHaveLength(1)
  })

  it('sends Authorization only when an API key is configured', async () => {
    let headers: HeadersInit | undefined
    await withFetch(
      (url, init) => {
        expect(url).toBe('http://localhost:8000/v1/models')
        headers = init?.headers
        return jsonResponse({ data: [] })
      },
      () => openaiCompatibleImageProvider.listModels({ baseUrl: CONFIG.baseUrl }),
    )
    expect(headers).toEqual({})
  })
})

// ─── describeModel ───────────────────────────────────────────────────────────

describe('openaiCompatibleImageProvider.describeModel', () => {
  it('returns the per-family static schema for known OpenAI ids and {} otherwise', async () => {
    const gpt = await openaiCompatibleImageProvider.describeModel!(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      CONFIG,
    )
    expect(Object.keys(gpt.params)).toContain('quality')
    expect(Object.keys(gpt.params)).toContain('background')

    const dalle = await openaiCompatibleImageProvider.describeModel!(
      { id: 'dall-e-3', name: 'DALL-E 3' },
      CONFIG,
    )
    expect(Object.keys(dalle.params)).toEqual(['quality', 'style'])

    const unknown = await openaiCompatibleImageProvider.describeModel!(
      { id: 'flux-schnell', name: 'Flux' },
      CONFIG,
    )
    expect(unknown.params).toEqual({})
  })
})

// ─── generate ────────────────────────────────────────────────────────────────

describe('openaiCompatibleImageProvider.generate', () => {
  it('points the OpenAI SDK at the configured base URL and key', async () => {
    await openaiCompatibleImageProvider.generate(
      { id: 'flux-schnell', name: 'Flux' },
      { prompt: 'a cat' },
      CONFIG,
    )
    expect(lastClientOpts?.baseURL).toBe('http://localhost:8000/v1')
    expect(lastClientOpts?.apiKey).toBe('sk-test')
  })

  it('uses a placeholder key when none is configured so the SDK still constructs', async () => {
    await openaiCompatibleImageProvider.generate(
      { id: 'flux-schnell', name: 'Flux' },
      { prompt: 'a cat' },
      { baseUrl: CONFIG.baseUrl },
    )
    expect(lastClientOpts?.apiKey).toBe('sk-no-key')
  })

  it('calls images.generate when no imageInput is provided', async () => {
    const result = await openaiCompatibleImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'a cat' },
      CONFIG,
    )
    expect(mockImagesGenerate).toHaveBeenCalledTimes(1)
    expect(mockImagesEdit).not.toHaveBeenCalled()
    expect(result.mediaType).toBe('image/png')
    expect(result.data.length).toBe(3)
  })

  it('calls images.edit when imageInputs is provided', async () => {
    const result = await openaiCompatibleImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1', maxImageInputs: 1 },
      {
        prompt: 'transform this',
        imageInputs: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' }],
      },
      CONFIG,
    )
    expect(mockImagesEdit).toHaveBeenCalledTimes(1)
    expect(mockImagesGenerate).not.toHaveBeenCalled()
    expect(result.mediaType).toBe('image/png')
    expect(result.data.length).toBe(3)
  })

  it('passes response_format=b64_json for dall-e family only', async () => {
    await openaiCompatibleImageProvider.generate(
      { id: 'dall-e-3', name: 'DALL-E 3' },
      { prompt: 'something' },
      CONFIG,
    )
    const dalleArgs = (mockImagesGenerate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(dalleArgs.response_format).toBe('b64_json')

    mockImagesGenerate.mockClear()
    await openaiCompatibleImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'something' },
      CONFIG,
    )
    const gptArgs = (mockImagesGenerate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(gptArgs.response_format).toBeUndefined()

    mockImagesGenerate.mockClear()
    await openaiCompatibleImageProvider.generate(
      { id: 'flux-schnell', name: 'Flux' },
      { prompt: 'something' },
      CONFIG,
    )
    const fluxArgs = (mockImagesGenerate.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>
    expect(fluxArgs.response_format).toBeUndefined()
  })

  it('honours request.size and merges request.params', async () => {
    await openaiCompatibleImageProvider.generate(
      { id: 'gpt-image-1', name: 'GPT Image 1' },
      { prompt: 'a cat', size: '1536x1024', params: { quality: 'high' } },
      CONFIG,
    )
    const call = (mockImagesGenerate.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
    expect(call?.['size']).toBe('1536x1024')
    expect(call?.['quality']).toBe('high')
  })

  it('fetches a URL when the endpoint returns url instead of b64_json', async () => {
    mockImagesGenerate.mockImplementation(() =>
      Promise.resolve({ data: [{ url: 'https://cdn.example/out.png' }] }),
    )
    const result = await withFetch(
      (url) => {
        expect(url).toBe('https://cdn.example/out.png')
        return new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        })
      },
      () => openaiCompatibleImageProvider.generate(
        { id: 'flux-schnell', name: 'Flux' },
        { prompt: 'x' },
        CONFIG,
      ),
    )
    expect(result.mediaType).toBe('image/webp')
    expect([...result.data]).toEqual([9, 8, 7])
  })

  it('decodes a data: URL without a second fetch', async () => {
    mockImagesGenerate.mockImplementation(() =>
      Promise.resolve({ data: [{ url: 'data:image/jpeg;base64,AAAA' }] }),
    )
    const result = await openaiCompatibleImageProvider.generate(
      { id: 'flux-schnell', name: 'Flux' },
      { prompt: 'x' },
      CONFIG,
    )
    expect(result.mediaType).toBe('image/jpeg')
    expect(result.data.length).toBe(3)
  })

  it('throws ProviderServerError when no image payload comes back', async () => {
    mockImagesGenerate.mockImplementation(() => Promise.resolve({ data: [] }))
    await expect(
      openaiCompatibleImageProvider.generate(
        { id: 'flux-schnell', name: 'Flux' },
        { prompt: 'x' },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(ProviderServerError)
  })

  it('maps a 404 Images route to a clear InvalidRequestError', async () => {
    const openaiMod = await import('openai')
    const APIError = openaiMod.APIError as unknown as new (status: number, message: string) => Error
    mockImagesGenerate.mockImplementation(() => Promise.reject(new APIError(404, 'Not Found')))

    await expect(
      openaiCompatibleImageProvider.generate(
        { id: 'llama3.3:70b', name: 'llama' },
        { prompt: 'x' },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(InvalidRequestError)

    await expect(
      openaiCompatibleImageProvider.generate(
        { id: 'llama3.3:70b', name: 'llama' },
        { prompt: 'x' },
        CONFIG,
      ),
    ).rejects.toThrow(/Images API/i)
  })
})
