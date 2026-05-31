import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/client/components/ui/collapsible'
import { Loader2, Archive, CheckCircle2, ChevronRight, Brain, AlertTriangle } from 'lucide-react'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import { cn } from '@/client/lib/utils'
import { RelativeTimestamp } from '@/client/components/chat/RelativeTimestamp'

interface CompactingCardProps {
  status: 'running' | 'done' | 'error'
  summary: string | null
  memoriesExtracted: number | null
  messageCount?: number
  cycle?: number
  estimatedTotal?: number
  error?: string
  timestamp?: string
}

export const CompactingCard = memo(function CompactingCard({
  status,
  summary,
  memoriesExtracted,
  messageCount,
  cycle,
  estimatedTotal,
  error,
  timestamp,
}: CompactingCardProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const isRunning = status === 'running'
  const isError = status === 'error'

  return (
    <div className="flex justify-center py-2 animate-fade-in-up">
      <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-md">
        <div
          className={cn(
            'surface-card rounded-xl border p-4 space-y-2 transition-colors duration-300',
            isRunning && 'border-primary/30',
            isError && 'border-destructive/30',
            !isRunning && !isError && 'border-border',
          )}
        >
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg',
              isError ? 'bg-destructive/10' : 'bg-primary/10',
            )}>
              {isRunning ? (
                <Loader2 className="size-4 text-primary animate-spin" />
              ) : isError ? (
                <AlertTriangle className="size-4 text-destructive" />
              ) : (
                <Archive className="size-4 text-primary" />
              )}
            </div>

            <div className="min-w-0 flex-1">
            {timestamp && (
              <RelativeTimestamp timestamp={timestamp} className="float-right text-[10px] text-muted-foreground/70 mt-0.5" />
            )}
              <p className="text-sm font-medium text-foreground">
                {t('chat.compacting.title')}
              </p>
              <div className="mt-0.5 flex items-center gap-1.5">
                {isRunning ? (
                  <span className="text-xs font-medium text-primary">
                    {cycle != null && cycle > 1
                      ? t('chat.compacting.runningCycle', { cycle })
                      : t('chat.compacting.running')}
                  </span>
                ) : isError ? (
                  <span className="text-xs font-medium text-destructive">
                    {t('chat.compacting.error')}
                  </span>
                ) : (
                  <>
                    <CheckCircle2 className="size-3 shrink-0 text-success" />
                    <span className="text-xs font-medium text-success">
                      {t('chat.compacting.done')}
                    </span>
                    {messageCount != null && messageCount > 0 && (
                      <>
                        <span className="text-[10px] text-muted-foreground">·</span>
                        <Archive className="size-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground">
                          {t('chat.compacting.messages', { count: messageCount })}
                        </span>
                      </>
                    )}
                    {memoriesExtracted != null && memoriesExtracted > 0 && (
                      <>
                        <span className="text-[10px] text-muted-foreground">·</span>
                        <Brain className="size-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground">
                          {t('chat.compacting.memories', { count: memoriesExtracted })}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
              {isError && error && (
                <p className="mt-1 text-[10px] text-muted-foreground truncate">
                  {error === 'NOTHING_TO_COMPACT' ? t('chat.compacting.nothingToCompact') : error}
                </p>
              )}
            </div>
          </div>

          {/* Indeterminate progress bar while running */}
          {isRunning && (
            <div className="h-0.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full animate-indeterminate-progress rounded-full bg-primary/50" />
            </div>
          )}

          {/* Collapsible summary when done */}
          {!isRunning && !isError && summary && (
            <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 transition-transform duration-200',
                  open && 'rotate-90',
                )}
              />
              <span>{t('chat.compacting.showSummary')}</span>
            </CollapsibleTrigger>
          )}

          <CollapsibleContent>
            {summary && (
              <div className="mt-1 rounded-lg bg-muted/80 p-3">
                <div className="text-xs leading-relaxed text-foreground">
                  <MarkdownContent content={summary} isUser={false} />
                </div>
              </div>
            )}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  )
})
