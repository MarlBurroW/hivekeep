import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'

interface InboxPrompt {
  id: string
  agentId: string
  agentName: string
  agentSlug: string
  question: string
}
interface InboxResponse {
  prompts: InboxPrompt[]
  total: number
  hasMore: boolean
}

/** Shared conversation questions; task questions remain in the task list. */
export function useInboxPrompts() {
  const [data, setData] = useState<InboxResponse>({ prompts: [], total: 0, hasMore: false })
  const [isLoading, setIsLoading] = useState(true)
  const [isFetching, setIsFetching] = useState(false)
  const [error, setError] = useState(false)
  const requestId = useRef(0)
  const fetchPage = useCallback(async (offset: number, append = false) => {
    const id = ++requestId.current
    setIsFetching(true)
    try {
      const response = await api.get<InboxResponse>(`/prompts/inbox?limit=20&offset=${offset}`)
      if (id !== requestId.current) return
      setData((previous) => ({
        ...response,
        prompts: append
          ? [
              ...new Map(
                [...previous.prompts, ...response.prompts].map((prompt) => [prompt.id, prompt]),
              ).values(),
            ]
          : response.prompts,
      }))
      setError(false)
    } catch {
      if (id === requestId.current) setError(true)
    } finally {
      if (id === requestId.current) {
        setIsLoading(false)
        setIsFetching(false)
      }
    }
  }, [])
  const refetch = useCallback(() => {
    void fetchPage(0)
  }, [fetchPage])
  useEffect(() => {
    refetch()
    return () => {
      requestId.current++
    }
  }, [refetch])
  useSSE({
    'prompt:pending': refetch,
    'prompt:answered': refetch,
    'prompt:expired': refetch,
    'agent:deleted': refetch,
  })
  useSSEResync(refetch)
  return {
    ...data,
    isLoading,
    isFetching,
    error,
    refetch,
    loadMore: () => {
      if (!isFetching) void fetchPage(data.prompts.length, true)
    },
  }
}
