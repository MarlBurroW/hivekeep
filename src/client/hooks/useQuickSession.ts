import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import { useAuth } from '@/client/hooks/useAuth'
import type { QuickSessionSummary } from '@/shared/types'

function readPanel(key: string | null): { sessionId?: string; open?: boolean } {
  try { return key ? JSON.parse(sessionStorage.getItem(key) ?? '{}') : {} } catch { return {} }
}

export function useQuickSession(agentId: string | null) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const key = agentId && user ? `hivekeep:quick-panel:${user.id}:${agentId}` : null
  const keyRef = useRef(key)
  keyRef.current = key
  const [activeSession, setActiveSession] = useState<QuickSessionSummary | null>(null)
  const [isOpen, setOpenState] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const creating = useRef(false)

  const remember = useCallback((sessionId: string | undefined, open: boolean) => {
    try { if (key) sessionStorage.setItem(key, JSON.stringify({ sessionId, open })) } catch { /* optional */ }
  }, [key])
  const setIsOpen = useCallback((open: boolean) => {
    setOpenState(open)
    remember(activeSession?.id, open)
  }, [activeSession?.id, remember])

  const fetchSessions = useCallback(async () => {
    if (!agentId || !key) return
    try {
      const data = await api.get<{ sessions: QuickSessionSummary[] }>(`/agents/${agentId}/quick-sessions`)
      if (keyRef.current !== key) return
      const saved = readPanel(key)
      const restored = data.sessions.find((session) => session.id === saved.sessionId) ?? data.sessions[0] ?? null
      setActiveSession(restored)
      setOpenState(!!restored && saved.open === true && restored.id === saved.sessionId)
    } catch {
      if (keyRef.current === key) toast.error(t('quickSession.errors.fetchFailed', 'Failed to load quick sessions'))
    }
  }, [agentId, key, t])

  useEffect(() => {
    setActiveSession(null)
    setOpenState(false)
    void fetchSessions()
  }, [fetchSessions])
  useSSEResync(() => { void fetchSessions() })

  const createSession = useCallback(async (title?: string) => {
    if (!agentId || creating.current) return null
    creating.current = true
    setIsCreating(true)
    try {
      const session = await api.post<QuickSessionSummary>(`/agents/${agentId}/quick-sessions`, { title })
      remember(session.id, true)
      if (keyRef.current === key) {
        setActiveSession(session)
        setOpenState(true)
      }
      return session
    } catch {
      toast.error(t('quickSession.errors.createFailed', 'Failed to create quick session'))
      return null
    } finally {
      creating.current = false
      if (keyRef.current === key) setIsCreating(false)
    }
  }, [agentId, key, remember, t])

  const closeSession = useCallback(async (sessionId: string, saveMemory?: boolean, memorySummary?: string) => {
    try {
      await api.post(`/quick-sessions/${sessionId}/close`, { saveMemory, memorySummary })
      remember(undefined, false)
      if (keyRef.current === key) {
        setActiveSession(null)
        setOpenState(false)
      }
    } catch {
      toast.error(t('quickSession.errors.closeFailed', 'Failed to close session. Please try again.'))
    }
  }, [key, remember, t])

  useSSE({
    'quick-session:closed': (data) => {
      if (activeSession && data.sessionId === activeSession.id) {
        setActiveSession(null)
        setOpenState(false)
        remember(undefined, false)
      }
    },
  })

  return { activeSession, isOpen, setIsOpen, isCreating, createSession, closeSession }
}
