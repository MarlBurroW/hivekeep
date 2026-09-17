import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/client/lib/utils'

/**
 * Canonical section-page header.
 *
 * One consistent header band across the routed section pages (Agents, Tasks,
 * Tasks, Scheduled Tasks, Mini-Apps): an optional leading slot (e.g. a mobile
 * drawer trigger), an accent icon, the title, and a right-aligned actions slot
 * for search / tabs / buttons. The global AppTopBar and the in-conversation
 * chat header are deliberately NOT built on this — they serve different roles.
 */
export function PageHeader({
  icon: Icon,
  title,
  leading,
  actions,
  className,
  children,
  embedded = false,
}: {
  icon?: LucideIcon
  title: ReactNode
  /** Rendered before the icon — e.g. a mobile drawer/menu trigger. */
  leading?: ReactNode
  /** Right-aligned controls (search input, tabs, buttons). */
  actions?: ReactNode
  className?: string
  /** Extra content rendered on a second row below the title row (e.g. a project
   *  description + progress bar). */
  children?: ReactNode
  /** Parent workspace already provides the visible page title and tabs. */
  embedded?: boolean
}) {
  return (
    <header
      className={cn(
        'flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center',
        embedded && 'md:px-6',
        className,
      )}
    >
      {embedded ? <h2 className="sr-only">{title}</h2> : <div className="flex min-w-0 flex-1 items-center gap-2.5">
        {leading}
        {Icon && <Icon className="size-5 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1">
          {typeof title === 'string' ? (
            <h1 className="truncate text-base font-semibold">{title}</h1>
          ) : (
            title
          )}
          {children}
        </div>
      </div>}
      {actions && <div className={cn('flex min-w-0 flex-wrap items-center gap-2', embedded ? 'w-full' : 'sm:ml-auto')}>{actions}</div>}
    </header>
  )
}
