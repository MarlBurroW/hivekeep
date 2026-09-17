import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'
import { ChevronDown, ChevronRight, FilePen, FileWarning, Loader2 } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

export function FileEditRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const filePath = typeof res?.path === 'string' ? res.path : typeof args?.path === 'string' ? args.path : null
  const success = res?.success === true
  const applied = res?.applied === true
  const oldText = typeof res?.oldText === 'string' ? res.oldText : typeof args?.oldText === 'string' ? args.oldText : null
  const newText = typeof res?.newText === 'string' ? res.newText : typeof args?.newText === 'string' ? args.newText : null
  const language = typeof res?.language === 'string' ? res.language : null
  const editLine = typeof res?.editLine === 'number' ? res.editLine : null
  const error = typeof res?.error === 'string' ? res.error : null

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
          <div className="px-3 py-2 text-red-300 break-words">{error ?? t('tools.renderers.editFailed')}</div>
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

  const oldLines = oldText?.split('\n') ?? []
  const newLines = newText?.split('\n') ?? []

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
            {editLine !== null && (
              <span className="text-[10px] text-zinc-500">{t('tools.renderers.line', { line: editLine })}</span>
            )}
          </div>
        </div>

        {/* Diff view */}
        <div className="max-h-80 overflow-auto scrollbar-thin py-1">
          {/* Removed lines */}
          {oldLines.map((line, i) => (
            <div key={`old-${i}`} className="px-3 bg-red-500/10 text-red-300">
              <span className="select-none inline-block w-4 text-right mr-2 opacity-60">-</span>
              {line}
            </div>
          ))}
          {/* Added lines */}
          {newLines.map((line, i) => (
            <div key={`new-${i}`} className="px-3 bg-green-500/10 text-green-300">
              <span className="select-none inline-block w-4 text-right mr-2 opacity-60">+</span>
              {line}
            </div>
          ))}
        </div>
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
