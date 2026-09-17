import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { CronSummary } from '@/shared/types'

interface CronsResponse {
  crons: CronSummary[]
}

interface CreateCronData {
  agentId: string
  name: string
  schedule: string
  taskDescription: string
  targetAgentId?: string
  model?: string
  runOnce?: boolean
  triggerParentTurn?: boolean
  toolboxIds?: string[]
}

type UpdateCronData = Partial<{
  name: string
  schedule: string
  taskDescription: string
  targetAgentId: string
  model: string
  isActive: boolean
  runOnce: boolean
  triggerParentTurn: boolean
  toolboxIds: string[] | null
}>

export function useCrons() {
  const [crons, setCrons] = useState<CronSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState(false)
  const [cronOrder, setCronOrder] = useState<string[]>([])

  const fetchCrons = useCallback(async () => {
    try {
      const data = await api.get<CronsResponse>('/crons')
      setCrons(data.crons)
      setFetchError(false)
    } catch {
      setFetchError(true)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchCronOrder = useCallback(async () => {
    try {
      const profile = await api.get<{ cronOrder: string | null }>('/me')
      if (profile.cronOrder) {
        setCronOrder(JSON.parse(profile.cronOrder) as string[])
      }
    } catch {
      // Silently fail
    }
  }, [])

  useEffect(() => {
    fetchCrons()
    fetchCronOrder()
  }, [fetchCrons, fetchCronOrder])

  const createCron = useCallback(async (data: CreateCronData) => {
    const result = await api.post<{ cron: CronSummary }>('/crons', data)
    setCrons((prev) => [result.cron, ...prev])
    return result.cron
  }, [])

  const updateCron = useCallback(async (id: string, updates: UpdateCronData) => {
    const result = await api.patch<{ cron: CronSummary }>(`/crons/${id}`, updates)
    setCrons((prev) => prev.map((c) => (c.id === id ? result.cron : c)))
    return result.cron
  }, [])

  const deleteCron = useCallback(async (id: string) => {
    await api.delete(`/crons/${id}`)
    setCrons((prev) => prev.filter((c) => c.id !== id))
    setCronOrder((prev) => prev.filter((cronId) => cronId !== id))
  }, [])

  const approveCron = useCallback(async (id: string) => {
    const result = await api.post<{ cron: CronSummary }>(`/crons/${id}/approve`)
    setCrons((prev) => prev.map((c) => (c.id === id ? result.cron : c)))
    return result.cron
  }, [])

  const reorderCrons = useCallback(async (newOrder: string[]) => {
    setCronOrder(newOrder)
    try {
      await api.patch('/me', { cronOrder: JSON.stringify(newOrder) })
    } catch {
      // Revert on failure
      fetchCronOrder()
    }
  }, [fetchCronOrder])

  // SSE: real-time cron updates
  useSSE({
    'cron:triggered': (data) => {
      const cronId = data.cronId as string
      // Use the server-authoritative timestamp from the event payload; fall back
      // to client time only for backward compatibility with old server versions.
      const lastTriggeredAt = (data.lastTriggeredAt as number | undefined) ?? Date.now()
      setCrons((prev) =>
        prev.map((c) =>
          c.id === cronId ? { ...c, lastTriggeredAt } : c,
        ),
      )
    },
    'cron:created': () => {
      // A cron was created (possibly by an agent) — refetch to get full data
      fetchCrons()
    },
    'cron:updated': () => {
      // A cron was updated (possibly approval, toggle, etc.) — refetch
      fetchCrons()
    },
    'cron:deleted': (data) => {
      const cronId = data.cronId as string
      setCrons((prev) => prev.filter((c) => c.id !== cronId))
      setCronOrder((prev) => prev.filter((id) => id !== cronId))
    },
    'notification:new': (data) => {
      // An agent-created cron is awaiting approval — refetch so it appears in the list
      if (data.type === 'cron:pending-approval') {
        fetchCrons()
      }
    },
    'profile:updated': (data) => {
      // Sync cronOrder when another tab/device reorders
      if (data.cronOrder !== undefined) {
        const newOrder = data.cronOrder as string[]
        setCronOrder(newOrder)
      }
    },
  })

  // Catch up on missed events after tab resume or SSE reconnect
  useSSEResync(() => {
    fetchCrons()
    fetchCronOrder()
  })

  // Sort: pending-approval first (newest first), then regular crons by user-defined order
  const sortedCrons = useMemo(() => {
    const pending = crons
      .filter((c) => c.requiresApproval)
      .sort((a, b) => b.createdAt - a.createdAt)

    const regular = crons.filter((c) => !c.requiresApproval)

    if (cronOrder.length === 0) {
      // Fallback: newest first. Deliberately NOT sorted by isActive — toggling a
      // cron on/off must not make its card jump around, which is jarring.
      const sorted = [...regular].sort((a, b) => b.createdAt - a.createdAt)
      return [...pending, ...sorted]
    }

    const orderMap = new Map(cronOrder.map((id, i) => [id, i]))
    const sorted = [...regular].sort((a, b) => {
      const ia = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const ib = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return ia - ib
    })
    return [...pending, ...sorted]
  }, [crons, cronOrder])

  // Agent-created crons awaiting user approval — surfaced as a badge on the
  // Crons nav item (ActivityBar + mobile top bar) so the action is discoverable
  // without opening the section.
  const pendingApprovalCount = useMemo(
    () => crons.filter((c) => c.requiresApproval).length,
    [crons],
  )

  return {
    crons: sortedCrons,
    fetchError,
    pendingApprovalCount,
    isLoading,
    createCron,
    updateCron,
    deleteCron,
    approveCron,
    reorderCrons,
    refetch: fetchCrons,
  }
}
