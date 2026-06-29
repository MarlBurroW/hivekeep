import os from 'os'
import { readFileSync, readlinkSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { spawn, type IPty } from 'bun-pty'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import type { TerminalSessionDTO } from '@/shared/types'

const log = createLogger('terminal')

/**
 * Admin-only web terminal sessions (Terminal section).
 *
 * tmux-like model: sessions are server-side PTYs scoped to their owner and
 * survive WebSocket disconnects — close the browser, reopen on another device,
 * and reattach to the same shell (scrollback is replayed). A session only dies
 * when its shell exits, when the user closes it from the sessions sidebar, or
 * (if `detachedTtlSec` > 0, off by default) after sitting detached too long.
 *
 * Persistence across a server restart has two layers:
 *  - Always: session metadata + a bounded scrollback tail are persisted to the
 *    DB (via an injected `TerminalPersistence`, so this module stays pure and
 *    unit-testable). On boot they come back as *dormant* sessions (no live
 *    shell); attaching respawns a fresh shell in the last working directory and
 *    replays the saved scrollback.
 *  - When `tmux` is available: sessions are backed by a tmux session. tmux's
 *    server is a separate daemon that outlives the Bun process, so after a
 *    process-only restart (e.g. an in-place self-update) reattaching reconnects
 *    to the *live* shell with its running processes intact. When tmux isn't
 *    installed we fall back to a direct PTY (no hard dependency).
 *
 * Every lifecycle change emits a `terminal:sessions-changed` SSE event to the
 * owner so all their devices keep their sidebar in sync.
 *
 * bun-pty is used instead of node-pty: node-pty's onData never fires under
 * Bun (its fd-socket trick isn't supported), bun-pty is a Rust/FFI port of
 * the same IPty interface that works natively.
 */

/** Fallback when another test file mocks @/server/config without the terminal
 *  section (Bun's mock.module is global for the whole test run). At runtime
 *  the real config always wins. */
const TERMINAL_DEFAULTS = {
  enabled: true,
  shell: process.env.SHELL ?? '/bin/bash',
  scrollbackKb: 256,
  detachedTtlSec: 0,
  maxSessions: 10,
}

export function getTerminalConfig(): typeof TERMINAL_DEFAULTS {
  return (config as { terminal?: typeof TERMINAL_DEFAULTS }).terminal ?? TERMINAL_DEFAULTS
}

/** Grace period for sessions that were created but never attached (the client
 *  died between the create and the attach) — without it they would leak. */
const ORPHAN_GRACE_MS = 60_000

/** Only the tail of the scrollback is persisted — enough to give context on
 *  reattach without bloating the DB row. The in-memory buffer stays larger. */
const PERSIST_SCROLLBACK_BYTES = 32 * 1024

type Backend = 'pty' | 'tmux'

interface TerminalClient {
  onClosed: () => void
  cols: number
  rows: number
}

/** Lightweight inspection of what a session is doing, surfaced on the sidebar
 *  cards so sessions are identifiable at a glance. Derived from the OS, never
 *  required — on platforms where it can't be read it simply stays empty. */
export interface SessionProbe {
  /** Working directory of the foreground process (or the shell when idle). */
  cwd?: string
  /** Foreground command running in the terminal, if any (idle shell → undefined). */
  command?: string
}

export interface TerminalSession {
  id: string
  userId: string
  name: string
  /** Live PTY, or null while the session is dormant (restored from DB after a
   *  restart, not yet reattached). */
  pty: IPty | null
  /** 'tmux' sessions survive a process-only restart with their shell alive;
   *  'pty' sessions only persist their scrollback and respawn a fresh shell. */
  backend: Backend
  /** tmux session name (`hk-<id>`) when backend is 'tmux', else null. */
  tmuxName: string | null
  createdAt: number
  lastActiveAt: number
  /** Bounded scrollback replayed on (re)attach. */
  scrollback: string
  /** Attached clients, keyed by their sink — output is mirrored to all of
   *  them (tmux-style), and the PTY is sized to the smallest viewer. */
  clients: Map<(data: string) => void, TerminalClient>
  /** True once a client has attached at least once (orphan-grace bookkeeping). */
  everAttached: boolean
  /** Pending kill timer while no client is attached. */
  detachTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
  /** Last inspected cwd/command, refreshed by the probe poller and diffed to
   *  decide whether a sidebar refresh is worth emitting. */
  probe: SessionProbe
  /** Set when in-memory state (scrollback / activity / cwd) has drifted from
   *  the persisted row; cleared on the next flush. */
  dirty: boolean
}

const sessions = new Map<string, TerminalSession>()

// ─── Persistence (injected) ─────────────────────────────────────────────────

/** A row as persisted to the DB. Kept free of live objects so the service has
 *  no direct DB dependency (real impl wired at boot, absent in unit tests). */
export interface PersistedTerminalSession {
  id: string
  userId: string
  name: string
  createdAt: number
  lastActiveAt: number
  lastCwd: string | null
  scrollback: string
  backend: Backend
  tmuxName: string | null
}

export interface TerminalPersistence {
  loadAll(): PersistedTerminalSession[]
  upsert(row: PersistedTerminalSession): void
  remove(id: string): void
}

let persistence: TerminalPersistence | null = null

/** Wire (or clear, with null) the DB-backed persistence. Called once at boot. */
export function setTerminalPersistence(p: TerminalPersistence | null) {
  persistence = p
}

function toPersisted(session: TerminalSession): PersistedTerminalSession {
  return {
    id: session.id,
    userId: session.userId,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    lastCwd: session.probe.cwd ?? null,
    scrollback: session.scrollback.slice(-PERSIST_SCROLLBACK_BYTES),
    backend: session.backend,
    tmuxName: session.tmuxName,
  }
}

function persistSession(session: TerminalSession) {
  if (!persistence || session.exited) return
  try {
    persistence.upsert(toPersisted(session))
  } catch (err) {
    log.warn({ err, sessionId: session.id }, 'Terminal session persist failed')
  }
}

function markDirty(session: TerminalSession) {
  session.dirty = true
}

// ─── tmux backing (opportunistic) ───────────────────────────────────────────

/** Dedicated tmux server socket so Hivekeep's sessions and global options
 *  (history-limit, mouse, clipboard) stay isolated from the user's own tmux on
 *  the default socket. Every tmux call below targets this socket. */
const TMUX_SOCKET = 'gezy'

/** Per-pane scrollback tmux keeps (default is only 2000 lines, which makes long
 *  output like Claude Code feel truncated when scrolling back). */
const TMUX_HISTORY_LIMIT = 50000

/** Prefix tmux args with the dedicated socket. */
function tmuxArgs(...args: string[]): string[] {
  return ['-L', TMUX_SOCKET, ...args]
}

let tmuxAvail: boolean | null = null

/** Whether tmux is usable on this host. Detected once and cached; sessions
 *  back themselves with tmux when true (true process survival across a
 *  process-only restart), and fall back to a direct PTY when false. */
export function isTmuxAvailable(): boolean {
  if (process.env.GEZY_TERMINAL_TMUX === 'off') return false
  if (tmuxAvail !== null) return tmuxAvail
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxAvail = true
  } catch {
    tmuxAvail = false
  }
  return tmuxAvail
}

function tmuxHasSession(name: string | null): boolean {
  if (!name || !isTmuxAvailable()) return false
  try {
    execFileSync('tmux', tmuxArgs('has-session', '-t', name), { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function probeViaTmux(name: string): SessionProbe {
  try {
    const out = execFileSync(
      'tmux',
      tmuxArgs('display-message', '-p', '-t', name, '#{pane_current_command}\n#{pane_current_path}'),
      { encoding: 'utf8' },
    )
    const [rawCommand, rawCwd] = out.split('\n')
    const command = rawCommand?.trim()
    const cwd = rawCwd?.trim()
    const shellBase = basename(getTerminalConfig().shell)
    return {
      cwd: cwd || undefined,
      command: command && command !== shellBase ? command : undefined,
    }
  } catch {
    return {}
  }
}

// ─── Probe (cwd + foreground command) ───────────────────────────────────────

function toDTO(session: TerminalSession): TerminalSessionDTO {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    attached: session.clients.size > 0,
    dormant: session.pty === null,
    persistent: session.backend === 'tmux',
    cwd: session.probe.cwd,
    command: session.probe.command,
  }
}

/**
 * Inspect a session's working directory and foreground command.
 *
 * tmux-backed sessions are inspected through tmux itself (reliable and works
 * even while no client is attached, since the shell lives in the tmux server).
 * Direct PTY sessions use Linux `/proc`: the controlling terminal's foreground
 * process group (`tpgid` in `/proc/<pid>/stat`) gives what's actually running,
 * then its `comm` and `cwd`. When the shell is the foreground process (idle
 * prompt) no command is reported. Any failure (non-Linux, dormant, a race with
 * an exiting process) yields an empty probe — the data is best-effort
 * decoration, never load-bearing.
 */
function probeSession(session: TerminalSession): SessionProbe {
  if (session.backend === 'tmux' && session.tmuxName && tmuxHasSession(session.tmuxName)) {
    return probeViaTmux(session.tmuxName)
  }
  const pid = session.pty?.pid
  if (!pid) return session.probe // dormant: keep last known (restored cwd)
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // `comm` (field 2) is wrapped in parens and may itself contain spaces or
    // parens, so split on everything after the final ')'.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // Post-comm fields: state, ppid, pgrp, session, tty_nr, tpgid, ...
    const tpgid = Number(afterComm[5])

    let command: string | undefined
    let cwdPid = pid
    if (tpgid > 0 && tpgid !== pid) {
      try {
        command = readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim() || undefined
        if (command) cwdPid = tpgid
      } catch {
        // Foreground process exited between reads — fall back to the shell.
      }
    }

    let cwd: string | undefined
    try {
      cwd = readlinkSync(`/proc/${cwdPid}/cwd`)
    } catch {
      // cwd unreadable (permissions / race) — leave undefined.
    }
    return { cwd, command }
  } catch {
    return {}
  }
}

/** Foreground command/cwd change without any lifecycle event firing (the user
 *  just runs `vim`), so a light poller diffs the probe of every live session
 *  and pushes a fresh sidebar list only when something actually changed. It
 *  doubles as the periodic flush of dirty rows to the DB. The timer is unref'd
 *  and torn down once the last session dies. */
const PROBE_INTERVAL_MS = 2500
let probeTimer: ReturnType<typeof setInterval> | null = null

function probesEqual(a: SessionProbe, b: SessionProbe): boolean {
  return a.cwd === b.cwd && a.command === b.command
}

function pollProbes() {
  const changedUsers = new Set<string>()
  for (const session of sessions.values()) {
    if (session.exited) continue
    const next = probeSession(session)
    if (!probesEqual(session.probe, next)) {
      session.probe = next
      session.dirty = true
      changedUsers.add(session.userId)
    }
    if (session.dirty) {
      session.dirty = false
      persistSession(session)
    }
  }
  for (const userId of changedUsers) notifySessionsChanged(userId)
  if (sessions.size === 0) stopProbePoller()
}

function ensureProbePoller() {
  if (probeTimer) return
  probeTimer = setInterval(pollProbes, PROBE_INTERVAL_MS)
  // Don't keep the process alive just for the terminal probe loop.
  ;(probeTimer as { unref?: () => void }).unref?.()
}

function stopProbePoller() {
  if (!probeTimer) return
  clearInterval(probeTimer)
  probeTimer = null
}

function listSessionsRaw(userId: string): TerminalSession[] {
  return [...sessions.values()]
    .filter((s) => s.userId === userId && !s.exited)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export function listSessions(userId: string): TerminalSessionDTO[] {
  return listSessionsRaw(userId).map(toDTO)
}

function notifySessionsChanged(userId: string) {
  // Optional call: several test files replace @/server/sse/index with partial
  // mocks lacking sendToUser, and mock.module is global to the bun test run.
  sseManager.sendToUser?.(userId, {
    type: 'terminal:sessions-changed',
    data: { sessions: listSessions(userId) },
  })
}

function appendScrollback(session: TerminalSession, data: string) {
  const max = getTerminalConfig().scrollbackKb * 1024
  session.scrollback += data
  if (session.scrollback.length > max) {
    session.scrollback = session.scrollback.slice(session.scrollback.length - max)
  }
}

/**
 * Strip terminal capability *queries* from a scrollback before replaying it.
 *
 * Full-screen programs (tmux especially) probe the terminal on startup by
 * emitting Device Attributes (DA1 `ESC[c`, DA2 `ESC[>c`, DA3 `ESC[=c`) and
 * Device Status Report (`ESC[6n`, `ESC[5n`) queries. These end up in the saved
 * scrollback. Replaying them verbatim on (re)attach makes xterm.js answer them
 * a second time, and the answer (e.g. `ESC[?1;2c`) lands on the now-idle shell
 * prompt where it shows up as visible junk like `1;2c` / `0;276;0c`.
 *
 * The queries are zero-width, so removing them from the replay copy doesn't
 * change what the user sees. The live PTY stream is never touched, so the real
 * startup handshake still works.
 */
function stripTerminalQueries(data: string): string {
  // CSI [private-prefix] [params] (c|n) — DA and DSR queries/answers.
  // eslint-disable-next-line no-control-regex
  return data.replace(/\x1b\[[?>=]?[0-9;]*[cn]/g, '')
}

/** Arm the pending-kill timer for an unattached session. Detached sessions
 *  persist by default (TTL 0); never-attached orphans always get a short grace. */
function armDetachTimer(session: TerminalSession) {
  if (session.detachTimer) clearTimeout(session.detachTimer)
  const ttlMs = session.everAttached ? getTerminalConfig().detachedTtlSec * 1000 : ORPHAN_GRACE_MS
  if (ttlMs <= 0) return
  session.detachTimer = setTimeout(() => {
    log.info({ sessionId: session.id }, 'Detached terminal session expired — killing shell')
    destroySession(session.id)
  }, ttlMs)
}

function nextSessionName(userId: string): string {
  const taken = new Set(
    [...sessions.values()].filter((s) => s.userId === userId && !s.exited).map((s) => s.name),
  )
  for (let n = 1; ; n++) {
    const name = `Session ${n}`
    if (!taken.has(name)) return name
  }
}

/** Spawn the PTY backing a session — a tmux client (attach-or-create) when the
 *  session is tmux-backed and tmux is available, otherwise a direct shell. The
 *  shell starts in `cwd` (the session's last known directory on revive). */
function spawnForSession(session: TerminalSession, cols: number, rows: number): IPty {
  const cwd = session.probe.cwd || os.homedir()
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
  const safeCols = Math.max(2, cols)
  const safeRows = Math.max(2, rows)

  if (session.backend === 'tmux' && isTmuxAvailable() && session.tmuxName) {
    // Start (or reuse) the dedicated server and raise the scrollback BEFORE the
    // pane exists (history-limit is read at pane creation), then `new-session
    // -A` attaches to the live session or creates it in `cwd`. We deliberately
    // leave tmux `mouse` off: turning it on routes selection through tmux (with
    // OSC 52 copy, which is size-limited and fights mouse-aware TUIs like Claude
    // Code), which broke copying long text. With mouse off, xterm's own native
    // selection handles copy reliably.
    return spawn(
      'tmux',
      tmuxArgs(
        'start-server', ';',
        'set-option', '-g', 'history-limit', String(TMUX_HISTORY_LIMIT), ';',
        'new-session', '-A', '-s', session.tmuxName, '-c', cwd,
      ),
      { name: 'xterm-256color', cols: safeCols, rows: safeRows, cwd, env },
    )
  }

  // tmux was expected but is no longer available — downgrade to a direct PTY.
  if (session.backend === 'tmux') {
    session.backend = 'pty'
    session.tmuxName = null
  }
  return spawn(getTerminalConfig().shell, [], {
    name: 'xterm-256color',
    cols: safeCols,
    rows: safeRows,
    cwd,
    env,
  })
}

/** Wire the PTY's data/exit handlers onto the session. Shared by create and
 *  revive. tmux client exit is special-cased: if the tmux server still holds
 *  the session the shell is alive, so we go dormant instead of destroying. */
function wireSession(session: TerminalSession, pty: IPty) {
  session.pty = pty
  pty.onData((data) => {
    session.lastActiveAt = Date.now()
    appendScrollback(session, data)
    markDirty(session)
    for (const sink of session.clients.keys()) sink(data)
  })
  pty.onExit(({ exitCode }) => {
    if (session.exited) return
    if (session.backend === 'tmux' && tmuxHasSession(session.tmuxName)) {
      log.info({ sessionId: session.id }, 'tmux client detached, server still alive — session dormant')
      becomeDormant(session)
      return
    }
    log.info({ sessionId: session.id, exitCode }, 'Terminal shell exited')
    session.exited = true
    // Let the attached clients render the exit before the session disappears.
    for (const sink of session.clients.keys()) sink(`\r\n[process exited with code ${exitCode}]\r\n`)
    destroySession(session.id)
  })
}

/** Drop the live PTY but keep the (persistent) session around: the tmux server
 *  still owns the shell, reattaching will reconnect to it. */
function becomeDormant(session: TerminalSession) {
  session.pty = null
  for (const client of session.clients.values()) client.onClosed()
  session.clients.clear()
  persistSession(session)
  notifySessionsChanged(session.userId)
}

/** Options applied when a session is created from a preset. */
export interface CreateSessionOptions {
  /** Directory the shell starts in (`~` expanded; falls back to home if it isn't
   *  an existing directory). */
  cwd?: string | null
  /** Multi-line script typed into the shell once, right after it starts. */
  initScript?: string | null
}

/** Resolve a preset cwd to a real, existing directory (expand `~`, validate). */
function resolveStartCwd(cwd?: string | null): string {
  const home = os.homedir()
  const raw = cwd?.trim()
  if (!raw) return home
  const expanded = raw === '~' || raw.startsWith('~/') ? join(home, raw.slice(1)) : raw
  try {
    if (statSync(expanded).isDirectory()) return expanded
  } catch {
    // Not an existing directory — fall back to home rather than failing the spawn.
  }
  return home
}

export function createSession(
  userId: string,
  cols: number,
  rows: number,
  opts: CreateSessionOptions = {},
): TerminalSession {
  const running = [...sessions.values()].filter((s) => !s.exited)
  if (running.length >= getTerminalConfig().maxSessions) {
    throw new Error('TERMINAL_MAX_SESSIONS')
  }

  const id = crypto.randomUUID()
  const backend: Backend = isTmuxAvailable() ? 'tmux' : 'pty'

  const session: TerminalSession = {
    id,
    userId,
    name: nextSessionName(userId),
    pty: null,
    backend,
    tmuxName: backend === 'tmux' ? `hk-${id}` : null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    scrollback: '',
    clients: new Map(),
    everAttached: false,
    detachTimer: null,
    exited: false,
    // Seed the start directory so spawnForSession opens the shell there.
    probe: { cwd: resolveStartCwd(opts.cwd) },
    dirty: false,
  }
  sessions.set(id, session)

  const pty = spawnForSession(session, cols, rows)
  wireSession(session, pty)
  session.probe = probeSession(session)

  // Run the preset's init script once: typed into the shell as if the user did.
  // The kernel tty buffers it, so writing before the shell is fully ready is safe.
  const initScript = opts.initScript?.trim()
  if (initScript) {
    session.pty?.write(initScript.endsWith('\n') ? initScript : `${initScript}\n`)
  }

  // Unattached until the WS handler claims it — the orphan grace ensures a
  // client that died between create and attach can't leak a shell.
  armDetachTimer(session)
  ensureProbePoller()
  persistSession(session)

  log.info(
    { sessionId: id, userId, backend, shell: getTerminalConfig().shell, pid: pty.pid },
    'Terminal session created',
  )
  notifySessionsChanged(userId)
  return session
}

/** Register a client on the session (any number of tabs/devices can view the
 *  same session simultaneously). Reviving a dormant session spawns its shell
 *  first. Returns the scrollback to replay (empty when reattaching to a live
 *  tmux session, which repaints its own screen). */
export function attach(
  sessionId: string,
  userId: string,
  sink: (data: string) => void,
  onClosed: () => void,
  cols = 80,
  rows = 24,
): string | null {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return null

  let replay = session.scrollback

  if (!session.pty) {
    // Dormant → revive. A live tmux session repaints its own screen, so don't
    // replay our saved scrollback on top (it would duplicate); a fresh shell
    // (direct PTY, or a tmux session whose server died) gets the saved history.
    const tmuxLive =
      session.backend === 'tmux' && tmuxHasSession(session.tmuxName)
    const pty = spawnForSession(session, cols, rows)
    wireSession(session, pty)
    if (tmuxLive) replay = ''
    log.info({ sessionId, backend: session.backend, tmuxLive }, 'Revived dormant terminal session')
    persistSession(session)
  }

  session.clients.set(sink, { onClosed, cols, rows })
  session.everAttached = true
  if (session.detachTimer) {
    clearTimeout(session.detachTimer)
    session.detachTimer = null
  }
  applyClientSizes(session)
  notifySessionsChanged(userId)
  // Strip capability queries so replaying the scrollback doesn't make the client
  // re-answer them (the answer would echo as junk like `1;2c` on the prompt).
  return stripTerminalQueries(replay)
}

/** Mirrored viewing (tmux-style): the PTY is sized to the smallest attached
 *  client so every viewer sees coherent line wrapping. */
function applyClientSizes(session: TerminalSession) {
  if (session.exited || !session.pty || session.clients.size === 0) return
  let cols = Infinity
  let rows = Infinity
  for (const client of session.clients.values()) {
    cols = Math.min(cols, client.cols)
    rows = Math.min(rows, client.rows)
  }
  try {
    session.pty.resize(Math.max(2, cols), Math.max(2, rows))
  } catch (err) {
    log.warn({ err, sessionId: session.id }, 'Terminal resize failed')
  }
}

export function detach(sessionId: string, sink: (data: string) => void) {
  const session = sessions.get(sessionId)
  if (!session) return
  if (!session.clients.delete(sink)) return
  if (session.exited) return
  // Flush latest state on disconnect so a restart restores up-to-date scrollback.
  persistSession(session)
  if (session.clients.size === 0) {
    armDetachTimer(session)
  } else {
    // A small viewer leaving may free the PTY to grow back.
    applyClientSizes(session)
  }
  notifySessionsChanged(session.userId)
}

export function write(sessionId: string, userId: string, data: string) {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId || !session.pty) return
  session.lastActiveAt = Date.now()
  markDirty(session)
  session.pty.write(data)
}

export function resize(sessionId: string, userId: string, sink: (data: string) => void, cols: number, rows: number) {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return
  const client = session.clients.get(sink)
  if (!client) return
  client.cols = cols
  client.rows = rows
  applyClientSizes(session)
}

export function renameSession(sessionId: string, userId: string, name: string): TerminalSessionDTO | null {
  const session = sessions.get(sessionId)
  if (!session || session.exited || session.userId !== userId) return null
  const trimmed = name.trim().slice(0, 60)
  if (!trimmed) return null
  session.name = trimmed
  persistSession(session)
  notifySessionsChanged(userId)
  return toDTO(session)
}

/** Ownership-checked destroy (sidebar close button / DELETE route). */
export function killSession(sessionId: string, userId: string): boolean {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) return false
  destroySession(sessionId)
  return true
}

export function destroySession(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  if (session.detachTimer) clearTimeout(session.detachTimer)
  for (const client of session.clients.values()) client.onClosed()
  session.clients.clear()
  // Kill the underlying tmux session too — closing from the sidebar means gone,
  // not just detached (otherwise it would survive in the tmux server).
  if (session.backend === 'tmux' && session.tmuxName && isTmuxAvailable()) {
    try {
      execFileSync('tmux', tmuxArgs('kill-session', '-t', session.tmuxName), { stdio: 'ignore' })
    } catch {
      // Already gone — nothing to kill.
    }
  }
  if (!session.exited) {
    session.exited = true
    try {
      session.pty?.kill()
    } catch (err) {
      log.warn({ err, sessionId }, 'Terminal kill failed')
    }
  }
  if (persistence) {
    try {
      persistence.remove(sessionId)
    } catch (err) {
      log.warn({ err, sessionId }, 'Terminal session delete failed')
    }
  }
  notifySessionsChanged(session.userId)
}

export function getSession(sessionId: string, userId: string): TerminalSession | null {
  const session = sessions.get(sessionId)
  if (!session || session.userId !== userId) return null
  return session
}

/**
 * Rebuild dormant sessions from the persisted store at boot. Each comes back
 * without a live PTY; the first attach revives it (reconnecting to a live tmux
 * session, or spawning a fresh shell in the saved cwd and replaying scrollback).
 * tmux-backed rows whose server has since died are downgraded to direct PTY so
 * they don't try to reattach to nothing.
 */
export function restorePersistedSessions(): number {
  if (!persistence) return 0
  let restored = 0
  for (const row of persistence.loadAll()) {
    if (sessions.has(row.id)) continue
    let backend = row.backend
    let tmuxName = row.tmuxName
    if (backend === 'tmux' && !isTmuxAvailable()) {
      backend = 'pty'
      tmuxName = null
    }
    const session: TerminalSession = {
      id: row.id,
      userId: row.userId,
      name: row.name,
      pty: null,
      backend,
      tmuxName,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      scrollback: row.scrollback,
      clients: new Map(),
      everAttached: true,
      detachTimer: null,
      exited: false,
      probe: { cwd: row.lastCwd ?? undefined },
      dirty: false,
    }
    sessions.set(row.id, session)
    restored++
    // Persist the possibly-downgraded backend so the row reflects reality.
    if (backend !== row.backend) persistSession(session)
  }
  if (restored > 0) {
    ensureProbePoller()
    log.info({ restored }, 'Restored persisted terminal sessions (dormant)')
  }
  return restored
}
