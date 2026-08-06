import { registerLLMProvider, getLLMProvider } from '@/server/llm/llm/registry'
import { anthropicKeyProvider } from '@/server/llm/llm/anthropic-key'
import { anthropicOAuthProvider } from '@/server/llm/llm/anthropic-oauth'
import { openaiKeyProvider } from '@/server/llm/llm/openai-key'
import { openaiCodexProvider } from '@/server/llm/llm/openai-codex'
import { geminiProvider } from '@/server/llm/llm/gemini'
import { openrouterProvider } from '@/server/llm/llm/openrouter'
import { kiloProvider } from '@/server/llm/llm/kilo'
import { ollamaProvider } from '@/server/llm/llm/ollama'
import { xaiProvider } from '@/server/llm/llm/xai'
import { deepseekProvider } from '@/server/llm/llm/deepseek'
import { minimaxProvider } from '@/server/llm/llm/minimax'
import { moonshotProvider } from '@/server/llm/llm/moonshot'
import { openaiCompatibleProvider } from '@/server/llm/llm/openai-compatible'

/**
 * Register every built-in LLM provider in the registry. Called once at
 * server startup before any code that may resolve a provider by type.
 */
export function registerBuiltinLLMProviders(): void {
  // Idempotent: registering the built-ins twice is a no-op. The registry is a
  // process-global singleton, so test files that each call this in `beforeAll`
  // would otherwise collide on "already registered" with whichever ran first.
  if (getLLMProvider(anthropicKeyProvider.type)) return
  registerLLMProvider(anthropicKeyProvider)
  registerLLMProvider(anthropicOAuthProvider)
  registerLLMProvider(openaiKeyProvider)
  registerLLMProvider(openaiCodexProvider)
  registerLLMProvider(geminiProvider)
  registerLLMProvider(openrouterProvider)
  registerLLMProvider(kiloProvider)
  registerLLMProvider(ollamaProvider)
  registerLLMProvider(xaiProvider)
  registerLLMProvider(deepseekProvider)
  registerLLMProvider(minimaxProvider)
  registerLLMProvider(moonshotProvider)
  registerLLMProvider(openaiCompatibleProvider)
}
