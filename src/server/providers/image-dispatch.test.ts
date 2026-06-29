/**
 * Tests for the image-model dispatcher helpers added with the
 * `describe_image_model` tool and the lookup cache:
 *   - `lookupImageModel(type, modelId, config)`
 *   - `describeImageModel(type, modelId, config)`
 *
 * Both layer a 5-minute in-memory cache on top of the image provider
 * registry. Coverage here keeps cache invalidation, fallback paths,
 * and provider-not-found edges from regressing silently.
 *
 * We register a fake `ImageProvider` against a unique synthetic type
 * name so we don't collide with the built-in OpenAI image provider
 * or any plugin-contributed provider in the registry.
 */

import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test'
// Import directly from the sibling module (not via `providers/index`)
// so we sidestep the `mock.module('@/server/providers/index', ...)`
// stubbing that image-tools.test.ts installs at module-load time.
import {
  lookupImageModel,
  describeImageModel,
  _resetImageModelCaches,
} from '@/server/providers/image-cache'
import {
  registerImageProvider,
  unregisterImageProvider,
} from '@/server/llm/image/registry'
import type {
  ImageProvider,
  ImageModel,
  ImageModelParamsSchema,
} from '@gezy/sdk'

const FAKE_TYPE = '__test-image-provider__'

const sampleModels: ImageModel[] = [
  { id: 'fake/text-to-image', name: 'Text-to-image' },
  { id: 'fake/edit', name: 'Edit', maxImageInputs: 1 },
  { id: 'fake/multi', name: 'Multi-ref', maxImageInputs: 4 },
]

function makeFakeProvider(opts: {
  listModels?: () => Promise<ImageModel[]>
  describeModel?: ((model: ImageModel) => Promise<ImageModelParamsSchema>) | undefined
} = {}): ImageProvider {
  const listFn = opts.listModels ?? (async () => sampleModels)
  const provider: ImageProvider = {
    type: FAKE_TYPE,
    displayName: 'Fake Image Provider',
    configSchema: [],
    async authenticate() {
      return { valid: true }
    },
    listModels: mock(listFn),
    async generate() {
      throw new Error('not used in dispatcher tests')
    },
  }
  if (opts.describeModel !== undefined) {
    provider.describeModel = mock(opts.describeModel)
  }
  return provider
}

beforeEach(() => {
  unregisterImageProvider(FAKE_TYPE)
  _resetImageModelCaches()
})

afterAll(() => {
  unregisterImageProvider(FAKE_TYPE)
  _resetImageModelCaches()
})

// ─── lookupImageModel ─────────────────────────────────────────────────────────

describe('lookupImageModel', () => {
  it('returns null for an unregistered provider type', async () => {
    const result = await lookupImageModel('does-not-exist', 'foo/bar', {})
    expect(result).toBeNull()
  })

  it('returns the matching model when listModels exposes it', async () => {
    registerImageProvider(makeFakeProvider())
    const result = await lookupImageModel(FAKE_TYPE, 'fake/edit', {})
    expect(result).not.toBeNull()
    expect(result?.id).toBe('fake/edit')
    expect(result?.maxImageInputs).toBe(1)
  })

  it('returns null (cached) when the listing does NOT contain the model id', async () => {
    registerImageProvider(makeFakeProvider())
    const result = await lookupImageModel(FAKE_TYPE, 'nope/missing', {})
    expect(result).toBeNull()
  })

  it('caches the result — second call within the TTL does not re-hit listModels', async () => {
    const provider = makeFakeProvider()
    registerImageProvider(provider)

    await lookupImageModel(FAKE_TYPE, 'fake/edit', {})
    await lookupImageModel(FAKE_TYPE, 'fake/edit', {})
    await lookupImageModel(FAKE_TYPE, 'fake/edit', {})

    // listModels is the only network-y path; we should have called it
    // exactly once across the 3 lookups thanks to the cache.
    expect((provider.listModels as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it('caches the null result for unknown model ids too', async () => {
    const provider = makeFakeProvider()
    registerImageProvider(provider)

    await lookupImageModel(FAKE_TYPE, 'nope/missing', {})
    await lookupImageModel(FAKE_TYPE, 'nope/missing', {})

    expect((provider.listModels as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it('_resetImageModelCaches clears the cache — next call re-hits listModels', async () => {
    const provider = makeFakeProvider()
    registerImageProvider(provider)

    await lookupImageModel(FAKE_TYPE, 'fake/edit', {})
    expect((provider.listModels as ReturnType<typeof mock>).mock.calls).toHaveLength(1)

    _resetImageModelCaches()
    await lookupImageModel(FAKE_TYPE, 'fake/edit', {})
    expect((provider.listModels as ReturnType<typeof mock>).mock.calls).toHaveLength(2)
  })
})

// ─── describeImageModel ───────────────────────────────────────────────────────

describe('describeImageModel', () => {
  it('returns null when the provider type is not registered', async () => {
    const result = await describeImageModel('not-registered', 'foo/bar', {})
    expect(result).toBeNull()
  })

  it("returns { params: {} } when the provider doesn't implement describeModel", async () => {
    registerImageProvider(makeFakeProvider()) // no describeModel passed
    const result = await describeImageModel(FAKE_TYPE, 'fake/edit', {})
    expect(result).toEqual({ params: {} })
  })

  it('returns the schema produced by describeModel when implemented', async () => {
    const schema: ImageModelParamsSchema = {
      params: {
        guidance_scale: { type: 'number', default: 3.5, minimum: 0, maximum: 10 },
        seed: { type: 'integer' },
      },
    }
    registerImageProvider(makeFakeProvider({ describeModel: async () => schema }))

    const result = await describeImageModel(FAKE_TYPE, 'fake/edit', {})
    expect(result).toEqual(schema)
  })

  it('caches the result — second call does not re-invoke describeModel', async () => {
    const describeFn = mock(async () => ({ params: {} }))
    const provider = makeFakeProvider()
    provider.describeModel = describeFn
    registerImageProvider(provider)

    await describeImageModel(FAKE_TYPE, 'fake/edit', {})
    await describeImageModel(FAKE_TYPE, 'fake/edit', {})

    expect(describeFn.mock.calls).toHaveLength(1)
  })

  it('looks up the real model object via the lookup cache before calling describeModel', async () => {
    let observedModel: ImageModel | undefined
    registerImageProvider(
      makeFakeProvider({
        describeModel: async (model) => {
          observedModel = model
          return { params: {} }
        },
      }),
    )

    await describeImageModel(FAKE_TYPE, 'fake/multi', {})

    expect(observedModel?.id).toBe('fake/multi')
    // Carries the full metadata from listModels (not the {id, name} stub).
    expect(observedModel?.maxImageInputs).toBe(4)
  })

  it('falls back to an {id, name} stub when the model is not in the listing', async () => {
    let observedModel: ImageModel | undefined
    registerImageProvider(
      makeFakeProvider({
        describeModel: async (model) => {
          observedModel = model
          return { params: {} }
        },
      }),
    )

    await describeImageModel(FAKE_TYPE, 'unknown/model', {})

    expect(observedModel?.id).toBe('unknown/model')
    expect(observedModel?.name).toBe('unknown/model')
    expect(observedModel?.maxImageInputs).toBeUndefined()
  })

  it('separate cache from lookupImageModel — clearing one resets both', async () => {
    const describeFn = mock(async () => ({ params: {} }))
    const provider = makeFakeProvider()
    provider.describeModel = describeFn
    registerImageProvider(provider)

    await describeImageModel(FAKE_TYPE, 'fake/edit', {})
    expect(describeFn.mock.calls).toHaveLength(1)

    _resetImageModelCaches()
    await describeImageModel(FAKE_TYPE, 'fake/edit', {})
    expect(describeFn.mock.calls).toHaveLength(2)
  })
})
