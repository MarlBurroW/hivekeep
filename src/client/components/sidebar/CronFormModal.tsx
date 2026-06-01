import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { Label } from '@/client/components/ui/label'
import { FormErrorAlert } from '@/client/components/common/FormErrorAlert'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { KinSelector } from '@/client/components/common/KinSelector'
import { KinSelectItem, type KinOption } from '@/client/components/common/KinSelectItem'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/components/ui/select'
import type { KinThinkingEffort } from '@/shared/types'
import { Switch } from '@/client/components/ui/switch'
import { Loader2, Sparkles, Trash2, Bell, AlertTriangle } from 'lucide-react'
import { InfoTip } from '@/client/components/common/InfoTip'
import { UnsavedChangesDialog } from '@/client/components/common/UnsavedChangesDialog'
import { useUnsavedChanges } from '@/client/hooks/useUnsavedChanges'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'
import { getErrorMessage } from '@/client/lib/api'
import { cronToHuman, isISODatetime } from '@/client/lib/cron-human'
import { cronNextRuns } from '@/client/lib/cron-next'
import type { CronSummary } from '@/shared/types'

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

interface CronFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  kins: KinOption[]
  llmModels: LLMModel[]
  cron?: CronSummary | null
  /** Pre-fill values for create mode (used when duplicating). */
  defaults?: Partial<CronSummary> | null
  onCreate?: (data: {
    kinId: string
    name: string
    schedule: string
    taskDescription: string
    targetKinId?: string
    model?: string
    providerId?: string
    runOnce?: boolean
    triggerParentTurn?: boolean
    thinkingEffort?: KinThinkingEffort | null
    toolboxIds?: string[]
  }) => Promise<CronSummary>
  onUpdate?: (id: string, updates: Record<string, unknown>) => Promise<CronSummary>
  onDelete?: (id: string) => Promise<void>
}

const CRON_PRESETS = [
  { key: 'presetEvery5m', value: '*/5 * * * *' },
  { key: 'presetEvery15m', value: '*/15 * * * *' },
  { key: 'presetEvery30m', value: '*/30 * * * *' },
  { key: 'presetHourly', value: '0 * * * *' },
  { key: 'presetDaily9am', value: '0 9 * * *' },
  { key: 'presetDaily6pm', value: '0 18 * * *' },
  { key: 'presetWeekdayMorning', value: '0 9 * * 1-5' },
  { key: 'presetWeekly', value: '0 9 * * 1' },
  { key: 'presetMonthly', value: '0 9 1 * *' },
] as const

export function CronFormModal({
  open,
  onOpenChange,
  kins,
  llmModels,
  cron,
  defaults,
  onCreate,
  onUpdate,
  onDelete,
}: CronFormModalProps) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { toolboxes } = useToolboxes()
  const serverTimezone = user?.serverTimezone
  const isEdit = !!cron

  // Unsaved changes guard
  const { markDirty, resetDirty, guardedClose, confirmDialogProps } = useUnsavedChanges({
    onClose: () => onOpenChange(false),
  })

  const [name, setName] = useState('')
  const [kinId, setKinId] = useState('')
  const [schedule, setSchedule] = useState('')
  const [runOnce, setRunOnce] = useState(false)
  const [triggerParentTurn, setTriggerParentTurn] = useState(false)
  const [scheduleDatetime, setScheduleDatetime] = useState('')
  const [taskDescription, setTaskDescription] = useState('')
  const [targetKinId, setTargetKinId] = useState<string>('')
  const [model, setModel] = useState('')
  const [modelProviderId, setModelProviderId] = useState('')
  const [thinkingEffort, setThinkingEffort] = useState<KinThinkingEffort | 'off'>('medium')
  const [selectedToolboxIds, setSelectedToolboxIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Populate form when editing or reset for create
  useEffect(() => {
    if (open) {
      if (cron) {
        setName(cron.name)
        setKinId(cron.kinId)
        const isOneShot = cron.runOnce && isISODatetime(cron.schedule)
        setRunOnce(cron.runOnce ?? false)
        setTriggerParentTurn(cron.triggerParentTurn ?? false)
        if (isOneShot) {
          setScheduleDatetime(cron.schedule.slice(0, 16)) // trim to datetime-local format
          setSchedule('')
        } else {
          setSchedule(cron.schedule)
          setScheduleDatetime('')
        }
        setTaskDescription(cron.taskDescription)
        setTargetKinId(cron.targetKinId ?? '')
        setModel(cron.model ?? '')
        setModelProviderId(cron.providerId ?? '')
        setThinkingEffort(cron.thinkingEffort ?? (cron.thinkingEnabled ? 'medium' : 'off'))
        setSelectedToolboxIds(cron.toolboxIds ?? [])
      } else if (defaults) {
        setName(defaults.name ?? '')
        setKinId(defaults.kinId ?? (kins.length === 1 ? kins[0]!.id : ''))
        setRunOnce(defaults.runOnce ?? false)
        setTriggerParentTurn(defaults.triggerParentTurn ?? false)
        setSchedule(defaults.schedule ?? '')
        setScheduleDatetime('')
        setTaskDescription(defaults.taskDescription ?? '')
        setTargetKinId(defaults.targetKinId ?? '')
        setModel(defaults.model ?? '')
        setModelProviderId(defaults.providerId ?? '')
        setThinkingEffort(defaults.thinkingEffort ?? (defaults.thinkingEnabled ? 'medium' : 'off'))
        setSelectedToolboxIds(defaults.toolboxIds ?? [])
      } else {
        setName('')
        setKinId(kins.length === 1 ? kins[0]!.id : '')
        setRunOnce(false)
        setTriggerParentTurn(false)
        setSchedule('')
        setScheduleDatetime('')
        setTaskDescription('')
        setTargetKinId('')
        setModel('')
        setModelProviderId('')
        setThinkingEffort('medium')
        setSelectedToolboxIds([])
      }
      setError(null)
      resetDirty()
    }
  }, [open, cron, defaults, kins, resetDirty])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setIsSubmitting(true)

    const effectiveSchedule = runOnce && scheduleDatetime ? scheduleDatetime : schedule

    const effortPayload: KinThinkingEffort | null = thinkingEffort === 'off' ? null : thinkingEffort

    try {
      if (isEdit && onUpdate && cron) {
        await onUpdate(cron.id, {
          name,
          schedule: effectiveSchedule,
          taskDescription,
          targetKinId: targetKinId || null,
          model: model || null,
          providerId: modelProviderId || null,
          runOnce,
          triggerParentTurn,
          thinkingEffort: effortPayload,
          toolboxIds: selectedToolboxIds,
        })
      } else if (onCreate) {
        await onCreate({
          kinId,
          name,
          schedule: effectiveSchedule,
          taskDescription,
          targetKinId: targetKinId || undefined,
          model: model || undefined,
          providerId: modelProviderId || undefined,
          runOnce: runOnce || undefined,
          triggerParentTurn,
          thinkingEffort: effortPayload,
          toolboxIds: selectedToolboxIds.length > 0 ? selectedToolboxIds : undefined,
        })
      }
      resetDirty()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!cron || !onDelete) return
    setIsSubmitting(true)
    try {
      await onDelete(cron.id)
      resetDirty()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const selectedKin = kins.find((k) => k.id === kinId)
  const effectiveScheduleForDisplay = runOnce && scheduleDatetime ? scheduleDatetime : schedule
  const scheduleHuman = useMemo(() => cronToHuman(effectiveScheduleForDisplay, i18n.language), [effectiveScheduleForDisplay, i18n.language])
  const scheduleInvalid = useMemo(() => {
    if (runOnce && scheduleDatetime) {
      const d = new Date(scheduleDatetime)
      return isNaN(d.getTime()) || d <= new Date()
    }
    return schedule.trim().length > 0 && !scheduleHuman
  }, [runOnce, scheduleDatetime, schedule, scheduleHuman])
  const nextRuns = useMemo(() => {
    if (runOnce && scheduleDatetime) return [] // one-shot: no recurring runs to preview
    return scheduleHuman ? cronNextRuns(schedule, 3, serverTimezone) : []
  }, [runOnce, scheduleDatetime, schedule, scheduleHuman, serverTimezone])

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { if (!v) guardedClose(); else onOpenChange(true) }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>
            {isEdit ? t('cron.edit.title') : t('cron.create.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit ? t('cron.edit.title') : t('cron.create.title')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Error alert */}
          {error && (
            <div className="shrink-0 px-6 pt-4">
              <FormErrorAlert error={error} animate />
            </div>
          )}

          {/* Form fields */}
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {/* Name */}
            <div className="space-y-2">
              <Label htmlFor="cronFormName" className="inline-flex items-center gap-1.5">{t('cron.create.name')} <InfoTip content={t('cron.create.nameTip')} /></Label>
              <Input
                id="cronFormName"
                value={name}
                onChange={(e) => { setName(e.target.value); markDirty() }}
                placeholder={t('cron.create.namePlaceholder')}
                required
              />
            </div>

            {/* Owner Kin */}
            <div className="space-y-2">
              <Label className="inline-flex items-center gap-1.5">{t('cron.create.kin')} <InfoTip content={t('cron.create.kinTip')} /></Label>
              {isEdit ? (
                <div className="flex items-center gap-2.5 rounded-md border border-input bg-muted/30 px-3 py-2">
                  {selectedKin && <KinSelectItem kin={selectedKin} />}
                </div>
              ) : (
                <KinSelector
                  value={kinId}
                  onValueChange={setKinId}
                  kins={kins}
                  placeholder={t('cron.create.kinPlaceholder')}
                  required
                />
              )}
            </div>

            {/* Schedule type toggle */}
            <div className="space-y-2">
              <Label className="inline-flex items-center gap-1.5">{t('cron.create.scheduleType', 'Schedule type')}</Label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { setRunOnce(false); markDirty() }}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    !runOnce
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {t('cron.create.recurring', 'Recurring')}
                </button>
                <button
                  type="button"
                  onClick={() => { setRunOnce(true); markDirty() }}
                  className={cn(
                    'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    runOnce
                      ? 'border-primary/50 bg-primary/10 text-primary'
                      : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {t('cron.create.oneTime', 'One-time')}
                </button>
              </div>
            </div>

            {/* Schedule */}
            <div className="space-y-2">
              <Label htmlFor="cronFormSchedule" className="inline-flex items-center gap-1.5">{t('cron.create.schedule')} <InfoTip content={t('cron.create.scheduleTip')} /></Label>
              {runOnce ? (
                <>
                  <Input
                    id="cronFormSchedule"
                    type="datetime-local"
                    value={scheduleDatetime}
                    onChange={(e) => { setScheduleDatetime(e.target.value); markDirty() }}
                    className={cn(scheduleInvalid && 'border-destructive focus-visible:ring-destructive/30')}
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">{t('cron.create.oneTimeHelp', 'Pick a date and time. The cron will fire once and then deactivate.')}</p>
                  {scheduleInvalid && scheduleDatetime && (
                    <p className="text-[11px] text-destructive">
                      {t('cron.create.datetimePast', 'Datetime must be in the future')}
                    </p>
                  )}
                  {scheduleDatetime && !scheduleInvalid && scheduleHuman && (
                    <p className="text-[11px] text-primary/80 italic">
                      {scheduleHuman} ({t('cron.create.serverTime')})
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Input
                    id="cronFormSchedule"
                    value={schedule}
                    onChange={(e) => { setSchedule(e.target.value); markDirty() }}
                    placeholder={t('cron.create.schedulePlaceholder')}
                    className={cn('font-mono', scheduleInvalid && 'border-destructive focus-visible:ring-destructive/30')}
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">{t('cron.create.scheduleHelp')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => { setSchedule(preset.value); markDirty() }}
                        className={cn(
                          'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                          schedule === preset.value
                            ? 'border-primary/50 bg-primary/10 text-primary'
                            : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        {t(`cron.create.${preset.key}`)}
                      </button>
                    ))}
                  </div>
                  {scheduleInvalid && (
                    <p className="text-[11px] text-destructive">
                      {t('cron.create.scheduleInvalid')}
                    </p>
                  )}
                  {scheduleHuman && (
                    <div className="space-y-0.5">
                      <p className="text-[11px] text-primary/80 italic">
                        {scheduleHuman} ({t('cron.create.serverTime')})
                      </p>
                      {nextRuns.length > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {t('cron.create.nextRuns')}: {nextRuns.map((d) =>
                            d.toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
                          ).join(', ')}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Task description (MarkdownEditor) */}
            <div className="space-y-2">
              <Label className="inline-flex items-center gap-1.5">{t('cron.create.taskDescription')} <InfoTip content={t('cron.create.taskDescriptionTip')} /></Label>
              <MarkdownEditor
                value={taskDescription}
                onChange={(v) => { setTaskDescription(v); markDirty() }}
                height="160px"
              />
            </div>

            {/* Target Kin (optional) */}
            <div className="space-y-2">
              <Label className="inline-flex items-center gap-1.5">{t('cron.create.targetKin')} <InfoTip content={t('cron.create.targetKinTip')} /></Label>
              <KinSelector
                value={targetKinId}
                onValueChange={setTargetKinId}
                kins={kins}
                placeholder="—"
                noneLabel="—"
              />
              <p className="text-[11px] text-muted-foreground">{t('cron.create.targetKinHint')}</p>
            </div>

            {/* Model (ModelPicker) */}
            <div className="space-y-2">
              <Label className="inline-flex items-center gap-1.5">{t('cron.create.model')} <InfoTip content={t('cron.create.modelTip')} /></Label>
              <ModelPicker
                models={llmModels}
                value={modelPickerValue(model, modelProviderId)}
                onValueChange={(modelId, pid) => { setModel(modelId); setModelProviderId(pid) }}
                placeholder={t('cron.create.modelPlaceholder')}
                allowClear
              />
            </div>

            {/* Thinking effort */}
            <div className="space-y-2">
              <Label className="inline-flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                {t('chat.thinkingPicker.title')}
              </Label>
              <Select
                value={thinkingEffort}
                onValueChange={(v) => { setThinkingEffort(v as KinThinkingEffort | 'off'); markDirty() }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('chat.thinkingPicker.effort.off')}</SelectItem>
                  <SelectItem value="low">{t('chat.thinkingPicker.effort.low')}</SelectItem>
                  <SelectItem value="medium">{t('chat.thinkingPicker.effort.medium')}</SelectItem>
                  <SelectItem value="high">{t('chat.thinkingPicker.effort.high')}</SelectItem>
                  <SelectItem value="max">{t('chat.thinkingPicker.effort.max')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Toolboxes */}
            {toolboxes.length > 0 && (
              <div className="space-y-2">
                <Label className="inline-flex items-center gap-1.5">
                  {t('cron.create.toolboxes')} <InfoTip content={t('cron.create.toolboxesTip')} />
                </Label>
                <ToolboxMultiSelect
                  toolboxes={toolboxes}
                  selected={selectedToolboxIds}
                  onChange={(next) => { setSelectedToolboxIds(next); markDirty() }}
                  disabled={isSubmitting}
                />
                <p className="text-[11px] text-muted-foreground">{t('cron.create.toolboxesHelp')}</p>
              </div>
            )}

            {/* Trigger parent turn */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3 rounded-md border border-input bg-muted/30 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="cronTriggerParentTurn" className="inline-flex items-center gap-1.5 cursor-pointer">
                    <Bell className="size-3.5" />
                    {t('cron.triggerParentTurn.label')}
                  </Label>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{t('cron.triggerParentTurn.help')}</p>
                </div>
                <Switch
                  id="cronTriggerParentTurn"
                  checked={triggerParentTurn}
                  onCheckedChange={(v) => { setTriggerParentTurn(v); markDirty() }}
                  className="shrink-0"
                />
              </div>
              {triggerParentTurn && (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{t('cron.triggerParentTurn.warning')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 flex items-center border-t px-6 py-3">
            {isEdit && onDelete && cron && (
              <ConfirmDeleteButton
                onConfirm={handleDelete}
                title={t('cron.edit.delete')}
                description={t('cron.edit.deleteConfirm')}
                confirmLabel={t('cron.edit.deleteAction')}
                trigger={
                  <Button type="button" variant="destructive" size="sm" className="mr-auto">
                    <Trash2 className="mr-1.5 size-3.5" />
                    {t('cron.edit.delete')}
                  </Button>
                }
              />
            )}

            <Button
              type="submit"
              disabled={isSubmitting || !name || (runOnce ? !scheduleDatetime : !schedule) || scheduleInvalid || !taskDescription || (!isEdit && !kinId)}
              className="ml-auto btn-shine"
              size="sm"
            >
              {isSubmitting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {isEdit ? t('cron.edit.save') : t('cron.create.submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>

    {/* Unsaved changes confirmation */}
    <UnsavedChangesDialog {...confirmDialogProps} />
    </>
  )
}
