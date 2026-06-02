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
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import { CronCard, SortableCronCard } from '@/client/components/crons/CronCard'
import { useCrons } from '@/client/hooks/useCrons'
import { useTasksContext } from '@/client/contexts/TasksContext'
import { useKins } from '@/client/hooks/useKins'
import { Plus, Loader2, Search, Timer, CalendarClock } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import type { CronSummary } from '@/shared/types'

const CronFormModal = lazy(() => import('@/client/components/sidebar/CronFormModal').then(m => ({ default: m.CronFormModal })))
const CronDetailModal = lazy(() => import('@/client/components/sidebar/CronDetailModal').then(m => ({ default: m.CronDetailModal })))

export function CronsPage() {
  const { t } = useTranslation()
  const { kins, llmModels } = useKins()
  const { activeCronIds } = useTasksContext()
  const {
    crons,
    isLoading,
    createCron,
    updateCron,
    deleteCron,
    approveCron,
    reorderCrons,
  } = useCrons()

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [editCron, setEditCron] = useState<CronSummary | null>(null)
  const [detailCron, setDetailCron] = useState<CronSummary | null>(null)
  const [duplicateDefaults, setDuplicateDefaults] = useState<Partial<CronSummary> | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const cronKins = useMemo(
    () => kins.map((k) => ({ id: k.id, name: k.name, role: k.role, avatarUrl: k.avatarUrl })),
    [kins],
  )

  const filteredCrons = useMemo(() => {
    if (!searchQuery.trim()) return crons
    const q = searchQuery.toLowerCase()
    return crons.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.kinName.toLowerCase().includes(q) ||
        c.schedule.toLowerCase().includes(q),
    )
  }, [crons, searchQuery])

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
  const isDraggable = !searchQuery.trim()

  const GRID = 'grid grid-cols-1 gap-3 items-stretch sm:grid-cols-2 xl:grid-cols-3'

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarClock className="size-5 shrink-0 text-primary" />
          <h1 className="truncate text-base font-semibold">{t('activityBar.crons')}</h1>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          {crons.length > 0 && (
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('sidebar.crons.search')}
                className="h-9 pl-8"
              />
            </div>
          )}
          <Button onClick={() => setShowCreateModal(true)} className="shrink-0 gap-1.5">
            <Plus className="size-4" />
            <span className="max-sm:hidden">{t('sidebar.crons.create')}</span>
          </Button>
        </div>
      </header>

      {/* Body */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isEmpty ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md">
            {searchQuery ? (
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
                <div className={GRID}>
                  {pendingCrons.map((cron) => (
                    <CronCard
                      key={cron.id}
                      cron={cron}
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
                  <SortableContext items={regularCronIds} strategy={rectSortingStrategy}>
                    <div className={GRID}>
                      {regularCrons.map((cron) => (
                        <SortableCronCard
                          key={cron.id}
                          cron={cron}
                          onClick={() => setDetailCron(cron)}
                          onToggleActive={(isActive) => updateCron(cron.id, { isActive })}
                          isRunning={activeCronIds?.has(cron.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className={GRID}>
                  {regularCrons.map((cron) => (
                    <CronCard
                      key={cron.id}
                      cron={cron}
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
            kins={cronKins}
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
            kins={cronKins}
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
