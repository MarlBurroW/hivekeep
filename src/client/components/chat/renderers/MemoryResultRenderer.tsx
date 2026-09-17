import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, BrainCircuit, Pin, AlertTriangle } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

interface MemoryResultItem {
  id?: string
  content?: string
  title?: string
  subject?: string
  category?: string
  importance?: number | string
  scope?: string
  authorAgentName?: string
  age?: string
  score?: number
  pinned?: boolean
  updatedAt?: number
}

/**
 * Renderer for memory lookup results (recall). Hits arrive under one of
 * several keys (memories / results / entries); each is rendered as a compact
 * card with title/snippet and metadata badges. Falls back to JsonViewer for
 * unexpected shapes.
 */
export function MemoryResultRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const error = typeof res?.error === 'string' ? res.error : null

  // The four tools each use a different array key.
  const items: MemoryResultItem[] | null =
    (Array.isArray(res?.memories) ? (res!.memories as MemoryResultItem[]) : null) ??
    (Array.isArray(res?.results) ? (res!.results as MemoryResultItem[]) : null) ??
    (Array.isArray(res?.chunks) ? (res!.chunks as MemoryResultItem[]) : null) ??
    (Array.isArray(res?.entries) ? (res!.entries as MemoryResultItem[]) : null)

  const query = typeof args.query === 'string' ? args.query : null

  // Unexpected shape → fall back to JSON.
  if (!items && !error && status !== 'error') {
    return (
      <>
        <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
        {result !== undefined && <JsonViewer data={result} label={t('tools.renderers.output')} maxHeight="max-h-60" />}
      </>
    )
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-border overflow-hidden text-xs">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border/50">
          <BrainCircuit className="size-3 text-muted-foreground shrink-0" />
          {query && <span className="min-w-0 text-foreground truncate font-medium">{query}</span>}
          {items && (
            <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">
              {t('tools.renderers.memoryResults', { count: items.length })}
            </span>
          )}
        </div>

        {/* Error */}
        {(error || status === 'error') && (
          <div className="flex items-start gap-2 px-3 py-2 text-destructive">
            <AlertTriangle className="size-3 mt-0.5 shrink-0" />
            <span className="break-all">{error ?? t('tools.renderers.error')}</span>
          </div>
        )}

        {/* Items */}
        {items && items.length > 0 && (
          <ul className="divide-y divide-border/40 max-h-96 overflow-auto scrollbar-thin">
            {items.map((it, i) => {
              const heading = it.title || it.subject || null
              const scorePct = typeof it.score === 'number' ? Math.round(it.score * 100) : null
              const updated = typeof it.updatedAt === 'number'
                ? new Date(it.updatedAt).toLocaleDateString()
                : null
              return (
                <li key={it.id ?? i} className="px-3 py-2 space-y-1">
                  <div className="flex items-start gap-2">
                    {it.pinned && <Pin className="size-3 mt-0.5 shrink-0 text-primary fill-primary/20" />}
                    <div className="flex-1 min-w-0">
                      {heading && <div className="font-medium text-foreground truncate">{heading}</div>}
                      {it.content && (
                        <p className={cn('text-[11px] text-muted-foreground', heading ? 'line-clamp-2' : 'line-clamp-3')}>
                          {it.content}
                        </p>
                      )}
                    </div>
                    {scorePct !== null && (
                      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                        {t('tools.renderers.memoryMatch', { score: scorePct })}
                      </span>
                    )}
                  </div>
                  {/* Metadata badges */}
                  {(it.category || it.scope || it.importance !== undefined || it.authorAgentName || it.age || updated) && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/70">
                      {it.category && <span className="rounded bg-muted px-1 py-0.5">{it.category}</span>}
                      {it.scope && <span className="rounded bg-muted px-1 py-0.5">{it.scope}</span>}
                      {it.importance !== undefined && (
                        <span className="rounded bg-muted px-1 py-0.5">★ {String(it.importance)}</span>
                      )}
                      {it.authorAgentName && <span>{it.authorAgentName}</span>}
                      {it.age && <span>{it.age}</span>}
                      {updated && <span>{updated}</span>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {items && items.length === 0 && !error && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('tools.renderers.memoryNoResults')}</div>
        )}
      </div>

      {/* Raw toggle */}
      <button
        type="button"
        onClick={() => setShowRaw(!showRaw)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        {showRaw ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {t('tools.renderers.rawJson')}
      </button>

      {showRaw && (
        <>
          <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
          {result !== undefined && <JsonViewer data={result} label={t('tools.renderers.output')} maxHeight="max-h-60" />}
        </>
      )}
    </div>
  )
}
