/**
 * Billing-related token math.
 *
 * Different providers price prompt caching differently. We model this as a
 * pair of multipliers (vs the fresh input rate) per provider:
 *
 *   - Anthropic   : read 0.10× / write 1.25× (5-min ephemeral cache)
 *   - OpenAI      : read 0.50× / write 1.00× (implicit cache, ≥1024 tokens)
 *   - Google      : read 0.25× / write 1.00× (implicit Gemini caching)
 *   - xAI (Grok)  : read 0.25× / write 1.00×
 *
 * `inputTokens` reported by the Vercel AI SDK is the GROSS input total
 * (fresh + cache_read + cache_write). The cache portions are in
 * `inputTokenDetails`. Fresh input is derived:
 *
 *   freshInput = inputTokens - cacheRead - cacheWrite
 *
 * `computeBillableInput` returns the input-equivalent token count after
 * applying the right multipliers for the provider — a single comparable
 * number that approximates what the input portion of the call costs.
 *
 * Output tokens are kept separate because they have a completely different
 * rate and folding them in would require a model-specific input/output
 * ratio. Input is normalized; output is shown as-is.
 */

export interface CacheMultipliers {
  /** Multiplier vs fresh input rate for tokens read from cache. */
  read: number
  /** Multiplier vs fresh input rate for tokens written to cache. */
  write: number
}

/** Per-provider cache pricing multipliers. Keys match `llm_usage.provider_type`. */
export const PROVIDER_CACHE_MULTIPLIERS: Record<string, CacheMultipliers> = {
  // Anthropic 5-min ephemeral cache.
  // (1-h extended cache uses write 2.0× but we don't differentiate yet — Vercel
  //  AI SDK reports a single `cacheCreationInputTokens` without TTL distinction.)
  anthropic:       { read: 0.1, write: 1.25 },
  // OpenAI: implicit cache, automatic for prompts ≥1024 tokens.
  openai:          { read: 0.5, write: 1.0 },
  // Google Gemini: implicit caching (no explicit write surcharge).
  google:          { read: 0.25, write: 1.0 },
  'google-vertex': { read: 0.25, write: 1.0 },
  // xAI Grok: cached input billed at ~0.25× of fresh.
  xai:             { read: 0.25, write: 1.0 },
}

/** Fallback when the provider type is unknown — use Anthropic numbers (most
 *  common provider in practice for this codebase, and the conservative cache
 *  read estimate that won't UNDER-count what the user is paying). */
export const DEFAULT_CACHE_MULTIPLIERS: CacheMultipliers = PROVIDER_CACHE_MULTIPLIERS.anthropic!

export function getCacheMultipliers(providerType?: string | null): CacheMultipliers {
  if (!providerType) return DEFAULT_CACHE_MULTIPLIERS
  return PROVIDER_CACHE_MULTIPLIERS[providerType] ?? DEFAULT_CACHE_MULTIPLIERS
}

export interface UsageWithCache {
  inputTokens: number
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

/**
 * Compute the billable-input-equivalent token count.
 * If `providerType` is omitted, Anthropic multipliers are used.
 *
 * Formula: freshInput * 1.0 + cacheWrite * write_mult + cacheRead * read_mult
 */
export function computeBillableInput(
  u: UsageWithCache,
  providerType?: string | null,
): number {
  const m = getCacheMultipliers(providerType)
  const cacheRead = u.cacheReadTokens ?? 0
  const cacheWrite = u.cacheWriteTokens ?? 0
  const freshInput = Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite)
  return Math.round(freshInput + cacheWrite * m.write + cacheRead * m.read)
}

/**
 * Cache hit rate in [0, 1]: portion of input tokens that came from cache reads.
 * Provider-agnostic (it's just a ratio).
 */
export function computeCacheHitRate(u: UsageWithCache): number {
  if (!u.inputTokens) return 0
  return Math.min(1, (u.cacheReadTokens ?? 0) / u.inputTokens)
}

/** Fresh (non-cached) input tokens. Negative results are clamped to 0. */
export function computeFreshInput(u: UsageWithCache): number {
  return Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0) - (u.cacheWriteTokens ?? 0))
}
