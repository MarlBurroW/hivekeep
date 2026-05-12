import React, { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, startTransition, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { MessageBubble } from '@/client/components/chat/MessageBubble'
import { MessageInput, type MessageInputHandle } from '@/client/components/chat/MessageInput'
import { TypingIndicator } from '@/client/components/chat/TypingIndicator'
import { ConversationHeader } from '@/client/components/chat/ConversationHeader'
import { ToolCallsViewer } from '@/client/components/chat/ToolCallsViewer'
const MiniAppViewer = lazy(() => import('@/client/components/mini-app/MiniAppViewer').then(m => ({ default: m.MiniAppViewer })))
import { TaskResultCard } from '@/client/components/chat/TaskResultCard'
import { CompactingCard } from '@/client/components/chat/CompactingCard'
import { HumanPromptCard } from '@/client/components/chat/HumanPromptCard'
import { Sheet, SheetContent, SheetTitle } from '@/client/components/ui/sheet'
const QuickChatPanel = lazy(() => import('@/client/components/chat/QuickChatPanel').then(m => ({ default: m.QuickChatPanel })))
const QuickSessionHistory = lazy(() => import('@/client/components/chat/QuickSessionHistory').then(m => ({ default: m.QuickSessionHistory })))
import { useChat, type LiveTask } from '@/client/hooks/useChat'
import { useToolCalls } from '@/client/hooks/useToolCalls'
import { useHumanPrompts } from '@/client/hooks/useHumanPrompts'
import { useQuickSession } from '@/client/hooks/useQuickSession'
import { useAuth } from '@/client/hooks/useAuth'
import { useReactions } from '@/client/hooks/useReactions'
import { useDraftMessage } from '@/client/hooks/useDraftMessage'
import { useQueueItems } from '@/client/hooks/useQueueItems'
import { useFileUpload } from '@/client/hooks/useFileUpload'
import { useExportConversation } from '@/client/hooks/useExportConversation'
const ConversationSearch = lazy(() => import('@/client/components/chat/ConversationSearch').then(m => ({ default: m.ConversationSearch })))
import { QueuePreview } from '@/client/components/chat/QueuePreview'
import type { ContextTokenBreakdown, ContextPipelineStatus, KinThinkingEffort } from '@/shared/types'
import { ChatEmptyState } from '@/client/components/chat/ChatEmptyState'
import { DateSeparator } from '@/client/components/chat/DateSeparator'
import { TimeGapIndicator } from '@/client/components/chat/TimeGapIndicator'
import { SearchHighlightProvider } from '@/client/components/chat/SearchHighlightContext'
import { MentionLookupProvider } from '@/client/components/chat/MentionContext'
import { useMentionables } from '@/client/hooks/useMentionables'
import { cn, getUserInitials } from '@/client/lib/utils'
import { useMiniAppPanel } from '@/client/contexts/MiniAppContext'
import { ArrowDown, ArrowUp, Upload, Pin, PinOff } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/client/lib/api'

interface KinInfo {
  id: string
  name: string
  role: string
  model: string
  providerId: string | null
  avatarUrl: string | null
  thinkingEnabled?: boolean
  thinkingEffort?: KinThinkingEffort | null
}

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

interface ChatPanelProps {
  kin: KinInfo
  llmModels: LLMModel[]
  modelUnavailable?: boolean
  queueState?: { isProcessing: boolean; queueSize: number; processingStartedAt?: number; contextTokens?: number; contextWindow?: number; apiContextTokens?: number; contextBreakdown?: ContextTokenBreakdown; pipelineStatus?: ContextPipelineStatus; compactingPercent?: number; compactingThresholdPercent?: number; summaryCount?: number; maxSummaries?: number; summaryTokens?: number; summaryBudgetTokens?: number; keepPercent?: number }
  onModelChange: (modelId: string, providerId: string) => void
  onEditKin: () => void
  onOpenSettings?: (section?: string, filters?: { kinId?: string }) => void
}

export function ChatPanel({ kin, llmModels, modelUnavailable = false, queueState, onModelChange, onEditKin, onOpenSettings }: ChatPanelProps) {
  const { t } = useTranslation()
  // Used by TokenUsageIndicator and the cache chip to apply provider-specific
  // cache pricing multipliers. Best-effort: derived from the Kin's CURRENT
  // model, so messages from a previous model are evaluated with the new
  // model's multipliers (rare in practice).
  const currentProviderType = llmModels.find((m) => m.id === kin.model)?.providerType ?? null
  const { user } = useAuth()
  const userInitials = user ? getUserInitials(user) : 'U'
  const { messages, streamingMessage, streamingReasoning, liveTasks, liveCompacting, isLoading, isStreaming, hasMore, isLoadingMore, tokenStalled, sendMessage, stopStreaming, clearConversation, fetchOlderMessages } = useChat(kin.id)
  const { toolCalls, toolCallCount, toolCallsByMessage } = useToolCalls(kin.id, messages)
  const { prompts: pendingPrompts, respond: respondToPrompt, isResponding } = useHumanPrompts(kin.id)
  const { content: draftContent, setContent: setDraftContent, clearDraft } = useDraftMessage(kin.id)
  const { items: queueItems, removeItem: removeQueueItem, injectItem: injectQueueItem, isRemoving: isRemovingQueueItem } = useQueueItems(kin.id)
  const { pendingFiles, addFiles, removeFile, clearFiles, isUploading } = useFileUpload(kin.id)
  const { activeSession, isOpen: isQuickOpen, setIsOpen: setQuickOpen, createSession, closeSession } = useQuickSession(kin.id)
  const [showQuickHistory, setShowQuickHistory] = useState(false)
  const { exportAsMarkdown, exportAsJSON } = useExportConversation(messages, kin.name)
  const { users: mentionableUsers, kins: mentionableKins } = useMentionables()
  const { toggleReaction } = useReactions(kin.id)
  const [thinkingEnabled, setThinkingEnabled] = useState(kin.thinkingEnabled ?? false)
  const [isToolCallsOpen, setIsToolCallsOpen] = useState(false)
  const { openTask } = useMiniAppPanel()
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const [showScrollTop, setShowScrollTop] = useState(false)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const prevMessageCountRef = useRef(messages.length)
  const [autoScroll, setAutoScroll] = useState(() => {
    try {
      const stored = localStorage.getItem('chat.autoScroll')
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })

  const [thinkingEffort, setThinkingEffort] = useState<KinThinkingEffort | null>(kin.thinkingEffort ?? null)

  // Sync thinking state from prop when kin changes
  useEffect(() => {
    setThinkingEnabled(kin.thinkingEnabled ?? false)
    setThinkingEffort(kin.thinkingEffort ?? null)
  }, [kin.id, kin.thinkingEnabled, kin.thinkingEffort])

  const updateThinking = useCallback(async (next: { enabled: boolean; effort: KinThinkingEffort | null }) => {
    const prevEnabled = thinkingEnabled
    const prevEffort = thinkingEffort
    setThinkingEnabled(next.enabled)
    setThinkingEffort(next.effort)
    try {
      await api.patch(`/kins/${kin.id}`, { thinkingConfig: { enabled: next.enabled, effort: next.effort } })
    } catch {
      setThinkingEnabled(prevEnabled)
      setThinkingEffort(prevEffort)
    }
  }, [thinkingEnabled, thinkingEffort, kin.id])

  // Slash command + keyboard shortcut: simple toggle (defaults to medium when enabling)
  const toggleThinking = useCallback(() => {
    if (thinkingEnabled) updateThinking({ enabled: false, effort: null })
    else updateThinking({ enabled: true, effort: thinkingEffort ?? 'medium' })
  }, [thinkingEnabled, thinkingEffort, updateThinking])

  const toggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      const next = !prev
      try { localStorage.setItem('chat.autoScroll', String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchHighlightId, setSearchHighlightId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<MessageInputHandle>(null)
  const prevScrollHeightRef = useRef<number | null>(null)
  const isLoadingMoreRef = useRef(false)
  const knownMessageIdsRef = useRef<Set<string>>(new Set())
  const initialLoadDoneRef = useRef(false)

  const toggleToolCalls = useCallback(() => setIsToolCallsOpen((prev) => !prev), [])
  const toggleSearch = useCallback(() => {
    setIsSearchOpen((prev) => {
      if (prev) {
        setSearchHighlightId(null)
        setSearchQuery('')
      }
      return !prev
    })
  }, [])

  const isCompacting = liveCompacting?.status === 'running'

  const handleQuickSession = useCallback(() => {
    if (activeSession) {
      setQuickOpen(true)
    } else {
      createSession()
    }
  }, [activeSession, setQuickOpen, createSession])

  const handleQuickClose = useCallback(
    (saveMemory?: boolean, memorySummary?: string) => {
      if (activeSession) {
        closeSession(activeSession.id, saveMemory, memorySummary)
      }
    },
    [activeSession, closeSession],
  )

  const handleForceCompact = useCallback(async () => {
    try {
      await api.post(`/kins/${kin.id}/compacting/run`)
    } catch (err: unknown) {
      const code = (err as { error?: { code?: string } })?.error?.code
      if (code === 'NOTHING_TO_COMPACT') {
        toast.info(t('chat.compacting.nothingToCompact'))
      } else {
        toast.error(t('chat.compacting.error'))
      }
    }
  }, [kin.id, t])

  // Ctrl+F to open search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setIsSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Reset known message IDs when switching kins
  useEffect(() => {
    knownMessageIdsRef.current = new Set()
    initialLoadDoneRef.current = false
  }, [kin.id])

  // Auto-focus message input when switching kins
  useEffect(() => {
    // Small delay to ensure the input is mounted and ready
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [kin.id])

  // Escape key to refocus the message input
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Don't hijack Escape from modals, dialogs, or search
      if (isSearchOpen || detailTaskId || isQuickOpen) return
      const tag = (e.target as HTMLElement)?.tagName
      const isInInput = tag === 'INPUT' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable
      // If in the message textarea, blur it (standard Escape behavior)
      // If elsewhere, focus the message input
      if (tag === 'TEXTAREA') return
      if (isInInput) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isSearchOpen, detailTaskId, isQuickOpen])

  // Track whether user has scrolled away from bottom
  const isNearBottomRef = useRef(true)

  // On mount (fresh for each kin thanks to key=kin.id), scroll to bottom
  // instantly once messages are loaded — runs before paint so the user
  // never sees the conversation at the wrong scroll position.
  const needsInstantScrollRef = useRef(true)
  const justDidInstantScrollRef = useRef(false)

  useLayoutEffect(() => {
    if (needsInstantScrollRef.current && messages.length > 0) {
      const scrollArea = scrollAreaRef.current
      if (scrollArea) {
        const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight
        }
      }
      isNearBottomRef.current = true
      needsInstantScrollRef.current = false
      justDidInstantScrollRef.current = true
    }
  }, [messages])

  const checkNearBottom = useCallback(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return
    const { scrollTop, scrollHeight, clientHeight } = viewport
    const nearBottom = scrollHeight - scrollTop - clientHeight < 100
    isNearBottomRef.current = nearBottom
    startTransition(() => {
      setShowScrollBottom(!nearBottom)
      setShowScrollTop(scrollTop > 300)
    })
    if (nearBottom) setNewMessageCount(0)
  }, [])

  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return
    viewport.addEventListener('scroll', checkNearBottom)
    return () => viewport.removeEventListener('scroll', checkNearBottom)
  }, [checkNearBottom])

  // Compensate scroll position when the viewport height changes (e.g. queue preview
  // appearing/disappearing). Without this, a viewport shrink pushes the user away from
  // the bottom and breaks auto-scroll. We adjust scrollTop by the exact delta so the
  // user stays at the same visual position — no jumps, no race conditions.
  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return
    let prevHeight = viewport.clientHeight
    const observer = new ResizeObserver(() => {
      const newHeight = viewport.clientHeight
      const delta = prevHeight - newHeight // positive when viewport shrinks
      prevHeight = newHeight
      // Check if user was near bottom BEFORE the resize using the old viewport height.
      // The scroll event listener may have already flipped isNearBottomRef to false
      // (because the viewport shrank, increasing distance-from-bottom), so we can't
      // rely on it alone. Compute the pre-resize distance instead.
      const { scrollTop, scrollHeight } = viewport
      const wasNearBottom = scrollHeight - scrollTop - (newHeight + delta) < 100
      if (wasNearBottom || isNearBottomRef.current) {
        // Viewport resized while user was near bottom — snap to bottom to stay pinned.
        viewport.scrollTop = viewport.scrollHeight
        isNearBottomRef.current = true
      }
      checkNearBottom()
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [checkNearBottom])

  // Stable ref for fetchOlderMessages so the IntersectionObserver doesn't
  // need to reconnect whenever the callback identity changes.
  const fetchOlderMessagesRef = useRef(fetchOlderMessages)
  fetchOlderMessagesRef.current = fetchOlderMessages

  // IntersectionObserver — trigger loading older messages when top sentinel is visible.
  // Uses a ref for the callback + hasMore to keep the observer stable and avoid
  // reconnection loops that would cause infinite fetch cascades.
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const scrollArea = scrollAreaRef.current
    if (!sentinel || !scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMoreRef.current) {
          // Save scroll height before fetch so we can restore position after prepend
          prevScrollHeightRef.current = viewport.scrollHeight
          isLoadingMoreRef.current = true
          fetchOlderMessagesRef.current()
        }
      },
      { root: viewport, threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  // Only reconnect observer when hasMore or kin changes — NOT on every message/callback change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, kin.id])

  // Keep isLoadingMoreRef in sync for the observer guard
  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore
  }, [isLoadingMore])

  // Restore scroll position after older messages are prepended.
  // Only runs when messages.length changes to avoid consuming prevScrollHeightRef
  // on unrelated re-renders (e.g. isLoadingMore toggling before messages arrive).
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current === null) return
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return

    const delta = viewport.scrollHeight - prevScrollHeightRef.current
    if (delta > 0) {
      viewport.scrollTop += delta
    }
    prevScrollHeightRef.current = null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // Track new messages arriving while scrolled up
  useEffect(() => {
    const diff = messages.length - prevMessageCountRef.current
    if (diff > 0 && !isNearBottomRef.current) {
      setNewMessageCount((prev) => prev + diff)
    }
    if (isNearBottomRef.current) {
      setNewMessageCount(0)
    }
    prevMessageCountRef.current = messages.length
  }, [messages.length])

  // Auto-scroll to bottom whenever the scroll container's content grows.
  // A MutationObserver on the viewport catches every DOM change (new messages,
  // streaming token batches, tool-call expansions, queue preview resize, etc.)
  // so we no longer depend on a React dependency list that can miss updates.
  const isProcessing = queueState?.isProcessing ?? false
  useEffect(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (!viewport) return

    let rafId: number | null = null
    let pendingNearBottom = false
    let pendingStreaming = false
    const scrollToEnd = () => {
      // Capture scroll state synchronously at mutation time, before a scroll
      // event can flip isNearBottomRef to false due to increased scrollHeight.
      const nearNow = isNearBottomRef.current
      const streamNow = isStreamingRef.current
      if (rafId !== null) {
        // Already coalescing — keep the most permissive state
        pendingNearBottom = pendingNearBottom || nearNow
        pendingStreaming = pendingStreaming || streamNow
        return
      }
      pendingNearBottom = nearNow
      pendingStreaming = streamNow
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!autoScrollRef.current) return
        // During active streaming, always scroll (don't rely on isNearBottom
        // which can flip to false between batched token updates)
        if (!pendingNearBottom && !pendingStreaming) return
        if (needsInstantScrollRef.current) return
        viewport.scrollTop = viewport.scrollHeight
        isNearBottomRef.current = true
      })
    }

    const observer = new MutationObserver(scrollToEnd)
    observer.observe(viewport, { childList: true, subtree: true, characterData: true })

    return () => {
      observer.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, []) // stable — reads refs only

  // Keep refs for autoScroll and isStreaming so the MutationObserver callback can read them
  const autoScrollRef = useRef(autoScroll)
  useEffect(() => { autoScrollRef.current = autoScroll }, [autoScroll])
  const isStreamingRef = useRef(isStreaming)
  useEffect(() => { isStreamingRef.current = isStreaming }, [isStreaming])

  // Still trigger a scroll on dependency changes that may not mutate DOM
  // (e.g. isProcessing flipping, queueItems count)
  useEffect(() => {
    if (justDidInstantScrollRef.current) {
      justDidInstantScrollRef.current = false
      return
    }
    if (needsInstantScrollRef.current) return
    if (autoScroll && isNearBottomRef.current) {
      requestAnimationFrame(() => {
        const scrollArea = scrollAreaRef.current
        if (!scrollArea) return
        const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight
          isNearBottomRef.current = true
        }
      })
    }
  }, [messages.length, isProcessing, autoScroll, queueItems.length])

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
    setNewMessageCount(0)
  }, [])

  const scrollToTop = useCallback(() => {
    const scrollArea = scrollAreaRef.current
    if (!scrollArea) return
    const viewport = scrollArea.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null
    if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  // Quote reply: insert quoted text into the draft and focus the input
  const handleQuoteReply = useCallback((quotedText: string) => {
    setDraftContent(draftContent ? `${draftContent}\n${quotedText}` : quotedText)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [setDraftContent, draftContent])

  // Edit & resend: populate input with the message content for editing
  const handleEditResend = useCallback((text: string) => {
    setDraftContent(text)
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [setDraftContent])

  // Full-area drag-and-drop for file upload
  const handlePanelDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1 && e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handlePanelDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragOver(false)
    }
  }, [])

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handlePanelDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0 && addFiles) {
      addFiles(Array.from(e.dataTransfer.files))
      inputRef.current?.focus()
    }
  }, [addFiles])

  // Resolve kin info for the currently open task detail modal
  const detailTask = detailTaskId ? liveTasks.find((t) => t.taskId === detailTaskId) : null

  const handleSend = useCallback(
    async (content: string, fileIds?: string[]) => {
      // Build optimistic MessageFile[] from pending files so images show immediately
      // Use serverUrl (already uploaded) — previewUrl (blob:) gets revoked by clearFiles
      const optimisticFiles = pendingFiles
        .filter((f) => f.status === 'done' && f.serverId && f.serverUrl)
        .map((f) => ({
          id: f.serverId!,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          url: f.serverUrl!,
        }))

      const success = await sendMessage(content, fileIds, optimisticFiles.length > 0 ? optimisticFiles : undefined)
      if (success) {
        clearDraft()
        clearFiles()
      } else {
        toast.error(t('chat.sendFailed'))
      }
    },
    [sendMessage, clearDraft, clearFiles, pendingFiles, t],
  )

  // Inject a message into the current streaming response (/btw)
  const handleInject = useCallback(
    async (content: string) => {
      try {
        await api.post(`/kins/${kin.id}/messages/inject`, { content })
        clearDraft()
      } catch {
        toast.error(t('chat.sendFailed'))
      }
    },
    [kin.id, clearDraft, t],
  )

  // Regenerate: find the last user message and re-send it
  const handleRegenerate = useCallback(() => {
    // Find the last user message (walking backwards)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!
      if (msg.role === 'user' && msg.sourceType === 'user') {
        const fileIds = msg.files && msg.files.length > 0 ? msg.files.map((f) => f.id) : undefined
        sendMessage(msg.content, fileIds)
        return
      }
    }
  }, [messages, sendMessage])

  // Handle slash commands from the input
  const handleCommand = useCallback(
    (command: string, _arg?: string) => {
      switch (command) {
        case 'stop':
          stopStreaming()
          break
        case 'regen':
          handleRegenerate()
          break
        case 'compact':
          handleForceCompact()
          break
        case 'thinking':
          toggleThinking()
          break
        case 'clear':
          clearConversation()
          break
        case 'help':
          toast.info(
            t('chat.commands.helpMessage'),
            { duration: 8000 },
          )
          break
      }
    },
    [stopStreaming, handleRegenerate, clearConversation, handleForceCompact, toggleThinking, t],
  )

  // Determine the last assistant message id (for showing the regenerate button)
  const lastAssistantMsgId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'assistant') return messages[i]!.id
    }
    return null
  }, [messages])

  // Merge streaming message into the display list so it renders in the same
  // React tree branch as persisted messages — prevents unmount/remount (and
  // entrance animation replay) when the stream completes.
  const displayMessages = useMemo(() => {
    // Hide the internal instruction injected by the force-compact endpoint
    // (sourceType 'compacting_followup'). It's a user-role message in the DB
    // because that's how the engine consumes queue items, but it's actually
    // an internal trigger to make the kin acknowledge the compaction +
    // refresh the navbar context counter — the user never typed it and
    // shouldn't see it as if they did. The kin's reply (sourceType 'kin')
    // stays visible.
    const filtered = messages.filter((m) => m.sourceType !== 'compacting_followup')
    if (!streamingMessage) return filtered
    if (filtered.some(m => m.id === streamingMessage.id)) return filtered
    return [...filtered, streamingMessage]
  }, [messages, streamingMessage])

  const handleSearchChange = useCallback((query: string, matchIndex: number, matchCount: number) => {
    setSearchQuery(query)
    if (query.trim().length < 2 || matchCount === 0) {
      setSearchHighlightId(null)
      return
    }
    // Find the matching message id
    const lowerQuery = query.toLowerCase()
    const matchingMessages = displayMessages.filter((m) => m.content.toLowerCase().includes(lowerQuery))
    if (matchingMessages[matchIndex]) {
      setSearchHighlightId(matchingMessages[matchIndex].id)
    }
  }, [displayMessages])

  // Pre-compute date separators, grouping, search matches — only recalculates
  // when displayMessages/search change, NOT when scroll button visibility changes.
  const processedMessages = useMemo(() => {
    const GROUPING_WINDOW_MS = 2 * 60 * 1000
    const lowerSearch = searchQuery.trim().length >= 2 ? searchQuery.toLowerCase() : ''

    return displayMessages.map((msg, idx) => {
      let showDateSeparator = false
      if (msg.createdAt) {
        const msgDay = new Date(msg.createdAt).toDateString()
        const prevDay = idx > 0 && displayMessages[idx - 1]?.createdAt
          ? new Date(displayMessages[idx - 1]!.createdAt).toDateString()
          : null
        if (idx === 0 || msgDay !== prevDay) {
          showDateSeparator = true
        }
      }

      const prev = idx > 0 ? displayMessages[idx - 1] : null
      const isGrouped = !showDateSeparator
        && prev !== null
        && prev !== undefined
        && prev.role === msg.role
        && prev.sourceType === msg.sourceType
        && msg.sourceType !== 'system'
        && msg.sourceType !== 'cron'
        && msg.sourceType !== 'compacting'
        && msg.sourceType !== 'task'
        && msg.createdAt && prev!.createdAt
        && (new Date(msg.createdAt).getTime() - new Date(prev!.createdAt).getTime()) < GROUPING_WINDOW_MS

      const showTimeGap = !showDateSeparator && idx > 0 && !!msg.createdAt && !!displayMessages[idx - 1]?.createdAt
      const prevTimestamp = idx > 0 ? displayMessages[idx - 1]?.createdAt : undefined

      const isSearchMatch = lowerSearch !== '' && msg.content.toLowerCase().includes(lowerSearch)
      const isCurrentMatch = searchHighlightId === msg.id

      // Only animate messages that haven't been rendered before.
      // Suppress animation entirely during the initial load so messages
      // fetched from the DB don't all flash in.
      const isNew = initialLoadDoneRef.current && !knownMessageIdsRef.current.has(msg.id)
      knownMessageIdsRef.current.add(msg.id)

      return { msg, showDateSeparator, isGrouped: !!isGrouped, showTimeGap, prevTimestamp, isSearchMatch, isCurrentMatch, isNew }
    })
  }, [displayMessages, searchQuery, searchHighlightId])

  // Build a unified chronological timeline merging messages and live tasks
  type TimelineItem =
    | { kind: 'message'; entry: (typeof processedMessages)[number] }
    | { kind: 'liveTask'; task: LiveTask }

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = processedMessages.map((entry) => ({ kind: 'message' as const, entry }))
    for (const task of liveTasks) {
      items.push({ kind: 'liveTask' as const, task })
    }
    // Stable sort by createdAt (string ISO dates compare lexicographically)
    items.sort((a, b) => {
      const tsA = a.kind === 'message' ? a.entry.msg.createdAt : a.task.createdAt
      const tsB = b.kind === 'message' ? b.entry.msg.createdAt : b.task.createdAt
      if (tsA < tsB) return -1
      if (tsA > tsB) return 1
      // Keep messages before live tasks at the same timestamp
      if (a.kind === 'message' && b.kind === 'liveTask') return -1
      if (a.kind === 'liveTask' && b.kind === 'message') return 1
      return 0
    })
    return items
  }, [processedMessages, liveTasks])

  // Mark initial load as done after the first batch of messages is processed
  useEffect(() => {
    if (!initialLoadDoneRef.current && displayMessages.length > 0 && !isLoading) {
      initialLoadDoneRef.current = true
    }
  }, [displayMessages, isLoading])

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragEnter={handlePanelDragEnter}
      onDragLeave={handlePanelDragLeave}
      onDragOver={handlePanelDragOver}
      onDrop={handlePanelDrop}
    >
      {/* Full-area drop overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary rounded-lg transition-all animate-fade-in">
          <div className="flex flex-col items-center gap-3 text-primary">
            <div className="rounded-full bg-primary/10 p-4">
              <Upload className="size-8" />
            </div>
            <p className="text-sm font-medium">{t('chat.dropFiles')}</p>
          </div>
        </div>
      )}

      {/* Conversation header */}
      <ConversationHeader
        kinId={kin.id}
        name={kin.name}
        role={kin.role}
        model={kin.model}
        providerId={kin.providerId}
        avatarUrl={kin.avatarUrl}
        llmModels={llmModels}
        modelUnavailable={modelUnavailable}
        messageCount={messages.length}
        estimatedTokens={queueState?.contextTokens ?? 0}
        maxTokens={queueState?.contextWindow ?? 0}
        apiContextTokens={queueState?.apiContextTokens}
        contextBreakdown={queueState?.contextBreakdown}
        pipelineStatus={queueState?.pipelineStatus}
        compactingPercent={queueState?.compactingPercent}
        compactingThresholdPercent={queueState?.compactingThresholdPercent}
        summaryCount={queueState?.summaryCount}
        maxSummaries={queueState?.maxSummaries}
        summaryTokens={queueState?.summaryTokens}
        summaryBudgetTokens={queueState?.summaryBudgetTokens}
        toolCallCount={toolCallCount}
        isToolCallsOpen={isToolCallsOpen}
        queueState={queueState}
        onModelChange={onModelChange}
        onToggleToolCalls={toggleToolCalls}
        onForceCompact={handleForceCompact}
        isCompacting={isCompacting}
        onEdit={onEditKin}
        onQuickSession={handleQuickSession}
        onExportMarkdown={exportAsMarkdown}
        onExportJSON={exportAsJSON}
        onSearch={toggleSearch}
        onClearConversation={clearConversation}
        messages={messages}
        scrollViewportRef={scrollAreaRef}
        thinkingEnabled={thinkingEnabled}
        thinkingEffort={thinkingEffort}
        onChangeThinking={updateThinking}
        onViewUsage={onOpenSettings ? () => onOpenSettings('tokenUsage', { kinId: kin.id }) : undefined}
      />

      {/* Search bar */}
      {isSearchOpen && (
        <Suspense fallback={null}>
          <ConversationSearch
            onClose={toggleSearch}
            onSearchChange={handleSearchChange}
            messages={displayMessages}
            hasMore={hasMore}
          />
        </Suspense>
      )}

      {/* Middle: messages + optional tool calls panel */}
      <div className="flex min-h-0 flex-1">
        {/* Messages area */}
        <div ref={scrollAreaRef} className="relative min-h-0 flex-1 flex flex-col">
        <ScrollArea className="min-h-0 flex-1">
          <SearchHighlightProvider value={searchQuery}>
          <MentionLookupProvider users={mentionableUsers} kins={mentionableKins}>
          <div className="mx-auto max-w-3xl py-4">
            {/* Sentinel for infinite scroll — triggers loading older messages */}
            {hasMore && <div ref={topSentinelRef} className="h-px" />}
            {isLoadingMore && (
              <div className="flex items-center justify-center py-4">
                <div className="size-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                <span className="ml-2 text-xs text-muted-foreground">{t('chat.loadingOlder')}</span>
              </div>
            )}
            {isLoading && messages.length === 0 ? (
              <div className="flex flex-col gap-4 py-8 animate-fade-in">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className={`flex gap-3 ${i % 2 === 0 ? '' : 'flex-row-reverse'}`}>
                    <div className="size-8 shrink-0 rounded-full bg-muted animate-pulse" />
                    <div className={`flex flex-col gap-1.5 ${i % 2 === 0 ? '' : 'items-end'}`}>
                      <div className="h-4 rounded bg-muted animate-pulse" style={{ width: `${120 + (i * 37) % 160}px` }} />
                      <div className="h-4 rounded bg-muted animate-pulse" style={{ width: `${80 + (i * 53) % 120}px` }} />
                    </div>
                  </div>
                ))}
              </div>
            ) : messages.length === 0 && liveTasks.length === 0 ? (
              <ChatEmptyState
                kinName={kin.name}
                kinRole={kin.role}
                kinAvatarUrl={kin.avatarUrl}
                onSendMessage={handleSend}
              />
            ) : (
              <div className="space-y-1">
                {timeline.map((item) => {
                  if (item.kind === 'liveTask') {
                    const task = item.task
                    return (
                      <TaskResultCard
                        key={`live-${task.taskId}`}
                        mode="live"
                        taskId={task.taskId}
                        status={task.status}
                        title={task.title}
                        senderName={task.senderName}
                        senderAvatarUrl={task.senderAvatarUrl}
                        result={task.result}
                        error={task.error}
                        createdAt={task.createdAt}
                        onOpenDetail={() => openTask({ taskId: task.taskId, kinName: task.senderName ?? kin.name, kinAvatarUrl: task.senderAvatarUrl ?? kin.avatarUrl })}
                      />
                    )
                  }

                  const { msg, showDateSeparator, isGrouped, showTimeGap, prevTimestamp, isSearchMatch, isCurrentMatch, isNew } = item.entry
                  const dateSeparator = showDateSeparator
                    ? <DateSeparator key={`date-${msg.id}`} date={msg.createdAt} />
                    : null

                  const timeGap = showTimeGap && prevTimestamp
                    ? <TimeGapIndicator key={`gap-${msg.id}`} prevTimestamp={prevTimestamp} currentTimestamp={msg.createdAt} />
                    : null

                  if (msg.sourceType === 'compacting') {
                    const isCompactingError = !!msg.compactingError
                    return (
                      <React.Fragment key={msg.id}>
                        {dateSeparator}
                        {timeGap}
                        <CompactingCard
                          status={isCompactingError ? 'error' : 'done'}
                          summary={msg.content || null}
                          memoriesExtracted={msg.memoriesExtracted}
                          error={msg.compactingError ?? undefined}
                          timestamp={msg.createdAt}
                        />
                      </React.Fragment>
                    )
                  }

                  const isFromUser = msg.role === 'user' && msg.sourceType === 'user'
                  const isFromKin = msg.sourceType === 'kin' && msg.role === 'user'
                  const isTask = msg.sourceType === 'task'
                  return (
                    <React.Fragment key={`wrap-${msg.id}`}>
                    {dateSeparator}
                    {timeGap}
                    <div
                      data-message-id={msg.id}
                      className={cn(
                        'transition-colors duration-300',
                        isCurrentMatch && 'bg-primary/10 rounded-lg',
                        isSearchMatch && !isCurrentMatch && 'bg-primary/5 rounded-lg',
                      )}
                    >
                    <MessageBubble
                      key={msg.id}
                      role={msg.role}
                      content={msg.content}
                      sourceType={msg.sourceType}
                      files={msg.files}
                      avatarUrl={
                        isFromUser
                          ? user?.avatarUrl
                          : (isFromKin || isTask)
                            ? msg.sourceAvatarUrl ?? kin.avatarUrl
                            : kin.avatarUrl
                      }
                      senderName={
                        isFromUser
                          ? (user?.pseudonym ?? user?.firstName)
                          : (isFromKin || isTask)
                            ? msg.sourceName ?? kin.name
                            : kin.name
                      }
                      userInitials={isFromUser ? userInitials : undefined}
                      timestamp={msg.createdAt}
                      toolCalls={toolCallsByMessage.get(msg.id)}
                      injectedMemories={msg.injectedMemories}
                      stepLimitReached={msg.stepLimitReached}
                      isRedacted={msg.isRedacted}
                      isGrouped={isGrouped}
                      isNew={isNew}
                      messageId={msg.id}
                      resolvedTaskId={msg.resolvedTaskId}
                      onOpenTaskDetail={isTask && msg.resolvedTaskId ? ((taskId: string) => {
                        const lt = liveTasks.find((t) => t.taskId === taskId)
                        openTask({ taskId, kinName: lt?.senderName ?? kin.name, kinAvatarUrl: lt?.senderAvatarUrl ?? kin.avatarUrl })
                      }) : undefined}
                      reactions={msg.reactions}
                      currentUserId={user?.id}
                      onToggleReaction={toggleReaction}
                      onQuoteReply={handleQuoteReply}
                      onEditResend={handleEditResend}
                      onRegenerate={msg.id === lastAssistantMsgId && !isStreaming && !isProcessing ? handleRegenerate : undefined}
                      tokenUsage={msg.tokenUsage}
                      providerType={currentProviderType}
                      reasoning={streamingMessage && msg.id === streamingMessage.id ? streamingReasoning : msg.reasoning ?? undefined}
                      channelContextLine={msg.channelContextLine}
                      channelBrandColor={msg.channelMeta?.brandColor ?? null}
                      channelPlatformOverride={msg.channelMeta?.platform ?? null}
                      systemEvent={msg.systemEvent}
                      currentKinName={kin.name}
                      currentKinAvatarUrl={kin.avatarUrl}
                    />
                    </div>
                    </React.Fragment>
                  )
                })}
                {liveCompacting && (
                  <CompactingCard
                    status={liveCompacting.status}
                    summary={liveCompacting.summary}
                    memoriesExtracted={liveCompacting.memoriesExtracted}
                    messageCount={liveCompacting.messageCount}
                    cycle={liveCompacting.cycle}
                    estimatedTotal={liveCompacting.estimatedTotal}
                    error={liveCompacting.error}
                    timestamp={liveCompacting.startedAt}
                  />
                )}
                {pendingPrompts.map((prompt) => (
                  <HumanPromptCard
                    key={prompt.id}
                    prompt={prompt}
                    onRespond={respondToPrompt}
                    isResponding={isResponding}
                  />
                ))}
                {queueState?.isProcessing && !(streamingMessage && streamingMessage.content.length > 0 && !tokenStalled) && (
                  <TypingIndicator kinName={kin.name} kinAvatarUrl={kin.avatarUrl} startedAt={queueState?.processingStartedAt} />
                )}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          </MentionLookupProvider>
          </SearchHighlightProvider>
        </ScrollArea>
          {showScrollTop && !showScrollBottom && (
            <button
              onClick={scrollToTop}
              className="absolute top-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-lg transition-opacity hover:opacity-90 hover:text-foreground"
              title={t('chat.scrollToTop')}
            >
              <ArrowUp className="size-3.5" />
              {t('chat.scrollToTop')}
            </button>
          )}
          {showScrollBottom && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-opacity hover:opacity-90"
              title={t('chat.scrollToBottom')}
            >
              <ArrowDown className="size-3.5" />
              {newMessageCount > 0
                ? t('chat.newMessages', { count: newMessageCount })
                : t('chat.scrollToBottom')}
            </button>
          )}
          {/* Auto-scroll toggle — pinned bottom-right */}
          <button
            onClick={toggleAutoScroll}
            className={cn(
              'absolute bottom-4 right-4 z-10 flex items-center justify-center size-8 rounded-full shadow-lg transition-colors',
              autoScroll
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
            title={autoScroll ? t('chat.autoScroll.on') : t('chat.autoScroll.off')}
          >
            {autoScroll ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
          </button>
        </div>

        {/* Tool calls side panel — animated width wrapper */}
        <div
          className={`shrink-0 overflow-hidden transition-[width] duration-300 ease-out ${
            isToolCallsOpen ? 'w-80 lg:w-96' : 'w-0'
          }`}
        >
          <ToolCallsViewer
            toolCalls={toolCalls}
            toolCallCount={toolCallCount}
            onClose={toggleToolCalls}
          />
        </div>

        {/* Mini-app side panel */}
        <Suspense fallback={null}>
          <MiniAppViewer />
        </Suspense>
      </div>

      {/* Queue preview */}
      <QueuePreview
        items={queueItems}
        isRemoving={isRemovingQueueItem}
        onRemove={removeQueueItem}
        isStreaming={isStreaming}
        onInject={injectQueueItem}
      />

      {/* Input */}
      <MessageInput
        ref={inputRef}
        value={draftContent}
        onChange={setDraftContent}
        onSend={handleSend}
        onStop={stopStreaming}
        onInject={handleInject}
        onCommand={handleCommand}
        isStreaming={isStreaming}
        isProcessing={isProcessing}
        disabled={modelUnavailable || isCompacting}
        disabledReason={isCompacting ? t('chat.compacting.inputDisabled') : modelUnavailable ? t('kin.modelUnavailableInput') : undefined}
        pendingFiles={pendingFiles}
        isUploading={isUploading}
        onAddFiles={addFiles}
        onRemoveFile={removeFile}
        kinId={kin.id}
        mentionableUsers={mentionableUsers}
        mentionableKins={mentionableKins}
      />

      {/* Task detail modal — kept as fallback for legacy references */}

      {/* Quick session side panel */}
      <Sheet open={isQuickOpen} onOpenChange={(open) => { setQuickOpen(open); if (!open) setShowQuickHistory(false) }}>
        <SheetContent side="right" className="w-full sm:w-[520px] md:w-[680px] lg:w-[780px] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">{t('chat.quickChat')}</SheetTitle>
          {showQuickHistory ? (
            <Suspense fallback={null}>
              <QuickSessionHistory
                kinId={kin.id}
                kinName={kin.name}
                kinAvatarUrl={kin.avatarUrl}
                onBack={() => setShowQuickHistory(false)}
              />
            </Suspense>
          ) : activeSession ? (
            <Suspense fallback={null}>
              <QuickChatPanel
                kinId={kin.id}
                kinName={kin.name}
                kinAvatarUrl={kin.avatarUrl}
                kinModel={kin.model}
                llmModels={llmModels}
                sessionId={activeSession.id}
                expiresAt={activeSession.expiresAt}
                onHide={() => setQuickOpen(false)}
                onEnd={handleQuickClose}
                onModelChange={onModelChange}
                onShowHistory={() => setShowQuickHistory(true)}
              />
            </Suspense>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="text-sm text-muted-foreground">{t('quickChat.expired.message')}</p>
              <Button variant="outline" size="sm" onClick={() => { setQuickOpen(false); createSession() }}>
                {t('quickChat.expired.startNew')}
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
