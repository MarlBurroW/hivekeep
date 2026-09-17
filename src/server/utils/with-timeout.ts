/**
 * Bound a promise that has no cancellation of its own.
 *
 * Used on the Agent turn path, where an await that never settles is worse than
 * one that fails: it holds the Agent's lock, skips every `finally`, and leaves
 * no recovery short of restarting the process. Prefer a real `AbortSignal` when
 * the callee accepts one (the work then actually stops); reach for this when it
 * does not — an in-process plugin hook, an SDK call with no signal support.
 *
 * The underlying promise is NOT cancelled, it is abandoned: its rejection is
 * swallowed so it cannot surface later as an unhandled rejection.
 */
export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number, label?: string) {
    super(`${label ?? 'Operation'} timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  label?: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new TimeoutError(timeoutMs, label))
    }, timeoutMs)
  })

  // An abandoned promise that rejects later would otherwise crash the process
  // as an unhandled rejection.
  promise.catch(() => {})

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
