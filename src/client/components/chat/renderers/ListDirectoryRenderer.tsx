import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FileText, FolderSearch, Loader2 } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import type { ToolResultRendererProps } from '@/client/lib/tool-renderers'

interface DirEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
  children?: DirEntry[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function TreeEntry({ entry, depth }: { entry: DirEntry; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const isDir = entry.type === 'directory'
  const hasChildren = isDir && entry.children && entry.children.length > 0

  return (
    <div>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-0.5 hover:bg-zinc-800/50 rounded-sm cursor-default',
          isDir && hasChildren && 'cursor-pointer',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="size-3 text-zinc-500 flex-shrink-0" />
          ) : (
            <ChevronRight className="size-3 text-zinc-500 flex-shrink-0" />
          )
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}

        {isDir ? (
          expanded ? (
            <FolderOpen className="size-3.5 text-amber-400 flex-shrink-0" />
          ) : (
            <Folder className="size-3.5 text-amber-400 flex-shrink-0" />
          )
        ) : (
          <FileText className="size-3.5 text-zinc-500 flex-shrink-0" />
        )}

        <span className={cn('min-w-0 truncate text-xs', isDir ? 'text-zinc-200 font-medium' : 'text-zinc-400')}>
          {entry.name}
        </span>

        {entry.size !== undefined && (
          <span className="ml-auto shrink-0 text-[10px] text-zinc-600 tabular-nums">{formatSize(entry.size)}</span>
        )}
      </div>

      {expanded && entry.children?.map((child, i) => (
        <TreeEntry key={`${child.name}-${i}`} entry={child} depth={depth + 1} />
      ))}
    </div>
  )
}

export function ListDirectoryRenderer({ args, result, status }: ToolResultRendererProps) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)

  const res = result as Record<string, unknown> | null | undefined
  const success = res?.success === true
  const dirPath = typeof res?.path === 'string' ? res.path : typeof args?.path === 'string' ? args.path : '.'
  const entries = Array.isArray(res?.entries) ? (res.entries as DirEntry[]) : null
  const error = typeof res?.error === 'string' ? res.error : null

  // Only a real error or a completed-but-unsuccessful result is a failure; an
  // as-yet-unresolved call (no result) is pending, not failed. Mirrors
  // FileEditRenderer / FileWriteRenderer.
  const failed = status === 'error' || error !== null || (result !== undefined && !success)

  if (failed) {
    return (
      <div className="space-y-2">
        <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
            <FolderSearch className="size-3 text-red-400 shrink-0" />
            <span className="min-w-0 truncate text-zinc-400 text-[10px]">{dirPath}</span>
            <span className="ml-auto shrink-0 text-[10px] text-red-400">{t('tools.renderers.error')}</span>
          </div>
          <div className="px-3 py-2 text-red-300 break-words">{error ?? t('tools.renderers.failedToListDirectory')}</div>
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
            <span className="min-w-0 truncate text-zinc-400 text-[10px]">{dirPath}</span>
            <span className="ml-auto shrink-0 text-[10px] text-blue-400">{t('tools.status.pending', { defaultValue: 'Pending' })}</span>
          </div>
          <div className="px-3 py-2 text-zinc-400 break-words">{t('tools.renderers.listingDirectory', { defaultValue: 'Preparing directory listing…' })}</div>
        </div>
      </div>
    )
  }

  if (!entries) {
    return (
      <>
        <JsonViewer data={args} label={t('tools.renderers.input')} maxHeight="max-h-40" />
        {result !== undefined && <JsonViewer data={result} label={t('tools.renderers.output')} maxHeight="max-h-60" />}
      </>
    )
  }

  const fileCount = entries.filter(e => e.type === 'file').length
  const dirCount = entries.filter(e => e.type === 'directory').length

  return (
    <div className="space-y-2">
      <div className="rounded-md bg-zinc-950 text-zinc-100 text-xs font-mono overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 border-b border-zinc-800">
          <Folder className="size-3 text-amber-400 shrink-0" />
          <span className="min-w-0 truncate text-zinc-300 text-[10px] font-medium">{dirPath}</span>
          <span className="ml-auto shrink-0 text-[10px] text-zinc-500 whitespace-nowrap">
            {dirCount > 0 && t('tools.renderers.dirCount', { count: dirCount })}
            {dirCount > 0 && fileCount > 0 && ' · '}
            {fileCount > 0 && t('tools.renderers.fileCount', { count: fileCount })}
          </span>
        </div>

        {/* Tree */}
        <div className="max-h-80 overflow-auto scrollbar-thin py-1">
          {entries.length === 0 ? (
            <div className="px-3 py-2 text-zinc-500 italic">{t('tools.renderers.emptyDirectory')}</div>
          ) : (
            entries.map((entry, i) => (
              <TreeEntry key={`${entry.name}-${i}`} entry={entry} depth={0} />
            ))
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
