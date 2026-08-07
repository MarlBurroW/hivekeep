import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'
import { formatRelativeTime } from '@/client/lib/time'
import { cronToHuman } from '@/client/lib/cron-human'
import { cronNextRun, formatCountdown } from '@/client/lib/cron-next'
import { Clock, CheckCircle2, Loader2, GripVertical, FastForward, History, Bell, Bot, Sparkles, Wrench, Repeat } from 'lucide-react'
import type { CronSummary, Toolbox } from '@/shared/types'

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

/** Small pill used for the model / thinking / toolbox meta on wide screens. */
function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex max-w-[10rem] items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground', className)}>
      {children}
    </span>
  )
}

/**
 * One scheduled job rendered as a dense list row: identity and human schedule on
 * the left, configuration chips in the middle (wide screens only), next/last run
 * and the active switch on the right. Below `sm` the row folds into a stacked
 * card while keeping the same information order.
 */
export function CronRow({
  cron,
  llmModels = [],
  toolboxes = [],
  agents = [],
  onClick,
  onApprove,
  onToggleActive,
  isRunning,
  dragHandle,
}: {
  cron: CronSummary
  llmModels?: LLMModel[]
  toolboxes?: Toolbox[]
  /** Owner/target Agents (id + default model) — used to resolve the effective
   *  model when the cron doesn't pin one of its own. */
  agents?: { id: string; model: string }[]
  onClick: () => void
  onApprove?: () => void
  onToggleActive?: (isActive: boolean) => void
  isRunning?: boolean
  dragHandle?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const serverTimezone = user?.serverTimezone
  const initials = cron.agentName.slice(0, 2).toUpperCase()
  const isPaused = !cron.isActive && !cron.requiresApproval
  const humanSchedule = cronToHuman(cron.schedule, i18n.language)
  const nextRun = cron.isActive && !cron.requiresApproval ? cronNextRun(cron.schedule, serverTimezone) : null

  const hasDifferentTarget = !!cron.targetAgentName && cron.targetAgentId !== cron.agentId
  const lastRunValue = cron.lastTriggeredAt ? formatRelativeTime(cron.lastTriggeredAt) : t('sidebar.crons.never')

  // Effective model: the cron's own override, else the model of the Agent the task
  // runs as (delegated target if any, otherwise the owner).
  const runAgentId = cron.targetAgentId ?? cron.agentId
  const effectiveModelId = cron.model ?? agents.find((a) => a.id === runAgentId)?.model ?? null
  const resolvedModel = effectiveModelId ? llmModels.find((m) => m.id === effectiveModelId) : undefined
  const modelLabel = resolvedModel?.name ?? effectiveModelId

  // Toolboxes — only surfaced when the cron restricts the toolset (empty = all
  // native tools, which is the default and not worth a chip).
  const toolboxLabel = (() => {
    if (cron.toolboxIds.length === 0) return null
    const names = cron.toolboxIds
      .map((id) => toolboxes.find((tb) => tb.id === id)?.name)
      .filter((n): n is string => !!n)
    if (names.length > 0 && names.length <= 2) return names.join(', ')
    return t('sidebar.crons.toolboxes', { count: cron.toolboxIds.length })
  })()

  const statusLabel = cron.requiresApproval
    ? t('sidebar.crons.pendingApproval')
    : cron.isActive
      ? t('sidebar.crons.active')
      : t('sidebar.crons.paused')
  const statusDot = cron.requiresApproval
    ? 'bg-warning'
    : cron.isActive
      ? 'bg-success'
      : 'bg-muted-foreground/40'

  const runLabel = `${t('sidebar.crons.nextRunLabel')} / ${t('sidebar.crons.lastRunLabel')}`

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
        'flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-xs transition-colors hover:bg-muted/40',
        isPaused && 'opacity-70',
      )}
    >
      {/* Drag handle column — kept reserved so rows align across sections */}
      <div className="hidden w-5 shrink-0 sm:block">{dragHandle}</div>

      <span className={cn('size-1.5 shrink-0 rounded-full', statusDot)} title={statusLabel} />

      <Avatar className="size-8 shrink-0">
        {cron.agentAvatarUrl && <AvatarImage src={cron.agentAvatarUrl} alt={cron.agentName} />}
        <AvatarFallback className="bg-secondary text-[10px]">{initials}</AvatarFallback>
      </Avatar>

      {/* Identity + schedule */}
      <div className="min-w-0 flex-1">
        {/* Below sm the name takes a full line so badges never squeeze it */}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-semibold leading-tight text-foreground max-sm:basis-full">{cron.name}</span>
          {isRunning && <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />}
          {cron.requiresApproval && (
            <Badge variant="outline" className="h-5 shrink-0 border-warning/40 px-1.5 text-[10px] text-warning">
              {t('sidebar.crons.pendingApproval')}
            </Badge>
          )}
          {cron.runOnce && (
            <Badge variant="outline" className="h-5 shrink-0 border-info/40 px-1.5 text-[10px] text-info">
              {t('cron.detail.oneTime')}
            </Badge>
          )}
          {cron.triggerParentTurn && (
            <Badge
              variant="outline"
              className="h-5 shrink-0 gap-1 border-chart-4/40 px-1.5 text-[10px] text-chart-4"
              title={t('cron.triggerParentTurn.badge')}
            >
              <Bell className="size-2.5" />
              <span className="max-lg:hidden">{t('cron.triggerParentTurn.badge')}</span>
            </Badge>
          )}
          {cron.createdBy === 'agent' && (
            <Badge variant="outline" className="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground">
              <Bot className="size-2.5" />
              {t('sidebar.crons.autoBadge')}
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="size-3 shrink-0" />
          <span className="truncate" title={cron.schedule}>{humanSchedule ?? cron.schedule}</span>
          <span className="shrink-0 text-muted-foreground/50">·</span>
          <span className="truncate">
            {hasDifferentTarget ? `${cron.agentName} → ${cron.targetAgentName}` : cron.agentName}
          </span>
        </div>
        {/* Mobile fallback for the next/last run column below */}
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground sm:hidden">
          {nextRun ? (
            <>
              <FastForward className="size-3 shrink-0 text-primary" />
              <span className="text-primary">{formatCountdown(nextRun)}</span>
            </>
          ) : (
            <>
              <History className="size-3 shrink-0" />
              <span className="truncate">{lastRunValue}</span>
            </>
          )}
        </div>
      </div>

      {/* Configuration meta — the widest screens only, it is secondary */}
      <div className="hidden shrink-0 items-center gap-1.5 text-[10px] xl:flex">
        {modelLabel && (
          <Chip>
            {resolvedModel && <ProviderIcon providerType={resolvedModel.providerType} className="size-3 shrink-0" />}
            <span className="truncate">{modelLabel}</span>
          </Chip>
        )}
        {cron.thinkingEnabled && (
          <Chip className="bg-chart-4/10 text-chart-4">
            <Sparkles className="size-2.5 shrink-0" />
            {cron.thinkingEffort
              ? t(`chat.thinkingPicker.effort.${cron.thinkingEffort}`)
              : t('chat.thinkingToggle')}
          </Chip>
        )}
        {toolboxLabel && (
          <Chip>
            <Wrench className="size-2.5 shrink-0" />
            <span className="truncate">{toolboxLabel}</span>
          </Chip>
        )}
        {cron.executionCount > 0 && (
          <Chip title={t('sidebar.crons.executions', { count: cron.executionCount })}>
            <Repeat className="size-2.5 shrink-0" />
            {cron.executionCount}
          </Chip>
        )}
      </div>

      {/* Next / last run */}
      <div className="hidden w-32 shrink-0 flex-col items-end gap-0.5 text-[11px] tabular-nums sm:flex" title={runLabel}>
        {nextRun ? (
          <span className="flex items-center gap-1 font-medium text-primary">
            <FastForward className="size-3 shrink-0" />
            {formatCountdown(nextRun)}
          </span>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        )}
        <span className="flex items-center gap-1 truncate text-muted-foreground">
          <History className="size-3 shrink-0" />
          {lastRunValue}
        </span>
      </div>

      {/* Control */}
      {cron.requiresApproval && onApprove ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5 text-xs"
          onClick={(e) => { e.stopPropagation(); onApprove() }}
        >
          <CheckCircle2 className="size-3.5 text-success" />
          <span className="max-sm:hidden">{t('sidebar.crons.approve')}</span>
        </Button>
      ) : !cron.requiresApproval && onToggleActive ? (
        <Switch
          checked={cron.isActive}
          onCheckedChange={(checked) => onToggleActive(checked)}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0"
          aria-label={statusLabel}
        />
      ) : null}
    </div>
  )
}

export function SortableCronRow({
  cron,
  llmModels,
  toolboxes,
  agents,
  onClick,
  onToggleActive,
  isRunning,
}: {
  cron: CronSummary
  llmModels?: LLMModel[]
  toolboxes?: Toolbox[]
  agents?: { id: string; model: string }[]
  onClick: () => void
  onToggleActive?: (isActive: boolean) => void
  isRunning?: boolean
}) {
  const { t } = useTranslation()
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
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('group relative bg-card', isDragging && 'z-10 opacity-60 shadow-lg')}
    >
      <CronRow
        cron={cron}
        llmModels={llmModels}
        toolboxes={toolboxes}
        agents={agents}
        onClick={onClick}
        onToggleActive={onToggleActive}
        isRunning={isRunning}
        dragHandle={
          <div
            {...attributes}
            {...listeners}
            className="flex cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical className="size-4" />
          </div>
        }
      />
    </div>
  )
}
