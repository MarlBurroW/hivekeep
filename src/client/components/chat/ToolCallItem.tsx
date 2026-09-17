import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/client/components/ui/collapsible'
import { ChevronRight, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { getToolDomainMeta } from '@/client/lib/tool-domain-lookup'
import { useCustomToolMeta } from '@/client/lib/custom-tool-names'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import { CustomToolRenderer } from '@/client/components/chat/CustomToolRenderer'
import { getRenderer, getPreviewRenderer } from '@/client/lib/tool-renderers'
import { getToolCallsDefaultOpen } from '@/client/lib/tool-call-prefs'
import type { ToolCallViewItem, ToolCallStatus } from '@/client/hooks/useToolCalls'

const STATUS_ICONS: Record<ToolCallStatus, typeof CheckCircle2> = {
  pending: Loader2,
  success: CheckCircle2,
  error: XCircle,
}

const STATUS_CLASSES: Record<ToolCallStatus, string> = {
  pending: 'text-muted-foreground animate-spin',
  success: 'text-success',
  error: 'text-destructive',
}

interface ToolCallItemProps {
  toolCall: ToolCallViewItem
}

export const ToolCallItem = memo(function ToolCallItem({ toolCall }: ToolCallItemProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(getToolCallsDefaultOpen)

  const meta = getToolDomainMeta(toolCall.domain)
  const StatusIcon = STATUS_ICONS[toolCall.status]
  const statusClass = STATUS_CLASSES[toolCall.status]
  const isError = toolCall.status === 'error'

  const CustomRenderer = getRenderer(toolCall.name)
  // Custom tools (custom_<slug>) carry user/Agent-authored localized names — prefer
  // those over the static i18n key so the chat shows a human name, not the slug.
  // The reactive store re-renders this component when the cache hydrates/refreshes
  // so a session-new tool (or a newly added renderer) appears without a reload.
  const isCustomTool = toolCall.name.startsWith('custom_')
  const { name: customName } = useCustomToolMeta(toolCall.name)
  // A custom tool MAY ship a server-bundled React result renderer. We attempt it
  // for ANY custom tool and let CustomToolRenderer fall back to the JSON viewer
  // (via its ErrorBoundary) when the tool ships no renderer. We deliberately do
  // NOT gate on a cached `hasRenderer` flag: that boot-time cache proved
  // unreliable for tools created/edited mid-session (renderer never applied in
  // real conversations), and the fallback for a renderer-less tool is cheap.
  const customSlug = isCustomTool ? toolCall.name.slice('custom_'.length) : null
  const humanName = customName ?? t(`tools.names.${toolCall.name}`, { defaultValue: toolCall.name })
  const previewFn = getPreviewRenderer(toolCall.name)
  const args = (toolCall.args ?? {}) as Record<string, unknown>
  const preview = previewFn?.({ toolName: toolCall.name, args, status: toolCall.status })
  const timeStr = new Date(toolCall.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border border-border bg-muted/50">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 cursor-pointer text-left hover:bg-muted/80 transition-colors rounded-lg">
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
              open && 'rotate-90',
            )}
          />
          <div className={cn('flex size-6 items-center justify-center rounded-md shrink-0', meta.bg)}>
            <ToolDomainIcon domain={toolCall.domain} className="size-3.5 text-foreground" />
          </div>
          <span className="flex-1 truncate text-sm font-medium">
            {humanName}
            {preview && (
              <span className="ml-1.5 text-xs text-muted-foreground/60 font-normal">· {preview}</span>
            )}
          </span>
          <StatusIcon className={cn('size-3.5 shrink-0', statusClass)} />
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">{timeStr}</span>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-2 space-y-2 border-t border-border/30 pt-2">
            {CustomRenderer ? (
              <CustomRenderer
                toolName={toolCall.name}
                args={args}
                result={toolCall.result}
                status={toolCall.status}
              />
            ) : customSlug ? (
              <CustomToolRenderer
                slug={customSlug}
                result={toolCall.result}
                args={toolCall.args}
              />
            ) : (
              <>
                <JsonViewer
                  data={args}
                  label={t('tools.viewer.input')}
                  maxHeight="max-h-40"
                />

                {toolCall.result !== undefined && (
                  <JsonViewer
                    data={toolCall.result}
                    label={t('tools.viewer.output')}
                    labelClassName={isError ? 'text-destructive' : undefined}
                    maxHeight="max-h-60"
                    className={isError ? 'bg-destructive/5 border border-destructive/20' : undefined}
                  />
                )}
              </>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
