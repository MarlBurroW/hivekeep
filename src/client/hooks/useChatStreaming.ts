import { useState, useRef, useCallback } from 'react'
import type { ChatMessage } from '@/client/hooks/useChat'

const STREAMING_BATCH_MS = 50
/** After this many ms without a text token, consider the output "stalled" (e.g. tool call being generated) */
const TOKEN_STALL_MS = 1500

export interface StreamingTokenData {
  messageId: string
  token: string
  sourceName?: string | null
  sourceAvatarUrl?: string | null
}

export interface StreamingReasoningTokenData {
  messageId: string
  token: string
}

export interface StreamingDoneData {
  content?: string | null
  sourceType?: string | null
  sourceId?: string | null
  sourceName?: string | null
  sourceAvatarUrl?: string | null
  stepLimitReached?: boolean
  tokenUsage?: ChatMessage['tokenUsage']
}

interface UseChatStreamingOptions {
  /** Track token stalls — useful in main chat to show tool-call indicator. Default: false */
  trackTokenStall?: boolean
}

/**
 * Shared streaming logic for chat hooks.
 *
 * Manages the streaming message lifecycle: token accumulation with batched UI
 * updates, stall detection (optional), and promotion of the streaming message
 * into a finalized ChatMessage on completion.
 */
export function useChatStreaming(options?: UseChatStreamingOptions) {
  const trackTokenStall = options?.trackTokenStall ?? false

  const [streamingMessage, setStreamingMessage] = useState<ChatMessage | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [tokenStalled, setTokenStalled] = useState(false)
  const [streamingReasoning, setStreamingReasoning] = useState('')

  const streamingContentRef = useRef('')
  const streamingMessageIdRef = useRef<string | null>(null)
  const streamingReasoningRef = useRef('')
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reasoningBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tokenStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Handle an incoming text token from SSE.
   * Call this from the `chat:token` SSE handler after your own filtering.
   */
  const handleToken = useCallback((data: StreamingTokenData) => {
    const { messageId, token, sourceName, sourceAvatarUrl } = data

    // Reset token stall timer
    if (trackTokenStall) {
      setTokenStalled(false)
      if (tokenStallTimerRef.current) clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = setTimeout(() => setTokenStalled(true), TOKEN_STALL_MS)
    }

    if (!streamingMessageIdRef.current) {
      // First token — create the streaming message
      streamingMessageIdRef.current = messageId
      streamingContentRef.current = token
      setIsStreaming(true)

      setStreamingMessage({
        id: messageId,
        role: 'assistant',
        content: token,
        sourceType: 'kin',
        sourceId: null,
        sourceName: sourceName ?? null,
        sourceAvatarUrl: sourceAvatarUrl ?? null,
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
        createdAt: new Date().toISOString(),
      })
    } else {
      // Accumulate token, batch UI updates
      streamingContentRef.current += token

      if (!batchTimerRef.current) {
        batchTimerRef.current = setTimeout(() => {
          batchTimerRef.current = null
          setStreamingMessage((prev) =>
            prev ? { ...prev, content: streamingContentRef.current } : prev,
          )
        }, STREAMING_BATCH_MS)
      }
    }
  }, [trackTokenStall])

  /**
   * Handle an incoming reasoning/thinking token from SSE.
   */
  const handleReasoningToken = useCallback((data: StreamingReasoningTokenData) => {
    const { messageId } = data

    // If we haven't started streaming yet, initialize the streaming message
    // (reasoning can arrive before the first text token)
    if (!streamingMessageIdRef.current) {
      streamingMessageIdRef.current = messageId
      setIsStreaming(true)
      setStreamingMessage({
        id: messageId,
        role: 'assistant',
        content: '',
        sourceType: 'kin',
        sourceId: null,
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
        createdAt: new Date().toISOString(),
      })
    }

    // Reset token stall timer (reasoning tokens also indicate activity)
    if (trackTokenStall) {
      setTokenStalled(false)
      if (tokenStallTimerRef.current) clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = setTimeout(() => setTokenStalled(true), TOKEN_STALL_MS)
    }

    streamingReasoningRef.current += data.token

    if (!reasoningBatchTimerRef.current) {
      reasoningBatchTimerRef.current = setTimeout(() => {
        reasoningBatchTimerRef.current = null
        setStreamingReasoning(streamingReasoningRef.current)
      }, STREAMING_BATCH_MS)
    }
  }, [trackTokenStall])

  /**
   * Handle a `chat:done` SSE event.
   * Flushes pending timers, builds the promoted ChatMessage (or null if no
   * streaming was active), and resets internal state.
   *
   * The caller is responsible for appending the returned message to its
   * messages array and triggering any post-done actions (e.g. fetchMessages).
   */
  const handleDone = useCallback((data?: StreamingDoneData): ChatMessage | null => {
    // Flush pending timers
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current)
      batchTimerRef.current = null
    }
    if (reasoningBatchTimerRef.current) {
      clearTimeout(reasoningBatchTimerRef.current)
      reasoningBatchTimerRef.current = null
    }
    if (tokenStallTimerRef.current) {
      clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = null
    }

    let promoted: ChatMessage | null = null

    if (streamingMessageIdRef.current) {
      promoted = {
        id: streamingMessageIdRef.current,
        role: 'assistant' as const,
        content: (data?.content as string) ?? streamingContentRef.current,
        sourceType: (data?.sourceType as string) ?? 'kin',
        sourceId: (data?.sourceId as string) ?? null,
        sourceName: (data?.sourceName as string) ?? null,
        sourceAvatarUrl: (data?.sourceAvatarUrl as string) ?? null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId: null,
        injectedMemories: null,
        memoriesExtracted: null,
        compactingError: null,
        files: [],
        reactions: [],
        stepLimitReached: (data?.stepLimitReached as boolean) ?? false,
        tokenUsage: data?.tokenUsage ?? null,
        reasoning: streamingReasoningRef.current ? [{ offset: 0, text: streamingReasoningRef.current }] : null,
        channelContextLine: null,
        channelMeta: null,
        systemEvent: null,
        createdAt: new Date().toISOString(),
      }
    }

    setIsStreaming(false)
    setStreamingMessage(null)
    setTokenStalled(false)
    setStreamingReasoning('')
    streamingContentRef.current = ''
    streamingReasoningRef.current = ''
    streamingMessageIdRef.current = null

    return promoted
  }, [])

  /**
   * Reset all streaming state. Call when the context changes (e.g. kinId switch).
   */
  const resetStreaming = useCallback(() => {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current)
      batchTimerRef.current = null
    }
    if (reasoningBatchTimerRef.current) {
      clearTimeout(reasoningBatchTimerRef.current)
      reasoningBatchTimerRef.current = null
    }
    if (tokenStallTimerRef.current) {
      clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = null
    }
    setIsStreaming(false)
    setStreamingMessage(null)
    setTokenStalled(false)
    setStreamingReasoning('')
    streamingContentRef.current = ''
    streamingReasoningRef.current = ''
    streamingMessageIdRef.current = null
  }, [])

  /**
   * Cleanup function — call in a useEffect return to clear timers on unmount.
   */
  const cleanup = useCallback(() => {
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current)
    if (reasoningBatchTimerRef.current) clearTimeout(reasoningBatchTimerRef.current)
    if (tokenStallTimerRef.current) clearTimeout(tokenStallTimerRef.current)
  }, [])

  return {
    streamingMessage,
    isStreaming,
    tokenStalled,
    streamingReasoning,
    handleToken,
    handleReasoningToken,
    handleDone,
    resetStreaming,
    cleanup,
  }
}
