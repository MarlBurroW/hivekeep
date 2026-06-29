/**
 * Tavily search provider.
 *
 *   API:  https://api.tavily.com/search
 *   Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
 *
 * Tavily is purpose-built for LLM grounding — it ships native answer
 * synthesis (`include_answer`), native include/exclude_domains filters,
 * and a coarse `time_range` recency filter. It does NOT expose
 * language or region knobs, so those capabilities stay false here
 * (the host emits a warning when the LLM passes them).
 */

import {
  AuthError,
  RateLimitError,
  NetworkError,
  ProviderServerError,
  InvalidRequestError,
} from '@gezy/sdk'
import type { AuthResult, ProviderConfig } from '@gezy/sdk'
import type {
  SearchProvider,
  SearchRequest,
  SearchResult,
} from '@/server/llm/search/types'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

interface TavilyResultEntry {
  title?: string
  url?: string
  content?: string
  published_date?: string
  score?: number
}

interface TavilyResponse {
  results?: TavilyResultEntry[]
  answer?: string | null
}

function getApiKey(config: ProviderConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    throw new AuthError('Missing Tavily API key (config.apiKey).')
  }
  return key
}

function pickDomain(r: TavilyResultEntry): string | undefined {
  if (!r.url) return undefined
  try {
    return new URL(r.url).hostname
  } catch {
    return undefined
  }
}

function parsePublishedAt(s: string | undefined): number | undefined {
  if (!s) return undefined
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : undefined
}

async function callTavily(
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TavilyResponse> {
  let response: Response
  try {
    response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw new NetworkError(
      `Tavily request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`Tavily authentication failed (HTTP ${response.status}).`)
  }
  if (response.status === 429) {
    throw new RateLimitError('Tavily rate limit exceeded.')
  }
  if (response.status >= 500) {
    throw new ProviderServerError(
      `Tavily server error (HTTP ${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new InvalidRequestError(
      `Tavily rejected the request (HTTP ${response.status}): ${text.slice(0, 200)}`,
    )
  }

  return response.json() as Promise<TavilyResponse>
}

export const tavilySearchProvider: SearchProvider = {
  type: 'tavily',
  displayName: 'Tavily',
  lobehubIcon: 'Tavily',  // Lobehub ships a Tavily icon
  apiKeyUrl: 'https://app.tavily.com/home',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API key',
      required: true,
      description: 'Tavily API key from your account dashboard.',
    },
  ],
  capabilities: {
    supportsAnswer: true,
    supportsFreshness: true,
    supportsDomainFilter: true,
    supportsLanguage: false,
    supportsLocation: false,
  },

  async authenticate(config): Promise<AuthResult> {
    let apiKey: string
    try {
      apiKey = getApiKey(config)
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }

    // No cheap dedicated auth endpoint — issue a minimal `ping` search
    // with max_results=1 and no extras. Costs the smallest possible
    // amount of plan credit (Tavily's basic depth is 1 credit).
    try {
      await callTavily(
        { query: 'ping', max_results: 1, search_depth: 'basic' },
        apiKey,
      )
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async search(request, config): Promise<SearchResult> {
    const apiKey = getApiKey(config)

    const body: Record<string, unknown> = {
      query: request.query,
      search_depth: 'basic',
    }

    if (request.count !== undefined) {
      // Tavily caps at 20; clamp client-side.
      body.max_results = Math.max(1, Math.min(20, request.count))
    }
    if (request.freshness && request.freshness !== 'all') {
      body.time_range = request.freshness  // 'day' | 'week' | 'month' | 'year' map 1-to-1
    }
    if (request.domains?.include?.length) body.include_domains = request.domains.include
    if (request.domains?.exclude?.length) body.exclude_domains = request.domains.exclude
    if (request.answer) body.include_answer = true

    const data = await callTavily(body, apiKey, request.signal)

    const results = (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      ...(r.content ? { snippet: r.content } : {}),
      ...(parsePublishedAt(r.published_date) !== undefined
        ? { publishedAt: parsePublishedAt(r.published_date)! }
        : {}),
      ...(pickDomain(r) ? { domain: pickDomain(r)! } : {}),
    }))

    const out: SearchResult = { results }
    if (request.answer && data.answer) {
      // Tavily's answer endpoint inlines citations as URL references inside
      // the prose. We surface the prose as `answer.text` and let the LLM
      // cross-reference the `results` list for citation URLs.
      out.answer = {
        text: data.answer,
        citations: results.map((r) => ({ url: r.url, title: r.title })),
      }
    }

    return out
  },
}
