import { useState, useMemo, useCallback, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/client/components/ui/dialog'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/client/components/ui/select'
import { useMiniApps } from '@/client/hooks/useMiniApps'
import { useKins } from '@/client/hooks/useKins'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { api, getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import { cn } from '@/client/lib/utils'
import { AppWindow, Blocks, LayoutGrid, List, Loader2, Search } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { MiniAppCard, MiniAppTile } from '@/client/components/mini-app/MiniAppCard'
import type { MiniAppSummary } from '@/shared/types'

// Side panel viewer — opening an app renders it here (state lives in
// SidePanelProvider at the App root, surviving navigation).
const MiniAppViewer = lazy(() => import('@/client/components/mini-app/MiniAppViewer').then(m => ({ default: m.MiniAppViewer })))

const VIEW_MODE_KEY = 'kinbot:miniapps-page-view-mode'

export function MiniAppsPage() {
  const { t } = useTranslation()
  const { apps, isLoading, deleteApp } = useMiniApps(null, 'all')
  const { kins } = useKins()
  const { activeAppId, badges, openApp, closePanel } = useSidePanel()
  const [searchQuery, setSearchQuery] = useState('')
  const [reassignApp, setReassignApp] = useState<MiniAppSummary | null>(null)
  const [reassignKinId, setReassignKinId] = useState('')
  const [reassigning, setReassigning] = useState(false)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() =>
    (localStorage.getItem(VIEW_MODE_KEY) as 'grid' | 'list') || 'grid',
  )

  const toggleView = (mode: 'grid' | 'list') => {
    setViewMode(mode)
    localStorage.setItem(VIEW_MODE_KEY, mode)
  }

  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) return apps
    const q = searchQuery.toLowerCase()
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.maintainerKinName ?? '').toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q)),
    )
  }, [apps, searchQuery])

  const handleDelete = useCallback(async (appId: string) => {
    if (appId === activeAppId) closePanel()
    await deleteApp(appId)
  }, [activeAppId, closePanel, deleteApp])

  const openReassign = useCallback((app: MiniAppSummary) => {
    setReassignApp(app)
    setReassignKinId(app.maintainerKinId)
  }, [])

  const submitReassign = useCallback(async () => {
    if (!reassignApp || !reassignKinId || reassignKinId === reassignApp.maintainerKinId) {
      setReassignApp(null)
      return
    }
    setReassigning(true)
    try {
      await api.patch(`/mini-apps/${reassignApp.id}`, { maintainerKinId: reassignKinId })
      const kin = kins.find((k) => k.id === reassignKinId)
      toast.success(t('miniApps.maintainer.reassigned', { kin: kin?.name ?? '' }))
      setReassignApp(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setReassigning(false)
    }
  }, [reassignApp, reassignKinId, kins, t])

  const isEmpty = filteredApps.length === 0 && !isLoading

  return (
    <div className="surface-base flex h-full overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Page header */}
        <PageHeader
          icon={Blocks}
          title={t('activityBar.apps')}
          actions={
            <>
              {apps.length > 0 && (
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('sidebar.miniApps.search')}
                    className="h-9 pl-8"
                  />
                </div>
              )}
              <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
                <button
                  type="button"
                  onClick={() => toggleView('grid')}
                  className={cn(
                    'rounded p-1.5 transition-colors',
                    viewMode === 'grid' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={t('sidebar.miniApps.viewGrid')}
                >
                  <LayoutGrid className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => toggleView('list')}
                  className={cn(
                    'rounded p-1.5 transition-colors',
                    viewMode === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                  title={t('sidebar.miniApps.viewList')}
                >
                  <List className="size-4" />
                </button>
              </div>
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
              {searchQuery ? (
                <p className="text-center text-sm text-muted-foreground">{t('sidebar.miniApps.noResults')}</p>
              ) : (
                <EmptyState
                  icon={AppWindow}
                  title={t('sidebar.miniApps.empty')}
                  description={t('sidebar.miniApps.emptyDescription')}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mx-auto max-w-6xl">
              {viewMode === 'grid' ? (
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                  {filteredApps.map((app) => (
                    <MiniAppTile
                      key={app.id}
                      app={app}
                      isActive={app.id === activeAppId}
                      badge={badges[app.id]}
                      onClick={() => openApp(app.id)}
                      onDelete={() => handleDelete(app.id)}
                      onChangeMaintainer={() => openReassign(app)}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {filteredApps.map((app) => (
                    <MiniAppCard
                      key={app.id}
                      app={app}
                      isActive={app.id === activeAppId}
                      badge={badges[app.id]}
                      onClick={() => openApp(app.id)}
                      onDelete={() => handleDelete(app.id)}
                      onChangeMaintainer={() => openReassign(app)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Side panel (app viewer) */}
      <Suspense fallback={null}>
        <MiniAppViewer />
      </Suspense>

      {/* Reassign maintainer dialog */}
      <Dialog open={!!reassignApp} onOpenChange={(open) => { if (!open && !reassigning) setReassignApp(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('miniApps.maintainer.dialogTitle', { name: reassignApp?.name ?? '' })}</DialogTitle>
            <DialogDescription>{t('miniApps.maintainer.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <Select value={reassignKinId} onValueChange={setReassignKinId} disabled={reassigning}>
            <SelectTrigger>
              <SelectValue placeholder={t('miniApps.maintainer.selectPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {kins.map((k) => (
                <SelectItem key={k.id} value={k.id}>{k.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReassignApp(null)} disabled={reassigning}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submitReassign} disabled={reassigning || !reassignKinId || reassignKinId === reassignApp?.maintainerKinId}>
              {reassigning ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('miniApps.maintainer.reassign')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
