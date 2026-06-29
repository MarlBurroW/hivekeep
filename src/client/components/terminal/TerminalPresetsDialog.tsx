import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, Folder, ChevronLeft, SquareTerminal } from 'lucide-react'
import { FormDialog } from '@/client/components/common/FormDialog'
import { EmptyState } from '@/client/components/common/EmptyState'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Textarea } from '@/client/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/client/components/ui/alert-dialog'
import { api, getErrorMessage } from '@/client/lib/api'
import type { TerminalPresetDTO } from '@/shared/types'

/**
 * Manage terminal session presets (working directory + init script). One
 * FormDialog that flips between a list view and a create/edit form. Mutations
 * go through the REST API; the parent's `terminal:presets-changed` SSE
 * subscription refreshes the `presets` prop.
 */
export function TerminalPresetsDialog({
  open,
  onOpenChange,
  presets,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: TerminalPresetDTO[]
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<'list' | 'form'>('list')
  const [editing, setEditing] = useState<TerminalPresetDTO | null>(null)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [initScript, setInitScript] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TerminalPresetDTO | null>(null)

  // Always reopen on the list view.
  useEffect(() => {
    if (open) {
      setView('list')
      setEditing(null)
      setError(null)
    }
  }, [open])

  const startCreate = () => {
    setEditing(null)
    setName('')
    setCwd('')
    setInitScript('')
    setError(null)
    setView('form')
  }

  const startEdit = (p: TerminalPresetDTO) => {
    setEditing(p)
    setName(p.name)
    setCwd(p.cwd ?? '')
    setInitScript(p.initScript ?? '')
    setError(null)
    setView('form')
  }

  const save = async () => {
    if (!name.trim()) {
      setError(t('terminal.presets.nameRequired'))
      return
    }
    setSaving(true)
    try {
      const body = { name, cwd, initScript }
      if (editing) await api.patch(`/terminal/presets/${editing.id}`, body)
      else await api.post('/terminal/presets', body)
      setView('list') // SSE refreshes the list
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    const target = deleteTarget
    setDeleteTarget(null)
    if (!target) return
    try {
      await api.delete(`/terminal/presets/${target.id}`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const listFooter = (
    <div className="flex w-full items-center justify-between gap-2">
      <Button type="button" variant="outline" size="sm" onClick={startCreate}>
        <Plus className="size-4" />
        {t('terminal.presets.new')}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
        {t('common.close')}
      </Button>
    </div>
  )

  return (
    <>
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={
          view === 'form' ? (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setView('list')}
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('common.back')}
              >
                <ChevronLeft className="size-4" />
              </button>
              {editing ? t('terminal.presets.editTitle') : t('terminal.presets.newTitle')}
            </span>
          ) : (
            t('terminal.presets.title')
          )
        }
        description={view === 'list' ? t('terminal.presets.description') : undefined}
        error={view === 'form' ? error : null}
        onSubmit={view === 'form' ? save : undefined}
        isSubmitting={saving}
        submitLabel={t('common.save')}
        footer={view === 'list' ? listFooter : undefined}
      >
        {view === 'list' ? (
          presets.length === 0 ? (
            <EmptyState
              icon={SquareTerminal}
              title={t('terminal.presets.emptyTitle')}
              description={t('terminal.presets.emptyDescription')}
            />
          ) : (
            <ul className="space-y-1.5">
              {presets.map((p) => (
                <li
                  key={p.id}
                  className="group flex items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                      {p.cwd && (
                        <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                          <Folder className="size-3 shrink-0" />
                          <span className="truncate">{p.cwd}</span>
                        </span>
                      )}
                      {p.initScript && (
                        <span className="truncate font-mono opacity-80">
                          {p.initScript.split('\n')[0]}
                          {p.initScript.includes('\n') ? ' …' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => startEdit(p)}
                      aria-label={t('common.edit')}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(p)}
                      aria-label={t('common.delete')}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="preset-name">{t('terminal.presets.nameLabel')}</Label>
              <Input
                id="preset-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('terminal.presets.namePlaceholder')}
                maxLength={60}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="preset-cwd">{t('terminal.presets.cwdLabel')}</Label>
              <Input
                id="preset-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="~/projects/gezy"
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">{t('terminal.presets.cwdHelp')}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="preset-init">{t('terminal.presets.initLabel')}</Label>
              <Textarea
                id="preset-init"
                value={initScript}
                onChange={(e) => setInitScript(e.target.value)}
                placeholder={'claude --remote-control --dangerously-skip-permission'}
                rows={5}
                className="font-mono text-xs"
              />
              <p className="text-[11px] text-muted-foreground">{t('terminal.presets.initHelp')}</p>
            </div>
          </div>
        )}
      </FormDialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('terminal.presets.deleteConfirmTitle', { name: deleteTarget?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('terminal.presets.deleteConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
