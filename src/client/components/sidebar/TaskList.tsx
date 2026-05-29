import { useState, useEffect, useRef, useMemo, memo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  SidebarGroupContent,
} from '@/client/components/ui/sidebar'
import { Input } from '@/client/components/ui/input'
import { cn } from '@/client/lib/utils'
import { formatDurationMs, computeDurationMs } from '@/client/lib/time'
import { useNow } from '@/client/hooks/useNow'
import { Loader2, Search, ListTodo, ChevronDown, Zap } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { TaskTimelineItem } from '@/client/components/common/TaskTimelineItem'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import type { TaskSummary } from '@/shared/types'

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

/** Group tasks by day, returning [label, tasks][] */
function groupByDay(tasks: TaskSummary[], t: (key: string) => string): [string, TaskSummary[]][] {
  const now = new Date()
  const todayStr = now.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toDateString()

  const groups = new Map<string, { label: string; tasks: TaskSummary[] }>()

  for (const task of tasks) {
    const date = new Date(task.createdAt)
    const dateStr = date.toDateString()

    let label: string
    if (dateStr === todayStr) {
      label = t('chat.dateSeparator.today')
    } else if (dateStr === yesterdayStr) {
      label = t('chat.dateSeparator.yesterday')
    } else {
      label = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    }

    const key = dateStr
    if (!groups.has(key)) {
      groups.set(key, { label, tasks: [] })
    }
    groups.get(key)!.tasks.push(task)
  }

  return Array.from(groups.values()).map((g) => [g.label, g.tasks])
}

function formatTime(isoDate: string): string {
  return new Date(isoDate).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

function TokenChip({ headline }: { headline: number }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-primary/10 text-primary px-1.5 py-px text-[9px] font-medium tabular-nums"
      title={`≈ ${headline.toLocaleString()} tokens`}
    >
      <Zap className="size-2" />
      ≈ {formatTokenCount(headline)}
    </span>
  )
}

function TimelineTaskCard({ task, onClick, isLast, queuePosition, nowMs }: { task: TaskSummary; onClick: () => void; isLast: boolean; queuePosition?: number; nowMs: number }) {
  const kinName = task.sourceKinName ?? task.parentKinName
  const isQueued = task.status === 'queued'
  const isActive = task.status === 'in_progress' || task.status === 'paused' || task.status === 'awaiting_human_input' || task.status === 'awaiting_kin_response' || task.status === 'pending'
  const isFinished = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'

  // Run duration is measured from when the task actually started executing
  // (startedAt), not when it was spawned/queued. While running it ticks live
  // off the shared `nowMs` clock; once terminal it freezes at endedAt.
  const startedMs = task.startedAt ? new Date(task.startedAt).getTime() : null
  const endedMs = task.endedAt ? new Date(task.endedAt).getTime() : null
  const runMs = computeDurationMs(startedMs, isFinished ? endedMs : null, nowMs)
  const runDuration = runMs != null ? formatDurationMs(runMs) : null

  const primary = task.title ?? (task.description.length > 55
    ? task.description.slice(0, 55) + '…'
    : task.description)
  const secondary = isQueued && task.concurrencyGroup ? task.concurrencyGroup : kinName
  // Active/finished rows surface the run duration; queued rows have no
  // execution window yet, so fall back to the spawn time.
  const time = runDuration != null ? runDuration : formatTime(task.createdAt)

  // Token chip — billable input + output ≈ what the user actually paid for.
  // Hidden when no usage has been recorded (queued / immediate cancel).
  const usage = task.tokenUsage
  const tokenHeadline = usage ? usage.billableInputTokens + usage.outputTokens : 0

  return (
    <TaskTimelineItem
      status={task.status}
      primary={primary}
      secondary={secondary}
      time={time}
      isLast={isLast}
      prefix={isQueued && queuePosition != null ? `#${queuePosition}` : undefined}
      trailing={tokenHeadline > 0 ? <TokenChip headline={tokenHeadline} /> : undefined}
      onClick={onClick}
    />
  )
}

interface TaskData {
  activeTasks: TaskSummary[]
  queuedTasks: TaskSummary[]
  historyTasks: TaskSummary[]
  hasMore: boolean
  isLoading: boolean
  isLoadingMore: boolean
  searchQuery: string
  setSearchQuery: (q: string) => void
  loadMore: () => void
}

interface TaskListProps {
  llmModels: LLMModel[]
  taskData: TaskData
}

export const TaskList = memo(function TaskList({ llmModels, taskData }: TaskListProps) {
  const { t } = useTranslation()
  const { openTask } = useSidePanel()
  const {
    activeTasks,
    queuedTasks,
    historyTasks,
    hasMore,
    isLoading,
    isLoadingMore,
    searchQuery,
    setSearchQuery,
    loadMore,
  } = taskData
  const [queueFilter, setQueueFilter] = useState<string | null>(null)
  const [queueFilterOpen, setQueueFilterOpen] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Shared 1s clock driving live duration counters. Only ticks while at least
  // one task is actually running (active or queued) so we don't re-render the
  // history list for nothing.
  const hasLiveTasks = activeTasks.length > 0 || queuedTasks.length > 0
  const nowMs = useNow(hasLiveTasks)

  // IntersectionObserver on sentinel for infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { threshold: 0.1 },
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  // Deduplicate history vs active/queued
  const nonHistoryIds = useMemo(() => {
    const ids = new Set(activeTasks.map((t) => t.id))
    for (const t of queuedTasks) ids.add(t.id)
    return ids
  }, [activeTasks, queuedTasks])
  const deduplicatedHistory = useMemo(
    () => historyTasks.filter((t) => !nonHistoryIds.has(t.id)),
    [historyTasks, nonHistoryIds],
  )

  // Group history by day
  const historyGroups = useMemo(
    () => groupByDay(deduplicatedHistory, t),
    [deduplicatedHistory, t],
  )

  // Queue groups for filter dropdown
  const queueGroups = useMemo(() => {
    const groups = new Map<string, number>()
    for (const task of queuedTasks) {
      if (task.concurrencyGroup) {
        groups.set(task.concurrencyGroup, (groups.get(task.concurrencyGroup) ?? 0) + 1)
      }
    }
    return groups
  }, [queuedTasks])

  // Filtered queued tasks
  const filteredQueuedTasks = useMemo(
    () => queueFilter ? queuedTasks.filter((t) => t.concurrencyGroup === queueFilter) : queuedTasks,
    [queuedTasks, queueFilter],
  )

  // Compute per-group queue positions (1-indexed)
  const queuePositions = useMemo(() => {
    const positions = new Map<string, number>()
    const groupCounters = new Map<string, number>()
    // queuedTasks are sorted by createdAt (oldest first from API)
    for (const task of queuedTasks) {
      const group = task.concurrencyGroup ?? '__default__'
      const pos = (groupCounters.get(group) ?? 0) + 1
      groupCounters.set(group, pos)
      positions.set(task.id, pos)
    }
    return positions
  }, [queuedTasks])

  const handleOpenTask = (task: TaskSummary) => {
    openTask({
      taskId: task.id,
      kinName: task.sourceKinName ?? task.parentKinName,
      kinAvatarUrl: task.sourceKinAvatarUrl ?? task.parentKinAvatarUrl,
    })
  }

  const isEmpty = activeTasks.length === 0 && queuedTasks.length === 0 && deduplicatedHistory.length === 0 && !isLoading
  const totalItems = activeTasks.length + queuedTasks.length + deduplicatedHistory.length

  return (
    <>
      {/* Search input — stays fixed above scroll */}
      <div className="shrink-0 px-1 pb-2 pt-1">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('sidebar.tasks.search')}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <SidebarGroupContent className="flex-1 min-h-0 overflow-y-auto">
        {isEmpty ? (
          searchQuery ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              {t('sidebar.tasks.noResults')}
            </p>
          ) : (
            <EmptyState
              compact
              icon={ListTodo}
              title={t('sidebar.tasks.empty')}
              description={t('sidebar.tasks.emptyDescription')}
            />
          )
        ) : (
          <div className="pl-2 pr-1">
              {/* Active tasks — pinned at top with "Active" header, hidden during search */}
              {activeTasks.length > 0 && !searchQuery && (
                <>
                  {/* Active header */}
                  <div className="relative flex gap-3 items-center mb-0.5">
                    <div className="flex flex-col items-center shrink-0 w-4">
                      <div className="size-2 rounded-full bg-primary animate-pulse" />
                    </div>
                    <span className="text-[10px] font-semibold text-primary uppercase tracking-wider">
                      {t('sidebar.tasks.activeLabel')}
                    </span>
                  </div>

                  {activeTasks.map((task, i) => (
                    <TimelineTaskCard
                      key={task.id}
                      task={task}
                      onClick={() => handleOpenTask(task)}
                      isLast={i === activeTasks.length - 1 && queuedTasks.length === 0 && deduplicatedHistory.length === 0}
                      nowMs={nowMs}
                    />
                  ))}
                </>
              )}

              {/* Queued tasks — between active and history, hidden during search */}
              {queuedTasks.length > 0 && !searchQuery && (
                <>
                  {/* Queued header with filter */}
                  <div className="relative flex gap-3 items-center mb-0.5 mt-1">
                    <div className="flex flex-col items-center shrink-0 w-4">
                      <div className="size-1.5 rounded-full bg-orange-500/40" />
                    </div>
                    <span className="text-[10px] font-semibold text-orange-500 uppercase tracking-wider">
                      {t('sidebar.tasks.queuedLabel')} ({filteredQueuedTasks.length})
                    </span>
                    {/* Queue filter dropdown */}
                    {queueGroups.size > 1 && (
                      <div className="relative ml-auto">
                        <button
                          onClick={() => setQueueFilterOpen((prev) => !prev)}
                          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {queueFilter ?? t('sidebar.tasks.queueFilter.all')}
                          <ChevronDown className="size-3" />
                        </button>
                        {queueFilterOpen && (
                          <div className="absolute right-0 top-full mt-1 z-20 min-w-[160px] rounded-md border bg-popover p-1 shadow-md">
                            <button
                              onClick={() => { setQueueFilter(null); setQueueFilterOpen(false) }}
                              className={cn(
                                'w-full text-left px-2 py-1 text-[10px] rounded hover:bg-accent transition-colors',
                                !queueFilter && 'font-medium text-foreground',
                              )}
                            >
                              {t('sidebar.tasks.queueFilter.all')}
                            </button>
                            {Array.from(queueGroups.entries()).map(([group, count]) => (
                              <button
                                key={group}
                                onClick={() => { setQueueFilter(group); setQueueFilterOpen(false) }}
                                className={cn(
                                  'w-full text-left px-2 py-1 text-[10px] rounded hover:bg-accent transition-colors',
                                  queueFilter === group && 'font-medium text-foreground',
                                )}
                              >
                                {group} ({count})
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {filteredQueuedTasks.map((task, i) => (
                    <TimelineTaskCard
                      key={task.id}
                      task={task}
                      onClick={() => handleOpenTask(task)}
                      isLast={i === filteredQueuedTasks.length - 1 && deduplicatedHistory.length === 0}
                      queuePosition={queuePositions.get(task.id)}
                      nowMs={nowMs}
                    />
                  ))}
                </>
              )}

              {/* History grouped by day */}
              {historyGroups.map(([label, tasks], groupIdx) => {
                const isLastGroup = groupIdx === historyGroups.length - 1
                return (
                  <div key={label}>
                    {/* Day header */}
                    <div className="relative flex gap-3 items-center mb-0.5 mt-1">
                      <div className="flex flex-col items-center shrink-0 w-4">
                        <div className="size-1.5 rounded-full bg-border" />
                      </div>
                      <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        {label}
                      </span>
                    </div>

                    {/* Tasks in this group */}
                    {tasks.map((task, i) => (
                      <TimelineTaskCard
                        key={task.id}
                        task={task}
                        onClick={() => handleOpenTask(task)}
                        isLast={isLastGroup && i === tasks.length - 1 && !hasMore}
                        nowMs={nowMs}
                      />
                    ))}
                  </div>
                )
              })}

              {/* Infinite scroll sentinel */}
              <div ref={sentinelRef} className="flex justify-center py-2">
                {(isLoadingMore || (isLoading && totalItems === 0)) && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                )}
              </div>
          </div>
        )}
      </SidebarGroupContent>


    </>
  )
})
