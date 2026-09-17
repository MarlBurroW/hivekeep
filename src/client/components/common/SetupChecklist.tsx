import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronRight, X, RotateCcw, Sparkles, AlertCircle } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { cn } from '@/client/lib/utils'
import { useSetupChecklist, type SetupItem, type SetupItemSeverity } from '@/client/hooks/useSetupChecklist'

interface SetupChecklistProps {
  /** Layout variant.
   *  - 'inline'  : large rendering for the chat empty state. Items have
   *                room for description text + a primary CTA button.
   *  - 'compact' : navbar popover. Shorter rows, action buttons compress
   *                to icons. Same data + same actions, smaller surface. */
  variant?: 'inline' | 'compact'
  /** Open the corresponding settings section (or the settings dialog
   *  when no section id is given). Wired by the host page so the
   *  checklist can navigate the user to the right place. */
  onOpenSettings: (section?: string) => void
  /** Open the 'Create your first Agent' flow (handled by ChatPage). */
  onCreateAgent: () => void
  /** Optional callback when the user clicks an item's CTA — used by
   *  the navbar popover to close itself after navigation. */
  onAction?: () => void
}

const SEVERITY_BADGE_VARIANT: Record<SetupItemSeverity, 'destructive' | 'default' | 'secondary'> = {
  required: 'destructive',
  recommended: 'default',
  optional: 'secondary',
}

export function SetupChecklist({
  variant = 'inline',
  onOpenSettings,
  onCreateAgent,
  onAction,
}: SetupChecklistProps) {
  const { t } = useTranslation()
  const [showOptional, setShowOptional] = useState(false)
  const { items, isLoading, isComplete, dismissItem, restoreItem } = useSetupChecklist()

  if (isLoading) return null

  const handleAction = (item: SetupItem) => {
    if (item.target.createAgent) {
      onCreateAgent()
    } else {
      onOpenSettings(item.target.section)
    }
    onAction?.()
  }

  const isCompact = variant === 'compact'

  return (
    <div className={cn(isCompact ? 'space-y-2 p-3' : 'w-full space-y-4 animate-fade-in-up')}>
      {!isCompact && (
        <div className="text-center space-y-1.5">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10">
            <Sparkles className="size-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">{t('chat.welcome.title')}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('chat.welcome.checklistIntro')}
          </p>
        </div>
      )}

      <div className={cn(isCompact ? 'space-y-1' : 'space-y-2')}>
        {items.filter((item) => showOptional || item.severity !== 'optional').map((item) => (
          <SetupItemRow
            key={item.id}
            item={item}
            compact={isCompact}
            onAction={() => handleAction(item)}
            onDismiss={() => dismissItem(item.id)}
            onRestore={() => restoreItem(item.id)}
          />
        ))}
      </div>

      <Button variant="ghost" size="sm" onClick={() => setShowOptional((value) => !value)} aria-expanded={showOptional}>
        {showOptional ? t('experience.setup.hideOptional', 'Hide optional capabilities') : t('experience.setup.showOptional', 'Explore optional capabilities')}
      </Button>

      {isComplete && (
        <p className={cn(
          'text-center text-emerald-600 dark:text-emerald-400 font-medium',
          isCompact ? 'text-xs pt-1' : 'text-sm',
        )}>
          {t('chat.welcome.allDone')}
        </p>
      )}
    </div>
  )
}

interface SetupItemRowProps {
  item: SetupItem
  compact: boolean
  onAction: () => void
  onDismiss: () => void
  onRestore: () => void
}

function SetupItemRow({ item, compact, onAction, onDismiss, onRestore }: SetupItemRowProps) {
  const { t } = useTranslation()
  const titleKey = `setup.items.${item.id}.title`
  const descKey = `setup.items.${item.id}.description`

  // Required + not done = highlighted state. Dismissed = muted +
  // 'Restore' affordance. Done = checkmark, no action needed.
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border p-3 transition-all',
        item.isDone && 'border-emerald-500/30 bg-emerald-500/5',
        !item.isDone && item.isDismissed && 'border-border/30 bg-muted/20 opacity-60',
        !item.isDone && !item.isDismissed && item.severity === 'required' && 'border-destructive/40 bg-destructive/5',
        !item.isDone && !item.isDismissed && item.severity !== 'required' && 'border-primary/30 bg-primary/5',
      )}
    >
      {/* Status indicator */}
      <div
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full',
          item.isDone && 'bg-emerald-500 text-white',
          !item.isDone && item.isDismissed && 'bg-muted text-muted-foreground',
          !item.isDone && !item.isDismissed && item.severity === 'required' && 'bg-destructive text-white',
          !item.isDone && !item.isDismissed && item.severity !== 'required' && 'bg-primary/15 text-primary',
        )}
      >
        {item.isDone ? (
          <Check className="size-3.5" />
        ) : item.isDismissed ? (
          <X className="size-3" />
        ) : item.severity === 'required' ? (
          <AlertCircle className="size-3.5" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <p className={cn(
            'text-sm font-medium',
            item.isDone && 'line-through text-muted-foreground',
            !compact || !item.isDone ? '' : 'text-xs',
          )}>
            {t(titleKey)}
          </p>
          {!item.isDone && !item.isDismissed && item.severity === 'required' && (
            <Badge variant={SEVERITY_BADGE_VARIANT.required} size="xs">
              {t('setup.severity.required')}
            </Badge>
          )}
        </div>
        {!compact && !item.isDone && (
          <p className="text-xs text-muted-foreground leading-relaxed">
            {t(descKey)}
          </p>
        )}
        {!item.isDone && !item.isDismissed && (
          <div className={cn('flex items-center gap-2', compact ? 'pt-1' : 'pt-1.5')}>
            <Button
              size="sm"
              variant="default"
              className="gap-1 h-7 text-xs"
              onClick={onAction}
            >
              {t('setup.actions.configure')}
              <ChevronRight className="size-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
            >
              {t('setup.actions.skip')}
            </Button>
          </div>
        )}
        {!item.isDone && item.isDismissed && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1 mt-1"
            onClick={onRestore}
          >
            <RotateCcw className="size-3" />
            {t('setup.actions.restore')}
          </Button>
        )}
      </div>
    </div>
  )
}
