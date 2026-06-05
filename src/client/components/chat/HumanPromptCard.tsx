import { memo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Textarea } from '@/client/components/ui/textarea'
import { HelpCircle, Check, Loader2, Send } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { RelativeTimestamp } from '@/client/components/chat/RelativeTimestamp'
import { MarkdownContent } from '@/client/components/chat/MarkdownContent'
import type { HumanPromptSummary, HumanPromptOptionVariant } from '@/shared/types'

interface HumanPromptCardProps {
  prompt: HumanPromptSummary
  onRespond: (promptId: string, response: unknown) => Promise<void>
  isResponding?: boolean
}

/** Map prompt option variant to visual classes */
function variantClasses(variant?: HumanPromptOptionVariant) {
  switch (variant) {
    case 'success':
      return {
        button: 'border-success/40 bg-success/10 text-success hover:bg-success/20',
        selected: 'border-success bg-success/20 ring-2 ring-success/30',
      }
    case 'warning':
      return {
        button: 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20',
        selected: 'border-warning bg-warning/20 ring-2 ring-warning/30',
      }
    case 'destructive':
      return {
        button: 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20',
        selected: 'border-destructive bg-destructive/20 ring-2 ring-destructive/30',
      }
    case 'primary':
      return {
        button: 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20',
        selected: 'border-primary bg-primary/20 ring-2 ring-primary/30',
      }
    default:
      return {
        button: 'border-border bg-muted/50 text-foreground hover:bg-muted',
        selected: 'border-primary bg-primary/10 ring-2 ring-primary/30',
      }
  }
}

export const HumanPromptCard = memo(function HumanPromptCard({
  prompt,
  onRespond,
  isResponding,
}: HumanPromptCardProps) {
  const { t } = useTranslation()
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set())
  const [textValue, setTextValue] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const handleConfirm = async (value: string) => {
    setSubmitted(true)
    await onRespond(prompt.id, value)
  }

  const handleSelect = async (value: string) => {
    setSubmitted(true)
    await onRespond(prompt.id, value)
  }

  const toggleMultiSelect = (value: string) => {
    setSelectedValues((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  const handleMultiSelectSubmit = async () => {
    if (selectedValues.size === 0) return
    setSubmitted(true)
    await onRespond(prompt.id, Array.from(selectedValues))
  }

  const handleTextSubmit = useCallback(async () => {
    const trimmed = textValue.trim()
    if (!trimmed) return
    setSubmitted(true)
    await onRespond(prompt.id, trimmed)
  }, [textValue, onRespond, prompt.id])

  const disabled = submitted || isResponding

  return (
    <div className="animate-fade-in-up glass-subtle rounded-xl border border-border p-4 max-w-lg">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="flex-shrink-0 mt-0.5 flex items-center justify-center size-8 rounded-lg bg-primary/10 text-primary">
          <HelpCircle className="size-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground leading-snug">
              {prompt.question}
            </p>
            <RelativeTimestamp timestamp={new Date(prompt.createdAt).toISOString()} className="shrink-0 text-[10px] text-muted-foreground/70" />
          </div>
          {prompt.description && (
            <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
              <MarkdownContent content={prompt.description} />
            </div>
          )}
        </div>
      </div>

      {/* Submitted state */}
      {submitted && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Check className="size-3.5 text-success" />
          <span>{t('humanPrompt.submitted')}</span>
        </div>
      )}

      {/* Confirm type — buttons side by side, wrapping to new lines when they
          don't fit (e.g. 3 long options in a narrow onboarding modal). */}
      {!submitted && prompt.promptType === 'confirm' && (
        <div className="flex flex-wrap gap-2">
          {prompt.options.map((option) => {
            const vc = variantClasses(option.variant)
            return (
              <Button
                key={option.value}
                variant="outline"
                size="sm"
                disabled={disabled}
                className={cn('h-auto min-w-[7rem] flex-1 whitespace-normal border py-1.5 text-center', vc.button)}
                onClick={() => handleConfirm(option.value)}
              >
                {disabled && <Loader2 className="size-3.5 animate-spin" />}
                {option.label}
              </Button>
            )
          })}
        </div>
      )}

      {/* Select type — clickable cards, immediate submit on click */}
      {!submitted && prompt.promptType === 'select' && (
        <div className="flex flex-col gap-1.5">
          {prompt.options.map((option) => {
            const vc = variantClasses(option.variant)
            return (
              <button
                key={option.value}
                disabled={disabled}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-all',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  vc.button,
                )}
                onClick={() => handleSelect(option.value)}
              >
                <div className="size-3.5 rounded-full border-2 border-current flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{option.label}</span>
                  {option.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Multi-select type — checkboxes + submit button */}
      {!submitted && prompt.promptType === 'multi_select' && (
        <div className="flex flex-col gap-1.5">
          {prompt.options.map((option) => {
            const checked = selectedValues.has(option.value)
            const vc = variantClasses(option.variant)
            return (
              <button
                key={option.value}
                disabled={disabled}
                className={cn(
                  'flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-all',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  checked ? vc.selected : vc.button,
                )}
                onClick={() => toggleMultiSelect(option.value)}
              >
                <div
                  className={cn(
                    'size-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-all',
                    checked ? 'bg-primary border-primary text-primary-foreground' : 'border-current',
                  )}
                >
                  {checked && <Check className="size-3" />}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{option.label}</span>
                  {option.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                  )}
                </div>
              </button>
            )
          })}
          <Button
            size="sm"
            disabled={disabled || selectedValues.size === 0}
            className="mt-2"
            onClick={handleMultiSelectSubmit}
          >
            {disabled && <Loader2 className="size-3.5 animate-spin" />}
            {t('humanPrompt.submit')} ({selectedValues.size})
          </Button>
        </div>
      )}

      {/* Text type — free-form textarea + submit. Submit on Cmd/Ctrl+Enter. */}
      {!submitted && prompt.promptType === 'text' && (
        <div className="flex flex-col gap-2">
          <Textarea
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                void handleTextSubmit()
              }
            }}
            placeholder={t('humanPrompt.textPlaceholder')}
            rows={3}
            disabled={disabled}
            autoFocus
            className="resize-y text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground/70">
              {t('humanPrompt.textHint')}
            </span>
            <Button
              size="sm"
              disabled={disabled || textValue.trim().length === 0}
              onClick={handleTextSubmit}
            >
              {disabled ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              {t('humanPrompt.submit')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
})
