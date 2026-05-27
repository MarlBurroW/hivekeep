import { useEffect, useState, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { Kanban, BookOpen } from 'lucide-react'
import { useProjects, useProject } from '@/client/hooks/useProjects'
import { useTickets } from '@/client/hooks/useTickets'
import { ProjectsSidebar } from '@/client/components/project/ProjectsSidebar'
import { ProjectKanban } from '@/client/components/project/ProjectKanban'
import { ProjectKnowledgePanel } from '@/client/pages/projects/ProjectKnowledgePanel'
import { CreateProjectModal } from '@/client/components/project/CreateProjectModal'
import { CreateTicketModal } from '@/client/components/project/CreateTicketModal'
import { EditProjectModal } from '@/client/components/project/EditProjectModal'
import { CloneStatusBadge } from '@/client/components/project/CloneStatusBadge'
import { ActiveKinsIndicator } from '@/client/components/project/ActiveKinsIndicator'
import { EmptyState } from '@/client/components/common/EmptyState'
import { Button } from '@/client/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/client/components/ui/tabs'
import { cn } from '@/client/lib/utils'
import { getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'

type ProjectView = 'kanban' | 'knowledge'

// Side panel viewer — same component used in ChatPage, rendered here too so
// that openTask/openTicket from the kanban actually shows something.
// State lives in SidePanelProvider (mounted at App.tsx root, survives navigation).
const MiniAppViewer = lazy(() => import('@/client/components/mini-app/MiniAppViewer').then(m => ({ default: m.MiniAppViewer })))

export function ProjectsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { projectId: routeProjectId } = useParams<{ projectId?: string }>()
  const { projects, isLoading, createProject, updateProject, deleteProject } = useProjects()
  const { project } = useProject(routeProjectId ?? null)
  const { createTicket } = useTickets(routeProjectId ?? null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createTicketOpen, setCreateTicketOpen] = useState(false)
  const [editProjectOpen, setEditProjectOpen] = useState(false)
  const [view, setView] = useState<ProjectView>('kanban')

  // Auto-select the first project if none is selected and projects are available
  useEffect(() => {
    if (!routeProjectId && !isLoading) {
      const first = projects[0]
      if (first) navigate(`/projects/${first.id}`, { replace: true })
    }
  }, [routeProjectId, isLoading, projects, navigate])

  // If route points to a non-existent project, redirect to the first available one (or root)
  useEffect(() => {
    if (routeProjectId && !isLoading) {
      const exists = projects.some((p) => p.id === routeProjectId)
      const first = projects[0]
      if (!exists && first) {
        navigate(`/projects/${first.id}`, { replace: true })
      }
    }
  }, [routeProjectId, isLoading, projects, navigate])

  async function handleCreateProject(input: Parameters<typeof createProject>[0]) {
    try {
      const project = await createProject(input)
      return project
    } catch (err) {
      toast.error(getErrorMessage(err))
      throw err
    }
  }

  return (
    <div className="surface-base flex h-full overflow-hidden">
      <ProjectsSidebar
        projects={projects}
        selectedId={routeProjectId ?? null}
        onSelect={(id) => navigate(`/projects/${id}`)}
        onCreate={() => setCreateOpen(true)}
        onEdit={(id) => {
          // Navigate first so the EditProjectModal has the right `project` data
          if (id !== routeProjectId) navigate(`/projects/${id}`)
          setEditProjectOpen(true)
        }}
      />

      <main className="flex-1 overflow-hidden">
        {!routeProjectId && projects.length === 0 && !isLoading && (
          <div className="flex h-full items-center justify-center p-6">
            <div className="w-full max-w-md">
              <EmptyState
                icon={Kanban}
                title={t('projects.empty.title')}
                description={t('projects.empty.description')}
                actionLabel={t('projects.sidebar.create')}
                onAction={() => setCreateOpen(true)}
              />
            </div>
          </div>
        )}

        {routeProjectId && project && (() => {
          const total = Object.values(project.ticketCounts).reduce((a, b) => a + b, 0)
          const done = project.ticketCounts.done ?? 0
          const percent = total > 0 ? Math.round((done / total) * 100) : 0
          // Segmented progress bar — each ticket status gets a slice proportional
          // to its share of the total, using the same color tokens as the kanban
          // column accents so the bar reads as a compact mini-map of the board.
          const segments = total > 0
            ? ([
                { status: 'backlog', count: project.ticketCounts.backlog ?? 0, color: 'bg-muted-foreground/60' },
                { status: 'todo', count: project.ticketCounts.todo ?? 0, color: 'bg-info' },
                { status: 'in_progress', count: project.ticketCounts.in_progress ?? 0, color: 'bg-primary' },
                { status: 'blocked', count: project.ticketCounts.blocked ?? 0, color: 'bg-destructive' },
                { status: 'done', count: project.ticketCounts.done ?? 0, color: 'bg-success' },
              ] as const).filter((s) => s.count > 0)
            : []
          return (
          <div className="flex h-full flex-col">
            <header className="flex items-start gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <h1 className="truncate text-base font-semibold">{project.title}</h1>
                  {project.slug && (
                    <span
                      className="shrink-0 font-mono text-[11px] text-muted-foreground"
                      title={`Slug: ${project.slug} — use as 'projectSlug#number' to qualify tickets`}
                    >
                      {project.slug}
                    </span>
                  )}
                  {project.githubRepo && (
                    <CloneStatusBadge
                      status={project.cloneStatus}
                      className="ml-1"
                    />
                  )}
                </div>
                {project.description && (
                  <p className="line-clamp-2 max-w-3xl text-xs text-muted-foreground">
                    {project.description}
                  </p>
                )}
                {/* Stacked segmented progress — shows ticket distribution across all
                    five statuses, not just done/total. Reads as a mini-map of the
                    kanban below since it reuses the same status accent colors. */}
                <div className="mt-2 flex max-w-md items-center gap-2">
                  <div
                    className="flex h-1 flex-1 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    {segments.map((seg) => (
                      <div
                        key={seg.status}
                        className={cn('h-full transition-[width] duration-300', seg.color)}
                        style={{ width: `${(seg.count / total) * 100}%` }}
                        title={`${t(`projects.status.${seg.status}`)}: ${seg.count}`}
                      />
                    ))}
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {total === 0
                      ? t('projects.kanban.progressEmpty')
                      : `${t('projects.kanban.progress', { done, total })} · ${percent}%`}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Tabs value={view} onValueChange={(v) => setView(v as ProjectView)}>
                  <TabsList>
                    <TabsTrigger value="kanban">
                      <Kanban className="size-4" />
                      {t('projects.view.kanban')}
                    </TabsTrigger>
                    <TabsTrigger value="knowledge">
                      <BookOpen className="size-4" />
                      {t('projects.view.knowledge')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <ActiveKinsIndicator projectId={routeProjectId} size="size-7" maxVisible={5} />
              </div>
            </header>
            <div className="flex-1 overflow-hidden">
              {view === 'kanban' ? (
                <ProjectKanban
                  projectId={routeProjectId}
                  onNewTicket={() => setCreateTicketOpen(true)}
                />
              ) : (
                <ProjectKnowledgePanel projectId={routeProjectId} />
              )}
            </div>
          </div>
          )
        })()}
      </main>

      {/* Side panel (task/ticket detail) — rendered here so it's available in Projects mode too */}
      <Suspense fallback={null}>
        <MiniAppViewer />
      </Suspense>

      <CreateProjectModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreateProject}
        onCreated={(projectId) => navigate(`/projects/${projectId}`)}
      />

      {project && (
        <CreateTicketModal
          open={createTicketOpen}
          onOpenChange={setCreateTicketOpen}
          availableTags={project.tags}
          onCreate={async (input) => {
            await createTicket(input)
          }}
        />
      )}

      {project && (
        <EditProjectModal
          open={editProjectOpen}
          onOpenChange={setEditProjectOpen}
          project={project}
          onSave={async (input) => {
            await updateProject(project.id, input)
          }}
          onDelete={async () => {
            await deleteProject(project.id)
            navigate('/projects', { replace: true })
          }}
        />
      )}
    </div>
  )
}
