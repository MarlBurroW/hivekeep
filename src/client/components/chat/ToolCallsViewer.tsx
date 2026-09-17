import React from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { Button } from '@/client/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { X, SearchX, Wrench } from 'lucide-react'
import { ToolCallItem } from '@/client/components/chat/ToolCallItem'
import type { ToolCallViewItem } from '@/client/hooks/useToolCalls'

interface ToolCallsViewerProps {
  /** Opens the agent's available-tools listing (the composer badge's modal). */
  onShowAvailableTools?: () => void
  toolCalls: ToolCallViewItem[]
  toolCallCount: number
  onClose: () => void
}

export const ToolCallsViewer = React.memo(function ToolCallsViewer({ toolCalls, toolCallCount, onClose, onShowAvailableTools }: ToolCallsViewerProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full min-w-80 flex-col border-l bg-background/80 backdrop-blur-sm lg:min-w-96">
      {/* Panel header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{t('tools.viewer.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('tools.viewer.description', { count: toolCallCount })}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          {onShowAvailableTools && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label={t('tools.viewer.showAvailable', 'View available tools')} variant="ghost" size="icon-xs" onClick={onShowAvailableTools}>
                  <Wrench className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('tools.viewer.showAvailable', 'View available tools')}</TooltipContent>
            </Tooltip>
          )}
          <Button aria-label={t('common.close')} variant="ghost" size="icon-xs" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {toolCallCount === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 animate-fade-in">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-muted">
            <SearchX className="size-7 text-muted-foreground" />
          </div>
          <p className="text-sm text-muted-foreground text-center">
            {t('tools.viewer.empty')}
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-0.5 px-1 py-2">
            {toolCalls.map((tc) => (
              <ToolCallItem key={tc.id} toolCall={tc} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
})
