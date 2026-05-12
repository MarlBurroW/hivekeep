import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { useChatStreaming } from '@/client/hooks/useChatStreaming'
import type { ToolCallEntry, TaskStatus, MessageFile, MessageTokenUsage } from '@/shared/types'
import type { PluginCard } from '@/shared/types/plugin-cards'

export interface MessageReaction {
  id: string
  userId: string
  emoji: string
  createdAt: string
}

export interface ChannelMeta {
  platform: string
  displayName: string
  brandColor: string | null
}

/**
 * Structured payload attached to system messages whose metadata.systemEvent
 * is set. The server resolves the OTHER Kin's name/slug/avatar and the
 * channel's current platform meta so the UI can render the dedicated
 * transfer cards without an extra round trip. Pre-existing system messages
 * (sourceType==='system' with no systemEvent discriminator) keep
 * systemEvent === null and fall through to the generic centered banner.
 */
export interface ChannelTransferSystemEvent {
  type: 'channel_transferred_out' | 'channel_transferred_in'
  channelId: string | null
  channelName: string | null
  channelPlatform: string | null
  channelBrandColor: string | null
  otherKin: {
    id: string | null
    slug: string | null
    name: string
    avatarUrl: string | null
  }
  reason: string | null
  at: number | null
}

/** Plugin-emitted card surfaced inline in the conversation. The full layout
 *  + state blob is carried in the systemEvent so the renderer never needs to
 *  refetch the message just to know what to draw. */
export interface PluginCardSystemEvent {
  type: 'plugin-card'
  pluginCard: PluginCard
}

export type SystemEvent = ChannelTransferSystemEvent | PluginCardSystemEvent

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sourceType: string
  sourceId: string | null
  sourceName: string | null
  sourceAvatarUrl: string | null
  isRedacted: boolean
  toolCalls: ToolCallEntry[] | null
  resolvedTaskId: string | null
  injectedMemories: Array<{ id: string; category: string; content: string; subject: string | null }> | null
  memoriesExtracted: number | null
  compactingError: string | null
  stepLimitReached: boolean
  tokenUsage: MessageTokenUsage | null
  reasoning: Array<{ offset: number; text: string }> | null
  files: MessageFile[]
  reactions: MessageReaction[]
  /** Adapter-provided, already-localized context for channel messages
   *  (e.g. "Sent on TeamSpeak via TTS with voice Kartal"). */
  channelContextLine: string | null
  /** Platform identity for channel messages (used to render brand accent). */
  channelMeta: ChannelMeta | null
  /** Structured event payload for sourceType='system' rows. Covers
   *  channel-transfer audit rows and plugin-emitted cards. */
  systemEvent: SystemEvent | null
  createdAt: string
}

/** A task card rendered live in the parent conversation while the task is active */
export interface LiveTask {
  taskId: string
  status: TaskStatus
  title: string
  senderName: string | null
  senderAvatarUrl: string | null
  result: string | null
  error: string | null
  createdAt: string
}

/** Live compacting card rendered in the conversation while compacting is active */
export interface LiveCompacting {
  kinId: string
  status: 'running' | 'done' | 'error'
  summary: string | null
  memoriesExtracted: number | null
  /** How many source messages were folded into the summary (set on done). */
  messageCount?: number
  startedAt: string
  cycle?: number
  estimatedTotal?: number
  error?: string
}

interface MessagesResponse {
  messages: ChatMessage[]
  hasMore: boolean
}

export function useChat(kinId: string | null) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [liveTasks, setLiveTasks] = useState<LiveTask[]>([])
  const [liveCompacting, setLiveCompacting] = useState<LiveCompacting | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  const {
    streamingMessage, isStreaming, tokenStalled, streamingReasoning,
    handleToken, handleReasoningToken, handleDone, resetStreaming, cleanup,
  } = useChatStreaming({ trackTokenStall: true })

  // Map task title → taskId, populated from SSE events so we can enrich
  // persisted messages that may lack resolvedTaskId in their server metadata.
  const taskIdByTitleRef = useRef(new Map<string, string>())

  // Ref to track messages for pagination without causing dependency churn
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // Fetch message history
  const fetchMessages = useCallback(async () => {
    if (!kinId) {
      setMessages([])
      return
    }

    setIsLoading(true)
    try {
      const data = await api.get<MessagesResponse>(`/kins/${kinId}/messages`)

      // Enrich task result messages that are missing resolvedTaskId.
      // The ref is populated from task:status SSE events and covers cases where
      // the server metadata wasn't set (e.g. tasks created before the metadata code).
      for (const msg of data.messages) {
        if (msg.sourceType === 'task' && !msg.resolvedTaskId) {
          for (const [title, taskId] of taskIdByTitleRef.current) {
            if (msg.content.includes(title)) {
              msg.resolvedTaskId = taskId
              break
            }
          }
        }
      }

      // Smart merge: preserve object references for messages that haven't changed.
      // This prevents unnecessary re-renders of MessageBubble components (which are
      // memo'd and compare props by reference).
      setMessages((prev) => {
        if (prev.length === 0) return data.messages
        const prevById = new Map(prev.map((m) => [m.id, m]))
        return data.messages.map((m) => {
          const existing = prevById.get(m.id)
          if (!existing) return m
          // Keep old reference if content and key metadata are unchanged
          if (
            existing.content === m.content &&
            existing.memoriesExtracted === m.memoriesExtracted &&
            existing.isRedacted === m.isRedacted &&
            (existing.toolCalls?.length ?? 0) === (m.toolCalls?.length ?? 0) &&
            existing.reactions.length === m.reactions.length
          ) {
            return existing
          }
          return m
        })
      })
      setHasMore(data.hasMore)

      // Remove live tasks whose result already appears as a persisted message.
      // Only match by resolvedTaskId (precise) and never remove tasks still active.
      const resolvedTaskIds = new Set(
        data.messages
          .filter((m) => m.sourceType === 'task' && m.resolvedTaskId)
          .map((m) => m.resolvedTaskId!),
      )
      if (resolvedTaskIds.size > 0) {
        setLiveTasks((prev) =>
          prev.filter((t) => !resolvedTaskIds.has(t.taskId)),
        )
      }
    } catch {
      toast.error(t('errors.loadMessagesFailed'))
    } finally {
      setIsLoading(false)
    }
  }, [kinId])

  // Fetch active tasks for this kin to restore live task cards after navigation
  const fetchActiveTasks = useCallback(async () => {
    if (!kinId) return
    try {
      const activeStatuses: TaskStatus[] = ['in_progress', 'pending', 'awaiting_human_input', 'awaiting_kin_response']
      const results = await Promise.all(
        activeStatuses.map((s) =>
          api.get<{ tasks: Array<{ id: string; status: TaskStatus; title: string; description: string; sourceKinName: string | null; sourceKinAvatarUrl: string | null; createdAt: string; parentKinName: string; parentKinAvatarUrl: string | null }> }>(
            `/tasks?kinId=${kinId}&status=${s}&limit=20`,
          ),
        ),
      )
      const activeTasks = results.flatMap((r) => r.tasks)
      if (activeTasks.length > 0) {
        setLiveTasks((prev) => {
          const existingIds = new Set(prev.map((t) => t.taskId))
          const newTasks: LiveTask[] = activeTasks
            .filter((t) => !existingIds.has(t.id))
            .map((t) => ({
              taskId: t.id,
              status: t.status,
              title: t.title ?? t.description,
              senderName: t.sourceKinName ?? t.parentKinName,
              senderAvatarUrl: t.sourceKinAvatarUrl ?? t.parentKinAvatarUrl,
              result: null,
              error: null,
              createdAt: t.createdAt,
            }))
          return newTasks.length > 0 ? [...prev, ...newTasks] : prev
        })
      }
    } catch {
      // Silently fail — tasks list is non-critical
    }
  }, [kinId])

  useEffect(() => {
    fetchMessages()
    resetStreaming()
    setLiveTasks([])
    setLiveCompacting(null)
    setHasMore(false)
    setIsLoadingMore(false)
    taskIdByTitleRef.current.clear()
    // Restore live task cards for active tasks after clearing
    fetchActiveTasks()
    // Restore compacting state if a compaction is in progress
    api.get<{ isCompacting?: boolean }>(`/kins/${kinId}`).then((kin) => {
      if (kin.isCompacting) {
        setLiveCompacting({
          kinId: kinId!,
          status: 'running',
          summary: null,
          memoriesExtracted: null,
          startedAt: new Date().toISOString(),
        })
      }
    }).catch(() => {})
  }, [fetchMessages, fetchActiveTasks])

  // Fetch older messages (pagination — prepend to existing)
  // Uses messagesRef to avoid recreating this callback on every message change,
  // which would cause the IntersectionObserver in ChatPanel to reconnect and
  // potentially trigger an infinite fetch loop.
  const fetchOlderMessages = useCallback(async () => {
    if (!kinId || !hasMore || isLoadingMore) return
    const firstMsg = messagesRef.current[0]
    if (!firstMsg) return

    setIsLoadingMore(true)
    try {
      const data = await api.get<MessagesResponse>(
        `/kins/${kinId}/messages?before=${firstMsg.id}&limit=50`,
      )

      // Enrich task result messages
      for (const msg of data.messages) {
        if (msg.sourceType === 'task' && !msg.resolvedTaskId) {
          for (const [title, taskId] of taskIdByTitleRef.current) {
            if (msg.content.includes(title)) {
              msg.resolvedTaskId = taskId
              break
            }
          }
        }
      }

      setMessages((prev) => [...data.messages, ...prev])
      setHasMore(data.hasMore)
    } catch {
      toast.error(t('errors.loadMessagesFailed'))
    } finally {
      setIsLoadingMore(false)
    }
  }, [kinId, hasMore, isLoadingMore])

  // SSE handlers
  useSSE({
    'chat:token': (data) => {
      if (data.kinId !== kinId) return
      if (data.taskId) return // Ignore tokens from sub-Kin tasks
      if (data.sessionId) return // Ignore tokens from quick sessions

      handleToken({
        messageId: data.messageId as string,
        token: data.token as string,
        sourceName: (data.sourceName as string) ?? null,
        sourceAvatarUrl: (data.sourceAvatarUrl as string) ?? null,
      })
    },

    'chat:reasoning-token': (data) => {
      if (data.kinId !== kinId) return
      if (data.taskId) return
      if (data.sessionId) return

      handleReasoningToken({
        messageId: data.messageId as string,
        token: data.token as string,
      })
    },

    'chat:done': (data) => {
      if (data.kinId !== kinId) return
      if (data.taskId) return // Ignore done events from sub-Kin tasks
      if (data.sessionId) return // Ignore done events from quick sessions

      // Promote the streaming message into the messages array before clearing
      // it. This keeps the same React key in the children list so React
      // reconciles in-place instead of re-mounting (which would replay the
      // entrance animation).
      const promoted = handleDone({
        content: (data.content as string) ?? undefined,
        sourceType: (data.sourceType as string) ?? undefined,
        sourceId: (data.sourceId as string) ?? undefined,
        sourceName: (data.sourceName as string) ?? undefined,
        sourceAvatarUrl: (data.sourceAvatarUrl as string) ?? undefined,
        stepLimitReached: (data.stepLimitReached as boolean) ?? undefined,
        tokenUsage: (data.tokenUsage as ChatMessage['tokenUsage']) ?? undefined,
      })

      if (promoted) {
        setMessages((prev) => [...prev, promoted])
      }

      // Refresh to get the final message from DB (with tool calls, memoriesExtracted, etc.)
      // Use a smart merge to preserve object references for unchanged messages,
      // avoiding unnecessary re-renders of the entire message list.
      fetchMessages()
    },

    'chat:message': (data) => {
      if (data.kinId !== kinId) return
      if (data.taskId) return // Ignore messages from sub-Kin tasks
      if (data.sessionId) return // Ignore messages from quick sessions

      // Resolve taskId: prefer SSE data, fallback to title-based ref lookup
      let resolvedTaskId = (data.resolvedTaskId as string) ?? null
      if (!resolvedTaskId && data.sourceType === 'task') {
        const content = data.content as string
        for (const [title, taskId] of taskIdByTitleRef.current) {
          if (content.includes(title)) {
            resolvedTaskId = taskId
            break
          }
        }
      }

      const message: ChatMessage = {
        id: data.id as string,
        role: data.role as ChatMessage['role'],
        content: data.content as string,
        sourceType: data.sourceType as string,
        sourceId: (data.sourceId as string) ?? null,
        sourceName: (data.sourceName as string) ?? null,
        sourceAvatarUrl: (data.sourceAvatarUrl as string) ?? null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId,
        injectedMemories: null,
        memoriesExtracted: null,
        compactingError: null,
        files: [],
        reactions: [],
          stepLimitReached: false,
        tokenUsage: null,
        reasoning: null,
        channelContextLine: (data.channelContextLine as string) ?? null,
        channelMeta: (data.channelMeta as ChatMessage['channelMeta']) ?? null,
        systemEvent: (data.systemEvent as ChatMessage['systemEvent']) ?? null,
        createdAt: new Date(data.createdAt as number).toISOString(),
      }
      setMessages((prev) => [...prev, message])

      // If this is a task result message, remove the corresponding live task (by precise ID only)
      if (data.sourceType === 'task' && data.resolvedTaskId) {
        const resolvedId = data.resolvedTaskId as string
        setLiveTasks((prev) => prev.filter((t) => t.taskId !== resolvedId))
      }
    },

    'task:status': (data) => {
      if (data.kinId !== kinId) return
      const taskId = data.taskId as string
      const status = data.status as TaskStatus
      const title = (data.title as string) ?? ''

      // Track title → taskId so we can enrich persisted messages later
      if (title) taskIdByTitleRef.current.set(title, taskId)

      setLiveTasks((prev) => {
        const existing = prev.find((t) => t.taskId === taskId)
        if (existing) {
          return prev.map((t) =>
            t.taskId === taskId ? { ...t, status } : t,
          )
        }
        // New task — add to live tasks
        return [
          ...prev,
          {
            taskId,
            status,
            title: (data.title as string) ?? '',
            senderName: (data.senderName as string) ?? null,
            senderAvatarUrl: (data.senderAvatarUrl as string) ?? null,
            result: null,
            error: null,
            createdAt: new Date().toISOString(),
          },
        ]
      })
    },

    'task:done': (data) => {
      if (data.kinId !== kinId) return
      const taskId = data.taskId as string
      const title = (data.title as string) ?? ''

      // Track title → taskId for message enrichment
      if (title) taskIdByTitleRef.current.set(title, taskId)

      // Eagerly remove the live task card to avoid a double-flash when the
      // persisted message arrives from fetchMessages shortly after.
      setLiveTasks((prev) => prev.filter((t) => t.taskId !== taskId))

      // Refresh messages after a short delay to pick up the task result message
      // (for await mode it may take longer; fetchMessages on chat:done handles that)
      setTimeout(() => fetchMessages(), 1000)
    },

    'compacting:start': (data) => {
      if (data.kinId !== kinId) return
      setLiveCompacting({
        kinId: data.kinId as string,
        status: 'running',
        summary: null,
        memoriesExtracted: null,
        startedAt: new Date().toISOString(),
        cycle: data.cycle as number | undefined,
        estimatedTotal: data.estimatedTotal as number | undefined,
      })
    },

    'compacting:done': (data) => {
      if (data.kinId !== kinId) return
      setLiveCompacting((prev) => {
        if (!prev) return null
        const updated = {
          ...prev,
          status: 'done' as const,
          summary: data.summary as string,
          memoriesExtracted: data.memoriesExtracted as number,
          messageCount: (data.messageCount as number | undefined) ?? prev.messageCount,
        }
        // During catch-up, more cycles may follow — don't clear yet
        if (prev.cycle && prev.estimatedTotal && prev.cycle < prev.estimatedTotal) {
          return updated
        }
        // Last cycle or single cycle — refresh and clear
        fetchMessages().then(() => setLiveCompacting(null))
        return updated
      })
    },

    'compacting:error': (data) => {
      if (data.kinId !== kinId) return
      const rawError = data.error as string
      const errorMessage = rawError === 'NOTHING_TO_COMPACT'
        ? t('chat.compacting.nothingToCompact')
        : rawError
      setLiveCompacting((prev) =>
        prev
          ? { ...prev, status: 'error', error: errorMessage }
          : null,
      )
      toast.error(errorMessage)
      // Auto-clear error card after 10 seconds
      setTimeout(() => setLiveCompacting(null), 10_000)
    },

    'chat:cleared': (data) => {
      if (data.kinId !== kinId) return
      setMessages([])
      resetStreaming()
    },

    'channel:transferred': (data) => {
      // A channel was re-bound. If the current Kin is either side of the
      // transfer (source or target), refetch the conversation so the new
      // audit-trail row appears inline immediately. Skip when the current
      // Kin is unrelated to avoid pointless work.
      if (!kinId) return
      if (data.fromKinId === kinId || data.toKinId === kinId) {
        fetchMessages()
      }
    },

    'channel:message-sent': (data) => {
      if (data.kinId !== kinId) return
      // The kin response has just been delivered to the external platform; the
      // adapter may have produced a `contextLine` describing how (TTS/text,
      // voice, target channel). Merge it into the existing message so the UI
      // shows the hint without waiting for the next history fetch.
      const messageId = data.messageId as string | undefined
      const contextLine = (data.contextLine as string | null | undefined) ?? null
      const platform = (data.platform as string | undefined) ?? null
      if (!messageId) return
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m
          const nextMeta: ChannelMeta | null =
            m.channelMeta ?? (platform ? { platform, displayName: platform, brandColor: null } : null)
          return {
            ...m,
            channelContextLine: contextLine ?? m.channelContextLine,
            channelMeta: nextMeta,
          }
        }),
      )
    },

    'reaction:added': (data) => {
      if (data.kinId !== kinId) return
      const { messageId, userId, userName, emoji, reactionId } = data as {
        messageId: string; userId: string; userName: string; emoji: string; reactionId: string
      }
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m
          // Avoid duplicates
          if (m.reactions.some((r) => r.id === reactionId)) return m
          return {
            ...m,
            reactions: [...m.reactions, { id: reactionId, userId, emoji, createdAt: new Date().toISOString() }],
          }
        }),
      )
    },

    'reaction:removed': (data) => {
      if (data.kinId !== kinId) return
      const { messageId, reactionId } = data as { messageId: string; reactionId: string }
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m
          return { ...m, reactions: m.reactions.filter((r) => r.id !== reactionId) }
        }),
      )
    },
  })

  // Send a message. Returns true on success, false on failure.
  const sendMessage = useCallback(
    async (content: string, fileIds?: string[], optimisticFiles?: MessageFile[]): Promise<boolean> => {
      const hasFiles = fileIds && fileIds.length > 0
      if (!kinId || (!content.trim() && !hasFiles)) return false

      // Optimistic update — add user message immediately (with file previews)
      const tempId = `temp-${Date.now()}`
      const userMessage: ChatMessage = {
        id: tempId,
        role: 'user',
        content,
        sourceType: 'user',
        sourceId: null,
        sourceName: null,
        sourceAvatarUrl: null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId: null,
        injectedMemories: null,
        memoriesExtracted: null,
        compactingError: null,
        files: optimisticFiles ?? [],
        reactions: [],
          stepLimitReached: false,
        tokenUsage: null,
        reasoning: null,
        channelContextLine: null,
        channelMeta: null,
        systemEvent: null,
        createdAt: new Date().toISOString(),
      }

      setMessages((prev) => [...prev, userMessage])

      try {
        await api.post(`/kins/${kinId}/messages`, { content, fileIds })
        return true
      } catch {
        // Remove optimistic message on error
        setMessages((prev) => prev.filter((m) => m.id !== tempId))
        return false
      }
    },
    [kinId],
  )

  // Stop an active LLM generation
  const stopStreaming = useCallback(async () => {
    if (!kinId) return
    try {
      await api.post(`/kins/${kinId}/messages/stop`, {})
    } catch {
      // Ignore — the server will emit chat:done regardless
    }
  }, [kinId])

  // Cleanup timers on unmount
  useEffect(() => cleanup, [])

  const clearConversation = useCallback(async () => {
    if (!kinId) return
    try {
      await api.delete(`/kins/${kinId}/messages`)
      setMessages([])
      toast.success(t('chat.clear.success'))
    } catch {
      toast.error(t('chat.clear.error'))
    }
  }, [kinId, t])

  return {
    messages,
    streamingMessage,
    streamingReasoning,
    liveTasks,
    liveCompacting,
    isLoading,
    isStreaming,
    hasMore,
    isLoadingMore,
    tokenStalled,
    sendMessage,
    stopStreaming,
    clearConversation,
    fetchOlderMessages,
    refetch: fetchMessages,
  }
}
