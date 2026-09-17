import { registerEmbeddingProvider } from '@/server/llm/embedding/registry'
import { openaiEmbeddingProvider } from '@/server/llm/embedding/openai'
import { openaiCompatibleEmbeddingProvider } from '@/server/llm/embedding/openai-compatible'
import { openrouterEmbeddingProvider } from '@/server/llm/embedding/openrouter'

/**
 * Register every built-in embedding provider in the registry. Called once
 * at server startup, after the LLM provider registration.
 */
export function registerBuiltinEmbeddingProviders(): void {
  registerEmbeddingProvider(openaiEmbeddingProvider)
  registerEmbeddingProvider(openaiCompatibleEmbeddingProvider)
  registerEmbeddingProvider(openrouterEmbeddingProvider)
}
