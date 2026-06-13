import type { SSEEvent } from '@/server/sse/types'
import { createLogger } from '@/server/logger'

const log = createLogger('sse')

type SSEWriter = {
  write: (data: string) => void
  close: () => void
  userId: string
}

/** A tap receives every event the manager fans out (in-process observers). */
export type SSETap = (event: SSEEvent, scope: { kind: 'broadcast' | 'user' | 'agent'; userId?: string }) => void

class SSEManager {
  private connections = new Map<string, SSEWriter>()
  /** In-process observers of the event stream (e.g. mini-app event subscriptions). */
  private taps = new Set<SSETap>()

  /**
   * Observe every event the manager fans out to clients, in-process. Returns an
   * unsubscribe function. Used by mini-app backends to react to platform events
   * (the tap mirrors the exact catalogue already sent over SSE). Taps must never
   * throw or block — they are called synchronously after client fan-out.
   */
  addTap(tap: SSETap): () => void {
    this.taps.add(tap)
    return () => { this.taps.delete(tap) }
  }

  private notifyTaps(event: SSEEvent, scope: { kind: 'broadcast' | 'user' | 'agent'; userId?: string }): void {
    for (const tap of this.taps) {
      try { tap(event, scope) } catch { /* a tap must never break fan-out */ }
    }
  }

  /**
   * Register a new SSE connection for a user.
   */
  addConnection(connectionId: string, writer: SSEWriter): void {
    this.connections.set(connectionId, writer)
    log.info({ connectionId, userId: writer.userId, total: this.connections.size }, 'SSE connection opened')
  }

  /**
   * Remove a connection when the client disconnects.
   */
  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId)
    log.info({ connectionId, total: this.connections.size }, 'SSE connection closed')
  }

  /**
   * Send an event to all connected clients.
   */
  broadcast(event: SSEEvent): void {
    const payload = formatSSE(event)
    for (const [, writer] of this.connections) {
      try {
        writer.write(payload)
      } catch {
        // Connection might be closed
      }
    }
    this.notifyTaps(event, { kind: 'broadcast' })
  }

  /**
   * Send an event to a specific user's connections.
   */
  sendToUser(userId: string, event: SSEEvent): void {
    const payload = formatSSE(event)
    for (const [, writer] of this.connections) {
      if (writer.userId === userId) {
        try {
          writer.write(payload)
        } catch {
          // Connection might be closed
        }
      }
    }
    this.notifyTaps(event, { kind: 'user', userId })
  }

  /**
   * Send an event to all clients that care about a specific agentId.
   * For now, broadcast to all — future: track which clients are watching which agents.
   */
  sendToAgent(agentId: string, event: SSEEvent): void {
    const payload = formatSSE({ ...event, agentId })
    for (const [, writer] of this.connections) {
      try {
        writer.write(payload)
      } catch {
        // Connection might be closed
      }
    }
    this.notifyTaps({ ...event, agentId }, { kind: 'agent' })
  }

  get connectionCount(): number {
    return this.connections.size
  }
}

function formatSSE(event: SSEEvent): string {
  return JSON.stringify({ type: event.type, agentId: event.agentId, ...event.data })
}

export const sseManager = new SSEManager()
