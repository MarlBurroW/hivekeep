import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, ChevronRight, Download, Folder, FolderOpen, Loader2, Paperclip, Plus, RefreshCw, Search, Upload, X } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/client/components/ui/sheet'
import { useWorkspaceFiles, parentDirOf } from '@/client/hooks/useWorkspaceFiles'
import { useWorkspaceFileSearch } from '@/client/hooks/useWorkspaceFileSearch'
import { getErrorMessage } from '@/client/lib/api'
import { formatFileSize, getFileIcon } from '@/client/lib/file-icons'
import { workspaceRawUrl } from '@/client/lib/workspace-source'
import { cn } from '@/client/lib/utils'

interface ChatWorkspaceFilesProps {
  agentId: string
  agentName?: string
  disabled?: boolean
  isPrivate?: boolean
  onInsert: (paths: string[]) => void
  onFocusComposer: () => void
  onAttachPrivateFile: () => void
}

/** Only mount the browser while open: no workspace requests for an idle chat. */
export function ChatWorkspaceFiles(props: ChatWorkspaceFilesProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const focusComposer = useRef(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          disabled={props.disabled}
          className="h-10 shrink-0 gap-1.5 rounded-lg px-2 text-xs font-normal text-muted-foreground hover:text-foreground sm:h-8"
          aria-label={t('chat.workspaceFiles.open')}
          title={t('chat.workspaceFiles.open')}
        >
          <FolderOpen className="size-4" />
          {t('files.tree.title')}
        </Button>
      </SheetTrigger>
      <SheetContent
        className="w-full sm:w-[460px] sm:max-w-[calc(100vw-2rem)]"
        showCloseButton={false}
        // Portalled sheet events still bubble through the composer in React.
        onDragEnter={(event) => event.stopPropagation()}
        onDragLeave={(event) => event.stopPropagation()}
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation() }}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation() }}
        onCloseAutoFocus={(event) => {
          if (focusComposer.current) {
            event.preventDefault()
            props.onFocusComposer()
            focusComposer.current = false
          }
        }}
      >
        <SheetHeader className="gap-2 border-b pr-16 pb-4">
          <span className="text-xs text-muted-foreground">{t('chat.workspaceFiles.scope')}</span>
          <SheetTitle className="break-words text-lg">{t('chat.workspaceFiles.title', { name: props.agentName ?? 'Agent' })}</SheetTitle>
          <SheetDescription>{t('chat.workspaceFiles.description')}</SheetDescription>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="absolute top-3 right-3 size-11" aria-label={t('common.close')}>
              <X className="size-4" />
            </Button>
          </SheetClose>
        </SheetHeader>
        {open && <WorkspaceBrowser
          {...props}
          onInsert={(paths) => {
            props.onInsert(paths)
            focusComposer.current = true
            setOpen(false)
          }}
          onAttachPrivateFile={() => {
            focusComposer.current = true
            setOpen(false)
            props.onAttachPrivateFile()
          }}
        />}
      </SheetContent>
    </Sheet>
  )
}

function WorkspaceBrowser({ agentId, isPrivate, disabled, onInsert, onAttachPrivateFile }: ChatWorkspaceFilesProps) {
  const { t } = useTranslation()
  const source = useMemo(() => ({ type: 'agent' as const, id: agentId }), [agentId])
  const workspace = useWorkspaceFiles(source)
  const [directory, setDirectory] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const uploadLock = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const searching = query.trim().length > 0
  const search = useWorkspaceFileSearch({ source, query: query.trim(), enabled: searching, limit: 50 })
  const state = workspace.dirs[directory]
  const entries = searching ? search.hits.map((hit) => ({ ...hit, type: 'file' as const })) : state?.entries ?? []
  const loading = searching ? search.isLoading : !state || state.isLoading
  const error = searching ? search.error : state?.error

  const refresh = () => searching ? search.refresh() : void workspace.loadDir(directory)
  const openDirectory = (path: string) => {
    setDirectory(path)
    setQuery('')
    void workspace.loadDir(path)
  }
  const toggle = (path: string) => setSelected((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })

  const upload = async (files: File[]) => {
    if (!files.length || uploadLock.current || isPrivate || disabled) return
    uploadLock.current = true
    setIsUploading(true)
    setUploadError(null)
    setUploadNotice(null)
    try {
      const result = await workspace.uploadFiles(directory, files)
      if (!active.current) return
      // Use the server's final paths, including collision suffixes.
      setSelected((previous) => new Set([...previous, ...result.files.map((file) => file.path)]))
      setQuery('')
      if (result.files.length) setUploadNotice(t('chat.workspaceFiles.uploaded', { count: result.files.length }))
      if (result.errors.length) setUploadError(t('chat.workspaceFiles.uploadErrors', { names: result.errors.map((file) => file.name).join(', ') }))
    } catch (err) {
      if (active.current) setUploadError(getErrorMessage(err))
    } finally {
      uploadLock.current = false
      if (active.current) setIsUploading(false)
    }
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col gap-4"
      onDragEnter={(event) => {
        if (isPrivate || disabled || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = isPrivate || disabled || isUploading ? 'none' : 'copy'
      }}
      onDragLeave={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragDepth.current = 0
        setDragging(false)
        void upload(Array.from(event.dataTransfer.files))
      }}
    >
      {dragging && <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/95 p-6 text-center text-sm font-medium">{t('chat.workspaceFiles.drop', { directory: directory || t('chat.workspaceFiles.root') })}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 px-4 pb-3">
          {isPrivate ? (
            <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">{t('chat.workspaceFiles.privateHint')}</p>
              <Button variant="outline" className="h-11 w-full" disabled={disabled} onClick={onAttachPrivateFile}>
                <Paperclip className="size-4" />{t('chat.workspaceFiles.attachPrivate')}
              </Button>
            </div>
          ) : (
            <>
              <input ref={input} type="file" multiple className="hidden" aria-label={t('chat.workspaceFiles.upload')} onChange={(event) => {
                void upload(Array.from(event.target.files ?? []))
                event.target.value = ''
              }} />
              <Button variant="outline" className="h-11 w-full" disabled={isUploading || disabled} onClick={() => input.current?.click()}>
                {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {t(isUploading ? 'chat.workspaceFiles.uploading' : 'chat.workspaceFiles.upload')}
              </Button>
              <p className="break-words text-xs text-muted-foreground">{t('chat.workspaceFiles.destination', { directory: directory || t('chat.workspaceFiles.root') })}</p>
            </>
          )}
          {uploadError && <p role="alert" className="break-words text-sm text-destructive">{uploadError}</p>}
          <p role="status" className={cn('text-xs text-muted-foreground', !uploadNotice && 'sr-only')}>{uploadNotice}</p>
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('chat.workspaceFiles.search')} aria-label={t('chat.workspaceFiles.search')} className="h-11 pr-10 pl-9" />
              {query && <Button variant="ghost" size="icon" className="absolute top-0 right-0 h-11 w-9" aria-label={t('chat.workspaceFiles.clearSearch')} onClick={() => setQuery('')}><X className="size-4" /></Button>}
            </div>
            <Button variant="ghost" size="icon" className="size-11 shrink-0" onClick={refresh} disabled={loading} aria-label={t('files.refresh')}>
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
          </div>
          <nav aria-label={t('chat.workspaceFiles.location')} className="flex items-center gap-1 text-xs">
            <Button variant="ghost" size="icon" className="size-11 shrink-0" disabled={(!directory && !searching) || isUploading} onClick={() => openDirectory(searching ? directory : parentDirOf(directory))} aria-label={t('chat.workspaceFiles.up')}><ArrowLeft className="size-4" /></Button>
            <Button variant="ghost" className="h-11 shrink-0 px-2 text-xs" disabled={isUploading} onClick={() => openDirectory('')}><Folder className="size-4" />{t('chat.workspaceFiles.root')}</Button>
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-muted-foreground" title={directory}>{searching ? t('chat.workspaceFiles.allFiles') : directory || t('chat.workspaceFiles.scope')}</span>
          </nav>
        </div>

        <div className="border-t px-2 py-2" aria-busy={loading}>
          {error ? (
            <div role="alert" className="space-y-3 p-4 text-center">
              <p className="text-sm text-destructive">{t('files.tree.loadError')}</p>
              <Button variant="outline" className="h-11" onClick={refresh}>{t('common.retry')}</Button>
            </div>
          ) : loading ? (
            <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('common.loading')}</div>
          ) : !entries.length ? (
            <div className="space-y-2 px-4 py-8 text-center">
              <FolderOpen className="mx-auto size-8 text-muted-foreground/60" />
              <p className="text-sm">{t(searching ? 'files.search.noResults' : 'chat.workspaceFiles.empty')}</p>
              {!searching && !isPrivate && <p className="text-xs text-muted-foreground">{t('chat.workspaceFiles.emptyHint')}</p>}
            </div>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => {
                const isDirectory = entry.type === 'dir'
                const Icon = isDirectory ? Folder : getFileIcon(entry.name)
                const checked = selected.has(entry.path)
                return <li key={entry.path} className={cn('flex min-w-0 items-center rounded-lg', checked && 'bg-primary/10')}>
                  <button
                    type="button"
                    className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    aria-label={entry.path}
                    aria-pressed={isDirectory ? undefined : checked}
                    disabled={isDirectory && isUploading}
                    title={entry.path}
                    onClick={() => isDirectory ? openDirectory(entry.path) : toggle(entry.path)}
                  >
                    {!isDirectory && <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded border', checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50')}>{checked && <Check className="size-3" />}</span>}
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{entry.name}</span>
                      {searching && <span className="block truncate text-xs text-muted-foreground">{entry.path}</span>}
                    </span>
                    {isDirectory ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : <span className="shrink-0 text-[11px] text-muted-foreground">{formatFileSize(entry.size)}</span>}
                  </button>
                  {!isDirectory && <Button asChild variant="ghost" size="icon" className="size-11 shrink-0 text-muted-foreground"><a href={workspaceRawUrl(source, entry.path)} download={entry.name} aria-label={t('chat.workspaceFiles.download', { name: entry.name })}><Download className="size-4" /></a></Button>}
                </li>
              })}
            </ul>
          )}
          {searching && entries.length === 50 && <p className="p-3 text-xs text-muted-foreground">{t('chat.workspaceFiles.refine')}</p>}
        </div>
      </div>

      <div className="shrink-0 space-y-3 border-t px-4 pt-3 pb-4">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <span aria-live="polite" className="text-xs text-muted-foreground">{t('chat.workspaceFiles.selected', { count: selected.size })}</span>
          {!!selected.size && <Button variant="ghost" className="h-9 px-2 text-xs" onClick={() => setSelected(new Set())}>{t('chat.workspaceFiles.clearSelection')}</Button>}
        </div>
        {!!selected.size && <ul className="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
          {[...selected].map((path) => <li key={path} className="min-w-0 max-w-full"><button type="button" className="flex min-h-9 max-w-full items-center gap-2 rounded-md border px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => toggle(path)} title={path} aria-label={t('chat.workspaceFiles.remove', { path })}><span className="truncate">{path}</span><X className="size-3 shrink-0" /></button></li>)}
        </ul>}
        <Button className="h-11 w-full" disabled={!selected.size || isUploading || disabled} onClick={() => onInsert([...selected])}>
          <Plus className="size-4" />{t('chat.workspaceFiles.insert')}
        </Button>
      </div>
    </div>
  )
}
