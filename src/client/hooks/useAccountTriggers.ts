import { useCallback, useEffect, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { AccountTriggerSummary } from '@/shared/types'

/**
 * Triggers for one connected account (or all when accountId is omitted).
 * Mirrors useEmailAccounts: fetch on mount, refetch on trigger:* SSE events and
 * on resume/reconnect.
 */
export function useAccountTriggers(accountId?: string) {
  const [triggers, setTriggers] = useState<AccountTriggerSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''
      const res = await api.get<{ triggers: AccountTriggerSummary[] }>(`/account-triggers${qs}`)
      setTriggers(res.triggers)
    } catch {
      // Surfaced by callers via individual actions; list stays as-is.
    } finally {
      setIsLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refetch()
  }, [refetch])

  useSSE({
    'trigger:created': () => { void refetch() },
    'trigger:updated': () => { void refetch() },
    'trigger:deleted': () => { void refetch() },
    'trigger:fired': () => { void refetch() },
  })

  useSSEResync(refetch)

  return { triggers, isLoading, refetch }
}
