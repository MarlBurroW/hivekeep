import { useEffect, useState } from 'react'

/**
 * Returns a live-ticking `Date.now()` value, re-rendering the calling component
 * at a fixed interval. Used to drive live duration counters (running tasks,
 * in-progress tickets) without each row owning its own timer.
 *
 * Pass `active = false` to freeze the clock (e.g. once every visible item is in
 * a terminal state) so we don't keep re-rendering for nothing. When inactive,
 * the returned value stops updating but stays defined.
 *
 * @param active   Whether to keep ticking. Default true.
 * @param intervalMs Tick cadence in ms. Default 1000 (1s, matching second-level
 *   duration display).
 */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    // Sync immediately so a freshly-activated clock doesn't show a stale value
    // for up to one interval.
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])

  return now
}
