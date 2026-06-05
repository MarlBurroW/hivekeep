import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { api, getErrorMessage, toastError } from '@/client/lib/api'
import { Skeleton } from '@/client/components/ui/skeleton'
import { InfoTip } from '@/client/components/common/InfoTip'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { getToolCallsDefaultOpen, setToolCallsDefaultOpen } from '@/client/lib/tool-call-prefs'

const MAX_CONCURRENT_UPPER_BOUND = 1000
const MAX_QUEUE_UPPER_BOUND = 100_000

export function GeneralSettings() {
  const { t } = useTranslation()

  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Global prompt
  const [globalPrompt, setGlobalPrompt] = useState('')
  const [initialGlobalPrompt, setInitialGlobalPrompt] = useState('')

  // Global avatar art-style directive (applies to newly generated Kin avatars)
  const [avatarStyle, setAvatarStyle] = useState('')
  const [initialAvatarStyle, setInitialAvatarStyle] = useState('')

  // Global task execution-slot limits (kept as strings so an in-progress edit
  // can be empty without coercing to 0; validated on save).
  const [maxConcurrent, setMaxConcurrent] = useState('')
  const [initialMaxConcurrent, setInitialMaxConcurrent] = useState('')
  const [maxQueue, setMaxQueue] = useState('')
  const [initialMaxQueue, setInitialMaxQueue] = useState('')
  const [savingTaskLimits, setSavingTaskLimits] = useState(false)

  // Saving state
  const [saving, setSaving] = useState(false)

  // Interface preference: expand tool calls by default (client-side, applies instantly)
  const [toolsDefaultOpen, setToolsDefaultOpenState] = useState(getToolCallsDefaultOpen)

  const handleToolsDefaultOpenChange = (value: boolean) => {
    setToolsDefaultOpenState(value)
    setToolCallsDefaultOpen(value)
  }

  useEffect(() => {
    setFetchError(null)
    fetchSettings().catch(() => {})
  }, [])

  const fetchSettings = async () => {
    try {
      const [prompt, taskLimits, avatar] = await Promise.all([
        api.get<{ globalPrompt: string }>('/settings/global-prompt'),
        api.get<{ maxConcurrent: number; maxQueue: number }>('/settings/task-limits'),
        api.get<{ avatarStyle: string }>('/settings/avatar-style'),
      ])
      setGlobalPrompt(prompt.globalPrompt)
      setInitialGlobalPrompt(prompt.globalPrompt)
      setAvatarStyle(avatar.avatarStyle)
      setInitialAvatarStyle(avatar.avatarStyle)
      setMaxConcurrent(String(taskLimits.maxConcurrent))
      setInitialMaxConcurrent(String(taskLimits.maxConcurrent))
      setMaxQueue(String(taskLimits.maxQueue))
      setInitialMaxQueue(String(taskLimits.maxQueue))
    } catch (err: unknown) {
      setFetchError(getErrorMessage(err))
      toast.error(t('settings.general.fetchError', 'Failed to load settings'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleSaveTaskLimits = async () => {
    const concurrent = Number(maxConcurrent)
    const queue = Number(maxQueue)
    setSavingTaskLimits(true)
    try {
      const data = await api.put<{ maxConcurrent: number; maxQueue: number }>(
        '/settings/task-limits',
        { maxConcurrent: concurrent, maxQueue: queue },
      )
      setMaxConcurrent(String(data.maxConcurrent))
      setInitialMaxConcurrent(String(data.maxConcurrent))
      setMaxQueue(String(data.maxQueue))
      setInitialMaxQueue(String(data.maxQueue))
      toast.success(t('settings.general.tasks.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingTaskLimits(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      if (hasPromptChanges) {
        await api.put('/settings/global-prompt', { globalPrompt })
        setInitialGlobalPrompt(globalPrompt)
      }
      if (hasAvatarChanges) {
        const data = await api.put<{ avatarStyle: string }>('/settings/avatar-style', { avatarStyle })
        setAvatarStyle(data.avatarStyle)
        setInitialAvatarStyle(data.avatarStyle)
      }
      toast.success(t('settings.general.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    setGlobalPrompt(initialGlobalPrompt)
    setAvatarStyle(initialAvatarStyle)
  }

  const MAX_PROMPT_LENGTH = 10000
  const hasPromptChanges = globalPrompt !== initialGlobalPrompt
  const hasAvatarChanges = avatarStyle !== initialAvatarStyle
  const hasChanges = hasPromptChanges || hasAvatarChanges
  const approxTokens = Math.ceil(globalPrompt.length / 4)
  const isOverLimit = globalPrompt.length > MAX_PROMPT_LENGTH

  // Task-limit validation: integers within the same bounds the API enforces.
  const concurrentNum = Number(maxConcurrent)
  const queueNum = Number(maxQueue)
  const isConcurrentValid =
    maxConcurrent.trim() !== '' &&
    Number.isInteger(concurrentNum) &&
    concurrentNum >= 1 &&
    concurrentNum <= MAX_CONCURRENT_UPPER_BOUND
  const isQueueValid =
    maxQueue.trim() !== '' &&
    Number.isInteger(queueNum) &&
    queueNum >= 0 &&
    queueNum <= MAX_QUEUE_UPPER_BOUND
  const hasTaskLimitChanges =
    maxConcurrent !== initialMaxConcurrent || maxQueue !== initialMaxQueue
  const canSaveTaskLimits =
    hasTaskLimitChanges && isConcurrentValid && isQueueValid && !savingTaskLimits

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-4 w-3/4" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-[240px] w-full rounded-md" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{fetchError}</p>
        <Button variant="outline" onClick={() => {
          setIsLoading(true)
          setFetchError(null)
          fetchSettings().catch(() => {})
        }}>
          {t('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {t('settings.general.description')}
      </p>

      {/* Global prompt */}
      <div className="space-y-2">
        <Label htmlFor="global-prompt" className="inline-flex items-center gap-1.5">
          {t('settings.general.globalPrompt')}
          <InfoTip content={t('settings.general.globalPromptTip')} />
        </Label>
        <MarkdownEditor
          value={globalPrompt}
          onChange={setGlobalPrompt}
          height="240px"
        />
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t('settings.general.globalPromptHint')}
          </p>
          <p className={`text-xs tabular-nums ${isOverLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
            {globalPrompt.length.toLocaleString()}/{MAX_PROMPT_LENGTH.toLocaleString()} · ~{approxTokens} tokens
          </p>
        </div>
      </div>

      {/* Global avatar art style */}
      <div className="space-y-2">
        <Label htmlFor="avatar-style" className="inline-flex items-center gap-1.5">
          {t('settings.general.avatarStyle', 'Avatar art style')}
          <InfoTip content={t('settings.general.avatarStyleTip', 'Applied to every newly generated Kin avatar so they share a consistent look. Leave empty for the default friendly Pixar-robot style. Does not change existing avatars.')} />
        </Label>
        <Input
          id="avatar-style"
          value={avatarStyle}
          onChange={(e) => setAvatarStyle(e.target.value)}
          placeholder={t('settings.general.avatarStylePlaceholder', 'e.g. heroic fantasy, cyberpunk cyborg, watercolor…')}
          maxLength={2000}
        />
        <p className="text-xs text-muted-foreground">
          {t('settings.general.avatarStyleHint', 'A short art-style directive shared by all generated avatars.')}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saving || isOverLimit}
        >
          {saving ? t('common.loading') : t('common.save')}
        </Button>
        {hasChanges && (
          <Button
            variant="ghost"
            onClick={handleDiscard}
          >
            {t('common.discard', 'Discard')}
          </Button>
        )}
      </div>

      {/* Interface preferences (applied instantly, stored locally) */}
      <div className="space-y-3 border-t border-border/60 pt-6">
        <h3 className="text-sm font-medium">{t('settings.general.interface.title')}</h3>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <div className="space-y-0.5">
            <Label htmlFor="tools-default-open" className="cursor-pointer">
              {t('settings.general.toolsDefaultOpen.label')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.general.toolsDefaultOpen.hint')}
            </p>
          </div>
          <Switch
            id="tools-default-open"
            checked={toolsDefaultOpen}
            onCheckedChange={handleToolsDefaultOpenChange}
          />
        </div>
      </div>

      {/* Global task execution-slot limits */}
      <div className="space-y-3 border-t border-border/60 pt-6">
        <h3 className="text-sm font-medium">{t('settings.general.tasks.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('settings.general.tasks.description')}
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="max-concurrent-tasks" className="inline-flex items-center gap-1.5">
              {t('settings.general.tasks.maxConcurrent.label')}
              <InfoTip content={t('settings.general.tasks.maxConcurrent.tip')} />
            </Label>
            <Input
              id="max-concurrent-tasks"
              type="number"
              min={1}
              max={MAX_CONCURRENT_UPPER_BOUND}
              step={1}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(e.target.value)}
              aria-invalid={maxConcurrent.trim() !== '' && !isConcurrentValid}
              className="tabular-nums"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="max-queued-tasks" className="inline-flex items-center gap-1.5">
              {t('settings.general.tasks.maxQueue.label')}
              <InfoTip content={t('settings.general.tasks.maxQueue.tip')} />
            </Label>
            <Input
              id="max-queued-tasks"
              type="number"
              min={0}
              max={MAX_QUEUE_UPPER_BOUND}
              step={1}
              value={maxQueue}
              onChange={(e) => setMaxQueue(e.target.value)}
              aria-invalid={maxQueue.trim() !== '' && !isQueueValid}
              className="tabular-nums"
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {t('settings.general.tasks.hint')}
        </p>

        <div className="flex items-center gap-2">
          <Button
            onClick={handleSaveTaskLimits}
            disabled={!canSaveTaskLimits}
          >
            {savingTaskLimits ? t('common.loading') : t('common.save')}
          </Button>
          {hasTaskLimitChanges && (
            <Button
              variant="ghost"
              onClick={() => {
                setMaxConcurrent(initialMaxConcurrent)
                setMaxQueue(initialMaxQueue)
              }}
            >
              {t('common.discard', 'Discard')}
            </Button>
          )}
        </div>
      </div>

      <HelpPanel
        contentKey="settings.general.help.content"
        bulletKeys={[
          'settings.general.help.bullet1',
          'settings.general.help.bullet2',
        ]}
        storageKey="help.general.open"
      />
    </div>
  )
}
