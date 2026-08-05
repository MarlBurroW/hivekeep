import { describe, it, expect } from 'bun:test'
import { withTimeout, TimeoutError } from '@/server/utils/with-timeout'

const never = () => new Promise<string>(() => {})
const after = (ms: number, value: string) => new Promise<string>((r) => setTimeout(() => r(value), ms))

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    expect(await withTimeout(after(5, 'done'), 200)).toBe('done')
  })

  it('rejects with TimeoutError when the promise never settles', async () => {
    await expect(withTimeout(never(), 20)).rejects.toThrow(TimeoutError)
  })

  it('names the operation in the error so logs identify the culprit', async () => {
    await expect(withTimeout(never(), 20, undefined, 'Hook handler')).rejects.toThrow(
      'Hook handler timed out after 20ms',
    )
  })

  it('runs the onTimeout callback exactly once on expiry', async () => {
    let calls = 0
    await withTimeout(never(), 20, () => { calls++ }).catch(() => {})
    await after(40, '')
    expect(calls).toBe(1)
  })

  it('does not run onTimeout when the promise wins', async () => {
    let calls = 0
    await withTimeout(after(5, 'ok'), 200, () => { calls++ })
    expect(calls).toBe(0)
  })

  it('propagates the original rejection rather than masking it as a timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('upstream 500')), 200)).rejects.toThrow('upstream 500')
  })

  it('treats a non-positive timeout as unbounded', async () => {
    expect(await withTimeout(after(5, 'v'), 0)).toBe('v')
    expect(await withTimeout(after(5, 'v'), -1)).toBe('v')
  })

  it('swallows a late rejection from the abandoned promise', async () => {
    // The promise is abandoned, not cancelled. Without the internal catch its
    // later rejection would surface as an unhandled rejection and, with the
    // process-level handler installed in main.ts, pollute the logs of an
    // unrelated turn.
    let unhandled: unknown = null
    const onUnhandled = (e: unknown) => { unhandled = e }
    process.on('unhandledRejection', onUnhandled)
    try {
      const doomed = new Promise<string>((_, reject) => setTimeout(() => reject(new Error('too late')), 15))
      await withTimeout(doomed, 5).catch(() => {})
      await after(40, '')
      expect(unhandled).toBeNull()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
