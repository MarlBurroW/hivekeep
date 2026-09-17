import { useState, useEffect, useCallback } from 'react'
import { api, getErrorMessage } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'

export interface AgentProfile {
  content: string
  tokenEstimate: number
  budget: number
  lastRewriteAt: string | null
  manuallyEditedAt: string | null
  updatedAt: string | null
}

/**
 * The curated memory profile of one Agent (see memory.md). Kept in sync via the
 * agent-profile:updated SSE event, which fires for maintenance rewrites and
 * edit_profile tool calls as well as user edits.
 */
export function useAgentProfile(agentId: string | null) {
  const [profile, setProfile] = useState<AgentProfile | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchProfile = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    try {
      const res = await api.get<{ profile: AgentProfile }>(`/agents/${agentId}/profile`)
      setProfile(res.profile)
      setError(null)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    void fetchProfile()
  }, [fetchProfile])

  useSSEResync(() => { void fetchProfile() })

  useSSE({
    'agent-profile:updated': (data) => {
      if (agentId && (data as { agentId?: string }).agentId === agentId) void fetchProfile()
    },
  })

  const save = useCallback(async (content: string) => {
    if (!agentId) return
    const res = await api.put<{ profile: AgentProfile }>(`/agents/${agentId}/profile`, { content })
    setProfile(res.profile)
  }, [agentId])

  const regenerate = useCallback(async () => {
    if (!agentId) return
    await api.post(`/agents/${agentId}/profile/regenerate`, {})
  }, [agentId])

  return { profile, loading, error, save, regenerate, refetch: fetchProfile }
}
