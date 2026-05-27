import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/client/lib/api'
import type { ProjectKnowledge } from '@/shared/types'

type ListMode = 'list' | 'search'

interface KnowledgeFilters {
  q?: string
  category?: string
  pinned?: boolean
  limit?: number
  offset?: number
}

interface ListResponse {
  entries: ProjectKnowledge[]
  total: number
  mode: ListMode
}

/**
 * Fetch project knowledge entries with optional filters. When `q` is set the
 * backend switches to semantic+FTS search and returns ranked results.
 *
 * Re-fetches whenever projectId or any filter changes. A short debounce on `q`
 * keeps typing responsive without spamming the server.
 */
export function useProjectKnowledge(
  projectId: string | null,
  filters: KnowledgeFilters = {},
) {
  const [entries, setEntries] = useState<ProjectKnowledge[]>([])
  const [total, setTotal] = useState(0)
  const [mode, setMode] = useState<ListMode>('list')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stabilize filter inputs to avoid re-fetching on every parent render
  const { q, category, pinned, limit, offset } = filters
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchEntries = useCallback(async () => {
    if (!projectId) {
      setEntries([])
      setTotal(0)
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (q) params.set('q', q)
      if (category) params.set('category', category)
      if (pinned !== undefined) params.set('pinned', String(pinned))
      if (limit !== undefined) params.set('limit', String(limit))
      if (offset !== undefined) params.set('offset', String(offset))
      const qs = params.toString()
      const url = `/projects/${projectId}/knowledge${qs ? `?${qs}` : ''}`
      const data = await api.get<ListResponse>(url)
      setEntries(data.entries)
      setTotal(data.total)
      setMode(data.mode)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load knowledge')
    } finally {
      setIsLoading(false)
    }
  }, [projectId, q, category, pinned, limit, offset])

  useEffect(() => {
    // Debounce only when there's a query (typing); otherwise fetch immediately.
    if (q && q.length > 0) {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        fetchEntries()
      }, 200)
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
      }
    }
    fetchEntries()
  }, [fetchEntries, q])

  return { entries, total, mode, isLoading, error, refetch: fetchEntries }
}

interface CreateInput {
  title: string
  content: string
  category?: string | null
  pinned?: boolean
}

interface UpdateInput {
  title?: string
  content?: string
  category?: string | null
  pinned?: boolean
}

/**
 * Mutations for project knowledge. Each returns the updated entry (or void
 * for delete) so callers can refresh local state without an extra fetch.
 *
 * Error handling: throws ApiRequestError on failure, including
 * `PIN_CAP_EXCEEDED` which callers should catch to show a friendly toast.
 */
export function useProjectKnowledgeMutations(projectId: string | null) {
  const create = useCallback(
    async (input: CreateInput): Promise<ProjectKnowledge> => {
      if (!projectId) throw new Error('NO_PROJECT')
      const data = await api.post<{ entry: ProjectKnowledge }>(
        `/projects/${projectId}/knowledge`,
        input,
      )
      return data.entry
    },
    [projectId],
  )

  const update = useCallback(
    async (id: string, input: UpdateInput): Promise<ProjectKnowledge> => {
      if (!projectId) throw new Error('NO_PROJECT')
      const data = await api.patch<{ entry: ProjectKnowledge }>(
        `/projects/${projectId}/knowledge/${id}`,
        input,
      )
      return data.entry
    },
    [projectId],
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!projectId) throw new Error('NO_PROJECT')
      await api.delete(`/projects/${projectId}/knowledge/${id}`)
    },
    [projectId],
  )

  const togglePin = useCallback(
    async (id: string, pinned: boolean): Promise<ProjectKnowledge> => {
      return update(id, { pinned })
    },
    [update],
  )

  return { create, update, remove, togglePin }
}
