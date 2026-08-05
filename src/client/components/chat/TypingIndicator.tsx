import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Wrench, AlertTriangle } from 'lucide-react'
import { ChatAvatar } from '@/client/components/chat/ChatAvatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'

interface TypingIndicatorProps {
  agentName?: string
  agentAvatarUrl?: string | null
  /** Server-side epoch (ms) when processing started — timer resumes correctly after navigation */
  startedAt?: number
  /** Live estimate of output tokens generated so far this turn (0 hides the counter) */
  tokenCount?: number
  /** Number of tool calls in the current turn (0 hides the counter) */
  toolCallCount?: number
  /** Opens the tool-calls side panel when the tool counter is clicked */
  onOpenToolCalls?: () => void
  /** Force-unblocks the Agent. Surfaced only once the turn has run long enough
   *  to look wedged, so the escape hatch is discoverable exactly when needed
   *  without inviting people to interrupt healthy long turns. */
  onForceReset?: () => void
}

/** Elapsed seconds after which a turn is treated as suspect in the UI. */
const STUCK_AFTER_SECONDS = 15 * 60

/** Compact token formatting: 1234 → "1.2k", 980 → "980". */
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

export function TypingIndicator({
  agentName,
  agentAvatarUrl,
  startedAt,
  tokenCount = 0,
  toolCallCount = 0,
  onOpenToolCalls,
  onForceReset,
}: TypingIndicatorProps) {
  const { t } = useTranslation()
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(startedAt ?? Date.now())

  useEffect(() => {
    startRef.current = startedAt ?? Date.now()
    setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [startedAt])

  const formatElapsed = (s: number) => {
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const rem = s % 60
    return `${m}m ${rem.toString().padStart(2, '0')}s`
  }

  return (
    <div className="flex gap-3 px-4 py-2 animate-fade-in-up">
      <ChatAvatar avatarUrl={agentAvatarUrl} name={agentName} fallbackClassName="text-xs" />

      <div className="space-y-1">
        {agentName && (
          <p className="text-xs font-medium text-muted-foreground">{agentName}</p>
        )}
        <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-md bg-muted px-4 py-2.5">
          <div className="flex gap-1">
            <span className="size-1.5 rounded-full bg-muted-foreground animate-typing-dot" />
            <span className="size-1.5 rounded-full bg-muted-foreground animate-typing-dot delay-1" />
            <span className="size-1.5 rounded-full bg-muted-foreground animate-typing-dot delay-2" />
          </div>
          <span className="text-xs text-muted-foreground">{t('chat.streaming')}</span>
          {elapsed > 0 && (
            <span className="text-xs text-muted-foreground/60 tabular-nums">
              {formatElapsed(elapsed)}
            </span>
          )}

          {tokenCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs text-muted-foreground/60 tabular-nums border-l border-border/60 pl-2">
                  {t('chat.thinkingTokens', { value: formatTokens(tokenCount) })}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{t('chat.thinkingTokensHint')}</TooltipContent>
            </Tooltip>
          )}

          {toolCallCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenToolCalls}
                  disabled={!onOpenToolCalls}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground/70 border-l border-border/60 transition-colors hover:text-foreground enabled:hover:bg-muted-foreground/10 disabled:cursor-default"
                >
                  <Wrench className="size-3" />
                  {toolCallCount}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('chat.thinkingToolsHint')}</TooltipContent>
            </Tooltip>
          )}

          {onForceReset && elapsed >= STUCK_AFTER_SECONDS && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onForceReset}
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-destructive border-l border-border/60 transition-colors hover:bg-destructive/10"
                >
                  <AlertTriangle className="size-3" />
                  {t('chat.forceReset')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('chat.forceResetHint')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  )
}
