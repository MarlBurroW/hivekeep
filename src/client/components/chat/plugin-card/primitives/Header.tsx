import { memo } from 'react'
import * as Icons from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { PluginCardVariant } from '@/shared/types/plugin-cards'
import { accentTextClass } from '../variants'

interface HeaderProps {
  title: string
  icon?: string
  accent?: PluginCardVariant
}

export const Header = memo(function Header({ title, icon, accent = 'default' }: HeaderProps) {
  const Icon = icon ? (Icons as unknown as Record<string, React.ComponentType<{ className?: string }>>)[icon] : null
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className={cn('size-4 shrink-0', accentTextClass(accent))} />}
      <span className={cn('text-sm font-medium', accentTextClass(accent))}>{title}</span>
    </div>
  )
})
