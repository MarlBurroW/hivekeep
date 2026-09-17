import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test'
import { fullMockConfig, fullMockSchema } from '../../test-helpers'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockGenerateImage = mock((): Promise<{ base64: string; mediaType: string }> =>
  Promise.resolve({
    base64: Buffer.from('fake-png-data').toString('base64'),
    mediaType: 'image/png',
  }),
)
const mockHasImageCapability = mock(() => Promise.resolve(true))

mock.module('@/server/services/image-generation', () => ({
  generateImage: mockGenerateImage,
  generateAvatarImage: mockGenerateImage,
  hasImageCapability: mockHasImageCapability,
  findLLMProvider: mock(() => Promise.resolve(null)),
  buildAvatarPrompt: mock(() => Promise.resolve('')),
  ImageGenerationError: class ImageGenerationError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))

const mockDbAll = mock(() => Promise.resolve([]))
const mockDbInsert = mock(() => ({
  values: mock(() => Promise.resolve()),
}))
const mockDbSelect = mock(() => ({
  from: mock(() => ({
    all: mockDbAll,
  })),
}))

mock.module('@/server/db/index', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
  },
}))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  files: {},
  providers: {},
}))

const mockListModelsForProvider = mock(() =>
  Promise.resolve([
    { id: 'dall-e-3', name: 'DALL-E 3', capability: 'image', maxImageInputs: 0 },
    { id: 'gpt-image-1', name: 'GPT Image 1', capability: 'image', maxImageInputs: 1 },
    { id: 'gpt-4o', name: 'GPT-4o', capability: 'chat', supportsImageInput: false },
  ]),
)

// Import real providers/index to spread all exports — only override
// `listModelsForProvider` so the tool tests don't need a real image
// provider registered. We DO NOT mock `describeImageModel`: bun's
// `mock.module` poisons the binding globally (even across re-exports
// from `image-cache.ts`), which broke the dispatcher tests in
// providers/image-dispatch.test.ts. The describe_image_model tool
// tests below register a fake ImageProvider in the registry instead,
// matching the dispatcher tests' pattern.
const _realProvidersIndex = await import('@/server/providers/index')
mock.module('@/server/providers/index', () => ({
  ..._realProvidersIndex,
  listModelsForProvider: mockListModelsForProvider,
}))

mock.module('@/server/services/encryption', () => ({
  encrypt: mock(() => Promise.resolve('encrypted')),
  decrypt: mock(() => Promise.resolve(JSON.stringify({ apiKey: 'test-key' }))),
  encryptBuffer: mock(() => Promise.resolve(new Uint8Array())),
  decryptBuffer: mock(() => Promise.resolve(new Uint8Array())),
}))

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    upload: { ...fullMockConfig.upload, dir: '/tmp/test-uploads' },
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

// Prevent actual filesystem writes — spread real fs/promises to preserve all exports
const _realFsPromises = await import('node:fs/promises')
const mockMkdir = mock(() => Promise.resolve(undefined))
mock.module('fs/promises', () => ({
  ..._realFsPromises,
  mkdir: mockMkdir,
}))

// Mock Bun.write globally
const originalBunWrite = Bun.write
const mockBunWrite = mock(() => Promise.resolve(0))

// Import after mocks
const { listImageModelsTool, generateImageTool, describeImageModelTool } = await import('@/server/tools/image-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeCtx = (overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  agentId: 'agent-test-1',
  userId: 'user-1',
  isSubAgent: false,
  ...overrides,
})

// ─── listImageModelsTool ─────────────────────────────────────────────────────

describe('listImageModelsTool', () => {
  it('has correct availability', () => {
    expect(listImageModelsTool.availability).toEqual(['main', 'sub-agent'])
  })

  it('returns models from valid image-capable providers', async () => {
    const providers = [
      {
        id: 'p-1',
        name: 'OpenAI',
        type: 'openai',
        isValid: true,
        capabilities: JSON.stringify(['chat', 'image']),
        configEncrypted: 'encrypted-config',
      },
    ]

    // Override the mock to return providers
    const mockFrom = mock(() => ({
      all: mock(() => Promise.resolve(providers)),
    }))
    mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)

    const ctx = makeCtx()
    const t = listImageModelsTool.create(ctx)
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models).toBeDefined()
    expect(result.models.length).toBe(2) // only image capability models
    expect(result.models[0].id).toBe('dall-e-3')
    expect(result.models[0].maxImageInputs).toBe(0)
    expect(result.models[1].id).toBe('gpt-image-1')
    expect(result.models[1].maxImageInputs).toBe(1)
  })

  it('skips providers that are not valid', async () => {
    const providers = [
      {
        id: 'p-1',
        name: 'Invalid Provider',
        type: 'openai',
        isValid: false,
        capabilities: JSON.stringify(['image']),
        configEncrypted: 'encrypted-config',
      },
    ]

    const mockFrom = mock(() => ({
      all: mock(() => Promise.resolve(providers)),
    }))
    mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)

    const ctx = makeCtx()
    const t = listImageModelsTool.create(ctx)
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models).toEqual([])
    expect(result.note).toContain('No image models available')
  })

  it('skips providers without image capability', async () => {
    const providers = [
      {
        id: 'p-1',
        name: 'Chat Only',
        type: 'openai',
        isValid: true,
        capabilities: JSON.stringify(['chat']),
        configEncrypted: 'encrypted-config',
      },
    ]

    const mockFrom = mock(() => ({
      all: mock(() => Promise.resolve(providers)),
    }))
    mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)

    const ctx = makeCtx()
    const t = listImageModelsTool.create(ctx)
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models).toEqual([])
    expect(result.note).toContain('No image models available')
  })

  it('returns note when no providers exist', async () => {
    const mockFrom = mock(() => ({
      all: mock(() => Promise.resolve([])),
    }))
    mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)

    const ctx = makeCtx()
    const t = listImageModelsTool.create(ctx)
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    expect(result.models).toEqual([])
    expect(result.note).toBeDefined()
    expect(result.note).toContain('No image models available')
  })

  it('handles provider model listing errors gracefully', async () => {
    const providers = [
      {
        id: 'p-1',
        name: 'Broken Provider',
        type: 'openai',
        isValid: true,
        capabilities: JSON.stringify(['image']),
        configEncrypted: 'encrypted-config',
      },
    ]

    mockListModelsForProvider.mockRejectedValueOnce(new Error('API error'))

    const mockFrom = mock(() => ({
      all: mock(() => Promise.resolve(providers)),
    }))
    mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)

    const ctx = makeCtx()
    const t = listImageModelsTool.create(ctx)
    const result = await (t as any).execute({}, { toolCallId: 'tc-1', messages: [] })

    // Should not throw, just return empty
    expect(result.models).toEqual([])
  })
})

// ─── generateImageTool ───────────────────────────────────────────────────────

describe('generateImageTool', () => {
  beforeEach(() => {
    mockGenerateImage.mockReset()
    mockGenerateImage.mockResolvedValue({
      base64: Buffer.from('fake-png-data').toString('base64'),
      mediaType: 'image/png',
    })
    mockHasImageCapability.mockReset()
    mockHasImageCapability.mockResolvedValue(true)
    mockMkdir.mockReset()
    mockMkdir.mockResolvedValue(undefined)
    mockDbInsert.mockReset()
    mockDbInsert.mockReturnValue({
      values: mock(() => Promise.resolve()),
    })
    // Mock Bun.write
    ;(Bun as any).write = mockBunWrite
    mockBunWrite.mockReset()
    mockBunWrite.mockResolvedValue(0)
  })

  it('has correct availability', () => {
    expect(generateImageTool.availability).toEqual(['main'])
  })

  it('returns error when no image provider is available', async () => {
    mockHasImageCapability.mockResolvedValueOnce(false)

    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a cat' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toContain('No image provider configured')
    expect(mockGenerateImage).not.toHaveBeenCalled()
  })

  it('generates a PNG image successfully', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a beautiful sunset' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.success).toBe(true)
    expect(result.fileId).toBeDefined()
    expect(result.url).toContain('/api/uploads/messages/agent-test-1/')
    expect(result.mimeType).toBe('image/png')
    expect(result.size).toBeGreaterThan(0)
    expect(mockGenerateImage).toHaveBeenCalledWith('a beautiful sunset', {
      providerId: undefined,
      modelId: undefined,
      imageUrls: undefined,
      params: undefined,
    })
    expect(mockMkdir).toHaveBeenCalled()
  })

  it('handles JPEG media type correctly', async () => {
    mockGenerateImage.mockResolvedValueOnce({
      base64: Buffer.from('fake-jpg-data').toString('base64'),
      mediaType: 'image/jpeg',
    })

    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a photo' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.success).toBe(true)
    expect(result.mimeType).toBe('image/jpeg')
    expect(result.url).toContain('-generated.jpg')
  })

  it('handles WebP media type correctly', async () => {
    mockGenerateImage.mockResolvedValueOnce({
      base64: Buffer.from('fake-webp-data').toString('base64'),
      mediaType: 'image/webp',
    })

    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a painting' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.success).toBe(true)
    expect(result.mimeType).toBe('image/webp')
    expect(result.url).toContain('-generated.webp')
  })

  it('uses custom filename when provided', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a cat', filename: 'my-cat.png' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.success).toBe(true)
    expect(result.url).toContain('my-cat.png')
  })

  it('sanitizes special characters in filename', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'test', filename: 'my file (1).png' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.success).toBe(true)
    // Special chars should be replaced with underscores
    expect(result.url).not.toContain(' ')
    expect(result.url).not.toContain('(')
    expect(result.url).not.toContain(')')
  })

  it('passes providerId and modelId to generateImage', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    await (t as any).execute(
      { prompt: 'a dog', providerId: 'p-openai', modelId: 'dall-e-3' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(mockGenerateImage).toHaveBeenCalledWith('a dog', {
      providerId: 'p-openai',
      modelId: 'dall-e-3',
      imageUrls: undefined,
      params: undefined,
    })
  })

  it('passes imageUrls (single) for editing', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    await (t as any).execute(
      { prompt: 'make it blue', imageUrls: ['/api/uploads/messages/agent-1/img.png'] },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(mockGenerateImage).toHaveBeenCalledWith('make it blue', {
      providerId: undefined,
      modelId: undefined,
      imageUrls: ['/api/uploads/messages/agent-1/img.png'],
      params: undefined,
    })
  })

  it('passes imageUrls (multiple) for multi-reference models', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    await (t as any).execute(
      {
        prompt: 'combine these',
        imageUrls: ['/api/uploads/a.png', '/api/uploads/b.png'],
      },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(mockGenerateImage).toHaveBeenCalledWith('combine these', {
      providerId: undefined,
      modelId: undefined,
      imageUrls: ['/api/uploads/a.png', '/api/uploads/b.png'],
      params: undefined,
    })
  })

  it('passes params straight through to generateImage', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    await (t as any).execute(
      { prompt: 'a cat', params: { seed: 42, guidance_scale: 7.5 } },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(mockGenerateImage).toHaveBeenCalledWith('a cat', {
      providerId: undefined,
      modelId: undefined,
      imageUrls: undefined,
      params: { seed: 42, guidance_scale: 7.5 },
    })
  })

  it('returns error message when generateImage throws', async () => {
    mockGenerateImage.mockRejectedValueOnce(new Error('Rate limit exceeded'))

    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a cat' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toBe('Rate limit exceeded')
    expect(result.success).toBeUndefined()
  })

  it('returns generic error for non-Error throws', async () => {
    mockGenerateImage.mockRejectedValueOnce('string error')

    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    const result = await (t as any).execute(
      { prompt: 'a cat' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toBe('Image generation failed')
  })

  it('creates directory recursively before writing', async () => {
    const ctx = makeCtx({ agentId: 'agent-special' })
    const t = generateImageTool.create(ctx)
    await (t as any).execute(
      { prompt: 'test' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(mockMkdir).toHaveBeenCalledWith(
      '/tmp/test-uploads/messages/agent-special',
      { recursive: true },
    )
  })

  it('inserts file record into database', async () => {
    const ctx = makeCtx()
    const t = generateImageTool.create(ctx)
    await (t as any).execute(
      { prompt: 'test' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(mockDbInsert).toHaveBeenCalled()
  })
})

// ─── describeImageModelTool ──────────────────────────────────────────────────
//
// We can't mock the `describeImageModel` dispatcher directly: bun's
// `mock.module` poisons the underlying binding globally and that
// kills the dispatcher's own test file (providers/image-dispatch.test.ts).
// Instead we register a fake `ImageProvider` against a synthetic type
// in the image registry, and arrange the DB mock to return a provider
// row whose `type` matches it. The tool's real code path runs through
// the real dispatcher → real registry → fake provider.

const { registerImageProvider, unregisterImageProvider } = await import('@/server/llm/image/registry')
const { _resetImageModelCaches } = await import('@/server/providers/image-cache')
const FAKE_TYPE = '__test-describe-provider__'

function makeProviderRow(opts: { isValid?: boolean; capabilities?: string[]; type?: string } = {}) {
  return {
    id: 'p-test',
    name: 'Test',
    type: opts.type ?? FAKE_TYPE,
    isValid: opts.isValid ?? true,
    capabilities: JSON.stringify(opts.capabilities ?? ['image']),
    configEncrypted: 'encrypted',
  }
}

function stubProviderRow(row: unknown) {
  const mockFrom = mock(() => ({
    where: mock(() => ({ get: mock(() => Promise.resolve(row)) })),
  }))
  mockDbSelect.mockReturnValueOnce({ from: mockFrom } as any)
}

describe('describeImageModelTool', () => {
  beforeEach(() => {
    unregisterImageProvider(FAKE_TYPE)
    _resetImageModelCaches()
  })

  it('has correct availability', () => {
    expect(describeImageModelTool.availability).toEqual(['main', 'sub-agent'])
  })

  it('returns an error when the provider id is unknown', async () => {
    stubProviderRow(undefined)

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-missing', modelId: 'whatever/model' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toContain('not found')
  })

  it('returns an error when the provider is currently invalid', async () => {
    stubProviderRow(makeProviderRow({ isValid: false }))

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-test', modelId: 'gpt-image-1' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toContain('marked invalid')
  })

  it("returns an error when the provider doesn't expose the 'image' capability", async () => {
    stubProviderRow(makeProviderRow({ capabilities: ['llm'] }))

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-test', modelId: 'gpt-4o' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toContain("doesn't expose image generation")
  })

  it('returns an error when the provider type is not registered in the image registry', async () => {
    stubProviderRow(makeProviderRow({ type: 'mystery-vendor' }))

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-test', modelId: 'whatever' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toContain("doesn't support image-model description")
  })

  it('forwards the schema (and a helpful note) when describeModel returns params', async () => {
    registerImageProvider({
      type: FAKE_TYPE,
      displayName: 'Fake',
      configSchema: [],
      authenticate: async () => ({ valid: true }),
      listModels: async () => [{ id: 'fake/model', name: 'Fake', maxImageInputs: 1 }],
      describeModel: async () => ({
        params: {
          guidance_scale: { type: 'number', default: 3.5, minimum: 0, maximum: 10 },
          seed: { type: 'integer' },
        },
      }),
      generate: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }),
    })
    stubProviderRow(makeProviderRow())

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-test', modelId: 'fake/model' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.modelId).toBe('fake/model')
    expect(result.providerId).toBe('p-test')
    expect(Object.keys(result.params)).toEqual(['guidance_scale', 'seed'])
    expect(result.note).toContain("generate_image's `params` field")
  })

  it('returns a "no documented parameters" note when the provider implements describeModel but returns empty params', async () => {
    registerImageProvider({
      type: FAKE_TYPE,
      displayName: 'Fake',
      configSchema: [],
      authenticate: async () => ({ valid: true }),
      listModels: async () => [{ id: 'fake/bare', name: 'Bare' }],
      describeModel: async () => ({ params: {} }),
      generate: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }),
    })
    stubProviderRow(makeProviderRow())

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-test', modelId: 'fake/bare' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.params).toEqual({})
    expect(result.note).toContain('no documented parameters')
  })

  it('returns the thrown error message when describeModel throws', async () => {
    registerImageProvider({
      type: FAKE_TYPE,
      displayName: 'Fake',
      configSchema: [],
      authenticate: async () => ({ valid: true }),
      listModels: async () => [{ id: 'fake/bad', name: 'Bad' }],
      describeModel: async () => { throw new Error('upstream 503') },
      generate: async () => ({ data: new Uint8Array(), mediaType: 'image/png' }),
    })
    stubProviderRow(makeProviderRow())

    const ctx = makeCtx()
    const t = describeImageModelTool.create(ctx)
    const result = await (t as any).execute(
      { providerId: 'p-test', modelId: 'fake/bad' },
      { toolCallId: 'tc-1', messages: [] },
    )

    expect(result.error).toContain('upstream 503')
  })
})
