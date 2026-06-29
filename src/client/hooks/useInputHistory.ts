import { useCallback, useRef } from 'react'

const STORAGE_KEY = 'gezy:input-history'
const MAX_HISTORY = 50

/**
 * Stores sent messages per agent and allows cycling through them with Up/Down arrows.
 * Works like a terminal history: Up goes back, Down goes forward, Escape resets.
 */
export function useInputHistory(agentId: string) {
  // Index into the history. -1 means "not browsing history" (current draft).
  const indexRef = useRef(-1)
  // Stores the current draft when the user starts browsing history.
  const draftRef = useRef('')

  const getHistory = useCallback((): string[] => {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY}:${agentId}`)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  }, [agentId])

  const push = useCallback(
    (message: string) => {
      const trimmed = message.trim()
      if (!trimmed) return
      const history = getHistory()
      // Remove duplicate if it's the same as the most recent entry
      if (history.length > 0 && history[0] === trimmed) {
        // Already at top — no-op
      } else {
        history.unshift(trimmed)
        if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
      }
      try {
        localStorage.setItem(`${STORAGE_KEY}:${agentId}`, JSON.stringify(history))
      } catch {
        // Storage full — silently ignore
      }
      // Reset browsing state after sending
      indexRef.current = -1
      draftRef.current = ''
    },
    [agentId, getHistory],
  )

  /**
   * Navigate history. Returns the new value to set in the input, or null if no action.
   * @param direction 'up' | 'down'
   * @param currentValue Current textarea value (to save as draft on first up)
   */
  const navigate = useCallback(
    (direction: 'up' | 'down', currentValue: string): string | null => {
      const history = getHistory()
      if (history.length === 0) return null

      if (direction === 'up') {
        if (indexRef.current === -1) {
          // Save current draft before entering history
          draftRef.current = currentValue
        }
        const nextIndex = indexRef.current + 1
        if (nextIndex >= history.length) return null // Already at oldest
        indexRef.current = nextIndex
        return history[nextIndex] ?? null
      }

      // direction === 'down'
      if (indexRef.current <= -1) return null // Not browsing history
      const nextIndex = indexRef.current - 1
      if (nextIndex < 0) {
        // Return to draft
        indexRef.current = -1
        return draftRef.current
      }
      indexRef.current = nextIndex
      return history[nextIndex] ?? null
    },
    [getHistory],
  )

  const reset = useCallback(() => {
    indexRef.current = -1
    draftRef.current = ''
  }, [])

  return { push, navigate, reset }
}
