/**
 * In-memory ring buffer for platform logs.
 * Captures Pino log entries so Agents can query recent system logs via the
 * `get_platform_logs` tool. No DB overhead — entries are ephemeral.
 */

const DEFAULT_MAX_SIZE = 2000

export interface LogEntry {
  level: string
  module: string
  message: string
  data?: Record<string, unknown>
  timestamp: number
}

export interface LogQueryOptions {
  level?: string
  module?: string
  search?: string
  minutesAgo?: number
  limit?: number
}

/** Pino numeric level → label mapping */
const LEVEL_LABELS: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
}

/** Fields to strip from the `data` payload (Pino internal + already extracted) */
const EXCLUDED_KEYS = new Set([
  'level',
  'time',
  'msg',
  'module',
  'pid',
  'hostname',
])

class LogStore {
  private buffer: LogEntry[] = []
  private maxSize: number
  private onEntry?: (entry: LogEntry) => void

  constructor(maxSize?: number) {
    this.maxSize = maxSize ?? DEFAULT_MAX_SIZE
  }

  /** Register a callback invoked on every new entry (used for SSE broadcast). */
  setOnEntry(cb: (entry: LogEntry) => void): void {
    this.onEntry = cb
  }

  /** Return unique module names currently in the buffer. */
  getModules(): string[] {
    const modules = new Set<string>()
    for (const e of this.buffer) {
      modules.add(e.module)
    }
    return Array.from(modules).sort()
  }

  /** Push a raw Pino JSON log line into the buffer. */
  pushRaw(raw: string): void {
    try {
      const parsed = JSON.parse(raw)
      const entry: LogEntry = {
        level: LEVEL_LABELS[parsed.level] ?? 'info',
        module: parsed.module ?? 'root',
        message: parsed.msg ?? '',
        timestamp: parsed.time
          ? new Date(parsed.time).getTime()
          : Date.now(),
      }

      // This ring is readable by platform tools as well as the admin UI. Keep
      // private-session text, provider errors and previews out of that shared
      // surface; the original operational record still goes to the server log.
      if (typeof parsed.sessionId === 'string' && parsed.sessionId) {
        entry.message = 'Private session activity (details omitted)'
        delete parsed.sessionId
        for (const key of Object.keys(parsed)) {
          if (!EXCLUDED_KEYS.has(key) && key !== 'agentId') delete parsed[key]
        }
      }

      // Collect extra fields as data
      const data: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (!EXCLUDED_KEYS.has(k)) {
          data[k] = v
        }
      }
      if (Object.keys(data).length > 0) {
        entry.data = data
      }

      this.buffer.push(entry)
      if (this.buffer.length > this.maxSize) {
        this.buffer.splice(0, this.buffer.length - this.maxSize)
      }

      if (this.onEntry) {
        try { this.onEntry(entry) } catch { /* ignore */ }
      }
    } catch {
      // Ignore unparseable lines (e.g. pino startup)
    }
  }

  /** Query the buffer with optional filters. Returns newest entries last. */
  query(opts: LogQueryOptions = {}): LogEntry[] {
    const limit = Math.min(opts.limit ?? 50, 200)
    let results = this.buffer

    if (opts.level) {
      results = results.filter((e) => e.level === opts.level)
    }
    if (opts.module) {
      const mod = opts.module.toLowerCase()
      results = results.filter((e) => e.module.toLowerCase().includes(mod))
    }
    if (opts.search) {
      const q = opts.search.toLowerCase()
      results = results.filter(
        (e) =>
          e.message.toLowerCase().includes(q) ||
          (e.data && JSON.stringify(e.data).toLowerCase().includes(q)),
      )
    }
    if (opts.minutesAgo) {
      const since = Date.now() - opts.minutesAgo * 60_000
      results = results.filter((e) => e.timestamp >= since)
    }

    return results.slice(-limit)
  }
}

export const logStore = new LogStore(
  Number(process.env.PLATFORM_LOG_BUFFER_SIZE) || DEFAULT_MAX_SIZE,
)
