import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Popover, PopoverTrigger, PopoverContent } from '@/client/components/ui/popover'
import { MessageBubble } from '@/client/components/chat/MessageBubble'
import { TokenUsageIndicator } from '@/client/components/chat/TokenUsageIndicator'
import { ToolCallsViewer } from '@/client/components/chat/ToolCallsViewer'
import { TypingIndicator } from '@/client/components/chat/TypingIndicator'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { HumanPromptCard } from '@/client/components/chat/HumanPromptCard'
import { TaskTodoList } from '@/client/components/sidebar/TaskTodoList'
import { ContextBar } from '@/client/components/chat/ContextBar'
import { useTaskDetail } from '@/client/hooks/useTaskDetail'
import { useHumanPrompts } from '@/client/hooks/useHumanPrompts'
import { useSSE } from '@/client/hooks/useSSE'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { cn } from '@/client/lib/utils'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { formatRelativeTime, formatDurationBetween, formatDurationMs, computeDurationMs } from '@/client/lib/time'
import { useNow } from '@/client/hooks/useNow'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/client/components/ui/dialog'
import {
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  UserCheck,
  MessageSquare,
  GitBranch,
  Layers,
  Wrench,
  Cpu,
  Sparkles,
  FileText,
  ListOrdered,
  Play,
  Pause,
  Send,
  Pin,
  PinOff,
  Lightbulb,
  History,
  ChevronDown,
  RotateCcw,
  GitFork,
} from 'lucide-react'
import { useAutoScroll } from '@/client/hooks/useAutoScroll'
import { api } from '@/client/lib/api'
import type { TaskStatus, ContextTokenBreakdown, TaskSummary } from '@/shared/types'

interface TasksResponse {
  tasks: TaskSummary[]
  total: number
  hasMore: boolean
}

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

interface TaskPanelContentProps {
  taskId: string
  kinName?: string
  kinAvatarUrl?: string | null
  llmModels?: LLMModel[]
}

const STATUS_CONFIG: Record<
  TaskStatus,
  {
    icon: typeof Clock
    iconClass: string
    badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline'
  }
> = {
  queued: { icon: ListOrdered, iconClass: 'text-orange-500', badgeVariant: 'outline' },
  pending: { icon: Clock, iconClass: 'text-muted-foreground', badgeVariant: 'secondary' },
  in_progress: { icon: Loader2, iconClass: 'animate-spin', badgeVariant: 'default' },
  paused: { icon: Pause, iconClass: 'text-amber-500', badgeVariant: 'outline' },
  awaiting_human_input: { icon: UserCheck, iconClass: 'text-warning animate-pulse', badgeVariant: 'outline' },
  awaiting_kin_response: { icon: MessageSquare, iconClass: 'text-info animate-pulse', badgeVariant: 'outline' },
  completed: { icon: CheckCircle2, iconClass: 'text-success', badgeVariant: 'outline' },
  failed: { icon: XCircle, iconClass: 'text-destructive', badgeVariant: 'destructive' },
  cancelled: { icon: Ban, iconClass: 'text-muted-foreground', badgeVariant: 'secondary' },
}

export function TaskPanelContent({
  taskId,
  kinName,
  kinAvatarUrl,
  llmModels = [],
}: TaskPanelContentProps) {
  const { t } = useTranslation()
  const {
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
    allToolCalls,
    toolCallCount,
    toolCallsByMessage,
    learningsSaved,
    todos,
  } = useTaskDetail(taskId)
  const { prompts: pendingPrompts, respond: respondToPrompt, isResponding } = useHumanPrompts(
    task ? task.parentKinId : null,
    taskId,
  )
  const [isToolCallsOpen, setIsToolCallsOpen] = useState(false)

  // Fetch context-preview for the task
  const [contextData, setContextData] = useState<{
    tokenEstimate: ContextTokenBreakdown
    contextWindow: number
    apiContextTokens?: number
  } | null>(null)
  useEffect(() => {
    if (!task?.parentKinId || !task?.id) { setContextData(null); return }
    fetch(`/api/kins/${task.parentKinId}/context-preview?taskId=${task.id}`)
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.tokenEstimate) {
          setContextData({
            tokenEstimate: data.tokenEstimate,
            contextWindow: data.contextWindow ?? 0,
            apiContextTokens: data.apiContextTokens ?? undefined,
          })
        }
      })
      .catch(() => {})
  }, [task?.parentKinId, task?.id])
  const [isPromptOpen, setIsPromptOpen] = useState(false)
  const [isRunPromptOpen, setIsRunPromptOpen] = useState(false)
  const toggleToolCalls = useCallback(() => setIsToolCallsOpen((prev) => !prev), [])

  // Sibling runs of the same cron — for the run selector
  const { openTask } = useSidePanel()
  const [siblingRuns, setSiblingRuns] = useState<TaskSummary[]>([])
  const [isLoadingRuns, setIsLoadingRuns] = useState(false)
  const [isRunSelectorOpen, setIsRunSelectorOpen] = useState(false)
  const cronId = task?.cronId ?? null
  const fetchSiblingRuns = useCallback(async () => {
    if (!cronId) { setSiblingRuns([]); return }
    setIsLoadingRuns(true)
    try {
      const data = await api.get<TasksResponse>(`/tasks?cronId=${cronId}&limit=50&offset=0`)
      setSiblingRuns(data.tasks)
    } catch {
      setSiblingRuns([])
    } finally {
      setIsLoadingRuns(false)
    }
  }, [cronId])
  useEffect(() => { fetchSiblingRuns() }, [fetchSiblingRuns])

  // Keep sibling-run statuses in sync via SSE
  useSSE({
    'task:status': (data) => {
      const tid = data.taskId as string
      const status = data.status as TaskStatus
      setSiblingRuns((prev) => prev.map((t) => t.id === tid ? { ...t, status, updatedAt: new Date().toISOString() } : t))
    },
    'task:done': (data) => {
      const tid = data.taskId as string
      const status = data.status as TaskStatus
      const title = (data.title as string) ?? null
      setSiblingRuns((prev) => prev.map((t) => t.id === tid ? { ...t, status, ...(title && { title }), updatedAt: new Date().toISOString() } : t))
    },
  })

  const handleSelectRun = useCallback((run: TaskSummary) => {
    setIsRunSelectorOpen(false)
    if (run.id === taskId) return
    openTask({
      taskId: run.id,
      kinName: run.sourceKinName ?? run.parentKinName ?? kinName,
      kinAvatarUrl: run.sourceKinAvatarUrl ?? run.parentKinAvatarUrl ?? kinAvatarUrl,
    })
  }, [openTask, taskId, kinName, kinAvatarUrl])

  // Filter out messages already represented elsewhere:
  const visibleMessages = useMemo(
    () => messages.filter((msg) =>
      !(msg.sourceType === 'system' && msg.role === 'user') &&
      msg.sourceType !== 'task' &&
      !(streamingMessage && msg.id === streamingMessage.id) &&
      !(msg.role === 'assistant' && !msg.content && !msg.toolCalls?.length)
    ),
    [messages, streamingMessage],
  )

  // Auto-scroll with toggle
  const { autoScroll, toggleAutoScroll, containerRef: scrollContainerRef, bottomRef } = useAutoScroll([
    visibleMessages.length,
    streamingMessage,
    isStreaming,
    pendingPrompts.length,
  ])

  const [isForceStarting, setIsForceStarting] = useState(false)

  const statusConfig = task ? STATUS_CONFIG[task.status] : null
  const StatusIcon = statusConfig?.icon
  const isQueued = task?.status === 'queued'
  const isRunning = task?.status === 'in_progress'
  const isPaused = task?.status === 'paused'
  const isActive = isRunning || isPaused || task?.status === 'pending' || task?.status === 'awaiting_human_input' || task?.status === 'awaiting_kin_response'
  const initials = kinName?.slice(0, 2).toUpperCase() ?? 'K'
  const resolvedModel = task?.model ? llmModels.find((m) => m.id === task.model) : null

  // Live + persisted run duration. Ticks every second while the task is active
  // (measured from startedAt), then freezes at endedAt once terminal. Null for
  // queued/pending tasks that haven't started executing yet.
  const isTerminal = task?.status === 'completed' || task?.status === 'failed' || task?.status === 'cancelled'
  const nowMs = useNow(isActive)
  const startedMs = task?.startedAt ? new Date(task.startedAt).getTime() : null
  const endedMs = task?.endedAt ? new Date(task.endedAt).getTime() : null
  const runMs = computeDurationMs(startedMs, isTerminal ? endedMs : null, nowMs)
  const runDuration = runMs != null ? formatDurationMs(runMs) : null

  const handleForceStart = useCallback(async () => {
    if (!task) return
    setIsForceStarting(true)
    try {
      await api.post(`/tasks/${task.id}/force-promote`)
    } catch {
      // Error handled by API layer
    } finally {
      setIsForceStarting(false)
    }
  }, [task])

  const [retryMode, setRetryMode] = useState<'fresh' | 'fork' | null>(null)
  const handleRetry = useCallback(async (preserveHistory: boolean) => {
    if (!task) return
    setRetryMode(preserveHistory ? 'fork' : 'fresh')
    try {
      const result = await api.post<{ taskId: string }>(`/tasks/${task.id}/retry`, { preserveHistory })
      if (result?.taskId) {
        openTask({ taskId: result.taskId, kinName, kinAvatarUrl })
      }
    } catch {
      // Error surfaced by the API layer's global toast
    } finally {
      setRetryMode(null)
    }
  }, [task, openTask, kinName, kinAvatarUrl])

  // Inject / Resume message input
  const [injectMessage, setInjectMessage] = useState('')
  const [isInjecting, setIsInjecting] = useState(false)

  const handleInject = useCallback(async () => {
    if (!injectMessage.trim()) return
    setIsInjecting(true)
    try {
      await injectIntoTask(injectMessage.trim())
      setInjectMessage('')
    } catch {
      // Error handled by API layer
    } finally {
      setIsInjecting(false)
    }
  }, [injectMessage, injectIntoTask])

  const handlePause = useCallback(async () => {
    await pauseTask()
  }, [pauseTask])

  const handleResume = useCallback(async () => {
    setIsInjecting(true)
    try {
      await resumeTask(injectMessage.trim() || undefined)
      setInjectMessage('')
    } catch {
      // Error handled by API layer
    } finally {
      setIsInjecting(false)
    }
  }, [injectMessage, resumeTask])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header info — restructured into 3 calm rows:
          1) avatar + title + status badge
          2) kin name · depth · mode · model · thinking effort · cron run selector
          3) action chips (tool calls, prompt, context) — only when relevant */}
      <div className="shrink-0 border-b border-border px-3 py-2.5 space-y-1.5">
        {/* Row 1: identity + status */}
        <div className="flex items-center gap-2">
          <Avatar className="size-7 shrink-0">
            {kinAvatarUrl ? (
              <AvatarImage src={kinAvatarUrl} alt={kinName ?? ''} />
            ) : (
              <AvatarFallback className="text-[10px] bg-secondary">
                {initials}
              </AvatarFallback>
            )}
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium leading-tight">
                {task?.title ??
                  (task?.description && task.description.length > 60
                    ? task.description.slice(0, 60) + '...'
                    : task?.description) ??
                  t('common.loading')}
              </span>
            </div>
            {kinName && (
              <div className="flex items-center gap-1 mt-0.5 text-[11px] text-muted-foreground">
                <GitBranch className="size-2.5 shrink-0" />
                <span className="truncate">{kinName}</span>
              </div>
            )}
          </div>

          {statusConfig && StatusIcon && task && (
            <Badge variant={statusConfig.badgeVariant} className="shrink-0 gap-1 text-[10px] px-1.5 py-0.5 h-5">
              <StatusIcon className={cn('size-2.5', statusConfig.iconClass)} />
              {t(`sidebar.tasks.status.${task.status}`)}
            </Badge>
          )}
        </div>

        {/* Row 2: meta facts — depth, mode, model, thinking, cron runs */}
        {task && (
          <div className="flex items-center gap-1 flex-wrap pl-9">
            {/* Mode */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="h-5 gap-1 px-1.5 py-0 text-[10px] font-normal">
                  {task.mode === 'await' ? t('taskDetail.modeAwait') : t('taskDetail.modeAsync')}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t('taskDetail.mode')}</TooltipContent>
            </Tooltip>

            {/* Depth */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="h-5 gap-1 px-1.5 py-0 text-[10px] font-normal">
                  <Layers className="size-2.5" />
                  {task.depth}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{t('taskDetail.depth')}</TooltipContent>
            </Tooltip>

            {/* Run duration — live while active, frozen once terminal. Hidden
                for queued/pending tasks that haven't started executing. */}
            {runDuration && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={cn(
                      'h-5 gap-1 px-1.5 py-0 text-[10px] font-normal tabular-nums',
                      isActive && 'border-primary/40 bg-primary/10 text-primary',
                    )}
                  >
                    <Clock className={cn('size-2.5', isActive && 'animate-pulse')} />
                    {runDuration}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {isActive ? t('taskDetail.duration.runningTooltip') : t('taskDetail.duration.finishedTooltip')}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Model */}
            {task.model && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="h-5 gap-1 px-1.5 py-0 text-[10px] font-normal max-w-[150px]">
                    {resolvedModel ? (
                      <ProviderIcon providerType={resolvedModel.providerType} className="size-2.5 shrink-0" />
                    ) : (
                      <Cpu className="size-2.5 shrink-0" />
                    )}
                    <span className="truncate">{resolvedModel?.name ?? task.model}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{resolvedModel?.name ?? task.model}</TooltipContent>
              </Tooltip>
            )}

            {/* Token usage — running total for the task, live-updated via SSE.
                Hidden until the first step records usage (the indicator itself
                also guards against zeros, but skipping the render is cheaper
                and avoids a flash for queued/just-spawned tasks). */}
            {task.tokenUsage && (
              <TokenUsageIndicator
                tokenUsage={task.tokenUsage}
                providerType={task.providerType ?? resolvedModel?.providerType ?? null}
                title={t('taskDetail.tokenUsage.title', 'Task total')}
                subtitle={t('taskDetail.tokenUsage.callCount', {
                  defaultValue: '{{count}} LLM call',
                  defaultValue_other: '{{count}} LLM calls',
                  // Use the sum of per-row stepCount, not COUNT(*) on
                  // llm_usage: one row = one sub-Kin turn (the runner
                  // collapses all tool-loop steps into a single roll-up),
                  // so COUNT(*) reads "1" on a turn that made 46 real
                  // HTTP calls to the provider. stepCount sums to the
                  // actual count the user expects.
                  count: task.tokenUsage.stepCount ?? task.tokenUsage.callCount,
                })}
              />
            )}

            {/* Thinking effort */}
            {task.thinkingEnabled && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className="h-5 gap-1 px-1.5 py-0 text-[10px] font-normal border-chart-4/40 bg-chart-4/10 text-chart-4"
                  >
                    <Sparkles className="size-2.5" />
                    {task.thinkingEffort
                      ? t(`chat.thinkingPicker.effort.${task.thinkingEffort}`)
                      : t('chat.thinkingPicker.effort.medium')}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {t('chat.thinkingPicker.title')}
                  {task.thinkingEffort ? `: ${t(`chat.thinkingPicker.effort.${task.thinkingEffort}`)}` : ''}
                </TooltipContent>
              </Tooltip>
            )}

            {/* Cron run selector */}
            {cronId && (
              <Popover open={isRunSelectorOpen} onOpenChange={setIsRunSelectorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 gap-1 px-1.5 text-[10px] font-normal"
                  >
                    <History className="size-2.5" />
                    {t('taskDetail.runSelector.trigger', { count: siblingRuns.length || 1 })}
                    <ChevronDown className="size-2.5 opacity-60" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-0">
                  <div className="px-3 py-2 border-b border-border">
                    <p className="text-xs font-medium">{t('taskDetail.runSelector.title')}</p>
                  </div>
                  <div className="max-h-72 overflow-y-auto py-1">
                    {isLoadingRuns ? (
                      <div className="flex justify-center py-4">
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      </div>
                    ) : siblingRuns.length === 0 ? (
                      <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                        {t('taskDetail.runSelector.empty')}
                      </p>
                    ) : (
                      siblingRuns.map((run) => {
                        const runStatusCfg = STATUS_CONFIG[run.status]
                        const RunStatusIcon = runStatusCfg.icon
                        const isFinished = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
                        const runStartMs = run.startedAt ? new Date(run.startedAt).getTime() : null
                        const runEndMs = run.endedAt ? new Date(run.endedAt).getTime() : null
                        const runDurationMs = isFinished ? computeDurationMs(runStartMs, runEndMs) : null
                        const duration = runDurationMs != null
                          ? formatDurationMs(runDurationMs)
                          : isFinished
                            ? formatDurationBetween(run.createdAt, run.updatedAt)
                            : undefined
                        const isCurrent = run.id === taskId
                        return (
                          <button
                            type="button"
                            key={run.id}
                            onClick={() => handleSelectRun(run)}
                            className={cn(
                              'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors',
                              isCurrent ? 'bg-primary/10 text-foreground' : 'hover:bg-accent/50',
                            )}
                          >
                            <RunStatusIcon className={cn('size-3 shrink-0', runStatusCfg.iconClass)} />
                            <span className="min-w-0 flex-1 truncate">
                              {run.title ?? run.description.slice(0, 50)}
                            </span>
                            {duration && (
                              <span className="text-[9px] text-muted-foreground shrink-0">{duration}</span>
                            )}
                            <span className="text-[9px] text-muted-foreground shrink-0">
                              {formatRelativeTime(new Date(run.createdAt).getTime(), { suffix: true })}
                            </span>
                          </button>
                        )
                      })
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}

        {/* Row 3: action chips — only rendered when at least one is visible */}
        {task && (toolCallCount > 0 || task.description || contextData) && (
          <div className="flex items-center gap-1.5 flex-wrap pl-9">
            {toolCallCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isToolCallsOpen ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-5 gap-1 px-1.5 text-[10px]"
                    onClick={toggleToolCalls}
                  >
                    <Wrench className="size-2.5" />
                    {toolCallCount}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('taskDetail.toolCalls', { defaultValue: 'Tool calls' })}</TooltipContent>
              </Tooltip>
            )}
            {task.description && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 gap-1 px-1.5 text-[10px]"
                    onClick={() => setIsPromptOpen(true)}
                  >
                    <FileText className="size-2.5" />
                    {t('taskDetail.viewPrompt')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('taskDetail.viewPromptTooltip')}</TooltipContent>
              </Tooltip>
            )}
            {task.runPrompt && task.runPrompt.trim().length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 gap-1 px-1.5 text-[10px]"
                    onClick={() => setIsRunPromptOpen(true)}
                  >
                    <Sparkles className="size-2.5" />
                    {t('taskDetail.runPrompt')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('taskDetail.runPromptTooltip')}</TooltipContent>
              </Tooltip>
            )}
            {contextData && (
              <ContextBar
                kinId={task.parentKinId}
                taskId={task.id}
                estimatedTokens={contextData.tokenEstimate.total}
                maxTokens={contextData.contextWindow}
                apiContextTokens={contextData.apiContextTokens}
                contextBreakdown={contextData.tokenEstimate}
                compact
              />
            )}
          </div>
        )}
      </div>

      {/* Plan banner — collapsed single-line by default, expandable in place
          above the conversation so it never competes with the tool-calls
          column for horizontal width. */}
      {todos.length > 0 && (
        <TaskTodoList todos={todos} />
      )}

      {/* Middle: messages + optional tool calls panel */}
      <div className="flex min-h-0 flex-1">
        {/* Conversation */}
        <div className="relative flex-1 min-h-0 overflow-y-auto py-3" ref={scrollContainerRef}>
          {isLoading && !task ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : isQueued ? (
            <div className="flex flex-col items-center justify-center py-8 gap-2">
              <ListOrdered className="size-6 text-muted-foreground" />
              <p className="text-xs text-muted-foreground text-center">
                {t('sidebar.tasks.status.queued')}
              </p>
              {task?.concurrencyGroup && (
                <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-center">
                  <p className="text-[10px] text-muted-foreground">
                    {t('sidebar.tasks.queueGroup', { group: task.concurrencyGroup })}
                  </p>
                  {task.concurrencyMax && (
                    <p className="text-[9px] text-muted-foreground/70 mt-0.5">
                      {t('taskDetail.concurrencySlots', { max: task.concurrencyMax })}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : visibleMessages.length === 0 && !streamingMessage && !isStreaming ? (
            isActive ? (
              <div className="py-4">
                <TypingIndicator kinName={kinName} kinAvatarUrl={kinAvatarUrl} />
              </div>
            ) : (
              <p className="text-center text-xs text-muted-foreground py-8">
                {t('taskDetail.conversationEmpty')}
              </p>
            )
          ) : (
            <div className="space-y-1">
              {visibleMessages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  role={msg.role}
                  content={msg.content}
                  sourceType={msg.sourceType}
                  avatarUrl={msg.role === 'assistant' ? kinAvatarUrl : undefined}
                  senderName={msg.role === 'assistant' ? kinName : undefined}
                  timestamp={msg.createdAt ? String(msg.createdAt) : undefined}
                  toolCalls={toolCallsByMessage.get(msg.id)}
                  tokenUsage={msg.tokenUsage}
                  reasoning={msg.reasoning ?? undefined}
                />
              ))}
              {streamingMessage && (
                <MessageBubble
                  key={streamingMessage.id}
                  role={streamingMessage.role}
                  content={streamingMessage.content}
                  sourceType={streamingMessage.sourceType}
                  avatarUrl={kinAvatarUrl}
                  senderName={kinName}
                  timestamp={streamingMessage.createdAt ? String(streamingMessage.createdAt) : undefined}
                  toolCalls={toolCallsByMessage.get(streamingMessage.id)}
                  reasoning={streamingReasoning || undefined}
                />
              )}
              {pendingPrompts.map((prompt) => (
                <div key={prompt.id} className="px-3">
                  <HumanPromptCard
                    prompt={prompt}
                    onRespond={respondToPrompt}
                    isResponding={isResponding}
                  />
                </div>
              ))}
              {(isStreaming || (isActive && !streamingMessage && pendingPrompts.length === 0)) && (
                <TypingIndicator kinName={kinName} kinAvatarUrl={kinAvatarUrl} />
              )}
            </div>
          )}

          {/* Result / Error block */}
          {task?.status === 'completed' && task.result && (
            <div className="mx-3 mt-3 rounded-xl border border-success/30 bg-success/5 p-2.5">
              <p className="text-[10px] font-medium text-success mb-1 flex items-center gap-1">
                <CheckCircle2 className="size-3" />
                {t('taskDetail.result')}
              </p>
              <div className="text-xs text-foreground">
                <MarkdownContent content={task.result} isUser={false} />
              </div>
            </div>
          )}

          {task?.status === 'failed' && task.error && (
            <div className="mx-3 mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-2.5">
              <p className="text-[10px] font-medium text-destructive mb-1 flex items-center gap-1">
                <XCircle className="size-3" />
                {t('taskDetail.error')}
              </p>
              <div className="text-xs text-foreground">
                <MarkdownContent content={task.error} isUser={false} />
              </div>
            </div>
          )}

          {/* Post-mortem token reading — one compact line with billable/output
              total, LLM call count, and cache hit %. Visible for every terminal
              status (completed/failed/cancelled) when usage was recorded.
              Header badge stays visible too; this footer makes the final total
              scannable next to the result/error block. */}
          {task && task.tokenUsage && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') && (
            <TaskTokenUsageFooter
              tokenUsage={task.tokenUsage}
              providerType={task.providerType ?? resolvedModel?.providerType ?? null}
            />
          )}

          {task && (task.status === 'failed' || task.status === 'cancelled') && (
            <div className="mx-3 mt-3 flex gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    onClick={() => handleRetry(false)}
                    disabled={retryMode !== null}
                  >
                    {retryMode === 'fresh'
                      ? <Loader2 className="size-3 mr-1 animate-spin" />
                      : <RotateCcw className="size-3 mr-1" />}
                    {t('taskDetail.retry.fresh')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-[220px]">
                  {t('taskDetail.retry.freshTooltip')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 text-xs"
                    onClick={() => handleRetry(true)}
                    disabled={retryMode !== null}
                  >
                    {retryMode === 'fork'
                      ? <Loader2 className="size-3 mr-1 animate-spin" />
                      : <GitFork className="size-3 mr-1" />}
                    {t('taskDetail.retry.fork')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs max-w-[220px]">
                  {t('taskDetail.retry.forkTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* Learnings saved during this run */}
          {learningsSaved.length > 0 && (
            <div className="mx-3 mt-3 rounded-xl border border-teal-500/30 bg-teal-500/5 p-2.5">
              <p className="text-[10px] font-medium text-teal-600 dark:text-teal-400 mb-1.5 flex items-center gap-1">
                <Lightbulb className="size-3" />
                {t('chat.taskResult.learningsSaved', { count: learningsSaved.length })}
              </p>
              <div className="space-y-1">
                {learningsSaved.map((l) => (
                  <div key={l.id} className="flex items-start gap-1.5 text-[11px]">
                    {l.category && (
                      <span className="shrink-0 rounded bg-teal-500/20 px-1 py-0.5 text-[9px] font-medium text-teal-600 dark:text-teal-400">
                        {l.category}
                      </span>
                    )}
                    <span className="text-foreground">{l.content}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
          {/* Auto-scroll toggle */}
          <button
            onClick={toggleAutoScroll}
            className={cn(
              'sticky bottom-1 float-right mr-1 z-10 flex items-center justify-center size-6 rounded-full shadow-lg transition-colors',
              autoScroll
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
            title={autoScroll ? t('chat.autoScroll.on') : t('chat.autoScroll.off')}
          >
            {autoScroll ? <Pin className="size-2.5" /> : <PinOff className="size-2.5" />}
          </button>
        </div>

        {/* Tool calls side panel — animated width */}
        <div
          className={cn(
            'shrink-0 overflow-hidden transition-[width] duration-300 ease-out',
            isToolCallsOpen ? 'w-56 lg:w-64' : 'w-0',
          )}
        >
          <ToolCallsViewer
            toolCalls={allToolCalls}
            toolCallCount={toolCallCount}
            onClose={toggleToolCalls}
          />
        </div>
      </div>

      {/* Run-prompt viewer dialog — only relevant on ticket tasks with a sur-prompt */}
      {task?.runPrompt && task.runPrompt.trim().length > 0 && (
        <Dialog open={isRunPromptOpen} onOpenChange={setIsRunPromptOpen}>
          <DialogContent className="sm:max-w-xl max-h-[80vh] flex flex-col gap-0">
            <DialogHeader className="pb-3 border-b border-border">
              <DialogTitle className="text-base flex items-center gap-2">
                <Sparkles className="size-4" />
                {t('taskDetail.runPrompt')}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t('taskDetail.runPromptTooltip')}
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto max-h-[60vh] py-4 px-1">
              <div className="text-sm text-foreground whitespace-pre-wrap break-words">
                {task.runPrompt}
              </div>
            </div>
            <DialogFooter className="pt-3 border-t border-border">
              <DialogClose asChild>
                <Button variant="outline" size="sm">
                  {t('taskDetail.close')}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Prompt viewer dialog */}
      {task?.description && (
        <Dialog open={isPromptOpen} onOpenChange={setIsPromptOpen}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col gap-0">
            <DialogHeader className="pb-3 border-b border-border">
              <DialogTitle className="text-base">
                {task.title ?? t('taskDetail.prompt')}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t('taskDetail.promptDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="overflow-y-auto max-h-[60vh] py-4 px-1">
              <div className="text-sm text-foreground">
                <MarkdownContent content={task.description} isUser={false} />
              </div>
            </div>
            <DialogFooter className="pt-3 border-t border-border">
              <DialogClose asChild>
                <Button variant="outline" size="sm">
                  {t('taskDetail.close')}
                </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Footer actions */}
      {task && (isActive || isQueued) && (
        <div className="shrink-0 border-t border-border px-3 py-2 space-y-2">
          {/* Message input — visible when running or paused */}
          {(isRunning || isPaused) && (
            <div className="flex gap-1.5">
              <input
                type="text"
                className="flex-1 h-7 rounded-md border border-border bg-background px-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                value={injectMessage}
                onChange={(e) => setInjectMessage(e.target.value)}
                placeholder={isPaused ? t('taskDetail.resumeMessagePlaceholder') : t('taskDetail.injectPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (isPaused) handleResume()
                    else if (injectMessage.trim()) handleInject()
                  }
                }}
                disabled={isInjecting}
              />
              {isPaused ? (
                <Button size="sm" className="h-7 text-xs" onClick={handleResume} disabled={isInjecting}>
                  {isInjecting ? (
                    <Loader2 className="size-3 animate-spin mr-1" />
                  ) : (
                    <Play className="size-3 mr-1" />
                  )}
                  {injectMessage.trim() ? t('taskDetail.resumeWithMessage') : t('taskDetail.resume')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-xs"
                  onClick={handleInject}
                  disabled={isInjecting || !injectMessage.trim()}
                >
                  {isInjecting ? (
                    <Loader2 className="size-3 animate-spin mr-1" />
                  ) : (
                    <Send className="size-3 mr-1" />
                  )}
                  {t('taskDetail.inject')}
                </Button>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {isQueued && (
              <Button variant="default" size="sm" className="h-7 text-xs" onClick={handleForceStart} disabled={isForceStarting}>
                {isForceStarting ? (
                  <Loader2 className="size-3 animate-spin mr-1" />
                ) : (
                  <Play className="size-3 mr-1" />
                )}
                {t('taskDetail.forceStart')}
              </Button>
            )}
            {isRunning && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={handlePause}>
                <Pause className="size-3 mr-1" />
                {t('taskDetail.pause')}
              </Button>
            )}
            <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={cancelTask}>
              {t('taskDetail.cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Footer: post-mortem token reading ────────────────────────────────────────

/** Compact post-mortem reading rendered under the result/error block when the
 *  task reaches a terminal status. Mirrors the header indicator's billable
 *  total but stretches the breakdown into a readable single line (input/output,
 *  call count, cache hit %) so the user gets the "what did this task cost?"
 *  answer without opening the popover. */
function TaskTokenUsageFooter({
  tokenUsage,
  providerType,
}: {
  tokenUsage: NonNullable<ReturnType<typeof useTaskDetail>['task']>['tokenUsage']
  providerType: string | null
}) {
  const { t } = useTranslation()
  if (!tokenUsage) return null

  const billable = tokenUsage.billableInputTokens ?? 0
  const output = tokenUsage.outputTokens
  const headline = billable + output
  const cacheRead = tokenUsage.cacheReadTokens ?? 0
  const cacheWrite = tokenUsage.cacheWriteTokens ?? 0
  const hasCache = cacheRead > 0 || cacheWrite > 0
  const hitRate = tokenUsage.inputTokens > 0
    ? Math.min(1, cacheRead / tokenUsage.inputTokens)
    : 0

  const fmt = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
    : n.toLocaleString()

  return (
    <div className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground tabular-nums">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-1 text-foreground font-medium">
            <Sparkles className="size-2.5 text-primary" />
            ≈ {fmt(headline)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {t('taskDetail.tokenUsage.title')}
          {providerType ? ` (${providerType})` : ''}
        </TooltipContent>
      </Tooltip>
      <span>
        {t('chat.tokenUsage.input')} <span className="text-foreground">{fmt(billable)}</span>
      </span>
      <span>
        {t('chat.tokenUsage.output')} <span className="text-foreground">{fmt(output)}</span>
      </span>
      <span>
        {t('taskDetail.tokenUsage.callCount', {
          defaultValue: '{{count}} LLM call',
          defaultValue_other: '{{count}} LLM calls',
          // See header indicator above — stepCount is the actual HTTP-call
          // count, not COUNT(*) on llm_usage rows.
          count: tokenUsage.stepCount ?? tokenUsage.callCount,
        })}
      </span>
      {hasCache && (
        <span>
          {t('chat.tokenUsage.cacheHit', 'Cache hit')}{' '}
          <span className={
            hitRate >= 0.7 ? 'text-success font-medium'
            : hitRate >= 0.3 ? 'text-warning font-medium'
            : 'text-foreground'
          }>
            {Math.round(hitRate * 100)}%
          </span>
        </span>
      )}
    </div>
  )
}
