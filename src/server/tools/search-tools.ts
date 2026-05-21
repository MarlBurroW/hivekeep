/**
 * Native search tools exposed to Kins.
 *
 *  - `list_search_providers` — discovery: configured search providers
 *    plus their static capabilities and the current default.
 *  - `web_search` — action: run a search through a slug-resolved provider
 *    (explicit slug → global default → first valid fallback).
 *
 * Search providers have no model selection (one provider == one search
 * endpoint), so the tool surface is intentionally thinner than the
 * image tools — no `describe_search_provider`, the capabilities returned
 * by `list_search_providers` are enough for the LLM to reason about.
 *
 * Provider-specific quirks (Perplexity `search_recency_filter`, Tavily
 * `include_raw_content`, …) are NOT exposed in this tool's input schema
 * on purpose — the SDK's `SearchRequest.extra` passthrough exists for
 * host-controlled bridging only. Exposing it raw to the LLM would
 * invite hallucinated keys; if a specific knob becomes load-bearing
 * we'll add it as a first-class input field with a capability flag.
 */

import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import { db } from '@/server/db/index'
import { providers as providersTable } from '@/server/db/schema'
import { getSearchProvider } from '@/server/llm/search/registry'
import { getDefaultSearchProviderId } from '@/server/services/app-settings'
import {
  resolveSearchProvider,
  SearchResolveError,
} from '@/server/services/search-resolver'
import type { SearchRequest } from '@/server/llm/search/types'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:search')

// ─── list_search_providers ───────────────────────────────────────────────────

export const listSearchProvidersTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'List configured search providers with their capabilities (supportsAnswer, ' +
        'supportsFreshness, supportsDomainFilter, supportsLanguage, supportsLocation). ' +
        'The entry with `isDefault: true` is what `web_search` uses when no ' +
        '`provider_slug` is passed. Call this before `web_search` when you need a ' +
        'specific capability (e.g. pick one with `supportsAnswer: true` to request ' +
        'a synthesized answer).',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = db.select().from(providersTable).all()
        const defaultId = await getDefaultSearchProviderId()

        const items = rows
          .filter((p) => p.isValid)
          .filter((p) => {
            try {
              const caps = JSON.parse(p.capabilities) as string[]
              return caps.includes('search')
            } catch {
              return false
            }
          })
          .map((p) => {
            // Capabilities come from the live provider instance (not the
            // DB row) — they're declared statically on the provider, not
            // configured per-credential. When the plugin is unloaded the
            // provider isn't in the registry; we still list the row but
            // with an empty capability set + an `unavailable` flag so the
            // LLM knows it can't be used.
            const provider = getSearchProvider(p.type)
            return {
              slug: p.slug,
              displayName: provider?.displayName ?? p.name,
              isDefault: p.id === defaultId,
              capabilities: provider?.capabilities ?? {},
              ...(provider ? {} : { unavailable: true as const }),
            }
          })

        return { providers: items }
      },
    }),
}

// ─── web_search ──────────────────────────────────────────────────────────────

export const webSearchTool: ToolRegistration = {
  availability: ['main', 'sub-kin'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Search the web for current information. Returns a list of results with ' +
        'title, url, and snippet. Use `browse_url` afterwards to read the full ' +
        'content of any result.\n\n' +
        'Provider selection: pass `provider_slug` to use a specific provider, ' +
        'otherwise the configured default is used. Call `list_search_providers` ' +
        'first to discover what is configured and which capabilities each one ' +
        'supports.\n\n' +
        'Set `answer: true` to request a synthesized answer with citations — ' +
        'only honored when the resolved provider declares `supportsAnswer: true`. ' +
        'When unsupported, results are still returned and a warning is added.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query. Plain natural language.'),
        provider_slug: z
          .string()
          .optional()
          .describe(
            'Slug of a specific search provider to use. Omit to use the global ' +
              'default. Discover available slugs via list_search_providers.',
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Maximum number of results. Default: provider-specific.'),
        freshness: z
          .enum(['day', 'week', 'month', 'year', 'all'])
          .optional()
          .describe(
            'Restrict results by recency. Honored only when the provider declares ' +
              '`supportsFreshness: true`; ignored otherwise.',
          ),
        include_domains: z
          .array(z.string())
          .optional()
          .describe(
            'Restrict results to these domains. Honored only when the provider ' +
              'declares `supportsDomainFilter: true`.',
          ),
        exclude_domains: z
          .array(z.string())
          .optional()
          .describe(
            'Exclude results from these domains. Honored only when the provider ' +
              'declares `supportsDomainFilter: true`.',
          ),
        lang: z
          .string()
          .optional()
          .describe(
            'ISO 639-1 language hint (e.g. "en", "fr"). Honored only when the ' +
              'provider declares `supportsLanguage: true`.',
          ),
        location: z
          .string()
          .optional()
          .describe(
            'Region hint (often an ISO country code like "US" or "FR"; some ' +
              'providers accept city/region strings). Honored only when the ' +
              'provider declares `supportsLocation: true`.',
          ),
        answer: z
          .boolean()
          .optional()
          .describe(
            'Request a synthesized answer with citations. Returns results plus ' +
              'an `answer` block when the provider supports it; otherwise returns ' +
              'results only with a warning.',
          ),
      }),
      execute: async (args) => {
        const {
          query,
          provider_slug,
          count,
          freshness,
          include_domains,
          exclude_domains,
          lang,
          location,
          answer,
        } = args

        let resolved
        try {
          resolved = await resolveSearchProvider(provider_slug)
        } catch (err) {
          if (err instanceof SearchResolveError) {
            return { error: err.message, code: err.code }
          }
          throw err
        }

        const { row, config, provider } = resolved
        const warnings: string[] = []

        // Preemptive capability-mismatch warnings. The host owns the
        // declared-capability contract — providers can still attempt the
        // operation, but the LLM gets one consistent signal regardless
        // of the provider's internal behavior.
        const caps = provider.capabilities
        if (answer && !caps.supportsAnswer) {
          warnings.push(
            `Provider "${row.slug}" does not support synthesized answers — ` +
              `returning results only. Call list_search_providers to find one ` +
              `with supportsAnswer: true.`,
          )
        }
        if (freshness && freshness !== 'all' && !caps.supportsFreshness) {
          warnings.push(
            `Provider "${row.slug}" does not support freshness filtering — ` +
              `the freshness hint will be ignored.`,
          )
        }
        if ((include_domains?.length || exclude_domains?.length) && !caps.supportsDomainFilter) {
          warnings.push(
            `Provider "${row.slug}" does not support domain filtering — ` +
              `include/exclude_domains will be ignored.`,
          )
        }
        if (lang && !caps.supportsLanguage) {
          warnings.push(
            `Provider "${row.slug}" does not honor language hints — ` +
              `the lang argument will be ignored.`,
          )
        }
        if (location && !caps.supportsLocation) {
          warnings.push(
            `Provider "${row.slug}" does not honor location hints — ` +
              `the location argument will be ignored.`,
          )
        }

        const request: SearchRequest = {
          query,
          ...(count !== undefined ? { count } : {}),
          ...(freshness !== undefined ? { freshness } : {}),
          ...(include_domains?.length || exclude_domains?.length
            ? {
                domains: {
                  ...(include_domains?.length ? { include: include_domains } : {}),
                  ...(exclude_domains?.length ? { exclude: exclude_domains } : {}),
                },
              }
            : {}),
          ...(lang !== undefined ? { lang } : {}),
          ...(location !== undefined ? { location } : {}),
          ...(answer !== undefined ? { answer } : {}),
        }

        log.debug(
          { providerSlug: row.slug, query, answer: !!answer },
          'web_search invoked',
        )

        let result
        try {
          result = await provider.search(request, config)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn({ providerSlug: row.slug, error: message }, 'web_search failed')
          return { error: message, provider: row.slug }
        }

        // Merge host warnings with provider-emitted warnings. De-dupe by
        // exact string match — providers commonly re-emit our preemptive
        // warning in their own response.
        const allWarnings = [...new Set([...warnings, ...(result.warnings ?? [])])]

        return {
          provider: row.slug,
          results: result.results,
          ...(result.answer ? { answer: result.answer } : {}),
          ...(allWarnings.length ? { warnings: allWarnings } : {}),
        }
      },
    }),
}

