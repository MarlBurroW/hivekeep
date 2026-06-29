import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { SquareTerminal, Plus, Plug, MoreHorizontal, PanelLeft, Pencil, Trash2, Folder, Anchor, TriangleAlert, Moon, Play, Settings2, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '@/client/hooks/useAuth'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { EmptyState } from '@/client/components/common/EmptyState'
import { Sheet, SheetContent, SheetTitle } from '@/client/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/client/components/ui/dropdown-menu'
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
import { api, ApiRequestError, getErrorMessage } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'
import { formatRelativeTime, formatDurationMs } from '@/client/lib/time'
import { TerminalPresetsDialog } from '@/client/components/terminal/TerminalPresetsDialog'
import type { TerminalSessionDTO, TerminalPresetDTO } from '@/shared/types'

/**
 * Admin-only web terminal on the host machine (or the container under Docker).
 *
 * tmux-like sessions: shells run server-side and survive disconnects, so a
 * session started on the desktop can be picked up from the phone. The sidebar
 * lists the user's live sessions (synced across devices via the
 * `terminal:sessions-changed` SSE event); closing one there kills its shell.
 * xterm.js renders; a WebSocket at /api/terminal/ws carries input/output.
 */

const SESSION_KEY = 'gezy.terminal.sessionId'
const PING_INTERVAL_MS = 30_000

// Sessions sidebar width: draggable like the main app sidebar, persisted so it
// survives reloads. The cards now carry a second line (cwd + command), so they
// need more room than a fixed-narrow rail allowed.
const SIDEBAR_WIDTH_KEY = 'gezy.terminal.sidebarWidth'
const SIDEBAR_WIDTH_DEFAULT = 300
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 560

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

/** Compact a path for the sidebar: keep the last two segments so the
 *  meaningful tail stays visible (full path is shown in the title tooltip). */
function shortenPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments.length <= 2) return path
  return `…/${segments.slice(-2).join('/')}`
}

/** Map a single character to its Ctrl-modified control code (Ctrl+C → 0x03).
 *  Used by the mobile key bar's Ctrl toggle, since a soft keyboard can't hold
 *  a modifier. Covers @, A-Z and [ \ ] ^ _ (ASCII 64-95); anything else passes
 *  through unchanged. */
function toControlChar(ch: string): string {
  if (ch.length !== 1) return ch
  const code = ch.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  return ch
}

/** Bar of keys a phone keyboard lacks (Esc, Tab, arrows) plus a Ctrl toggle that
 *  modifies the next typed letter. Docked at the top of the terminal pane, below
 *  the page header, and visible on mobile only (`md:hidden`).
 *
 *  Why the top and not floating above the keyboard: a soft keyboard overlays the
 *  layout viewport without resizing it, and iOS Safari scroll-shifts the whole
 *  webview when the hidden input is focused, so any `position: fixed` bar jitters
 *  and drifts across the screen. A bar pinned above the terminal never fights the
 *  keyboard. Each button keeps the terminal focused (preventDefault on the press)
 *  so tapping a key doesn't dismiss the keyboard. */
function MobileKeyBar({
  onKey,
  ctrlArmed,
  onToggleCtrl,
}: {
  onKey: (data: string) => void
  ctrlArmed: boolean
  onToggleCtrl: () => void
}) {
  const { t } = useTranslation()
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const arrows = [
    { icon: ArrowUp, data: '\x1b[A', label: t('terminal.keys.up') },
    { icon: ArrowDown, data: '\x1b[B', label: t('terminal.keys.down') },
    { icon: ArrowLeft, data: '\x1b[D', label: t('terminal.keys.left') },
    { icon: ArrowRight, data: '\x1b[C', label: t('terminal.keys.right') },
  ]
  return (
    <div
      className="mb-2 flex shrink-0 items-center gap-1 overflow-x-auto md:hidden"
      role="toolbar"
      aria-label={t('terminal.keys.label')}
    >
      <Button variant="outline" size="sm" className="h-8 shrink-0 px-2.5" onMouseDown={keepFocus} onClick={() => onKey('\x1b')}>
        Esc
      </Button>
      <Button variant="outline" size="sm" className="h-8 shrink-0 px-2.5" onMouseDown={keepFocus} onClick={() => onKey('\t')}>
        Tab
      </Button>
      <Button
        variant={ctrlArmed ? 'default' : 'outline'}
        size="sm"
        className="h-8 shrink-0 px-2.5"
        title={t('terminal.keys.ctrlHint')}
        aria-pressed={ctrlArmed}
        onMouseDown={keepFocus}
        onClick={onToggleCtrl}
      >
        {t('terminal.keys.ctrl')}
      </Button>
      {arrows.map((a) => (
        <Button
          key={a.data}
          variant="outline"
          size="icon-sm"
          className="size-8 shrink-0"
          aria-label={a.label}
          onMouseDown={keepFocus}
          onClick={() => onKey(a.data)}
        >
          <a.icon className="size-4" />
        </Button>
      ))}
    </div>
  )
}

function InlineRenameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="h-6 min-w-0 flex-1 px-1.5 text-sm"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onSubmit(value.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        if (value.trim() && value.trim() !== initial) onSubmit(value.trim())
        else onCancel()
      }}
    />
  )
}

/** The "+" new-session control: a menu offering a blank session, each preset,
 *  and a link to manage presets. `trigger` is the button it hangs off. */
function NewSessionMenu({
  trigger,
  presets,
  onBlank,
  onPreset,
  onManage,
}: {
  trigger: ReactNode
  presets: TerminalPresetDTO[]
  onBlank: () => void
  onPreset: (presetId: string) => void
  onManage: () => void
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={onBlank}>
          <SquareTerminal className="size-4" />
          {t('terminal.blankSession')}
        </DropdownMenuItem>
        {presets.length > 0 && <DropdownMenuSeparator />}
        {presets.map((p) => (
          <DropdownMenuItem key={p.id} onClick={() => onPreset(p.id)}>
            <Play className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onManage}>
          <Settings2 className="size-4" />
          {t('terminal.presets.manage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  const [sessions, setSessions] = useState<TerminalSessionDTO[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [presets, setPresets] = useState<TerminalPresetDTO[]>([])
  const [presetsDialogOpen, setPresetsDialogOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [closeTarget, setCloseTarget] = useState<TerminalSessionDTO | null>(null)
  const [tmuxAvailable, setTmuxAvailable] = useState(false)
  // Mobile key bar: a soft keyboard can't hold Ctrl, so the bar arms it and the
  // next typed letter (via term.onData) is folded into a control code.
  const [ctrlArmed, setCtrlArmed] = useState(false)
  const ctrlArmedRef = useRef(false)
  const setCtrlArmedBoth = useCallback((v: boolean) => {
    ctrlArmedRef.current = v
    setCtrlArmed(v)
  }, [])
  const [sidebarWidth, setSidebarWidthState] = useState(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return stored >= SIDEBAR_WIDTH_MIN && stored <= SIDEBAR_WIDTH_MAX ? stored : SIDEBAR_WIDTH_DEFAULT
  })
  const sidebarWidthRef = useRef(sidebarWidth)
  const setSidebarWidth = useCallback((w: number) => {
    sidebarWidthRef.current = w
    setSidebarWidthState(w)
  }, [])

  // Drag-to-resize the sessions panel (desktop only — mobile uses the Sheet).
  // Mirrors the main sidebar's handle: document-level listeners during the drag,
  // clamped width, persisted to localStorage on release.
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, startWidth + (ev.clientX - startX)))
      setSidebarWidth(next)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current))
      } catch {
        // private mode / quota — width just won't persist
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setSidebarWidth])

  const setStatusBoth = useCallback((s: Status) => {
    statusRef.current = s
    setStatus(s)
  }, [])

  const setActiveBoth = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveId(id)
    if (id) sessionStorage.setItem(SESSION_KEY, id)
    else sessionStorage.removeItem(SESSION_KEY)
  }, [])

  // Raw input from the mobile key bar (escape sequences, no Ctrl folding).
  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      const [sessionsRes, presetsRes] = await Promise.all([
        api.get<{ sessions: TerminalSessionDTO[] }>('/terminal/sessions'),
        api.get<{ presets: TerminalPresetDTO[] }>('/terminal/presets'),
      ])
      setSessions(sessionsRes.sessions)
      setPresets(presetsRes.presets)
    } catch {
      // Transient; the next SSE event or resync will repair the lists.
    }
  }, [])

  // The sidebar + presets are shared state across the user's devices: the server
  // pushes the fresh list on every change, and we refetch on SSE resume (events
  // are not replayed after a disconnect/locked phone).
  useSSE({
    'terminal:sessions-changed': (data) => {
      const list = (data as { sessions?: TerminalSessionDTO[] }).sessions
      if (list) setSessions(list)
    },
    'terminal:presets-changed': (data) => {
      const list = (data as { presets?: TerminalPresetDTO[] }).presets
      if (list) setPresets(list)
    },
  })
  useSSEResync(refreshSessions)

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

  /** Open the WS: attach to `sessionId`, or create a fresh shell when null
   *  (optionally seeded from a preset's working directory + init script). */
  const connect = useCallback((sessionId: string | null, presetId?: string) => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    closeSocket()
    setStatusBoth('connecting')

    const params = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) })
    if (sessionId) params.set('sessionId', sessionId)
    if (presetId) params.set('presetId', presetId)
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
        if (msg.sessionId) setActiveBoth(msg.sessionId)
        // A resumed session replays its full scrollback right after `ready`,
        // so wipe whatever the previous attachment left on screen.
        if (msg.resumed) term.reset()
        setStatusBoth('connected')
        term.focus()
      } else if (msg.type === 'exit') {
        setActiveBoth(null)
        setStatusBoth('ended')
      } else if (msg.type === 'error') {
        term.writeln(`\r\n${t('terminal.maxSessions')}`)
        setActiveBoth(null)
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
  }, [closeSocket, setStatusBoth, setActiveBoth, t])

  const selectSession = useCallback((id: string) => {
    setSheetOpen(false)
    if (id === activeIdRef.current && statusRef.current === 'connected') return
    termRef.current?.reset()
    connect(id)
  }, [connect])

  const newSession = useCallback((presetId?: string) => {
    setSheetOpen(false)
    termRef.current?.reset()
    connect(null, presetId)
  }, [connect])

  const renameSession = useCallback(async (id: string, name: string) => {
    setRenamingId(null)
    try {
      await api.patch(`/terminal/sessions/${id}`, { name })
      // Sidebar updates via the SSE event.
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }, [])

  const confirmClose = useCallback(async () => {
    const target = closeTarget
    setCloseTarget(null)
    if (!target) return
    try {
      // Killing the active session surfaces as a WS 'exit' message, which
      // drives the ended state — no special-casing needed here.
      await api.delete(`/terminal/sessions/${target.id}`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }, [closeTarget])

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
      let out = data
      // A Ctrl tap on the mobile bar arms the modifier for exactly one keystroke.
      if (ctrlArmedRef.current) {
        out = toControlChar(data)
        setCtrlArmedBoth(false)
      }
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: out }))
    })
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    // Clipboard. xterm wires nothing by itself: selecting text never copies, and
    // Ctrl+C must stay SIGINT. navigator.clipboard needs a secure context
    // (https/localhost), so we fall back to execCommand for copy and to xterm's
    // own native paste for paste, keeping it working over plain http on a LAN.
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

    const copyText = async (text: string) => {
      try {
        if (typeof navigator.clipboard?.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return
        }
      } catch {
        // fall through to the execCommand path below
      }
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy')
      } catch {
        // best effort — nothing else we can do in an insecure context
      }
      document.body.removeChild(ta)
    }

    const pasteText = async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (text) term.paste(text)
      } catch {
        // permission denied / insecure context — native paste covers this case
      }
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return true
      const key = e.key.toLowerCase()
      // Paste: Ctrl+V / Cmd+V / Ctrl+Shift+V.
      if (key === 'v') {
        if (typeof navigator.clipboard?.readText === 'function') {
          e.preventDefault()
          void pasteText()
          return false
        }
        return true // insecure context: let xterm's native textarea paste run
      }
      // Copy: Cmd+C and Ctrl+Shift+C always; plain Ctrl+C only with a selection
      // (so an empty Ctrl+C still sends SIGINT). Copy clears the selection so the
      // next Ctrl+C interrupts as usual.
      if (key === 'c') {
        const selection = term.getSelection()
        const copyCombo = e.metaKey || e.shiftKey || (e.ctrlKey && !isMac)
        if (selection && copyCombo) {
          e.preventDefault()
          void copyText(selection)
          term.clearSelection()
          return false
        }
        return true // no selection (or mac Ctrl+C) → passes through as SIGINT
      }
      return true
    })

    const observer = new ResizeObserver(() => {
      if (!disposed) fit.fit()
    })
    observer.observe(el)

    // Touch scrolling: a one-finger drag should page the buffer back through
    // history. xterm's own touch handling is unreliable here (and can swallow
    // the events), so we run in the capture phase, convert the pixel delta into
    // rows, and drive xterm's own scroll. A tap moves nothing, so tap-to-focus
    // still works; two-finger gestures (pinch-zoom) are left alone.
    let lastTouchY: number | null = null
    let scrollRemainder = 0
    const onTouchStart = (e: TouchEvent) => {
      lastTouchY = e.touches.length === 1 ? (e.touches[0]?.clientY ?? null) : null
      scrollRemainder = 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0]
      if (lastTouchY === null || e.touches.length !== 1 || !touch) return
      const cellHeight = el.clientHeight / Math.max(1, term.rows)
      scrollRemainder += lastTouchY - touch.clientY
      lastTouchY = touch.clientY
      const lines = Math.trunc(scrollRemainder / cellHeight)
      if (lines !== 0) {
        term.scrollLines(lines)
        scrollRemainder -= lines * cellHeight
      }
      e.preventDefault()
    }
    const onTouchEnd = () => {
      lastTouchY = null
    }
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    el.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    el.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })

    // Confirm the feature is enabled before opening the socket (a WS rejection
    // carries no error body, the REST probe does), then resume the last-used
    // session if it is still alive, else the most recent one, else a new shell.
    api
      .get<{ enabled: boolean; tmux: boolean }>('/terminal/status')
      .then((status) => {
        if (!disposed) setTmuxAvailable(status.tmux)
        return Promise.all([
          api.get<{ sessions: TerminalSessionDTO[] }>('/terminal/sessions'),
          api.get<{ presets: TerminalPresetDTO[] }>('/terminal/presets'),
        ])
      })
      .then(([res, presetsRes]) => {
        if (disposed) return
        setSessions(res.sessions)
        setPresets(presetsRes.presets)
        const last = sessionStorage.getItem(SESSION_KEY)
        const pick = res.sessions.find((s) => s.id === last) ?? res.sessions[res.sessions.length - 1]
        connect(pick?.id ?? null)
      })
      .catch((err) => {
        if (disposed) return
        if (err instanceof ApiRequestError && err.code === 'TERMINAL_DISABLED') setStatusBoth('disabled')
        else setStatusBoth('disconnected')
      })

    return () => {
      disposed = true
      observer.disconnect()
      el.removeEventListener('touchstart', onTouchStart, { capture: true })
      el.removeEventListener('touchmove', onTouchMove, { capture: true })
      el.removeEventListener('touchend', onTouchEnd, { capture: true })
      closeSocket()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect, closeSocket, setStatusBoth, setCtrlArmedBoth])

  // Auto-reconnect when the tab comes back to the foreground. Locking a phone or
  // switching apps drops the WebSocket; without this the user is stranded on the
  // "Reconnect" button every time they return. The button stays as a manual
  // fallback for mid-session network blips.
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== 'visible') return
      if (statusRef.current === 'disconnected' && activeIdRef.current) connect(activeIdRef.current)
    }
    document.addEventListener('visibilitychange', onResume)
    window.addEventListener('focus', onResume)
    return () => {
      document.removeEventListener('visibilitychange', onResume)
      window.removeEventListener('focus', onResume)
    }
  }, [connect])

  if (user && user.role !== 'admin') return <Navigate to="/" replace />

  const statusLabel: Record<Exclude<Status, 'disabled'>, string> = {
    connecting: t('terminal.status.connecting'),
    connected: t('terminal.status.connected'),
    disconnected: t('terminal.status.disconnected'),
    ended: t('terminal.status.ended'),
  }

  const sessionsPanel = (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('terminal.sessions.title')}
        </span>
        <NewSessionMenu
          presets={presets}
          onBlank={() => newSession()}
          onPreset={(id) => newSession(id)}
          onManage={() => setPresetsDialogOpen(true)}
          trigger={
            <Button variant="ghost" size="icon-sm" title={t('terminal.newSession')} aria-label={t('terminal.newSession')}>
              <Plus className="size-4" />
            </Button>
          }
        />
      </div>
      {/* Persistence indicator: tmux-backed sessions survive a restart with their
          processes; without tmux only the scrollback is restored. */}
      <div className="shrink-0 border-b border-border px-3 py-1.5">
        {tmuxAvailable ? (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
            title={t('terminal.tmux.persistentHint')}
          >
            <Anchor className="size-3 shrink-0 text-success" />
            {t('terminal.tmux.persistent')}
          </span>
        ) : (
          <span
            className="inline-flex items-start gap-1.5 text-[11px] text-warning"
            title={t('terminal.tmux.unavailableHint')}
          >
            <TriangleAlert className="mt-px size-3 shrink-0" />
            <span>{t('terminal.tmux.unavailable')}</span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t('terminal.sessions.empty')}</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => selectSession(session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectSession(session.id)
              }}
              className={cn(
                'group flex w-full cursor-pointer flex-col items-stretch gap-1 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                session.id === activeId
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    session.dormant ? 'bg-warning' : session.attached ? 'bg-success' : 'bg-muted-foreground/40',
                  )}
                  title={
                    session.dormant
                      ? t('terminal.sessions.dormantHint')
                      : session.attached
                        ? t('terminal.sessions.attached')
                        : t('terminal.sessions.detached')
                  }
                />
                {renamingId === session.id ? (
                  <InlineRenameInput
                    initial={session.name}
                    onSubmit={(name) => void renameSession(session.id, name)}
                    onCancel={() => setRenamingId(null)}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{session.name}</span>
                )}
                {session.persistent && (
                  <span className="shrink-0" title={t('terminal.sessions.persistent')}>
                    <Anchor className="size-3 text-muted-foreground/70" />
                  </span>
                )}
                {/* "⋯" — hover-revealed on desktop, always visible below md (touch has no hover) */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="rounded-sm p-0.5 text-muted-foreground opacity-100 hover:bg-muted-foreground/20 hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:data-[state=open]:opacity-100"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`actions ${session.name}`}
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onClick={() => setRenamingId(session.id)}>
                      <Pencil className="size-4" />
                      {t('terminal.sessions.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => setCloseTarget(session)}>
                      <Trash2 className="size-4" />
                      {t('terminal.sessions.close')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {/* Identification line: running command, cwd, last activity. Kept
                  out of the click target's text flow so it stays muted/compact. */}
              <div
                className={cn(
                  'flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px]',
                  session.id === activeId ? 'text-primary/70' : 'text-muted-foreground',
                )}
              >
                {session.dormant && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1 py-px text-warning"
                    title={t('terminal.sessions.dormantHint')}
                  >
                    <Moon className="size-2.5" />
                    {t('terminal.sessions.dormant')}
                  </span>
                )}
                {session.command && (
                  <span
                    className="shrink-0 rounded bg-foreground/10 px-1 py-px font-mono leading-tight"
                    title={t('terminal.sessions.running', { command: session.command })}
                  >
                    {session.command}
                  </span>
                )}
                {session.cwd && (
                  <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono" title={session.cwd}>
                    <Folder className="size-3 shrink-0" />
                    <span className="truncate">{shortenPath(session.cwd)}</span>
                  </span>
                )}
                <span
                  className="ml-auto shrink-0 tabular-nums"
                  title={t('terminal.sessions.openedFor', { duration: formatDurationMs(Date.now() - session.createdAt) })}
                >
                  {formatRelativeTime(session.lastActiveAt)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={SquareTerminal}
        title={t('terminal.title')}
        leading={
          status !== 'disabled' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              onClick={() => setSheetOpen(true)}
              aria-label={t('terminal.sessions.title')}
            >
              <PanelLeft className="size-4" />
            </Button>
          ) : undefined
        }
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
              {status === 'disconnected' && activeId && (
                <Button variant="outline" size="sm" onClick={() => connect(activeId)}>
                  <Plug className="size-4" />
                  {t('terminal.reconnect')}
                </Button>
              )}
              <NewSessionMenu
                presets={presets}
                onBlank={() => newSession()}
                onPreset={(id) => newSession(id)}
                onManage={() => setPresetsDialogOpen(true)}
                trigger={
                  <Button variant="outline" size="sm">
                    <Plus className="size-4" />
                    <span className="hidden sm:inline">{t('terminal.newSession')}</span>
                  </Button>
                }
              />
            </>
          ) : undefined
        }
      />
      {status === 'disabled' ? (
        <div className="p-4 sm:p-6">
          <EmptyState
            icon={SquareTerminal}
            title={t('terminal.disabled.title')}
            description={t('terminal.disabled.description')}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            style={{ width: sidebarWidth }}
            className="relative hidden shrink-0 border-r border-border md:flex md:flex-col"
          >
            {sessionsPanel}
            {/* Drag handle on the right edge (desktop only). */}
            <div
              onMouseDown={startSidebarResize}
              className="group absolute inset-y-0 right-[-4px] z-20 w-2 cursor-col-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('terminal.sessions.resize')}
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-primary/30 group-active:bg-primary/50" />
            </div>
          </aside>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="left" className="w-72 p-0 md:hidden">
              <SheetTitle className="sr-only">{t('terminal.sessions.title')}</SheetTitle>
              {sessionsPanel}
            </SheetContent>
          </Sheet>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col p-2 sm:p-4">
            <MobileKeyBar
              onKey={sendInput}
              ctrlArmed={ctrlArmed}
              onToggleCtrl={() => setCtrlArmedBoth(!ctrlArmedRef.current)}
            />
            <div
              className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border p-2"
              style={{ backgroundColor: TERMINAL_THEME.background }}
            >
              <div ref={containerRef} className="h-full w-full" />
            </div>
          </main>
        </div>
      )}

      <AlertDialog open={closeTarget !== null} onOpenChange={(open) => !open && setCloseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('terminal.sessions.closeConfirmTitle', { name: closeTarget?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('terminal.sessions.closeConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmClose()}>
              {t('terminal.sessions.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <TerminalPresetsDialog open={presetsDialogOpen} onOpenChange={setPresetsDialogOpen} presets={presets} />
    </div>
  )
}
