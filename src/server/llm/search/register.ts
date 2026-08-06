import { registerSearchProvider } from '@/server/llm/search/registry'
import { braveSearchProvider } from '@/server/llm/search/brave'
import { serpapiSearchProvider } from '@/server/llm/search/serpapi'
import { tavilySearchProvider } from '@/server/llm/search/tavily'
import { perplexitySearchProvider } from '@/server/llm/search/perplexity'
import { searxngSearchProvider } from '@/server/llm/search/searxng'
import { ollamaSearchProvider } from '@/server/llm/search/ollama'

/**
 * Register every built-in search provider in the registry. Called once at
 * server startup, after the image provider registration.
 *
 * Plugin-contributed search providers are registered by the plugin
 * loader regardless of which built-ins exist.
 */
export function registerBuiltinSearchProviders(): void {
  registerSearchProvider(braveSearchProvider)
  registerSearchProvider(serpapiSearchProvider)
  registerSearchProvider(tavilySearchProvider)
  registerSearchProvider(perplexitySearchProvider)
  registerSearchProvider(searxngSearchProvider)
  registerSearchProvider(ollamaSearchProvider)
}
