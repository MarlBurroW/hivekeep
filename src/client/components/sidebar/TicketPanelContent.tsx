import { useState, useRef, useLayoutEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTicket, useTickets } from '@/client/hooks/useTickets'
import { useProject } from '@/client/hooks/useProjects'
import { useTicketComments } from '@/client/hooks/useTicketComments'
import { useAuth } from '@/client/hooks/useAuth'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { MessageSquare, Play, ListChecks, Loader2, X, ChevronLeft, Pencil, Sparkles, ChevronDown, ChevronUp, Timer } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { EmptyState } from '@/client/components/common/EmptyState'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { TaskTimelineItem } from '@/client/components/common/TaskTimelineItem'
import { useSidePanel } from '@/client/contexts/SidePanelContext'
import { formatRelativeTime, formatDurationMs, computeDurationMs } from '@/client/lib/time'
import { useNow } from '@/client/hooks/useNow'
import { StartTaskDialog } from '@/client/components/project/StartTaskDialog'
import { EnrichTicketDialog } from '@/client/components/project/EnrichTicketDialog'
import { EditTicketModal } from '@/client/components/project/EditTicketModal'
import { TicketReporterBadge } from '@/client/components/project/TicketReporterBadge'
import { TicketCommentsList } from '@/client/components/project/TicketCommentsList'
import { TicketCommentForm } from '@/client/components/project/TicketCommentForm'
import { TicketAttachmentsSection } from '@/client/components/project/TicketAttachmentsSection'
import { getErrorMessage } from '@/client/lib/api'
import { toast } from 'sonner'
import type { TicketTaskSummary } from '@/shared/types'

const COMMENTS_COLLAPSED_COUNT = 3

interface TicketPanelContentProps {
  ticketId: string
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  backlog: 'projects.status.backlog',
  todo: 'projects.status.todo',
  in_progress: 'projects.status.in_progress',
  blocked: 'projects.status.blocked',
  done: 'projects.status.done',
}

export function TicketPanelContent({ ticketId }: TicketPanelContentProps) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { ticket, isLoading } = useTicket(ticketId)
  const { project } = useProject(ticket?.projectId ?? null)
  const { updateTicket, deleteTicket } = useTickets(ticket?.projectId ?? null)
  const { closeTicket, activeTicket, openTask } = useSidePanel()
  const {
    comments,
    isLoading: commentsLoading,
    createComment,
    updateComment,
    deleteComment,
  } = useTicketComments(ticketId)
  const [startTaskOpen, setStartTaskOpen] = useState(false)
  const [enrichOpen, setEnrichOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [showAllComments, setShowAllComments] = useState(false)

  // Server returns comments oldest-first; flip for a Jira-style "newest at top"
  // feed so the panel surfaces what just happened without scrolling.
  const orderedComments = useMemo(
    () => [...comments].sort((a, b) => b.createdAt - a.createdAt),
    [comments],
  )
  const visibleComments = showAllComments
    ? orderedComments
    : orderedComments.slice(0, COMMENTS_COLLAPSED_COUNT)
  const hiddenCount = orderedComments.length - visibleComments.length

  const parent = activeTicket?.parent

  // Detect an in-flight enrichment so we can disable the button + show a hint.
  const RUNNING_STATUSES = new Set([
    'queued',
    'pending',
    'in_progress',
    'paused',
    'awaiting_human_input',
    'awaiting_kin_response',
  ])
  const enrichmentRunning = !!ticket?.tasks?.some(
    (tk) => tk.kind === 'enrich' && RUNNING_STATUSES.has(tk.status as string),
  )

  // Shared 1s clock for live task-duration counters in the history list. Ticks
  // only while at least one task on this ticket is still running, and while the
  // ticket itself sits in the in_progress column (for the header timer).
  const hasActiveTask = !!ticket?.tasks?.some((tk) => RUNNING_STATUSES.has(tk.status as string))
  const ticketInProgress = ticket?.status === 'in_progress' && ticket?.inProgressAt != null
  const nowMs = useNow(hasActiveTask || ticketInProgress)
  const ticketInProgressMs = ticketInProgress
    ? computeDurationMs(ticket?.inProgressAt ?? null, null, nowMs)
    : null
  const ticketInProgressDuration = ticketInProgressMs != null ? formatDurationMs(ticketInProgressMs) : null

  if (isLoading && !ticket) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  if (!ticket) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('projects.ticket.panel.notFound')}</p>
        <Button variant="ghost" onClick={closeTicket}>
          {t('common.close')}
        </Button>
      </div>
    )
  }

  function handleTaskClick(task: TicketTaskSummary) {
    openTask({
      taskId: task.id,
      kinName: task.parentKinName,
      kinAvatarUrl: task.parentKinAvatarUrl,
      parent: { type: 'ticket', id: ticket!.id },
    })
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {parent && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => {
              if (parent.type === 'task') {
                openTask({ taskId: parent.id })
              }
            }}
            title={t('projects.ticket.panel.back', { type: parent.type })}
          >
            <ChevronLeft className="size-4" />
          </Button>
        )}
        <h2 className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('projects.ticket.panel.heading')}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setEnrichOpen(true)}
          disabled={enrichmentRunning}
          title={
            enrichmentRunning
              ? t('projects.enrich.alreadyRunning')
              : t('projects.enrich.action')
          }
        >
          {enrichmentRunning ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setEditOpen(true)}
          title={t('projects.ticket.panel.editAction')}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={closeTicket}
          title={t('common.close')}
        >
          <X className="size-3.5" />
        </Button>
      </header>

      {/* Body — read-only */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Title */}
        <h1 className="mb-2 text-base font-semibold leading-tight">{ticket.title}</h1>

        {/* Reporter (created by ...) + created date */}
        {(ticket.reporter || ticket.createdAt) && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t('projects.reporter.label')}</span>
            {ticket.reporter ? (
              <TicketReporterBadge reporter={ticket.reporter} variant="full" />
            ) : (
              <span className="italic">{t('projects.reporter.unknown')}</span>
            )}
            <span>·</span>
            <span>{formatRelativeTime(ticket.createdAt)}</span>
          </div>
        )}

        {/* Status + tags */}
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-xs">
            {t(STATUS_LABEL_KEYS[ticket.status] ?? ticket.status)}
          </Badge>
          {/* Live "in progress since" timer — only while the ticket sits in the
              in_progress column, measured from when it last entered it. */}
          {ticketInProgressDuration && (
            <Badge
              variant="outline"
              className="gap-1 text-xs tabular-nums border-primary/40 bg-primary/10 text-primary"
              title={t('projects.ticketCard.inProgressSince', {
                date: new Date(ticket.inProgressAt as number).toLocaleString(),
              })}
            >
              <Timer className="size-3 animate-pulse" />
              {ticketInProgressDuration}
            </Badge>
          )}
          {ticket.tags.map((tag) => (
            <Badge
              key={tag.id}
              variant="secondary"
              className="px-1.5 py-0 text-[10px] font-normal"
              style={{
                backgroundColor: `${tag.color}20`,
                color: tag.color,
                borderColor: `${tag.color}40`,
              }}
            >
              {tag.label}
            </Badge>
          ))}
        </div>

        {/* Description */}
        <section className="mb-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('projects.ticket.panel.description')}
          </h3>
          {ticket.description.trim() ? (
            <CollapsibleDescription content={ticket.description} />
          ) : (
            <p className="text-sm italic text-muted-foreground">
              {t('projects.ticket.panel.noDescription')}
            </p>
          )}
        </section>

        {/* Attachments */}
        <TicketAttachmentsSection ticketId={ticket.id} />

        {/* Comments — newest first, top 3 collapsed */}
        <section className="mb-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <MessageSquare className="size-3.5" />
            {t('projects.ticket.comments.title')}
            {orderedComments.length > 0 && (
              <span className="text-muted-foreground/70">({orderedComments.length})</span>
            )}
          </h3>

          {user && (
            <div className="mb-3">
              <TicketCommentForm onSubmit={(content) => createComment(content)} />
            </div>
          )}

          <TicketCommentsList
            comments={visibleComments}
            isLoading={commentsLoading}
            currentUserId={user?.id ?? null}
            onUpdate={(commentId, content) => updateComment(commentId, content)}
            onDelete={(commentId) => deleteComment(commentId)}
          />

          {orderedComments.length > COMMENTS_COLLAPSED_COUNT && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowAllComments((v) => !v)}
            >
              {showAllComments ? (
                <>
                  <ChevronUp className="size-3" />
                  {t('projects.ticket.comments.showLess')}
                </>
              ) : (
                <>
                  <ChevronDown className="size-3" />
                  {t('projects.ticket.comments.showAll', { count: hiddenCount })}
                </>
              )}
            </Button>
          )}
        </section>

        {/* Tasks history */}
        <section>
          <header className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <ListChecks className="size-3.5" />
              {t('projects.ticket.panel.tasksHistory', { count: ticket.tasks.length })}
            </h3>
            <Button size="sm" onClick={() => setStartTaskOpen(true)}>
              <Play className="mr-1 size-3" />
              {t('projects.ticket.panel.startTask')}
            </Button>
          </header>

          {ticket.tasks.length === 0 ? (
            <EmptyState
              compact
              icon={Play}
              title={t('projects.ticket.panel.noTasksTitle')}
              description={t('projects.ticket.panel.noTasksDescription')}
              actionLabel={t('projects.ticket.panel.startTask')}
              onAction={() => setStartTaskOpen(true)}
            />
          ) : (
            <ul className="space-y-0">
              {ticket.tasks.map((task, i) => {
                const isFinished = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled'
                const runMs = computeDurationMs(
                  task.startedAt,
                  isFinished ? task.endedAt : null,
                  nowMs,
                )
                const runDuration = runMs != null ? formatDurationMs(runMs) : null
                return (
                  <li key={task.id}>
                    <TaskTimelineItem
                      status={task.status}
                      primary={task.parentKinName}
                      secondary={t(`projects.taskStatus.${task.status}`, { defaultValue: task.status })}
                      time={runDuration ?? formatRelativeTime(task.createdAt)}
                      isLast={i === ticket.tasks.length - 1}
                      onClick={() => handleTaskClick(task)}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <StartTaskDialog
        open={startTaskOpen}
        onOpenChange={setStartTaskOpen}
        ticketId={ticket.id}
        projectId={ticket.projectId}
      />

      <EnrichTicketDialog
        open={enrichOpen}
        onOpenChange={setEnrichOpen}
        ticketId={ticket.id}
        projectId={ticket.projectId}
      />

      {project && (
        <EditTicketModal
          open={editOpen}
          onOpenChange={setEditOpen}
          ticket={ticket}
          availableTags={project.tags}
          onSave={async (input) => {
            try {
              await updateTicket(ticket.id, input)
            } catch (err) {
              toast.error(getErrorMessage(err))
              throw err
            }
          }}
          onDelete={async () => {
            await deleteTicket(ticket.id)
            closeTicket()
          }}
        />
      )}
    </div>
  )
}

/**
 * Collapsible markdown description with a "show more" affordance.
 *
 * Defaults to a clamped height (~20 lines) and lets the user expand on demand
 * so the tasks history stays visible without scrolling on long descriptions.
 */
function CollapsibleDescription({ content }: { content: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [needsClamp, setNeedsClamp] = useState(false)
  const innerRef = useRef<HTMLDivElement | null>(null)

  // ~20 lines @ 1.5 line-height with text-sm (14px) ≈ 420px. Stay slightly
  // under to make the gradient hint noticeable without hiding too much.
  const MAX_PX = 420

  useLayoutEffect(() => {
    if (!innerRef.current) return
    setNeedsClamp(innerRef.current.scrollHeight > MAX_PX + 4)
  }, [content])

  return (
    <div className="text-sm text-foreground">
      <div
        className={cn('relative overflow-hidden')}
        style={!expanded && needsClamp ? { maxHeight: `${MAX_PX}px` } : undefined}
      >
        <div ref={innerRef}>
          <MarkdownContent content={content} isUser={false} />
        </div>
        {needsClamp && !expanded && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent"
            aria-hidden="true"
          />
        )}
      </div>
      {needsClamp && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3" />
              {t('projects.ticket.panel.descriptionCollapse')}
            </>
          ) : (
            <>
              <ChevronDown className="size-3" />
              {t('projects.ticket.panel.descriptionExpand')}
            </>
          )}
        </Button>
      )}
    </div>
  )
}
