import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'
import { formatRelativeTime } from '@/client/lib/time'
import { cronToHuman } from '@/client/lib/cron-human'
import { cronNextRun, formatCountdown } from '@/client/lib/cron-next'
import { Clock, CheckCircle2, Loader2, GripHorizontal, FastForward, History, Bell, Bot } from 'lucide-react'
import type { CronSummary } from '@/shared/types'

/** A single labelled stat cell (next run / last run). */
function Stat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Clock
  label: string
  value: string
  accent?: string
}) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/30 px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <Icon className="size-2.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <p className={cn('mt-0.5 truncate text-xs font-semibold', accent ?? 'text-foreground')}>{value}</p>
    </div>
  )
}

export function CronCard({
  cron,
  onClick,
  onApprove,
  onToggleActive,
  isRunning,
}: {
  cron: CronSummary
  onClick: () => void
  onApprove?: () => void
  onToggleActive?: (isActive: boolean) => void
  isRunning?: boolean
}) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const serverTimezone = user?.serverTimezone
  const initials = cron.kinName.slice(0, 2).toUpperCase()
  const isPaused = !cron.isActive && !cron.requiresApproval
  const humanSchedule = cronToHuman(cron.schedule, i18n.language)
  const nextRun = cron.isActive && !cron.requiresApproval ? cronNextRun(cron.schedule, serverTimezone) : null

  const hasDifferentTarget = !!cron.targetKinName && cron.targetKinId !== cron.kinId
  const lastRunValue = cron.lastTriggeredAt ? formatRelativeTime(cron.lastTriggeredAt) : t('sidebar.crons.never')

  // Footer status label + accent
  const statusLabel = cron.requiresApproval
    ? t('sidebar.crons.pendingApproval')
    : cron.isActive
      ? t('sidebar.crons.active')
      : t('sidebar.crons.paused')
  const statusAccent = cron.requiresApproval
    ? 'text-warning'
    : cron.isActive
      ? 'text-success'
      : 'text-muted-foreground'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className={cn(
        'surface-card flex h-full cursor-pointer flex-col gap-3 rounded-xl border border-border p-4 text-xs transition-colors hover:border-primary/40',
        isPaused && 'opacity-70',
      )}
    >
      {/* Header — owner identity */}
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar className="size-9 shrink-0">
          {cron.kinAvatarUrl && <AvatarImage src={cron.kinAvatarUrl} alt={cron.kinName} />}
          <AvatarFallback className="bg-secondary text-[11px]">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold leading-tight text-foreground">{cron.name}</p>
            {isRunning && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{cron.kinName}</p>
        </div>
      </div>

      {/* Badges */}
      {(cron.requiresApproval || cron.runOnce || cron.triggerParentTurn || cron.createdBy === 'kin') && (
        <div className="flex flex-wrap items-center gap-1">
          {cron.requiresApproval && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-warning border-warning/40">
              {t('sidebar.crons.pendingApproval')}
            </Badge>
          )}
          {cron.runOnce && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] text-info border-info/40">
              {t('cron.detail.oneTime', 'One-time')}
            </Badge>
          )}
          {cron.triggerParentTurn && (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] text-chart-4 border-chart-4/40">
              <Bell className="size-2.5" />
              <span className="max-sm:hidden">{t('cron.triggerParentTurn.badge')}</span>
            </Badge>
          )}
          {cron.createdBy === 'kin' && (
            <Badge variant="outline" className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground">
              <Bot className="size-2.5" />
              {t('sidebar.crons.autoBadge')}
            </Badge>
          )}
        </div>
      )}

      {/* Task description — extra context, hidden on small screens to stay lean */}
      {cron.taskDescription && (
        <p className="hidden line-clamp-2 text-[11px] leading-relaxed text-muted-foreground sm:block">
          {cron.taskDescription}
        </p>
      )}

      {/* Schedule */}
      <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 px-2.5 py-2">
        <Clock className="size-3.5 shrink-0 text-primary" />
        <span className="truncate text-xs font-medium text-foreground" title={cron.schedule}>
          {humanSchedule ?? cron.schedule}
        </span>
      </div>

      {/* Next / Last run — full stat grid on sm+, single compact line on mobile */}
      <div className="hidden grid-cols-2 gap-2 sm:grid">
        <Stat
          icon={FastForward}
          label={t('sidebar.crons.nextRunLabel')}
          value={nextRun ? formatCountdown(nextRun) : '—'}
          accent={nextRun ? 'text-primary' : 'text-muted-foreground'}
        />
        <Stat
          icon={History}
          label={t('sidebar.crons.lastRunLabel')}
          value={lastRunValue}
        />
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground sm:hidden">
        {nextRun ? (
          <>
            <FastForward className="size-3 shrink-0 text-primary" />
            <span className="text-primary">{formatCountdown(nextRun)}</span>
          </>
        ) : (
          <>
            <History className="size-3 shrink-0" />
            <span>{lastRunValue}</span>
          </>
        )}
      </div>

      {/* Target kin (when the task runs as a different Kin) — hidden on small */}
      {hasDifferentTarget && (
        <div className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex">
          <span className="shrink-0">{t('sidebar.crons.targetLabel')}</span>
          <Avatar className="size-4 shrink-0">
            {cron.targetKinAvatarUrl && <AvatarImage src={cron.targetKinAvatarUrl} alt={cron.targetKinName ?? ''} />}
            <AvatarFallback className="text-[6px]">{(cron.targetKinName ?? '').slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate font-medium text-foreground">{cron.targetKinName}</span>
        </div>
      )}

      {/* Footer — status + control. mt-auto keeps footers aligned across a row. */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <span className={cn('text-[11px] font-medium', statusAccent)}>{statusLabel}</span>
        {cron.requiresApproval && onApprove ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={(e) => { e.stopPropagation(); onApprove() }}
            title={t('sidebar.crons.approve')}
          >
            <CheckCircle2 className="size-3.5 text-success" />
            {t('sidebar.crons.approve')}
          </Button>
        ) : !cron.requiresApproval && onToggleActive ? (
          <Switch
            checked={cron.isActive}
            onCheckedChange={(checked) => onToggleActive(checked)}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0"
          />
        ) : null}
      </div>
    </div>
  )
}

export function SortableCronCard({
  cron,
  onClick,
  onToggleActive,
  isRunning,
}: {
  cron: CronSummary
  onClick: () => void
  onToggleActive?: (isActive: boolean) => void
  isRunning?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cron.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="group relative h-full">
      {/* Drag handle — top-center, surfaces on hover. Sits in the card's top
          padding so it never overlaps the content. */}
      <div
        {...attributes}
        {...listeners}
        className="absolute left-1/2 top-0.5 z-10 flex h-5 w-10 -translate-x-1/2 cursor-grab items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
      >
        <GripHorizontal className="size-3.5 text-muted-foreground" />
      </div>
      <CronCard
        cron={cron}
        onClick={onClick}
        onToggleActive={onToggleActive}
        isRunning={isRunning}
      />
    </div>
  )
}
