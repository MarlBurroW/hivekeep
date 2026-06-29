import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { lazy, Suspense } from 'react'
import { api } from '@/client/lib/api'
import { useAuth } from '@/client/hooks/useAuth'

const FeedbackDialog = lazy(() =>
  import('@/client/components/feedback/FeedbackDialog').then((m) => ({ default: m.FeedbackDialog })),
)

interface FeedbackStateView {
  enabled: boolean
  shouldPrompt: boolean
  starred: boolean
  githubUrl: string
}

interface FeedbackContextValue {
  /** Feature configured on this instance (endpoint set). */
  enabled: boolean
  /** The proactive banner should be shown right now. */
  shouldPrompt: boolean
  /** User already clicked the GitHub star CTA. */
  starred: boolean
  githubUrl: string
  /** Open the written-feedback dialog (the always-available entry point). */
  open: () => void
  /** Record the star click and open GitHub in a new tab. */
  star: () => void
  /** "Later" — hide the banner for a while. */
  snooze: () => void
  /** "Don't ask again" — hide the banner permanently. */
  dismiss: () => void
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null)

const DEFAULT_STATE: FeedbackStateView = {
  enabled: false,
  shouldPrompt: false,
  starred: false,
  githubUrl: 'https://github.com/pgun/gezy',
}

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [state, setState] = useState<FeedbackStateView>(DEFAULT_STATE)
  const [dialogOpen, setDialogOpen] = useState(false)

  const refresh = useCallback(() => {
    if (!user) return
    api
      .get<FeedbackStateView>('/feedback/state')
      .then(setState)
      .catch(() => {
        /* feature stays disabled on error — never block the app for feedback */
      })
  }, [user])

  useEffect(() => {
    refresh()
  }, [refresh])

  const patch = useCallback((action: 'snooze' | 'dismiss' | 'starred' | 'shown') => {
    api
      .patch<FeedbackStateView>('/feedback/state', { action })
      .then(setState)
      .catch(() => {})
  }, [])

  const open = useCallback(() => setDialogOpen(true), [])

  const star = useCallback(() => {
    // Optimistic: flip locally so the banner CTA updates instantly.
    setState((s) => ({ ...s, starred: true, shouldPrompt: false }))
    patch('starred')
    window.open(state.githubUrl, '_blank', 'noopener,noreferrer')
  }, [patch, state.githubUrl])

  const snooze = useCallback(() => {
    setState((s) => ({ ...s, shouldPrompt: false }))
    patch('snooze')
  }, [patch])

  const dismiss = useCallback(() => {
    setState((s) => ({ ...s, shouldPrompt: false }))
    patch('dismiss')
  }, [patch])

  // Record that the banner was shown (telemetry / pacing), once per eligibility.
  useEffect(() => {
    if (state.shouldPrompt) patch('shown')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.shouldPrompt])

  const value: FeedbackContextValue = {
    enabled: state.enabled,
    shouldPrompt: state.shouldPrompt,
    starred: state.starred,
    githubUrl: state.githubUrl,
    open,
    star,
    snooze,
    dismiss,
  }

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      {dialogOpen && (
        <Suspense fallback={null}>
          <FeedbackDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            onSubmitted={() => {
              // A submission counts as engagement: stop nagging.
              setState((s) => ({ ...s, shouldPrompt: false }))
            }}
          />
        </Suspense>
      )}
    </FeedbackContext.Provider>
  )
}

export function useFeedback(): FeedbackContextValue {
  const ctx = useContext(FeedbackContext)
  if (!ctx) throw new Error('useFeedback must be used within a FeedbackProvider')
  return ctx
}
