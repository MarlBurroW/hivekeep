import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { SquareTerminal, RotateCcw, Plug } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '@/client/hooks/useAuth'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { Button } from '@/client/components/ui/button'
import { EmptyState } from '@/client/components/common/EmptyState'
import { api, ApiRequestError } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'

/**
 * Admin-only web terminal on the host machine (or the container under Docker).
 *
 * One PTY session per browser tab: the session id is kept in sessionStorage so
 * navigating away and back reattaches to the same shell (the server keeps a
 * detached session alive for a TTL and replays its scrollback on resume).
 * xterm.js renders; a WebSocket at /api/terminal/ws carries input/output.
 */

const SESSION_KEY = 'hivekeep.terminal.sessionId'
const PING_INTERVAL_MS = 30_000

type Status = 'connecting' | 'connected' | 'disconnected' | 'ended' | 'disabled'

// Fixed dark theme (One Dark-ish): terminals stay dark in both app modes, like
// embedded terminals in IDEs. xterm needs concrete colors, not CSS variables.
const TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#d6dde6',
  cursor: '#d6dde6',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(110, 140, 180, 0.35)',
  black: '#1c2128',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d6dde6',
  brightBlack: '#5c6370',
  brightRed: '#ef7d85',
  brightGreen: '#a9d389',
  brightYellow: '#f0cc8b',
  brightBlue: '#74bcff',
  brightMagenta: '#d68aef',
  brightCyan: '#66c6d2',
  brightWhite: '#f0f4f8',
}

export function TerminalPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const statusRef = useRef<Status>('connecting')

  const setStatusBoth = useCallback((s: Status) => {
    statusRef.current = s
    setStatus(s)
  }, [])

  const closeSocket = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current)
      pingRef.current = null
    }
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }, [])

  const connect = useCallback((fresh: boolean) => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    closeSocket()
    setStatusBoth('connecting')

    if (fresh) sessionStorage.removeItem(SESSION_KEY)
    const sessionId = sessionStorage.getItem(SESSION_KEY)
    const params = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) })
    if (sessionId) params.set('sessionId', sessionId)
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/terminal/ws?${params}`)
    wsRef.current = ws

    ws.onmessage = (evt) => {
      let msg: { type: string; data?: string; sessionId?: string; resumed?: boolean; code?: string }
      try {
        msg = JSON.parse(String(evt.data))
      } catch {
        return
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data)
      } else if (msg.type === 'ready') {
        if (msg.sessionId) sessionStorage.setItem(SESSION_KEY, msg.sessionId)
        // A resumed session replays its full scrollback right after `ready`,
        // so wipe whatever the previous attachment left on screen.
        if (msg.resumed) term.reset()
        setStatusBoth('connected')
        term.focus()
      } else if (msg.type === 'exit') {
        sessionStorage.removeItem(SESSION_KEY)
        setStatusBoth('ended')
      } else if (msg.type === 'error') {
        sessionStorage.removeItem(SESSION_KEY)
        term.writeln(`\r\n${t('terminal.maxSessions')}`)
        setStatusBoth('ended')
      }
    }
    ws.onclose = () => {
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
      if (wsRef.current !== ws) return
      wsRef.current = null
      // A close after 'exit' is expected teardown; anything else is a drop.
      if (statusRef.current !== 'ended') setStatusBoth('disconnected')
    }
    // Periodic ping: keeps Bun's WS idle timeout and reverse proxies from
    // dropping a shell that is just sitting at a prompt.
    pingRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
    }, PING_INTERVAL_MS)
  }, [closeSocket, setStatusBoth, t])

  const restart = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill' }))
    sessionStorage.removeItem(SESSION_KEY)
    termRef.current?.reset()
    connect(true)
  }, [connect])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let disposed = false
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: TERMINAL_THEME,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    const observer = new ResizeObserver(() => {
      if (!disposed) fit.fit()
    })
    observer.observe(el)

    // Confirm the feature is enabled before opening the socket: a WS rejection
    // carries no error body, the REST probe does.
    api
      .get<{ enabled: boolean }>('/terminal/status')
      .then(() => {
        if (!disposed) connect(false)
      })
      .catch((err) => {
        if (disposed) return
        if (err instanceof ApiRequestError && err.code === 'TERMINAL_DISABLED') setStatusBoth('disabled')
        else setStatusBoth('disconnected')
      })

    return () => {
      disposed = true
      observer.disconnect()
      closeSocket()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect, closeSocket, setStatusBoth])

  if (user && user.role !== 'admin') return <Navigate to="/" replace />

  const statusLabel: Record<Exclude<Status, 'disabled'>, string> = {
    connecting: t('terminal.status.connecting'),
    connected: t('terminal.status.connected'),
    disconnected: t('terminal.status.disconnected'),
    ended: t('terminal.status.ended'),
  }

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={SquareTerminal}
        title={t('terminal.title')}
        actions={
          status !== 'disabled' ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    'size-2 rounded-full',
                    status === 'connected' && 'bg-success',
                    status === 'connecting' && 'animate-pulse bg-warning',
                    (status === 'disconnected' || status === 'ended') && 'bg-destructive',
                  )}
                />
                <span className="hidden sm:inline">{statusLabel[status]}</span>
              </span>
              {status === 'disconnected' && (
                <Button variant="outline" size="sm" onClick={() => connect(false)}>
                  <Plug className="size-4" />
                  {t('terminal.reconnect')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={restart}>
                <RotateCcw className="size-4" />
                {t('terminal.newSession')}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 p-2 sm:p-4">
        {status === 'disabled' ? (
          <EmptyState
            icon={SquareTerminal}
            title={t('terminal.disabled.title')}
            description={t('terminal.disabled.description')}
          />
        ) : (
          <div
            className="h-full overflow-hidden rounded-lg border border-border p-2"
            style={{ backgroundColor: TERMINAL_THEME.background }}
          >
            <div ref={containerRef} className="h-full w-full" />
          </div>
        )}
      </div>
    </div>
  )
}
