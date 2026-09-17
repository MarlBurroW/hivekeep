/**
 * Adaptive typewriter for streamed text.
 *
 * Some providers deliver text in coarse chunks — Anthropic batches SSE deltas
 * server-side to ~100+ chars every 500-800ms under fast generation — which
 * renders as one or two visible jumps per second no matter how fast the
 * client applies them. This reveals the received buffer progressively: each
 * tick advances a cursor by a fraction of the current backlog, sized to drain
 * it over `drainMs`. Display stays continuous and the cursor converges just
 * behind the upstream chunk cadence; a final `flush()` shows any remainder
 * instantly when the turn ends.
 */
export interface SmoothReveal {
  /** Set the target length after receiving text. A target below the visible
   *  cursor (retraction) snaps the cursor down immediately. */
  setTarget(length: number): void
  /** Set cursor and target to `length` with no animation and no update
   *  callback — for seeding pre-existing text on mid-stream rehydration. */
  prime(length: number): void
  /** Jump the cursor to the target and stop ticking (turn finished). */
  flush(): void
  /** Reset cursor and target to zero and stop ticking. */
  reset(): void
}

export function createSmoothReveal(
  onUpdate: (visibleLength: number) => void,
  { tickMs = 40, drainMs = 900 }: { tickMs?: number; drainMs?: number } = {},
): SmoothReveal {
  let target = 0
  let visible = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  const tick = () => {
    if (visible >= target) {
      stop()
      return
    }
    const backlog = target - visible
    visible = Math.min(target, visible + Math.max(1, Math.ceil((backlog * tickMs) / drainMs)))
    onUpdate(visible)
  }

  return {
    setTarget(length) {
      if (length < visible) {
        visible = length
        onUpdate(visible)
      }
      target = length
      if (!timer && visible < target) timer = setInterval(tick, tickMs)
    },
    prime(length) {
      stop()
      target = length
      visible = length
    },
    flush() {
      stop()
      if (visible !== target) {
        visible = target
        onUpdate(visible)
      }
    },
    reset() {
      stop()
      target = 0
      visible = 0
    },
  }
}
