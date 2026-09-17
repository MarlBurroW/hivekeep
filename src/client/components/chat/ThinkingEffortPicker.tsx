import { useTranslation } from 'react-i18next'
import { Brain, Sparkles } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { cn } from '@/client/lib/utils'
import { clampEffort, type ModelReasoningInfo } from '@/client/lib/model-efforts'
import { DEFAULT_THINKING_EFFORTS } from '@/shared/constants'
import type { AgentThinkingEffort } from '@/shared/types'

interface Props {
  enabled: boolean
  effort: AgentThinkingEffort | null
  onChange: (next: { enabled: boolean; effort: AgentThinkingEffort | null }) => void
  /**
   * Reasoning support of the current model (see `modelReasoningInfo`).
   * Omitted/unknown → the default ladder. `levels` → only the model's efforts.
   * `toggle` → on/off only. `unsupported` → off only + a hint.
   */
  reasoning?: ModelReasoningInfo
  /** Compact icon-only trigger (for chat header). Otherwise renders a labeled button. */
  compact?: boolean
  className?: string
}

export function ThinkingEffortPicker({ enabled, effort, onChange, reasoning, compact = false, className }: Props) {
  const { t } = useTranslation()
  const kind = reasoning?.kind ?? 'unknown'
  const efforts = kind === 'unknown' ? DEFAULT_THINKING_EFFORTS : reasoning?.efforts ?? []

  // Honest display: show what the provider will actually run (the stored
  // effort clamped to the model), not a level the model can't reach.
  const active = enabled && kind !== 'unsupported' && (!!effort || kind === 'toggle')
  const displayEffort = active && effort && reasoning ? clampEffort(effort, reasoning) : effort
  const currentLabel = !active
    ? t('chat.thinkingPicker.effort.off')
    : kind === 'toggle'
      ? t('chat.thinkingPicker.effort.on')
      : t(`chat.thinkingPicker.effort.${displayEffort ?? 'medium'}`)

  const levels: Array<{ value: AgentThinkingEffort | 'on' | null; key: string }> = [
    { value: null, key: 'off' },
    ...(kind === 'toggle' ? ([{ value: 'on', key: 'on' }] as const) : []),
    ...efforts.map((e) => ({ value: e, key: e })),
  ]

  const handleSelect = (value: AgentThinkingEffort | 'on' | null) => {
    if (value === null) onChange({ enabled: false, effort: null })
    else if (value === 'on') onChange({ enabled: true, effort: null })
    else onChange({ enabled: true, effort: value })
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex min-h-10 min-w-8 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8',
                active
                  ? 'bg-chart-4/15 text-chart-4 hover:bg-chart-4/25'
                  : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50',
                className,
              )}
              aria-label={t('chat.thinkingPicker.title')}
            >
              <Sparkles className="size-3" />
              {(!compact || active) && <span>{currentLabel}</span>}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('chat.thinkingPicker.title')}: {currentLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" className="w-56 p-2">
        <div className="mb-2 flex items-center gap-1.5 px-1">
          <Brain className="size-3.5 text-muted-foreground" />
          <p className="text-[11px] font-medium text-muted-foreground">{t('chat.thinkingPicker.title')}</p>
        </div>
        <div className="flex flex-col gap-0.5">
          {levels.map((level) => {
            const isSelected = level.value === null
              ? !active
              : level.value === 'on'
                ? active
                : displayEffort === level.value && active
            return (
              <button
                key={level.key}
                type="button"
                onClick={() => handleSelect(level.value)}
                className={cn(
                  'flex items-center justify-between rounded-md px-2 py-1.5 text-[12px] transition-colors',
                  isSelected
                    ? 'bg-chart-4/15 text-chart-4 font-medium'
                    : 'hover:bg-muted/60 text-foreground/80',
                )}
              >
                <span>{t(`chat.thinkingPicker.effort.${level.key}`)}</span>
                {isSelected && <span className="text-[10px]">●</span>}
              </button>
            )
          })}
        </div>
        {kind === 'unsupported' && (
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">{t('chat.thinkingPicker.unsupported')}</p>
        )}
        {reasoning?.note && (
          <p className="mt-2 px-1 text-[11px] text-muted-foreground">{reasoning.note}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}
