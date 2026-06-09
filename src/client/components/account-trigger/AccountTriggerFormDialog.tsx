import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { api, getErrorMessage } from '@/client/lib/api'
import { useAgents } from '@/client/hooks/useAgents'
import { ConditionNodeEditor, defaultGroup } from '@/client/components/account-trigger/ConditionBuilder'
import type { AccountTriggerSummary, ConditionNode, TriggerDispatchMode } from '@/shared/types'

interface EmailFolder { id: string; name: string }

interface Props {
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  /** When set, the dialog edits this trigger; otherwise it creates a new one. */
  trigger?: AccountTriggerSummary
}

export function AccountTriggerFormDialog({ accountId, open, onOpenChange, onSaved, trigger }: Props) {
  const { t } = useTranslation()
  const { agents } = useAgents()

  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [folder, setFolder] = useState('INBOX')
  const [targetAgentId, setTargetAgentId] = useState('')
  const [dispatchMode, setDispatchMode] = useState<TriggerDispatchMode>('conversation')
  const [conditions, setConditions] = useState<ConditionNode>(defaultGroup())
  const [folders, setFolders] = useState<EmailFolder[]>([{ id: 'INBOX', name: 'INBOX' }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>()

  // Initialize from the edited trigger (or defaults) whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setError(undefined)
    if (trigger) {
      setName(trigger.name)
      setPrompt(trigger.prompt)
      setFolder(trigger.folder)
      setTargetAgentId(trigger.targetAgentId)
      setDispatchMode(trigger.dispatchMode)
      setConditions(trigger.conditions)
    } else {
      setName('')
      setPrompt('')
      setFolder('INBOX')
      setTargetAgentId(agents[0]?.id ?? '')
      setDispatchMode('conversation')
      setConditions(defaultGroup())
    }
  }, [open, trigger, agents])

  // Load the account's folders for the picker.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const res = await api.get<{ folders: EmailFolder[] }>(`/email-accounts/${accountId}/folders`)
        if (!cancelled && res.folders.length > 0) setFolders(res.folders)
      } catch {
        // Keep the INBOX fallback.
      }
    })()
    return () => { cancelled = true }
  }, [open, accountId])

  const submit = async () => {
    setError(undefined)
    if (!name.trim()) return setError(t('settings.triggers.errorName'))
    if (!prompt.trim()) return setError(t('settings.triggers.errorPrompt'))
    if (!targetAgentId) return setError(t('settings.triggers.errorAgent'))

    setSubmitting(true)
    try {
      const body = { accountId, name: name.trim(), folder, conditions, prompt: prompt.trim(), targetAgentId, dispatchMode }
      if (trigger) await api.patch(`/account-triggers/${trigger.id}`, body)
      else await api.post('/account-triggers', body)
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={trigger ? t('settings.triggers.editTitle') : t('settings.triggers.addTitle')}
      description={t('settings.triggers.dialogDescription')}
      error={error}
      onSubmit={() => void submit()}
      isSubmitting={submitting}
      submitLabel={trigger ? t('common.save') : t('common.create')}
    >
      <FormField label={t('settings.triggers.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('settings.triggers.namePlaceholder')} />
      </FormField>

      <div className="grid grid-cols-2 gap-3">
        <FormField label={t('settings.triggers.folder')}>
          <Select value={folder} onValueChange={setFolder}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {folders.map((f) => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormField>

        <FormField label={t('settings.triggers.targetAgent')}>
          <Select value={targetAgentId} onValueChange={setTargetAgentId}>
            <SelectTrigger><SelectValue placeholder={t('settings.triggers.selectAgent')} /></SelectTrigger>
            <SelectContent>
              {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </FormField>
      </div>

      <FormField label={t('settings.triggers.conditions')} hint={t('settings.triggers.conditionsHint')}>
        <ConditionNodeEditor node={conditions} onChange={setConditions} />
      </FormField>

      <FormField label={t('settings.triggers.prompt')} hint={t('settings.triggers.promptHint')}>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder={t('settings.triggers.promptPlaceholder')} />
      </FormField>

      <FormField label={t('settings.triggers.dispatchMode')} hint={t('settings.triggers.dispatchHint')}>
        <Select value={dispatchMode} onValueChange={(v) => setDispatchMode(v as TriggerDispatchMode)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="conversation">{t('settings.triggers.dispatchConversation')}</SelectItem>
            <SelectItem value="task">{t('settings.triggers.dispatchTask')}</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </FormDialog>
  )
}
