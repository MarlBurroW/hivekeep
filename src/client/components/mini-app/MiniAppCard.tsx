import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { cn } from '@/client/lib/utils'
import { Trash2, Users } from 'lucide-react'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import type { MiniAppSummary } from '@/shared/types'

export function MiniAppIcon({ app, size = 'md' }: { app: MiniAppSummary; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'size-14 text-3xl rounded-xl' : size === 'md' ? 'size-10 text-xl rounded-lg' : 'size-8 text-lg rounded-md'
  if (app.iconUrl) {
    return <img src={app.iconUrl} alt={app.name} className={cn(sizeClass, 'object-cover shrink-0')} />
  }
  return (
    <div className={cn('flex shrink-0 items-center justify-center bg-secondary', sizeClass)}>
      {app.icon || '\u{1F4E6}'}
    </div>
  )
}

export function MiniAppCard({
  app,
  isActive,
  badge,
  onClick,
  onDelete,
  onChangeMaintainer,
}: {
  app: MiniAppSummary
  isActive: boolean
  badge?: string | null
  onClick: () => void
  onDelete: () => void
  onChangeMaintainer?: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className={cn(
        'group flex items-center gap-2.5 rounded-lg bg-sidebar-accent/30 px-2.5 py-2 text-xs hover:bg-sidebar-accent/50 transition-colors cursor-pointer',
        isActive && 'ring-1 ring-primary/40 bg-sidebar-accent/50',
        !app.isActive && 'opacity-60',
      )}
    >
      <MiniAppIcon app={app} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate font-medium text-foreground">{app.name}</p>
          {app.hasBackend && (
            <span className="shrink-0 rounded bg-primary/15 px-1 py-0 text-[9px] font-medium text-primary leading-tight">
              API
            </span>
          )}
        </div>
        {app.description && (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {app.description}
          </p>
        )}
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <Avatar className="size-3">
            {app.maintainerKinAvatarUrl && <AvatarImage src={app.maintainerKinAvatarUrl} alt={app.maintainerKinName ?? ''} />}
            <AvatarFallback className="text-[6px]">{(app.maintainerKinName ?? '?').slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="truncate">{app.maintainerKinName ?? ''}</span>
          <span className="opacity-50">·</span>
          <span>v{app.version}</span>
        </div>
      </div>
      {badge && !isActive && (
        <span className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
          {badge}
        </span>
      )}
      {isActive && (
        <div className="size-1.5 shrink-0 rounded-full bg-primary" />
      )}
      {onChangeMaintainer && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onChangeMaintainer() }}
          className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
          title={t('miniApps.maintainer.change')}
        >
          <Users className="size-3" />
        </button>
      )}
      <ConfirmDeleteButton
        onConfirm={onDelete}
        title={t('miniApps.deleteTitle')}
        description={t('miniApps.deleteConfirm', { name: app.name })}
        confirmLabel={t('miniApps.deleteAction')}
        trigger={
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            title={t('miniApps.delete')}
          >
            <Trash2 className="size-3" />
          </button>
        }
      />
    </div>
  )
}

export function MiniAppTile({
  app,
  isActive,
  badge,
  onClick,
  onDelete,
  onChangeMaintainer,
}: {
  app: MiniAppSummary
  isActive: boolean
  badge?: string | null
  onClick: () => void
  onDelete: () => void
  onChangeMaintainer?: () => void
}) {
  const { t } = useTranslation()

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      className={cn(
        'group relative flex flex-col items-center gap-1.5 rounded-lg bg-sidebar-accent/30 p-3 text-xs hover:bg-sidebar-accent/50 transition-colors cursor-pointer',
        isActive && 'ring-1 ring-primary/40 bg-sidebar-accent/50',
        !app.isActive && 'opacity-60',
      )}
    >
      {app.hasBackend && (
        <span className="absolute right-1.5 top-1.5 shrink-0 rounded bg-primary/15 px-1 py-0 text-[8px] font-medium text-primary leading-tight">
          API
        </span>
      )}
      <MiniAppIcon app={app} size="lg" />
      <p className="w-full truncate text-center text-[12px] font-medium text-foreground">{app.name}</p>
      {app.description && (
        <p className="line-clamp-2 w-full text-center text-[10px] text-muted-foreground">
          {app.description}
        </p>
      )}
      <div className="flex items-center gap-1 text-[9px] text-muted-foreground/70">
        <Avatar className="size-3">
          {app.maintainerKinAvatarUrl && <AvatarImage src={app.maintainerKinAvatarUrl} alt={app.maintainerKinName ?? ''} />}
          <AvatarFallback className="text-[5px]">{(app.maintainerKinName ?? '?').slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="max-w-[6rem] truncate">{app.maintainerKinName ?? ''}</span>
        <span className="opacity-50">·</span>
        <span>v{app.version}</span>
      </div>
      {badge && !isActive && (
        <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
          {badge}
        </span>
      )}
      {isActive && !badge && (
        <div className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />
      )}
      {onChangeMaintainer && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onChangeMaintainer() }}
          className="absolute right-1 top-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
          title={t('miniApps.maintainer.change')}
        >
          <Users className="size-3" />
        </button>
      )}
      <ConfirmDeleteButton
        onConfirm={onDelete}
        title={t('miniApps.deleteTitle')}
        description={t('miniApps.deleteConfirm', { name: app.name })}
        confirmLabel={t('miniApps.deleteAction')}
        trigger={
          <button
            type="button"
            className="absolute left-1 top-1 shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            title={t('miniApps.delete')}
          >
            <Trash2 className="size-3" />
          </button>
        }
      />
    </div>
  )
}
