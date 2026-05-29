import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { getToolDomain as lookupToolDomain } from '@/client/lib/tool-domain-lookup'
import type { TaskStatus, ToolCallEntry, ToolDomain, MessageTokenUsage, KinThinkingEffort, TaskTodo, TaskTokenUsage } from '@/shared/types'
import type { ToolCallViewItem, ToolCallStatus } from '@/client/hooks/useToolCalls'

interface TaskDetail {
  id: string
  parentKinId: string
  title: string | null
  description: string
  status: TaskStatus
  mode: string
  model: string | null
  /** Provider family ("anthropic", "openai", ...) resolved server-side from
   *  the effective model. Used by `TokenUsageIndicator` to apply the correct
   *  cache multipliers in the popover breakdown. */
  providerType?: string | null
  thinkingEnabled?: boolean
  thinkingEffort?: KinThinkingEffort | null
  depth: number
  result: string | null
  error: string | null
  concurrencyGroup: string | null
  concurrencyMax: number | null
  cronId: string | null
  /** Optional run-specific sur-prompt captured at spawn time for ticket tasks.
   *  Surfaced in the task panel so the user can audit what scope this run
   *  was given, distinct from the ticket description itself. */
  runPrompt?: string | null
  /** Roll-up of every LLM call billed to this task. Null until the first step
   *  records usage. Pushed live via `task:token-usage` SSE so the running
   *  counter updates without polling. */
  tokenUsage?: TaskTokenUsage | null
  /** Unix-ms (string) when the task first entered in_progress. Null while
   *  queued/pending. Drives the live + persisted run-duration chip. */
  startedAt?: string | null
  /** When the task reached a terminal status. Null while still active. */
  endedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sourceType: string
  sourceId: string | null
  isRedacted: boolean
  toolCalls: ToolCallEntry[] | null
  tokenUsage: MessageTokenUsage | null
  reasoning: Array<{ offset: number; text: string }> | null
  createdAt: number
}

interface LearningEntry {
  id: string
  content: string
  category: string | null
  createdAt: string
}

interface TaskDetailResponse {
  task: TaskDetail
  messages: TaskMessage[]
  streamingMessageId: string | null
  learningsSaved: LearningEntry[]
  todos: TaskTodo[]
}

const STREAMING_BATCH_MS = 50

function getToolDomain(toolName: string): ToolDomain {
  return lookupToolDomain(toolName)
}

function deriveStatus(entry: ToolCallEntry): ToolCallStatus {
  if (entry.result === undefined) return 'error'
  if (
    typeof entry.result === 'object' &&
    entry.result !== null &&
    'error' in (entry.result as Record<string, unknown>)
  )
    return 'error'
  return 'success'
}

export function useTaskDetail(taskId: string | null) {
  const [task, setTask] = useState<TaskDetail | null>(null)
  const [messages, setMessages] = useState<TaskMessage[]>([])
  const [learningsSaved, setLearningsSaved] = useState<LearningEntry[]>([])
  const [todos, setTodos] = useState<TaskTodo[]>([])
  const messagesRef = useRef<TaskMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Streaming state (same pattern as useChat)
  const [streamingMessage, setStreamingMessage] = useState<TaskMessage | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const streamingContentRef = useRef('')
  const streamingMessageIdRef = useRef<string | null>(null)
  const streamingReasoningRef = useRef('')
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reasoningBatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Streaming tool calls (accumulated during streaming, merged into allToolCalls)
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallViewItem[]>([])
  const streamingToolCallsRef = useRef<ToolCallViewItem[]>([])

  // Gate: SSE streaming events are buffered until the first fetchDetail()
  // resolves. Without this, events arriving before fetchDetail seed from an
  // empty messagesRef, causing a text gap. Buffered events are replayed once
  // messagesRef is populated.
  const readyRef = useRef(false)
  const pendingEventsRef = useRef<Array<{ type: string; data: Record<string, unknown> }>>([])



  // Keep messagesRef always in sync with messages state
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // Reset ALL state when taskId changes (modal close/reopen).
  // Without this, stale streaming refs from a previous open cause
  // unpredictable content on each re-open.
  useEffect(() => {
    readyRef.current = false
    pendingEventsRef.current = []
    setTask(null)
    setMessages([])
    setIsStreaming(false)
    setStreamingMessage(null)
    setStreamingReasoning('')
    streamingContentRef.current = ''
    streamingMessageIdRef.current = null
    streamingReasoningRef.current = ''
    streamingToolCallsRef.current = []
    setStreamingToolCalls([])
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current)
      batchTimerRef.current = null
    }
    if (reasoningBatchTimerRef.current) {
      clearTimeout(reasoningBatchTimerRef.current)
      reasoningBatchTimerRef.current = null
    }
  }, [taskId])

  const fetchDetail = useCallback(async () => {
    if (!taskId) return

    setIsLoading(true)
    try {
      const data = await api.get<TaskDetailResponse>(`/tasks/${taskId}`)
      setTask(data.task)
      setLearningsSaved(data.learningsSaved ?? [])
      setTodos(data.todos ?? [])
      // Smart merge: preserve object references for unchanged messages to
      // avoid unnecessary re-renders (same pattern as useChat.fetchMessages)
      // Smart merge: preserve object references for unchanged messages
      const merged = data.messages.map((newMsg) => {
        const existing = messagesRef.current.find((m) => m.id === newMsg.id)
        if (
          existing &&
          existing.content === newMsg.content &&
          JSON.stringify(existing.toolCalls) === JSON.stringify(newMsg.toolCalls)
        ) {
          return existing
        }
        return newMsg
      })
      // Update ref synchronously BEFORE replaying buffered events,
      // because setMessages is async and the useEffect([messages]) sync
      // won't run until the next render.
      messagesRef.current = merged
      setMessages(merged)

      // Safety net: if task is terminal, ensure streaming is cleared
      const s = data.task.status
      if (s === 'completed' || s === 'failed' || s === 'cancelled') {
        setIsStreaming(false)
        setStreamingMessage(null)
        setStreamingReasoning('')
        streamingContentRef.current = ''
        streamingMessageIdRef.current = null
        streamingReasoningRef.current = ''
        streamingToolCallsRef.current = []
        setStreamingToolCalls([])
      } else if (data.streamingMessageId) {
        // The server reports an in-flight assistant message and has overlaid
        // its live in-memory content into the messages list. Pre-seed the
        // streaming state from it so buffered chat:token events whose
        // `contentLength` is already covered by the snapshot are skipped
        // (see handleToken) — avoids double-counting tokens that were
        // emitted between the SSE connection and fetchDetail resolution.
        const inflight = merged.find((m) => m.id === data.streamingMessageId)
        if (inflight && inflight.role === 'assistant') {
          streamingMessageIdRef.current = inflight.id
          streamingContentRef.current = inflight.content
          setIsStreaming(true)
          setStreamingMessage(inflight)
        }
      }
      // Allow SSE handlers to process events now that messagesRef is populated,
      // then replay any events that arrived while we were fetching.
      readyRef.current = true
      replayPendingEvents()
    } catch {
      // Silently fail — task may have been deleted
    } finally {
      setIsLoading(false)
    }
  }, [taskId])

  // ── Streaming event handlers (used both by SSE and replay) ──────────────

  function seedStreaming(messageId: string, extraContent = '') {
    const existing = messagesRef.current.find((m) => m.id === messageId)
    const baseContent = (existing?.content ?? '') + extraContent
    streamingMessageIdRef.current = messageId
    streamingContentRef.current = baseContent
    setIsStreaming(true)
    setStreamingMessage({
      id: messageId,
      role: 'assistant',
      content: baseContent,
      sourceType: 'kin',
      sourceId: null,
      isRedacted: false,
      toolCalls: null,
      tokenUsage: null,
      reasoning: null,
      createdAt: existing?.createdAt ?? Date.now(),
    })
  }

  function handleReasoningToken(data: Record<string, unknown>) {
    const messageId = data.messageId as string
    const token = data.token as string

    if (!streamingMessageIdRef.current) {
      seedStreaming(messageId)
    }

    streamingReasoningRef.current += token
    if (!reasoningBatchTimerRef.current) {
      reasoningBatchTimerRef.current = setTimeout(() => {
        reasoningBatchTimerRef.current = null
        setStreamingReasoning(streamingReasoningRef.current)
      }, STREAMING_BATCH_MS)
    }
  }

  function handleToolCallStart(data: Record<string, unknown>) {
    const messageId = data.messageId as string
    if (!streamingMessageIdRef.current) seedStreaming(messageId)
  }

  function handleToken(data: Record<string, unknown>) {
    const token = data.token as string
    const messageId = data.messageId as string
    const contentLength = typeof data.contentLength === 'number' ? data.contentLength : undefined

    if (!streamingMessageIdRef.current) {
      seedStreaming(messageId, token)
    } else {
      // Skip events already incorporated into streamingContentRef. The server
      // tags each chat:token with the fullContent length AFTER appending — and
      // the live snapshot returned by fetchDetail is always at a token boundary
      // (see executeSubKin) — so this comparison is exact and rejects only
      // tokens the snapshot already covered.
      if (contentLength !== undefined && contentLength <= streamingContentRef.current.length) {
        return
      }
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
  }

  function handleToolCall(data: Record<string, unknown>) {
    const messageId = data.messageId as string
    if (!streamingMessageIdRef.current) seedStreaming(messageId)

    const item: ToolCallViewItem = {
      id: data.toolCallId as string,
      messageId,
      name: data.toolName as string,
      domain: getToolDomain(data.toolName as string),
      args: data.args,
      result: undefined,
      status: 'pending',
      timestamp: new Date().toISOString(),
      offset: typeof data.contentOffset === 'number' ? data.contentOffset : undefined,
    }
    streamingToolCallsRef.current = [...streamingToolCallsRef.current, item]
    setStreamingToolCalls(streamingToolCallsRef.current)
  }

  function handleToolResult(data: Record<string, unknown>) {
    const toolCallId = data.toolCallId as string
    const resultData = data.result
    const hasError =
      typeof resultData === 'object' &&
      resultData !== null &&
      'error' in (resultData as Record<string, unknown>)

    streamingToolCallsRef.current = streamingToolCallsRef.current.map((tc) =>
      tc.id === toolCallId
        ? { ...tc, result: resultData, status: (hasError ? 'error' : 'success') as ToolCallStatus }
        : tc,
    )
    setStreamingToolCalls(streamingToolCallsRef.current)
  }

  function handleDone(data: Record<string, unknown>) {
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current)
      batchTimerRef.current = null
    }
    if (reasoningBatchTimerRef.current) {
      clearTimeout(reasoningBatchTimerRef.current)
      reasoningBatchTimerRef.current = null
    }

    const finalContent = (data.content as string) ?? streamingContentRef.current
    const doneMessageId = (data.messageId as string) ?? streamingMessageIdRef.current
    const finalReasoning = streamingReasoningRef.current
      ? [{ offset: 0, text: streamingReasoningRef.current }]
      : null

    if (doneMessageId) {
      setMessages((prev) => {
        const withoutOld = prev.filter((m) => m.id !== doneMessageId)
        return [
          ...withoutOld,
          {
            id: doneMessageId,
            role: 'assistant' as const,
            content: finalContent,
            sourceType: 'kin',
            sourceId: null,
            isRedacted: false,
            toolCalls: null,
            tokenUsage: null,
            reasoning: finalReasoning,
            createdAt: Date.now(),
          },
        ]
      })
    }

    setIsStreaming(false)
    setStreamingMessage(null)
    setStreamingReasoning('')
    streamingContentRef.current = ''
    streamingMessageIdRef.current = null
    streamingReasoningRef.current = ''
    streamingToolCallsRef.current = []
    setStreamingToolCalls([])

    fetchDetail()
  }

  function replayPendingEvents() {
    const events = pendingEventsRef.current
    pendingEventsRef.current = []
    for (const { type, data } of events) {
      switch (type) {
        case 'chat:tool-call-start': handleToolCallStart(data); break
        case 'chat:token': handleToken(data); break
        case 'chat:reasoning-token': handleReasoningToken(data); break
        case 'chat:tool-call': handleToolCall(data); break
        case 'chat:tool-result': handleToolResult(data); break
        case 'chat:done': handleDone(data); break
      }
    }
  }

  // Initial fetch
  useEffect(() => {
    fetchDetail()
  }, [fetchDetail])

  // SSE handlers
  useSSE({
    // Task lifecycle events
    'task:todos': (data) => {
      if (data.taskId !== taskId) return
      const next = Array.isArray(data.todos) ? (data.todos as TaskTodo[]) : []
      setTodos(next)
    },
    'task:deleted': (data) => {
      if (data.taskId !== taskId) return
      setTask(null)
      setMessages([])
      setTodos([])
      setIsStreaming(false)
      setStreamingMessage(null)
      setStreamingReasoning('')
      streamingContentRef.current = ''
      streamingMessageIdRef.current = null
      streamingReasoningRef.current = ''
      streamingToolCallsRef.current = []
      setStreamingToolCalls([])
    },
    'task:status': (data) => {
      if (data.taskId !== taskId) return
      const status = data.status as TaskStatus
      const startedAt = typeof data.startedAt === 'number' ? new Date(data.startedAt).toISOString() : undefined
      const endedAt = typeof data.endedAt === 'number' ? new Date(data.endedAt).toISOString() : undefined
      setTask((prev) =>
        prev
          ? {
              ...prev,
              status,
              ...(startedAt !== undefined && { startedAt }),
              ...(endedAt !== undefined && { endedAt }),
            }
          : prev,
      )
      // Terminal or paused status → clear streaming state (safety net if chat:done was missed)
      if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'paused') {
        if (batchTimerRef.current) {
          clearTimeout(batchTimerRef.current)
          batchTimerRef.current = null
        }
        if (reasoningBatchTimerRef.current) {
          clearTimeout(reasoningBatchTimerRef.current)
          reasoningBatchTimerRef.current = null
        }
        setIsStreaming(false)
        setStreamingMessage(null)
        setStreamingReasoning('')
        streamingContentRef.current = ''
        streamingMessageIdRef.current = null
        streamingReasoningRef.current = ''
        streamingToolCallsRef.current = []
        setStreamingToolCalls([])
        fetchDetail()
      }
    },
    'task:token-usage': (data) => {
      if (data.taskId !== taskId) return
      const next = data.tokenUsage as TaskTokenUsage | null | undefined
      if (!next) return
      setTask((prev) => (prev ? { ...prev, tokenUsage: next } : prev))
    },
    'task:done': (data) => {
      if (data.taskId !== taskId) return
      // Clear streaming state — task is finished
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current)
        batchTimerRef.current = null
      }
      if (reasoningBatchTimerRef.current) {
        clearTimeout(reasoningBatchTimerRef.current)
        reasoningBatchTimerRef.current = null
      }
      setIsStreaming(false)
      setStreamingMessage(null)
      setStreamingReasoning('')
      streamingContentRef.current = ''
      streamingMessageIdRef.current = null
      streamingReasoningRef.current = ''
      streamingToolCallsRef.current = []
      setStreamingToolCalls([])
      fetchDetail()
    },

    // Real-time message insertion (e.g. initial task description saved by backend)
    'chat:message': (data) => {
      if (data.taskId !== taskId) return

      const msg: TaskMessage = {
        id: data.id as string,
        role: data.role as 'user' | 'assistant' | 'system',
        content: (data.content as string) ?? '',
        sourceType: (data.sourceType as string) ?? 'system',
        sourceId: (data.sourceId as string) ?? null,
        isRedacted: false,
        toolCalls: null,
        tokenUsage: null,
        reasoning: null,
        createdAt: data.createdAt as number,
      }

      setMessages((prev) => {
        // Avoid duplicates (initial fetch may already have it)
        if (prev.some((m) => m.id === msg.id)) return prev
        return [...prev, msg]
      })
    },

    // Streaming events — filtered by taskId
    // All streaming handlers buffer events until fetchDetail has resolved
    // (readyRef), then replay them so no tokens are lost.

    'chat:tool-call-start': (data) => {
      if (data.taskId !== taskId) return
      if (!readyRef.current) { pendingEventsRef.current.push({ type: 'chat:tool-call-start', data }); return }
      handleToolCallStart(data)
    },

    'chat:token': (data) => {
      if (data.taskId !== taskId) return
      if (!readyRef.current) { pendingEventsRef.current.push({ type: 'chat:token', data }); return }
      handleToken(data)
    },

    'chat:reasoning-token': (data) => {
      if (data.taskId !== taskId) return
      if (!readyRef.current) { pendingEventsRef.current.push({ type: 'chat:reasoning-token', data }); return }
      handleReasoningToken(data)
    },

    'chat:tool-call': (data) => {
      if (data.taskId !== taskId) return
      if (!readyRef.current) { pendingEventsRef.current.push({ type: 'chat:tool-call', data }); return }
      handleToolCall(data)
    },

    'chat:tool-result': (data) => {
      if (data.taskId !== taskId) return
      if (!readyRef.current) { pendingEventsRef.current.push({ type: 'chat:tool-result', data }); return }
      handleToolResult(data)
    },

    'chat:done': (data) => {
      if (data.taskId !== taskId) return
      if (!readyRef.current) { pendingEventsRef.current.push({ type: 'chat:done', data }); return }
      handleDone(data)
    },
  })

  // Polling fallback — if SSE events are lost (e.g. reconnection gap),
  // periodically refresh the task detail so messages still appear.
  useEffect(() => {
    if (!taskId) return
    // SSE is the source of truth during streaming — don't let polling
    // overwrite the streaming state with stale DB content
    if (isStreaming) return
    const status = task?.status
    if (!status || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'paused') return

    const interval = setInterval(fetchDetail, 1000)
    return () => clearInterval(interval)
  }, [taskId, task?.status, fetchDetail, isStreaming])

  // Extract tool calls from persisted messages
  const historicalToolCalls = useMemo(() => {
    const items: ToolCallViewItem[] = []
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          items.push({
            id: tc.id,
            messageId: msg.id,
            name: tc.name,
            domain: getToolDomain(tc.name),
            args: tc.args,
            result: tc.result,
            status: deriveStatus(tc),
            timestamp: String(msg.createdAt),
            offset: tc.offset,
          })
        }
      }
    }
    return items
  }, [messages])

  // Merge historical + streaming tool calls (deduplicate by id — the 3s
  // polling fallback can fetch persisted messages while the stream is still
  // active, causing the same tool call to appear in both lists).
  const allToolCalls = useMemo(() => {
    if (streamingToolCalls.length === 0) return historicalToolCalls
    if (historicalToolCalls.length === 0) return streamingToolCalls
    const seen = new Set(historicalToolCalls.map((tc) => tc.id))
    const unique = streamingToolCalls.filter((tc) => !seen.has(tc.id))
    return [...historicalToolCalls, ...unique]
  }, [historicalToolCalls, streamingToolCalls])

  const toolCallsByMessage = useMemo(() => {
    const map = new Map<string, ToolCallViewItem[]>()
    for (const tc of allToolCalls) {
      const existing = map.get(tc.messageId)
      if (existing) {
        existing.push(tc)
      } else {
        map.set(tc.messageId, [tc])
      }
    }
    return map
  }, [allToolCalls])

  const cancelTask = useCallback(async () => {
    if (!taskId) return false
    try {
      await api.post(`/tasks/${taskId}/cancel`)
      return true
    } catch {
      return false
    }
  }, [taskId])

  const pauseTask = useCallback(async () => {
    if (!taskId) return false
    try {
      await api.post(`/tasks/${taskId}/pause`)
      return true
    } catch {
      return false
    }
  }, [taskId])

  const resumeTask = useCallback(async (message?: string) => {
    if (!taskId) return false
    try {
      await api.post(`/tasks/${taskId}/resume`, message ? { message } : {})
      return true
    } catch {
      return false
    }
  }, [taskId])

  const injectIntoTask = useCallback(async (content: string) => {
    if (!taskId) return false
    try {
      await api.post(`/tasks/${taskId}/inject`, { content })
      return true
    } catch {
      return false
    }
  }, [taskId])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current)
      }
      if (reasoningBatchTimerRef.current) {
        clearTimeout(reasoningBatchTimerRef.current)
      }
    }
  }, [])

  return {
    task,
    messages,
    isLoading,
    isStreaming,
    streamingMessage,
    streamingReasoning,
    cancelTask,
    pauseTask,
    resumeTask,
    injectIntoTask,
    refetch: fetchDetail,
    allToolCalls,
    toolCallCount: allToolCalls.length,
    toolCallsByMessage,
    learningsSaved,
    todos,
  }
}
