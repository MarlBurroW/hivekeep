import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api, getErrorMessage, ApiRequestError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { useVersionCheck } from '@/client/hooks/useVersionCheck'
import type { UpdateChannel, UpdateRunInfo, VersionInfo } from '@/shared/types'

interface StartUpdateOptions {
  channel: UpdateChannel
  toVersion: string
}

interface UpdateContextValue {
  // ── Availability (shared, single source for the whole app) ──
  /** Latest version-check result (null until first load). */
  versionInfo: VersionInfo | null
  /** True when an update is available on the active channel. */
  isUpdateAvailable: boolean
  isLoading: boolean
  isChecking: boolean
  /** Force a fresh check against GitHub. */
  forceCheck: () => Promise<VersionInfo | undefined>
  refetch: () => Promise<void>
  /** Open the shared "update available" dialog (changelog + actions). */
  openUpdateDialog: () => void
  /** Controlled open-state of the shared dialog (read by GlobalUpdateDialog). */
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void

  // ── Active self-update run (full-screen overlay) ──
  /** The active run, or null when no update overlay should show. */
  run: UpdateRunInfo | null
  /** Kick off a self-update. Shows the full-screen overlay immediately. */
  startUpdate: (opts: StartUpdateOptions) => Promise<void>
  /** Dismiss a finished (failed / rolled-back) overlay. No-op while running. */
  dismiss: () => void
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

/** Hook for triggering and observing the platform self-update. */
export function useUpdate(): UpdateContextValue {
  const ctx = useContext(UpdateContext)
  if (!ctx) throw new Error('useUpdate must be used within an UpdateProvider')
  return ctx
}

const POLL_INTERVAL_MS = 1500

function isTerminal(status: UpdateRunInfo['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'rolled-back'
}

/**
 * Drives the platform self-update overlay.
 *
 * The journal (`GET /version-check/last-update`) is the source of truth — we
 * POLL it rather than relying on SSE `update:progress` events, because the
 * orchestrator blocks the event loop during the long steps (bun install,
 * build) and a freshly-mounted client subscribes too late to see the early
 * events. Polling `currentStep` is immune to that and also survives the
 * server restart (the SSE connection dies with the old process). SSE is used
 * only to pop the overlay up promptly on other tabs/devices.
 */
export function UpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  // Single app-wide version-check instance: the sidebar badge, the top-bar
  // indicator and the settings page all read from this one source.
  const { versionInfo, isLoading, isChecking, forceCheck, refetch } = useVersionCheck()
  const [dialogOpen, setDialogOpen] = useState(false)
  const openUpdateDialog = useCallback(() => setDialogOpen(true), [])

  const [run, setRun] = useState<UpdateRunInfo | null>(null)
  // Latch so the overlay stays mounted (and keeps polling) even if a GET fails
  // mid-restart and momentarily returns no run.
  const activeRef = useRef(false)
  const reloadingRef = useRef(false)

  const active = run !== null

  const handleTerminal = useCallback((finished: UpdateRunInfo) => {
    setRun(finished)
    activeRef.current = false
    if (finished.status === 'success' && !reloadingRef.current) {
      reloadingRef.current = true
      // The frontend assets changed under us — reload onto the new build.
      setTimeout(() => window.location.reload(), 2500)
    }
  }, [])

  const startUpdate = useCallback(
    async ({ channel, toVersion }: StartUpdateOptions) => {
      if (activeRef.current) return
      activeRef.current = true
      // Optimistic: show the overlay the instant the button is clicked, before
      // the POST resolves — no "I clicked and nothing happened" gap.
      setRun({
        id: '',
        channel,
        fromVersion: '',
        fromSha: null,
        toVersion,
        status: 'running',
        currentStep: 'preflight',
        error: null,
        startedAt: Date.now(),
        finishedAt: null,
      })

      try {
        await api.post<{ runId: string }>('/version-check/update')
        // Progress now flows in through the poller below.
      } catch (err) {
        // An update already running is fine — the poller will sync to it.
        if (err instanceof ApiRequestError && err.code === 'UPDATE_IN_PROGRESS') return
        // A real rejection (not admin, docker, dev mode, no update): tear the
        // overlay down and surface the reason.
        activeRef.current = false
        setRun(null)
        toast.error(t('updateAvailable.updateFailed'), { description: getErrorMessage(err) })
      }
    },
    [t],
  )

  const dismiss = useCallback(() => {
    if (run && !isTerminal(run.status)) return
    setRun(null)
  }, [run])

  // On mount, adopt an update that's already in flight (page reloaded
  // mid-update, or another admin started one). A terminal journal is ignored.
  useEffect(() => {
    let cancelled = false
    api
      .get<{ run: UpdateRunInfo | null }>('/version-check/last-update')
      .then(({ run: existing }) => {
        if (cancelled || !existing) return
        if (existing.status === 'running' || existing.status === 'restarting') {
          activeRef.current = true
          setRun(existing)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Pop the overlay up on other tabs/devices as soon as an update starts.
  useSSE({
    'update:progress': () => {
      if (activeRef.current) return
      activeRef.current = true
      api
        .get<{ run: UpdateRunInfo | null }>('/version-check/last-update')
        .then(({ run: existing }) => {
          if (existing && !isTerminal(existing.status)) setRun(existing)
          else activeRef.current = false
        })
        .catch(() => {})
    },
  })

  // Poll the journal while the overlay is active — the resilient source of
  // truth for step progress and the terminal outcome.
  useEffect(() => {
    if (!active) return
    let stopped = false
    const tick = async () => {
      if (stopped || !activeRef.current) return
      try {
        const { run: latest } = await api.get<{ run: UpdateRunInfo | null }>(
          '/version-check/last-update',
        )
        if (stopped || !latest) return
        if (isTerminal(latest.status)) handleTerminal(latest)
        else setRun(latest)
      } catch {
        // Server is restarting — keep the overlay up and keep polling.
      }
    }
    const interval = setInterval(tick, POLL_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [active, handleTerminal])

  return (
    <UpdateContext.Provider
      value={{
        versionInfo: versionInfo ?? null,
        isUpdateAvailable: versionInfo?.isUpdateAvailable === true,
        isLoading,
        isChecking,
        forceCheck,
        refetch,
        openUpdateDialog,
        dialogOpen,
        setDialogOpen,
        run,
        startUpdate,
        dismiss,
      }}
    >
      {children}
    </UpdateContext.Provider>
  )
}
