import { memo } from 'react'

interface DividerProps {
  label?: string
}

export const Divider = memo(function Divider({ label }: DividerProps) {
  if (!label) {
    return <hr className="my-1 border-border" />
  }
  return (
    <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <span>{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
})
