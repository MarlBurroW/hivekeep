import React, { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback, startTransition, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { MessageBubble } from '@/client/components/chat/MessageBubble'
import { MessageInput, type MessageInputHandle } from '@/client/components/chat/MessageInput'
import { AgentToolsModal } from '@/client/components/agent/AgentToolsModal'
import { FeedbackBanner } from '@/client/components/feedback/FeedbackBanner'
import { useAgentTools } from '@/client/hooks/useAgentTools'
import { TypingIndicator } from '@/client/components/chat/TypingIndicator'
import { ConversationHeader } from '@/client/components/chat/ConversationHeader'
import { ToolCallsViewer } from '@/client/components/chat/ToolCallsViewer'
import { TaskResultCard } from '@/client/components/chat/TaskResultCard'
import { CompactingCard } from '@/client/components/chat/CompactingCard'
import { HumanPromptCard } from '@/client/components/chat/HumanPromptCard'
import { SecretPromptModal } from '@/client/components/chat/SecretPromptModal'
import { Sheet, SheetContent, SheetTitle } from '@/client/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { SidebarTrigger } from '@/client/components/ui/sidebar'
const QuickChatPanel = lazy(() => import('@/client/components/chat/QuickChatPanel').then(m => ({ default: m.QuickChatPanel })))
const QuickSessionHistory = lazy(() => import('@/client/components/chat/QuickSessionHistory').then(m => ({ default: m.QuickSessionHistory })))
import { useChat, type LiveTask } from '@/client/hooks/useChat'
import { useToolCalls } from '@/client/hooks/useToolCalls'
import { useHumanPrompts } from '@/client/hooks/useHumanPrompts'
import { useQuickSession } from '@/client/hooks/useQuickSession'
import { useAuth } from '@/client/hooks/useAuth'
import { useReactions } from '@/client/hooks/useReactions'
import { useDraftMessage } from '@/client/hooks/useDraftMessage'
import { WorkspacePathProvider } from '@/client/contexts/WorkspacePathContext'
import { useQueueItems } from '@/client/hooks/useQueueItems'
import { useFileUpload } from '@/client/hooks/useFileUpload'
import { useExportConversation } from '@/client/hooks/useExportConversation'
const ConversationSearch = lazy(() => import('@/client/components/chat/ConversationSearch').then(m => ({ default: m.ConversationSearch })))
const OrphanTaskDialog = lazy(() => import('@/client/components/chat/OrphanTaskDialog').then(m => ({ default: m.OrphanTaskDialog })))
import { QueuePreview } from '@/client/components/chat/QueuePreview'
import type { ContextTokenBreakdown, ContextPipelineStatus, AgentThinkingEffort } from '@/shared/types'
import { ChatEmptyState } from '@/client/components/chat/ChatEmptyState'
import { ChatAvatar } from '@/client/components/chat/ChatAvatar'
import { DateSeparator } from '@/client/components/chat/DateSeparator'
import { TimeGapIndicator } from '@/client/components/chat/TimeGapIndicator'
import { SearchHighlightProvider } from '@/client/components/chat/SearchHighlightContext'
import { MentionLookupProvider } from '@/client/components/chat/MentionContext'
import { useMentionables } from '@/client/hooks/useMentionables'
import { cn, getUserInitials } from '@/client/lib/utils'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { ArrowDown, ArrowUp, Upload, Pin, PinOff, AlertTriangle, Bot, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, getErrorMessage } from '@/client/lib/api'

interface AgentInfo {
  id: string
  name: string
  role: string
  model: string
  providerId: string | null
  avatarUrl: string | null
  thinkingEnabled?: boolean
  thinkingEffort?: AgentThinkingEffort | null
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
  agent: AgentInfo
  llmModels: LLMModel[]
  modelUnavailable?: boolean
  queueState?: { isProcessing: boolean; queueSize: number; processingStartedAt?: number; contextTokens?: number; contextWindow?: number; apiContextTokens?: number; contextBreakdown?: ContextTokenBreakdown; pipelineStatus?: ContextPipelineStatus; compactingPercent?: number; compactingThresholdPercent?: number; summaryCount?: number; maxSummaries?: number; summaryTokens?: number; summaryBudgetTokens?: number; keepPercent?: number }
  onModelChange: (modelId: string, providerId: string) => void
  onEditAgent: (opts?: { initialTab?: 'tools' }) => void
  onOpenSettings?: (section?: string, filters?: { agentId?: string }) => void
  /** Distraction-less variant (used by the onboarding modal): renders a minimal
   *  header (avatar + name only, no model picker / actions toolbar) and drops the
   *  desktop sidebar trigger. Everything else (messages, input, prompts, secure
   *  input) is unchanged. */
  compact?: boolean
  /** When true, reasoning/thinking blocks are hidden in every message (used by
   *  the onboarding modal so Queenie's meta-reasoning doesn't break first-use
   *  magic). The same thread shows thinking normally in the regular chat. */
  hideThinking?: boolean
}

/** The scrollable element inside a ScrollArea, where scrollTop/scrollHeight live. */
function getScrollViewport(scrollArea: HTMLElement | null): HTMLElement | null {
  return scrollArea?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null
}

export function ChatPanel({ agent, llmModels, modelUnavailable = false, queueState, onModelChange, onEditAgent, onOpenSettings, compact = false, hideThinking = false }: ChatPanelProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const userInitials = user ? getUserInitials(user) : 'U'
  const { messages, streamingMessage, streamingReasoning, streamingOutputTokens, liveTasks, liveCompacting, isLoading, isStreaming, hasMore, isLoadingMore, tokenStalled, sendMessage, stopStreaming, clearConversation, deleteMessage, rewindToMessage, fetchOlderMessages } = useChat(agent.id)
  const { toolCalls, toolCallCount, streamingToolCallCount, toolCallsByMessage } = useToolCalls(agent.id, messages)
  const { prompts: pendingPrompts, respond: respondToPrompt, isResponding } = useHumanPrompts(agent.id)
  const { content: draftContent, setContent: setDraftContent, clearDraft } = useDraftMessage(agent.id)
  const { items: queueItems, removeItem: removeQueueItem, injectItem: injectQueueItem, isRemoving: isRemovingQueueItem } = useQueueItems(agent.id)
  const { pendingFiles, addFiles, removeFile, clearFiles, isUploading } = useFileUpload(agent.id)
  const { activeSession, isOpen: isQuickOpen, setIsOpen: setQuickOpen, createSession, closeSession } = useQuickSession(agent.id)
  const [showQuickHistory, setShowQuickHistory] = useState(false)
  const { exportAsMarkdown, exportAsJSON } = useExportConversation(messages, agent.name)
  const { users: mentionableUsers, agents: mentionableAgents } = useMentionables()
  const { toggleReaction } = useReactions(agent.id)
  const [thinkingEnabled, setThinkingEnabled] = useState(agent.thinkingEnabled ?? false)
  const [isToolCallsOpen, setIsToolCallsOpen] = useState(false)
  // Pending "rewind to here" target — the confirmation dialog owns the actual call.
  const [rewindTarget, setRewindTarget] = useState<string | null>(null)
  // Tools badge: the agent's resolved toolset + its listing modal.
  const { tools: agentTools, count: agentToolCount, refetch: refetchAgentTools } = useAgentTools(agent.id)
  const [toolsModalOpen, setToolsModalOpen] = useState(false)
  const { openTask } = useSidePanel()
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

  const [thinkingEffort, setThinkingEffort] = useState<AgentThinkingEffort | null>(agent.thinkingEffort ?? null)

  // Sync thinking state from prop when agent changes
  useEffect(() => {
    setThinkingEnabled(agent.thinkingEnabled ?? false)
    setThinkingEffort(agent.thinkingEffort ?? null)
  }, [agent.id, agent.thinkingEnabled, agent.thinkingEffort])

  const updateThinking = useCallback(async (next: { enabled: boolean; effort: AgentThinkingEffort | null }) => {
    const prevEnabled = thinkingEnabled
    const prevEffort = thinkingEffort
    setThinkingEnabled(next.enabled)
    setThinkingEffort(next.effort)
    try {
      await api.patch(`/agents/${agent.id}`, { thinkingConfig: { enabled: next.enabled, effort: next.effort } })
    } catch {
      setThinkingEnabled(prevEnabled)
      setThinkingEffort(prevEffort)
    }
  }, [thinkingEnabled, thinkingEffort, agent.id])

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
  const [isOrphanTaskOpen, setIsOrphanTaskOpen] = useState(false)
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
  // Message count captured when a page was requested, so the settle handler can
  // tell whether that page actually prepended anything. null = no page in flight.
  const pendingPageCountRef = useRef<number | null>(null)
  const knownMessageIdsRef = useRef<Set<string>>(new Set())
  const initialLoadDoneRef = useRef(false)

  const toggleToolCalls = useCallback(() => setIsToolCallsOpen((prev) => !prev), [])
  const openToolCalls = useCallback(() => setIsToolCallsOpen(true), [])
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
      await api.post(`/agents/${agent.id}/compacting/run`)
    } catch (err: unknown) {
      const code = (err as { error?: { code?: string } })?.error?.code
      if (code === 'NOTHING_TO_COMPACT') {
        toast.info(t('chat.compacting.nothingToCompact'))
      } else {
        toast.error(t('chat.compacting.error'))
      }
    }
  }, [agent.id, t])

  const handleForceReset = useCallback(async () => {
    try {
      await api.post(`/agents/${agent.id}/force-reset`)
      toast.success(t('chat.forceResetDone'))
    } catch (err: unknown) {
      toast.error(getErrorMessage(err))
    }
  }, [agent.id, t])

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

  // Reset known message IDs when switching agents
  useEffect(() => {
    knownMessageIdsRef.current = new Set()
    initialLoadDoneRef.current = false
  }, [agent.id])

  // Auto-focus message input when switching agents
  useEffect(() => {
    // Small delay to ensure the input is mounted and ready
    const timer = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [agent.id])

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

  // On mount (fresh for each agent thanks to key=agent.id), scroll to bottom
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

  const messageCountRef = useRef(messages.length)
  messageCountRef.current = messages.length

  // Single owner of the "request the next page" protocol: arm the scroll-restore
  // handoff, block the observer, remember the pre-fetch count. Both the observer
  // and the post-load re-check go through here so the three writes stay together.
  const requestOlderPage = useCallback((viewport: HTMLElement) => {
    // fetchOlderMessages bails on an empty list without ever toggling
    // isLoadingMore, which would leave the guard ref latched true forever.
    if (messageCountRef.current === 0) return
    pendingPageCountRef.current = messageCountRef.current
    prevScrollHeightRef.current = viewport.scrollHeight
    isLoadingMoreRef.current = true
    fetchOlderMessagesRef.current()
  }, [])

  // IntersectionObserver — trigger loading older messages when top sentinel is visible.
  // Uses a ref for the callback + hasMore to keep the observer stable and avoid
  // reconnection loops that would cause infinite fetch cascades.
  useEffect(() => {
    const sentinel = topSentinelRef.current
    const viewport = getScrollViewport(scrollAreaRef.current)
    if (!sentinel || !viewport) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMoreRef.current) {
          requestOlderPage(viewport)
        }
      },
      { root: viewport, threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  // Only reconnect observer when hasMore or agent changes — NOT on every message/callback change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, agent.id])

  // Keep isLoadingMoreRef in sync for the observer guard.
  useEffect(() => {
    isLoadingMoreRef.current = isLoadingMore
  }, [isLoadingMore])

  // When a page settles, re-check the sentinel manually: IntersectionObserver
  // only fires on crossings, so a short page can leave the sentinel inside the
  // viewport and pagination would stall until the user jiggles the scroll.
  useEffect(() => {
    if (isLoadingMore) return
    const pendingCount = pendingPageCountRef.current
    if (pendingCount === null) return
    pendingPageCountRef.current = null
    if (pendingCount === messages.length) {
      // The page prepended nothing: rows already loaded, or a failed request.
      // The cursor hasn't moved, so re-firing would re-request the identical
      // page forever. Drop the armed scroll-restore too, since the layout
      // effect that consumes it only runs on a length change and would
      // otherwise apply this stale height to some later, unrelated update.
      prevScrollHeightRef.current = null
      return
    }
    if (!hasMore) return
    const sentinel = topSentinelRef.current
    const viewport = getScrollViewport(scrollAreaRef.current)
    if (!sentinel || !viewport) return
    const vRect = viewport.getBoundingClientRect()
    const sRect = sentinel.getBoundingClientRect()
    if (sRect.bottom >= vRect.top && sRect.top <= vRect.bottom) {
      requestOlderPage(viewport)
    }
  }, [isLoadingMore, hasMore, messages.length, requestOlderPage])

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
    const scrollToEnd = () => {
      // Capture scroll state synchronously at mutation time, before a resize/
      // scroll handler can flip isNearBottomRef to false due to the content
      // growth itself. This capture is what makes gating on near-bottom safe
      // during streaming: after each auto-scroll we reset the ref to true, so
      // only a REAL user scroll away from the bottom flips it, and that must
      // pause auto-scroll (streaming included), otherwise the user can never
      // scroll up to read history while the Agent responds.
      const nearNow = isNearBottomRef.current
      if (rafId !== null) {
        // Already coalescing — keep the most permissive state
        pendingNearBottom = pendingNearBottom || nearNow
        return
      }
      pendingNearBottom = nearNow
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!autoScrollRef.current) return
        if (!pendingNearBottom) return
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

  // Keep a ref for autoScroll so the MutationObserver callback can read it
  const autoScrollRef = useRef(autoScroll)
  useEffect(() => { autoScrollRef.current = autoScroll }, [autoScroll])

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

  // Jump to the bottom and re-arm auto-scroll. Deliberately instant: a smooth
  // animation emits scroll events for hundreds of ms, and each one re-runs
  // checkNearBottom, which flips isNearBottomRef back to false while the
  // animation is still far from the bottom. Tokens arriving in that window
  // would then be gated out and the reply would stream off-screen.
  const jumpToBottom = useCallback(() => {
    const viewport = getScrollViewport(scrollAreaRef.current)
    if (!viewport) return
    viewport.scrollTop = viewport.scrollHeight
    isNearBottomRef.current = true
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

  // Resolve agent info for the currently open task detail modal
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
        // Sending from a scrolled-up position must bring the user's own message
        // (and the upcoming reply) into view. Auto-scroll alone won't, since it
        // respects the scrolled-away state.
        jumpToBottom()
      } else {
        toast.error(t('chat.sendFailed'))
      }
    },
    [sendMessage, clearDraft, clearFiles, pendingFiles, t, jumpToBottom],
  )

  // Inject a message into the current streaming response (/btw)
  const handleInject = useCallback(
    async (content: string) => {
      try {
        await api.post(`/agents/${agent.id}/messages/inject`, { content })
        clearDraft()
      } catch {
        toast.error(t('chat.sendFailed'))
      }
    },
    [agent.id, clearDraft, t],
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

  // Newest persisted message — "rewind to here" on it would be a no-op, so the
  // action is hidden there.
  const lastDisplayMsgId = messages.length > 0 ? messages[messages.length - 1]!.id : null

  // Merge streaming message into the display list so it renders in the same
  // React tree branch as persisted messages — prevents unmount/remount (and
  // entrance animation replay) when the stream completes.
  const displayMessages = useMemo(() => {
    // Hide the internal instruction injected by the force-compact endpoint
    // (sourceType 'compacting_followup'). It's a user-role message in the DB
    // because that's how the engine consumes queue items, but it's actually
    // an internal trigger to make the agent acknowledge the compaction +
    // refresh the navbar context counter — the user never typed it and
    // shouldn't see it as if they did. The agent's reply (sourceType 'agent')
    // stays visible.
    const filtered = messages.filter((m) => m.sourceType !== 'compacting_followup')
    if (!streamingMessage) return filtered
    if (filtered.some(m => m.id === streamingMessage.id)) return filtered
    // Only render the streaming bubble once it actually carries something to
    // show: text content, reasoning, or a tool call. The streaming message is
    // seeded with empty content as soon as the turn starts (or when reasoning
    // tokens arrive before the first text token, since reasoning lives in a
    // separate batched state), so merging it unconditionally flashed a blank
    // bubble *alongside* the typing indicator until the first token landed.
    // Same guard as the task panel (TaskPanelContent).
    const hasContent = streamingMessage.content.length > 0
    // When thinking is hidden (onboarding), reasoning-only doesn't count toward
    // showing the bubble — otherwise a blank bubble would flash next to the
    // typing indicator while Queenie "thinks" before the first text token.
    const hasReasoning = !hideThinking && streamingReasoning.length > 0
    const hasToolCalls = (toolCallsByMessage.get(streamingMessage.id)?.length ?? 0) > 0
    if (!hasContent && !hasReasoning && !hasToolCalls) return filtered
    return [...filtered, streamingMessage]
  }, [messages, streamingMessage, streamingReasoning, toolCallsByMessage, hideThinking])

  const handleSearchChange = useCallback((query: string, matchIndex: number, matchCount: number) => {
    setSearchQuery(query)
    if (query.trim().length < 2 || matchCount === 0) {
      setSearchHighlightId(null)
      return
    }
    // Find the matching message id
    const lowerQuery = query.toLowerCase()
    const matchingMessages = displayMessages.filter((m) => (m.content ?? '').toLowerCase().includes(lowerQuery))
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

      const isSearchMatch = lowerSearch !== '' && (msg.content ?? '').toLowerCase().includes(lowerSearch)
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
    // Anchor live task cards to the assistant message that spawned them when
    // we know it (triggerMessageId set by the task:status SSE, see useChat).
    // A task spawned mid-turn carries the id of the in-flight assistant
    // message; rendering the card right under that message keeps the logical
    // order. Tasks with no trigger (webhooks, crons, restored-after-navigation)
    // or whose trigger message isn't in the current window fall back to the
    // createdAt-based placement as standalone timeline items.
    const messageIds = new Set(processedMessages.map((e) => e.msg.id))
    const anchoredByMessage = new Map<string, LiveTask[]>()
    const orphanTasks: LiveTask[] = []
    for (const task of liveTasks) {
      if (task.triggerMessageId && messageIds.has(task.triggerMessageId)) {
        const list = anchoredByMessage.get(task.triggerMessageId)
        if (list) list.push(task)
        else anchoredByMessage.set(task.triggerMessageId, [task])
      } else {
        orphanTasks.push(task)
      }
    }

    // Sort anchored tasks within each message group by createdAt so multiple
    // spawns in the same turn keep a stable, chronological order.
    for (const list of anchoredByMessage.values()) {
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    }

    const items: TimelineItem[] = processedMessages.map((entry) => ({ kind: 'message' as const, entry }))
    for (const task of orphanTasks) {
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

    // Splice anchored tasks in right after their trigger message.
    if (anchoredByMessage.size === 0) return items
    const result: TimelineItem[] = []
    for (const item of items) {
      result.push(item)
      if (item.kind === 'message') {
        const anchored = anchoredByMessage.get(item.entry.msg.id)
        if (anchored) {
          for (const task of anchored) {
            result.push({ kind: 'liveTask' as const, task })
          }
        }
      }
    }
    return result
  }, [processedMessages, liveTasks])

  // Mark initial load as done after the first batch of messages is processed
  useEffect(() => {
    if (!initialLoadDoneRef.current && displayMessages.length > 0 && !isLoading) {
      initialLoadDoneRef.current = true
    }
  }, [displayMessages, isLoading])

  // Memoize the whole message-list subtree as a stable element. ChatPanel
  // re-renders on every keystroke in the composer (the draft lives here, in
  // useDraftMessage), but none of these deps change while typing — so this
  // returns the SAME element reference and React skips reconciling the entire
  // (non-virtualized, potentially huge) list. It still recomputes during
  // streaming/new messages because streamingMessage/timeline/etc. are deps.
  const timelineContent = useMemo(() => (
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
                        onOpenDetail={() => openTask({ taskId: task.taskId, agentName: task.senderName ?? agent.name, agentAvatarUrl: task.senderAvatarUrl ?? agent.avatarUrl })}
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
                  const isFromAgent = msg.sourceType === 'agent' && msg.role === 'user'
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
                      compact={compact}
                      hideThinking={hideThinking}
                      files={msg.files}
                      avatarUrl={
                        isFromUser
                          ? user?.avatarUrl
                          : (isFromAgent || isTask)
                            ? msg.sourceAvatarUrl ?? agent.avatarUrl
                            : agent.avatarUrl
                      }
                      senderName={
                        isFromUser
                          ? (user?.pseudonym ?? user?.firstName)
                          : (isFromAgent || isTask)
                            ? msg.sourceName ?? agent.name
                            : agent.name
                      }
                      userInitials={isFromUser ? userInitials : undefined}
                      timestamp={msg.createdAt}
                      toolCalls={toolCallsByMessage.get(msg.id)}
                      stepLimitReached={msg.stepLimitReached}
                    emptyTurn={msg.emptyTurn}
                    finishReason={msg.finishReason}
                    silentStop={msg.silentStop}
                      isRedacted={msg.isRedacted}
                      isGrouped={isGrouped}
                      isNew={isNew}
                      messageId={msg.id}
                      resolvedTaskId={msg.resolvedTaskId}
                      onOpenTaskDetail={isTask && msg.resolvedTaskId ? ((taskId: string) => {
                        const lt = liveTasks.find((t) => t.taskId === taskId)
                        openTask({ taskId, agentName: lt?.senderName ?? agent.name, agentAvatarUrl: lt?.senderAvatarUrl ?? agent.avatarUrl })
                      }) : undefined}
                      reactions={msg.reactions}
                      currentUserId={user?.id}
                      onToggleReaction={toggleReaction}
                      onQuoteReply={handleQuoteReply}
                      onEditResend={handleEditResend}
                      onRegenerate={msg.id === lastAssistantMsgId && !isStreaming && !isProcessing ? handleRegenerate : undefined}
                      onDeleteMessage={!compact && !isStreaming && !isProcessing ? deleteMessage : undefined}
                      onRewindHere={!compact && !isStreaming && !isProcessing && msg.id !== lastDisplayMsgId ? setRewindTarget : undefined}
                      tokenUsage={msg.tokenUsage}
                      reasoning={streamingMessage && msg.id === streamingMessage.id ? streamingReasoning : msg.reasoning ?? undefined}
                      channelContextLine={msg.channelContextLine}
                      channelBrandColor={msg.channelMeta?.brandColor ?? null}
                      channelPlatformOverride={msg.channelMeta?.platform ?? null}
                      systemEvent={msg.systemEvent}
                      currentAgentName={agent.name}
                      currentAgentAvatarUrl={agent.avatarUrl}
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
                <SecretPromptModal agentId={agent.id} />
                {queueState?.isProcessing && !(streamingMessage && streamingMessage.content.length > 0 && !tokenStalled) && (
                  <TypingIndicator
                    agentName={agent.name}
                    agentAvatarUrl={agent.avatarUrl}
                    startedAt={queueState?.processingStartedAt}
                    tokenCount={streamingOutputTokens}
                    toolCallCount={streamingToolCallCount}
                    onOpenToolCalls={openToolCalls}
                    onForceReset={handleForceReset}
                  />
                )}
              </div>
  ), [timeline, openTask, agent, compact, hideThinking, user, userInitials, toolCallsByMessage, liveTasks, toggleReaction, handleQuoteReply, handleEditResend, lastAssistantMsgId, isStreaming, isProcessing, handleRegenerate, deleteMessage, lastDisplayMsgId, setRewindTarget, streamingMessage, streamingReasoning, liveCompacting, pendingPrompts, respondToPrompt, isResponding, queueState, tokenStalled, streamingOutputTokens, streamingToolCallCount, openToolCalls, handleForceReset])

  return (
    <WorkspacePathProvider agentId={agent.id}>
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

      {/* Conversation header — minimal in compact (onboarding modal) mode */}
      {compact ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
          {agent.avatarUrl ? (
            <img src={agent.avatarUrl} alt={agent.name} className="size-9 rounded-full object-cover" />
          ) : (
            <div className="flex size-9 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bot className="size-5" />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{agent.name}</p>
            <p className="truncate text-xs text-muted-foreground">{agent.role}</p>
          </div>
          {queueState?.isProcessing && <Loader2 className="ml-auto size-4 animate-spin text-muted-foreground" />}
        </div>
      ) : (
      <ConversationHeader
        agentId={agent.id}
        name={agent.name}
        role={agent.role}
        model={agent.model}
        providerId={agent.providerId}
        avatarUrl={agent.avatarUrl}
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
        onEdit={onEditAgent}
        onStartTask={() => setIsOrphanTaskOpen(true)}
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
        onViewUsage={onOpenSettings ? () => onOpenSettings('tokenUsage', { agentId: agent.id }) : undefined}
        leading={<SidebarTrigger className="-ml-1 shrink-0 md:hidden" />}
      />
      )}

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

      {/* Orphan task launcher — standalone task on this Agent */}
      {isOrphanTaskOpen && (
        <Suspense fallback={null}>
          <OrphanTaskDialog
            open={isOrphanTaskOpen}
            onOpenChange={setIsOrphanTaskOpen}
            agentId={agent.id}
            agentName={agent.name}
          />
        </Suspense>
      )}

      {/* Middle: messages + optional tool calls panel */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Messages area — min-w-0 lets it shrink below its content width when
            the tool-calls panel opens, so wide content (code blocks) scrolls
            inside the ScrollArea instead of forcing the row to overflow
            ChatPanel and spill over the adjacent mini-app panel. */}
        <div ref={scrollAreaRef} className="relative min-h-0 min-w-0 flex-1 flex flex-col">
        {!compact && <FeedbackBanner />}
        <ScrollArea className="min-h-0 flex-1">
          <SearchHighlightProvider value={searchQuery}>
          <MentionLookupProvider users={mentionableUsers} agents={mentionableAgents}>
          {/* overflow-anchor:none: scroll position after prepending older pages
              is compensated manually (exact delta); letting the browser's native
              scroll anchoring also adjust would double-compensate and jump. */}
          <div className="mx-auto min-w-0 max-w-3xl py-4 px-2 md:px-0 [overflow-anchor:none]">
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
            ) : messages.length === 0 && liveTasks.length === 0 && !queueState?.isProcessing && !streamingMessage && !compact ? (
              /* Empty conversation: prompt-suggestion cards — but NOT while the
                 Agent is already inferring/streaming the first message (show the
                 typing indicator instead), and never in the distraction-less
                 onboarding modal (compact). */
              <ChatEmptyState
                agentName={agent.name}
                agentRole={agent.role}
                agentAvatarUrl={agent.avatarUrl}
                onSendMessage={handleSend}
              />
            ) : compact && displayMessages.length === 0 && liveTasks.length === 0 ? (
              /* Onboarding first-paint: Queenie's first greeting is generated by a
                 hidden kickoff trigger, so for the first few seconds the compact
                 conversation is genuinely empty (the empty-state cards are
                 suppressed in compact mode). Show a warm "getting ready" placeholder
                 instead of a blank panel. It disappears on its own the moment her
                 first message streams in (displayMessages.length becomes > 0). This
                 branch is gated on `compact`, so the normal chat is unaffected. */
              <div className="flex flex-col items-center justify-center gap-4 py-16 text-center animate-fade-in">
                <ChatAvatar
                  avatarUrl={agent.avatarUrl}
                  name={agent.name}
                  className="size-14"
                  fallbackClassName="text-base"
                />
                <p className="text-sm font-medium text-muted-foreground">
                  {t('onboarding.queenieGettingReady', { name: agent.name })}
                </p>
                <div className="flex gap-1" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-muted-foreground animate-typing-dot" />
                  <span className="size-1.5 rounded-full bg-muted-foreground animate-typing-dot delay-1" />
                  <span className="size-1.5 rounded-full bg-muted-foreground animate-typing-dot delay-2" />
                </div>
              </div>
            ) : (
              timelineContent
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
            onShowAvailableTools={() => { void refetchAgentTools(); setToolsModalOpen(true) }}
          />
        </div>

        {/* Mini-app / task side panel is mounted at ChatPage level
            so it works even when no Agent is selected (an empty Agents page can
            still preview a task or open a mini-app from the sidebar). */}
      </div>

      {/* Queue preview */}
      <QueuePreview
        items={queueItems}
        isRemoving={isRemovingQueueItem}
        onRemove={removeQueueItem}
        isStreaming={isStreaming}
        onInject={injectQueueItem}
      />

      {/* Model-unavailable banner — visible above the input when this
          Agent's configured model can't be resolved (provider deleted,
          plugin unloaded, family stripped from the row, …). The
          input is already disabled with a tooltip via `disabledReason`,
          but the tooltip requires hover; this banner makes the state
          + the fix discoverable at a glance. */}
      {modelUnavailable && (
        <div className="flex items-center justify-between gap-3 border-t bg-destructive/5 px-4 py-2">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-destructive">{t('agent.modelUnavailable')}</p>
              <p className="text-xs text-muted-foreground truncate">{t('agent.modelUnavailableHint')}</p>
            </div>
          </div>
          {onOpenSettings && (
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => onOpenSettings('providers')}>
              {t('agent.modelUnavailableAction')}
            </Button>
          )}
        </div>
      )}

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
        disabledReason={isCompacting ? t('chat.compacting.inputDisabled') : modelUnavailable ? t('agent.modelUnavailableInput') : undefined}
        pendingFiles={pendingFiles}
        isUploading={isUploading}
        onAddFiles={addFiles}
        onRemoveFile={removeFile}
        agentId={agent.id}
        mentionableUsers={mentionableUsers}
        mentionableAgents={mentionableAgents}
        llmModels={llmModels}
        model={agent.model}
        providerId={agent.providerId}
        onModelChange={onModelChange}
        thinkingEnabled={thinkingEnabled}
        thinkingEffort={thinkingEffort}
        onChangeThinking={updateThinking}
        toolCount={agentToolCount}
        onShowTools={() => { void refetchAgentTools(); setToolsModalOpen(true) }}
      />

      {/* Tools listing modal (composer tools badge) — mounted on demand so the
          tool catalog is only fetched when actually opened */}
      {toolsModalOpen && (
        <AgentToolsModal
          open={toolsModalOpen}
          onOpenChange={setToolsModalOpen}
          agentId={agent.id}
          agentName={agent.name}
          tools={agentTools}
          onEditTools={() => onEditAgent({ initialTab: 'tools' })}
        />
      )}

      {/* Task detail modal — kept as fallback for legacy references */}

      {/* Quick session side panel */}
      <Sheet open={isQuickOpen} onOpenChange={(open) => { setQuickOpen(open); if (!open) setShowQuickHistory(false) }}>
        <SheetContent side="right" className="w-full sm:w-[520px] md:w-[680px] lg:w-[780px] p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">{t('chat.quickChat')}</SheetTitle>
          {showQuickHistory ? (
            <Suspense fallback={null}>
              <QuickSessionHistory
                agentId={agent.id}
                agentName={agent.name}
                agentAvatarUrl={agent.avatarUrl}
                onBack={() => setShowQuickHistory(false)}
              />
            </Suspense>
          ) : activeSession ? (
            <Suspense fallback={null}>
              <QuickChatPanel
                agentId={agent.id}
                agentName={agent.name}
                agentAvatarUrl={agent.avatarUrl}
                agentModel={agent.model}
                llmModels={llmModels}
                sessionId={activeSession.id}
                expiresAt={activeSession.expiresAt}
                onHide={() => setQuickOpen(false)}
                onEnd={handleQuickClose}
                onShowHistory={() => setShowQuickHistory(true)}
                agentThinkingEnabled={thinkingEnabled}
                agentThinkingEffort={thinkingEffort}
                onEditTools={() => { setQuickOpen(false); onEditAgent({ initialTab: 'tools' }) }}
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

      {/* Rewind confirmation — destructive bulk delete, irreversible */}
      <AlertDialog open={rewindTarget !== null} onOpenChange={(o) => !o && setRewindTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.rewind.title', 'Rewind conversation?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chat.rewind.description', {
                count: rewindTarget ? Math.max(0, messages.length - 1 - messages.findIndex((m) => m.id === rewindTarget)) : 0,
                defaultValue: 'This message becomes the most recent one — about {{count}} later message(s) will be permanently deleted from the conversation and its context. This cannot be undone.',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (rewindTarget) void rewindToMessage(rewindTarget); setRewindTarget(null) }}
            >
              {t('chat.rewind.confirm', 'Rewind')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </WorkspacePathProvider>
  )
}
