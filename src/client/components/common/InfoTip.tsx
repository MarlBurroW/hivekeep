import { CircleHelp } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/client/components/ui/tooltip'
import { cn } from '@/client/lib/utils'

interface InfoTipProps {
  content: string
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}

/**
 * Small help icon (?) with a tooltip on hover.
 * Place next to a Label to explain what a field does.
 */
export function InfoTip({ content, className, side = 'top' }: InfoTipProps) {
  return (
    <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={content}
          className={cn(
            'inline-flex items-center justify-center text-muted-foreground/60 transition-colors hover:text-muted-foreground',
            className,
          )}
        >
          <CircleHelp className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-64">
        {content}
      </TooltipContent>
    </Tooltip>
    </TooltipProvider>
  )
}
