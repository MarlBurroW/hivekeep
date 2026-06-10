import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Boxes, DownloadCloud, RefreshCw } from 'lucide-react'
import { useAuth } from '@/client/hooks/useAuth'
import { Button } from '@/client/components/ui/button'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { api, getErrorMessage } from '@/client/lib/api'
import { ModelRegistryTable } from '@/client/pages/models/ModelRegistryTable'

/**
 * Dedicated, full-width home for the model registry. The table is a dense admin
 * grid (context, modalities, reasoning, pricing per model) that was cramped
 * inside the Settings modal's `max-w-2xl` column — it gets a real page here.
 * Admin-only; non-admins are bounced to the app root.
 *
 * The sync actions (models.dev snapshot refresh + resync) live in the page
 * header's actions slot; the table reloads via the bumped `reloadKey`.
 */
export function ModelRegistryPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [resyncing, setResyncing] = useState(false)
  const [snapshotBusy, setSnapshotBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  if (user && user.role !== 'admin') return <Navigate to="/" replace />

  const resync = async () => {
    setResyncing(true)
    try {
      await api.post('/models/resync')
      toast.success(t('settings.modelRegistry.resyncStarted', 'Resync started — refresh in a moment'))
      // give the background reconcile a beat, then reload the table
      setTimeout(() => setReloadKey((k) => k + 1), 1500)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setResyncing(false)
    }
  }

  const refreshSnapshot = async () => {
    setSnapshotBusy(true)
    try {
      const res = await api.post<{ modelCount: number; providerCount: number }>('/models/refresh-snapshot', {})
      toast.success(t('settings.modelRegistry.snapshotRefreshed', { models: res.modelCount, providers: res.providerCount, defaultValue: 'models.dev updated — {{models}} models across {{providers}} providers. Re-matching…' }))
      setTimeout(() => setReloadKey((k) => k + 1), 2000)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSnapshotBusy(false)
    }
  }

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={Boxes}
        title={t('settings.modelRegistry.title', 'Model registry')}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={refreshSnapshot} disabled={snapshotBusy} title={t('settings.modelRegistry.snapshotTip', 'Download the latest models.dev catalogue, then re-match')}>
              <DownloadCloud className={`size-4 ${snapshotBusy ? 'animate-pulse' : ''}`} />
              {t('settings.modelRegistry.snapshotRefresh', 'Update models.dev')}
            </Button>
            <Button variant="outline" size="sm" onClick={resync} disabled={resyncing}>
              <RefreshCw className={`size-4 ${resyncing ? 'animate-spin' : ''}`} />
              {t('settings.modelRegistry.resync', 'Resync')}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
          <ModelRegistryTable reloadKey={reloadKey} />
        </div>
      </div>
    </div>
  )
}
