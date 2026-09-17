import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { Input } from '@/client/components/ui/input'
import { Checkbox } from '@/client/components/ui/checkbox'
import { Badge } from '@/client/components/ui/badge'
import { Pause, Play, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'

interface LogEntry {
  level: string
  module: string
  message: string
  data?: Record<string, unknown>
  timestamp: number
}

const LEVEL_COLORS: Record<string, string> = {
  trace: 'bg-muted text-muted-foreground',
  debug: 'bg-muted text-muted-foreground',
  info: 'bg-blue-500/20 text-blue-400',
  warn: 'bg-yellow-500/20 text-yellow-400',
  error: 'bg-red-500/20 text-red-400',
  fatal: 'bg-red-700/30 text-red-300',
}

const LEVELS = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal']

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  })
}

function LogEntryRow({ entry }: { entry: LogEntry }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const hasData = entry.data && Object.keys(entry.data).length > 0

  return (
    <div className="flex flex-col border-b border-border/30 py-0.5 px-2 hover:bg-muted/30 font-mono text-xs leading-5">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-muted-foreground/60 w-[85px]">
          {formatTimestamp(entry.timestamp)}
        </span>
        <Badge
          variant="secondary"
          className={`shrink-0 text-[10px] px-1.5 py-0 font-medium uppercase w-[42px] text-center justify-center ${LEVEL_COLORS[entry.level] || ''}`}
        >
          {entry.level}
        </Badge>
        <span className="shrink-0 text-primary/70 w-[120px] truncate" title={entry.module}>
          {entry.module}
        </span>
        <span className="flex-1 break-all">{entry.message}</span>
        {hasData && (
          <button
            onClick={() => setExpanded(!expanded)}
            aria-label={t(expanded ? 'common.hideDetails' : 'common.showDetails')}
            aria-expanded={expanded}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        )}
      </div>
      {expanded && hasData && (
        <pre className="ml-0 sm:ml-[230px] mt-1 mb-1 text-[10px] text-muted-foreground bg-muted/50 rounded p-2 overflow-x-auto max-h-40">
          {JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function LogsSettings() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [modules, setModules] = useState<string[]>([])
  const [levelFilter, setLevelFilter] = useState('all')
  const [moduleFilter, setModuleFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [paused, setPaused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)

  // Keep ref in sync
  pausedRef.current = paused

  // Initial load
  useEffect(() => {
    api.get<{ logs: LogEntry[] }>('/logs?limit=200').then((res) => {
      setLogs(res.logs)
    }).catch(() => {})
    api.get<{ modules: string[] }>('/logs/modules').then((res) => {
      setModules(res.modules)
    }).catch(() => {})
  }, [])

  // SSE real-time
  useSSE({
    'log:entry': useCallback((data: Record<string, unknown>) => {
      if (pausedRef.current) return
      const entry = data as unknown as LogEntry
      setLogs((prev) => {
        const next = [...prev, entry]
        return next.length > 500 ? next.slice(-500) : next
      })
      // Update modules list if new module
      if (entry.module) {
        setModules((prev) => {
          if (prev.includes(entry.module)) return prev
          return [...prev, entry.module].sort()
        })
      }
    }, []),
  })

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  // Detect manual scroll up to disable auto-scroll
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (!atBottom && autoScroll) setAutoScroll(false)
    if (atBottom && !autoScroll) setAutoScroll(true)
  }, [autoScroll])

  // Filter logs
  const filtered = logs.filter((entry) => {
    if (levelFilter !== 'all' && entry.level !== levelFilter) return false
    if (moduleFilter !== 'all' && entry.module !== moduleFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (
        !entry.message.toLowerCase().includes(q) &&
        !entry.module.toLowerCase().includes(q)
      ) return false
    }
    return true
  })

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">{t('settings.logs.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('settings.logs.description')}</p>
      </div>

      {/* Filters bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger className="w-full sm:w-[130px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {l === 'all' ? t('settings.logs.allLevels') : l.toUpperCase()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={moduleFilter} onValueChange={setModuleFilter}>
          <SelectTrigger className="w-full sm:w-[160px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.logs.allModules')}</SelectItem>
            {modules.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          placeholder={t('settings.logs.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-[180px] h-8 text-xs"
        />

        <div className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto sm:ml-auto">
          <span className="text-xs text-muted-foreground">
            {t('settings.logs.entries', { count: filtered.length })}
          </span>

          <div className="flex items-center gap-1">
            <Checkbox
              id="auto-scroll"
              checked={autoScroll}
              onCheckedChange={(v) => setAutoScroll(!!v)}
            />
            <label htmlFor="auto-scroll" className="text-xs cursor-pointer">
              {t('settings.logs.autoScroll')}
            </label>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setPaused(!paused)}
          >
            {paused ? <Play className="size-3.5 mr-1" /> : <Pause className="size-3.5 mr-1" />}
            {paused ? t('settings.logs.resume') : t('settings.logs.pause')}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setLogs([])}
          >
            <Trash2 className="size-3.5 mr-1" />
            {t('settings.logs.clear')}
          </Button>
        </div>
      </div>

      {/* Log container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="glass-strong h-[60vh] min-h-[300px] max-h-[400px] overflow-y-auto rounded-lg border"
      >
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            {t('settings.logs.noLogs')}
          </div>
        ) : (
          filtered.map((entry, i) => <LogEntryRow key={`${entry.timestamp}-${i}`} entry={entry} />)
        )}
      </div>
    </div>
  )
}
