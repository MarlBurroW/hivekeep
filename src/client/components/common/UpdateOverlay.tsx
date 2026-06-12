import { useTranslation } from 'react-i18next'
import { ArrowUpCircle, Check, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/components/ui/button'
import { UpdateResultBanner } from '@/client/components/common/UpdateResultBanner'
import { useUpdate } from '@/client/contexts/UpdateContext'
import type { UpdateStepId } from '@/shared/types'

const ALL_STEPS: UpdateStepId[] = [
  'preflight',
  'snapshot',
  'backup',
  'download',
  'apply',
  'dependencies',
  'assets',
  'restart',
]

type StepStatus = 'pending' | 'running' | 'done'

/**
 * Full-screen overlay shown while a platform self-update runs. Driven by the
 * `UpdateContext` poller (immune to missed SSE events). The stepper derives
 * each step's state from the journal's `currentStep`, so it advances steadily
 * even though the server can't emit fine-grained events while a blocking step
 * (bun install / build) holds the event loop.
 */
export function UpdateOverlay() {
  const { t } = useTranslation()
  const { run, dismiss } = useUpdate()

  if (!run) return null

  const terminal = run.status === 'success' || run.status === 'failed' || run.status === 'rolled-back'
  const restarting = run.status === 'restarting'

  const steps = ALL_STEPS.filter((s) => (run.channel === 'edge' ? s !== 'download' : true))
  // 'restart' is implied by status === 'restarting'; while pre-restart steps run
  // we map currentStep onto the list. Unknown/elapsed → treat as far along.
  const currentIndex = run.currentStep ? steps.indexOf(run.currentStep) : -1

  const stepStatus = (index: number): StepStatus => {
    if (restarting) return index < steps.length - 1 ? 'done' : 'running'
    if (currentIndex < 0) return 'pending'
    if (index < currentIndex) return 'done'
    if (index === currentIndex) return 'running'
    return 'pending'
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="glass-strong w-full max-w-md rounded-xl border p-6 shadow-2xl">
        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-lg bg-primary/10 p-2">
            <ArrowUpCircle className="size-6 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold">
              {terminal && run.status === 'success'
                ? t('updateOverlay.successTitle')
                : t('updateOverlay.title')}
            </h2>
            <p className="text-xs text-muted-foreground truncate">
              {run.toVersion
                ? t('updateOverlay.toVersion', { version: run.toVersion })
                : t('updateProgress.title')}
            </p>
          </div>
        </div>

        {terminal ? (
          <div className="space-y-4">
            <UpdateResultBanner result={run} />
            {run.status === 'success' ? (
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t('updateProgress.reloading')}
              </div>
            ) : (
              <Button variant="outline" className="w-full" onClick={dismiss}>
                {t('common.close')}
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* Stepper */}
            <div className="space-y-1">
              {steps.map((step, index) => {
                const status = stepStatus(index)
                return (
                  <div
                    key={step}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                      status === 'running' && 'bg-primary/5 text-foreground',
                      status === 'pending' && 'text-muted-foreground/50',
                      status === 'done' && 'text-muted-foreground',
                    )}
                  >
                    <span className="flex size-4 items-center justify-center shrink-0">
                      {status === 'running' && <Loader2 className="size-4 animate-spin text-primary" />}
                      {status === 'done' && <Check className="size-4 text-emerald-500" />}
                      {status === 'pending' && <span className="size-1.5 rounded-full bg-current" />}
                    </span>
                    <span className="flex-1">{t(`updateProgress.steps.${step}`)}</span>
                  </div>
                )
              })}
            </div>

            {restarting && (
              <div className="mt-4 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <RefreshCw className="size-3.5 animate-spin" />
                {t('updateProgress.waitingForServer')}
              </div>
            )}

            <p className="mt-4 text-center text-xs text-muted-foreground">
              {t('updateProgress.dontClose')}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
