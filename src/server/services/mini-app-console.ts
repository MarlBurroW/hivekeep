/**
 * In-memory ring buffer for mini-app console entries.
 * Console messages are forwarded from the iframe SDK → parent → server via POST.
 * Kins can retrieve them via the get_mini_app_console tool.
 */

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error'
  args: string[]
  stack: string | null
  timestamp: number
}

const BUFFER_MAX = 50
const buffers = new Map<string, ConsoleEntry[]>()

/** Last time the app's entry HTML was served (i.e. the iframe (re)loaded), keyed by appId. */
const lastServedAt = new Map<string, number>()

export function pushConsoleEntry(appId: string, entry: ConsoleEntry): void {
  let buf = buffers.get(appId)
  if (!buf) {
    buf = []
    buffers.set(appId, buf)
  }
  buf.push(entry)
  if (buf.length > BUFFER_MAX) buf.shift()
}

export function getConsoleEntries(appId: string, level?: string): ConsoleEntry[] {
  const buf = buffers.get(appId) ?? []
  if (level) return buf.filter((e) => e.level === level)
  return [...buf]
}

export function clearConsoleEntries(appId: string): void {
  buffers.delete(appId)
}

/** Record that the app's entry HTML was just served (called from the /serve route). */
export function markServed(appId: string): void {
  lastServedAt.set(appId, Date.now())
}

/** Get the last serve timestamp (ms) for an app, or null if it was never served. */
export function getServedAt(appId: string): number | null {
  return lastServedAt.get(appId) ?? null
}
