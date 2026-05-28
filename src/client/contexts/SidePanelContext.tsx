import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { useSSE } from '@/client/hooks/useSSE'

type ActiveTab = 'mini-app' | 'task' | 'ticket'

/** Lightweight reference to a parent entity, used for back-navigation in the side panel.
 *  E.g. opening a task from a ticket sets `parent: { type: 'ticket', id }` so the
 *  panel shows a "← Back to ticket" button. Depth 1 max. */
export interface SidePanelParentRef {
  type: 'task' | 'ticket'
  id: string
}

interface TaskPanelInfo {
  taskId: string
  kinName?: string
  kinAvatarUrl?: string | null
  parent?: SidePanelParentRef
}

interface TicketPanelInfo {
  ticketId: string
  parent?: SidePanelParentRef
}

interface SidePanelContextValue {
  // Panel state
  panelOpen: boolean
  activeTab: ActiveTab | null

  // Mini-app state
  activeAppId: string | null
  activeAppVersion: number
  /** Bumped on a `miniapp:reload` SSE event to force the active iframe to reload. */
  activeAppReloadSignal: number
  isFullPage: boolean
  customTitle: string | null
  badges: Record<string, string>

  // Task state
  activeTask: TaskPanelInfo | null

  // Ticket state
  activeTicket: TicketPanelInfo | null

  // Mini-app actions
  openApp: (appId: string) => void
  closePanel: () => void
  toggleFullPage: () => void
  setFullPage: (value: boolean) => void
  setCustomTitle: (title: string | null) => void
  setBadge: (appId: string, value: string | null) => void

  // Task actions
  openTask: (info: TaskPanelInfo) => void
  closeTask: () => void

  // Ticket actions
  openTicket: (info: TicketPanelInfo) => void
  closeTicket: () => void

  // Tab switching
  switchTab: (tab: ActiveTab) => void
}

const SidePanelContext = createContext<SidePanelContextValue | null>(null)

export function SidePanelProvider({ children }: { children: ReactNode }) {
  const [activeAppId, setActiveAppId] = useState<string | null>(null)
  const [activeAppVersion, setActiveAppVersion] = useState(0)
  const [activeAppReloadSignal, setActiveAppReloadSignal] = useState(0)
  const [isFullPage, setIsFullPage] = useState(false)
  const [customTitle, setCustomTitle] = useState<string | null>(null)
  const [badges, setBadgesState] = useState<Record<string, string>>({})
  const [activeTab, setActiveTab] = useState<ActiveTab | null>(null)
  const [activeTask, setActiveTask] = useState<TaskPanelInfo | null>(null)
  const [activeTicket, setActiveTicket] = useState<TicketPanelInfo | null>(null)

  const openApp = useCallback((appId: string) => {
    setActiveAppId(appId)
    setActiveAppVersion((v) => v + 1)
    setCustomTitle(null)
    setActiveTab('mini-app')
  }, [])

  const openTask = useCallback((info: TaskPanelInfo) => {
    setActiveTask(info)
    setActiveTab('task')
    // Exit full page mode if switching to task
    setIsFullPage(false)
  }, [])

  const closeTask = useCallback(() => {
    setActiveTask(null)
    // Fall back to the next available tab, in priority order: ticket → mini-app → none
    if (activeTicket) setActiveTab('ticket')
    else if (activeAppId) setActiveTab('mini-app')
    else setActiveTab(null)
  }, [activeAppId, activeTicket])

  const openTicket = useCallback((info: TicketPanelInfo) => {
    setActiveTicket(info)
    setActiveTab('ticket')
    setIsFullPage(false)
  }, [])

  const closeTicket = useCallback(() => {
    setActiveTicket(null)
    // Fall back to the next available tab, in priority order: task → mini-app → none
    if (activeTask) setActiveTab('task')
    else if (activeAppId) setActiveTab('mini-app')
    else setActiveTab(null)
  }, [activeAppId, activeTask])

  const closePanel = useCallback(() => {
    // Close whichever tab is active, then fall back to the next available one.
    // Priority order: mini-app → task → ticket → null
    if (activeTab === 'mini-app') {
      setActiveAppId(null)
      setIsFullPage(false)
      setCustomTitle(null)
      if (activeTask) setActiveTab('task')
      else if (activeTicket) setActiveTab('ticket')
      else setActiveTab(null)
    } else if (activeTab === 'task') {
      setActiveTask(null)
      if (activeTicket) setActiveTab('ticket')
      else if (activeAppId) setActiveTab('mini-app')
      else setActiveTab(null)
    } else if (activeTab === 'ticket') {
      setActiveTicket(null)
      if (activeTask) setActiveTab('task')
      else if (activeAppId) setActiveTab('mini-app')
      else setActiveTab(null)
    } else {
      // Close everything
      setActiveAppId(null)
      setActiveTask(null)
      setActiveTicket(null)
      setIsFullPage(false)
      setCustomTitle(null)
      setActiveTab(null)
    }
  }, [activeTab, activeTask, activeTicket, activeAppId])

  const toggleFullPage = useCallback(() => {
    setIsFullPage((v) => !v)
  }, [])

  const setFullPage = useCallback((value: boolean) => {
    setIsFullPage(value)
  }, [])

  const switchTab = useCallback((tab: ActiveTab) => {
    if (tab === 'mini-app' && activeAppId) {
      setActiveTab('mini-app')
    } else if (tab === 'task' && activeTask) {
      setActiveTab('task')
    } else if (tab === 'ticket' && activeTicket) {
      setActiveTab('ticket')
    }
  }, [activeAppId, activeTask, activeTicket])

  const setBadge = useCallback((appId: string, value: string | null) => {
    setBadgesState((prev) => {
      if (value === null) {
        const next = { ...prev }
        delete next[appId]
        return next
      }
      return { ...prev, [appId]: value }
    })
  }, [])

  // Listen for file updates to reload the active app's iframe
  useSSE({
    'miniapp:file-updated': (data) => {
      const appId = data.appId as string
      const version = data.version as number
      if (appId === activeAppId) {
        setActiveAppVersion(version)
      }
    },
    'miniapp:reload': (data) => {
      const appId = data.appId as string
      if (appId === activeAppId) {
        setActiveAppReloadSignal((n) => n + 1)
      }
    },
    'miniapp:deleted': (data) => {
      const appId = data.appId as string
      if (appId === activeAppId) {
        setActiveAppId(null)
        setCustomTitle(null)
        setIsFullPage(false)
        if (activeTask) {
          setActiveTab('task')
        } else {
          setActiveTab(null)
        }
      }
      // Clean up badge for deleted app
      setBadge(appId, null)
    },
  })

  const panelOpen = activeTab !== null && (
    (activeTab === 'mini-app' && activeAppId !== null) ||
    (activeTab === 'task' && activeTask !== null) ||
    (activeTab === 'ticket' && activeTicket !== null)
  )

  return (
    <SidePanelContext.Provider
      value={{
        panelOpen,
        activeTab,
        activeAppId,
        activeAppVersion,
        activeAppReloadSignal,
        isFullPage,
        customTitle,
        badges,
        activeTask,
        activeTicket,
        openApp,
        closePanel,
        toggleFullPage,
        setFullPage,
        setCustomTitle,
        setBadge,
        openTask,
        closeTask,
        openTicket,
        closeTicket,
        switchTab,
      }}
    >
      {children}
    </SidePanelContext.Provider>
  )
}

export function useSidePanel() {
  const ctx = useContext(SidePanelContext)
  if (!ctx) {
    throw new Error('useSidePanel must be used within a SidePanelProvider')
  }
  return ctx
}
