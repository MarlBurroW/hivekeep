import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import type { ServerWebSocket } from 'bun'
import type { Context, Next } from 'hono'
import { eq } from 'drizzle-orm'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { db } from '@/server/db/index'
import { userProfiles } from '@/server/db/schema'
import type { AppVariables } from '@/server/app'
import {
  attach,
  createSession,
  destroySession,
  detach,
  resize,
  write,
} from '@/server/services/terminal-sessions'

const log = createLogger('terminal')

// Single createBunWebSocket instance: `upgradeWebSocket` is used by the route
// below, `websocket` must be passed to Bun.serve (see main.ts).
const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()
export { websocket as terminalWebSocket }

/** Client → server messages over the terminal WebSocket. */
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' }

const terminalRoutes = new Hono<{ Variables: AppVariables }>()

/** Admin-only + feature-flag gate (the session itself is checked by authMiddleware). */
async function requireTerminalAccess(c: Context<{ Variables: AppVariables }>, next: Next) {
  if (!config.terminal.enabled) {
    return c.json({ error: { code: 'TERMINAL_DISABLED', message: 'The terminal feature is disabled on this instance' } }, 403)
  }
  const user = c.get('user')
  const profile = await db
    .select({ role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id))
    .get()
  if (!profile || profile.role !== 'admin') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403)
  }
  return next()
}

terminalRoutes.use('*', requireTerminalAccess)

// Lets the page distinguish "disabled instance" from transient WS failures.
terminalRoutes.get('/status', (c) => c.json({ enabled: true, shell: config.terminal.shell }))

terminalRoutes.get(
  '/ws',
  upgradeWebSocket((c) => {
    const user = c.get('user') as AppVariables['user']
    const requestedId = c.req.query('sessionId')
    const cols = Number(c.req.query('cols') ?? 80) || 80
    const rows = Number(c.req.query('rows') ?? 24) || 24

    let sessionId: string | null = null
    let sink: ((data: string) => void) | null = null

    return {
      onOpen(_evt, ws) {
        const send = (msg: Record<string, unknown>) => {
          try {
            ws.send(JSON.stringify(msg))
          } catch {
            // Socket already gone — detach will clean up via onClose.
          }
        }
        sink = (data: string) => send({ type: 'output', data })
        const onClosed = () => {
          send({ type: 'exit' })
          sessionId = null
        }

        // Reattach when the client brings a still-alive session id; otherwise
        // spawn a fresh shell. Scrollback is replayed before any live output.
        if (requestedId) {
          const scrollback = attach(requestedId, user.id, sink, onClosed)
          if (scrollback !== null) {
            sessionId = requestedId
            send({ type: 'ready', sessionId, resumed: true })
            if (scrollback) send({ type: 'output', data: scrollback })
            resize(sessionId, user.id, cols, rows)
            return
          }
        }

        let session
        try {
          session = createSession(user.id, cols, rows)
        } catch (err) {
          log.warn({ err, userId: user.id }, 'Terminal session creation failed')
          send({ type: 'error', code: 'TERMINAL_MAX_SESSIONS' })
          ws.close()
          return
        }
        sessionId = session.id
        attach(session.id, user.id, sink, onClosed)
        send({ type: 'ready', sessionId, resumed: false })
      },

      onMessage(evt, _ws) {
        if (!sessionId) return
        let msg: ClientMessage
        try {
          msg = JSON.parse(String(evt.data))
        } catch {
          return
        }
        if (msg.type === 'input' && typeof msg.data === 'string') {
          write(sessionId, user.id, msg.data)
        } else if (msg.type === 'resize') {
          resize(sessionId, user.id, Number(msg.cols) || 80, Number(msg.rows) || 24)
        } else if (msg.type === 'kill') {
          destroySession(sessionId)
        }
      },

      onClose() {
        if (sessionId && sink) detach(sessionId, sink)
      },
    }
  }),
)

export { terminalRoutes }
