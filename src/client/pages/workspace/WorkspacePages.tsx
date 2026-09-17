import { Suspense, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Blocks, FolderOpen, Workflow, CalendarClock, Webhook, Mail } from 'lucide-react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { useAuth } from '@/client/hooks/useAuth'
import { cn } from '@/client/lib/utils'

const CronsPage = lazy(() => import('@/client/pages/crons/CronsPage').then((m) => ({ default: m.CronsPage })))
const MiniAppsPage = lazy(() =>
  import('@/client/pages/mini-apps/MiniAppsPage').then((m) => ({ default: m.MiniAppsPage })),
)
const SettingsContent = lazy(() =>
  import('@/client/pages/settings/SettingsPage').then((m) => ({ default: m.SettingsContent })),
)

type Tab = { to: string; label: string; shortLabel?: string; icon: typeof Blocks }
function WorkspaceFrame({
  title,
  description,
  tabs,
  children,
}: {
  title: string
  description: string
  tabs: Tab[]
  children: ReactNode
}) {
  return (
    <div className="surface-base flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-4 pt-5 md:px-6 md:pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <nav aria-label={title} className="mt-4 flex gap-1">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              aria-label={tab.label}
              className={({ isActive }) =>
                cn(
                  'flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-primary sm:flex-none sm:flex-row sm:gap-2 sm:px-4 sm:text-sm',
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )
              }
            >
              <tab.icon className="size-4" />
              <span className="max-w-full truncate sm:hidden">{tab.shortLabel ?? tab.label}</span>
              <span className="hidden sm:inline">{tab.label}</span>
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <p role="status" className="p-6">
              …
            </p>
          }
        >
          {children}
        </Suspense>
      </div>
    </div>
  )
}

export function ProductionsPage({ children }: { children?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <WorkspaceFrame
      title={t('workspace.productions')}
      description={t('workspace.productionsDescription')}
      tabs={[
        { to: '/productions/apps', label: t('workspace.apps'), icon: Blocks },
        { to: '/files', label: t('activityBar.files'), icon: FolderOpen },
      ]}
    >
      {children ?? <MiniAppsPage embedded />}
    </WorkspaceFrame>
  )
}

export function AutomationsPage({ section = 'plans' }: { section?: 'plans' | 'webhooks' | 'emailAccounts' }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const navigate = useNavigate()
  const tabs: Tab[] = [{ to: '/automations/plans', label: t('workspace.plans'), icon: CalendarClock }]
  if (user?.role === 'admin')
    tabs.push(
      { to: '/automations/webhooks', label: t('settings.webhooks.title'), icon: Webhook },
      { to: '/automations/emailAccounts', label: t('workspace.accountTriggers'), shortLabel: t('workspace.accounts'), icon: Mail },
    )
  return (
    <WorkspaceFrame
      title={t('workspace.automations')}
      description={t('workspace.automationsDescription')}
      tabs={tabs}
    >
      {section === 'plans' ? (
        <CronsPage embedded />
      ) : (
        <div className="h-full overflow-y-auto p-4 md:p-6">
          <div className="mx-auto max-w-3xl">
            <SettingsContent
              section={section}
              onNavigate={(id) => navigate(`/settings/${id}`)}
              onClose={() => navigate('/automations/plans')}
            />
          </div>
        </div>
      )}
    </WorkspaceFrame>
  )
}
