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
import { useAuth } from '@/client/hooks/useAuth'
import { getPublicUrlMismatch } from '@/client/lib/public-url'
import { AlertTriangle } from 'lucide-react'

const MAX_CONCURRENT_UPPER_BOUND = 1000
const MAX_QUEUE_UPPER_BOUND = 100_000

export function GeneralSettings() {
  const { t } = useTranslation()
  const { user } = useAuth()

  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Configured public URL (best-effort, for the misconfiguration warning).
  const [publicUrl, setPublicUrl] = useState<string | null>(null)

  // Global prompt
  const [globalPrompt, setGlobalPrompt] = useState('')
  const [initialGlobalPrompt, setInitialGlobalPrompt] = useState('')

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

  // Best-effort — the public-URL warning must never block the settings load.
  useEffect(() => {
    api
      .get<{ publicUrl: string }>('/info')
      .then((info) => setPublicUrl(info.publicUrl ?? null))
      .catch(() => {})
  }, [])

  const fetchSettings = async () => {
    try {
      const [prompt, taskLimits] = await Promise.all([
        api.get<{ globalPrompt: string }>('/settings/global-prompt'),
        api.get<{ maxConcurrent: number; maxQueue: number }>('/settings/task-limits'),
      ])
      setGlobalPrompt(prompt.globalPrompt)
      setInitialGlobalPrompt(prompt.globalPrompt)
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
      toast.success(t('settings.general.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const handleDiscard = () => {
    setGlobalPrompt(initialGlobalPrompt)
  }

  const MAX_PROMPT_LENGTH = 10000
  const hasPromptChanges = globalPrompt !== initialGlobalPrompt
  const hasChanges = hasPromptChanges
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

  // Public-URL misconfiguration warning — only admins can act on it (env + restart).
  const isAdmin = user?.role === 'admin'
  const publicUrlMismatch = getPublicUrlMismatch(publicUrl)

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
      {isAdmin && publicUrlMismatch && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-300">
              {t('settings.general.publicUrlWarning.title')}
            </p>
            <p className="text-muted-foreground">
              {t('settings.general.publicUrlWarning.body', publicUrlMismatch)}
            </p>
            <p className="text-muted-foreground">
              {t('settings.general.publicUrlWarning.fix', { actual: publicUrlMismatch.actual })}
            </p>
          </div>
        </div>
      )}

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
