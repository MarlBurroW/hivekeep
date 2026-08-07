import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { v4 as uuid } from 'uuid'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'
import type { AppVariables } from '@/server/app'

const log = createLogger('routes:sse')

const sseRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/sse — global SSE connection (one per client)
sseRoutes.get('/', (c) => {
  const user = c.get('user') as { id: string }

  return streamSSE(c, async (stream) => {
    const connectionId = uuid()

    // Half-open TCP connections (mobile clients dropping without FIN/RST)
    // never fire onAbort: without eviction they'd stay in the manager's map
    // forever, each accumulating an unbounded chain of pending writes.
    let closed = false
    let pingInterval: ReturnType<typeof setInterval> | undefined
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const teardown = () => {
      if (closed) return
      closed = true
      if (pingInterval) clearInterval(pingInterval)
      sseManager.removeConnection(connectionId)
      resolveDone()
    }

    // Serialise writes so rapid-fire events (e.g. chat:token during LLM
    // streaming) don't interleave in the SSE byte stream.  Each writeSSE()
    // call waits for the previous one to complete before starting.
    let writeQueue = Promise.resolve()
    let pendingWrites = 0
    const MAX_PENDING_WRITES = 2000

    sseManager.addConnection(connectionId, {
      write: (data: string) => {
        if (closed) return
        if (pendingWrites >= MAX_PENDING_WRITES) {
          // Writes are not draining: the socket is effectively dead. Evict
          // rather than letting the promise chain grow for the process's life.
          log.warn({ connectionId, pendingWrites }, 'SSE write backlog exceeded — evicting connection')
          teardown()
          try { stream.close() } catch { /* already gone */ }
          return
        }
        pendingWrites++
        writeQueue = writeQueue
          .then(() =>
            stream.writeSSE({ data, event: 'message' }).catch(() => {
              // stream might be closed
            }),
          )
          .finally(() => { pendingWrites-- })
      },
      close: () => {
        teardown()
        try { stream.close() } catch { /* already gone */ }
      },
      userId: user.id,
    })

    // Send connected event
    await stream.writeSSE({
      data: JSON.stringify({ type: 'connected', connectionId }),
      event: 'connected',
    })

    // Keep connection alive with periodic pings; a failed ping means the
    // socket is dead, so evict the connection (not just stop pinging).
    pingInterval = setInterval(() => {
      stream.writeSSE({
        data: JSON.stringify({ type: 'ping', timestamp: Date.now() }),
        event: 'ping',
      }).catch(() => {
        teardown()
      })
    }, 15000)

    // Wait for disconnect
    stream.onAbort(teardown)

    // Keep stream alive until the client disconnects or the connection is
    // evicted (a never-resolving promise here kept every handler closure
    // alive for the life of the process).
    await done
  })
})

export { sseRoutes }
