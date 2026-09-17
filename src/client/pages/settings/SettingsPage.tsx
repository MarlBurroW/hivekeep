import { createContext, useContext, Suspense, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, SquareTerminal } from 'lucide-react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { useAuth } from '@/client/hooks/useAuth'
import { settingsSections, visibleSettingsGroups, settingsUrl } from '@/client/lib/navigation'
import { ThemeToggle } from '@/client/components/common/ThemeToggle'
import { PaletteToggle } from '@/client/components/common/PaletteToggle'
import { ErrorBoundary } from '@/client/components/common/ErrorBoundary'
import { cn } from '@/client/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/client/components/ui/dialog'

const GeneralSettings = lazy(() => import('@/client/pages/settings/GeneralSettings').then(m => ({ default: m.GeneralSettings })))
const ProvidersSettings = lazy(() => import('@/client/pages/settings/ProvidersSettings').then(m => ({ default: m.ProvidersSettings })))
const ModelsSettings = lazy(() => import('@/client/pages/settings/ModelsSettings').then(m => ({ default: m.ModelsSettings })))
const ModelRegistrySettings = lazy(() => import('@/client/pages/settings/ModelRegistrySettings').then(m => ({ default: m.ModelRegistrySettings })))
const AvatarsSettings = lazy(() => import('@/client/pages/settings/AvatarsSettings').then(m => ({ default: m.AvatarsSettings })))
const VaultSettings = lazy(() => import('@/client/pages/settings/VaultSettings').then(m => ({ default: m.VaultSettings })))
const McpServersSettings = lazy(() => import('@/client/pages/settings/McpServersSettings').then(m => ({ default: m.McpServersSettings })))
const ContactsSettings = lazy(() => import('@/client/pages/settings/ContactsSettings').then(m => ({ default: m.ContactsSettings })))
const FileStorageSettings = lazy(() => import('@/client/pages/settings/FileStorageSettings').then(m => ({ default: m.FileStorageSettings })))
const MemoriesSettings = lazy(() => import('@/client/pages/settings/MemoriesSettings').then(m => ({ default: m.MemoriesSettings })))
const WebhooksSettings = lazy(() => import('@/client/pages/settings/WebhooksSettings').then(m => ({ default: m.WebhooksSettings })))
const ExternalApiSettings = lazy(() => import('@/client/pages/settings/ExternalApiSettings').then(m => ({ default: m.ExternalApiSettings })))
const ChannelsSettings = lazy(() => import('@/client/pages/settings/ChannelsSettings').then(m => ({ default: m.ChannelsSettings })))
const EmailAccountsSettings = lazy(() => import('@/client/pages/settings/EmailAccountsSettings').then(m => ({ default: m.EmailAccountsSettings })))
const UsersSettings = lazy(() => import('@/client/pages/settings/UsersSettings').then(m => ({ default: m.UsersSettings })))
const NotificationPreferences = lazy(() => import('@/client/components/notifications/NotificationPreferences').then(m => ({ default: m.NotificationPreferences })))
const PluginsSettings = lazy(() => import('@/client/pages/settings/PluginsSettings').then(m => ({ default: m.PluginsSettings })))
const PluginMarketplace = lazy(() => import('@/client/pages/settings/PluginMarketplace').then(m => ({ default: m.PluginMarketplace })))
const ToolboxesSettings = lazy(() => import('@/client/pages/settings/ToolboxesSettings').then(m => ({ default: m.ToolboxesSettings })))
const CustomToolsSettings = lazy(() => import('@/client/pages/settings/CustomToolsSettings').then(m => ({ default: m.CustomToolsSettings })))
const CustomDomainsSettings = lazy(() => import('@/client/pages/settings/CustomDomainsSettings').then(m => ({ default: m.CustomDomainsSettings })))
const LogsSettings = lazy(() => import('@/client/pages/settings/LogsSettings').then(m => ({ default: m.LogsSettings })))
const TokenUsageSettings = lazy(() => import('@/client/pages/settings/TokenUsageSettings').then(m => ({ default: m.TokenUsageSettings })))
const UpdatesSettings = lazy(() => import('@/client/pages/settings/UpdatesSettings').then(m => ({ default: m.UpdatesSettings })))

const sectionComponents: Record<string, React.FC> = {
  general: GeneralSettings,
  providers: ProvidersSettings,
  models: ModelsSettings,
  modelRegistry: ModelRegistrySettings,
  avatars: AvatarsSettings,
  mcp: McpServersSettings,
  vault: VaultSettings,
  memories: MemoriesSettings,
  contacts: ContactsSettings,
  users: UsersSettings,
  files: FileStorageSettings,
  webhooks: WebhooksSettings,
  externalApi: ExternalApiSettings,
  channels: ChannelsSettings,
  emailAccounts: EmailAccountsSettings,
  plugins: PluginsSettings,
  marketplace: PluginMarketplace,
  toolboxes: ToolboxesSettings,
  customTools: CustomToolsSettings,
  customDomains: CustomDomainsSettings,
  notifications: NotificationPreferences,
  logs: LogsSettings,
  tokenUsage: TokenUsageSettings,
  updates: UpdatesSettings,
}


export interface SettingsFilters { agentId?: string }
const SettingsNavContext = createContext<((section: string) => void) | null>(null)
const SettingsCloseContext = createContext<(() => void) | null>(null)
export function useSettingsNav() { return useContext(SettingsNavContext) ?? (() => {}) }
export function useSettingsClose() { return useContext(SettingsCloseContext) ?? (() => {}) }

export function SettingsContent({ section, filters, onNavigate, onClose }: { section: string; filters?: SettingsFilters; onNavigate: (section: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const available = visibleSettingsGroups(user?.role === 'admin').flatMap(group => group.items)
  const allowed = available.some(item => item.id === section)
  const Component = sectionComponents[section]
  if (!allowed || !Component) return <div className="p-8"><h1 className="text-xl font-semibold">{t('workspace.unavailable')}</h1><p className="mt-2 text-muted-foreground">{t('workspace.unavailableDescription')}</p><button onClick={() => onNavigate('general')} className="mt-4 min-h-11 text-primary">{t('settings.title')}</button></div>
  return <SettingsCloseContext.Provider value={onClose}><SettingsNavContext.Provider value={onNavigate}>
    <ErrorBoundary key={section} compact><Suspense fallback={<p role="status" className="p-6 text-muted-foreground">{t('common.loading')}</p>}>
      {section === 'general' && <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"><span className="text-sm font-medium">{t('workspace.appearance')}</span><div className="flex gap-2"><PaletteToggle /><ThemeToggle /></div></div>}
      {section === 'tokenUsage' ? <TokenUsageSettings initialAgentFilter={filters?.agentId} /> : <Component />}
    </Suspense></ErrorBoundary>
  </SettingsNavContext.Provider></SettingsCloseContext.Provider>
}

export function SettingsPage() {
  const { section = 'general' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuth()
  const { t } = useTranslation()
  const groups = visibleSettingsGroups(user?.role === 'admin')
  const current = settingsSections.find(item => item.id === section)
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo
  const close = () => navigate(returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/agents')
  const change = (id: string) => navigate(settingsUrl(id, { agentId: params.get('agentId') ?? undefined }), { state: { returnTo } })
  return <div className="surface-base flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3 md:px-6"><button onClick={close} aria-label={t('workspace.back')} className="flex size-11 items-center justify-center rounded-xl hover:bg-muted"><ArrowLeft className="size-5" /></button><div><p className="text-xs text-muted-foreground">{t('settings.title')}</p><h1 className="text-lg font-semibold">{current ? t(current.labelKey) : t('workspace.unavailable')}</h1></div></header>
    <div className="min-h-0 flex flex-1 flex-col md:flex-row">
      <div className="border-b p-3 md:hidden"><label className="sr-only" htmlFor="settings-section">{t('settings.title')}</label><select id="settings-section" className="min-h-11 w-full rounded-lg border bg-background px-3 text-sm" value={section} onChange={event => change(event.target.value)}>{groups.map(group => <optgroup key={group.labelKey} label={t(group.labelKey)}>{group.items.map(item => <option key={item.id} value={item.id}>{t(item.labelKey)}</option>)}</optgroup>)}</select></div>
      <nav aria-label={t('settings.title')} className="surface-sidebar hidden w-56 shrink-0 overflow-y-auto border-r p-4 md:block">{groups.map(group => <div key={group.labelKey} className="mb-5"><h2 className="mb-2 px-2 text-xs font-semibold text-muted-foreground">{t(group.labelKey)}</h2>{group.items.map(item => <Link key={item.id} to={settingsUrl(item.id, { agentId: params.get('agentId') ?? undefined })} state={{ returnTo }} aria-current={section === item.id ? 'page' : undefined} className={cn('flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm', section === item.id ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted')}><item.icon className="size-4 shrink-0" />{t(item.labelKey)}</Link>)}</div>)}{user?.role === 'admin' && <Link to="/terminal" className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted"><SquareTerminal className="size-4" />{t('activityBar.terminal')}</Link>}</nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8"><div className="mx-auto max-w-3xl"><SettingsContent section={section} filters={{ agentId: params.get('agentId') ?? undefined }} onNavigate={change} onClose={close} /></div></main>
    </div>
  </div>
}

// Kept for integrations that still embed the settings dialog.
export function SettingsModal({ open, onOpenChange, initialSection = 'general', initialFilters }: { open: boolean; onOpenChange: (open: boolean) => void; initialSection?: string; initialFilters?: SettingsFilters }) {
  const { t } = useTranslation()
  const [section, setSection] = useState<string | null>(null)
  return <Dialog open={open} onOpenChange={value => { setSection(null); onOpenChange(value) }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"><DialogHeader><DialogTitle>{t('settings.title')}</DialogTitle></DialogHeader><SettingsContent section={section ?? initialSection} filters={initialFilters} onNavigate={setSection} onClose={() => onOpenChange(false)} /></DialogContent></Dialog>
}
