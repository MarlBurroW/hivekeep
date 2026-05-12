import { useEffect, useState, useMemo } from 'react'
import { useSSE } from '@/client/hooks/useSSE'

/**
 * Subscribe to live updates for a single plugin card and expose the merged
 * state. Initial state comes from the persisted message; updates arrive on
 * the `card:updated` SSE event and merge shallowly so the renderer can
 * re-render without an extra fetch.
 */
export function usePluginCardLiveUpdates(
  cardInstanceId: string,
  initialState: Record<string, unknown>,
): Record<string, unknown> {
  const [patch, setPatch] = useState<Record<string, unknown>>({})

  useEffect(() => {
    // Reset overlay when the card identity changes (e.g. message list
    // refetch returned a different instance id at the same index).
    setPatch({})
  }, [cardInstanceId])

  useSSE({
    'card:updated': (data) => {
      if (data.cardInstanceId !== cardInstanceId) return
      const incoming = data.state as Record<string, unknown> | undefined
      if (!incoming) return
      setPatch((prev) => ({ ...prev, ...incoming }))
    },
  })

  return useMemo(() => ({ ...initialState, ...patch }), [initialState, patch])
}
