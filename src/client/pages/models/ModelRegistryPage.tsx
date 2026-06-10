import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { Boxes } from 'lucide-react'
import { useAuth } from '@/client/hooks/useAuth'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { ModelRegistryTable } from '@/client/pages/models/ModelRegistryTable'

/**
 * Dedicated, full-width home for the model registry. The table is a dense admin
 * grid (context, modalities, reasoning, pricing per model) that was cramped
 * inside the Settings modal's `max-w-2xl` column — it gets a real page here.
 * Admin-only; non-admins are bounced to the app root.
 */
export function ModelRegistryPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  if (user && user.role !== 'admin') return <Navigate to="/" replace />

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader icon={Boxes} title={t('settings.modelRegistry.title', 'Model registry')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
          <ModelRegistryTable />
        </div>
      </div>
    </div>
  )
}
