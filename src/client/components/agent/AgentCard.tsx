import { forwardRef, useState, type HTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@/client/components/ui/badge'
import { cn } from '@/client/lib/utils'
import { useIsMobile } from '@/client/hooks/use-mobile'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { PlatformIcon } from '@/client/components/common/PlatformIcon'
import type { AgentChannelBadge } from '@/client/hooks/useAgentChannels'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/client/components/ui/context-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { AlertTriangle, Bot, Coins, Download, Folder, GripVertical, Loader2, Network, Settings2, Trash2, Crown } from 'lucide-react'

export interface AgentCardProps extends HTMLAttributes<HTMLDivElement> {
  id: string
  name: string
  role: string
  avatarUrl: string | null
  modelDisplayName?: string
  queueSize?: number
  isProcessing?: boolean
  isSelected?: boolean
  isDragging?: boolean
  modelUnavailable?: boolean
  unreadCount?: number
  shortcutIndex?: number
  /**
   * Active channels currently bound to this Agent (transferable binding,
   * Issue 3 of 3). Rendered as a row of brand-colored platform icons below
   * the Agent name. Up to MAX_VISIBLE_BADGES icons are shown explicitly,
   * the rest are collapsed into a "+N" affordance.
   */
  channels?: AgentChannelBadge[]
  /** Click handler for a channel icon (opens the channel settings page). */
  onOpenChannel?: (channelId: string) => void
  onClick: () => void
  onEdit?: () => void
  onDelete?: () => void
  onExport?: () => void
  onViewUsage?: () => void
  dragHandleProps?: Record<string, unknown>
}

const MAX_VISIBLE_BADGES = 5
/** Tighter cap inside the ~288px mobile drawer so cards stay compact. */
const MAX_VISIBLE_BADGES_MOBILE = 3

export const AgentCard = forwardRef<HTMLDivElement, AgentCardProps>(function AgentCard({
  id,
  name,
  role,
  avatarUrl,
  modelDisplayName,
  queueSize = 0,
  isProcessing = false,
  isSelected = false,
  isDragging = false,
  modelUnavailable = false,
  unreadCount = 0,
  shortcutIndex,
  channels,
  onOpenChannel,
  onClick,
  onEdit,
  onDelete,
  onExport,
  onViewUsage,
  dragHandleProps,
  style,
  className: extraClassName,
  ...rest
}, ref) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  // Track which avatar URL has finished loading. Comparing against the current
  // url (rather than a plain boolean) resets the fade-in when the avatar is
  // regenerated and the cache-busting `?v=` changes, without an effect.
  const [loadedAvatarUrl, setLoadedAvatarUrl] = useState<string | null>(null)
  const avatarLoaded = avatarUrl != null && loadedAvatarUrl === avatarUrl
  const isMobile = useIsMobile()
  // Inside the narrow mobile drawer, show fewer icons and collapse the rest
  // into the existing "+N" affordance. Desktop keeps the full count.
  const maxVisibleBadges = isMobile ? MAX_VISIBLE_BADGES_MOBILE : MAX_VISIBLE_BADGES

  const cardContent = (
    <div
      ref={ref}
      style={style}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-current={isSelected ? 'page' : undefined}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          event.currentTarget.click()
        }
      }}
      className={cn(
        'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 w-full text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-ring',
        isDragging ? 'z-50 shadow-lg opacity-90 scale-[1.02]' : 'transition-all duration-150',
        isSelected
          ? 'bg-primary/10 shadow-sm'
          : 'hover:bg-accent/50',
        modelUnavailable && !isSelected && 'opacity-60',
        extraClassName,
      )}
      id={id}
      {...rest}
    >
      {/* Selected accent bar */}
      {isSelected && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-[3px] rounded-full gradient-primary" />
      )}

      {/* Drag handle */}
      {dragHandleProps && (
        <div
          {...dragHandleProps}
          className="absolute left-0 top-0 z-10 flex h-full w-5 cursor-grab items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="size-3.5 text-muted-foreground" />
        </div>
      )}

      {/* Avatar */}
      <div className="relative size-10 shrink-0">
        <div
          className={cn(
            'relative size-10 rounded-xl flex items-center justify-center overflow-hidden transition-shadow',
            isSelected
              ? 'gradient-primary shadow-md'
              : 'bg-secondary',
          )}
        >
          {/* Placeholder sits underneath the image: the Bot icon (pulsing
              while the avatar is still loading) so the slot is never blank. */}
          <Bot
            className={cn(
              'size-5',
              isSelected ? 'text-white' : 'text-secondary-foreground/70',
              avatarUrl && !avatarLoaded && 'animate-pulse',
            )}
          />
          {avatarUrl && (
            <img
              src={avatarUrl}
              alt={name}
              onLoad={() => setLoadedAvatarUrl(avatarUrl)}
              className={cn(
                'absolute inset-0 size-full object-cover transition-opacity duration-300',
                avatarLoaded ? 'opacity-100' : 'opacity-0',
              )}
            />
          )}
        </div>
        {/* Status dot */}
        {isProcessing && (
          <span className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-sidebar bg-warning animate-pulse" />
        )}
        {modelUnavailable && !isProcessing && (
          <span className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-sidebar bg-muted-foreground" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className={cn('truncate text-[13px] leading-tight', isSelected ? 'font-semibold' : 'font-medium')}>
          <span className="truncate">{name}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {isProcessing ? (
            <>
              <Loader2 className="size-3 shrink-0 text-primary animate-spin" />
              <p className="truncate text-xs text-primary font-medium">
                {t('agent.processing')}
              </p>
            </>
          ) : modelUnavailable ? (
            <>
              <AlertTriangle className="size-3 shrink-0 text-warning" />
              <p className="truncate text-xs text-warning">
                {t('agent.modelUnavailable')}
              </p>
            </>
          ) : (
            <p className="truncate text-xs text-muted-foreground">{role}</p>
          )}
        </div>
        {modelDisplayName && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{modelDisplayName}</p>
        )}
        {channels && channels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1" aria-label={t('sidebar.agents.boundChannelsLabel', 'Bound channels')}>
            {channels.slice(0, maxVisibleBadges).map((ch) => (
              <Tooltip key={ch.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onOpenChannel?.(ch.id) }}
                    className="rounded p-0.5 transition-colors hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-label={ch.name}
                  >
                    <PlatformIcon platform={ch.platform} variant="color" className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {ch.name}
                </TooltipContent>
              </Tooltip>
            ))}
            {channels.length > maxVisibleBadges && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="rounded px-1 py-0.5 text-[10px] font-medium text-muted-foreground/70">
                    +{channels.length - maxVisibleBadges}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {channels.slice(maxVisibleBadges).map((c) => c.name).join(', ')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Right actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {unreadCount > 0 && !isSelected && (
          <Badge variant="default" className="size-5 p-0 text-[10px] flex items-center justify-center rounded-full animate-in fade-in zoom-in-50 duration-200">
            {unreadCount > 99 ? '99+' : unreadCount}
          </Badge>
        )}
        {isProcessing && (
          <Loader2 className="size-4 text-primary animate-spin" />
        )}
        {!isProcessing && queueSize > 0 && (
 <Badge variant="secondary" size="xs">
            {queueSize}
          </Badge>
        )}
        {modelUnavailable && !isProcessing && (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangle className="size-4 text-warning" />
            </TooltipTrigger>
            <TooltipContent side="right">
              {t('agent.modelUnavailableHint')}
            </TooltipContent>
          </Tooltip>
        )}
        {shortcutIndex != null && shortcutIndex >= 1 && shortcutIndex <= 9 && (
          <kbd className="rounded border border-border/60 bg-muted/50 px-1 py-0.5 font-mono text-[9px] leading-none text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity">
            {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+'}{shortcutIndex}
          </kbd>
        )}
        {onEdit && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onEdit() }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onEdit() } }}
            className="rounded-md p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
          >
            <Settings2 className="size-4 text-muted-foreground" />
          </span>
        )}
      </div>
    </div>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {cardContent}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {onEdit && (
            <ContextMenuItem onClick={onEdit}>
              <Settings2 className="size-4" />
              {t('sidebar.agents.contextMenu.edit')}
            </ContextMenuItem>
          )}
          {onExport && (
            <ContextMenuItem onClick={onExport}>
              <Download className="size-4" />
              {t('sidebar.agents.contextMenu.export', { defaultValue: 'Export config' })}
            </ContextMenuItem>
          )}
          {onViewUsage && (
            <ContextMenuItem onClick={onViewUsage}>
              <Coins className="size-4" />
              {t('sidebar.agents.contextMenu.viewUsage')}
            </ContextMenuItem>
          )}
          {/* Browse this Agent's workspace in the Files section */}
          <ContextMenuItem onClick={() => navigate(`/files/${id}`)}>
            <Folder className="size-4" />
            {t('files.browseWorkspace')}
          </ContextMenuItem>
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setDeleteDialogOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="size-4" />
                {t('sidebar.agents.contextMenu.delete')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {/* Delete confirmation dialog */}
      {onDelete && (
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('agent.delete')}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('agent.deleteConfirm')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onDelete()
                  setDeleteDialogOpen(false)
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {t('agent.deleteAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
})
