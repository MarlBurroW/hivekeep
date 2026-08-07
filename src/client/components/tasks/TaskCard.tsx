import { useTranslation } from 'react-i18next'
import { Zap, Sparkles, CalendarClock, Timer, Clock, Layers } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { cn } from '@/client/lib/utils'
import { formatDurationMs, computeDurationMs, formatRelativeTime } from '@/client/lib/time'
import { taskStatusMeta, isQueuedStatus, isTerminalStatus, isActiveStatus } from '@/client/lib/task-status'
import type { TaskStatus, AgentThinkingEffort, TaskTokenUsage } from '@/shared/types'

/**
 * Normalized view-model for a task card. Both the Tasks page (`TaskSummary`)
 * and the task panel map their richer/leaner shapes
 * onto this so the card stays visually identical across the app. Timestamps are
 * Unix-ms numbers; the optional meta fields are only populated where available.
 */
export interface TaskCardModel {
  id: string
  status: TaskStatus
  /** Primary line — task title/prompt. */
  title: string
  /** Secondary line — the acting Agent (matches the avatar). */
  agentName: string
  avatarUrl: string | null
  startedMs: number | null
  endedMs: number | null
  createdMs: number
  model?: string | null
  providerType?: string | null
  thinkingEnabled?: boolean
  thinkingEffort?: AgentThinkingEffort | null
  cronId?: string | null
  depth?: number
  concurrencyGroup?: string | null
  tokenUsage?: TaskTokenUsage | null
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString()
}

/**
 * Compact, info-rich task card. Surfaces the acting Agent's identity, a labelled
 * status badge, optional model/thinking/origin meta, and a footer with the run
 * duration (live off the shared `nowMs` clock while executing, frozen once
 * terminal) plus token consumption. Sections collapse when their data is
 * absent, so a lean task degrades to a clean status card.
 */
export function TaskCard({
  task,
  onClick,
  queuePosition,
  nowMs,
}: {
  task: TaskCardModel
  onClick: () => void
  queuePosition?: number
  nowMs: number
}) {
  const { t } = useTranslation()

  const meta = taskStatusMeta(task.status)
  const StatusIcon = meta.icon
  const spin = task.status === 'in_progress'
  const isQueued = isQueuedStatus(task.status)
  const isFinished = isTerminalStatus(task.status)
  const isActive = isActiveStatus(task.status)

  const initials = task.agentName.slice(0, 2).toUpperCase()

  const runMs = computeDurationMs(task.startedMs, isFinished ? task.endedMs : null, nowMs)
  const runDuration = runMs != null ? formatDurationMs(runMs) : null
  const relTime = formatRelativeTime(task.createdMs, { suffix: true })

  const usage = task.tokenUsage
  const tokenHeadline = usage ? usage.inputTokens + usage.outputTokens : 0
  const callCount = usage?.callCount ?? 0
  const depth = task.depth ?? 0

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      className={cn(
        'mb-3 flex cursor-pointer flex-col gap-1.5 rounded-xl p-2.5 text-xs shadow-md transition-shadow hover:shadow-lg',
        // Running tasks get a primary gradient contour that slowly spins; the
        // resting ones use the frosted "gradient strip + blur" header surface.
        spin ? 'gradient-border-spin-solid' : 'surface-header border border-border/60',
        isQueued && 'opacity-80',
        task.status === 'cancelled' && 'opacity-60',
      )}
    >
      {/* Header — acting Agent identity + task title */}
      <div className="flex min-w-0 items-start gap-2">
        <Avatar className="size-7 shrink-0">
          {task.avatarUrl && <AvatarImage src={task.avatarUrl} alt={task.agentName} />}
          <AvatarFallback className="bg-secondary text-[9px]">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] font-semibold leading-tight text-foreground">{task.title}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{task.agentName}</p>
        </div>
        {queuePosition != null && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
            #{queuePosition}
          </span>
        )}
      </div>

      {/* Status + config + origin — a single wrap row keeps the card compact */}
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium', meta.bgClass, meta.textClass)}>
          <StatusIcon className={cn('size-3 shrink-0', spin && 'animate-spin', !spin && meta.pulse && 'animate-pulse')} />
          {t(meta.labelKey)}
        </span>
        {task.model && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground">
            {task.providerType && <ProviderIcon providerType={task.providerType} className="size-3 shrink-0" />}
            <span className="max-w-[8rem] truncate">{task.model}</span>
          </span>
        )}
        {task.thinkingEnabled && (
          <span className="inline-flex items-center gap-1 rounded-md bg-chart-4/10 px-1.5 py-0.5 font-medium text-chart-4">
            <Sparkles className="size-2.5 shrink-0" />
            {task.thinkingEffort
              ? t(`chat.thinkingPicker.effort.${task.thinkingEffort}`)
              : t('chat.thinkingToggle')}
          </span>
        )}
        {task.cronId && (
          <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground">
            <CalendarClock className="size-2.5 shrink-0" />
            {t('sidebar.tasks.scheduled')}
          </span>
        )}
        {depth > 0 && (
          <span
            className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground"
            title={t('sidebar.tasks.nested')}
          >
            <Layers className="size-2.5 shrink-0" />
            {depth}
          </span>
        )}
        {isQueued && task.concurrencyGroup && (
          <span className="inline-flex max-w-[8rem] items-center rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground">
            <span className="truncate">{task.concurrencyGroup}</span>
          </span>
        )}
      </div>

      {/* Footer — run duration / age + token consumption */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 tabular-nums">
          {runDuration != null ? (
            <>
              <Timer className={cn('size-3 shrink-0', isActive && 'text-primary')} />
              <span className={cn(isActive && 'font-medium text-primary')}>{runDuration}</span>
            </>
          ) : (
            <>
              <Clock className="size-3 shrink-0" />
              {relTime}
            </>
          )}
        </span>
        {tokenHeadline > 0 && (
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            title={`≈ ${tokenHeadline.toLocaleString()} tokens${callCount > 0 ? ` · ${callCount} calls` : ''}`}
          >
            <Zap className="size-2.5 shrink-0 text-primary" />≈ {formatTokenCount(tokenHeadline)}
            {callCount > 0 && <span className="text-muted-foreground/70">· {callCount}</span>}
          </span>
        )}
      </div>
    </div>
  )
}
