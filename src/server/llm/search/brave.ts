/**
 * Brave Search provider.
 *
 *   API:  https://api.search.brave.com/res/v1/web/search
 *   Docs: https://api-dashboard.search.brave.com/app/documentation/web-search/
 *
 * SERP-only — Brave doesn't synthesize an answer (no `supportsAnswer`).
 * Domain filtering is implemented host-side via `site:` / `-site:`
 * query operators since Brave doesn't expose dedicated include/exclude
 * params. Freshness, language, and location map cleanly to native
 * `freshness`, `search_lang`, and `country` params.
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

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveWebResult {
  title?: string
  url?: string
  description?: string
  page_age?: string
  meta_url?: { hostname?: string }
}

interface BraveResponse {
  web?: {
    results?: BraveWebResult[]
  }
}

function getApiKey(config: ProviderConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    throw new AuthError('Missing Brave Search API key (config.apiKey).')
  }
  return key
}

/** Map our normalized freshness enum to Brave's native codes. */
function mapFreshness(freshness?: SearchRequest['freshness']): string | undefined {
  switch (freshness) {
    case 'day':   return 'pd'
    case 'week':  return 'pw'
    case 'month': return 'pm'
    case 'year':  return 'py'
    default:      return undefined  // 'all' or missing → omit
  }
}

/**
 * Compose the final query string. Brave supports inline `site:` /
 * `-site:` operators, so we append them when domain filters are set.
 * The user-typed query is preserved verbatim in front of the operators.
 */
function composeQuery(query: string, domains?: SearchRequest['domains']): string {
  const parts: string[] = [query.trim()]
  if (domains?.include?.length) {
    if (domains.include.length === 1) {
      parts.push(`site:${domains.include[0]}`)
    } else {
      parts.push(`(${domains.include.map((d) => `site:${d}`).join(' OR ')})`)
    }
  }
  if (domains?.exclude?.length) {
    for (const d of domains.exclude) parts.push(`-site:${d}`)
  }
  return parts.join(' ')
}

function pickDomain(r: BraveWebResult): string | undefined {
  if (r.meta_url?.hostname) return r.meta_url.hostname
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

async function callBrave(
  url: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<BraveResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
      signal,
    })
  } catch (err) {
    throw new NetworkError(
      `Brave Search request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`Brave Search authentication failed (HTTP ${response.status}).`)
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after')
    const retryMs = retryAfter ? Number(retryAfter) * 1000 : undefined
    throw new RateLimitError(
      'Brave Search rate limit exceeded.',
      Number.isFinite(retryMs) ? retryMs : undefined,
    )
  }
  if (response.status >= 500) {
    throw new ProviderServerError(
      `Brave Search server error (HTTP ${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new InvalidRequestError(
      `Brave Search rejected the request (HTTP ${response.status}): ${body.slice(0, 200)}`,
    )
  }

  return response.json() as Promise<BraveResponse>
}

export const braveSearchProvider: SearchProvider = {
  type: 'brave-search',
  displayName: 'Brave Search',
  apiKeyUrl: 'https://brave.com/search/api/',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API key',
      required: true,
      description: 'Subscription token from your Brave Search API dashboard.',
    },
  ],
  capabilities: {
    supportsAnswer: false,
    supportsFreshness: true,
    supportsDomainFilter: true,  // via inline site: operators
    supportsLanguage: true,
    supportsLocation: true,
  },

  async authenticate(config): Promise<AuthResult> {
    let apiKey: string
    try {
      apiKey = getApiKey(config)
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }

    const params = new URLSearchParams({ q: 'ping', count: '1' })
    try {
      await callBrave(`${BRAVE_ENDPOINT}?${params.toString()}`, apiKey)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async search(request, config): Promise<SearchResult> {
    const apiKey = getApiKey(config)

    const params = new URLSearchParams()
    params.set('q', composeQuery(request.query, request.domains))
    params.set('text_decorations', 'false')  // no <strong> tags in snippets

    if (request.count !== undefined) {
      // Brave caps at 20 — clamp client-side to fail loudly on misuse.
      params.set('count', String(Math.max(1, Math.min(20, request.count))))
    }
    const freshness = mapFreshness(request.freshness)
    if (freshness) params.set('freshness', freshness)
    if (request.lang) params.set('search_lang', request.lang)
    if (request.location) params.set('country', request.location)

    const body = await callBrave(
      `${BRAVE_ENDPOINT}?${params.toString()}`,
      apiKey,
      request.signal,
    )

    const results = (body.web?.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      ...(r.description ? { snippet: r.description } : {}),
      ...(parsePublishedAt(r.page_age) !== undefined
        ? { publishedAt: parsePublishedAt(r.page_age)! }
        : {}),
      ...(pickDomain(r) ? { domain: pickDomain(r)! } : {}),
    }))

    return { results }
  },
}
