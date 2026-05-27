import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Edit2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Info,
  Loader2,
  Sparkles,
  User as UserIcon,
  X,
  Clock,
  Calendar,
  Hash,
  FileText,
} from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Badge } from '@/client/components/ui/badge'
import {
  Card,
  CardContent,
  CardHeader,
  CardFooter,
} from '@/client/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/client/components/ui/tooltip'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { EmptyState } from '@/client/components/common/EmptyState'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { useProjectKnowledge, useProjectKnowledgeMutations } from '@/client/hooks/useProjectKnowledge'
import { getErrorMessage } from '@/client/lib/api'
import { timeAgo } from '@/client/lib/time'
import { cn } from '@/client/lib/utils'
import type { ProjectKnowledge } from '@/shared/types'

interface Props {
  projectId: string
}

type FilterPin = 'all' | 'pinned' | 'unpinned'

const PAGE_SIZE = 20

/** Format an absolute timestamp for the tooltip behind a relative date. */
function formatAbsolute(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ProjectKnowledgePanel({ projectId }: Props) {
  const { t } = useTranslation()

  const [query, setQuery] = useState('')
  const [filterPin, setFilterPin] = useState<FilterPin>('all')
  const [page, setPage] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ProjectKnowledge | null>(null)
  const [helpOpen, setHelpOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('projectKnowledge.helpDismissed') !== 'true'
  })
  // Pinned cards default-expanded (their body is in every Kin's prompt
  // anyway, hiding it would be misleading). Unpinned default-collapsed.
  // The set stores ids whose default state has been toggled.
  const [toggledIds, setToggledIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    setPage(0)
  }, [query, filterPin, projectId])

  const filters = useMemo(
    () => ({
      q: query.trim() || undefined,
      pinned: filterPin === 'pinned' ? true : filterPin === 'unpinned' ? false : undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    }),
    [query, filterPin, page],
  )

  const { entries, total, mode, isLoading, refetch } = useProjectKnowledge(projectId, filters)
  const showPagination = mode === 'list' && total > PAGE_SIZE
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasMore = page < pageCount - 1
  // Spinner shown both during request and during debounce — instant feedback.
  const trimmedQuery = query.trim()
  const showSearchSpinner = !!trimmedQuery && (isLoading || trimmedQuery !== (filters.q ?? ''))

  useEffect(() => {
    if (mode === 'list' && !isLoading && page > 0 && page >= pageCount) {
      setPage(pageCount - 1)
    }
  }, [mode, isLoading, page, pageCount])

  const { create, update, remove, togglePin } = useProjectKnowledgeMutations(projectId)
  const pinnedCount = entries.filter((e) => e.pinned).length

  function isExpanded(entry: ProjectKnowledge): boolean {
    const toggled = toggledIds.has(entry.id)
    return entry.pinned ? !toggled : toggled
  }

  function toggleExpand(id: string) {
    setToggledIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function dismissHelp() {
    setHelpOpen(false)
    if (typeof window !== 'undefined') {
      localStorage.setItem('projectKnowledge.helpDismissed', 'true')
    }
  }

  async function handleCreate(input: { title: string; content: string; category: string | null; pinned: boolean }) {
    try {
      await create(input)
      toast.success(t('projects.knowledge.toast.created'))
      await refetch()
      setEditorOpen(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
      throw err
    }
  }

  async function handleUpdate(
    id: string,
    input: { title: string; content: string; category: string | null; pinned: boolean },
  ) {
    try {
      await update(id, input)
      toast.success(t('projects.knowledge.toast.updated'))
      await refetch()
      setEditorOpen(false)
      setEditing(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
      throw err
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t('projects.knowledge.confirmDelete'))) return
    try {
      await remove(id)
      toast.success(t('projects.knowledge.toast.deleted'))
      await refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  async function handleTogglePin(entry: ProjectKnowledge) {
    try {
      await togglePin(entry.id, !entry.pinned)
      await refetch()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/30 px-4 py-3 backdrop-blur-sm">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('projects.knowledge.searchPlaceholder')}
            className="pl-9 pr-9"
          />
          {showSearchSpinner ? (
            <Loader2 className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-primary" />
          ) : query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t('projects.knowledge.clearSearch')}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center rounded-md border border-border bg-background p-0.5">
          {(['all', 'pinned', 'unpinned'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setFilterPin(opt)}
              disabled={!!filters.q && opt !== 'all'}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                filterPin === opt
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                !!filters.q && opt !== 'all' && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
              )}
            >
              {t(`projects.knowledge.filter.${opt}`)}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          onClick={() => {
            setEditing(null)
            setEditorOpen(true)
          }}
          className="gap-1.5"
        >
          <Plus className="size-4" />
          {t('projects.knowledge.add')}
        </Button>
      </div>

      {/* ── Help banner ─────────────────────────────────────────────────── */}
      {helpOpen && (
        <div className="relative border-b border-border bg-gradient-to-r from-primary/5 via-primary/[0.07] to-transparent px-4 py-3">
          <div className="flex items-start gap-3 pr-8">
            <div className="rounded-full bg-primary/10 p-1.5">
              <Info className="size-4 text-primary" />
            </div>
            <div className="flex-1 space-y-1.5 text-sm">
              <p className="font-semibold">{t('projects.knowledge.help.title')}</p>
              <p className="text-xs text-muted-foreground">
                <Badge className="gradient-primary mr-1.5 border-0 text-white">
                  <Pin className="size-2.5" />
                  {t('projects.knowledge.help.pinnedLead')}
                </Badge>
                {t('projects.knowledge.help.pinned')}
              </p>
              <p className="text-xs text-muted-foreground">
                <Badge variant="secondary" className="mr-1.5">
                  {t('projects.knowledge.help.unpinnedLead')}
                </Badge>
                {t('projects.knowledge.help.unpinned')}
              </p>
              <p className="pt-0.5 text-[11px] italic text-muted-foreground/80">
                {t('projects.knowledge.help.scope')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismissHelp}
            className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t('common.dismiss')}
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* ── Stats strip ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-border bg-muted/20 px-4 py-2 text-xs">
        <div className="flex items-center gap-4 text-muted-foreground">
          {mode === 'search' ? (
            <span className="inline-flex items-center gap-1.5">
              <Search className="size-3" />
              <span className="font-medium text-foreground">
                {t('projects.knowledge.searchResults', { count: entries.length, total })}
              </span>
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <FileText className="size-3" />
                <span className="font-medium text-foreground">
                  {t('projects.knowledge.totalCount', { count: total })}
                </span>
              </span>
              {pinnedCount > 0 && (
                <span className="inline-flex items-center gap-1.5 text-primary">
                  <Pin className="size-3 fill-current" />
                  <span className="font-medium">
                    {t('projects.knowledge.pinnedCount', { count: pinnedCount })}
                  </span>
                </span>
              )}
            </>
          )}
        </div>
        {!helpOpen && (
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Info className="size-3" />
            {t('projects.knowledge.help.show')}
          </button>
        )}
      </div>

      {/* ── List + pagination ───────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden surface-base">
        <div className="flex-1 overflow-auto">
          {isLoading && entries.length === 0 ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2, 3].map((i) => (
                <KnowledgeSkeleton key={i} delayMs={i * 100} />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={mode === 'search' ? Search : Sparkles}
                title={mode === 'search' ? t('projects.knowledge.empty.searchTitle') : t('projects.knowledge.empty.title')}
                description={
                  mode === 'search'
                    ? t('projects.knowledge.empty.searchDescription')
                    : t('projects.knowledge.empty.description')
                }
                actionLabel={mode === 'search' ? undefined : t('projects.knowledge.add')}
                onAction={mode === 'search' ? undefined : () => setEditorOpen(true)}
              />
            </div>
          ) : (
            <ul className="space-y-3 p-4">
              {entries.map((entry) => (
                <KnowledgeCard
                  key={entry.id}
                  entry={entry}
                  expanded={isExpanded(entry)}
                  onToggleExpand={() => toggleExpand(entry.id)}
                  onTogglePin={() => handleTogglePin(entry)}
                  onEdit={() => {
                    setEditing(entry)
                    setEditorOpen(true)
                  }}
                  onDelete={() => handleDelete(entry.id)}
                />
              ))}
            </ul>
          )}
        </div>

        {showPagination && (
          <div className="flex items-center justify-between border-t border-border bg-card/30 px-4 py-2 text-xs backdrop-blur-sm">
            <span className="text-muted-foreground">
              {t('projects.knowledge.pagination', {
                from: page * PAGE_SIZE + 1,
                to: Math.min((page + 1) * PAGE_SIZE, total),
                total,
              })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={page === 0 || isLoading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="size-4" />
                {t('common.previous')}
              </Button>
              <span className="px-2 tabular-nums text-muted-foreground">
                {page + 1} / {pageCount}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!hasMore || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('common.next')}
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <KnowledgeEditorDialog
        open={editorOpen}
        editing={editing}
        onOpenChange={(open) => {
          setEditorOpen(open)
          if (!open) setEditing(null)
        }}
        onSubmit={async (input) => {
          if (editing) {
            await handleUpdate(editing.id, input)
          } else {
            await handleCreate(input)
          }
        }}
      />
    </div>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────

function KnowledgeSkeleton({ delayMs = 0 }: { delayMs?: number }) {
  return (
    <Card className="overflow-hidden" style={{ animationDelay: `${delayMs}ms` }}>
      <div className="animate-pulse">
        <CardHeader className="gap-3">
          <div className="flex items-center gap-2">
            <div className="h-5 w-16 rounded-full bg-muted" />
            <div className="h-5 w-20 rounded-full bg-muted" />
            <div className="ml-auto h-5 w-24 rounded bg-muted" />
          </div>
          <div className="h-5 w-3/4 rounded bg-muted" />
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="h-3 w-full rounded bg-muted" />
            <div className="h-3 w-5/6 rounded bg-muted" />
            <div className="h-3 w-2/3 rounded bg-muted" />
          </div>
        </CardContent>
        <CardFooter className="gap-3 border-t pt-3">
          <div className="h-3 w-20 rounded bg-muted" />
          <div className="h-3 w-24 rounded bg-muted" />
          <div className="ml-auto h-3 w-16 rounded bg-muted" />
        </CardFooter>
      </div>
    </Card>
  )
}

// ── Card ───────────────────────────────────────────────────────────────

interface CardProps {
  entry: ProjectKnowledge
  expanded: boolean
  onToggleExpand: () => void
  onTogglePin: () => void
  onEdit: () => void
  onDelete: () => void
}

function KnowledgeCard({ entry, expanded, onToggleExpand, onTogglePin, onEdit, onDelete }: CardProps) {
  const { t } = useTranslation()
  // Treat created==updated as a single date display; otherwise show "updated"
  // as the primary timestamp since that's what governs the prompt freshness.
  const wasEdited = entry.updatedAt > entry.createdAt + 1000

  return (
    <li>
      <Card
        className={cn(
          'group relative gap-0 overflow-hidden py-0 transition-all card-hover',
          entry.pinned && 'surface-card gradient-border',
        )}
      >
        <CardHeader className="gap-3 px-5 pt-5">
          {/* Top row: pinned + category + author + actions */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              {entry.pinned && (
                <Badge className="gradient-primary border-0 text-white">
                  <Pin className="size-3 fill-white" />
                  {t('projects.knowledge.pinnedBadge')}
                </Badge>
              )}
              {entry.category && (
                <Badge variant="secondary" className="font-medium">
                  {entry.category}
                </Badge>
              )}
              <Badge variant="outline" className="gap-1 font-normal">
                {entry.authorKinName ? (
                  <>
                    <Sparkles className="size-2.5 text-primary" />
                    {t('projects.knowledge.byKin', { name: entry.authorKinName })}
                  </>
                ) : (
                  <>
                    <UserIcon className="size-2.5" />
                    {t('projects.knowledge.byUser')}
                  </>
                )}
              </Badge>
            </div>

            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon" variant="ghost" className="size-7" onClick={onTogglePin}>
                    {entry.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {entry.pinned ? t('projects.knowledge.unpin') : t('projects.knowledge.pin')}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon" variant="ghost" className="size-7" onClick={onEdit}>
                    <Edit2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('projects.knowledge.edit')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 hover:bg-destructive/10 hover:text-destructive"
                    onClick={onDelete}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('projects.knowledge.delete')}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Title — clickable */}
          <button
            type="button"
            onClick={onToggleExpand}
            className="flex w-full items-start gap-2 text-left transition-colors hover:text-primary"
            aria-expanded={expanded}
          >
            <ChevronDown
              className={cn(
                'mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-200',
                expanded ? '' : '-rotate-90',
              )}
            />
            <h3 className="flex-1 text-base font-semibold leading-snug">{entry.title}</h3>
          </button>
        </CardHeader>

        {/* Body */}
        {expanded && entry.content.trim().length > 0 && (
          <CardContent className="px-5 pb-0 pt-1">
            <div className="ml-6 rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
              <MarkdownContent content={entry.content} className="text-sm" />
            </div>
          </CardContent>
        )}

        {/* Footer: metadata */}
        <CardFooter className="mt-4 gap-4 border-t bg-muted/10 px-5 py-2.5 text-[11px] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1.5">
                {wasEdited ? <Clock className="size-3" /> : <Calendar className="size-3" />}
                {wasEdited
                  ? t('projects.knowledge.metadata.updated', { time: timeAgo(entry.updatedAt) })
                  : t('projects.knowledge.metadata.created', { time: timeAgo(entry.createdAt) })}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-0.5 text-xs">
                <div>
                  {t('projects.knowledge.metadata.createdAt', { date: formatAbsolute(entry.createdAt) })}
                </div>
                {wasEdited && (
                  <div>
                    {t('projects.knowledge.metadata.updatedAt', { date: formatAbsolute(entry.updatedAt) })}
                  </div>
                )}
              </div>
            </TooltipContent>
          </Tooltip>

          <span className="inline-flex items-center gap-1.5">
            <FileText className="size-3" />
            {t('projects.knowledge.metadata.chars', { count: entry.content.length })}
          </span>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(entry.id)
                  toast.success(t('projects.knowledge.metadata.idCopied'))
                }}
                className="ml-auto inline-flex items-center gap-1.5 font-mono transition-colors hover:text-foreground"
              >
                <Hash className="size-3" />
                {entry.id.slice(0, 8)}
              </button>
            </TooltipTrigger>
            <TooltipContent>{t('projects.knowledge.metadata.copyId')}</TooltipContent>
          </Tooltip>
        </CardFooter>
      </Card>
    </li>
  )
}

// ── Editor dialog ──────────────────────────────────────────────────────

interface EditorProps {
  open: boolean
  editing: ProjectKnowledge | null
  onOpenChange: (open: boolean) => void
  onSubmit: (input: { title: string; content: string; category: string | null; pinned: boolean }) => Promise<void>
}

function KnowledgeEditorDialog({ open, editing, onOpenChange, onSubmit }: EditorProps) {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [category, setCategory] = useState('')
  const [pinned, setPinned] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (open) {
      setTitle(editing?.title ?? '')
      setContent(editing?.content ?? '')
      setCategory(editing?.category ?? '')
      setPinned(editing?.pinned ?? false)
      setIsSubmitting(false)
    }
  }, [open, editing])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (isSubmitting) return
    const trimmedTitle = title.trim()
    const trimmedContent = content.trim()
    if (!trimmedTitle || !trimmedContent) return
    setIsSubmitting(true)
    try {
      await onSubmit({
        title: trimmedTitle,
        content: trimmedContent,
        category: category.trim() || null,
        pinned,
      })
    } catch {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isSubmitting && !next) return
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('projects.knowledge.dialog.editTitle') : t('projects.knowledge.dialog.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('projects.knowledge.dialog.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-3">
            <div className="space-y-1.5">
              <Label htmlFor="pk-title">{t('projects.knowledge.dialog.titleLabel')}</Label>
              <Input
                id="pk-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t('projects.knowledge.dialog.titlePlaceholder')}
                required
                maxLength={200}
              />
              <p className="text-xs text-muted-foreground">
                {t('projects.knowledge.dialog.titleHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pk-content">{t('projects.knowledge.dialog.contentLabel')}</Label>
              <MarkdownEditor value={content} onChange={setContent} height="260px" />
              <p className="text-xs text-muted-foreground">
                {t('projects.knowledge.dialog.contentHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pk-category">{t('projects.knowledge.dialog.categoryLabel')}</Label>
              <Input
                id="pk-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder={t('projects.knowledge.dialog.categoryPlaceholder')}
              />
            </div>
            <div
              className={cn(
                'space-y-2 rounded-lg border p-3 transition-colors',
                pinned ? 'border-primary/40 bg-primary/5' : 'border-border',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="pk-pinned" className="flex cursor-pointer items-center gap-2 font-medium">
                  <Pin className={cn('size-3.5', pinned && 'fill-primary text-primary')} />
                  {t('projects.knowledge.dialog.pinnedLabel')}
                </Label>
                <Switch id="pk-pinned" checked={pinned} onCheckedChange={setPinned} />
              </div>
              <p className="text-xs text-muted-foreground">
                {pinned
                  ? t('projects.knowledge.dialog.pinnedOnHint')
                  : t('projects.knowledge.dialog.pinnedOffHint')}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !title.trim() || !content.trim()}
            >
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {editing ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
