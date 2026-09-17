import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { useAuth } from '@/client/hooks/useAuth'
import { HivekeepLogo } from '@/client/components/common/HivekeepLogo'
import { UserMenu } from '@/client/components/common/UserMenu'
import { NotificationBell } from '@/client/components/notifications/NotificationBell'
import { UpdateAvailableButton } from '@/client/components/layout/UpdateAvailableButton'

export function AppTopBar({ onOpenSettings, onOpenAccount }: { onOpenSettings: (section?: string, filters?: { agentId?: string }) => void; onOpenAccount: () => void }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { t } = useTranslation()
  return <header className="surface-header z-30 flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-5">
    <button type="button" className="flex min-h-11 shrink-0 items-center" onClick={() => navigate('/')} aria-label={t('workspace.home')}><HivekeepLogo size={28} withWordmark title={null} /></button>
    <div className="flex min-w-0 flex-1 items-center justify-end gap-1 sm:gap-2">
      <button type="button" aria-label={t('commandPalette.title')} onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))} className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-2 text-muted-foreground hover:bg-muted sm:px-3"><Search className="size-4" /><span className="hidden text-sm lg:inline">{t('workspace.search')}</span><kbd className="hidden rounded border px-1.5 text-xs lg:inline">⌘ K</kbd></button>
      {user && <UpdateAvailableButton />}
      {user && <NotificationBell onOpenSettings={onOpenSettings} />}
      {user && <UserMenu user={user} onLogout={logout} onOpenSettings={() => onOpenSettings()} onOpenAccount={onOpenAccount} />}
    </div>
  </header>
}
