/**
 * Perplexity Sonar search provider.
 *
 *   API:  https://api.perplexity.ai/chat/completions  (OpenAI-compatible)
 *   Docs: https://docs.perplexity.ai/api-reference/chat-completions-post
 *
 * Sonar is an LLM-with-search, not a traditional SERP. Every call returns
 * a synthesized answer regardless of what the host requests — `answer:
 * false` from the LLM simply means we discard the prose and surface the
 * `search_results[]` as a SERP list.
 *
 * Capability mapping:
 *   - supportsAnswer:       true (it's literally what Sonar does)
 *   - supportsFreshness:    true (search_recency_filter: day/week/month;
 *                                 'year' is degraded to 'month' since
 *                                 Sonar caps at one month)
 *   - supportsDomainFilter: true (search_domain_filter with '-' prefix
 *                                 for exclusion, max 10 entries combined)
 *   - supportsLanguage:     false (not exposed by the API)
 *   - supportsLocation:     false (not exposed by the API)
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

const PERPLEXITY_ENDPOINT = 'https://api.perplexity.ai/chat/completions'

/** Default model. `sonar` is the cheapest/fastest; users who want
 *  longer-context reasoning can switch to sonar-pro via the SDK's
 *  `extra: { model: 'sonar-pro' }` passthrough. */
const DEFAULT_MODEL = 'sonar'

/** Sonar caps recency at one month, so we degrade 'year' to 'month'
 *  rather than dropping the hint entirely — closest match the API
 *  accepts. Anything coarser is omitted. */
function mapRecency(freshness?: SearchRequest['freshness']): string | undefined {
  switch (freshness) {
    case 'day':   return 'day'
    case 'week':  return 'week'
    case 'month': return 'month'
    case 'year':  return 'month'  // degraded — Sonar's coarsest filter
    default:      return undefined
  }
}

/** Combine include + exclude into Sonar's single `search_domain_filter`
 *  array (excludes prefixed with `-`). Cap at the documented 10 entries. */
function buildDomainFilter(domains?: SearchRequest['domains']): string[] | undefined {
  if (!domains?.include?.length && !domains?.exclude?.length) return undefined
  const out: string[] = []
  for (const d of domains.include ?? []) out.push(d)
  for (const d of domains.exclude ?? []) out.push(`-${d}`)
  return out.slice(0, 10)
}

interface PerplexitySearchResult {
  title?: string
  url?: string
  date?: string
  last_updated?: string
}

interface PerplexityChoice {
  message?: { content?: string }
}

interface PerplexityResponse {
  choices?: PerplexityChoice[]
  search_results?: PerplexitySearchResult[]
  citations?: string[]  // legacy fallback when search_results isn't populated
}

function getApiKey(config: ProviderConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    throw new AuthError('Missing Perplexity API key (config.apiKey).')
  }
  return key
}

function pickDomain(r: PerplexitySearchResult): string | undefined {
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

async function callPerplexity(
  body: Record<string, unknown>,
  apiKey: string,
  signal?: AbortSignal,
): Promise<PerplexityResponse> {
  let response: Response
  try {
    response = await fetch(PERPLEXITY_ENDPOINT, {
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
      `Perplexity request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`Perplexity authentication failed (HTTP ${response.status}).`)
  }
  if (response.status === 429) {
    throw new RateLimitError('Perplexity rate limit exceeded.')
  }
  if (response.status >= 500) {
    throw new ProviderServerError(
      `Perplexity server error (HTTP ${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new InvalidRequestError(
      `Perplexity rejected the request (HTTP ${response.status}): ${text.slice(0, 200)}`,
    )
  }

  return response.json() as Promise<PerplexityResponse>
}

export const perplexitySearchProvider: SearchProvider = {
  type: 'perplexity-sonar',
  displayName: 'Perplexity Sonar',
  lobehubIcon: 'Perplexity',
  apiKeyUrl: 'https://www.perplexity.ai/settings/api',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API key',
      required: true,
      description: 'Perplexity API key from Settings → API.',
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

    // No dedicated /me endpoint — issue the smallest possible chat call.
    // Single-token max keeps the credit cost minimal while still proving
    // the key works end-to-end.
    try {
      await callPerplexity(
        {
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
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
      model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: request.query }],
    }

    if (request.count !== undefined) {
      // Sonar doesn't have a result-count cap, but limiting context helps
      // both latency and token cost.
      body.web_search_options = { search_context_size: request.count <= 5 ? 'low' : 'medium' }
    }
    const recency = mapRecency(request.freshness)
    if (recency) body.search_recency_filter = recency

    const domainFilter = buildDomainFilter(request.domains)
    if (domainFilter) body.search_domain_filter = domainFilter

    const data = await callPerplexity(body, apiKey, request.signal)

    // Sonar's `search_results[]` is the new canonical field; legacy
    // `citations[]` (URLs only) is the fallback for older API responses.
    const sources: PerplexitySearchResult[] = data.search_results?.length
      ? data.search_results
      : (data.citations ?? []).map((url): PerplexitySearchResult => ({ url }))

    const results = sources.map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url ?? '',
      ...(parsePublishedAt(r.date ?? r.last_updated) !== undefined
        ? { publishedAt: parsePublishedAt(r.date ?? r.last_updated)! }
        : {}),
      ...(pickDomain(r) ? { domain: pickDomain(r)! } : {}),
    }))

    const out: SearchResult = { results }
    const answerText = data.choices?.[0]?.message?.content?.trim()
    if (request.answer && answerText) {
      out.answer = {
        text: answerText,
        citations: results.map((r) => ({ url: r.url, ...(r.title ? { title: r.title } : {}) })),
      }
    }

    // Surface the recency degradation as a warning so the LLM knows the
    // filter was coarser than what it asked for.
    if (request.freshness === 'year') {
      out.warnings = [
        ...(out.warnings ?? []),
        'Perplexity Sonar caps recency at one month; freshness=year was applied as month.',
      ]
    }

    return out
  },
}
