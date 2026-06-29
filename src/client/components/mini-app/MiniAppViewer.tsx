import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { Button } from '@/client/components/ui/button'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/client/components/ui/alert-dialog'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/client/components/ui/sheet'
import { VisuallyHidden } from 'radix-ui'
import { useIsMobile } from '@/client/hooks/use-mobile'
import { X, RotateCw, Maximize2, Minimize2, Sparkles, Wand2, Loader2, AlertTriangle, ClipboardList, ShieldAlert } from 'lucide-react'
import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/client/lib/lazy-with-retry'
import { api, getErrorMessage } from '@/client/lib/api'
const TaskPanelContent = lazy(() => import('@/client/components/sidebar/TaskPanelContent').then(m => ({ default: m.TaskPanelContent })))
const TicketPanelContent = lazy(() => import('@/client/components/sidebar/TicketPanelContent').then(m => ({ default: m.TicketPanelContent })))
import { toast } from 'sonner'
import { useAuth } from '@/client/hooks/useAuth'
import type { MiniAppSummary } from '@/shared/types'

/** Rate limiter for sendMessage: max 5 messages per 30 seconds per app */
const messageCooldowns = new Map<string, number[]>()

/** Console entries from mini-app iframes, keyed by appId */
export interface MiniAppConsoleEntry {
  level: 'log' | 'warn' | 'error'
  args: string[]
  stack: string | null
  timestamp: number
}
const consoleBuffers = new Map<string, MiniAppConsoleEntry[]>()
const CONSOLE_BUFFER_MAX = 50

/** Get console entries for a specific app (used by tools via window.__gezy_getConsole) */
function getConsoleEntries(appId: string): MiniAppConsoleEntry[] {
  return consoleBuffers.get(appId) ?? []
}

// Expose globally so the server-side tool can read console entries via SSE/API
;(window as unknown as Record<string, unknown>).__gezy_getConsole = getConsoleEntries

export function MiniAppViewer() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isMobile = useIsMobile()
  const { panelOpen, activeAppId, activeAppVersion, activeAppReloadSignal, isFullPage, customTitle, openApp, closePanel, toggleFullPage, setFullPage, setCustomTitle, setBadge } = useSidePanel()
  const [app, setApp] = useState<MiniAppSummary | null>(null)
  const [iframeKey, setIframeKey] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const pendingShareData = useRef<unknown>(null)

  // Dialog state for confirm/prompt
  const [dialog, setDialog] = useState<{
    type: 'confirm' | 'prompt'
    callbackId: string
    message: string
    title: string
    confirmLabel: string
    cancelLabel: string
    variant?: 'default' | 'destructive'
    placeholder?: string
    defaultValue?: string
  } | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [generatingIcon, setGeneratingIcon] = useState(false)
  const [errorCount, setErrorCount] = useState(0)

  const sendDialogResult = useCallback((callbackId: string, value: unknown) => {
    if (!iframeRef.current?.contentWindow) return
    iframeRef.current.contentWindow.postMessage({
      source: 'gezy-parent',
      type: 'dialog-result',
      callbackId,
      value,
    }, '*')
  }, [])

  const handleGenerateIcon = useCallback(async () => {
    if (!app || generatingIcon) return
    setGeneratingIcon(true)
    try {
      const data = await api.post<{ app: MiniAppSummary }>(`/mini-apps/${app.id}/generate-icon`, {})
      setApp(data.app)
      toast.success(t('miniApps.icon.generated'))
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('miniApps.icon.error')
      toast.error(msg)
    } finally {
      setGeneratingIcon(false)
    }
  }, [app, generatingIcon, t])

  // Fetch app details when activeAppId changes
  useEffect(() => {
    if (!activeAppId) {
      setApp(null)
      setErrorCount(0)
      return
    }
    setErrorCount(0)
    let cancelled = false
    api.get<{ app: MiniAppSummary }>(`/mini-apps/${activeAppId}`).then((data) => {
      if (!cancelled) setApp(data.app)
    }).catch(() => {
      if (!cancelled) setApp(null)
    })
    return () => { cancelled = true }
  }, [activeAppId])

  // Capability permissions: backends may request access (app.json "permissions")
  // that the user has to approve before the matching ctx capabilities work.
  const [permissions, setPermissions] = useState<{ requested: string[]; granted: string[]; missing: string[] } | null>(null)
  const [granting, setGranting] = useState(false)

  useEffect(() => {
    setPermissions(null)
    if (!activeAppId || !app?.hasBackend) return
    let cancelled = false
    api.get<{ requested: string[]; granted: string[]; missing: string[] }>(`/mini-apps/${activeAppId}/permissions`)
      .then((data) => { if (!cancelled) setPermissions(data) })
      .catch(() => { if (!cancelled) setPermissions(null) })
    return () => { cancelled = true }
  }, [activeAppId, app?.hasBackend, app?.version])

  const handleGrantPermissions = useCallback(async () => {
    if (!activeAppId || !permissions || permissions.missing.length === 0 || granting) return
    setGranting(true)
    try {
      const result = await api.post<{ requested: string[]; granted: string[] }>(
        `/mini-apps/${activeAppId}/permissions`,
        { grant: permissions.missing },
      )
      setPermissions({
        requested: result.requested,
        granted: result.granted,
        missing: result.requested.filter((p) => !result.granted.includes(p)),
      })
      toast.success(t('miniApps.permissions.granted'))
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setGranting(false)
    }
  }, [activeAppId, permissions, granting, t])

  // Reload iframe when version changes
  useEffect(() => {
    if (activeAppVersion > 0) {
      setIframeKey((k) => k + 1)
    }
  }, [activeAppVersion])

  // Force-reload iframe on an explicit reload_mini_app request
  useEffect(() => {
    if (activeAppReloadSignal > 0) {
      setIframeKey((k) => k + 1)
    }
  }, [activeAppReloadSignal])

  // Send app metadata to iframe when it loads
  const sendAppMeta = useCallback(() => {
    if (!iframeRef.current?.contentWindow || !app) return
    iframeRef.current.contentWindow.postMessage({
      source: 'gezy-parent',
      type: 'app-meta',
      data: {
        id: app.id,
        name: app.name,
        slug: app.slug,
        description: app.description,
        icon: app.icon,
        agentId: app.maintainerAgentId,
        agentName: app.maintainerAgentName,
        agentAvatarUrl: app.maintainerAgentAvatarUrl,
        version: app.version,
        isFullPage,
        locale: i18n.language,
        user: user ? {
          id: user.id,
          name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.pseudonym,
          pseudonym: user.pseudonym,
          locale: user.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          avatarUrl: user.avatarUrl,
        } : null,
      },
    }, '*')
  }, [app, isFullPage, i18n.language, user])

  // Push the current theme to the iframe. The iframe runs at an opaque origin
  // (no allow-same-origin) so it CAN'T read parent.document — we read our own
  // documentElement (legit) and postMessage it. Sent on 'ready' and on change.
  const sendTheme = useCallback(() => {
    if (!iframeRef.current?.contentWindow) return
    const r = document.documentElement
    iframeRef.current.contentWindow.postMessage({
      source: 'gezy-parent',
      type: 'theme',
      data: {
        dark: r.classList.contains('dark'),
        palette: r.getAttribute('data-palette'),
        contrast: r.getAttribute('data-contrast'),
      },
    }, '*')
  }, [])

  // Re-push theme whenever the app's theme/palette/contrast changes.
  useEffect(() => {
    const obs = new MutationObserver(() => sendTheme())
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-palette', 'data-contrast'] })
    return () => obs.disconnect()
  }, [sendTheme])

  // Notify iframe when full-page mode changes
  useEffect(() => {
    if (!iframeRef.current?.contentWindow) return
    iframeRef.current.contentWindow.postMessage({
      source: 'gezy-parent',
      type: 'fullpage-changed',
      data: { isFullPage },
    }, '*')
  }, [isFullPage])

  // Notify iframe when locale changes
  useEffect(() => {
    if (!iframeRef.current?.contentWindow) return
    iframeRef.current.contentWindow.postMessage({
      source: 'gezy-parent',
      type: 'locale-changed',
      data: { locale: i18n.language },
    }, '*')
  }, [i18n.language])

  // Handle postMessage from mini-app SDK
  useEffect(() => {
    function handleMessage(ev: MessageEvent) {
      const msg = ev.data
      if (!msg || msg.source !== 'gezy-sdk') return

      switch (msg.type) {
        case 'console': {
          const entry: MiniAppConsoleEntry = {
            level: msg.level as 'log' | 'warn' | 'error',
            args: Array.isArray(msg.args) ? msg.args.map(String) : [String(msg.args)],
            stack: msg.stack ? String(msg.stack) : null,
            timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
          }
          if (activeAppId) {
            const buf = consoleBuffers.get(activeAppId) ?? []
            buf.push(entry)
            if (buf.length > CONSOLE_BUFFER_MAX) buf.shift()
            consoleBuffers.set(activeAppId, buf)
            if (entry.level === 'error') {
              setErrorCount((c) => c + 1)
            }
            // Forward to server for Agent tool access
            fetch(`/api/mini-apps/${activeAppId}/console`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(entry),
            }).catch(() => { /* best effort */ })
          }
          break
        }
        case 'toast': {
          const text = String(msg.message || '').slice(0, 500)
          const toastType = msg.toastType as string
          if (toastType === 'success') toast.success(text)
          else if (toastType === 'error') toast.error(text)
          else if (toastType === 'warning') toast.warning(text)
          else toast.info(text)
          break
        }
        case 'navigate': {
          const path = String(msg.path || '/')
          // Only allow internal navigation (starts with /)
          if (path.startsWith('/')) navigate(path)
          break
        }
        case 'ready': {
          sendAppMeta()
          sendTheme()
          // Forward any pending shared data from another mini-app
          if (pendingShareData.current && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage({
              source: 'gezy-parent',
              type: 'shared-data',
              data: pendingShareData.current,
            }, '*')
            pendingShareData.current = null
          }
          break
        }
        case 'fullpage': {
          const requested = Boolean(msg.value)
          setFullPage(requested)
          break
        }
        case 'confirm': {
          setDialog({
            type: 'confirm',
            callbackId: String(msg.callbackId),
            message: String(msg.message || ''),
            title: String(msg.title || '') || t('miniApps.dialog.confirmTitle'),
            confirmLabel: String(msg.confirmLabel || '') || t('miniApps.dialog.confirm'),
            cancelLabel: String(msg.cancelLabel || '') || t('miniApps.dialog.cancel'),
            variant: msg.variant === 'destructive' ? 'destructive' : 'default',
          })
          break
        }
        case 'prompt': {
          const dv = String(msg.defaultValue || '')
          setPromptValue(dv)
          setDialog({
            type: 'prompt',
            callbackId: String(msg.callbackId),
            message: String(msg.message || ''),
            title: String(msg.title || '') || t('miniApps.dialog.promptTitle'),
            confirmLabel: String(msg.confirmLabel || '') || t('miniApps.dialog.ok'),
            cancelLabel: String(msg.cancelLabel || '') || t('miniApps.dialog.cancel'),
            placeholder: String(msg.placeholder || ''),
            defaultValue: dv,
          })
          break
        }
        case 'set-title': {
          const title = String(msg.title || '')
          setCustomTitle(title || null)
          break
        }
        case 'set-badge': {
          if (activeAppId) {
            setBadge(activeAppId, msg.value ?? null)
          }
          break
        }
        case 'clipboard-write': {
          const callbackId = String(msg.callbackId)
          const text = String(msg.text || '')
          navigator.clipboard.writeText(text)
            .then(() => {
              if (iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage({
                  source: 'gezy-parent',
                  type: 'dialog-result',
                  callbackId,
                  value: true,
                }, '*')
              }
            })
            .catch(() => {
              if (iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage({
                  source: 'gezy-parent',
                  type: 'dialog-result',
                  callbackId,
                  value: false,
                }, '*')
              }
            })
          break
        }
        case 'clipboard-read': {
          const cbId = String(msg.callbackId)
          navigator.clipboard.readText()
            .then((text) => {
              if (iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage({
                  source: 'gezy-parent',
                  type: 'dialog-result',
                  callbackId: cbId,
                  value: text,
                }, '*')
              }
            })
            .catch(() => {
              if (iframeRef.current?.contentWindow) {
                iframeRef.current.contentWindow.postMessage({
                  source: 'gezy-parent',
                  type: 'dialog-result',
                  callbackId: cbId,
                  value: null,
                }, '*')
              }
            })
          break
        }
        case 'open-app': {
          const slug = String(msg.slug || '')
          if (!slug || !app?.maintainerAgentId) break
          // Resolve slug to appId via API, then open
          api.get<{ app: MiniAppSummary }>(`/mini-apps/by-slug/${app.maintainerAgentId}/${encodeURIComponent(slug)}`)
            .then((data) => {
              if (data.app?.id) {
                openApp(data.app.id)
              } else {
                toast.error(t('miniApps.appNotFound', { slug }))
              }
            })
            .catch(() => {
              toast.error(t('miniApps.appNotFound', { slug }))
            })
          break
        }
        case 'share': {
          const targetSlug = String(msg.targetSlug || '')
          if (!targetSlug || !app?.maintainerAgentId) break
          const sharePayload = msg.shareData
          // Resolve target app, open it, and forward shared data once it's ready
          api.get<{ app: MiniAppSummary }>(`/mini-apps/by-slug/${app.maintainerAgentId}/${encodeURIComponent(targetSlug)}`)
            .then((data) => {
              if (data.app?.id) {
                pendingShareData.current = sharePayload
                openApp(data.app.id)
              } else {
                toast.error(t('miniApps.appNotFound', { slug: targetSlug }))
              }
            })
            .catch(() => {
              toast.error(t('miniApps.appNotFound', { slug: targetSlug }))
            })
          break
        }
        case 'resize': {
          const width = msg.width as number | undefined
          const height = msg.height as number | undefined
          // Clamp to reasonable bounds
          if (width !== undefined) {
            const clamped = Math.max(320, Math.min(1200, width))
            const panel = iframeRef.current?.closest('[class*="w-["]') as HTMLElement | null
            if (panel) panel.style.width = `${clamped}px`
          }
          // Height is only meaningful if we want to constrain the iframe itself
          if (height !== undefined) {
            const clamped = Math.max(200, Math.min(2000, height))
            if (iframeRef.current) iframeRef.current.style.maxHeight = `${clamped}px`
          }
          break
        }
        case 'download': {
          const callbackId = String(msg.callbackId)
          const filename = String(msg.filename || 'download')
          const b64Data = String(msg.data || '')
          const mimeType = String(msg.mimeType || 'application/octet-stream')
          if (!b64Data) {
            sendDialogResult(callbackId, false)
            break
          }
          try {
            // Decode base64 to binary
            const binary = atob(b64Data)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            const blob = new Blob([bytes], { type: mimeType })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = filename
            a.style.display = 'none'
            document.body.appendChild(a)
            a.click()
            // Cleanup
            setTimeout(() => {
              URL.revokeObjectURL(url)
              a.remove()
            }, 1000)
            sendDialogResult(callbackId, true)
          } catch {
            sendDialogResult(callbackId, false)
          }
          break
        }
        case 'notification': {
          const callbackId = String(msg.callbackId)
          const title = String(msg.title || '')
          const body = msg.body ? String(msg.body) : undefined
          if (!title) {
            sendDialogResult(callbackId, false)
            break
          }
          if ('Notification' in window && Notification.permission === 'granted') {
            try {
              new Notification(title, { body, icon: app?.icon ? undefined : undefined })
              sendDialogResult(callbackId, true)
            } catch {
              sendDialogResult(callbackId, false)
            }
          } else if ('Notification' in window && Notification.permission !== 'denied') {
            Notification.requestPermission().then((perm) => {
              if (perm === 'granted') {
                try {
                  new Notification(title, { body })
                  sendDialogResult(callbackId, true)
                } catch {
                  sendDialogResult(callbackId, false)
                }
              } else {
                sendDialogResult(callbackId, false)
              }
            })
          } else {
            sendDialogResult(callbackId, false)
          }
          break
        }
        case 'send-message': {
          const callbackId = String(msg.callbackId)
          const text = String(msg.text || '').trim()
          const silent = Boolean(msg.silent)

          if (!text || !app?.maintainerAgentId) {
            sendDialogResult(callbackId, false)
            break
          }

          // Rate limiting: max 5 messages per 30 seconds
          const now = Date.now()
          const appKey = app.id
          const timestamps = messageCooldowns.get(appKey) ?? []
          const recent = timestamps.filter((ts) => now - ts < 30_000)
          if (recent.length >= 5) {
            if (!silent) toast.warning(t('miniApps.sendMessage.rateLimited'))
            sendDialogResult(callbackId, false)
            break
          }
          recent.push(now)
          messageCooldowns.set(appKey, recent)

          // Prefix message with app context
          const prefixed = `[${app.icon || '📦'} ${app.name}] ${text}`

          api.post<{ messageId: string }>(`/agents/${app.maintainerAgentId}/messages`, { content: prefixed })
            .then(() => {
              if (!silent) toast.success(t('miniApps.sendMessage.sent'))
              sendDialogResult(callbackId, true)
            })
            .catch(() => {
              if (!silent) toast.error(t('miniApps.sendMessage.error'))
              sendDialogResult(callbackId, false)
            })
          break
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [navigate, sendAppMeta, setFullPage, setCustomTitle, setBadge, activeAppId, app, openApp, t])

  // Escape key exits full-page mode
  useEffect(() => {
    if (!isFullPage) return
    function handleKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setFullPage(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullPage, setFullPage])

  const handleRefresh = useCallback(() => {
    setIframeKey((k) => k + 1)
  }, [])

  const handleIframeLoad = useCallback(() => {
    sendAppMeta()
    // Push the theme on load too (not only on the app's 'ready') so the initial
    // theme applies even if the app never calls Hivekeep.ready(). The iframe is
    // opaque-origin and can't read parent.document, so this push is the only way.
    sendTheme()
  }, [sendAppMeta, sendTheme])

  const errorBadge = errorCount > 0 ? (
    <div className="flex items-center gap-1 rounded-md bg-destructive/10 px-1.5 py-0.5 text-xs text-destructive" title={`${errorCount} error${errorCount > 1 ? 's' : ''} in console`}>
      <AlertTriangle className="size-3" />
      <span>{errorCount}</span>
    </div>
  ) : null

  // ─── "Improve this app" → message the maintainer Agent ────────────────────────
  const [improveOpen, setImproveOpen] = useState(false)
  const [improveText, setImproveText] = useState('')
  const [improveSubmitting, setImproveSubmitting] = useState(false)

  const submitImprove = useCallback(async () => {
    const description = improveText.trim()
    if (!app || !description) return
    setImproveSubmitting(true)
    try {
      const res = await api.post<{ maintainerAgentId: string; maintainerAgentName: string }>(
        `/mini-apps/${app.id}/improve`,
        { description },
      )
      toast.success(t('miniApps.improve.sent', { agent: res.maintainerAgentName }))
      setImproveText('')
      setImproveOpen(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setImproveSubmitting(false)
    }
  }, [app, improveText, t])

  const improveButton = (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      onClick={() => setImproveOpen(true)}
      disabled={!app}
      title={t('miniApps.improve.button')}
    >
      <Wand2 className="size-3.5" />
    </Button>
  )

  const improveDialog = (
    <AlertDialog open={improveOpen} onOpenChange={(open) => { if (!improveSubmitting) setImproveOpen(open) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('miniApps.improve.modalTitle', { name: app?.name ?? '' })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('miniApps.improve.modalDescription', { agent: app?.maintainerAgentName ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          value={improveText}
          onChange={(e) => setImproveText(e.target.value)}
          placeholder={t('miniApps.improve.placeholder')}
          rows={5}
          autoFocus
          disabled={improveSubmitting}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={improveSubmitting}>{t('common.cancel')}</AlertDialogCancel>
          <Button onClick={submitImprove} disabled={improveSubmitting || !improveText.trim()}>
            {improveSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('miniApps.improve.submit')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  const iframeSrc = activeAppId
    ? `/api/mini-apps/${activeAppId}/serve?v=${activeAppVersion}`
    : ''

  const handleDialogCancel = useCallback(() => {
    if (!dialog) return
    sendDialogResult(dialog.callbackId, dialog.type === 'confirm' ? false : null)
    setDialog(null)
  }, [dialog, sendDialogResult])

  const handleDialogConfirm = useCallback(() => {
    if (!dialog) return
    sendDialogResult(dialog.callbackId, dialog.type === 'confirm' ? true : promptValue)
    setDialog(null)
  }, [dialog, sendDialogResult, promptValue])

  const dialogElement = dialog && (
    <AlertDialog open onOpenChange={(open) => { if (!open) handleDialogCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{dialog.title}</AlertDialogTitle>
          <AlertDialogDescription>{dialog.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {dialog.type === 'prompt' && (
          <div className="px-1 py-2">
            <Input
              autoFocus
              placeholder={dialog.placeholder}
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleDialogConfirm() }}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDialogCancel}>
            {dialog.cancelLabel}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDialogConfirm}
            className={dialog.variant === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
          >
            {dialog.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // Approval banner shown above the iframe while the backend has ungranted permissions
  const permissionsBanner = app?.hasBackend && permissions && permissions.missing.length > 0 ? (
    <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2">
      <ShieldAlert className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{t('miniApps.permissions.title')}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {permissions.missing.map((p) => (
            <code key={p} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{p}</code>
          ))}
        </div>
      </div>
      <Button size="sm" className="h-7 text-xs" onClick={handleGrantPermissions} disabled={granting}>
        {granting ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
        {t('miniApps.permissions.approve')}
      </Button>
    </div>
  ) : null

  // Full-page mode: render as overlay
  if (isFullPage && panelOpen && activeAppId) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background">
        {dialogElement}
        {improveDialog}
        {/* Header */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          {app?.iconUrl ? (
            <img src={app.iconUrl} alt={app.name} className="size-6 rounded-md object-cover" />
          ) : app?.icon ? (
            <span className="text-base">{app.icon}</span>
          ) : null}
          <span className="flex-1 truncate text-sm font-medium">
            {customTitle || (app?.name ?? '...')}
          </span>
          {errorBadge}
          {improveButton}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleGenerateIcon}
            disabled={generatingIcon}
            title={t('miniApps.icon.generate')}
          >
            {generatingIcon ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={handleRefresh}
            title={t('miniApps.refresh')}
          >
            <RotateCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={toggleFullPage}
            title={t('miniApps.exitFullPage')}
          >
            <Minimize2 className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={closePanel}
            title={t('miniApps.closePanel')}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        {permissionsBanner}

        {/* Iframe */}
        <iframe
          ref={iframeRef}
          key={iframeKey}
          src={iframeSrc}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          allow="microphone; camera; clipboard-read; clipboard-write; autoplay"
          className="min-h-0 flex-1 w-full border-0"
          title={app?.name ?? 'Mini App'}
          onLoad={handleIframeLoad}
        />
      </div>
    )
  }

  const { activeTab, activeTask, activeTicket, switchTab, closeTask } = useSidePanel()
  const hasBothTabs = activeAppId !== null && activeTask !== null
  const showMiniApp = activeTab === 'mini-app'
  const showTask = activeTab === 'task'
  const showTicket = activeTab === 'ticket'

  // Side panel mode (default). The inner content is identical between desktop
  // (inline fixed-width column) and mobile (fullscreen Sheet overlay). On
  // mobile the inline column would force page-wide horizontal scroll and leave
  // no room for the conversation, so we render it inside a Sheet instead.
  const panelInner = (
      <div className={`flex h-full flex-col ${isMobile ? 'w-full' : 'w-[480px] lg:w-[600px] border-l border-border'}`}>
        {dialogElement}
        {improveDialog}

        {/* Tab bar — only shown when both a mini-app and task are loaded */}
        {hasBothTabs && (
          <div className="flex shrink-0 items-center border-b border-border bg-muted/30">
            <button
              onClick={() => switchTab('mini-app')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                showMiniApp
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {app?.icon ? (
                <span className="text-sm">{app.icon}</span>
              ) : app?.iconUrl ? (
                <img src={app.iconUrl} alt="" className="size-3.5 rounded" />
              ) : (
                <span className="text-sm">🧩</span>
              )}
              <span className="truncate max-w-[100px]">{customTitle || (app?.name ?? '...')}</span>
            </button>
            <button
              onClick={() => switchTab('task')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                showTask
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <ClipboardList className="size-3.5" />
              <span className="truncate max-w-[100px]">{t('rightPanel.taskTab')}</span>
            </button>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="icon"
              className="size-7 mr-1"
              onClick={closePanel}
              title={t('miniApps.closePanel')}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}

        {/* Mini-app content */}
        {showMiniApp && (
          <>
            {/* Header — only shown when no tab bar (single mode) */}
            {!hasBothTabs && (
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
                {app?.iconUrl ? (
                  <img src={app.iconUrl} alt={app.name} className="size-6 rounded-md object-cover" />
                ) : app?.icon ? (
                  <span className="text-base">{app.icon}</span>
                ) : null}
                <span className="flex-1 truncate text-sm font-medium">
                  {customTitle || (app?.name ?? '...')}
                </span>
                {errorBadge}
          {improveButton}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={handleGenerateIcon}
                  disabled={generatingIcon}
                  title={t('miniApps.icon.generate')}
                >
                  {generatingIcon ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={handleRefresh}
                  title={t('miniApps.refresh')}
                >
                  <RotateCw className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={toggleFullPage}
                  title={t('miniApps.fullPage')}
                >
                  <Maximize2 className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={closePanel}
                  title={t('miniApps.closePanel')}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}

            {/* Mini-app action buttons when in tab mode */}
            {hasBothTabs && (
              <div className="flex shrink-0 items-center gap-1 px-2 py-1 border-b border-border">
                {app?.iconUrl ? (
                  <img src={app.iconUrl} alt={app.name} className="size-5 rounded-md object-cover" />
                ) : app?.icon ? (
                  <span className="text-sm">{app.icon}</span>
                ) : null}
                <span className="flex-1 truncate text-xs font-medium">
                  {customTitle || (app?.name ?? '...')}
                </span>
                {errorBadge}
          {improveButton}
                <Button variant="ghost" size="icon" className="size-6" onClick={handleGenerateIcon} disabled={generatingIcon} title={t('miniApps.icon.generate')}>
                  {generatingIcon ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
                </Button>
                <Button variant="ghost" size="icon" className="size-6" onClick={handleRefresh} title={t('miniApps.refresh')}>
                  <RotateCw className="size-3" />
                </Button>
                <Button variant="ghost" size="icon" className="size-6" onClick={toggleFullPage} title={t('miniApps.fullPage')}>
                  <Maximize2 className="size-3" />
                </Button>
              </div>
            )}

            {permissionsBanner}

            {/* Iframe */}
            {activeAppId && (
              <iframe
                ref={iframeRef}
                key={iframeKey}
                src={iframeSrc}
                sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                allow="microphone; camera; clipboard-read; clipboard-write; autoplay"
                className="min-h-0 flex-1 w-full border-0"
                title={app?.name ?? 'Mini App'}
                onLoad={handleIframeLoad}
              />
            )}
          </>
        )}

        {/* Task content */}
        {showTask && activeTask && (
          <>
            {/* Close button when in single task mode (no tab bar) */}
            {!hasBothTabs && (
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
                <ClipboardList className="size-4 text-muted-foreground" />
                <span className="flex-1 truncate text-sm font-medium">{t('rightPanel.taskTab')}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={closeTask}
                  title={t('taskDetail.close')}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            )}
            <Suspense fallback={<div className="flex items-center justify-center py-8"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>}>
              <TaskPanelContent
                taskId={activeTask.taskId}
                agentName={activeTask.agentName}
                agentAvatarUrl={activeTask.agentAvatarUrl}
              />
            </Suspense>
          </>
        )}

        {/* Ticket content (Phase 26.7) — full panel takeover, no tab bar yet.
            Header + close handled internally by TicketPanelContent. */}
        {showTicket && activeTicket && (
          <Suspense fallback={<div className="flex items-center justify-center py-8"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>}>
            <TicketPanelContent ticketId={activeTicket.ticketId} />
          </Suspense>
        )}
      </div>
  )

  // Mobile: render the panel as a fullscreen Sheet overlay instead of an inline
  // column. This frees the whole width for the conversation and hosts mini-apps,
  // task detail and ticket detail without forcing page-wide horizontal scroll.
  // Closing the Sheet routes through closePanel() so the underlying tab/app
  // state is reset consistently with the desktop close controls.
  if (isMobile) {
    return (
      <Sheet open={panelOpen} onOpenChange={(open) => { if (!open) closePanel() }}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-screen max-w-none h-full gap-0 p-0 sm:max-w-none"
        >
          {/* Radix Dialog requires an accessible title/description. The panel
              renders its own visible headers, so keep these screen-reader only. */}
          <VisuallyHidden.Root>
            <SheetTitle>{customTitle || (app?.name ?? t('rightPanel.title', { defaultValue: 'Panel' }))}</SheetTitle>
            <SheetDescription>{t('rightPanel.description', { defaultValue: 'Detail panel' })}</SheetDescription>
          </VisuallyHidden.Root>
          {panelInner}
        </SheetContent>
      </Sheet>
    )
  }

  // Desktop (>= 768px): inline fixed-width side column — unchanged behavior.
  return (
    <div
      className={`shrink-0 overflow-hidden transition-[width] duration-300 ease-out ${
        panelOpen ? 'w-[480px] lg:w-[600px]' : 'w-0'
      }`}
    >
      {panelInner}
    </div>
  )
}
