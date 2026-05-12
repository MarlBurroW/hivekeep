import { memo } from 'react'
import { Loader2 } from 'lucide-react'

interface SpinnerProps {
  label?: string
}

export const Spinner = memo(function Spinner({ label }: SpinnerProps) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label && <span>{label}</span>}
    </div>
  )
})
