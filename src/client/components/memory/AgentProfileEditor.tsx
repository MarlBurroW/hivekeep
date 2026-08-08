import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw, Save, Brain } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/client/components/ui/alert-dialog'
import { useAgentProfile } from '@/client/hooks/useAgentProfile'
import { getErrorMessage } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'

/**
 * Editor for an Agent's curated memory profile — the document injected into
 * every prompt. The episodic archive lives in the sibling MemoryList.
 */
export function AgentProfileEditor({ agentId }: { agentId: string }) {
  const { t } = useTranslation()
  const { profile, loading, error, save, regenerate } = useAgentProfile(agentId)

  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Adopt server content unless the user has unsaved edits, so a maintenance
  // rewrite arriving over SSE doesn't silently discard what they typed.
  useEffect(() => {
    if (profile && !dirty) setDraft(profile.content)
  }, [profile, dirty])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await save(draft)
      setDirty(false)
    } catch (err) {
      setSaveError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerate = async () => {
    setRegenerating(true)
    setSaveError(null)
    try {
      await regenerate()
      setDirty(false)
    } catch (err) {
      setSaveError(getErrorMessage(err))
    } finally {
      setRegenerating(false)
    }
  }

  if (loading && !profile) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('common.loading')}
      </div>
    )
  }

  const budget = profile?.budget ?? 0
  const tokens = profile?.tokenEstimate ?? 0
  const overBudget = budget > 0 && tokens > budget

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Label className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Brain className="size-4" />
          {t('agent.memoryProfile.title')}
        </Label>

        <div className="flex items-center gap-2">
          <span
            className={cn(
              'font-mono text-xs tabular-nums',
              overBudget ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {t('agent.memoryProfile.tokenCount', { tokens, budget })}
          </span>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={regenerating}>
                {regenerating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {t('agent.memoryProfile.regenerate')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('agent.memoryProfile.regenerateConfirmTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('agent.memoryProfile.regenerateConfirmDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={handleRegenerate}>
                  {t('agent.memoryProfile.regenerate')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Button type="button" size="sm" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t('common.save')}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('agent.memoryProfile.description')}
      </p>

      <MarkdownEditor
        value={draft}
        onChange={(v) => { setDraft(v); setDirty(true) }}
        height="320px"
      />

      {regenerating && (
        <p className="text-xs text-muted-foreground">{t('agent.memoryProfile.regenerating')}</p>
      )}
      {(saveError || error) && (
        <p className="text-xs text-destructive">{saveError ?? error}</p>
      )}
    </div>
  )
}
