import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEStatus, useSSEResync } from '@/client/hooks/useSSE'
import { useModels, type ProviderModel } from '@/client/hooks/useModels'
import type { AgentCompactingConfig, AgentThinkingConfig, AgentThinkingEffort, AgentKind, ContextTokenBreakdown, ContextPipelineStatus } from '@/shared/types'

interface AgentSummary {
  id: string
  slug: string
  name: string
  role: string
  /** 'configurator' for the seeded onboarding guide (Queenie), else 'regular'. */
  kind: AgentKind
  avatarUrl: string | null
  model: string
  providerId: string | null
  createdAt: string
  thinkingEnabled: boolean
  thinkingEffort: AgentThinkingEffort | null
}

interface AgentDetail extends AgentSummary {
  character: string
  expertise: string
  /** Optional cheap scout model for the `scout` tool. Coupled with
   *  `scoutProviderId`; null → inherit (global default → main model). */
  scoutModel: string | null
  scoutProviderId: string | null
  workspacePath: string
  /** Toolbox selection (sole tool-grant primitive). Null → 'all' built-in. */
  toolboxIds: string[] | null
  /** Individual tool grants on top of toolboxes (incl. approved
   *  request_tool_access requests). Null → none. */
  extraToolNames: string[] | null
  compactingConfig: AgentCompactingConfig | null
  thinkingConfig: AgentThinkingConfig | null
  mcpServers: { id: string; name: string }[]
  queueSize: number
  isProcessing: boolean
}

export interface GeneratedAgentConfig {
  name: string
  role: string
  character: string
  expertise: string
  suggestedModel: string
}

interface CreateAgentData {
  name: string
  slug?: string
  role: string
  character: string
  expertise: string
  model: string
  providerId?: string | null
  scoutModel?: string | null
  scoutProviderId?: string | null
  scoutThinkingConfig?: AgentThinkingConfig | null
  toolboxIds?: string[] | null
}

interface UpdateAgentData {
  name?: string
  slug?: string
  role?: string
  character?: string
  expertise?: string
  model?: string
  providerId?: string | null
  scoutModel?: string | null
  scoutProviderId?: string | null
  toolboxIds?: string[] | null
  extraToolNames?: string[] | null
  compactingConfig?: AgentCompactingConfig | null
  thinkingConfig?: AgentThinkingConfig | null
  scoutThinkingConfig?: AgentThinkingConfig | null
}

interface UserProfile {
  agentOrder: string | null
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const { models, llmModels, imageModels, refetch: fetchModels } = useModels()
  const [isLoading, setIsLoading] = useState(true)
  const [agentOrder, setAgentOrder] = useState<string[]>([])
  const hasImageCapability = imageModels.length > 0

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.get<{ agents: (AgentSummary & { isProcessing?: boolean; queueSize?: number; processingStartedAt?: number })[] }>('/agents')
      setAgents(data.agents)
      // Hydrate queue state from initial fetch so we don't miss processing state
      setAgentQueueState((prev) => {
        const next = new Map(prev)
        for (const agent of data.agents) {
          if (agent.isProcessing || (agent.queueSize && agent.queueSize > 0)) {
            const existing = next.get(agent.id)
            next.set(agent.id, {
              ...existing,
              isProcessing: agent.isProcessing ?? false,
              queueSize: agent.queueSize ?? 0,
              processingStartedAt: agent.processingStartedAt ?? existing?.processingStartedAt,
            })
          }
        }
        return next
      })
    } catch {
      // Ignore errors
    } finally {
      setIsLoading(false)
    }
  }, [])

  const fetchAgentOrder = useCallback(async () => {
    try {
      const profile = await api.get<UserProfile>('/me')
      if (profile.agentOrder) {
        setAgentOrder(JSON.parse(profile.agentOrder) as string[])
      }
    } catch {
      // Ignore errors
    }
  }, [])

  // Image capability is now derived from useModels() — no need for a separate fetch

  useEffect(() => {
    fetchAgents()
    fetchAgentOrder()
  }, [fetchAgents, fetchAgentOrder])

  // Refetch when SSE reconnects (agents may have changed while disconnected)
  const sseStatus = useSSEStatus()
  const prevStatusRef = useRef(sseStatus)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = sseStatus
    if (prev !== 'connected' && sseStatus === 'connected') {
      fetchAgents()
    }
  }, [sseStatus, fetchAgents])

  // Also catch up on resume even if the connection never dropped — a locked
  // phone often keeps the EventSource "open" but silently drops events, so the
  // status transition above never fires. Refreshes the list + per-agent queue
  // state (which drives the processing indicator and context bar). Also refetch
  // agentOrder so a reorder made in another tab/device is not missed.
  useSSEResync(() => {
    fetchAgents()
    fetchAgentOrder()
  })

  // Track which agents are currently processing (queue state from SSE)
  const [agentQueueState, setAgentQueueState] = useState<Map<string, { isProcessing: boolean; queueSize: number; processingStartedAt?: number; contextTokens?: number; contextWindow?: number; apiContextTokens?: number;contextBreakdown?: ContextTokenBreakdown; pipelineStatus?: ContextPipelineStatus; compactingPercent?: number; compactingThresholdPercent?: number; summaryCount?: number; maxSummaries?: number; summaryTokens?: number; summaryBudgetTokens?: number; keepPercent?: number }>>(new Map())

  // Listen for agent lifecycle and queue updates via SSE to keep the list in sync
  useSSE({
    'agent:created': (data) => {
      const newAgent: AgentSummary = {
        id: data.agentId as string,
        slug: data.slug as string,
        name: data.name as string,
        role: data.role as string,
        kind: (data.kind as AgentKind | undefined) ?? 'regular',
        model: data.model as string,
        providerId: (data.providerId as string | null) ?? null,
        avatarUrl: (data.avatarUrl as string | null) ?? null,
        createdAt: data.createdAt as string,
        thinkingEnabled: (data.thinkingEnabled as boolean) ?? false,
        thinkingEffort: (data.thinkingEffort as AgentThinkingEffort | null) ?? null,
      }
      setAgents((prev) => {
        // Avoid duplicates (e.g. if this client also called createAgent via the UI)
        if (prev.some((k) => k.id === newAgent.id)) return prev
        return [...prev, newAgent]
      })
    },
    'agent:updated': (data) => {
      const agentId = data.agentId as string
      setAgents((prev) =>
        prev.map((k) =>
          k.id === agentId
            ? {
                ...k,
                ...(data.slug !== undefined && { slug: data.slug as string }),
                ...(data.name !== undefined && { name: data.name as string }),
                ...(data.role !== undefined && { role: data.role as string }),
                ...(data.model !== undefined && { model: data.model as string }),
                ...(data.providerId !== undefined && { providerId: data.providerId as string | null }),
                ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl as string | null }),
                ...(data.thinkingEnabled !== undefined && { thinkingEnabled: data.thinkingEnabled as boolean }),
                ...(data.thinkingEffort !== undefined && { thinkingEffort: data.thinkingEffort as AgentThinkingEffort | null }),
              }
            : k,
        ),
      )
    },
    'agent:deleted': (data) => {
      const agentId = data.agentId as string
      setAgents((prev) => prev.filter((k) => k.id !== agentId))
      setAgentQueueState((prev) => {
        const next = new Map(prev)
        next.delete(agentId)
        return next
      })
    },
    'queue:update': (data) => {
      const agentId = data.agentId as string
      const isProcessing = data.isProcessing as boolean
      const queueSize = data.queueSize as number
      setAgentQueueState((prev) => {
        const next = new Map(prev)
        const existing = prev.get(agentId)
        next.set(agentId, {
          isProcessing,
          queueSize,
          processingStartedAt: isProcessing
            ? (data.processingStartedAt as number | undefined) ?? existing?.processingStartedAt
            : undefined,
          // Keep previous context info when not provided (end-of-processing events omit it).
          // For apiContextTokens specifically, an explicit `null` from the server means
          // "actively clear" (compacting service emits this after a successful summary
          // since the previous API count is for a payload that no longer applies).
          // Only `undefined` means "no update for this field".
          contextTokens: (data.contextTokens as number | undefined) ?? existing?.contextTokens,
          contextWindow: (data.contextWindow as number | undefined) ?? existing?.contextWindow,
          apiContextTokens: data.apiContextTokens === null
            ? undefined
            : (data.apiContextTokens as number | undefined) ?? existing?.apiContextTokens,
          contextBreakdown: (data.contextBreakdown as ContextTokenBreakdown | undefined) ?? existing?.contextBreakdown,
          pipelineStatus: (data.pipelineStatus as ContextPipelineStatus | undefined) ?? existing?.pipelineStatus,
          compactingPercent: (data.compactingPercent as number | undefined) ?? existing?.compactingPercent,
          compactingThresholdPercent: (data.compactingThresholdPercent as number | undefined) ?? existing?.compactingThresholdPercent,
          summaryCount: (data.summaryCount as number | undefined) ?? existing?.summaryCount,
          maxSummaries: (data.maxSummaries as number | undefined) ?? existing?.maxSummaries,
          summaryTokens: (data.summaryTokens as number | undefined) ?? existing?.summaryTokens,
          summaryBudgetTokens: (data.summaryBudgetTokens as number | undefined) ?? existing?.summaryBudgetTokens,
          keepPercent: (data.keepPercent as number | undefined) ?? existing?.keepPercent,
        })
        return next
      })
    },
    'profile:updated': (data) => {
      // Sync agentOrder when another tab/device reorders — avoid clobbering if
      // this tab was the one that initiated the reorder (optimistic update wins).
      if (data.agentOrder !== undefined) {
        const newOrder = data.agentOrder as string[]
        setAgentOrder(newOrder)
      }
    },
  })

  // Sort agents by user order — ordered agents first, then any new agents at the end
  const sortedAgents = useMemo(() => {
    if (agentOrder.length === 0) return agents
    const orderMap = new Map(agentOrder.map((id, i) => [id, i]))
    return [...agents].sort((a, b) => {
      const ia = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const ib = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return ia - ib
    })
  }, [agents, agentOrder])

  const reorderAgents = useCallback(async (newOrder: string[]) => {
    setAgentOrder(newOrder)
    try {
      await api.patch('/me', { agentOrder: JSON.stringify(newOrder) })
    } catch {
      // Revert on failure
      fetchAgentOrder()
    }
  }, [fetchAgentOrder])

  // Fetch initial context usage for an agent (so the counter doesn't show "— / —")
  const fetchContextUsage = useCallback(async (agentId: string) => {
    try {
      const data = await api.get<{ contextTokens: number; contextWindow: number; apiContextTokens?: number;contextBreakdown?: ContextTokenBreakdown; pipelineStatus?: ContextPipelineStatus; compactingPercent?: number; compactingThresholdPercent?: number; summaryCount?: number; maxSummaries?: number; summaryTokens?: number; summaryBudgetTokens?: number; keepPercent?: number }>(`/agents/${agentId}/context-usage`)
      setAgentQueueState((prev) => {
        const existing = prev.get(agentId)
        // Don't overwrite if SSE already provided fresh data
        if (existing?.contextWindow && existing.contextWindow > 0) return prev
        const next = new Map(prev)
        next.set(agentId, {
          isProcessing: existing?.isProcessing ?? false,
          queueSize: existing?.queueSize ?? 0,
          processingStartedAt: existing?.processingStartedAt,
          contextTokens: data.contextTokens,
          contextWindow: data.contextWindow,
          apiContextTokens: data.apiContextTokens ?? undefined,
          contextBreakdown: data.contextBreakdown,
          pipelineStatus: data.pipelineStatus ?? undefined,
          compactingPercent: data.compactingPercent,
          compactingThresholdPercent: data.compactingThresholdPercent,
          summaryCount: data.summaryCount,
          maxSummaries: data.maxSummaries,
          summaryTokens: data.summaryTokens,
          summaryBudgetTokens: data.summaryBudgetTokens,
          keepPercent: data.keepPercent,
        })
        return next
      })
    } catch {
      // Non-fatal — counter will just show "— / —" until first message
    }
  }, [])

  const getAgent = useCallback(async (id: string): Promise<AgentDetail> => {
    return api.get<AgentDetail>(`/agents/${id}`)
  }, [])

  const createAgent = useCallback(async (data: CreateAgentData): Promise<AgentDetail> => {
    const result = await api.post<{ agent: AgentDetail }>('/agents', data)
    await fetchAgents()
    return result.agent
  }, [fetchAgents])

  const updateAgent = useCallback(async (id: string, data: UpdateAgentData): Promise<AgentDetail> => {
    const result = await api.patch<{ agent: AgentDetail }>(`/agents/${id}`, data)
    // Update local state immediately (SSE also propagates for other clients)
    setAgents((prev) =>
      prev.map((k) =>
        k.id === id
          ? {
              ...k,
              ...(data.slug !== undefined && { slug: data.slug }),
              ...(data.name !== undefined && { name: data.name }),
              ...(data.role !== undefined && { role: data.role }),
              ...(data.model !== undefined && { model: data.model }),
              ...(data.providerId !== undefined && { providerId: data.providerId }),
              ...(data.thinkingConfig !== undefined && {
                thinkingEnabled: data.thinkingConfig?.enabled === true,
                thinkingEffort: data.thinkingConfig?.effort ?? null,
              }),
              avatarUrl: result.agent.avatarUrl,
            }
          : k,
      ),
    )
    // If the model or provider changed, the cached contextWindow is stale —
    // wipe it so the next fetchContextUsage() repopulates with fresh data
    // from the server (which recomputes contextWindow from the new model).
    if (data.model !== undefined || data.providerId !== undefined) {
      setAgentQueueState((prev) => {
        const existing = prev.get(id)
        if (!existing) return prev
        const next = new Map(prev)
        next.set(id, { ...existing, contextWindow: undefined, contextTokens: undefined })
        return next
      })
      // Refetch immediately so the UI doesn't show "— / —" momentarily.
      void fetchContextUsage(id)
    }
    return result.agent
  }, [fetchContextUsage])

  const deleteAgent = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/agents/${id}`)
    setAgentOrder((prev) => prev.filter((agentId) => agentId !== id))
    await fetchAgents()
  }, [fetchAgents])

  const uploadAvatar = useCallback(async (id: string, file: File): Promise<string> => {
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch(`/api/agents/${id}/avatar`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    const data = await response.json() as { avatarUrl: string }
    // Update local state immediately (SSE also propagates for other clients)
    setAgents((prev) =>
      prev.map((k) =>
        k.id === id ? { ...k, avatarUrl: data.avatarUrl } : k,
      ),
    )
    return data.avatarUrl
  }, [])

  const generateAvatarPreview = useCallback(async (
    id: string,
    mode: 'auto' | 'manual',
    opts?: { style?: string; subject?: string; character?: string; useBase?: boolean },
    imageModel?: { providerId: string; modelId: string },
  ): Promise<string> => {
    const data = await api.post<{ base64: string; mediaType: string }>(`/agents/${id}/avatar/generate`, {
      mode,
      ...(opts ?? {}),
      ...(imageModel && { imageProviderId: imageModel.providerId, imageModel: imageModel.modelId }),
    })
    return `data:${data.mediaType};base64,${data.base64}`
  }, [])

  const generateAgentConfig = useCallback(async (data: {
    description?: string
    refinement?: string
    currentConfig?: Record<string, unknown>
    language?: string
    /** Model used to generate the config (distinct from the Agent's own model). */
    model?: string
    providerId?: string | null
  }): Promise<GeneratedAgentConfig> => {
    const result = await api.post<{ config: GeneratedAgentConfig }>('/agents/generate-config', data)
    return result.config
  }, [])

  const generateAvatarPreviewFromConfig = useCallback(async (data: {
    name: string
    role: string
    character: string
    expertise: string
  }): Promise<string> => {
    const result = await api.post<{ base64: string; mediaType: string }>('/agents/avatar/preview', data)
    return `data:${result.mediaType};base64,${result.base64}`
  }, [])

  return {
    agents: sortedAgents,
    llmModels,
    imageModels,
    isLoading,
    agentQueueState,
    fetchContextUsage,
    getAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    uploadAvatar,
    generateAvatarPreview,
    generateAgentConfig,
    generateAvatarPreviewFromConfig,
    hasImageCapability,
    reorderAgents,
    refetch: fetchAgents,
    refetchModels: fetchModels,
  }
}
