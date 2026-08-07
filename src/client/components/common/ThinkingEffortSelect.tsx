import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import type { ThinkingChoice } from '@/client/lib/thinking-choice'
import type { ModelReasoningInfo } from '@/client/lib/model-efforts'
import { DEFAULT_THINKING_EFFORTS } from '@/shared/constants'

interface ThinkingEffortSelectProps {
  value: ThinkingChoice
  onChange: (value: ThinkingChoice) => void
  disabled?: boolean
  /** Label shown for the `inherit` option. Lets callers pick the wording.
   *  Omit to hide the inherit option entirely (e.g. cron overrides). */
  inheritLabel?: string
  /**
   * Reasoning support of the target model (see `modelReasoningInfo`). Drives
   * which options are offered:
   * - omitted / kind `unknown` → the default ladder
   * - kind `levels` → exactly the model's supported efforts
   * - kind `toggle` → a single "enabled" option (no granularity)
   * - kind `unsupported` → off only
   */
  reasoning?: ModelReasoningInfo
  className?: string
}

/**
 * Single-select reasoning-effort dial backed by `ThinkingChoice`.
 *
 * The shared effort selector for forms (Agent settings, task-start dialogs,
 * cron overrides). Options adapt to the selected model's registry metadata via
 * the `reasoning` prop — callers are responsible for clamping a stored value
 * when the model changes (see `clampEffort`).
 */
export function ThinkingEffortSelect({
  value,
  onChange,
  disabled = false,
  inheritLabel,
  reasoning,
  className,
}: ThinkingEffortSelectProps) {
  const { t } = useTranslation()
  const kind = reasoning?.kind ?? 'unknown'
  const efforts = kind === 'unknown' ? DEFAULT_THINKING_EFFORTS : reasoning?.efforts ?? []
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ThinkingChoice)} disabled={disabled}>
      <SelectTrigger className={className ?? 'h-9'}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel !== undefined && (
          <SelectItem value="inherit">
            <span className="italic text-muted-foreground">{inheritLabel}</span>
          </SelectItem>
        )}
        <SelectItem value="off">{t('chat.thinkingPicker.effort.off')}</SelectItem>
        {kind === 'toggle' && (
          <SelectItem value="on">{t('chat.thinkingPicker.effort.on')}</SelectItem>
        )}
        {efforts.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {t(`chat.thinkingPicker.effort.${effort}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
