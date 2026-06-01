import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useSSE } from '@/client/hooks/useSSE'
import { useAuth } from '@/client/hooks/useAuth'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Badge } from '@/client/components/ui/badge'
import { Button } from '@/client/components/ui/button'
import { Switch } from '@/client/components/ui/switch'
import { Label } from '@/client/components/ui/label'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import {
  ArrowRight,
  Clock,
  Pencil,
  Loader2,
  Cpu,
  Copy,
  Play,
  Sparkles,
  Bell,
  Lock,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { cn } from '@/client/lib/utils'
import { formatRelativeTime, formatDurationBetween } from '@/client/lib/time'
import { cronToHuman } from '@/client/lib/cron-human'
import { cronNextRun, formatCountdown } from '@/client/lib/cron-next'
import { taskStatusMeta, isTerminalStatus } from '@/client/lib/task-status'
import { api } from '@/client/lib/api'
import type { CronSummary, TaskSummary, TaskStatus } from '@/shared/types'

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

interface CronDetailModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  cron: CronSummary
  llmModels: LLMModel[]
  onEdit: () => void
  onDuplicate?: () => void
  onApprove: (id: string) => Promise<CronSummary>
  onToggleActive: (id: string, isActive: boolean) => Promise<CronSummary>
}

export function CronDetailModal({
  open,
  onOpenChange,
  cron,
  llmModels,
  onEdit,
  onDuplicate,
  onApprove,
  onToggleActive,
}: CronDetailModalProps) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { toolboxes } = useToolboxes()
  const serverTimezone = user?.serverTimezone
  const { openTask } = useSidePanel()

  // Resolve the cron's selected toolbox ids to their objects (preserving order).
  const selectedToolboxes = (cron.toolboxIds ?? [])
    .map((id) => toolboxes.find((tb) => tb.id === id))
    .filter((tb): tb is NonNullable<typeof tb> => tb != null)
  const [executions, setExecutions] = useState<TaskSummary[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [isTogglingActive, setIsTogglingActive] = useState(false)
  const [isApproving, setIsApproving] = useState(false)
  const [isTriggering, setIsTriggering] = useState(false)

  const kinName = cron.kinName
  const initials = kinName.slice(0, 2).toUpperCase()

  const fetchExecutions = useCallback(async () => {
    setIsLoadingHistory(true)
    setHistoryError(false)
    try {
      const data = await api.get<TasksResponse>(`/tasks?cronId=${cron.id}&limit=20&offset=0`)
      setExecutions(data.tasks)
    } catch {
      setHistoryError(true)
    } finally {
      setIsLoadingHistory(false)
    }
  }, [cron.id])

  useEffect(() => {
    if (open) fetchExecutions()
  }, [open, fetchExecutions])

  // Keep execution statuses in sync via SSE
  useSSE({
    'task:status': (data) => {
      const taskId = data.taskId as string
      const status = data.status as TaskStatus
      setExecutions((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status, updatedAt: new Date().toISOString() } : t))
      )
    },
    'task:done': (data) => {
      const taskId = data.taskId as string
      const status = data.status as TaskStatus
      const title = (data.title as string) ?? null
      setExecutions((prev) =>
        prev.map((t) => (t.id === taskId ? { ...t, status, ...(title && { title }), updatedAt: new Date().toISOString() } : t))
      )
    },
  })

  async function handleToggleActive(checked: boolean) {
    setIsTogglingActive(true)
    try {
      await onToggleActive(cron.id, checked)
    } catch {
      // Error handled upstream
    } finally {
      setIsTogglingActive(false)
    }
  }

  async function handleApprove() {
    setIsApproving(true)
    try {
      await onApprove(cron.id)
    } catch {
      // Error handled upstream
    } finally {
      setIsApproving(false)
    }
  }

  async function handleTrigger() {
    setIsTriggering(true)
    try {
      await api.post(`/crons/${cron.id}/trigger`)
      toast.success(t('cron.detail.triggerSuccess'))
      await fetchExecutions()
    } catch {
      toast.error(t('cron.detail.triggerError'))
    } finally {
      setIsTriggering(false)
    }
  }

  const handleOpenTask = useCallback((task: TaskSummary) => {
    openTask({
      taskId: task.id,
      kinName: task.sourceKinName ?? task.parentKinName ?? cron.kinName,
      kinAvatarUrl: task.sourceKinAvatarUrl ?? task.parentKinAvatarUrl ?? cron.kinAvatarUrl,
    })
    onOpenChange(false)
  }, [openTask, onOpenChange, cron.kinName, cron.kinAvatarUrl])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] overflow-hidden flex flex-col gap-0 !p-0 sm:max-w-2xl">
          {/* Header */}
          <DialogHeader className="shrink-0 px-6 pt-6 pb-3 border-b border-border">
            <div className="flex items-center gap-3">
              <Avatar className="size-9 shrink-0">
                {cron.kinAvatarUrl && <AvatarImage src={cron.kinAvatarUrl} alt={kinName} />}
                <AvatarFallback className="text-xs bg-secondary">{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-base truncate">{cron.name}</DialogTitle>
                <DialogDescription className="sr-only">{cron.name}</DialogDescription>
                <p className="text-xs text-muted-foreground truncate">{kinName}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {cron.requiresApproval ? (
                  <Badge variant="outline" className="text-warning border-warning/40">
                    {t('sidebar.crons.pendingApproval')}
                  </Badge>
                ) : cron.isActive ? (
                  <Badge variant="default" className="bg-success/20 text-success border-success/40">
                    {t('sidebar.crons.active')}
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    {t('sidebar.crons.paused')}
                  </Badge>
                )}
                {cron.runOnce && (
                  <Badge variant="outline" className="text-info border-info/40">
                    {t('cron.detail.oneTime', 'One-time')}
                  </Badge>
                )}
                {cron.triggerParentTurn && (
                  <Badge variant="outline" className="text-chart-4 border-chart-4/40">
                    <Bell className="mr-1 size-3" />
                    {t('cron.triggerParentTurn.badge')}
                  </Badge>
                )}
              </div>
            </div>
          </DialogHeader>

          {/* Content */}
          <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">
            <div className="space-y-4">
              {/* Schedule */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('cron.detail.schedule')}</p>
                <p className="text-sm">
                  {cronToHuman(cron.schedule, i18n.language) ?? cron.schedule}
                  {cronToHuman(cron.schedule, i18n.language) && (
                    <span className="ml-1.5 text-xs text-muted-foreground">({t('cron.create.serverTime')})</span>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Clock className="size-3.5 text-muted-foreground shrink-0" />
                  <code className="text-xs font-mono text-muted-foreground">{cron.schedule}</code>
                </div>
                {cron.lastTriggeredAt && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('sidebar.crons.lastRun', { time: formatRelativeTime(cron.lastTriggeredAt, { suffix: true }) })}
                  </p>
                )}
                {cron.isActive && !cron.requiresApproval && (() => {
                  const next = cronNextRun(cron.schedule, serverTimezone)
                  if (!next) return null
                  return (
                    <p className="text-[11px] text-primary/80">
                      {t('sidebar.crons.nextRun', { time: formatCountdown(next) })} — {next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  )
                })()}
              </div>

              {/* Description */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('cron.detail.description')}</p>
                <div className="max-h-48 overflow-y-auto rounded-md bg-muted/50 px-3 py-2 text-sm">
                  <MarkdownContent content={cron.taskDescription} />
                </div>
              </div>

              {/* Target Kin */}
              {cron.targetKinId && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t('cron.detail.targetKin')}</p>
                  <div className="flex items-center gap-2">
                    <ArrowRight className="size-3.5 text-muted-foreground shrink-0" />
                    <Avatar className="size-5 shrink-0">
                      {cron.targetKinAvatarUrl && <AvatarImage src={cron.targetKinAvatarUrl} alt={cron.targetKinName ?? ''} />}
                      <AvatarFallback className="text-[10px] bg-secondary">
                        {(cron.targetKinName ?? '?').slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm">{cron.targetKinName ?? cron.targetKinId}</span>
                  </div>
                </div>
              )}

              {/* Model */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('cron.detail.model')}</p>
                {cron.model ? (
                  (() => {
                    const resolvedModel = llmModels.find((m) => m.id === cron.model)
                    return (
                      <div className="flex items-center gap-2 text-sm">
                        {resolvedModel ? (
                          <ProviderIcon providerType={resolvedModel.providerType} className="size-4 shrink-0" />
                        ) : (
                          <Cpu className="size-4 shrink-0 text-muted-foreground" />
                        )}
                        <span>{resolvedModel?.name ?? cron.model}</span>
                      </div>
                    )
                  })()
                ) : (
                  <p className="text-sm text-muted-foreground italic">{t('cron.detail.modelInherited')}</p>
                )}
              </div>

              {/* Toolboxes */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('cron.detail.toolboxes')}</p>
                {selectedToolboxes.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">{t('cron.detail.toolboxesAll')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedToolboxes.map((tb) => (
                      <span
                        key={tb.id}
                        title={tb.description ?? undefined}
                        className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-2.5 py-1 text-xs text-primary"
                      >
                        {tb.builtin ? <Lock className="size-3" /> : <Wrench className="size-3" />}
                        {tb.builtin ? t(`toolboxes.builtin.${tb.name}`, tb.name) : tb.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {cron.thinkingEnabled && (
                <div className="flex items-center gap-1.5 text-xs text-chart-4">
                  <Sparkles className="size-3" />
                  <span>{t('chat.thinkingToggle')}</span>
                </div>
              )}

              {cron.triggerParentTurn && (
                <div className="flex items-start gap-2 rounded-md border border-chart-4/30 bg-chart-4/5 px-3 py-2 text-xs text-chart-4">
                  <Bell className="mt-0.5 size-3.5 shrink-0" />
                  <span>{t('cron.triggerParentTurn.detail')}</span>
                </div>
              )}

              {/* Active toggle */}
              {!cron.requiresApproval && (
                <div className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
                  <Label htmlFor="cronActiveToggle" className="text-sm cursor-pointer">
                    {t('sidebar.crons.active')}
                  </Label>
                  <Switch
                    id="cronActiveToggle"
                    checked={cron.isActive}
                    onCheckedChange={handleToggleActive}
                    disabled={isTogglingActive}
                  />
                </div>
              )}

              {/* Execution history */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('cron.detail.history')}
                  {executions.length > 0 && (
                    <span className="ml-1.5 text-[11px] font-normal">
                      ({t('cron.detail.executions', { count: executions.length })})
                    </span>
                  )}
                </p>

                {isLoadingHistory ? (
                  <div className="flex justify-center py-4">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : historyError ? (
                  <div className="flex flex-col items-center gap-2 py-4">
                    <p className="text-xs text-destructive">{t('cron.detail.historyError')}</p>
                    <button
                      type="button"
                      onClick={fetchExecutions}
                      className="text-xs text-primary underline hover:no-underline"
                    >
                      {t('common.retry')}
                    </button>
                  </div>
                ) : executions.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    {t('cron.detail.historyEmpty')}
                  </p>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {executions.map((task) => {
                      const statusMeta = taskStatusMeta(task.status)
                      const StatusIcon = statusMeta.icon
                      const statusSpin = task.status === 'in_progress'
                      const isFinished = isTerminalStatus(task.status)
                      const duration = isFinished
                        ? formatDurationBetween(task.createdAt, task.updatedAt)
                        : undefined

                      return (
                        <div
                          key={task.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleOpenTask(task)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenTask(task) }}
                          className="flex items-center gap-3 rounded-lg bg-sidebar-accent/30 px-3 py-2 text-xs hover:bg-sidebar-accent/50 transition-colors cursor-pointer"
                        >
                          <StatusIcon className={cn('size-3.5 shrink-0', statusMeta.textClass, statusSpin && 'animate-spin', !statusSpin && statusMeta.pulse && 'animate-pulse')} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-foreground">
                              {task.title ?? task.description.slice(0, 60)}
                            </p>
                          </div>
                          {duration && (
                            <span className="text-[10px] text-muted-foreground shrink-0">{duration}</span>
                          )}
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {formatRelativeTime(new Date(task.createdAt).getTime(), { suffix: true })}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <DialogFooter className="shrink-0 flex-row items-center gap-2 px-6 pb-6 pt-3 border-t border-border">
            {cron.requiresApproval && (
              <Button
                size="sm"
                onClick={handleApprove}
                disabled={isApproving}
                className="btn-shine"
              >
                {isApproving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                {t('sidebar.crons.approve')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => { onOpenChange(false); onEdit() }}
            >
              <Pencil className="mr-1.5 size-3.5" />
              {t('common.edit')}
            </Button>
            {onDuplicate && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { onOpenChange(false); onDuplicate() }}
              >
                <Copy className="mr-1.5 size-3.5" />
                {t('cron.detail.duplicate')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTrigger}
              disabled={isTriggering}
            >
              {isTriggering ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Play className="mr-1.5 size-3.5" />}
              {t('cron.detail.runNow')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="ml-auto"
            >
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  )
}
