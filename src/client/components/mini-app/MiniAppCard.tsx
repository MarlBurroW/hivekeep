import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { cn } from '@/client/lib/utils'
import { ArrowUpRight, Trash2, Users } from 'lucide-react'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import type { MiniAppSummary } from '@/shared/types'

export function MiniAppIcon({ app, size = 'md' }: { app: MiniAppSummary; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'size-14 text-3xl rounded-xl' : size === 'md' ? 'size-10 text-xl rounded-lg' : 'size-8 text-lg rounded-md'
  if (app.iconUrl) {
    return <img src={app.iconUrl} alt="" className={cn(sizeClass, 'object-cover shrink-0')} />
  }
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center bg-secondary', sizeClass)}>{app.icon || '\u{1F4E6}'}</span>
}

interface MiniAppEntryProps {
  app: MiniAppSummary
  isActive: boolean
  badge?: string | null
  onClick: () => void
  onDelete: () => void
  onChangeMaintainer?: () => void
}

/** Opening and managing an app are separate native buttons, including on touch screens. */
function MiniAppEntry({ app, isActive, badge, onClick, onDelete, onChangeMaintainer, tile = false }: MiniAppEntryProps & { tile?: boolean }) {
  const { t } = useTranslation()
  return (
    <article className={cn(
      'group flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-card transition-colors hover:border-primary/40',
      isActive ? 'border-primary/50 bg-primary/5' : 'border-border',
      !app.isActive && 'opacity-60',
    )}>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${t('miniApps.openPanel')} : ${app.name}`}
        aria-pressed={isActive}
        className={cn('flex w-full min-w-0 flex-1 gap-4 p-4 text-left outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', tile ? 'flex-col' : 'items-center')}
      >
        <span className={cn('flex min-w-0 items-center gap-3', tile ? 'w-full' : 'contents')}>
          <MiniAppIcon app={app} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{app.name}</span>
            {!tile && app.description && <span className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{app.description}</span>}
          </span>
          {badge && !isActive && <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">{badge}</span>}
        </span>
        {tile && <span className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{app.description}</span>}
        <span aria-hidden="true" className={cn('flex shrink-0 items-center gap-1.5 text-xs font-medium text-primary', tile ? 'mt-auto' : 'ml-auto')}>
          <span className={tile ? '' : 'hidden sm:inline'}>{t('workspace.open')}</span>
          <ArrowUpRight className="size-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
        </span>
      </button>
      <div className="flex min-h-12 items-center gap-2 border-t border-border/70 px-3">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
          <Avatar className="size-5 shrink-0">
            {app.maintainerAgentAvatarUrl && <AvatarImage src={app.maintainerAgentAvatarUrl} alt="" />}
            <AvatarFallback className="text-[8px]">{(app.maintainerAgentName ?? '?').slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate">{app.maintainerAgentName}</span>
        </span>
        {onChangeMaintainer && <button
          type="button"
          onClick={onChangeMaintainer}
          aria-label={t('miniApps.maintainer.change')}
          title={t('miniApps.maintainer.change')}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        ><Users className="size-4" /></button>}
        <ConfirmDeleteButton
          onConfirm={onDelete}
          title={t('miniApps.deleteTitle')}
          description={t('miniApps.deleteConfirm', { name: app.name })}
          confirmLabel={t('miniApps.deleteAction')}
          trigger={<button
            type="button"
            aria-label={t('miniApps.delete')}
            title={t('miniApps.delete')}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
          ><Trash2 className="size-4" /></button>}
        />
      </div>
    </article>
  )
}

export function MiniAppCard(props: MiniAppEntryProps) { return <MiniAppEntry {...props} /> }
export function MiniAppTile(props: MiniAppEntryProps) { return <MiniAppEntry {...props} tile /> }
