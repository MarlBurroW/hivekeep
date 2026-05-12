import { memo } from 'react'
import { Progress as UIProgress } from '@/client/components/ui/progress'

interface ProgressProps {
  value?: number
  max?: number
  indeterminate?: boolean
  label?: string
}

export const Progress = memo(function Progress({ value, max = 100, indeterminate, label }: ProgressProps) {
  const numeric = typeof value === 'number' ? Math.max(0, Math.min(100, (value / max) * 100)) : undefined
  return (
    <div className="flex flex-col gap-1.5">
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
      <UIProgress
        value={indeterminate ? undefined : numeric}
        variant="gradient"
        active={Boolean(indeterminate)}
      />
    </div>
  )
})
