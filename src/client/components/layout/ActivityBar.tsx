import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Settings2, MessageSquarePlus } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { primaryNavigation, matchesDestination } from '@/client/lib/navigation'
import { useTasksContext } from '@/client/contexts/TasksContext'
import { useCronsContext } from '@/client/contexts/CronsContext'
import { useFeedback } from '@/client/contexts/FeedbackContext'

export function ActivityBar({ mobile = false }: { mobile?: boolean }) {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const { activeTasks } = useTasksContext()
  const { pendingApprovalCount } = useCronsContext()
  const { enabled, open } = useFeedback()
  const waiting = activeTasks.filter(task => task.status === 'awaiting_human_input').length
  return <nav aria-label={t('workspace.navigation')} className={cn('surface-sidebar shrink-0 border-border', mobile ? 'grid grid-cols-4 border-t pb-[env(safe-area-inset-bottom)] md:hidden' : 'hidden w-48 flex-col gap-1 border-r p-3 md:flex xl:w-52')}>
    {primaryNavigation.map(item => {
      const active = matchesDestination(pathname, item.matches)
      const count = item.id === 'home' ? waiting : item.id === 'automations' ? pendingApprovalCount : 0
      const Icon = item.icon
      return <Link key={item.id} to={item.to} aria-current={active ? 'page' : undefined} className={cn('relative flex min-h-12 items-center rounded-xl font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary', mobile ? 'flex-col justify-center gap-1 px-1 py-2 text-[11px]' : 'gap-3 px-3 text-sm', active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
        <Icon className="size-5 shrink-0" aria-hidden="true" /><span>{t(item.labelKey)}</span>
        {count > 0 && <span className={cn('rounded-full bg-primary px-1.5 text-xs text-primary-foreground', mobile ? 'absolute right-2 top-1' : 'ml-auto')}>{count}</span>}
      </Link>
    })}
    {!mobile && <div className="mt-auto space-y-1 border-t pt-3">
      <Link to="/settings/general" aria-current={pathname.startsWith('/settings/') ? 'page' : undefined} className={cn('flex min-h-12 items-center gap-3 rounded-xl px-3 text-sm font-medium', pathname.startsWith('/settings/') ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted')}><Settings2 className="size-5" />{t('settings.title')}</Link>
      {enabled && <button onClick={open} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm text-muted-foreground hover:bg-muted"><MessageSquarePlus className="size-5" />{t('activityBar.feedback')}</button>}
    </div>}
  </nav>
}
