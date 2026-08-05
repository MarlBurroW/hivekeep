import { describe, it, expect } from 'bun:test'
import {
  isContextTooLargeError,
  parseContextOverflowTokens,
  resolveOverflowCalibration,
  CALIBRATION_MIN,
  CALIBRATION_OVERFLOW_MAX,
} from '@/server/services/context-overflow'

describe('isContextTooLargeError', () => {
  it('matches the Anthropic wording', () => {
    expect(isContextTooLargeError('prompt is too long: 1021159 tokens > 1000000 maximum')).toBe(true)
  })

  it('matches the OpenAI wording', () => {
    expect(
      isContextTooLargeError("This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens."),
    ).toBe(true)
  })

  it('matches the Google wording', () => {
    expect(
      isContextTooLargeError('input token count (1021159) exceeds the maximum number of tokens allowed (1000000)'),
    ).toBe(true)
  })

  it('does not match unrelated provider errors', () => {
    expect(isContextTooLargeError('429 rate limit exceeded, please retry')).toBe(false)
    expect(isContextTooLargeError('The long context beta is not yet available for this subscription.')).toBe(false)
  })
})

describe('parseContextOverflowTokens', () => {
  it('reads both numbers from the Anthropic wording', () => {
    // The exact payload that deadlocked the Majordome conversation.
    expect(
      parseContextOverflowTokens(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1021159 tokens > 1000000 maximum"},"request_id":"req_011Cdj"}',
      ),
    ).toEqual({ actual: 1021159, max: 1000000 })
  })

  it('reads the OpenAI wording, where the limit comes before the actual size', () => {
    expect(
      parseContextOverflowTokens(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130500 tokens. Please reduce the length of the messages.",
      ),
    ).toEqual({ actual: 130500, max: 128000 })
  })

  it('reads the Google wording', () => {
    expect(
      parseContextOverflowTokens('input token count (1021159) exceeds the maximum number of tokens allowed (1000000)'),
    ).toEqual({ actual: 1021159, max: 1000000 })
  })

  it('returns null when the error carries no numbers', () => {
    expect(parseContextOverflowTokens('context_length_exceeded')).toBeNull()
  })

  it('returns null for an unrelated error', () => {
    expect(parseContextOverflowTokens('429 rate limit exceeded')).toBeNull()
  })

  it('rejects an incoherent pair rather than poisoning the calibration', () => {
    // actual <= max means we misread the message: a payload that fits was not
    // rejected for being too long. Feeding that ratio into the calibration
    // would silently corrupt the Agent's context accounting.
    expect(parseContextOverflowTokens('prompt is too long: 900 tokens > 1000000 maximum')).toBeNull()
    expect(parseContextOverflowTokens('prompt is too long: 500 tokens > 500 maximum')).toBeNull()
  })

  it('rejects a zero limit', () => {
    expect(parseContextOverflowTokens('prompt is too long: 1000 tokens > 0 maximum')).toBeNull()
  })
})

describe('resolveOverflowCalibration', () => {
  it('adopts the observed ratio, replacing the previous factor', () => {
    // The estimator sized the payload at 100k, the provider counted 250k.
    expect(resolveOverflowCalibration(250_000, 100_000, 1.2)).toBeCloseTo(2.5, 5)
  })

  it('represents a divergence the success-path 3.0 clamp could never encode', () => {
    // The real Majordome numbers: estimated 118_557, actually 1_021_159.
    // Under the old clamp this capped at 3.0 and the gauge stayed 5x too low,
    // leaving compacting permanently below its own trigger.
    const factor = resolveOverflowCalibration(1_021_159, 118_557, 1.724)
    expect(factor).toBeCloseTo(8.613, 2)
    expect(factor).toBeGreaterThan(3.0)
  })

  it('does not exceed the overflow ceiling', () => {
    expect(resolveOverflowCalibration(50_000_000, 10_000, 1)).toBe(CALIBRATION_OVERFLOW_MAX)
  })

  it('does not fall below the floor', () => {
    expect(resolveOverflowCalibration(10_000, 1_000_000, 1)).toBe(CALIBRATION_MIN)
  })

  it('keeps the current factor when there is no usable estimate to compare against', () => {
    expect(resolveOverflowCalibration(1_021_159, undefined, 1.5)).toBe(1.5)
    expect(resolveOverflowCalibration(1_021_159, 0, 1.5)).toBe(1.5)
    // Below the 1000-token guard the ratio is dominated by noise.
    expect(resolveOverflowCalibration(1_021_159, 800, 1.5)).toBe(1.5)
  })
})
