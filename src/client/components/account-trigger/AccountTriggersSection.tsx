import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Plus, Pencil, Zap } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Switch } from '@/client/components/ui/switch'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { api, getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import { cn } from '@/client/lib/utils'
import { useAccountTriggers } from '@/client/hooks/useAccountTriggers'
import { AccountTriggerFormDialog } from '@/client/components/account-trigger/AccountTriggerFormDialog'
import type { AccountTriggerSummary } from '@/shared/types'

export function AccountTriggersSection({ accountId }: { accountId: string }) {
  const { t } = useTranslation()
  const { triggers, refetch } = useAccountTriggers(accountId)
  const [open, setOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AccountTriggerSummary | undefined>()

  const toggleActive = async (trigger: AccountTriggerSummary) => {
    try {
      await api.patch(`/account-triggers/${trigger.id}`, { isActive: !trigger.isActive })
      await refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const remove = async (trigger: AccountTriggerSummary) => {
    try {
      await api.delete(`/account-triggers/${trigger.id}`)
      await refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const openAdd = () => { setEditing(undefined); setDialogOpen(true) }
  const openEdit = (trg: AccountTriggerSummary) => { setEditing(trg); setDialogOpen(true) }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Zap className="size-3.5" />
          {t('settings.triggers.sectionTitle')}
          {triggers.length > 0 && <Badge variant="secondary" size="xs">{triggers.length}</Badge>}
        </span>
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-2 px-4 pb-4">
        {triggers.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">{t('settings.triggers.empty')}</p>
        ) : (
          triggers.map((trg) => (
            <div key={trg.id} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium">{trg.name}</p>
                  <Badge variant="secondary" className="text-[10px]">
                    {trg.dispatchMode === 'task' ? t('settings.triggers.dispatchTask') : t('settings.triggers.dispatchConversation')}
                  </Badge>
                  {trg.requiresApproval && !trg.isActive && (
                    <Badge variant="outline" className="text-[10px] text-warning">{t('settings.triggers.pendingApproval')}</Badge>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={trg.conditionsSummary}>
                  {trg.folder} · {trg.conditionsSummary}
                </p>
                <p className="truncate text-[11px] text-muted-foreground/80">
                  → {trg.targetAgentName}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Switch checked={trg.isActive} onCheckedChange={() => void toggleActive(trg)} title={t('settings.triggers.active')} />
                <Button size="icon" variant="ghost" className="size-8" onClick={() => openEdit(trg)} title={t('common.edit')}>
                  <Pencil className="size-3.5" />
                </Button>
                <ConfirmDeleteButton
                  onConfirm={() => void remove(trg)}
                  title={t('settings.triggers.deleteTitle')}
                  description={t('settings.triggers.deleteConfirm')}
                  size="icon"
                />
              </div>
            </div>
          ))
        )}

        <Button variant="outline" size="sm" className="w-full" onClick={openAdd}>
          <Plus className="mr-1.5 size-3.5" />{t('settings.triggers.add')}
        </Button>
      </CollapsibleContent>

      <AccountTriggerFormDialog
        accountId={accountId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => void refetch()}
        trigger={editing}
      />
    </Collapsible>
  )
}
