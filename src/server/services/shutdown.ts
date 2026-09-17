let shuttingDown = false
export const isShuttingDown = () => shuttingDown

type ShutdownOptions = {
  stopAdmission: () => void
  stopProducers: () => void
  activeWork: () => number
  abortRemaining: () => void
  closeResources: () => Promise<void>
  drainTimeoutMs: number
  cleanupTimeoutMs: number
  onError: (error: unknown) => void
}

async function waitForIdle(activeWork: () => number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (activeWork() > 0) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
  }
  return true
}

/** One signal sequence, even when SIGINT/SIGTERM arrive repeatedly. Stop new
 * work first, allow a finite drain, then abort and bound resource cleanup. */
export function createShutdown(options: ShutdownOptions) {
  let result: Promise<{ drained: boolean; cleaned: boolean }> | null = null
  return () => {
    if (result) return result
    shuttingDown = true
    result = (async () => {
      for (const stop of [options.stopAdmission, options.stopProducers]) {
        try { stop() } catch (error) { options.onError(error) }
      }
      const drained = await waitForIdle(options.activeWork, options.drainTimeoutMs)
      if (!drained) {
        try { options.abortRemaining() } catch (error) { options.onError(error) }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (async () => {
        // Aborted turns need a chance to commit partial output before DB close.
        await waitForIdle(options.activeWork, options.cleanupTimeoutMs / 2)
        await options.closeResources()
        return true
      })().catch((error) => { options.onError(error); return false })
      try {
        const cleaned = await Promise.race([
          cleanup,
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), options.cleanupTimeoutMs) }),
        ])
        return { drained, cleaned }
      } finally {
        if (timer) clearTimeout(timer)
      }
    })()
    return result
  }
}
