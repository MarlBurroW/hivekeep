import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Badge } from '@/client/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { Loader2, ListChecks, Clock, UserCheck } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '@/client/lib/time'
import { TicketReporterBadge } from '@/client/components/project/TicketReporterBadge'
import type { TicketSummary } from '@/shared/types'

interface TicketCardProps {
  ticket: TicketSummary
  onClick?: () => void
  isOverlay?: boolean
  /** Lowercased, trimmed search query. When non-empty, matching substrings in
   *  the title and tag labels are wrapped in a `<mark>` for visual feedback. */
  highlightQuery?: string
  /** Called with the tag label when a tag chip is clicked. Used by the kanban
   *  to pre-fill the search filter so the user can pivot from a single tag. */
  onTagClick?: (label: string) => void
}

/**
 * Split a string around case-insensitive occurrences of `query` and wrap matches
 * in `<mark>`. Returns the raw string when `query` is empty or has no match,
 * keeping the call cheap on the common (unfiltered) render path.
 */
function highlightMatches(text: string, query: string) {
  if (!query) return text
  const lowerText = text.toLowerCase()
  const idx = lowerText.indexOf(query)
  if (idx < 0) return text
  const parts: Array<string | { match: string }> = []
  let cursor = 0
  let next = idx
  while (next >= 0) {
    if (next > cursor) parts.push(text.slice(cursor, next))
    parts.push({ match: text.slice(next, next + query.length) })
    cursor = next + query.length
    next = lowerText.indexOf(query, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.map((part, i) =>
    typeof part === 'string' ? (
      <span key={i}>{part}</span>
    ) : (
      <mark
        key={i}
        className="rounded-sm bg-primary/25 px-0.5 text-foreground"
      >
        {part.match}
      </mark>
    ),
  )
}

export function TicketCard({ ticket, onClick, isOverlay = false, highlightQuery, onTagClick }: TicketCardProps) {
  const { t } = useTranslation()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: ticket.id,
    data: { type: 'ticket', ticket },
  })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  // Defensive defaults — SSE / optimistic update paths can occasionally produce
  // partial tickets without these arrays. Falling back to empty values keeps the
  // kanban from crashing instead of failing the whole page.
  const runningKins = ticket.runningKins ?? []
  const tags = ticket.tags ?? []
  const description = ticket.description ?? ''

  const hasRunning = runningKins.length > 0
  const awaitingInput = ticket.awaitingHumanInputCount ?? 0
  const hasAwaitingInput = awaitingInput > 0
  const visibleRunning = runningKins.slice(0, 3)
  const overflowRunning = runningKins.length - visibleRunning.length
  const normalizedQuery = (highlightQuery ?? '').trim().toLowerCase()

  // Short snippet of the description, shown in a tooltip on title hover so users
  // can preview context without opening the side panel. Cap at ~240 chars to keep
  // the tooltip skim-friendly and avoid huge floating boxes.
  const trimmedDescription = description.trim()
  const descriptionPreview =
    trimmedDescription.length > 240
      ? trimmedDescription.slice(0, 240).trimEnd() + '…'
      : trimmedDescription

  // Distinguish created vs. updated: if updated more than 1 minute after creation
  // we treat it as a meaningful edit and prefer surfacing that timestamp.
  const wasEdited = ticket.updatedAt - ticket.createdAt > 60_000
  const displayedTs = wasEdited ? ticket.updatedAt : ticket.createdAt
  const fullDate = new Date(displayedTs).toLocaleString()

  // Click anywhere on the card (except interactive children that stop propagation)
  // opens the side panel. We don't wrap in a <button> anymore so we can render
  // tag chips as their own real buttons (HTML forbids nesting buttons).
  function handleCardClick() {
    onClick?.()
  }
  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }

  return (
    <article
      ref={setNodeRef}
      style={style}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      className={cn(
        'group relative cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm transition-shadow active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && !isOverlay && 'opacity-30',
        // Drag overlay: slight tilt + stronger shadow + ring make the floating
        // card feel like it's been picked up off the board (Trello/Linear vibe).
        isOverlay && 'rotate-2 shadow-xl ring-1 ring-primary/30',
        // Awaiting-input emphasis wins over running: the user needs to act before the
        // task can resume, so we surface that more loudly with a warning-colored ring.
        hasAwaitingInput && 'ring-1 ring-warning/60 shadow-warning/10 animate-running-pulse',
        // Running emphasis (only when no awaiting-input on this ticket).
        hasRunning && !hasAwaitingInput && 'ring-1 ring-primary/40 shadow-primary/10 animate-running-pulse',
      )}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start gap-1.5">
        {ticket.number !== null && ticket.number !== undefined && (
          <span
            className="mt-0.5 shrink-0 font-mono text-[11px] leading-none text-muted-foreground/90"
            aria-label={`Ticket #${ticket.number}`}
            title={`Ticket #${ticket.number}`}
          >
            #{ticket.number}
          </span>
        )}
        {descriptionPreview ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <h3 className="line-clamp-2 flex-1 cursor-help text-sm font-medium leading-snug">
                {highlightMatches(ticket.title, normalizedQuery)}
              </h3>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-sm">
              <p className="whitespace-pre-wrap text-xs leading-relaxed">{descriptionPreview}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          <h3 className="line-clamp-2 flex-1 text-sm font-medium leading-snug">
            {highlightMatches(ticket.title, normalizedQuery)}
          </h3>
        )}
        {ticket.reporter && (
          <TicketReporterBadge reporter={ticket.reporter} variant="compact" size="size-4" />
        )}
      </div>

      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.slice(0, 4).map((tag) => (
            <button
              key={tag.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onTagClick?.(tag.label)
              }}
              className="rounded-md transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={onTagClick ? `Filter by ${tag.label}` : undefined}
            >
              <Badge
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
            </button>
          ))}
          {tags.length > 4 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="secondary"
                  className="cursor-help px-1.5 py-0 text-[10px] font-normal"
                >
                  +{tags.length - 4}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <div className="flex flex-wrap gap-1">
                  {tags.slice(4).map((tag) => (
                    <span
                      key={tag.id}
                      className="rounded px-1.5 py-0.5 text-[10px]"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                      }}
                    >
                      {tag.label}
                    </span>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      )}

        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          {/* Left side: awaiting-input (most urgent) > running > plain task count */}
          {hasAwaitingInput ? (
            <span className="inline-flex items-center gap-1 text-warning">
              <UserCheck className="size-3 animate-pulse" />
              <span className="font-medium">
                {t('projects.ticketCard.awaitingInput', { count: awaitingInput })}
              </span>
            </span>
          ) : hasRunning ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <Loader2 className="size-3 animate-spin" />
              <span className="font-medium">
                {t('projects.ticketCard.running', { count: ticket.runningTaskCount })}
              </span>
            </span>
          ) : ticket.taskCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ListChecks className="size-3" />
              {t('projects.ticketCard.taskCount', { count: ticket.taskCount })}
            </span>
          ) : (
            <span />
          )}

          {/* Right side: running Kins avatar stack OR timestamp.
              When a task is running, the avatars win the slot — the running
              signal is more relevant than age. Otherwise we surface the
              creation/update timestamp with a tooltip carrying the full date. */}
          {hasRunning ? (
            <div
              className="flex items-center -space-x-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              {visibleRunning.map((rk, i) => {
                const initials = rk.kinName.slice(0, 2).toUpperCase()
                return (
                  <Tooltip key={`${rk.taskId}-${i}`}>
                    <TooltipTrigger asChild>
                      <span>
                        <Avatar className="size-5 ring-2 ring-card">
                          {rk.avatarUrl && <AvatarImage src={rk.avatarUrl} alt={rk.kinName} />}
                          <AvatarFallback className="text-[9px] bg-secondary">{initials}</AvatarFallback>
                        </Avatar>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      <span className="text-xs">
                        {t('projects.ticketCard.kinRunning', { name: rk.kinName })}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                )
              })}
              {overflowRunning > 0 && (
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground ring-2 ring-card">
                  +{overflowRunning}
                </span>
              )}
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground/70">
                  <Clock className="size-3" aria-hidden />
                  {formatRelativeTime(displayedTs)}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <span className="text-xs">
                  {t(
                    wasEdited
                      ? 'projects.ticketCard.updatedAt'
                      : 'projects.ticketCard.createdAt',
                    { date: fullDate },
                  )}
                </span>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
    </article>
  )
}
