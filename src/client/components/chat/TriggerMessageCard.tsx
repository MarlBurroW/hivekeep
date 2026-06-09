import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Zap, ChevronRight } from 'lucide-react'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { cn } from '@/client/lib/utils'
import { RelativeTimestamp } from '@/client/components/chat/RelativeTimestamp'

interface Props {
  content: string
  timestamp?: string
}

/** Parse "[Trigger \"name\" · account]\n<body>" into its parts. */
function parse(content: string): { name: string; account: string; body: string } {
  const match = content.match(/^\[Trigger\s+"(.+?)"\s+·\s+(.+?)\]\s*\n?([\s\S]*)$/)
  if (!match) return { name: 'trigger', account: '', body: content }
  return { name: match[1] ?? 'trigger', account: match[2] ?? '', body: (match[3] ?? '').trim() }
}

export const TriggerMessageCard = memo(function TriggerMessageCard({ content, timestamp }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { name, account, body } = parse(content)

  return (
    <div className="flex justify-center py-2 animate-fade-in-up">
      <Collapsible open={open} onOpenChange={setOpen} className="w-full max-w-md">
        <div className="surface-card space-y-2 rounded-xl border border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Zap className="size-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-medium text-foreground">{name}</p>
                {timestamp && (
                  <RelativeTimestamp timestamp={timestamp} className="shrink-0 text-[10px] text-muted-foreground/70" />
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {t('chat.trigger.received')}{account ? ` · ${account}` : ''}
              </p>
            </div>
          </div>

          {body.length > 0 && (
            <>
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ChevronRight className={cn('size-3 shrink-0 transition-transform duration-200', open && 'rotate-90')} />
                <span>{t('chat.trigger.showDetails')}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-1 rounded-lg bg-muted/80 p-3">
                  <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{body}</pre>
                </div>
              </CollapsibleContent>
            </>
          )}
        </div>
      </Collapsible>
    </div>
  )
})
