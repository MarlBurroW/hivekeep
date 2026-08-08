import { useState, useRef, useCallback } from 'react'
import { createSmoothReveal, type SmoothReveal } from '@/client/lib/smooth-stream'
import type { ChatMessage } from '@/client/hooks/useChat'

/** After this many ms without a text token, consider the output "stalled" (e.g. tool call being generated) */
const TOKEN_STALL_MS = 1500

export interface StreamingTokenData {
  messageId: string
  token: string
  /** Total content length (committed + provisional) AFTER this token, as
   *  computed by the server. Used to skip tokens already covered by a
   *  rehydration snapshot. Absent on some synthetic fallback events. */
  contentLength?: number
  sourceName?: string | null
  sourceAvatarUrl?: string | null
}

export interface StreamingTokenRetractData {
  messageId: string
  /** Committed length to truncate the streaming content back to. */
  contentLength: number
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
  emptyTurn?: boolean
  finishReason?: string | null
  silentStop?: boolean
  tokenUsage?: ChatMessage['tokenUsage']
}

/**
 * Server-side snapshot of an in-flight assistant message, used to rehydrate
 * the streaming bubble when a client mounts mid-stream (e.g. navigated away
 * and back, or full page reload while the model was still emitting tokens).
 */
export interface StreamingSnapshot {
  messageId: string
  content: string
  reasoning?: Array<{ offset: number; text: string }> | null
  /** Running output-token total reported by the server for this in-flight turn */
  outputTokens?: number | null
  sourceName?: string | null
  sourceAvatarUrl?: string | null
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
  // Running output-token total for the current turn, fed by `chat:token-usage`
  // SSE events (one per completed step) — drives the live counter in the
  // thinking bubble.
  const [streamingOutputTokens, setStreamingOutputTokens] = useState(0)

  const streamingContentRef = useRef('')
  const streamingMessageIdRef = useRef<string | null>(null)
  const streamingReasoningRef = useRef('')
  const tokenStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Adaptive typewriter (see smooth-stream.ts): refs hold the full received
  // text; the reveals advance a cursor into them so coarse provider chunks
  // render as a continuous flow instead of visible jumps.
  const contentRevealRef = useRef<SmoothReveal | null>(null)
  if (!contentRevealRef.current) {
    contentRevealRef.current = createSmoothReveal((len) => {
      setStreamingMessage((prev) =>
        prev ? { ...prev, content: streamingContentRef.current.slice(0, len) } : prev,
      )
    })
  }
  const reasoningRevealRef = useRef<SmoothReveal | null>(null)
  if (!reasoningRevealRef.current) {
    reasoningRevealRef.current = createSmoothReveal((len) => {
      setStreamingReasoning(streamingReasoningRef.current.slice(0, len))
    })
  }

  /**
   * Handle an incoming text token from SSE.
   * Call this from the `chat:token` SSE handler after your own filtering.
   */
  const handleToken = useCallback((data: StreamingTokenData) => {
    const { messageId, token, contentLength, sourceName, sourceAvatarUrl } = data

    // Reset token stall timer
    if (trackTokenStall) {
      setTokenStalled(false)
      if (tokenStallTimerRef.current) clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = setTimeout(() => setTokenStalled(true), TOKEN_STALL_MS)
    }

    if (!streamingMessageIdRef.current || streamingMessageIdRef.current !== messageId) {
      // First token of a stream, or a NEW messageId while an old one was
      // still tracked (chat:done was missed, e.g. during a reconnect gap):
      // start fresh instead of appending a new turn onto a stale bubble.
      if (streamingMessageIdRef.current && streamingMessageIdRef.current !== messageId) {
        streamingReasoningRef.current = ''
        setStreamingReasoning('')
        setStreamingOutputTokens(0)
        reasoningRevealRef.current!.reset()
      }
      contentRevealRef.current!.reset()
      streamingMessageIdRef.current = messageId
      streamingContentRef.current = token
      setIsStreaming(true)

      // The bubble starts empty; the reveal cursor types the text in.
      setStreamingMessage({
        id: messageId,
        role: 'assistant',
        content: '',
        sourceType: 'agent',
        sourceId: null,
        sourceName: sourceName ?? null,
        sourceAvatarUrl: sourceAvatarUrl ?? null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId: null,
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
      // Skip tokens the local content already covers: the server tags each
      // token with the total length AFTER appending, and the rehydration
      // snapshot is always at a token boundary, so this comparison is exact.
      // Guards the race where a mid-stream mount seeds the snapshot AND the
      // same tokens arrive live over SSE (they used to double-append).
      if (contentLength !== undefined && contentLength <= streamingContentRef.current.length) {
        return
      }
      streamingContentRef.current += token
    }
    contentRevealRef.current!.setTarget(streamingContentRef.current.length)
  }, [trackTokenStall])

  /**
   * Handle a `chat:token-retract` SSE event: the step whose text was being
   * streamed died (error, abort, stall): truncate the streaming bubble back
   * to the committed length. The reasoning stream and tool cards are
   * unaffected.
   */
  const handleTokenRetract = useCallback((data: StreamingTokenRetractData) => {
    if (streamingMessageIdRef.current !== data.messageId) return
    if (data.contentLength >= streamingContentRef.current.length) return
    streamingContentRef.current = streamingContentRef.current.slice(0, data.contentLength)
    // A target below the reveal cursor snaps the visible text down immediately.
    contentRevealRef.current!.setTarget(data.contentLength)
  }, [])

  /**
   * Handle an incoming reasoning/thinking token from SSE.
   */
  const handleReasoningToken = useCallback((data: StreamingReasoningTokenData) => {
    const { messageId } = data

    // If we haven't started streaming yet, initialize the streaming message
    // (reasoning can arrive before the first text token). A DIFFERENT
    // messageId while one is still tracked means chat:done was missed:
    // start fresh instead of appending onto the stale turn.
    if (!streamingMessageIdRef.current || streamingMessageIdRef.current !== messageId) {
      if (streamingMessageIdRef.current && streamingMessageIdRef.current !== messageId) {
        streamingContentRef.current = ''
        streamingReasoningRef.current = ''
        setStreamingReasoning('')
        setStreamingOutputTokens(0)
        contentRevealRef.current!.reset()
        reasoningRevealRef.current!.reset()
      }
      streamingMessageIdRef.current = messageId
      setIsStreaming(true)
      setStreamingMessage({
        id: messageId,
        role: 'assistant',
        content: '',
        sourceType: 'agent',
        sourceId: null,
        sourceName: null,
        sourceAvatarUrl: null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId: null,
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
    reasoningRevealRef.current!.setTarget(streamingReasoningRef.current.length)
  }, [trackTokenStall])

  /**
   * Handle a `chat:token-usage` SSE event — the server's running output-token
   * total for the current turn. Monotonic; ignore stale/lower values.
   */
  const handleTokenUsage = useCallback((outputTokens: number) => {
    setStreamingOutputTokens((prev) => (outputTokens > prev ? outputTokens : prev))
  }, [])

  /**
   * Handle a `chat:done` SSE event.
   * Flushes pending timers, builds the promoted ChatMessage (or null if no
   * streaming was active), and resets internal state.
   *
   * The caller is responsible for appending the returned message to its
   * messages array and triggering any post-done actions (e.g. fetchMessages).
   */
  const handleDone = useCallback((data?: StreamingDoneData): ChatMessage | null => {
    contentRevealRef.current!.reset()
    reasoningRevealRef.current!.reset()
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
        sourceType: (data?.sourceType as string) ?? 'agent',
        sourceId: (data?.sourceId as string) ?? null,
        sourceName: (data?.sourceName as string) ?? null,
        sourceAvatarUrl: (data?.sourceAvatarUrl as string) ?? null,
        isRedacted: false,
        toolCalls: null,
        resolvedTaskId: null,
        memoriesExtracted: null,
        compactingError: null,
        files: [],
        reactions: [],
        stepLimitReached: (data?.stepLimitReached as boolean) ?? false,
        emptyTurn: (data?.emptyTurn as boolean) ?? false,
        finishReason: (data?.finishReason as string) ?? null,
        silentStop: (data?.silentStop as boolean) ?? false,
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
    setStreamingOutputTokens(0)
    streamingContentRef.current = ''
    streamingReasoningRef.current = ''
    streamingMessageIdRef.current = null

    return promoted
  }, [])

  /**
   * Seed the streaming state from a server-provided snapshot. Used to rehydrate
   * the in-flight bubble when the chat hook mounts mid-stream (navigate-away
   * then back, or full page reload while the model is still emitting tokens).
   *
   * Safe to call after `resetStreaming()`; the next `chat:token` event will
   * accumulate on top of the seeded content because the messageId ref is set.
   * If the local stream is already tracking the same messageId, the snapshot
   * is reconciled (we keep whichever content is longer) so a race between the
   * REST fetch and the live SSE stream cannot truncate the bubble.
   */
  const seedStreaming = useCallback((snapshot: StreamingSnapshot) => {
    if (!snapshot.messageId) return

    const sameMessage = streamingMessageIdRef.current === snapshot.messageId
    const localContent = streamingContentRef.current
    const seededContent = snapshot.content ?? ''
    const content = sameMessage && localContent.length > seededContent.length
      ? localContent
      : seededContent

    streamingMessageIdRef.current = snapshot.messageId
    streamingContentRef.current = content
    // Pre-existing text shows at once (no typewriter over old content); only
    // tokens arriving after the seed animate.
    contentRevealRef.current!.prime(content.length)

    const reasoningText = snapshot.reasoning && snapshot.reasoning.length > 0
      ? snapshot.reasoning.map((r) => r.text).join('')
      : ''
    if (reasoningText && streamingReasoningRef.current.length < reasoningText.length) {
      streamingReasoningRef.current = reasoningText
      setStreamingReasoning(reasoningText)
      reasoningRevealRef.current!.prime(reasoningText.length)
    }

    if (typeof snapshot.outputTokens === 'number') {
      setStreamingOutputTokens((prev) => Math.max(prev, snapshot.outputTokens!))
    }

    setIsStreaming(true)
    setTokenStalled(false)

    // Re-arm the stall timer so the typing indicator does not flash off and
    // back on while waiting for the next live token after rehydration.
    if (trackTokenStall) {
      if (tokenStallTimerRef.current) clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = setTimeout(() => setTokenStalled(true), TOKEN_STALL_MS)
    }

    setStreamingMessage({
      id: snapshot.messageId,
      role: 'assistant',
      content,
      sourceType: 'agent',
      sourceId: null,
      sourceName: snapshot.sourceName ?? null,
      sourceAvatarUrl: snapshot.sourceAvatarUrl ?? null,
      isRedacted: false,
      toolCalls: null,
      resolvedTaskId: null,
      memoriesExtracted: null,
      compactingError: null,
      files: [],
      reactions: [],
      stepLimitReached: false,
      tokenUsage: null,
      reasoning: snapshot.reasoning ?? null,
      channelContextLine: null,
      channelMeta: null,
      systemEvent: null,
      createdAt: new Date().toISOString(),
    })
  }, [trackTokenStall])

  /**
   * Reset all streaming state. Call when the context changes (e.g. agentId switch).
   */
  const resetStreaming = useCallback(() => {
    contentRevealRef.current!.reset()
    reasoningRevealRef.current!.reset()
    if (tokenStallTimerRef.current) {
      clearTimeout(tokenStallTimerRef.current)
      tokenStallTimerRef.current = null
    }
    setIsStreaming(false)
    setStreamingMessage(null)
    setTokenStalled(false)
    setStreamingReasoning('')
    setStreamingOutputTokens(0)
    streamingContentRef.current = ''
    streamingReasoningRef.current = ''
    streamingMessageIdRef.current = null
  }, [])

  /**
   * Cleanup function — call in a useEffect return to clear timers on unmount.
   */
  const cleanup = useCallback(() => {
    contentRevealRef.current!.reset()
    reasoningRevealRef.current!.reset()
    if (tokenStallTimerRef.current) clearTimeout(tokenStallTimerRef.current)
  }, [])

  return {
    streamingMessage,
    isStreaming,
    tokenStalled,
    streamingReasoning,
    streamingOutputTokens,
    handleToken,
    handleTokenRetract,
    handleReasoningToken,
    handleTokenUsage,
    handleDone,
    seedStreaming,
    resetStreaming,
    cleanup,
  }
}
