import { useState, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/client/components/ui/progress'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/client/components/ui/tooltip'
import { MessageSquare, Wrench, Archive, AlertTriangle } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { ContextTokenBreakdown, ContextPipelineStatus } from '@/shared/types'

const ContextViewerDialog = lazy(() =>
  import('@/client/components/chat/ContextViewerDialog').then((m) => ({ default: m.ContextViewerDialog })),
)

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface ContextBarProps {
  kinId: string
  /** Local BPE estimate of the context size — drives the breakdown bar. */
  estimatedTokens: number
  maxTokens: number
  /** Provider-reported context size from the last LLM call (ground truth).
   *  When present, a separate solid bar shows it alongside the estimate.
   *  Independent of `estimatedTokens`. */
  apiContextTokens?: number
  contextBreakdown?: ContextTokenBreakdown
  pipelineStatus?: ContextPipelineStatus
  compactingPercent?: number
  compactingThresholdPercent?: number
  summaryCount?: number
  maxSummaries?: number
  summaryTokens?: number
  summaryBudgetTokens?: number
  messageCount?: number
  /** Compact mode: smaller width, no compacting proximity line */
  compact?: boolean
  /** If set, context preview will show the task's context instead of the main conversation */
  taskId?: string
  /** If set, context preview will show the quick session's context */
  sessionId?: string
}

/** Renders a colored breakdown bar from the local estimate's section sizes. */
function BreakdownBar({
  contextBreakdown,
  maxTokens,
  height = 'h-1.5',
}: {
  contextBreakdown: ContextTokenBreakdown
  maxTokens: number
  height?: string
}) {
  return (
    <div className={cn('flex w-full overflow-hidden rounded-full bg-primary/15', height)}>
      {contextBreakdown.tools > 0 && (
        <div className="bg-blue-500" style={{ width: `${Math.max(0.5, (contextBreakdown.tools / maxTokens) * 100)}%` }} />
      )}
      {contextBreakdown.systemPrompt > 0 && (
        <div className="bg-purple-500" style={{ width: `${Math.max(0.5, (contextBreakdown.systemPrompt / maxTokens) * 100)}%` }} />
      )}
      {(contextBreakdown.summary ?? 0) > 0 && (
        <div className="bg-amber-500" style={{ width: `${Math.max(0.5, (contextBreakdown.summary! / maxTokens) * 100)}%` }} />
      )}
      {(contextBreakdown.cronRuns ?? 0) > 0 && (
        <div className="bg-orange-500" style={{ width: `${Math.max(0.5, (contextBreakdown.cronRuns! / maxTokens) * 100)}%` }} />
      )}
      {(contextBreakdown.cronLearnings ?? 0) > 0 && (
        <div className="bg-teal-500" style={{ width: `${Math.max(0.5, (contextBreakdown.cronLearnings! / maxTokens) * 100)}%` }} />
      )}
      {contextBreakdown.messages > 0 && (
        <div className="bg-emerald-500" style={{ width: `${Math.max(0.5, (contextBreakdown.messages / maxTokens) * 100)}%` }} />
      )}
    </div>
  )
}

/** Renders a solid bar (no per-section breakdown) representing a single
 *  ground-truth value from the provider. */
function RealBar({
  realTokens,
  maxTokens,
  height = 'h-1.5',
}: {
  realTokens: number
  maxTokens: number
  height?: string
}) {
  const pct = Math.min(100, (realTokens / maxTokens) * 100)
  return (
    <div className={cn('relative w-full overflow-hidden rounded-full bg-success/10', height)}>
      <div
        className="h-full bg-success/80"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function ContextBar({
  kinId,
  estimatedTokens,
  maxTokens,
  apiContextTokens,
  contextBreakdown,
  pipelineStatus,
  compactingPercent: compactingPct,
  compactingThresholdPercent,
  summaryCount,
  maxSummaries,
  summaryTokens,
  summaryBudgetTokens,
  messageCount,
  compact = false,
  taskId,
  sessionId,
}: ContextBarProps) {
  const { t } = useTranslation()
  const [contextViewerOpen, setContextViewerOpen] = useState(false)

  const hasContextData = maxTokens > 0
  const hasReal = apiContextTokens != null && apiContextTokens > 0 && hasContextData
  // The displayed total in the navbar summary line: prefer the provider
  // value when available, fall back to the local estimate. Both are kept
  // separately and rendered on their own bars in the tooltip.
  const displayTokens = hasReal ? apiContextTokens! : estimatedTokens
  const displayPercent = hasContextData ? Math.min(100, Math.round((displayTokens / maxTokens) * 100)) : 0
  const displayLabel = hasContextData
    ? `${formatTokenCount(displayTokens)} / ${formatTokenCount(maxTokens)}`
    : '— / —'

  const hasCompactingData = (compactingThresholdPercent ?? 0) > 0
  const compactingPercent = compactingPct ?? 0

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`flex cursor-pointer flex-col gap-1 rounded-md px-1 transition-colors hover:bg-muted/50 min-w-0 ${compact ? 'w-44' : 'w-56'}`}
            onClick={() => setContextViewerOpen(true)}
          >
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              {messageCount != null && (
                <span className="flex items-center gap-1 shrink-0">
                  <MessageSquare className="size-3" />
                  {messageCount}
                </span>
              )}
              <span className="flex items-center gap-1 shrink-0 truncate">
                {hasContextData && (
                  hasReal ? (
                    <span
                      className="rounded bg-success/15 px-1 py-px text-[9px] font-medium text-success"
                      title={t('chat.contextSource.apiHint', { defaultValue: 'Reported by the provider on the last call (ground truth).' })}
                    >
                      ✓ {t('chat.contextSource.real', { defaultValue: 'real' })}
                    </span>
                  ) : (
                    <span
                      className="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground/80"
                      title={t('chat.contextSource.estimateHint', { defaultValue: 'Local BPE estimate — switches to ground-truth after the first LLM call.' })}
                    >
                      ~ {t('chat.contextSource.estimate', { defaultValue: 'est.' })}
                    </span>
                  )
                )}
                <span>{displayLabel}</span>
              </span>
            </div>
            {/* Single solid bar in the always-visible summary. The two-bar
                breakdown lives in the tooltip / visualizer where we have
                room for proper labels. */}
            <div className="relative">
              <Progress
                value={displayPercent}
                variant={displayPercent > 80 ? 'glow' : (hasReal ? 'default' : 'default')}
                className={cn('h-1.5', hasReal && '[&>div]:bg-success')}
              />
              {hasCompactingData && (
                <div
                  className="absolute top-0 h-full w-px bg-warning"
                  style={{ left: `${compactingThresholdPercent}%` }}
                />
              )}
            </div>
            {!compact && hasCompactingData && (
              <p className="truncate text-[9px] text-muted-foreground">
                {t('chat.compactingProximity', {
                  percent: compactingPercent,
                  threshold: compactingThresholdPercent ?? 0,
                  summaryCount: summaryCount ?? 0,
                })}
              </p>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" hideArrow className="w-80 space-y-3 border border-border bg-popover p-3 text-popover-foreground shadow-md">
          {/* Two-bar layout: real (when available) + estimate with breakdown */}
          <div className="space-y-3">
            <div className="text-[11px] font-medium">{t('chat.tooltipContext')}</div>

            {/* Real bar (provider ground truth) */}
            {hasReal && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <span className="rounded bg-success/15 px-1 py-px text-[9px] font-medium text-success">
                      ✓ {t('chat.contextSource.real', { defaultValue: 'real' })}
                    </span>
                    <span>{t('chat.contextSource.realLabel', { defaultValue: 'Provider-reported' })}</span>
                  </span>
                  <span className="text-foreground tabular-nums">
                    {formatTokenCount(apiContextTokens!)} / {formatTokenCount(maxTokens)} ({Math.round((apiContextTokens! / maxTokens) * 100)}%)
                  </span>
                </div>
                <div className="relative">
                  <RealBar realTokens={apiContextTokens!} maxTokens={maxTokens} height="h-2.5" />
                  {hasCompactingData && (
                    <div
                      className="absolute top-[-2px] h-[calc(100%+4px)] w-px bg-warning"
                      style={{ left: `${compactingThresholdPercent}%` }}
                    />
                  )}
                </div>
              </div>
            )}

            {/* Estimate bar with section breakdown */}
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px]">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground/80">
                    ~ {t('chat.contextSource.estimate', { defaultValue: 'est.' })}
                  </span>
                  <span>{t('chat.contextSource.estimateLabel', { defaultValue: 'Local estimate' })}</span>
                </span>
                <span className="text-foreground tabular-nums">
                  {formatTokenCount(estimatedTokens)} / {formatTokenCount(maxTokens)} ({Math.round((estimatedTokens / maxTokens) * 100)}%)
                </span>
              </div>
              <div className="relative">
                {contextBreakdown && hasContextData ? (
                  <BreakdownBar contextBreakdown={contextBreakdown} maxTokens={maxTokens} height="h-2.5" />
                ) : (
                  <Progress value={displayPercent} className="h-2.5" />
                )}
                {hasCompactingData && (
                  <div
                    className="absolute top-[-2px] h-[calc(100%+4px)] w-px bg-warning"
                    style={{ left: `${compactingThresholdPercent}%` }}
                  />
                )}
              </div>

              {/* Section legend */}
              {contextBreakdown && hasContextData && (
                <div className="space-y-0.5 text-[10px] pt-1">
                  {contextBreakdown.tools > 0 && (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-sm bg-blue-500" />
                        {t('chat.breakdown.tools', 'Tools')}
                      </span>
                      <span className="tabular-nums">{formatTokenCount(contextBreakdown.tools)}</span>
                    </div>
                  )}
                  {contextBreakdown.systemPrompt > 0 && (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-sm bg-purple-500" />
                        {t('chat.breakdown.systemPrompt', 'System prompt')}
                      </span>
                      <span className="tabular-nums">{formatTokenCount(contextBreakdown.systemPrompt)}</span>
                    </div>
                  )}
                  {(contextBreakdown.summary ?? 0) > 0 && (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-sm bg-amber-500" />
                        {t('chat.breakdown.summary', 'Summary')}
                      </span>
                      <span className="tabular-nums">{formatTokenCount(contextBreakdown.summary!)}</span>
                    </div>
                  )}
                  {(contextBreakdown.cronRuns ?? 0) > 0 && (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-sm bg-orange-500" />
                        {t('chat.breakdown.cronRuns', 'Previous runs')}
                      </span>
                      <span className="tabular-nums">{formatTokenCount(contextBreakdown.cronRuns!)}</span>
                    </div>
                  )}
                  {(contextBreakdown.cronLearnings ?? 0) > 0 && (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-sm bg-teal-500" />
                        {t('chat.breakdown.cronLearnings', 'Learnings')}
                      </span>
                      <span className="tabular-nums">{formatTokenCount(contextBreakdown.cronLearnings!)}</span>
                    </div>
                  )}
                  {contextBreakdown.messages > 0 && (
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block size-2 rounded-sm bg-emerald-500" />
                        {t('chat.breakdown.messages', 'Messages')}
                      </span>
                      <span className="tabular-nums">{formatTokenCount(contextBreakdown.messages)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {hasReal && (
              <p className="text-[9px] leading-relaxed text-muted-foreground/80 border-t border-border/40 pt-2">
                {t('chat.contextSource.dualBarHint', {
                  defaultValue: 'The estimate breakdown shows where tokens come from by section (local BPE approximation). The real bar is what the provider actually counted on the last call.',
                })}
              </p>
            )}

            {pipelineStatus && (pipelineStatus.maskedToolGroups > 0 || pipelineStatus.observationCompactedCount > 0 || pipelineStatus.emergencyTrimmedCount > 0) && (
              <div className="space-y-0.5 border-t border-border/40 pt-2 text-[10px]">
                {pipelineStatus.maskedToolGroups > 0 && (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Wrench className="size-2.5 shrink-0" />
                    <span>{t('chat.pipeline.maskedTools', { count: pipelineStatus.maskedToolGroups, tokens: formatTokenCount(pipelineStatus.estimatedTokensSavedByMasking) })}</span>
                  </div>
                )}
                {pipelineStatus.observationCompactedCount > 0 && (
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <Archive className="size-2.5 shrink-0" />
                    <span>{t('chat.pipeline.observationCompacted', { count: pipelineStatus.observationCompactedCount })}</span>
                  </div>
                )}
                {pipelineStatus.emergencyTrimmedCount > 0 && (
                  <div className="flex items-center gap-1 text-amber-500">
                    <AlertTriangle className="size-2.5 shrink-0" />
                    <span>{t('chat.pipeline.emergencyTrim', { count: pipelineStatus.emergencyTrimmedCount })}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Compacting proximity */}
          {hasCompactingData && (
            <div className="space-y-1.5 border-t border-border/40 pt-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium">{t('chat.tooltipCompacting')}</span>
                <span className="text-muted-foreground">{compactingPercent}%</span>
              </div>
              <Progress
                value={compactingPercent}
                variant={compactingPercent > 80 ? 'glow' : 'default'}
                className="h-2.5"
              />
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>{t('chat.compactingProximity', {
                  percent: compactingPercent,
                  threshold: compactingThresholdPercent ?? 0,
                  summaryCount: summaryCount ?? 0,
                })}</span>
              </div>
            </div>
          )}

          {/* Summary merge proximity */}
          {(maxSummaries ?? 0) > 0 && (summaryCount ?? 0) > 0 && (
            <div className="space-y-1.5 border-t border-border/40 pt-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-medium">{t('chat.tooltipSummaryMerge')}</span>
              </div>
              <div className="space-y-1 text-[10px]">
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t('chat.summaryMergeCount', { count: summaryCount ?? 0, max: maxSummaries ?? 0 })}</span>
                </div>
                <Progress
                  value={Math.min(100, Math.round(((summaryCount ?? 0) / (maxSummaries ?? 10)) * 100))}
                  variant={((summaryCount ?? 0) / (maxSummaries ?? 10)) > 0.8 ? 'glow' : 'default'}
                  className="h-1.5"
                />
                {(summaryBudgetTokens ?? 0) > 0 && (
                  <>
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span>{t('chat.summaryMergeBudget', { tokens: formatTokenCount(summaryTokens ?? 0), budget: formatTokenCount(summaryBudgetTokens ?? 0) })}</span>
                    </div>
                    <Progress
                      value={Math.min(100, Math.round(((summaryTokens ?? 0) / (summaryBudgetTokens ?? 1)) * 100))}
                      variant={((summaryTokens ?? 0) / (summaryBudgetTokens ?? 1)) > 0.8 ? 'glow' : 'default'}
                      className="h-1.5"
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </TooltipContent>
      </Tooltip>

      {/* Context viewer dialog */}
      {contextViewerOpen && (
        <Suspense fallback={null}>
          <ContextViewerDialog
            open={contextViewerOpen}
            onOpenChange={setContextViewerOpen}
            kinId={kinId}
            taskId={taskId}
            sessionId={sessionId}
          />
        </Suspense>
      )}
    </>
  )
}
