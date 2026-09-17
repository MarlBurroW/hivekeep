import { Suspense, useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Bot, CheckCircle2, Clock3, MessageSquare, Plus, Sparkles } from 'lucide-react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import { useAuth } from '@/client/hooks/useAuth'
import { useSetupChecklist } from '@/client/hooks/useSetupChecklist'
import { useAgents } from '@/client/hooks/useAgents'
import { useUnreadPerAgent } from '@/client/hooks/useUnreadPerAgent'
import { useInboxPrompts } from '@/client/hooks/useInboxPrompts'
import { useTasksContext } from '@/client/contexts/TasksContext'
import { useCronsContext } from '@/client/contexts/CronsContext'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { TASK_STATUS_META } from '@/client/lib/task-status'
import { cn } from '@/client/lib/utils'
import { SetupChecklist } from '@/client/components/common/SetupChecklist'
import type { TaskSummary } from '@/shared/types'

const MiniAppViewer = lazy(() =>
  import('@/client/components/mini-app/MiniAppViewer').then((m) => ({ default: m.MiniAppViewer })),
)

export function HomePage({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { agents, isLoading: agentsLoading, fetchError: agentsError, refetch: refetchAgents } = useAgents()
  const { unreadCounts } = useUnreadPerAgent(null)
  const { activeTasks, activeLoading, activeError, refetchActive } = useTasksContext()
  const {
    pendingApprovalCount: allPendingApprovals,
    isLoading: cronsLoading,
    fetchError: cronsError,
    refetch: refetchCrons,
  } = useCronsContext()
  const pendingApprovalCount = user?.role === 'admin' ? allPendingApprovals : 0
  const inbox = useInboxPrompts()
  const isLoading = agentsLoading || activeLoading || cronsLoading || inbox.isLoading
  const loadError = activeError || agentsError || cronsError || inbox.error
  const { openTask, panelOpen } = useSidePanel()
  const waiting = activeTasks.filter((task) => task.status === 'awaiting_human_input')
  const [recent, setRecent] = useState<TaskSummary[]>([])
  const [recentError, setRecentError] = useState(false)
  const fetchRecent = useCallback(async () => {
    try {
      const [completed, failed] = await Promise.all(
        ['completed', 'failed'].map((status) =>
          api.get<{ tasks: TaskSummary[] }>(`/tasks?status=${status}&limit=6&offset=0`),
        ),
      )
      setRecent(
        [...(completed?.tasks ?? []), ...(failed?.tasks ?? [])]
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, 6),
      )
      setRecentError(false)
    } catch {
      setRecentError(true)
    }
  }, [])
  useEffect(() => {
    void fetchRecent()
  }, [fetchRecent])
  useSSE({
    'task:done': () => {
      void fetchRecent()
    },
    'task:deleted': () => {
      void fetchRecent()
    },
  })
  useSSEResync(fetchRecent)
  const unreadAgents = agents.filter((agent) => (unreadCounts.get(agent.id) ?? 0) > 0)
  const taskRow = (task: TaskSummary) => {
    const meta = TASK_STATUS_META[task.status]
    const Icon = meta.icon
    return (
      <button
        key={task.id}
        onClick={() =>
          openTask({
            taskId: task.id,
            agentName: task.parentAgentName,
            agentAvatarUrl: task.parentAgentAvatarUrl,
          })
        }
        className="group flex min-h-20 w-full items-center gap-3 border-b px-4 py-3 text-left last:border-0 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl',
            meta.bgClass,
            meta.textClass,
          )}
        >
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{task.title || task.description}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {task.parentAgentName} · {t(meta.labelKey)}
          </span>
        </span>
        <span className="hidden text-sm text-primary sm:inline">
          {task.status === 'awaiting_human_input' ? t('workspace.reply') : t('workspace.open')}
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
    )
  }
  return (
    <div className="surface-base flex h-full min-h-0 overflow-hidden">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-8 p-4 md:p-8 xl:p-10">
          <header className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-2 text-sm text-muted-foreground">{t('workspace.yourWorkspace')}</p>
              <h1 className="text-3xl font-semibold tracking-tight">
                {t('workspace.greeting', { name: user?.firstName || user?.pseudonym || '' })}
              </h1>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {t('workspace.homeDescription')}
              </p>
            </div>
            <Link
              to="/agents"
              className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              <MessageSquare className="size-4" />
              {t('workspace.startConversation')}
            </Link>
          </header>
          {user?.role === 'admin' && (
            <HomeSetup onOpenSettings={onOpenSettings} onCreateAgent={() => navigate('/agents?create=1')} />
          )}
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            {[
              {
                label: t('workspace.needsYou'),
                count: waiting.length + pendingApprovalCount + inbox.total,
                icon: Sparkles,
                to: '#attention',
              },
              {
                label: t('workspace.running'),
                count: activeTasks.filter((task) => ['pending', 'in_progress'].includes(task.status)).length,
                icon: Clock3,
                to: '/tasks',
              },
              {
                label: t('workspace.unread'),
                count: unreadAgents.reduce((sum, agent) => sum + (unreadCounts.get(agent.id) ?? 0), 0),
                icon: MessageSquare,
                to: '/agents',
              },
            ].map((card) => (
              <Link
                key={card.label}
                to={card.to}
                onClick={(event) => {
                  if (card.to.startsWith('#')) {
                    event.preventDefault()
                    document.getElementById(card.to.slice(1))?.scrollIntoView({ block: 'start' })
                  }
                }}
                className="flex flex-col items-center gap-2 rounded-2xl border bg-card p-3 text-center transition-colors hover:border-primary/40 sm:flex-row sm:gap-4 sm:p-5 sm:text-left"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted sm:size-11">
                  <card.icon className="size-5 text-primary" />
                </span>
                <div>
                  <p className="text-xl font-semibold sm:text-2xl">
                    {isLoading || loadError ? '—' : card.count}
                  </p>
                  <p className="text-xs text-muted-foreground sm:text-sm">{card.label}</p>
                </div>
              </Link>
            ))}
          </div>
          <div className="grid gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <section id="attention" className="min-w-0 scroll-mt-4">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{t('workspace.needsYou')}</h2>
                <Link className="text-sm text-primary" to="/tasks">
                  {t('workspace.executions')}
                </Link>
              </div>
              <div className="overflow-hidden rounded-2xl border bg-card">
                {loadError ? (
                  <div role="alert" className="space-y-3 p-6">
                    <p className="text-sm text-muted-foreground">{t('workspace.loadError')}</p>
                    <button
                      className="min-h-11 text-sm font-medium text-primary"
                      onClick={() => {
                        void refetchActive()
                        void refetchAgents()
                        void refetchCrons()
                        inbox.refetch()
                      }}
                    >
                      {t('errors.retry')}
                    </button>
                  </div>
                ) : isLoading ? (
                  <p role="status" className="p-6 text-sm text-muted-foreground">
                    {t('common.loading')}
                  </p>
                ) : waiting.length || pendingApprovalCount || unreadAgents.length || inbox.total ? (
                  <>
                    {inbox.prompts.map((prompt) => (
                      <Link
                        key={prompt.id}
                        to={`/agent/${prompt.agentSlug}`}
                        className="flex min-h-20 items-center gap-3 border-b p-4 hover:bg-muted/50"
                      >
                        <MessageSquare className="size-5 shrink-0 text-primary" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{prompt.question}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {prompt.agentName} · {t('workspace.reply')}
                          </span>
                        </span>
                        <ArrowRight className="size-4 shrink-0" />
                      </Link>
                    ))}
                    {inbox.hasMore && (
                      <button
                        onClick={inbox.loadMore}
                        disabled={inbox.isFetching}
                        className="min-h-11 w-full border-b p-3 text-sm text-primary disabled:opacity-50"
                      >
                        {t('workspace.loadMore')}
                      </button>
                    )}
                    {waiting.map(taskRow)}
                    {pendingApprovalCount > 0 && (
                      <Link
                        to="/automations"
                        className="flex min-h-20 items-center justify-between gap-3 border-b p-4 text-sm font-medium hover:bg-muted/50"
                      >
                        <span>{t('workspace.pendingApprovals', { count: pendingApprovalCount })}</span>
                        <ArrowRight className="size-4" />
                      </Link>
                    )}
                    {unreadAgents.map((agent) => (
                      <Link
                        key={agent.id}
                        to={`/agent/${agent.slug}`}
                        className="flex min-h-20 items-center gap-3 border-b p-4 last:border-0 hover:bg-muted/50"
                      >
                        <Bot className="size-5 text-primary" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{agent.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {t('workspace.unreadMessages', { count: unreadCounts.get(agent.id) })}
                          </p>
                        </div>
                        <ArrowRight className="size-4" />
                      </Link>
                    ))}
                  </>
                ) : (
                  <div className="px-6 py-10 text-center">
                    <CheckCircle2 className="mx-auto mb-3 size-8 text-primary" />
                    <p className="font-medium">{t('workspace.allClear')}</p>
                    <p className="mt-2 text-sm text-muted-foreground">{t('workspace.allClearDescription')}</p>
                  </div>
                )}
              </div>
              <div className="mb-4 mt-8 flex items-center justify-between">
                <h2 className="text-lg font-semibold">{t('workspace.recentResults')}</h2>
                <Link to="/tasks" className="text-sm text-primary">
                  {t('workspace.seeAll')}
                </Link>
              </div>
              <div className="overflow-hidden rounded-2xl border bg-card">
                {recentError ? (
                  <button
                    onClick={() => void fetchRecent()}
                    className="min-h-11 p-4 text-sm text-destructive"
                  >
                    {t('errors.retry')}
                  </button>
                ) : recent.length ? (
                  recent.map(taskRow)
                ) : (
                  <p className="p-6 text-sm text-muted-foreground">{t('workspace.noResults')}</p>
                )}
              </div>
            </section>
            <section className="min-w-0">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">{t('workspace.yourAgents')}</h2>
                {user?.role === 'admin' && (
                  <Link
                    to="/agents?create=1"
                    className="inline-flex min-h-11 items-center gap-1 text-sm text-primary"
                  >
                    <Plus className="size-4" />
                    {t('workspace.create')}
                  </Link>
                )}
              </div>
              <div className="space-y-3">
                {agents.slice(0, 8).map((agent) => (
                  <Link
                    key={agent.id}
                    to={`/agent/${agent.slug}`}
                    className="flex items-center gap-3 rounded-2xl border bg-card p-4 hover:border-primary/40"
                  >
                    {agent.avatarUrl ? (
                      <img src={agent.avatarUrl} alt="" className="size-11 rounded-xl object-cover" />
                    ) : (
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                        <Bot className="size-5 text-primary" />
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-medium">{agent.name}</p>
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {agent.role}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
              <Link to="/agents" className="mt-3 flex min-h-11 items-center gap-2 text-sm text-primary">
                {t('workspace.allAgents')}
                <ArrowRight className="size-4" />
              </Link>
            </section>
          </div>
        </div>
      </main>
      {panelOpen && (
        <Suspense fallback={null}>
          <MiniAppViewer />
        </Suspense>
      )}
    </div>
  )
}

function HomeSetup({
  onOpenSettings,
  onCreateAgent,
}: {
  onOpenSettings: (section?: string) => void
  onCreateAgent: () => void
}) {
  const setup = useSetupChecklist()
  if (setup.isLoading || setup.isComplete) return null
  return (
    <section className="rounded-2xl border border-primary/20 bg-primary/5 p-5">
      <SetupChecklist variant="inline" onCreateAgent={onCreateAgent} onOpenSettings={onOpenSettings} />
    </section>
  )
}
