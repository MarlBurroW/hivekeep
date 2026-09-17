import { useState, useMemo, useCallback, useEffect, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/client/components/ui/sidebar'
import { AppSidebar } from '@/client/components/sidebar/AppSidebar'
import { ChatPanel } from '@/client/components/chat/ChatPanel'
import { isUserAgent } from '@/shared/agent-kind'
import { appendToDraft } from '@/client/hooks/useDraftMessage'

// Lazy-load modals — not needed on initial render
const AgentFormModal = lazy(() => import('@/client/components/agent/AgentFormModal').then(m => ({ default: m.AgentFormModal })))
const MiniAppViewer = lazy(() => import('@/client/components/mini-app/MiniAppViewer').then(m => ({ default: m.MiniAppViewer })))
import { useAgents } from '@/client/hooks/useAgents'
import { KeyboardShortcutsDialog } from '@/client/components/common/KeyboardShortcutsDialog'
import { StatusNotifications } from '@/client/components/common/StatusNotifications'
import { Button } from '@/client/components/ui/button'
import { SetupChecklist } from '@/client/components/common/SetupChecklist'
import { useDocumentTitle } from '@/client/hooks/useDocumentTitle'
import { useUnreadWhileHidden } from '@/client/hooks/useUnreadWhileHidden'
import { useFaviconBadge } from '@/client/hooks/useFaviconBadge'
import { Bot, ChevronRight, Command, MessageSquare, Network, Plus, Sparkles } from 'lucide-react'
import { useUnreadPerAgent } from '@/client/hooks/useUnreadPerAgent'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { api } from '@/client/lib/api'
import { useAuth } from '@/client/hooks/useAuth'
import { useSidePanel } from '@/client/contexts/SidePanelContext'

interface ChatPageProps {
  /** Open the global settings modal (mounted at App.tsx root). */
  onOpenSettings: (section?: string, filters?: { agentId?: string }) => void
  /** Open the global account dialog (mounted at App.tsx root). */
  onOpenAccount: () => void
}

export function ChatPage({ onOpenSettings, onOpenAccount }: ChatPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { panelOpen } = useSidePanel()
  const {
    agents,
    llmModels,
    imageModels,
    isLoading: agentsLoading,
    agentQueueState,
    getAgent,
    createAgent,
    updateAgent,
    deleteAgent,
    uploadAvatar,
    generateAvatarPreview,
    generateAgentConfig,
    generateAvatarPreviewFromConfig,
    hasImageCapability,
    reorderAgents,
    fetchContextUsage,
    refetch: refetchAgents,
    refetchModels,
  } = useAgents()

  // Derive selected agent from URL (/agent/:slug)
  const selectedAgentSlug = location.pathname.match(/^\/agent\/([^/]+)/)?.[1] ?? null

  // Persist the last selected agent so navigating away and back
  // doesn't drop the selection. Restored once on first visit to "/" when we
  // have a stored slug matching an existing agent.
  useEffect(() => {
    if (selectedAgentSlug) {
      try { localStorage.setItem('hivekeep:lastSelectedAgentSlug', selectedAgentSlug) } catch { /* ignore */ }
    }
  }, [selectedAgentSlug])

  useEffect(() => {
    if (selectedAgentSlug || agentsLoading || agents.length === 0) return
    if (location.pathname !== '/agents' || location.search) return
    let stored: string | null = null
    try { stored = localStorage.getItem('hivekeep:lastSelectedAgentSlug') } catch { /* ignore */ }
    if (!stored) return
    if (!agents.some((k) => k.slug === stored)) return
    navigate(`/agent/${stored}`, { replace: true })
  }, [selectedAgentSlug, agentsLoading, agents, location.pathname, navigate])

  // Optional first-run guidance points to the normal Queenie conversation.
  // It never blocks navigation or asks for a second onboarding interaction.
  const configuratorAgent = agents.find((k) => k.kind === 'configurator')
  // Dismissal is DB-backed (user_profiles.onboarding_modal_dismissed) so a fresh
  // DB re-shows the modal and it persists across devices. Optimistic local flag
  // avoids a flash between the PATCH and the user refetch.
  const { user, refetch: refetchUser } = useAuth()
  const [dismissedOptimistic, setDismissedOptimistic] = useState(false)
  const onboardingModalDismissed = dismissedOptimistic || user?.onboardingModalDismissed === true
  const dismissOnboardingModal = useCallback(() => {
    setDismissedOptimistic(true)
    api.patch('/me', { onboardingModalDismissed: true }).then(() => refetchUser()).catch(() => { /* keep optimistic */ })
  }, [refetchUser])
  const showOnboardingModal =
    !!configuratorAgent &&
    !onboardingModalDismissed &&
    !agentsLoading &&
    // Only while it's the user's sole Agent (i.e. they haven't created a real one yet).
    !agents.some(isUserAgent)

  // Detect agents whose model is no longer served by any provider
  const unavailableAgentIds = useMemo(() => {
    if (llmModels.length === 0) return new Set<string>()
    return new Set(
      agents.filter((k) => !llmModels.some((m) => m.id === k.model)).map((k) => k.id),
    )
  }, [agents, llmModels])

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const [editingAgent, setEditingAgent] = useState<Awaited<ReturnType<typeof getAgent>> | null>(null)
  // Tab the edit modal opens on — 'tools' when coming from the composer's tools badge.
  const [editInitialTab, setEditInitialTab] = useState<'tools' | undefined>(undefined)

  // Settings + account modals are owned by App.tsx (AuthenticatedShell) and rendered there.
  // ChatPage calls the props directly to open them. We keep a local alias for backwards
  // compatibility with the existing onOpenSettings prop chain through children.
  const handleOpenSettings = onOpenSettings

  const handleSelectAgent = (slug: string) => {
    const agent = agents.find((k) => k.slug === slug)
    if (agent) clearAgentUnread(agent.id)
    navigate(`/agent/${slug}`)
  }

  const handleOpenCreateModal = () => {
    if (user?.role !== 'admin') return
    refetchModels()
    setShowCreateModal(true)
  }

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('create') === '1' && user?.role === 'admin') {
      setShowCreateModal(true)
      refetchModels()
      params.delete('create')
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
    }
    if (params.get('draft') === 'build-app' && selectedAgentSlug) {
      const agent = agents.find((item) => item.slug === selectedAgentSlug)
      if (!agent || !user) return
      appendToDraft(agent.id, t('experience.buildAppDraft', 'Help me build an app. First, let us define what it should do.'), user.id)
      params.delete('draft')
      navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
    }
  }, [location.pathname, location.search, user?.id, user?.role, selectedAgentSlug, agents, navigate, refetchModels, t])

  // Onboarding is complete when at least one LLM is configured AND at least
  // one Agent exists. The Hub Agent distinction was retired — every Agent is a
  // first-class citizen now that channels bind directly to any of them.
  // The seeded configurator Agent (Queenie) doesn't count as the user's "first
  // Agent" — onboarding is only "done" once they've created a real one.
  const onboardingComplete = llmModels.length > 0 && agents.some(isUserAgent)

  // Suppress the onboarding checklist while initial data is still loading.
  // Without this, the chat momentarily renders the checklist when arriving
  // on "/" before agents/models have been fetched, then flips to the
  // "Select an agent" placeholder once data lands. Showing nothing during
  // load is much calmer than the flash.
  //
  // We rely on `agentsLoading` alone — gating on `llmModels.length > 0 ||
  // agents.length > 0` used to leave a freshly-onboarded user (zero of
  // everything) stuck on a blank screen forever.
  const initialDataLoaded = !agentsLoading

  const handleOpenEditModal = async (agentId?: string, initialTab?: 'tools') => {
    const id = agentId ?? selectedAgent?.id
    if (!id) return
    refetchModels()
    try {
      const detail = await getAgent(id)
      setEditingAgent(detail)
      setEditInitialTab(initialTab)
      setShowEditModal(true)
    } catch {
      // Ignore errors
    }
  }

  const handleDeleteAgent = async (id: string) => {
    await deleteAgent(id)
    setEditingAgent(null)
    if (selectedAgent?.id === id) navigate('/agents')
  }

  const handleModelChange = useCallback(async (agentId: string, modelId: string, providerId: string) => {
    try {
      await updateAgent(agentId, { model: modelId, providerId: providerId || null })
    } catch {
      // Ignore errors
    }
  }, [updateAgent])

  const selectedAgent = agents.find((k) => k.slug === selectedAgentSlug)

  // Fetch context usage when selecting an agent so the token counter is populated immediately
  useEffect(() => {
    if (selectedAgent?.id) {
      fetchContextUsage(selectedAgent.id)
    }
  }, [selectedAgent?.id, fetchContextUsage])

  // Dynamic browser tab title — shows selected Agent name + processing state
  const selectedAgentProcessing = selectedAgent
    ? agentQueueState.get(selectedAgent.id)?.isProcessing ?? false
    : false
  const unreadCount = useUnreadWhileHidden(selectedAgent?.id ?? null)
  const { unreadCounts: unreadPerAgent, clearUnread: clearAgentUnread } = useUnreadPerAgent(selectedAgent?.id ?? null)
  useDocumentTitle(selectedAgent?.name, selectedAgentProcessing, unreadCount)
  useFaviconBadge(unreadCount)

  // Global keyboard shortcuts for agent navigation & actions
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return

      // Cmd/Ctrl + 1-9 → switch to agent by index
      const digit = parseInt(e.key, 10)
      if (digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
        const agent = agents[digit - 1]
        if (agent) {
          e.preventDefault()
          navigate(`/agent/${agent.slug}`)
        }
        return
      }

      // Cmd/Ctrl + Shift + N → create new agent
      if (e.key.toLowerCase() === 'n' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        handleOpenCreateModal()
        return
      }

      // Cmd/Ctrl + , → open settings
      if (e.key === ',' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        handleOpenSettings()
        return
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [agents, navigate, handleOpenSettings])

  // The shadcn SidebarProvider wrapper defaults to `min-h-svh` (full viewport
  // height). We're now inside an AuthenticatedShell with an AppTopBar above
  // us, so the available height is `100vh - topbar`. Override the wrapper's
  // min-h-svh to `h-full min-h-0` so it matches its parent (the page slot below
  // AppTopBar). Without this, the wrapper overflows the viewport and the agent's
  // header gets pushed past the bottom.
  // `transform: translateZ(0)` turns this wrapper into the containing block for
  // the shadcn Sidebar's `position: fixed` (cf. ui/sidebar.tsx:260) so it anchors
  // to the chat content area instead of the viewport. Scoped to ChatPage only:
  // applying it higher (App.tsx) would also hijack @dnd-kit's DragOverlay
  // (position: fixed) and offset the drag ghost.
  return (
    <div className="h-full overflow-hidden" style={{ transform: 'translateZ(0)' }}>
    <SidebarProvider className="!min-h-0 !h-full">
      <AppSidebar
        selectedAgentId={selectedAgent?.id ?? null}
        agents={agents}
        llmModels={llmModels}
        selectedAgentSlug={selectedAgentSlug}
        unavailableAgentIds={unavailableAgentIds}
        agentQueueState={agentQueueState}
        unreadCounts={unreadPerAgent}
        onSelectAgent={handleSelectAgent}
        onCreateAgent={handleOpenCreateModal}
        onEditAgent={handleOpenEditModal}
        onDeleteAgent={handleDeleteAgent}
        onReorderAgents={reorderAgents}
        onOpenSettings={handleOpenSettings}
      />

      <SidebarInset className="min-h-0">
        {/* `overflow-x-hidden` keeps the row from ever forcing page-wide
            horizontal scroll on narrow viewports. On mobile the detail panel
            (MiniAppViewer) renders as a fullscreen Sheet overlay instead of an
            inline column, so the conversation below gets the full width; the
            inline fixed-width column only participates at >= 768px. */}
        <div className="flex h-full min-h-0 overflow-x-hidden">
        <div className="flex h-full min-w-0 min-h-0 flex-1 flex-col">
          {/* An open conversation hosts the sidebar toggle in its own header. */}
          {!selectedAgent && <div className="hidden h-10 shrink-0 items-center border-b px-2 md:flex">
            <SidebarTrigger />
          </div>}

          {/* Connection lost banner */}

          {/* Onboarding progress banner removed alongside the Hub Agent
              concept — the per-step banner mapped 1:1 to 'create hub'
              / 'create specialist' which are no longer distinct. The
              full setup checklist below replaces the per-step nudge. */}

          {showOnboardingModal && configuratorAgent && user?.role === 'admin' && (
            <div className="flex flex-wrap items-center gap-3 border-b bg-primary/5 px-4 py-3">
              <Sparkles className="size-4 text-primary" />
              <p className="min-w-0 flex-1 text-sm">{t('experience.onboarding.guidance', 'Queenie can help you create your first Agent. Continue in her conversation whenever you are ready.')}</p>
              <Button size="sm" onClick={() => navigate(`/agent/${configuratorAgent.slug}`)}>{t('experience.onboarding.openQueenie', 'Talk to Queenie')}</Button>
              <Button size="sm" variant="ghost" onClick={dismissOnboardingModal}>{t('experience.onboarding.dismiss', 'I will explore on my own')}</Button>
            </div>
          )}

          {/* Page content */}
          <Routes>
            <Route
              path="*"
              element={
                selectedAgent ? (
                  <ChatPanel
                    key={selectedAgent.id}
                    agent={{
                      id: selectedAgent.id,
                      name: selectedAgent.name,
                      role: selectedAgent.role,
                      model: selectedAgent.model,
                      providerId: selectedAgent.providerId ?? null,
                      avatarUrl: selectedAgent.avatarUrl,
                      thinkingEnabled: selectedAgent.thinkingEnabled,
                      thinkingEffort: selectedAgent.thinkingEffort,
                    }}
                    llmModels={llmModels}
                    modelUnavailable={unavailableAgentIds.has(selectedAgent.id)}
                    queueState={agentQueueState.get(selectedAgent.id)}
                    onModelChange={(modelId, providerId) => handleModelChange(selectedAgent.id, modelId, providerId)}
                    onEditAgent={(opts) => handleOpenEditModal(undefined, opts?.initialTab)}
                    onOpenSettings={handleOpenSettings}
                  />
                ) : (
                  /* `m-auto` on the child centers vertically when content
                     fits; on short viewports the child overflows and the
                     parent's `overflow-y-auto` lets the user scroll. Using
                     `justify-center` here would clip the top of overflowing
                     content (no way to scroll up). */
                  <div className="surface-chat relative flex flex-1 flex-col items-center overflow-y-auto p-6">
                    {/* Mobile sidebar trigger — the standalone trigger bar is
                        hidden on mobile, so without this the user has no way to
                        open the sidebar and pick an Agent from the placeholder. */}
                    <div className="absolute left-2 top-2 md:hidden">
                      <SidebarTrigger />
                    </div>
                    {!initialDataLoaded ? (
                      /* Still loading agents/models — render nothing rather than
                         flashing the onboarding checklist for a few hundred ms. */
                      null
                    ) : !onboardingComplete ? (
                      /* ── Onboarding not finished: show full setup checklist ── */
                      <div className="m-auto w-full max-w-md">
                        <SetupChecklist
                          variant="inline"
                          onCreateAgent={handleOpenCreateModal}
                          onOpenSettings={handleOpenSettings}
                        />
                      </div>
                    ) : (
                      /* ── Onboarding done, no Agent selected ── */
                      <div className="m-auto text-center animate-fade-in-up space-y-4">
                        <div className="mx-auto mb-2 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
                          <Bot className="size-8 text-primary" />
                        </div>
                        <p className="text-muted-foreground">
                          {t('chat.selectAgent')}
                        </p>
                        <div className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground/60">
                          <div className="flex items-center gap-1.5">
                            <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">
                              <Command className="size-2.5" />K
                            </kbd>
                            <span>{t('chat.shortcutHint')}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <kbd className="inline-flex items-center rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]">
                              ?
                            </kbd>
                            <span>{t('chat.shortcutsHint')}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              }
            />
          </Routes>
        </div>
        {/* Side panel (task / mini-app) — mounted at page level so
            it works even when no Agent is selected (selecting a task from the
            sidebar still opens its detail view). */}
        {panelOpen && <Suspense fallback={null}>
          <MiniAppViewer />
        </Suspense>}
        </div>
      </SidebarInset>

      {/* Lazy-loaded modals */}
      <Suspense fallback={null}>
        {/* Create Agent modal */}
        {showCreateModal && user?.role === 'admin' && (
          <AgentFormModal
            open={showCreateModal}
            onOpenChange={setShowCreateModal}
            llmModels={llmModels}
            imageModels={imageModels}
            onCreateAgent={async (data) => {
              const created = await createAgent(data)
              navigate(`/agent/${created.slug}`)
              return created
            }}
            onUpdateAgent={updateAgent}
            onUploadAvatar={uploadAvatar}
            onGenerateAvatarPreview={generateAvatarPreview}
            onGenerateAgentConfig={generateAgentConfig}
            onGenerateAvatarPreviewFromConfig={generateAvatarPreviewFromConfig}
            hasImageCapability={hasImageCapability}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* Edit Agent modal */}
        {showEditModal && (
          <AgentFormModal
            open={showEditModal}
            onOpenChange={setShowEditModal}
            initialTab={editInitialTab}
            llmModels={llmModels}
            imageModels={imageModels}
            agent={editingAgent}
            onUpdateAgent={updateAgent}
            onDeleteAgent={handleDeleteAgent}
            onUploadAvatar={uploadAvatar}
            onGenerateAvatarPreview={generateAvatarPreview}
            hasImageCapability={hasImageCapability}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* Account + Settings modals are now mounted at App.tsx root (AuthenticatedShell) */}
      </Suspense>

      {/* Keyboard shortcuts help (?) */}
      <KeyboardShortcutsDialog />

      {/* Real-time status change notifications */}
      <StatusNotifications />
    </SidebarProvider>
    </div>
  )
}
