import { memo } from 'react'
import { cn } from '@/client/lib/utils'
import type { PluginCardVariant } from '@/shared/types/plugin-cards'
import { badgeClassesFor } from '../variants'

interface BadgeProps {
  text: string
  variant?: PluginCardVariant
}

export const Badge = memo(function Badge({ text, variant }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        badgeClassesFor(variant),
      )}
    >
      {text}
    </span>
  )
})
