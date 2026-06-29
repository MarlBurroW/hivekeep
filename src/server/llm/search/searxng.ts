/**
 * SearXNG search provider — a BYO-endpoint connector for self-hosted
 * SearXNG metasearch instances.
 *
 *   API:  GET <baseUrl>/search?q=…&format=json
 *   Docs: https://docs.searxng.org/dev/search_api.html
 *
 * Unlike the branded SERP providers (Brave, SerpAPI, …) which hardcode a
 * vendor endpoint, SearXNG takes its base URL from the user's config — the
 * typical homelab case is a private instance with no commercial search API
 * behind it. This is why pointing the Tavily provider at a SearXNG URL fails
 * with HTTP 401: Tavily sends its own auth + JSON body, which SearXNG doesn't
 * understand. SearXNG is NOT API-compatible with Tavily, so it gets its own
 * provider type (see issue #21).
 *
 * Design choices:
 *  - JSON output. SearXNG only returns machine-readable results when the
 *    `json` format is enabled in `search.formats` (settings.yml). When it
 *    isn't, the instance answers with HTTP 403 (disabled format) or a 200
 *    HTML page — both are surfaced as a clear, actionable error telling the
 *    admin to enable JSON.
 *  - Optional auth. Public instances need no credentials; protected ones
 *    (behind a reverse proxy / basic-auth) take an API key carried in a
 *    configurable header (`Authorization: Bearer …` by default).
 *  - Capabilities. SearXNG forwards the query to many upstream engines, so
 *    freshness (`time_range`) and language map cleanly, and domain filtering
 *    rides on inline `site:` operators (same trick as the Brave/SerpAPI
 *    providers). It does NOT synthesize an answer, so `supportsAnswer` is
 *    false. The result's source `engine` has no slot in the normalized
 *    `SearchResultEntry`, so it's intentionally dropped (the `domain` field
 *    serves the same disambiguation purpose).
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
  SearchResultEntry,
} from '@/server/llm/search/types'

/** A single entry from SearXNG's `results[]`. Only the fields we read. */
interface SearxngResult {
  title?: string
  url?: string
  content?: string
  engine?: string
  publishedDate?: string | null
}

/** Subset of SearXNG's `/search?format=json` response we consume. */
interface SearxngResponse {
  results?: SearxngResult[]
  unresponsive_engines?: unknown[]
}

/** Normalize the base URL: trim, drop trailing slashes. Throws when absent. */
function getBaseUrl(config: ProviderConfig): string {
  const raw = (config.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!raw) {
    throw new InvalidRequestError('Missing SearXNG base URL (config.baseUrl).')
  }
  return raw
}

/**
 * Build auth headers for a protected instance. No key → no headers (public
 * instance). The header name is configurable (`config.authHeader`, default
 * `Authorization`):
 *  - `Authorization`: prefix the key with `Bearer ` unless it already carries
 *    a scheme (so `Basic <base64>` or `Bearer <jwt>` pass through verbatim).
 *  - any other header (e.g. `X-API-Key`): the key is sent as-is.
 *
 * @internal exported for tests.
 */
export function buildAuthHeaders(config: ProviderConfig): Record<string, string> {
  const key = (config.apiKey ?? '').trim()
  if (!key) return {}
  const headerName = (config.authHeader ?? '').trim() || 'Authorization'
  if (headerName.toLowerCase() === 'authorization') {
    const hasScheme = /^(bearer|basic|digest|token)\s+/i.test(key)
    return { Authorization: hasScheme ? key : `Bearer ${key}` }
  }
  return { [headerName]: key }
}

/**
 * Map our normalized freshness enum to SearXNG's `time_range`. SearXNG
 * accepts day/week/month/year 1-to-1; 'all' (or missing) omits the filter.
 *
 * @internal exported for tests.
 */
export function mapFreshness(freshness?: SearchRequest['freshness']): string | undefined {
  switch (freshness) {
    case 'day':   return 'day'
    case 'week':  return 'week'
    case 'month': return 'month'
    case 'year':  return 'year'
    default:      return undefined  // 'all' or missing → omit
  }
}

/**
 * Compose the query string. SearXNG forwards `site:` / `-site:` operators to
 * upstream engines (Google, Bing, …), so domain filters become inline
 * operators — the same approach as the Brave and SerpAPI providers.
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

/**
 * Build the `/search` query params. `request.lang` wins over the config
 * default; categories / safesearch come from config only (no normalized
 * request field for them). `format=json` is always set.
 *
 * @internal exported for tests.
 */
export function buildSearchParams(request: SearchRequest, config: ProviderConfig): URLSearchParams {
  const params = new URLSearchParams()
  params.set('q', composeQuery(request.query, request.domains))
  params.set('format', 'json')

  const lang = (request.lang ?? '').trim() || (config.language ?? '').trim()
  if (lang) params.set('language', lang)

  const timeRange = mapFreshness(request.freshness)
  if (timeRange) params.set('time_range', timeRange)

  const categories = (config.categories ?? '').trim()
  if (categories) params.set('categories', categories)

  const safesearch = (config.safesearch ?? '').trim()
  if (safesearch) params.set('safesearch', safesearch)

  return params
}

function pickDomain(r: SearxngResult): string | undefined {
  if (!r.url) return undefined
  try {
    return new URL(r.url).hostname
  } catch {
    return undefined
  }
}

function parsePublishedAt(s: string | null | undefined): number | undefined {
  if (!s) return undefined
  const ms = Date.parse(s)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Map SearXNG results to normalized entries, clamped to `count`. The source
 * `engine` is dropped — there's no slot for it in `SearchResultEntry`.
 *
 * @internal exported for tests.
 */
export function mapResults(data: SearxngResponse, count?: number): SearchResultEntry[] {
  const entries = (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    ...(r.content ? { snippet: r.content } : {}),
    ...(parsePublishedAt(r.publishedDate) !== undefined
      ? { publishedAt: parsePublishedAt(r.publishedDate)! }
      : {}),
    ...(pickDomain(r) ? { domain: pickDomain(r)! } : {}),
  }))
  // SearXNG returns a merged, ranked list (no native result-count param), so
  // we clamp host-side when the caller asked for a specific count.
  return count !== undefined ? entries.slice(0, Math.max(1, count)) : entries
}

/**
 * Issue a GET to the instance and parse JSON defensively. A SearXNG with the
 * `json` format disabled answers with a 403 (rejected format) or a 200 HTML
 * page — both become a clear, actionable error pointing the admin at
 * `search.formats` in settings.yml.
 */
async function callSearxng(
  endpoint: string,
  params: URLSearchParams,
  config: ProviderConfig,
  signal?: AbortSignal,
): Promise<SearxngResponse> {
  let response: Response
  try {
    response = await fetch(`${endpoint}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...buildAuthHeaders(config),
      },
      signal,
    })
  } catch (err) {
    throw new NetworkError(
      `SearXNG request failed (is the base URL reachable?): ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (response.status === 401) {
    throw new AuthError(
      'SearXNG requires authentication (HTTP 401). Set an API key and, if needed, a custom auth header.',
    )
  }
  if (response.status === 403) {
    // Ambiguous: SearXNG returns 403 both for a disabled JSON format and for
    // a protected instance. Cover both causes in one actionable message.
    throw new InvalidRequestError(
      'SearXNG returned HTTP 403. Likely causes: (1) JSON output is not enabled — add `json` to `search.formats` in settings.yml; (2) the instance is protected — set an API key / custom auth header.',
    )
  }
  if (response.status === 429) {
    throw new RateLimitError('SearXNG rate limit exceeded.')
  }
  if (response.status >= 500) {
    throw new ProviderServerError(
      `SearXNG server error (HTTP ${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new InvalidRequestError(
      `SearXNG rejected the request (HTTP ${response.status}): ${body.slice(0, 200)}`,
    )
  }

  // A misconfigured instance can answer 200 with the HTML search page when the
  // JSON format isn't enabled. Parse defensively and explain how to fix it.
  const text = await response.text()
  try {
    return JSON.parse(text) as SearxngResponse
  } catch {
    throw new InvalidRequestError(
      'SearXNG did not return JSON. Enable the `json` format under `search.formats` in your instance settings.yml (https://docs.searxng.org/admin/settings/settings_search.html).',
    )
  }
}

export const searxngSearchProvider: SearchProvider = {
  type: 'searxng',
  displayName: 'SearXNG',
  reactIcon: 'si/SiSearxng',
  brandColor: '#3050FF',
  noApiKey: true,  // public instances need none; a key is optional
  configSchema: [
    {
      key: 'baseUrl',
      type: 'url',
      label: 'Base URL',
      required: true,
      placeholder: 'https://search.example.com',
      description:
        'Root URL of your SearXNG instance (no trailing `/search`). The instance must have the `json` format enabled under `search.formats` in settings.yml.',
    },
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API key',
      required: false,
      placeholder: 'Leave empty for a public instance',
      description:
        'Optional. Credential for a protected instance (behind a reverse proxy or basic-auth). Sent in the header below.',
    },
    {
      key: 'authHeader',
      type: 'text',
      label: 'Auth header',
      required: false,
      default: 'Authorization',
      placeholder: 'Authorization',
      description:
        'Header carrying the API key. With `Authorization`, the key is prefixed with `Bearer ` (unless it already starts with `Bearer`/`Basic`). For a raw token, use a custom name like `X-API-Key`.',
    },
    {
      key: 'language',
      type: 'text',
      label: 'Default language',
      required: false,
      placeholder: 'all',
      description:
        'Default search language code (e.g. `en`, `fr`, `de`, or `all`). An explicit per-search language overrides this.',
    },
    {
      key: 'categories',
      type: 'text',
      label: 'Categories',
      required: false,
      placeholder: 'general',
      description:
        'Comma-separated SearXNG categories to query (e.g. `general`, `general,news`). Leave empty for the instance default.',
    },
    {
      key: 'safesearch',
      type: 'text',
      label: 'Safe search',
      required: false,
      placeholder: '0, 1, or 2',
      description: 'Safe-search level: `0` (off), `1` (moderate), `2` (strict). Leave empty for the instance default.',
    },
  ],
  capabilities: {
    supportsAnswer: false,
    supportsFreshness: true,
    supportsDomainFilter: true,  // via inline site: operators
    supportsLanguage: true,
    supportsLocation: false,
  },

  async authenticate(config): Promise<AuthResult> {
    let endpoint: string
    try {
      endpoint = `${getBaseUrl(config)}/search`
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }

    // Cheapest probe: a minimal JSON search. This also validates that the
    // instance has the JSON format enabled (the #1 SearXNG misconfiguration).
    const params = new URLSearchParams({ q: 'ping', format: 'json' })
    try {
      await callSearxng(endpoint, params, config)
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async search(request, config): Promise<SearchResult> {
    const endpoint = `${getBaseUrl(config)}/search`
    const params = buildSearchParams(request, config)

    const data = await callSearxng(endpoint, params, config, request.signal)

    const out: SearchResult = { results: mapResults(data, request.count) }

    // Surface partial-coverage as a soft warning so the Agent (and the user)
    // know some engines didn't answer — a common homelab symptom of a
    // rate-limited or misconfigured upstream.
    if (Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0) {
      out.warnings = [
        `${data.unresponsive_engines.length} SearXNG engine(s) did not respond; results may be incomplete.`,
      ]
    }

    return out
  },
}
