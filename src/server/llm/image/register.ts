import { registerImageProvider } from '@/server/llm/image/registry'
import { openaiImageProvider } from '@/server/llm/image/openai'
import { geminiImageProvider } from '@/server/llm/image/gemini'
import { openrouterImageProvider } from '@/server/llm/image/openrouter'

/**
 * Register every built-in image-generation provider in the registry. Called
 * once at server startup, after the LLM provider registration.
 */
export function registerBuiltinImageProviders(): void {
  registerImageProvider(openaiImageProvider)
  registerImageProvider(geminiImageProvider)
  registerImageProvider(openrouterImageProvider)
}
