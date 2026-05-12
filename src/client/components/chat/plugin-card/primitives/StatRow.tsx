import { memo } from 'react'
import { cn } from '@/client/lib/utils'
import type { PluginCardStatItem } from '@/shared/types/plugin-cards'
import { statValueClass } from '../variants'

interface StatRowProps {
  items: PluginCardStatItem[]
}

export const StatRow = memo(function StatRow({ items }: StatRowProps) {
  if (!Array.isArray(items) || items.length === 0) return null
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.map((item, idx) => (
        <div key={`${item.label}-${idx}`} className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-3 py-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{item.label}</span>
          <span className={cn('text-sm font-medium', statValueClass(item.variant))}>{item.value}</span>
        </div>
      ))}
    </div>
  )
})
