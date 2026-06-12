import os from 'os'
import { spawn, type IPty } from 'bun-pty'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'

const log = createLogger('terminal')

/**
 * Admin-only web terminal sessions (Terminal section).
 *
 * One PTY per session, owned by the user who opened it. A session survives a
 * WebSocket disconnect (navigation away, brief network drop) for
 * `config.terminal.detachedTtlSec`: while detached, output accumulates in a
 * bounded scrollback buffer that is replayed on reattach. Killing the shell
 * (exit / TTL / explicit close) removes the session.
 *
 * bun-pty is used instead of node-pty: node-pty's onData never fires under
 * Bun (its fd-socket trick isn't supported), bun-pty is a Rust/FFI port of
 * the same IPty interface that works natively.
 */

export interface TerminalSession {
  id: string
  userId: string
  pty: IPty
  createdAt: number
  /** Bounded scrollback replayed on (re)attach. */
  scrollback: string
  /** Currently attached client sink, if any (one client per session). */
  sink: ((data: string) => void) | null
  /** Notified when the session is destroyed while a client is attached. */
  onClosed: (() => void) | null
  /** Pending kill timer while no client is attached. */
  detachTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
}

const sessions = new Map<string, TerminalSession>()

function appendScrollback(session: TerminalSession, data: string) {
  const max = config.terminal.scrollbackKb * 1024
  session.scrollback += data
  if (session.scrollback.length > max) {
    session.scrollback = session.scrollback.slice(session.scrollback.length - max)
  }
}

function armDetachTimer(session: TerminalSession) {
  if (session.detachTimer) clearTimeout(session.detachTimer)
  session.detachTimer = setTimeout(() => {
    log.info({ sessionId: session.id }, 'Detached terminal session expired — killing shell')
    destroySession(session.id)
  }, config.terminal.detachedTtlSec * 1000)
}

export function createSession(userId: string, cols: number, rows: number): TerminalSession {
  const running = [...sessions.values()].filter((s) => !s.exited)
  if (running.length >= config.terminal.maxSessions) {
    throw new Error('TERMINAL_MAX_SESSIONS')
  }

  const id = crypto.randomUUID()
  const pty = spawn(config.terminal.shell, [], {
    name: 'xterm-256color',
    cols: Math.max(2, cols),
    rows: Math.max(2, rows),
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
  })

  const session: TerminalSession = {
    id,
    userId,
    pty,
    createdAt: Date.now(),
    scrollback: '',
    sink: null,
    onClosed: null,
    detachTimer: null,
    exited: false,
  }
  sessions.set(id, session)

  pty.onData((data) => {
    appendScrollback(session, data)
    session.sink?.(data)
  })
  pty.onExit(({ exitCode }) => {
    log.info({ sessionId: id, exitCode }, 'Terminal shell exited')
    session.exited = true
    // Let the attached client render the exit before the session disappears.
    session.sink?.(`\r\n[process exited with code ${exitCode}]\r\n`)
    destroySession(id)
  })

  // Unattached until the WS handler claims it — arm the TTL so an orphaned
  // create (client died between create and attach) can't leak a shell.
  armDetachTimer(session)

  log.info({ sessionId: id, userId, shell: config.terminal.shell, pid: pty.pid }, 'Terminal session created')
  return session
}

/** Claim the session for a connected client. Returns the scrollback to replay. */
export function attach(
  sessionId: string,
  userId: string,
  sink: (data: string) => void,
  onClosed: () => void,
): string | null {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return null
  // Single attachment: a newer client (e.g. another tab) silently replaces the
  // previous sink — the old socket stops receiving output and will be closed
  // by its own client.
  session.sink = sink
  session.onClosed = onClosed
  if (session.detachTimer) {
    clearTimeout(session.detachTimer)
    session.detachTimer = null
  }
  return session.scrollback
}

export function detach(sessionId: string, sink: (data: string) => void) {
  const session = sessions.get(sessionId)
  if (!session) return
  // Only the currently attached sink may detach — a stale socket closing must
  // not steal the session from the client that replaced it.
  if (session.sink !== sink) return
  session.sink = null
  session.onClosed = null
  if (!session.exited) armDetachTimer(session)
}

export function write(sessionId: string, userId: string, data: string) {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return
  session.pty.write(data)
}

export function resize(sessionId: string, userId: string, cols: number, rows: number) {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return
  try {
    session.pty.resize(Math.max(2, cols), Math.max(2, rows))
  } catch (err) {
    log.warn({ err, sessionId }, 'Terminal resize failed')
  }
}

export function destroySession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.detachTimer) clearTimeout(session.detachTimer)
  session.onClosed?.()
  session.onClosed = null
  session.sink = null
  if (!session.exited) {
    session.exited = true
    try {
      session.pty.kill()
    } catch (err) {
      log.warn({ err, sessionId }, 'Terminal kill failed')
    }
  }
}

export function getSession(sessionId: string, userId: string): TerminalSession | null {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) return null
  return session
}
