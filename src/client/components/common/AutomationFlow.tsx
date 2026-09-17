import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/client/lib/utils'

/** Describes existing automation contracts; it does not schedule or execute work. */
export function AutomationFlow({ trigger, agent, action, actionDetail, destination, lastTriggeredAt, next, className }: {
  trigger: string
  agent: string
  action: string
  actionDetail?: string | null
  destination: string
  lastTriggeredAt: number | null
  next: string
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const steps = [
    { key: 'trigger', value: trigger },
    { key: 'agent', value: agent },
    { key: 'action', value: action, detail: actionDetail },
    { key: 'destination', value: destination },
  ]
  return (
    <div className={cn('min-w-0 space-y-1.5', className)} aria-label={t('workspace.automationsFlow.description')}>
      <ol className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 lg:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.key} className="min-w-0 text-[11px]">
            <span className="flex items-center gap-1 font-medium text-muted-foreground">
              {index > 0 && <ArrowRight aria-hidden="true" className="size-3 shrink-0" />}
              {t(`workspace.automationsFlow.${step.key}`)}
            </span>
            <p className="break-words line-clamp-2 text-foreground" title={step.value}>{step.value}</p>
            {step.detail && <p className="line-clamp-1 break-words text-muted-foreground" title={step.detail}>{step.detail}</p>}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>{t('workspace.automationsFlow.last')}: {lastTriggeredAt === null
          ? t('workspace.automationsFlow.never')
          : <time dateTime={new Date(lastTriggeredAt).toISOString()}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'short' }).format(lastTriggeredAt)}</time>}
        </span>
        <span>{t('workspace.automationsFlow.next')}: {next}</span>
      </div>
    </div>
  )
}
