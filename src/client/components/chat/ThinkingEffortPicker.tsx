import { useTranslation } from 'react-i18next'
import { Brain, Sparkles } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { cn } from '@/client/lib/utils'
import type { KinThinkingEffort } from '@/shared/types'

const LEVELS: Array<{ value: KinThinkingEffort | null; key: string }> = [
  { value: null, key: 'off' },
  { value: 'low', key: 'low' },
  { value: 'medium', key: 'medium' },
  { value: 'high', key: 'high' },
  { value: 'max', key: 'max' },
]

interface Props {
  enabled: boolean
  effort: KinThinkingEffort | null
  onChange: (next: { enabled: boolean; effort: KinThinkingEffort | null }) => void
  /** Compact icon-only trigger (for chat header). Otherwise renders a labeled button. */
  compact?: boolean
  className?: string
}

export function ThinkingEffortPicker({ enabled, effort, onChange, compact = false, className }: Props) {
  const { t } = useTranslation()
  const active = enabled && !!effort
  const currentLabel = active ? t(`chat.thinkingPicker.effort.${effort}`) : t('chat.thinkingPicker.effort.off')

  const handleSelect = (value: KinThinkingEffort | null) => {
    if (value === null) onChange({ enabled: false, effort: null })
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
                'flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium transition-colors',
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
          {LEVELS.map((level) => {
            const isSelected = level.value === null ? !active : effort === level.value
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
      </PopoverContent>
    </Popover>
  )
}
