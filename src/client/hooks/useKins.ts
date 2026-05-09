import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEStatus } from '@/client/hooks/useSSE'
import { useModels, type ProviderModel } from '@/client/hooks/useModels'
import type { KinToolConfig, KinCompactingConfig, KinThinkingConfig, ContextTokenBreakdown, ContextPipelineStatus } from '@/shared/types'

interface KinSummary {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
  model: string
  providerId: string | null
  createdAt: string
  isHub: boolean
  thinkingEnabled: boolean
}

interface KinDetail extends KinSummary {
  character: string
  expertise: string
  workspacePath: string
  toolConfig: KinToolConfig | null
  compactingConfig: KinCompactingConfig | null
  thinkingConfig: KinThinkingConfig | null
  mcpServers: { id: string; name: string }[]
  queueSize: number
  isProcessing: boolean
}

/** @deprecated Use ProviderModel from useModels instead */
type Model = ProviderModel

export interface GeneratedKinConfig {
  name: string
  role: string
  character: string
  expertise: string
  suggestedModel: string
  disableToolDomains: string[]
  enableOptInToolDomains: string[]
}

interface CreateKinData {
  name: string
  slug?: string
  role: string
  character: string
  expertise: string
  model: string
  providerId?: string | null
}

interface UpdateKinData {
  name?: string
  slug?: string
  role?: string
  character?: string
  expertise?: string
  model?: string
  providerId?: string | null
  toolConfig?: KinToolConfig | null
  compactingConfig?: KinCompactingConfig | null
  thinkingConfig?: KinThinkingConfig | null
}

interface UserProfile {
  kinOrder: string | null
}

export function useKins() {
  const [kins, setKins] = useState<KinSummary[]>([])
  const { models, llmModels, imageModels, refetch: fetchModels } = useModels()
  const [isLoading, setIsLoading] = useState(true)
  const [kinOrder, setKinOrder] = useState<string[]>([])
  const hasImageCapability = imageModels.length > 0

  const fetchKins = useCallback(async () => {
    try {
      const data = await api.get<{ kins: (KinSummary & { isProcessing?: boolean; queueSize?: number; processingStartedAt?: number })[] }>('/kins')
      setKins(data.kins)
      // Hydrate queue state from initial fetch so we don't miss processing state
      setKinQueueState((prev) => {
        const next = new Map(prev)
        for (const kin of data.kins) {
          if (kin.isProcessing || (kin.queueSize && kin.queueSize > 0)) {
            const existing = next.get(kin.id)
            next.set(kin.id, {
              ...existing,
              isProcessing: kin.isProcessing ?? false,
              queueSize: kin.queueSize ?? 0,
              processingStartedAt: kin.processingStartedAt ?? existing?.processingStartedAt,
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

  const fetchKinOrder = useCallback(async () => {
    try {
      const profile = await api.get<UserProfile>('/me')
      if (profile.kinOrder) {
        setKinOrder(JSON.parse(profile.kinOrder) as string[])
      }
    } catch {
      // Ignore errors
    }
  }, [])

  // Image capability is now derived from useModels() — no need for a separate fetch

  useEffect(() => {
    fetchKins()
    fetchKinOrder()
  }, [fetchKins, fetchKinOrder])

  // Refetch when SSE reconnects (kins may have changed while disconnected)
  const sseStatus = useSSEStatus()
  const prevStatusRef = useRef(sseStatus)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = sseStatus
    if (prev !== 'connected' && sseStatus === 'connected') {
      fetchKins()
    }
  }, [sseStatus, fetchKins])

  // Track which kins are currently processing (queue state from SSE)
  const [kinQueueState, setKinQueueState] = useState<Map<string, { isProcessing: boolean; queueSize: number; processingStartedAt?: number; contextTokens?: number; contextWindow?: number; apiContextTokens?: number;contextBreakdown?: ContextTokenBreakdown; pipelineStatus?: ContextPipelineStatus; compactingPercent?: number; compactingThresholdPercent?: number; summaryCount?: number; maxSummaries?: number; summaryTokens?: number; summaryBudgetTokens?: number; keepPercent?: number }>>(new Map())

  // Listen for kin lifecycle and queue updates via SSE to keep the list in sync
  useSSE({
    'kin:created': (data) => {
      const newKin: KinSummary = {
        id: data.kinId as string,
        slug: data.slug as string,
        name: data.name as string,
        role: data.role as string,
        model: data.model as string,
        providerId: (data.providerId as string | null) ?? null,
        avatarUrl: (data.avatarUrl as string | null) ?? null,
        createdAt: data.createdAt as string,
        isHub: false,
        thinkingEnabled: (data.thinkingEnabled as boolean) ?? false,
      }
      setKins((prev) => {
        // Avoid duplicates (e.g. if this client also called createKin via the UI)
        if (prev.some((k) => k.id === newKin.id)) return prev
        return [...prev, newKin]
      })
    },
    'kin:updated': (data) => {
      const kinId = data.kinId as string
      setKins((prev) =>
        prev.map((k) =>
          k.id === kinId
            ? {
                ...k,
                ...(data.slug !== undefined && { slug: data.slug as string }),
                ...(data.name !== undefined && { name: data.name as string }),
                ...(data.role !== undefined && { role: data.role as string }),
                ...(data.model !== undefined && { model: data.model as string }),
                ...(data.providerId !== undefined && { providerId: data.providerId as string | null }),
                ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl as string | null }),
              }
            : k,
        ),
      )
    },
    'kin:deleted': (data) => {
      const kinId = data.kinId as string
      setKins((prev) => prev.filter((k) => k.id !== kinId))
      setKinQueueState((prev) => {
        const next = new Map(prev)
        next.delete(kinId)
        return next
      })
    },
    'queue:update': (data) => {
      const kinId = data.kinId as string
      const isProcessing = data.isProcessing as boolean
      const queueSize = data.queueSize as number
      setKinQueueState((prev) => {
        const next = new Map(prev)
        const existing = prev.get(kinId)
        next.set(kinId, {
          isProcessing,
          queueSize,
          processingStartedAt: isProcessing
            ? (data.processingStartedAt as number | undefined) ?? existing?.processingStartedAt
            : undefined,
          // Keep previous context info when not provided (end-of-processing events omit it)
          contextTokens: (data.contextTokens as number | undefined) ?? existing?.contextTokens,
          contextWindow: (data.contextWindow as number | undefined) ?? existing?.contextWindow,
          apiContextTokens: (data.apiContextTokens as number | undefined) ?? existing?.apiContextTokens,
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
    'settings:hub-changed': (data) => {
      const newHubKinId = (data.hubKinId as string | null) ?? null
      setKins((prev) =>
        prev.map((k) => ({ ...k, isHub: k.id === newHubKinId })),
      )
    },
  })

  // Sort kins by user order — ordered kins first, then any new kins at the end
  const sortedKins = useMemo(() => {
    if (kinOrder.length === 0) return kins
    const orderMap = new Map(kinOrder.map((id, i) => [id, i]))
    return [...kins].sort((a, b) => {
      const ia = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const ib = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return ia - ib
    })
  }, [kins, kinOrder])

  const reorderKins = useCallback(async (newOrder: string[]) => {
    setKinOrder(newOrder)
    try {
      await api.patch('/me', { kinOrder: JSON.stringify(newOrder) })
    } catch {
      // Revert on failure
      fetchKinOrder()
    }
  }, [fetchKinOrder])

  // Fetch initial context usage for a kin (so the counter doesn't show "— / —")
  const fetchContextUsage = useCallback(async (kinId: string) => {
    try {
      const data = await api.get<{ contextTokens: number; contextWindow: number; apiContextTokens?: number;contextBreakdown?: ContextTokenBreakdown; pipelineStatus?: ContextPipelineStatus; compactingPercent?: number; compactingThresholdPercent?: number; summaryCount?: number; maxSummaries?: number; summaryTokens?: number; summaryBudgetTokens?: number; keepPercent?: number }>(`/kins/${kinId}/context-usage`)
      setKinQueueState((prev) => {
        const existing = prev.get(kinId)
        // Don't overwrite if SSE already provided fresh data
        if (existing?.contextWindow && existing.contextWindow > 0) return prev
        const next = new Map(prev)
        next.set(kinId, {
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

  const getKin = useCallback(async (id: string): Promise<KinDetail> => {
    return api.get<KinDetail>(`/kins/${id}`)
  }, [])

  const createKin = useCallback(async (data: CreateKinData): Promise<KinDetail> => {
    const result = await api.post<{ kin: KinDetail }>('/kins', data)
    await fetchKins()
    return result.kin
  }, [fetchKins])

  const updateKin = useCallback(async (id: string, data: UpdateKinData): Promise<KinDetail> => {
    const result = await api.patch<{ kin: KinDetail }>(`/kins/${id}`, data)
    // Update local state immediately (SSE also propagates for other clients)
    setKins((prev) =>
      prev.map((k) =>
        k.id === id
          ? {
              ...k,
              ...(data.slug !== undefined && { slug: data.slug }),
              ...(data.name !== undefined && { name: data.name }),
              ...(data.role !== undefined && { role: data.role }),
              ...(data.model !== undefined && { model: data.model }),
              ...(data.providerId !== undefined && { providerId: data.providerId }),
              avatarUrl: result.kin.avatarUrl,
            }
          : k,
      ),
    )
    // If the model or provider changed, the cached contextWindow is stale —
    // wipe it so the next fetchContextUsage() repopulates with fresh data
    // from the server (which recomputes contextWindow from the new model).
    if (data.model !== undefined || data.providerId !== undefined) {
      setKinQueueState((prev) => {
        const existing = prev.get(id)
        if (!existing) return prev
        const next = new Map(prev)
        next.set(id, { ...existing, contextWindow: undefined, contextTokens: undefined })
        return next
      })
      // Refetch immediately so the UI doesn't show "— / —" momentarily.
      void fetchContextUsage(id)
    }
    return result.kin
  }, [fetchContextUsage])

  const deleteKin = useCallback(async (id: string): Promise<void> => {
    await api.delete(`/kins/${id}`)
    setKinOrder((prev) => prev.filter((kinId) => kinId !== id))
    await fetchKins()
  }, [fetchKins])

  const uploadAvatar = useCallback(async (id: string, file: File): Promise<string> => {
    const formData = new FormData()
    formData.append('file', file)
    const response = await fetch(`/api/kins/${id}/avatar`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })
    const data = await response.json() as { avatarUrl: string }
    // Update local state immediately (SSE also propagates for other clients)
    setKins((prev) =>
      prev.map((k) =>
        k.id === id ? { ...k, avatarUrl: data.avatarUrl } : k,
      ),
    )
    return data.avatarUrl
  }, [])

  const generateAvatarPreview = useCallback(async (
    id: string,
    mode: 'auto' | 'prompt',
    prompt?: string,
    imageModel?: { providerId: string; modelId: string },
  ): Promise<string> => {
    const data = await api.post<{ base64: string; mediaType: string }>(`/kins/${id}/avatar/generate`, {
      mode,
      ...(prompt && { prompt }),
      ...(imageModel && { imageProviderId: imageModel.providerId, imageModel: imageModel.modelId }),
    })
    return `data:${data.mediaType};base64,${data.base64}`
  }, [])

  const generateKinConfig = useCallback(async (data: {
    description?: string
    refinement?: string
    currentConfig?: Record<string, unknown>
    language?: string
  }): Promise<GeneratedKinConfig> => {
    const result = await api.post<{ config: GeneratedKinConfig }>('/kins/generate-config', data)
    return result.config
  }, [])

  const generateAvatarPreviewFromConfig = useCallback(async (data: {
    name: string
    role: string
    character: string
    expertise: string
  }): Promise<string> => {
    const result = await api.post<{ base64: string; mediaType: string }>('/kins/avatar/preview', data)
    return `data:${result.mediaType};base64,${result.base64}`
  }, [])

  return {
    kins: sortedKins,
    llmModels,
    imageModels,
    isLoading,
    kinQueueState,
    fetchContextUsage,
    getKin,
    createKin,
    updateKin,
    deleteKin,
    uploadAvatar,
    generateAvatarPreview,
    generateKinConfig,
    generateAvatarPreviewFromConfig,
    hasImageCapability,
    reorderKins,
    refetch: fetchKins,
    refetchModels: fetchModels,
  }
}
