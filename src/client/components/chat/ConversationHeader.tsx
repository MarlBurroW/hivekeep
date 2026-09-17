import { useState, useMemo, memo, useRef, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useIsMobile } from '@/client/hooks/use-mobile'
import { ChatAvatar } from '@/client/components/chat/ChatAvatar'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Progress } from '@/client/components/ui/progress'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { computeCacheHitRate, computeFreshInput } from '@/shared/billing'
import type { MessageTokenUsage, AgentThinkingEffort } from '@/shared/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/client/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { AlertTriangle, Bot, Settings, Pencil, MessageSquare, Loader2, Wrench, Archive, Zap, FileText, FileJson, Search, Trash2, MoreHorizontal, Coins, ListPlus, Folder } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { ContextBar } from '@/client/components/chat/ContextBar'
import { ConversationStats } from '@/client/components/chat/ConversationStats'
import { DateNavigator } from '@/client/components/chat/DateNavigator'
import type { ChatMessage } from '@/client/hooks/useChat'
import type { ContextTokenBreakdown, ContextPipelineStatus } from '@/shared/types'

interface LLMModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

interface ConversationHeaderProps {
  agentId: string
  name: string
  role: string
  model: string
  providerId: string | null
  avatarUrl: string | null
  llmModels: LLMModel[]
  modelUnavailable?: boolean
  messageCount: number
  estimatedTokens: number
  maxTokens: number
  /** Provider-reported context size from the most recent LLM call. When
   *  present, the bar shows it on a separate solid track in addition to
   *  the (estimated) breakdown blocks. Independent of `estimatedTokens`. */
  apiContextTokens?: number
  toolCallCount: number
  isToolCallsOpen: boolean
  queueState?: { isProcessing: boolean; queueSize: number }
  onModelChange: (modelId: string, providerId: string) => void
  onToggleToolCalls: () => void
  onForceCompact?: () => void
  isCompacting?: boolean
  onEdit: () => void
  onStartTask?: () => void
  onQuickSession?: () => void
  onExportMarkdown?: () => void
  onExportJSON?: () => void
  onSearch?: () => void
  onClearConversation?: () => void
  onViewUsage?: () => void
  contextBreakdown?: ContextTokenBreakdown
  pipelineStatus?: ContextPipelineStatus
  compactingPercent?: number
  compactingThresholdPercent?: number
  summaryCount?: number
  maxSummaries?: number
  summaryTokens?: number
  summaryBudgetTokens?: number
  messages?: ChatMessage[]
  scrollViewportRef?: React.RefObject<HTMLElement | null>
  thinkingEnabled?: boolean
  thinkingEffort?: AgentThinkingEffort | null
  onChangeThinking?: (next: { enabled: boolean; effort: AgentThinkingEffort | null }) => void
  /** Optional leading element (e.g. the mobile sidebar trigger). Rendered at the
   *  very start of the header so we can collapse the separate trigger bar on
   *  mobile and reclaim that vertical space. */
  leading?: React.ReactNode
}

/**
 * Observe an element's own width. Used to drive the header's responsive
 * "priority-plus" action bar: as the chat area narrows (window resize, side
 * panel opening, sidebar collapse) the lowest-priority actions fold away —
 * simple actions into a "⋯" overflow menu, passive viewers (stats / date nav)
 * are hidden outright. Container-query CSS can't do the fold-into-menu part
 * because the menu renders in a portal outside the `@container`, so we measure
 * in JS and derive both the visible icons and the menu contents from one width.
 */
function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState<number>(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(el.getBoundingClientRect().width)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

// Header width (px) below which each action folds away, lowest priority first.
// Tuned for icon-sized buttons (~36px incl. gap) plus the always-on context bar.
const HIDE_DATE_NAV_BELOW = 820
const HIDE_STATS_BELOW = 740
const FOLD_USAGE_BELOW = 660
const FOLD_QUICK_BELOW = 580

export const ConversationHeader = memo(function ConversationHeader({
  agentId,
  name,
  role,
  model,
  providerId,
  avatarUrl,
  llmModels,
  modelUnavailable = false,
  messageCount,
  estimatedTokens,
  maxTokens,
  apiContextTokens,
  toolCallCount,
  isToolCallsOpen,
  queueState,
  onModelChange,
  onToggleToolCalls,
  onForceCompact,
  isCompacting = false,
  onEdit,
  onStartTask,
  onQuickSession,
  onExportMarkdown,
  onExportJSON,
  onSearch,
  onClearConversation,
  onViewUsage,
  contextBreakdown,
  pipelineStatus,
  compactingPercent,
  compactingThresholdPercent,
  summaryCount,
  maxSummaries,
  summaryTokens,
  summaryBudgetTokens,
  messages,
  scrollViewportRef,
  thinkingEnabled = false,
  thinkingEffort = null,
  onChangeThinking,
  leading,
}: ConversationHeaderProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [mobileInfoOpen, setMobileInfoOpen] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)

  const isProcessing = queueState?.isProcessing ?? false
  const queueSize = queueState?.queueSize ?? 0
  const hasContextData = maxTokens > 0
  const contextPercent = hasContextData ? Math.min(100, Math.round((estimatedTokens / maxTokens) * 100)) : 0

  // Compute the cache state from the last assistant turn that has token usage.
  // This gives the user a confidence signal before sending the next message:
  // if the previous turn read a lot from cache, the prefix is likely still
  // warm (Anthropic's 5-min ephemeral cache) and the next turn will be cheap.
  const lastTurnCache = useMemo<{ usage: MessageTokenUsage; hitRate: number; fresh: number; turnAt: string } | null>(() => {
    if (!messages || messages.length === 0) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (!m) continue
      if (m.role === 'assistant' && m.tokenUsage) {
        const cacheRead = m.tokenUsage.cacheReadTokens ?? 0
        const cacheWrite = m.tokenUsage.cacheWriteTokens ?? 0
        if (cacheRead === 0 && cacheWrite === 0) return null
        return {
          usage: m.tokenUsage,
          hitRate: computeCacheHitRate(m.tokenUsage),
          fresh: computeFreshInput(m.tokenUsage),
          turnAt: m.createdAt,
        }
      }
    }
    return null
  }, [messages])

  // Anthropic's default ephemeral cache TTL is 5 minutes from the last hit.
  // After that, the prefix has to be re-written on the next request, so the
  // next turn is no longer cheap. The chip would otherwise lie when the last
  // turn is hours old.
  const ANTHROPIC_CACHE_TTL_MS = 5 * 60 * 1000
  const cacheAgeMs = lastTurnCache ? Date.now() - new Date(lastTurnCache.turnAt).getTime() : 0
  const cacheExpired = lastTurnCache != null && cacheAgeMs > ANTHROPIC_CACHE_TTL_MS
  const cacheAgeLabel = (() => {
    if (!lastTurnCache) return ''
    const min = Math.floor(cacheAgeMs / 60_000)
    if (min < 60) return `${min}min`
    const h = Math.floor(min / 60)
    return min % 60 === 0 ? `${h}h` : `${h}h${min % 60}min`
  })()

  const selectedModel = llmModels.find((m) => m.id === model)
  const selectedModelName = selectedModel?.name ?? model

  // Responsive action bar — see useElementWidth above.
  const isMobile = useIsMobile()
  const [headerRef, headerWidth] = useElementWidth<HTMLDivElement>()
  // On mobile the foldable / passive actions always collapse, regardless of the
  // measured width. This also avoids a first-paint overflow flash before the
  // ResizeObserver reports a width (initial width is +Infinity). At >=768px the
  // hook returns false, so desktop behaviour stays driven purely by the
  // width thresholds — byte-identical to before.
  const showDateNav = !isMobile && headerWidth >= HIDE_DATE_NAV_BELOW
  const showStats = !isMobile && headerWidth >= HIDE_STATS_BELOW
  const showUsageIcon = !isMobile && headerWidth >= FOLD_USAGE_BELOW
  const showQuickIcon = !isMobile && headerWidth >= FOLD_QUICK_BELOW
  // The "⋯" overflow only appears when at least one *foldable* action (a simple
  // onClick — quick session, usage) couldn't fit. Stats/date-nav don't fold.
  const hasOverflow = Boolean((onQuickSession && !showQuickIcon) || (onViewUsage && !showUsageIcon))

  return (
    <div ref={headerRef} className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5 sm:gap-3 sm:px-4">
      {/* Leading slot (mobile sidebar trigger) — collapses the standalone
          trigger bar into this header on mobile to save vertical space. */}
      {leading}

      {/* Avatar */}
      <ChatAvatar
        avatarUrl={avatarUrl}
        name={name}
        className="size-8 border border-border/50 sm:size-10"
        fallbackClassName="bg-primary/10"
        fallbackIcon={<Bot className="size-4 text-primary sm:size-5" />}
      />

      {/* Name + role — desktop: static, mobile: tappable to show model & context */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{name}</h2>
          {modelUnavailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1 text-warning">
                  <AlertTriangle className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('agent.modelUnavailableHint')}
              </TooltipContent>
            </Tooltip>
          )}
          {isProcessing && (
            <Loader2 className="size-3.5 animate-spin text-primary" />
          )}
          {queueSize > 0 && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t('agent.queue', { count: queueSize })}
            </span>
          )}
          {lastTurnCache && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums cursor-default',
                    cacheExpired && 'bg-muted text-muted-foreground/70',
                    !cacheExpired && lastTurnCache.hitRate >= 0.7 && 'bg-success/15 text-success',
                    !cacheExpired && lastTurnCache.hitRate >= 0.3 && lastTurnCache.hitRate < 0.7 && 'bg-warning/15 text-warning',
                    !cacheExpired && lastTurnCache.hitRate < 0.3 && 'bg-muted text-muted-foreground',
                  )}
                  aria-label={t('chat.cacheChip.aria', 'Cache state from last turn')}
                >
                  <Zap className="size-2.5" />
                  {Math.round(lastTurnCache.hitRate * 100)}%
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <div className="space-y-1 text-xs">
                  <div className="font-medium">
                    {t('chat.cacheChip.title', 'Last turn cache')}
                  </div>
                  <p className="text-muted-foreground leading-snug">
                    {cacheExpired
                      ? t('chat.cacheChip.hintCold', {
                          defaultValue: '{{hit}}% of input was served from cache on the last turn — but that was {{ago}} ago, past Anthropic\'s ~5min ephemeral TTL. The prefix is cold; the next request re-writes it.',
                          hit: Math.round(lastTurnCache.hitRate * 100),
                          ago: cacheAgeLabel,
                        })
                      : t('chat.cacheChip.hint', {
                          defaultValue: '{{hit}}% of input was served from cache. The cache is warm — your next message should be cheap unless the prefix changes significantly.',
                          hit: Math.round(lastTurnCache.hitRate * 100),
                        })}
                  </p>
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Desktop: show role */}
        <p className="hidden truncate text-xs text-muted-foreground sm:block">{role}</p>

        {/* Mobile: show model name + context % as tappable summary */}
        <Popover open={mobileInfoOpen} onOpenChange={setMobileInfoOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 truncate text-xs text-muted-foreground sm:hidden"
            >
              <span className="truncate">{selectedModelName}</span>
              <span className="shrink-0 text-[10px]">·</span>
              <span className="flex shrink-0 items-center gap-1 text-[10px]">
                <MessageSquare className="size-2.5" />
                {messageCount}
              </span>
              <Progress
                value={contextPercent}
                variant={contextPercent > 80 ? 'glow' : 'default'}
                className="h-1 w-10 shrink-0"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-72 space-y-3 p-3">
            {/* Model & effort pickers now live in the composer toolbar; this
                popover is a context-usage summary only. */}
            <ContextBar
              agentId={agentId}
              estimatedTokens={estimatedTokens}
              maxTokens={maxTokens}
              apiContextTokens={apiContextTokens}
              contextBreakdown={contextBreakdown}
              pipelineStatus={pipelineStatus}
              compactingPercent={compactingPercent}
              compactingThresholdPercent={compactingThresholdPercent}
              summaryCount={summaryCount}
              maxSummaries={maxSummaries}
              summaryTokens={summaryTokens}
              summaryBudgetTokens={summaryBudgetTokens}
              messageCount={messageCount}
              compact
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* Context usage + compacting proximity (desktop only — mobile shows it
          in the name-tap popover above). Always visible; never folds. */}
      <div className="hidden min-w-0 items-center sm:flex">
        <ContextBar
          agentId={agentId}
          estimatedTokens={estimatedTokens}
          maxTokens={maxTokens}
          apiContextTokens={apiContextTokens}
          contextBreakdown={contextBreakdown}
          pipelineStatus={pipelineStatus}
          compactingPercent={compactingPercent}
          compactingThresholdPercent={compactingThresholdPercent}
          summaryCount={summaryCount}
          maxSummaries={maxSummaries}
          summaryTokens={summaryTokens}
          summaryBudgetTokens={summaryBudgetTokens}
          messageCount={messageCount}
        />
      </div>

      {/* Tool calls toggle — always visible (highest priority) */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('relative', isToolCallsOpen && 'bg-muted')}
            onClick={onToggleToolCalls}
          >
            <Wrench className="size-4" />
            {toolCallCount > 0 && (
              <Badge
                variant="default"
                className="absolute -top-1 -right-1 size-4 p-0 text-[9px] flex items-center justify-center rounded-full"
              >
                {toolCallCount > 99 ? '99+' : toolCallCount}
              </Badge>
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('tools.viewer.title')}</TooltipContent>
      </Tooltip>

      {/* Search — always visible (high priority) */}
      {onSearch && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onSearch}>
              <Search className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chat.search.title')}</TooltipContent>
        </Tooltip>
      )}

      {/* Quick session — folds into the ⋯ overflow when the header is narrow */}
      {onQuickSession && showQuickIcon && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onQuickSession}>
              <Zap className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('quickChat.open')}</TooltipContent>
        </Tooltip>
      )}

      {/* Token usage — folds into the ⋯ overflow when the header is narrow */}
      {onViewUsage && showUsageIcon && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onViewUsage}>
              <Coins className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('chat.viewUsage')}</TooltipContent>
        </Tooltip>
      )}

      {/* Conversation statistics — passive viewer; first to hide when cramped */}
      {messages && messages.length > 0 && showStats && (
        <ConversationStats messages={messages} toolCallCount={toolCallCount} />
      )}

      {/* Date navigator — passive viewer; first to hide when cramped */}
      {messages && messages.length > 0 && showDateNav && (
        <DateNavigator messages={messages} scrollViewportRef={scrollViewportRef} />
      )}

      {/* Responsive overflow — appears only when a foldable action didn't fit.
          On mobile these actions move into the settings (⚙️) menu instead, so
          we don't render a second trailing dropdown next to it. */}
      {!isMobile && hasOverflow && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm">
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('chat.moreActions')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end">
            {onQuickSession && !showQuickIcon && (
              <DropdownMenuItem onClick={onQuickSession}>
                <Zap className="mr-2 size-4" />
                {t('quickChat.open')}
              </DropdownMenuItem>
            )}
            {onViewUsage && !showUsageIcon && (
              <DropdownMenuItem onClick={onViewUsage}>
                <Coins className="mr-2 size-4" />
                {t('chat.viewUsage')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {/* Settings — real cog. Holds agent + conversation actions (no standalone ⋯). */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('accessibility.agentSettings')}>
                <Settings className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('accessibility.agentSettings')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {/* Mobile: the standalone ⋯ overflow is hidden, so its foldable
              actions (quick session, usage) live here instead. */}
          {isMobile && onQuickSession && (
            <DropdownMenuItem onClick={onQuickSession}>
              <Zap className="mr-2 size-4" />
              {t('quickChat.open')}
            </DropdownMenuItem>
          )}
          {isMobile && onViewUsage && (
            <DropdownMenuItem onClick={onViewUsage}>
              <Coins className="mr-2 size-4" />
              {t('chat.viewUsage')}
            </DropdownMenuItem>
          )}
          {isMobile && (onQuickSession || onViewUsage) && <DropdownMenuSeparator />}
          {/* Edit this Agent's configuration */}
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 size-4" />
            {t('sidebar.agents.contextMenu.edit')}
          </DropdownMenuItem>
          {/* Launch a standalone (orphan) task on this Agent. */}
          {onStartTask && (
            <DropdownMenuItem onClick={onStartTask}>
              <ListPlus className="mr-2 size-4" />
              {t('orphanTask.menuAction')}
            </DropdownMenuItem>
          )}
          {/* Browse this Agent's workspace in the Files section */}
          <DropdownMenuItem onClick={() => navigate(`/files/${agentId}`)}>
            <Folder className="mr-2 size-4" />
            {t('files.browseWorkspace')}
          </DropdownMenuItem>
          {(onForceCompact || onExportMarkdown || onExportJSON) && <DropdownMenuSeparator />}
          {onForceCompact && (
            <DropdownMenuItem onClick={onForceCompact} disabled={isCompacting}>
              {isCompacting ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Archive className="mr-2 size-4" />
              )}
              {t('chat.forceCompact')}
            </DropdownMenuItem>
          )}
          {onExportMarkdown && (
            <DropdownMenuItem onClick={onExportMarkdown}>
              <FileText className="mr-2 size-4" />
              {t('chat.export.markdown')}
            </DropdownMenuItem>
          )}
          {onExportJSON && (
            <DropdownMenuItem onClick={onExportJSON}>
              <FileJson className="mr-2 size-4" />
              {t('chat.export.json')}
            </DropdownMenuItem>
          )}
          {onClearConversation && messageCount > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setClearDialogOpen(true)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 size-4" />
                {t('chat.clear.title')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Clear conversation confirmation dialog */}
      {onClearConversation && (
        <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('chat.clear.title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('chat.clear.description')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  onClearConversation()
                  setClearDialogOpen(false)
                }}
              >
                {t('chat.clear.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

    </div>
  )
})
