/**
 * Pure cost math for LLM usage — kept dependency-free (no DB) so it's trivially
 * testable. Pricing is USD per MILLION tokens (the models.dev convention).
 */

export interface UsagePricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Estimated USD cost for a set of token counts at a given price. Cache
 * reads/writes are billed at their own rate when the model exposes one, else the
 * input rate. Input tokens are treated as the billable (non-cached) prompt —
 * matching Anthropic's accounting, where cache tokens are reported separately;
 * minor skew on providers that bundle them. Reasoning tokens are already part of
 * output tokens, so they're not added again.
 */
export function computeUsageCostUsd(
  pricing: UsagePricing,
  tokens: {
    inputTokens?: number | null
    outputTokens?: number | null
    cacheReadTokens?: number | null
    cacheWriteTokens?: number | null
  },
): number {
  const input = tokens.inputTokens ?? 0
  const output = tokens.outputTokens ?? 0
  const cacheRead = tokens.cacheReadTokens ?? 0
  const cacheWrite = tokens.cacheWriteTokens ?? 0
  const cost =
    input * pricing.input +
    output * pricing.output +
    cacheRead * (pricing.cacheRead ?? pricing.input) +
    cacheWrite * (pricing.cacheWrite ?? pricing.input)
  return cost / 1_000_000
}
