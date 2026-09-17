import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'
import { ChevronDown, ChevronRight, FilePlus, FilePen, Loader2 } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

function computeUnifiedDiff(oldText: string, newText: string): { type: 'same' | 'add' | 'remove'; line: string }[] {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const result: { type: 'same' | 'add' | 'remove'; line: string }[] = []

  // Simple LCS-based diff
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1]![j - 1]! + 1
        : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }

  // Backtrack
  const ops: { type: 'same' | 'add' | 'remove'; line: string }[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'same', line: oldLines[i - 1]! })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      ops.push({ type: 'add', line: newLines[j - 1]! })
      j--
    } else {
      ops.push({ type: 'remove', line: oldLines[i - 1]! })
      i--
    }
  }

  return ops.reverse()
}

export function FileWriteRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const filePath = typeof res?.path === 'string' ? res.path : typeof args?.path === 'string' ? args.path : null
  const success = res?.success === true
  const created = res?.created === true
  const bytesWritten = typeof res?.bytesWritten === 'number' ? res.bytesWritten : null
  const linesWritten = typeof res?.linesWritten === 'number' ? res.linesWritten : null
  const language = typeof res?.language === 'string' ? res.language : null
  const previousContent = typeof res?.previousContent === 'string' ? res.previousContent : null
  const content = typeof args?.content === 'string' ? args.content : null
  const error = typeof res?.error === 'string' ? res.error : null

  const failed = status === 'error' || error !== null || (result !== undefined && !success)

  if (failed) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
            <FilePen className="size-3 text-red-400 shrink-0" />
            <span className="min-w-0 truncate text-zinc-400 text-[10px]">{filePath ?? t('tools.renderers.file')}</span>
            <span className="ml-auto shrink-0 text-[10px] text-red-400">{t('tools.renderers.error')}</span>
          </div>
          <div className="px-3 py-2 text-red-300 break-words">{error ?? t('tools.renderers.writeFailed')}</div>
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
          <div className="px-3 py-2 text-zinc-400 break-words">{t('tools.renderers.writingFile', { defaultValue: 'Preparing write preview…' })}</div>
        </div>
      </div>
    )
  }

  const Icon = created ? FilePlus : FilePen
  const badge = created ? t('tools.renderers.created') : t('tools.renderers.modified')
  const badgeColor = created ? 'text-green-400 bg-green-500/20' : 'text-amber-400 bg-amber-500/20'

  // Show diff if overwriting
  const showDiff = !created && previousContent !== null && content !== null
  const diffLines = showDiff ? computeUnifiedDiff(previousContent!, content!) : null

  return (
    <div className="space-y-2">
      <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
          <Icon className="size-3 text-zinc-500 shrink-0" />
          <span className="min-w-0 truncate text-zinc-300 text-[10px] font-medium">{filePath}</span>
          {language && <span className="shrink-0 text-[10px] text-zinc-500">{language}</span>}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', badgeColor)}>
              {badge}
            </span>
            {bytesWritten !== null && (
              <span className="text-[10px] text-zinc-500">
                {bytesWritten > 1024 ? t('tools.renderers.bytesKB', { size: (bytesWritten / 1024).toFixed(1) }) : t('tools.renderers.bytesB', { size: bytesWritten })}
                {linesWritten !== null && ` · ${t('tools.renderers.linesWritten', { count: linesWritten })}`}
              </span>
            )}
          </div>
        </div>

        {/* Diff or content */}
        <div className="max-h-80 overflow-auto scrollbar-thin">
          {diffLines ? (
            <div className="py-1">
              {diffLines.map((d, i) => (
                <div
                  key={i}
                  className={cn(
                    'px-3 py-0',
                    d.type === 'add' && 'bg-green-500/10 text-green-300',
                    d.type === 'remove' && 'bg-red-500/10 text-red-300',
                    d.type === 'same' && 'text-zinc-400',
                  )}
                >
                  <span className="select-none inline-block w-4 text-right mr-2 opacity-60">
                    {d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' '}
                  </span>
                  {d.line}
                </div>
              ))}
            </div>
          ) : content ? (
            <pre className="px-3 py-2 whitespace-pre-wrap break-all text-zinc-300">
              {content.length > 5000 ? content.substring(0, 5000) + '\n' + t('tools.renderers.truncated') : content}
            </pre>
          ) : (
            <div className="px-3 py-2 text-zinc-500 italic">{t('tools.renderers.fileWritten')}</div>
          )}
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
