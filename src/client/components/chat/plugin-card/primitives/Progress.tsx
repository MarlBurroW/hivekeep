/**
 * Progress: plugin-card progress bar.
 *
 * Two visual modes:
 *  - Determinate (`indeterminate: false` or unset with a `value`):
 *    delegates to the shared shadcn Progress component, which fills
 *    the track to value/max using the app's gradient indicator.
 *  - Indeterminate (`indeterminate: true`): renders our own track and
 *    a small colored chunk that continuously slides left to right.
 *    The shadcn primitive's "active" shimmer was too subtle once the
 *    indicator was pulled fully off-screen (translateX(-100%)), and
 *    users saw an apparently static empty bar. The dedicated marker
 *    makes "something is running" unambiguous.
 *
 * Keyframes for the indeterminate sweep are defined in globals.css as
 * `plugin-card-progress-indeterminate`.
 */

import { memo } from 'react'
import { Progress as UIProgress } from '@/client/components/ui/progress'

interface ProgressProps {
  value?: number
  max?: number
  indeterminate?: boolean
  label?: string
}

export const Progress = memo(function Progress({ value, max = 100, indeterminate, label }: ProgressProps) {
  if (indeterminate) {
    return (
      <div className="flex flex-col gap-1.5">
        {label && <span className="text-xs text-muted-foreground">{label}</span>}
        <div
          role="progressbar"
          aria-busy="true"
          aria-valuemin={0}
          aria-valuemax={100}
          className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 w-1/3 animate-plugin-card-progress-indeterminate gradient-primary rounded-full"
          />
        </div>
      </div>
    )
  }

  const numeric = typeof value === 'number' ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <UIProgress value={numeric} variant="gradient" />
    </div>
  )
})
