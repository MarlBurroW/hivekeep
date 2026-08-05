import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { providers } from '@/server/db/schema'
import { config } from '@/server/config'
import { getEmbeddingModel } from '@/server/services/app-settings'
import { loadProviderConfig } from '@/server/services/provider-config'
import { recordUsage } from '@/server/services/token-usage'
import { getEmbeddingProvider } from '@/server/llm/embedding/registry'
import { withTimeout } from '@/server/utils/with-timeout'

const log = createLogger('embeddings')

/**
 * Generate embeddings for a text string using the configured embedding provider.
 *
 * The embedding family is dispatched through the native `EmbeddingProvider`
 * registry. Today only `openai` is registered; adding Voyage / Cohere /
 * Nomic later is a single new provider file + register call away.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const provider = await findEmbeddingProvider()
  if (!provider) {
    log.warn('No embedding provider configured')
    throw new Error('No embedding provider configured')
  }

  const providerConfig = await loadProviderConfig(provider)
  const embeddingModelId = (await getEmbeddingModel()) ?? config.memory.embeddingModel

  const embeddingProvider = getEmbeddingProvider(provider.type)
  if (!embeddingProvider) {
    throw new Error(`Provider type ${provider.type} does not support embeddings`)
  }

  // Pass a minimal model object — concrete dimensions/maxInputTokens aren't
  // used by `embed()` itself (only by callers that want to size/chunk input).
  //
  // Bounded because this runs under the compacting lock (memory write-back).
  // An embedding endpoint that accepts the connection and never answers would
  // otherwise leave `compactingAgents` held forever, and the engine refuses
  // every message for that Agent while it is — with no way to clear it short
  // of a restart, since the force-compact route answers 409 in that state.
  const result = await withTimeout(
    embeddingProvider.embed(
      { id: embeddingModelId, name: embeddingModelId, dimensions: 0, maxInputTokens: 0 },
      { text },
      providerConfig,
    ),
    config.memory.embeddingTimeoutMs,
    undefined,
    'Embedding request',
  )

  recordUsage({
    callSite: 'embedding',
    callType: 'embed',
    providerType: provider.type,
    providerId: provider.id,
    modelId: embeddingModelId,
    embeddingTokens: result.inputTokens,
  })

  return result.vector
}

async function findEmbeddingProvider() {
  const allProviders = await db.select().from(providers).all()

  for (const p of allProviders) {
    try {
      const capabilities = JSON.parse(p.capabilities) as string[]
      if (capabilities.includes('embedding') && p.isValid) {
        return p
      }
    } catch {
      // Skip
    }
  }

  return null
}
