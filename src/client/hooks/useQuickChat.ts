import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { useChatStreaming } from '@/client/hooks/useChatStreaming'
import type { ChatMessage } from '@/client/hooks/useChat'
import type { MessageFile } from '@/shared/types'

export function useQuickChat(sessionId: string | null, kinId: string | null) {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)

  const {
    streamingMessage, isStreaming,
    handleToken, handleDone, resetStreaming, cleanup,
  } = useChatStreaming()

  // Fetch messages for this session
  const fetchMessages = useCallback(async () => {
    if (!sessionId) {
      setMessages([])
      return
    }
    setIsLoading(true)
    try {
      const data = await api.get<{ session: any; messages: ChatMessage[] }>(
        `/quick-sessions/${sessionId}`,
      )
      setMessages(data.messages)
    } catch {
      toast.error(t('quickSession.errors.fetchMessagesFailed', 'Failed to load messages'))
    } finally {
      setIsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    fetchMessages()
    resetStreaming()
  }, [fetchMessages])

  // SSE handlers — filtered by sessionId
  useSSE({
    'chat:token': (data) => {
      if (data.kinId !== kinId) return
      if (data.sessionId !== sessionId) return

      setIsProcessing(false)
      handleToken({
        messageId: data.messageId as string,
        token: data.token as string,
      })
    },

    'chat:done': (data) => {
      if (data.kinId !== kinId) return
      if (data.sessionId !== sessionId) return

      const promoted = handleDone({
        tokenUsage: (data.tokenUsage as ChatMessage['tokenUsage']) ?? undefined,
      })

      if (promoted) {
        setMessages((prev) => [...prev, promoted])
      }

      setIsProcessing(false)

      // Refresh to get tool calls, metadata, etc.
      fetchMessages()
    },

    'chat:message': (data) => {
      if (data.kinId !== kinId) return
      if (data.sessionId !== sessionId) return

      const message: ChatMessage = {
        id: data.id as string,
        role: data.role as ChatMessage['role'],
        content: data.content as string,
        sourceType: data.sourceType as string,
        sourceId: (data.sourceId as string) ?? null,
        sourceName: null,
        sourceAvatarUrl: null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId: null,
        injectedMemories: null,
        memoriesExtracted: null,
        compactingError: null,
        files: [],
          reactions: [],
          stepLimitReached: false,
        tokenUsage: null,
        reasoning: null,
        channelContextLine: null,
        channelMeta: null,
        systemEvent: null,
        createdAt: new Date(data.createdAt as number).toISOString(),
      }
      setMessages((prev) => [...prev, message])
    },
  })

  // Send a message
  const sendMessage = useCallback(
    async (content: string, fileIds?: string[], optimisticFiles?: MessageFile[]) => {
      const hasFiles = fileIds && fileIds.length > 0
      if (!sessionId || (!content.trim() && !hasFiles)) return

      // Optimistic update
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
      setIsProcessing(true)

      try {
        await api.post(`/quick-sessions/${sessionId}/messages`, {
          content,
          fileIds,
        })
      } catch (err: unknown) {
        setMessages((prev) => prev.filter((m) => m.id !== tempId))
        setIsProcessing(false)
        const apiErr = err as { code?: string; status?: number } | undefined
        if (apiErr?.code === 'SESSION_EXPIRED' || apiErr?.status === 409) {
          toast.error(t('quickSession.errors.sessionExpired', 'Session expired. Please start a new one.'))
        } else {
          toast.error(t('quickSession.errors.sendFailed', 'Failed to send message'))
        }
      }
    },
    [sessionId],
  )

  // Stop streaming
  const stopStreaming = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.post(`/quick-sessions/${sessionId}/messages/stop`, {})
    } catch {
      toast.error(t('quickSession.errors.stopFailed', 'Failed to stop generation'))
    }
  }, [sessionId])

  // Cleanup timers on unmount
  useEffect(() => cleanup, [])

  return {
    messages,
    streamingMessage,
    isLoading,
    isProcessing,
    isStreaming,
    sendMessage,
    stopStreaming,
    refetch: fetchMessages,
  }
}
