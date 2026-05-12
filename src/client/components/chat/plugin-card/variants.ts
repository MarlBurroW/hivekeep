import type { PluginCardVariant } from '@/shared/types/plugin-cards'

/**
 * Variant to Tailwind class mapping for plugin card primitives. The card
 * variants map onto semantic design tokens so they look correct across all
 * palettes without per-palette overrides.
 */

export function badgeClassesFor(variant: PluginCardVariant = 'default'): string {
  switch (variant) {
    case 'success':
      return 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-900/60'
    case 'warning':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200 border border-amber-200 dark:border-amber-900/60'
    case 'destructive':
      return 'bg-destructive text-white'
    case 'primary':
      return 'bg-primary text-primary-foreground'
    case 'muted':
      return 'bg-muted text-muted-foreground border border-border'
    case 'default':
    default:
      return 'bg-secondary text-secondary-foreground'
  }
}

export function buttonVariantFor(variant: PluginCardVariant = 'default'): 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' {
  switch (variant) {
    case 'destructive': return 'destructive'
    case 'primary': return 'default'
    case 'muted': return 'ghost'
    case 'default': return 'secondary'
    case 'success':
    case 'warning':
    default: return 'outline'
  }
}

export function accentTextClass(variant: PluginCardVariant = 'default'): string {
  switch (variant) {
    case 'success': return 'text-emerald-600 dark:text-emerald-400'
    case 'warning': return 'text-amber-600 dark:text-amber-400'
    case 'destructive': return 'text-destructive'
    case 'primary': return 'text-primary'
    case 'muted': return 'text-muted-foreground'
    case 'default':
    default: return 'text-foreground'
  }
}

export function statValueClass(variant: PluginCardVariant = 'default'): string {
  switch (variant) {
    case 'success': return 'text-emerald-600 dark:text-emerald-400'
    case 'warning': return 'text-amber-600 dark:text-amber-400'
    case 'destructive': return 'text-destructive'
    case 'primary': return 'text-primary'
    case 'muted': return 'text-muted-foreground'
    case 'default':
    default: return 'text-foreground'
  }
}
