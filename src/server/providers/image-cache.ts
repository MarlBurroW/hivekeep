/**
 * Image-model dispatcher with a short in-memory cache, extracted out
 * of `providers/index.ts` so the test suite can exercise it without
 * tripping over `mock.module('@/server/providers/index', ...)` calls
 * that other tests use to stub `listModelsForProvider`. Keeping these
 * dispatchers in their own module gives them a stable, un-mocked
 * import path for the cache-behavior tests.
 *
 * Two layers:
 *   - `lookupImageModel(type, modelId, config)` — find a single model
 *     via the provider's own `listModels()`. Caches both hits and
 *     misses for the TTL window.
 *   - `describeImageModel(type, modelId, config)` — fetch the model's
 *     tunable-parameters schema via the optional
 *     `ImageProvider.describeModel()` method. Caches the response.
 *
 * Both are provider-agnostic — zero hardcoded type names. Plugins
 * drop in via the image registry and benefit immediately.
 */

import type { ProviderConfig as HivekeepProviderConfig } from '@/server/llm/core/types'
import type { ImageModel, ImageModelParamsSchema } from '@gezy/sdk'
import { getImageProvider } from '@/server/llm/image/registry'

const IMAGE_MODEL_CACHE_TTL_MS = 5 * 60_000
const imageModelCache = new Map<string, { value: ImageModel | null; expiresAt: number }>()

export async function lookupImageModel(
  type: string,
  modelId: string,
  config: HivekeepProviderConfig,
): Promise<ImageModel | null> {
  const cacheKey = `${type}::${modelId}`
  const cached = imageModelCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const provider = getImageProvider(type)
  if (!provider) return null

  const list = await provider.listModels(config)
  const found = list.find((m) => m.id === modelId) ?? null
  imageModelCache.set(cacheKey, { value: found, expiresAt: Date.now() + IMAGE_MODEL_CACHE_TTL_MS })
  return found
}

const DESCRIBE_CACHE_TTL_MS = 5 * 60_000
const describeCache = new Map<string, { value: ImageModelParamsSchema; expiresAt: number }>()

export async function describeImageModel(
  type: string,
  modelId: string,
  config: HivekeepProviderConfig,
): Promise<ImageModelParamsSchema | null> {
  const cacheKey = `${type}::${modelId}`
  const cached = describeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }

  const provider = getImageProvider(type)
  if (!provider) return null
  if (!provider.describeModel) return { params: {} }

  const model = (await lookupImageModel(type, modelId, config)) ?? { id: modelId, name: modelId }
  const schema = await provider.describeModel(model, config)

  describeCache.set(cacheKey, { value: schema, expiresAt: Date.now() + DESCRIBE_CACHE_TTL_MS })
  return schema
}

/** Test-only: flush the describe + lookup caches so tests don't bleed state. */
export function _resetImageModelCaches(): void {
  describeCache.clear()
  imageModelCache.clear()
}
