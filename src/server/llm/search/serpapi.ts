/**
 * SerpAPI provider (Google search via SerpAPI gateway).
 *
 *   API:  https://serpapi.com/search.json
 *   Docs: https://serpapi.com/search-api
 *
 * SERP-only — we read `organic_results[]` and ignore the answer-box /
 * knowledge-graph blocks that SerpAPI also returns. A future revision
 * could surface those as an `answer` block, but doing so cleanly would
 * require disambiguating between SerpAPI's structured panels and a
 * true LLM-synthesized answer (different shapes, different reliability),
 * so we keep `supportsAnswer: false` for now.
 *
 * Domain filtering is implemented host-side via `site:` / `-site:`
 * query operators (Google query syntax, same trick as the Brave provider).
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

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json'

interface SerpOrganicResult {
  title?: string
  link?: string
  snippet?: string
  displayed_link?: string
  date?: string
}

interface SerpResponse {
  organic_results?: SerpOrganicResult[]
  error?: string
}

function getApiKey(config: ProviderConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    throw new AuthError('Missing SerpAPI key (config.apiKey).')
  }
  return key
}

/** Map our normalized freshness enum to SerpAPI's `tbs` qdr codes. */
function mapFreshness(freshness?: SearchRequest['freshness']): string | undefined {
  switch (freshness) {
    case 'day':   return 'qdr:d'
    case 'week':  return 'qdr:w'
    case 'month': return 'qdr:m'
    case 'year':  return 'qdr:y'
    default:      return undefined
  }
}

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

function pickDomain(r: SerpOrganicResult): string | undefined {
  if (r.displayed_link) {
    // SerpAPI's displayed_link is shaped like "www.example.com › path"
    // — split on the breadcrumb separator and take the host.
    const host = r.displayed_link.split('›')[0]?.trim()
    if (host) return host
  }
  if (!r.link) return undefined
  try {
    return new URL(r.link).hostname
  } catch {
    return undefined
  }
}

function parsePublishedAt(s: string | undefined): number | undefined {
  if (!s) return undefined
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : undefined
}

async function callSerp(
  url: string,
  signal?: AbortSignal,
): Promise<SerpResponse> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal,
    })
  } catch (err) {
    throw new NetworkError(
      `SerpAPI request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`SerpAPI authentication failed (HTTP ${response.status}).`)
  }
  if (response.status === 429) {
    throw new RateLimitError('SerpAPI rate limit exceeded.')
  }
  if (response.status >= 500) {
    throw new ProviderServerError(
      `SerpAPI server error (HTTP ${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new InvalidRequestError(
      `SerpAPI rejected the request (HTTP ${response.status}): ${body.slice(0, 200)}`,
    )
  }

  const body = (await response.json()) as SerpResponse
  // SerpAPI returns 200 with `error` in the body for plan / key issues.
  if (body.error) {
    if (/key|auth|unauthor/i.test(body.error)) {
      throw new AuthError(`SerpAPI: ${body.error}`)
    }
    throw new InvalidRequestError(`SerpAPI: ${body.error}`)
  }
  return body
}

export const serpapiSearchProvider: SearchProvider = {
  type: 'serpapi',
  displayName: 'SerpAPI',
  apiKeyUrl: 'https://serpapi.com/manage-api-key',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API key',
      required: true,
      description: 'Your SerpAPI key (see Manage API Key in your dashboard).',
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

    // SerpAPI's account endpoint reports plan + balance for the key
    // without spending a search credit. Cheaper than burning a real search
    // just to validate.
    const params = new URLSearchParams({ api_key: apiKey })
    try {
      const response = await fetch(`https://serpapi.com/account?${params.toString()}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
      })
      if (response.ok) return { valid: true }
      const body = await response.text().catch(() => '')
      return { valid: false, error: `SerpAPI account check failed (HTTP ${response.status}): ${body.slice(0, 200)}` }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async search(request, config): Promise<SearchResult> {
    const apiKey = getApiKey(config)

    const params = new URLSearchParams()
    params.set('api_key', apiKey)
    params.set('engine', 'google')
    params.set('q', composeQuery(request.query, request.domains))

    if (request.count !== undefined) {
      params.set('num', String(Math.max(1, Math.min(100, request.count))))
    }
    const tbs = mapFreshness(request.freshness)
    if (tbs) params.set('tbs', tbs)
    if (request.lang) params.set('hl', request.lang)
    if (request.location) {
      // Google's `gl` param takes a 2-letter country code, lowercased
      // ('us', 'fr'). Our normalized SearchRequest.location is whatever
      // the user passes; uppercase forms still work but lowercasing is
      // the documented shape.
      params.set('gl', request.location.toLowerCase())
    }

    const body = await callSerp(
      `${SERPAPI_ENDPOINT}?${params.toString()}`,
      request.signal,
    )

    const results = (body.organic_results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(parsePublishedAt(r.date) !== undefined
        ? { publishedAt: parsePublishedAt(r.date)! }
        : {}),
      ...(pickDomain(r) ? { domain: pickDomain(r)! } : {}),
    }))

    return { results }
  },
}
