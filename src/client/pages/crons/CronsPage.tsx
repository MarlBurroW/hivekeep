import { useState, useMemo, useCallback, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { CronRow, SortableCronRow } from '@/client/components/crons/CronRow'
import { useCronsContext } from '@/client/contexts/CronsContext'
import { useTasksContext } from '@/client/contexts/TasksContext'
import { useAgents } from '@/client/hooks/useAgents'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { Plus, Loader2, Search, Timer, CalendarClock } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { PageHeader } from '@/client/components/layout/PageHeader'
import type { CronSummary } from '@/shared/types'

const CronFormModal = lazy(() => import('@/client/components/sidebar/CronFormModal').then(m => ({ default: m.CronFormModal })))
const CronDetailModal = lazy(() => import('@/client/components/sidebar/CronDetailModal').then(m => ({ default: m.CronDetailModal })))

export function CronsPage() {
  const { t } = useTranslation()
  const { agents, llmModels } = useAgents()
  const { toolboxes } = useToolboxes()
  const { activeCronIds } = useTasksContext()
  const {
    crons,
    isLoading,
    createCron,
    updateCron,
    deleteCron,
    approveCron,
    reorderCrons,
  } = useCronsContext()

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editCron, setEditCron] = useState<CronSummary | null>(null)
  const [detailCron, setDetailCron] = useState<CronSummary | null>(null)
  const [duplicateDefaults, setDuplicateDefaults] = useState<Partial<CronSummary> | null>(null)
  const [filterAgentId, setFilterAgentId] = useState<string>('all')

  const cronAgents = useMemo(
    () => agents.map((k) => ({ id: k.id, name: k.name, role: k.role, avatarUrl: k.avatarUrl })),
    [agents],
  )

  // Search (name / Agent / schedule) + per-Agent filter. Search stays in the
  // PageHeader actions slot (canonical placement); the filter sits beside it.
  const list = useListControls(crons, {
    searchText: (c) => [c.name, c.agentName, c.schedule],
    filter: (c) => filterAgentId === 'all' || c.agentId === filterAgentId,
  })
  const filteredCrons = list.filtered
  const showAgentFilter = agents.length > 1 && crons.length >= LIST_FILTER_THRESHOLD
  const isFiltering = list.isSearching || filterAgentId !== 'all'

  const pendingCrons = useMemo(() => filteredCrons.filter((c) => c.requiresApproval), [filteredCrons])
  const regularCrons = useMemo(() => filteredCrons.filter((c) => !c.requiresApproval), [filteredCrons])

  const isEmpty = filteredCrons.length === 0 && !isLoading

  const currentDetailCron = useMemo(
    () => (detailCron ? crons.find((c) => c.id === detailCron.id) ?? detailCron : null),
    [detailCron, crons],
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = regularCrons.findIndex((c) => c.id === active.id)
    const newIndex = regularCrons.findIndex((c) => c.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    const reordered = [...regularCrons]
    const [moved] = reordered.splice(oldIndex, 1)
    reordered.splice(newIndex, 0, moved!)
    reorderCrons(reordered.map((c) => c.id))
  }, [regularCrons, reorderCrons])

  const regularCronIds = regularCrons.map((c) => c.id)
  // Reordering a filtered subset would persist a misleading order, so drag is
  // only enabled when the full list is shown.
  const isDraggable = !isFiltering

  const LIST = 'surface-card divide-y divide-border/60 overflow-hidden rounded-xl border border-border'

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <PageHeader
        icon={CalendarClock}
        title={t('activityBar.crons')}
        actions={
          <>
            {showAgentFilter && (
              <Select value={filterAgentId} onValueChange={setFilterAgentId}>
                <SelectTrigger className="h-9 w-full sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('sidebar.crons.allAgents', 'All Agents')}</SelectItem>
                  {cronAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {crons.length > 0 && (
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={list.query}
                  onChange={(e) => list.setQuery(e.target.value)}
                  placeholder={t('sidebar.crons.search')}
                  className="h-9 pl-8"
                />
              </div>
            )}
            <Button onClick={() => setShowCreateModal(true)} className="shrink-0 gap-1.5">
              <Plus className="size-4" />
              <span className="max-sm:hidden">{t('sidebar.crons.create')}</span>
            </Button>
          </>
        }
      />

      {/* Body */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isEmpty ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md">
            {isFiltering ? (
              <p className="text-center text-sm text-muted-foreground">{t('sidebar.crons.noResults')}</p>
            ) : (
              <EmptyState
                icon={Timer}
                title={t('sidebar.crons.empty')}
                description={t('sidebar.crons.emptyDescription')}
                actionLabel={t('sidebar.crons.create')}
                onAction={() => setShowCreateModal(true)}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-5">
            {/* Pending approval — not sortable */}
            {pendingCrons.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-warning">
                  {t('sidebar.crons.pendingApproval')}
                </h2>
                <div className={LIST}>
                  {pendingCrons.map((cron) => (
                    <CronRow
                      key={cron.id}
                      cron={cron}
                      llmModels={llmModels}
                      toolboxes={toolboxes}
                      agents={agents}
                      onClick={() => setDetailCron(cron)}
                      onApprove={() => approveCron(cron.id)}
                      isRunning={activeCronIds?.has(cron.id)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Active + inactive — sortable (unless searching) */}
            {regularCrons.length > 0 && (
              isDraggable ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={regularCronIds} strategy={verticalListSortingStrategy}>
                    <div className={LIST}>
                      {regularCrons.map((cron) => (
                        <SortableCronRow
                          key={cron.id}
                          cron={cron}
                          llmModels={llmModels}
                          toolboxes={toolboxes}
                          agents={agents}
                          onClick={() => setDetailCron(cron)}
                          onToggleActive={(isActive) => updateCron(cron.id, { isActive })}
                          isRunning={activeCronIds?.has(cron.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className={LIST}>
                  {regularCrons.map((cron) => (
                    <CronRow
                      key={cron.id}
                      cron={cron}
                      llmModels={llmModels}
                      toolboxes={toolboxes}
                      agents={agents}
                      onClick={() => setDetailCron(cron)}
                      onToggleActive={(isActive) => updateCron(cron.id, { isActive })}
                      isRunning={activeCronIds?.has(cron.id)}
                    />
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreateModal && (
        <Suspense fallback={null}>
          <CronFormModal
            open={showCreateModal}
            onOpenChange={(open) => {
              setShowCreateModal(open)
              if (!open) setDuplicateDefaults(null)
            }}
            agents={cronAgents}
            llmModels={llmModels}
            defaults={duplicateDefaults}
            onCreate={createCron}
          />
        </Suspense>
      )}

      {/* Edit modal */}
      {editCron !== null && (
        <Suspense fallback={null}>
          <CronFormModal
            open={editCron !== null}
            onOpenChange={(open) => { if (!open) setEditCron(null) }}
            agents={cronAgents}
            llmModels={llmModels}
            cron={editCron}
            onUpdate={updateCron}
            onDelete={deleteCron}
          />
        </Suspense>
      )}

      {/* Detail modal */}
      {currentDetailCron && (
        <Suspense fallback={null}>
          <CronDetailModal
            open={detailCron !== null}
            onOpenChange={(open) => { if (!open) setDetailCron(null) }}
            cron={currentDetailCron}
            llmModels={llmModels}
            onEdit={() => {
              setDetailCron(null)
              setEditCron(currentDetailCron)
            }}
            onDuplicate={() => {
              setDetailCron(null)
              setDuplicateDefaults({
                ...currentDetailCron,
                name: `${currentDetailCron.name} (${t('cron.detail.copy')})`,
              })
              setShowCreateModal(true)
            }}
            onApprove={approveCron}
            onToggleActive={(id, isActive) => updateCron(id, { isActive })}
          />
        </Suspense>
      )}
    </div>
  )
}
