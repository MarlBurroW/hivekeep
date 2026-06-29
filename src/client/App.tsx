import { useState, useEffect, useCallback, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { useAuth } from '@/client/hooks/useAuth'
import { useTranslation } from 'react-i18next'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { toast } from 'sonner'
import { api } from '@/client/lib/api'
import { SidePanelProvider } from '@/client/contexts/SidePanelContext'
import { TasksProvider } from '@/client/contexts/TasksContext'
import { CronsProvider } from '@/client/contexts/CronsContext'
import { TicketMentionShell } from '@/client/contexts/TicketMentionShell'
import { UpdateProvider } from '@/client/contexts/UpdateContext'
import { FeedbackProvider } from '@/client/contexts/FeedbackContext'
import { UpdateOverlay } from '@/client/components/common/UpdateOverlay'
import { GlobalUpdateDialog } from '@/client/components/common/GlobalUpdateDialog'
import { ActivityBar } from '@/client/components/layout/ActivityBar'
import { AppTopBar } from '@/client/components/layout/AppTopBar'
import { TooltipProvider } from '@/client/components/ui/tooltip'

// Lazy-loaded pages for code splitting
const ChatPage = lazy(() => import('@/client/pages/chat/ChatPage').then(m => ({ default: m.ChatPage })))
const ProjectsPage = lazy(() => import('@/client/pages/projects/ProjectsPage').then(m => ({ default: m.ProjectsPage })))
const TasksPage = lazy(() => import('@/client/pages/tasks/TasksPage').then(m => ({ default: m.TasksPage })))
const CronsPage = lazy(() => import('@/client/pages/crons/CronsPage').then(m => ({ default: m.CronsPage })))
const FilesPage = lazy(() => import('@/client/pages/files/FilesPage').then(m => ({ default: m.FilesPage })))
const MiniAppsPage = lazy(() => import('@/client/pages/mini-apps/MiniAppsPage').then(m => ({ default: m.MiniAppsPage })))
const ModelRegistryPage = lazy(() => import('@/client/pages/models/ModelRegistryPage').then(m => ({ default: m.ModelRegistryPage })))
const TerminalPage = lazy(() => import('@/client/pages/terminal/TerminalPage').then(m => ({ default: m.TerminalPage })))
const LoginPage = lazy(() => import('@/client/pages/login/LoginPage').then(m => ({ default: m.LoginPage })))
const OnboardingPage = lazy(() => import('@/client/pages/onboarding/OnboardingPage').then(m => ({ default: m.OnboardingPage })))
const DesignSystemPage = lazy(() => import('@/client/pages/design-system/DesignSystemPage').then(m => ({ default: m.DesignSystemPage })))
const InvitePage = lazy(() => import('@/client/pages/invite/InvitePage').then(m => ({ default: m.InvitePage })))

// Global modals rendered at App root so they survive navigation between Agents / Projets.
const SettingsModal = lazy(() => import('@/client/pages/settings/SettingsPage').then(m => ({ default: m.SettingsModal })))
const AccountDialog = lazy(() => import('@/client/pages/account/AccountPage').then(m => ({ default: m.AccountDialog })))

const isDev = import.meta.env.DEV

function PageFallback() {
  return (
    <div className="surface-base flex min-h-screen items-center justify-center">
      <div className="text-center animate-fade-in">
        <h1 className="gradient-primary-text text-4xl font-bold tracking-tight">Gezy</h1>
      </div>
    </div>
  )
}

interface OnboardingStatus {
  completed: boolean
  hasAdmin: boolean
  hasLlm: boolean
  hasEmbedding: boolean
}

function AppRoot() {
  const { t } = useTranslation()
  const { isLoading: authLoading, isAuthenticated, login, refetch } = useAuth()
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null)
  const [isCheckingOnboarding, setIsCheckingOnboarding] = useState(true)
  const [backendError, setBackendError] = useState(false)

  const checkOnboarding = useCallback(async () => {
    try {
      const status = await api.get<OnboardingStatus>('/onboarding/status')
      setOnboardingStatus(status)
      setBackendError(false)
    } catch {
      setBackendError(true)
    } finally {
      setIsCheckingOnboarding(false)
    }
  }, [])

  useEffect(() => {
    checkOnboarding()
  }, [checkOnboarding])

  // Warm the registry's name→domain map once. The lib falls back to 'mcp'
  // while this is in-flight; first paint may briefly show generic badges
  // for new tools, then re-render with the right colour.
  useEffect(() => {
    void import('@/client/lib/tool-domain-lookup').then((m) => {
      void m.loadToolDomainMap()
      void m.loadToolDomainMeta()
    })
    // Localized custom-tool display names (custom_<slug> → human name) so chat
    // tool-calls show a proper name instead of the raw slug.
    void import('@/client/lib/custom-tool-names').then((m) => {
      void m.loadCustomToolNames()
    })
  }, [])

  // Loading state
  if (authLoading || isCheckingOnboarding) {
    return (
      <div className="surface-base flex min-h-screen items-center justify-center">
        <div className="text-center animate-fade-in">
          <h1 className="gradient-primary-text text-4xl font-bold tracking-tight">Gezy</h1>
          <p className="mt-3 text-muted-foreground">{t('common.loading')}</p>
        </div>
      </div>
    )
  }

  // Backend unreachable — show error with retry
  if (backendError) {
    return (
      <div className="surface-base flex min-h-screen items-center justify-center">
        <div className="text-center animate-fade-in max-w-md space-y-4">
          <h1 className="gradient-primary-text text-4xl font-bold tracking-tight">Gezy</h1>
          <p className="text-muted-foreground">{t('errors.backendUnavailable')}</p>
          <button
            onClick={() => {
              setIsCheckingOnboarding(true)
              setBackendError(false)
              checkOnboarding()
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {t('errors.retry')}
          </button>
        </div>
      </div>
    )
  }

  // Fresh install — no admin exists yet, run the (now-minimal) onboarding.
  // The provider/default-model questionnaire that used to live here moved
  // to the dashboard's setup checklist; first-time users land on a usable
  // app immediately and configure capabilities at their own pace.
  if (onboardingStatus && !onboardingStatus.hasAdmin) {
    return (
      <Suspense fallback={<PageFallback />}>
        <OnboardingPage
          onComplete={async () => {
            await refetch()
            await checkOnboarding()
          }}
        />
      </Suspense>
    )
  }

  // Not authenticated — show login
  if (!isAuthenticated) {
    return (
      <Suspense fallback={<PageFallback />}>
        <LoginPage onLogin={login} />
      </Suspense>
    )
  }

  return <AuthenticatedShell />
}

// ─── Authenticated shell ────────────────────────────────────────────────────
//
// Top-level layout when the user is authenticated. Owns:
//  - The persistent top bar (visible across Agents / Projets / future modes)
//  - The activity bar (left, 48px)
//  - The global SettingsModal and AccountDialog
//
// The shadcn Sidebar inside ChatPage uses `position: fixed` (cf.
// src/client/components/ui/sidebar.tsx:260), which by default anchors to the
// viewport. The containing-block trick (transform: translateZ(0)) that scopes
// that fixed sidebar to the content area lives on ChatPage's own wrapper, NOT
// here on the global routed-content div. Applying it globally would also turn
// this div into the containing block for @dnd-kit's DragOverlay (also
// position: fixed), offsetting the drag ghost on the Projects kanban.
function AuthenticatedShell() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>()
  const [settingsFilters, setSettingsFilters] = useState<{ agentId?: string } | undefined>()
  const [accountOpen, setAccountOpen] = useState(false)

  const handleOpenSettings = useCallback((section?: string, filters?: { agentId?: string }) => {
    setSettingsInitialSection(section)
    setSettingsFilters(filters)
    setSettingsOpen(true)
  }, [])

  const handleOpenAccount = useCallback(() => setAccountOpen(true), [])

  // Surface the result of an email OAuth connect (the callback redirects back
  // to "/?email_connected=<addr>" or "/?email_error=<msg>"). Toast, open the
  // Email accounts settings on success, then strip the query params.
  const { t } = useTranslation()
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('email_connected')
    const error = params.get('email_error')
    if (!connected && !error) return
    if (connected) {
      toast.success(t('settings.emailAccounts.connectedToast', { email: connected }))
      handleOpenSettings('emailAccounts')
    } else if (error) {
      toast.error(decodeURIComponent(error))
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash)
  }, [t, handleOpenSettings])

  return (
    <TooltipProvider delayDuration={0}>
    <SidePanelProvider>
    <TasksProvider>
    <CronsProvider>
    <UpdateProvider>
    <FeedbackProvider>
    <TicketMentionShell>
      <div className="flex h-dvh w-screen flex-col overflow-hidden">
        <AppTopBar
          onOpenSettings={handleOpenSettings}
          onOpenAccount={handleOpenAccount}
        />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <ActivityBar />
          <div className="min-w-0 flex-1">
            <Suspense fallback={<PageFallback />}>
              <Routes>
                <Route
                  path="/projects"
                  element={<ProjectsPage />}
                />
                <Route
                  path="/projects/:projectId"
                  element={<ProjectsPage />}
                />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/crons" element={<CronsPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/files/:agentId" element={<FilesPage />} />
                <Route path="/files/:sourceType/:sourceId" element={<FilesPage />} />
                <Route path="/mini-apps" element={<MiniAppsPage />} />
                <Route path="/models" element={<ModelRegistryPage />} />
                <Route path="/terminal" element={<TerminalPage />} />
                <Route
                  path="*"
                  element={
                    <ChatPage
                      onOpenSettings={handleOpenSettings}
                      onOpenAccount={handleOpenAccount}
                    />
                  }
                />
              </Routes>
            </Suspense>
          </div>
        </div>

        {/* Global modals — rendered once, survive navigation */}
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            initialSection={settingsInitialSection}
            initialFilters={settingsFilters}
          />
        </Suspense>
        <Suspense fallback={null}>
          <AccountDialog
            open={accountOpen}
            onOpenChange={setAccountOpen}
          />
        </Suspense>

        {/* Shared update dialog + full-screen self-update overlay (global) */}
        <GlobalUpdateDialog />
        <UpdateOverlay />
      </div>
    </TicketMentionShell>
    </FeedbackProvider>
    </UpdateProvider>
    </CronsProvider>
    </TasksProvider>
    </SidePanelProvider>
    </TooltipProvider>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {isDev && <Route path="/design-system" element={<Suspense fallback={<PageFallback />}><DesignSystemPage /></Suspense>} />}
        <Route path="/invite/:token" element={<Suspense fallback={<PageFallback />}><InvitePage /></Suspense>} />
        <Route path="*" element={<AppRoot />} />
      </Routes>
    </BrowserRouter>
  )
}
