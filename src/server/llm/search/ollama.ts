/** Ollama web search provider.
 *
 * Ollama documents a REST web search API at:
 *   POST https://ollama.com/api/web_search
 * with bearer-token API-key authentication and `{ query, max_results }`.
 * It returns SERP snippets only; no freshness/domain/language/location filters
 * and no synthesized answer are documented, so this provider advertises the
 * bare search capability only.
 */

import {
  AuthError,
  RateLimitError,
  NetworkError,
  ProviderServerError,
  InvalidRequestError,
} from '@hivekeep/sdk'
import type { AuthResult, ProviderConfig } from '@hivekeep/sdk'
import type { SearchProvider, SearchResult } from '@/server/llm/search/types'

const DEFAULT_BASE_URL = 'https://ollama.com/api'

interface OllamaSearchResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>
}

function getBaseUrl(config: ProviderConfig): string {
  return (config['baseUrl']?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function getApiKey(config: ProviderConfig): string {
  const apiKey = config['apiKey']?.trim()
  if (!apiKey) throw new AuthError('Missing Ollama API key')
  return apiKey
}

async function parseError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return `Ollama web search returned HTTP ${res.status}`
  try {
    const json = JSON.parse(text) as { error?: string | { message?: string } }
    return typeof json.error === 'string' ? json.error : json.error?.message ?? text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}

async function callSearch(config: ProviderConfig, query: string, count?: number, signal?: AbortSignal): Promise<OllamaSearchResponse> {
  let res: Response
  try {
    res = await fetch(`${getBaseUrl(config)}/web_search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getApiKey(config)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: Math.max(1, Math.min(10, count ?? 5)) }),
      signal,
    })
  } catch (err) {
    throw new NetworkError(`Ollama web search request failed: ${err instanceof Error ? err.message : String(err)}`, err)
  }
  if (res.status === 401 || res.status === 403) throw new AuthError(`Ollama web search authentication failed (HTTP ${res.status}).`)
  if (res.status === 429) throw new RateLimitError('Ollama web search rate limit exceeded.')
  if (res.status >= 500) throw new ProviderServerError(`Ollama web search server error (HTTP ${res.status}).`, res.status)
  if (!res.ok) throw new InvalidRequestError(`Ollama web search rejected the request (HTTP ${res.status}): ${await parseError(res)}`)
  return res.json() as Promise<OllamaSearchResponse>
}

export const ollamaSearchProvider: SearchProvider = {
  type: 'ollama',
  displayName: 'Ollama Web Search',
  apiKeyUrl: 'https://ollama.com/settings/keys',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API Key',
      required: true,
      description: 'Ollama API key for web search. Create one at https://ollama.com/settings/keys',
    },
    {
      key: 'baseUrl',
      type: 'url',
      label: 'Base URL',
      required: false,
      default: DEFAULT_BASE_URL,
      placeholder: DEFAULT_BASE_URL,
      description: 'Optional override. Defaults to Ollama Cloud at https://ollama.com/api.',
    },
  ],
  capabilities: {},

  async authenticate(config): Promise<AuthResult> {
    try {
      await callSearch(config, 'ping', 1)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async search(request, config): Promise<SearchResult> {
    const payload = await callSearch(config, request.query, request.count, request.signal)
    const warnings: string[] = []
    if (request.answer) warnings.push('Ollama web search does not synthesize answers; returning results only.')
    if (request.freshness && request.freshness !== 'all') warnings.push('Ollama web search does not support freshness filters.')
    if (request.domains?.include?.length || request.domains?.exclude?.length) warnings.push('Ollama web search does not support domain filters.')
    if (request.lang) warnings.push('Ollama web search does not support language filtering.')
    if (request.location) warnings.push('Ollama web search does not support location filtering.')

    const results = (payload.results ?? [])
      .filter((r) => r.url)
      .map((r) => {
        let domain: string | undefined
        try { domain = r.url ? new URL(r.url).hostname : undefined } catch { domain = undefined }
        return {
          title: r.title ?? r.url ?? '',
          url: r.url ?? '',
          ...(r.content ? { snippet: r.content } : {}),
          ...(domain ? { domain } : {}),
        }
      })
    return { results, ...(warnings.length ? { warnings } : {}) }
  },
}
