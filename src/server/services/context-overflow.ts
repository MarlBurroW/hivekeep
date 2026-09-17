/**
 * Recognising and reading "your prompt exceeds the context window" responses.
 *
 * Kept dependency-free and separate from agent-engine so it can be unit-tested
 * against the real implementation instead of a copy (importing agent-engine
 * pulls in the DB, providers and tool registry).
 */

/**
 * Match the various ways providers report "you sent too many tokens".
 * Anthropic: "prompt is too long: X tokens > Y maximum"
 * OpenAI:    "This model's maximum context length is X tokens..." or `code:context_length_exceeded`
 * Google:    "input token count (X) exceeds the maximum number of tokens allowed (Y)"
 * Generic:   "context window" appears in many provider messages.
 *
 * Used both to friendly-format the error AND to decide whether to fire a
 * background recovery compacting.
 */
const CONTEXT_TOO_LARGE_RE =
  /prompt is too long|context[\s_-]?length[\s_-]?exceed|maximum context length|context window|exceeds the maximum number of tokens|input token count[^.]{0,40}exceed/i

export function isContextTooLargeError(errorMsg: string): boolean {
  return CONTEXT_TOO_LARGE_RE.test(errorMsg)
}

/** `actual` is the payload size the provider measured, `max` its own limit. */
export interface ContextOverflow {
  actual: number
  max: number
}

const OVERFLOW_PATTERNS: Array<{ re: RegExp; actualFirst: boolean }> = [
  // Anthropic: "prompt is too long: 1021159 tokens > 1000000 maximum"
  { re: /prompt is too long:\s*(\d+)\s*tokens\s*>\s*(\d+)\s*maximum/i, actualFirst: true },
  // OpenAI: "maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens"
  { re: /maximum context length is\s*(\d+)\s*tokens[\s\S]{0,120}?resulted in\s*(\d+)\s*tokens/i, actualFirst: false },
  // Google: "input token count (1021159) exceeds the maximum number of tokens allowed (1000000)"
  { re: /input token count\s*\((\d+)\)[\s\S]{0,80}?allowed\s*\((\d+)\)/i, actualFirst: true },
]

/** Lower bound shared with the success-path calibration: an estimate that
 *  over-counts by more than this is not a plausible reading. */
export const CALIBRATION_MIN = 0.7

/** Ceiling for a factor derived from a rejected payload rather than a
 *  successful roundtrip. The success path clamps at 3.0 to keep a noisy EMA
 *  sane, but that also caps how wrong the estimate is allowed to be discovered
 *  to be: an estimate off by 8x can never be corrected under 3.0, so the gauge
 *  stays wrong and compacting never fires. An overflow is a hard provider
 *  count, so it gets a much wider bound — still bounded, so a mis-parsed error
 *  cannot poison an Agent's calibration permanently. */
export const CALIBRATION_OVERFLOW_MAX = 20.0

/**
 * Calibration factor to adopt after the provider rejected a payload of
 * `actualTokens` that the local estimator had sized at `rawEstimate`.
 *
 * The observed ratio REPLACES the running average instead of blending into it:
 * the estimate was just proven wrong by a hard count, so averaging it with the
 * history that produced the wrong value only slows the correction down.
 *
 * Falls back to `current` when there is no usable estimate to compare against.
 */
export function resolveOverflowCalibration(actualTokens: number, rawEstimate: number | undefined, current: number): number {
  if (!rawEstimate || rawEstimate <= 1000) return current
  const observed = actualTokens / rawEstimate
  return Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_OVERFLOW_MAX, observed))
}

/**
 * A rejection carries the only hard measurement of the payload we ever get: the
 * provider counted the request and refused it. Everything else in the context
 * accounting is an estimate, so these two numbers outrank it.
 *
 * Extracting them turns a permanent deadlock into a self-healing turn. Without
 * them the engine keeps believing the `apiContextTokens` from the last
 * SUCCESSFUL call (a failed call reports no usage at all), so recovery
 * compacting is handed a size below its own trigger and correctly concludes
 * there is nothing to do, while every retry rebuilds the same oversized prompt.
 *
 * Returns null when no known shape matches, or when the numbers are not
 * coherent (a "max" of zero, or an actual size that does not exceed the max,
 * which would mean we misread the message).
 */
export function parseContextOverflowTokens(errorMsg: string): ContextOverflow | null {
  for (const { re, actualFirst } of OVERFLOW_PATTERNS) {
    const m = re.exec(errorMsg)
    if (!m) continue
    const actual = Number(m[actualFirst ? 1 : 2])
    const max = Number(m[actualFirst ? 2 : 1])
    if (!Number.isFinite(actual) || !Number.isFinite(max)) continue
    if (max <= 0 || actual <= max) continue
    return { actual, max }
  }
  return null
}
