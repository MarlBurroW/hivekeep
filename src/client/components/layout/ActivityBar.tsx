import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { Home, ListTodo, CalendarClock, Folder, Blocks, Boxes, SquareTerminal, MessageSquarePlus } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { useTasksContext } from '@/client/contexts/TasksContext'
import { useCronsContext } from '@/client/contexts/CronsContext'
import { useAuth } from '@/client/hooks/useAuth'
import { useFeedback } from '@/client/contexts/FeedbackContext'

interface ActivityBarItem {
  /** URL prefix that activates this item. */
  matchPrefix: string
  /** Path to navigate to on click. */
  navigateTo: string
  icon: typeof Home
  labelKey: string
  /** Which live count drives this item's badge, if any. */
  badgeKey?: 'tasks' | 'crons'
  /** When true, the item is only shown to admin users. */
  adminOnly?: boolean
}

// Order: Agents first (default landing), then the dedicated section pages.
const ITEMS: ActivityBarItem[] = [
  // Default landing — "Agents" matches any path not claimed by a section below.
  { matchPrefix: '/', navigateTo: '/', icon: Home, labelKey: 'activityBar.agents' },
  { matchPrefix: '/tasks', navigateTo: '/tasks', icon: ListTodo, labelKey: 'activityBar.tasks', badgeKey: 'tasks' },
  { matchPrefix: '/crons', navigateTo: '/crons', icon: CalendarClock, labelKey: 'activityBar.crons', badgeKey: 'crons' },
  { matchPrefix: '/files', navigateTo: '/files', icon: Folder, labelKey: 'activityBar.files' },
  { matchPrefix: '/mini-apps', navigateTo: '/mini-apps', icon: Blocks, labelKey: 'activityBar.apps' },
  { matchPrefix: '/models', navigateTo: '/models', icon: Boxes, labelKey: 'activityBar.models', adminOnly: true },
  { matchPrefix: '/terminal', navigateTo: '/terminal', icon: SquareTerminal, labelKey: 'activityBar.terminal', adminOnly: true },
]

const SECTION_PREFIXES = ['/tasks', '/crons', '/files', '/mini-apps', '/models', '/terminal']

export function ActivityBar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { activeTasks } = useTasksContext()
  const { pendingApprovalCount } = useCronsContext()
  const { user } = useAuth()
  const { enabled: feedbackEnabled, open: openFeedback } = useFeedback()
  const isAdmin = user?.role === 'admin'
  const items = ITEMS.filter((item) => !item.adminOnly || isAdmin)

  const activeCount = activeTasks.length
  const hasAwaiting = activeTasks.some(
    (task) => task.status === 'awaiting_human_input' || task.status === 'awaiting_agent_response',
  )

  // Resolve an item's badge from the live counts. `warning` uses the louder,
  // pulsing treatment for states that need user action (a task awaiting input,
  // a cron awaiting approval).
  function badgeFor(item: ActivityBarItem): { count: number; warning: boolean } | null {
    if (item.badgeKey === 'tasks') return activeCount > 0 ? { count: activeCount, warning: hasAwaiting } : null
    if (item.badgeKey === 'crons') {
      return pendingApprovalCount > 0 ? { count: pendingApprovalCount, warning: true } : null
    }
    return null
  }

  function isActive(item: ActivityBarItem): boolean {
    if (item.matchPrefix === '/') {
      // "Agents" — active iff no dedicated section claims the path.
      return !SECTION_PREFIXES.some((p) => location.pathname.startsWith(p))
    }
    return location.pathname.startsWith(item.matchPrefix)
  }

  return (
    <nav
      className="surface-base hidden h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border py-3 md:flex"
      aria-label="Application sections"
    >
      {items.map((item) => {
        const Icon = item.icon
        const active = isActive(item)
        return (
          <button
            key={item.matchPrefix}
            type="button"
            onClick={() => navigate(item.navigateTo)}
            title={t(item.labelKey)}
            aria-label={t(item.labelKey)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex size-9 items-center justify-center rounded-md transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {active && (
              <span
                aria-hidden
                className="absolute -left-3 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary"
              />
            )}
            <Icon className="size-4.5" strokeWidth={1.75} />
            {(() => {
              const badge = badgeFor(item)
              if (!badge) return null
              return (
                <span
                  className={cn(
                    'absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none',
                    badge.warning
                      ? 'animate-pulse bg-warning text-warning-foreground'
                      : 'bg-primary text-primary-foreground',
                  )}
                >
                  {badge.count}
                </span>
              )
            })()}
          </button>
        )
      })}

      {feedbackEnabled && (
        <button
          type="button"
          onClick={openFeedback}
          title={t('activityBar.feedback')}
          aria-label={t('activityBar.feedback')}
          className="relative mt-auto flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MessageSquarePlus className="size-4.5" strokeWidth={1.75} />
        </button>
      )}
    </nav>
  )
}
