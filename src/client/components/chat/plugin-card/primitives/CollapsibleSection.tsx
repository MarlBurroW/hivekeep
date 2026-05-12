import { memo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/client/lib/utils'

interface CollapsibleSectionProps {
  label: string
  defaultOpen?: boolean
  children: React.ReactNode
}

export const CollapsibleSection = memo(function CollapsibleSection({ label, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
        <span>{label}</span>
      </button>
      {open && <div className="pl-4">{children}</div>}
    </div>
  )
})
