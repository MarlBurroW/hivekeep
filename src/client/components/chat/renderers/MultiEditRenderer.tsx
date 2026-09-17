import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'
import { ChevronDown, ChevronRight, FilePen, FileWarning, Loader2 } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

interface EditPair {
  oldText: string
  newText: string
}

/**
 * Rich renderer for multi_edit tool results.
 * Shows each edit as an inline diff hunk (removed lines then added lines),
 * with the file path / language header and the edit count. On failure it
 * surfaces the failing edit index and how many edits were applied before it.
 */
export function MultiEditRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const filePath = typeof res?.path === 'string' ? res.path : typeof args?.path === 'string' ? args.path : null
  const success = res?.success === true
  const language = typeof res?.language === 'string' ? res.language : null
  const editsApplied = typeof res?.editsApplied === 'number' ? res.editsApplied : null
  const error = typeof res?.error === 'string' ? res.error : null
  const failedEditIndex = typeof res?.failedEditIndex === 'number' ? res.failedEditIndex : null

  const edits = Array.isArray(args?.edits) ? (args.edits as EditPair[]) : null

  // Only a real error or a completed-but-unsuccessful result is a failure; an
  // as-yet-unresolved call (no result) is pending, not failed. Mirrors
  // FileEditRenderer / FileWriteRenderer.
  const failed = status === 'error' || error !== null || (result !== undefined && !success)

  if (failed) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
            <FileWarning className="size-3 text-red-400 shrink-0" />
            <span className="min-w-0 truncate text-zinc-400 text-[10px]">{filePath ?? t('tools.renderers.file')}</span>
            <span className="ml-auto shrink-0 text-[10px] text-red-400">{t('tools.renderers.failed')}</span>
          </div>
          <div className="px-3 py-2 text-red-300 break-words">
            {failedEditIndex !== null && (
              <span className="text-red-400 mr-1">#{failedEditIndex + 1}:</span>
            )}
            {error ?? t('tools.renderers.editFailed')}
          </div>
        </div>
      </div>
    )
  }

  if (!success) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
            <Loader2 className="size-3 text-blue-400 shrink-0 animate-spin" />
            <span className="min-w-0 truncate text-zinc-400 text-[10px]">{filePath ?? t('tools.renderers.file')}</span>
            <span className="ml-auto shrink-0 text-[10px] text-blue-400">{t('tools.status.pending', { defaultValue: 'Pending' })}</span>
          </div>
          <div className="px-3 py-2 text-zinc-400 break-words">{t('tools.renderers.editingFile', { defaultValue: 'Preparing edit preview…' })}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
          <FilePen className="size-3 text-zinc-500 shrink-0" />
          <span className="min-w-0 truncate text-zinc-300 text-[10px] font-medium">{filePath}</span>
          {language && <span className="shrink-0 text-[10px] text-zinc-500">{language}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded text-blue-400 bg-blue-500/20">
              {t('tools.renderers.edited')}
            </span>
            {editsApplied !== null && (
              <span className="text-[10px] text-zinc-500">
                {t('tools.renderers.multiEditCount', { count: editsApplied })}
              </span>
            )}
          </div>
        </div>

        {/* Edit hunks */}
        {edits && edits.length > 0 ? (
          <div className="max-h-80 overflow-auto scrollbar-thin py-1">
            {edits.map((edit, idx) => {
              const oldLines = edit.oldText?.split('\n') ?? []
              const newLines = edit.newText?.split('\n') ?? []
              return (
                <div key={idx} className={cn(idx > 0 && 'border-t border-zinc-800/50 mt-1 pt-1')}>
                  <div className="px-3 py-0.5 text-[10px] text-zinc-500 select-none">
                    {t('tools.renderers.multiEditHunk', { index: idx + 1 })}
                  </div>
                  {oldLines.map((line, i) => (
                    <div key={`old-${idx}-${i}`} className="px-3 bg-red-500/10 text-red-300">
                      <span className="select-none inline-block w-4 text-right mr-2 opacity-60">-</span>
                      {line}
                    </div>
                  ))}
                  {newLines.map((line, i) => (
                    <div key={`new-${idx}-${i}`} className="px-3 bg-green-500/10 text-green-300">
                      <span className="select-none inline-block w-4 text-right mr-2 opacity-60">+</span>
                      {line}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="px-3 py-2 text-zinc-500 italic">{t('tools.renderers.fileWritten')}</div>
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
