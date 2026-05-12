import { memo, useMemo } from 'react'
import type {
  PluginCard,
  PluginCardPrimitive,
  PluginCardStatItem,
  PluginCardAction,
} from '@/shared/types/plugin-cards'
import { usePluginCardLiveUpdates } from '@/client/hooks/usePluginCardLiveUpdates'
import { interpolate } from './interpolate'
import { Header } from './primitives/Header'
import { StatRow } from './primitives/StatRow'
import { Progress } from './primitives/Progress'
import { LogStream } from './primitives/LogStream'
import { ActionRow } from './primitives/ActionRow'
import { Spinner } from './primitives/Spinner'
import { Badge } from './primitives/Badge'
import { Divider } from './primitives/Divider'
import { Markdown } from './primitives/Markdown'
import { CollapsibleSection } from './primitives/CollapsibleSection'

interface PluginCardRendererProps {
  card: PluginCard
}

// We interpret already-interpolated primitives at runtime. Strings that
// stood in for arrays/objects in the layout are reified by `interpolate`
// before we see them here, so the runtime shape matches PluginCardPrimitive.
function renderPrimitive(prim: unknown, cardInstanceId: string, key: number | string): React.ReactNode {
  if (!prim || typeof prim !== 'object') return null
  const p = prim as PluginCardPrimitive

  switch (p.type) {
    case 'header':
      return <Header key={key} title={p.title ?? ''} icon={p.icon} accent={p.accent} />
    case 'stat-row':
      return <StatRow key={key} items={Array.isArray(p.items) ? (p.items as PluginCardStatItem[]) : []} />
    case 'progress':
      return <Progress key={key} value={p.value} max={p.max} indeterminate={p.indeterminate} label={p.label} />
    case 'log-stream':
      return <LogStream key={key} lines={Array.isArray(p.lines) ? p.lines : []} autoscroll={p.autoscroll} maxHeight={p.maxHeight} />
    case 'action-row':
      return <ActionRow key={key} cardInstanceId={cardInstanceId} actions={Array.isArray(p.actions) ? (p.actions as PluginCardAction[]) : []} />
    case 'markdown':
      return <Markdown key={key} content={typeof p.content === 'string' ? p.content : ''} />
    case 'spinner':
      return <Spinner key={key} label={p.label} />
    case 'badge':
      return <Badge key={key} text={p.text ?? ''} variant={p.variant} />
    case 'divider':
      return <Divider key={key} label={p.label} />
    case 'collapsible': {
      const inner = Array.isArray(p.content) ? p.content : [p.content]
      return (
        <CollapsibleSection key={key} label={p.label ?? ''} defaultOpen={p.defaultOpen}>
          <div className="flex flex-col gap-2">
            {inner.map((child, idx) => renderPrimitive(child, cardInstanceId, idx))}
          </div>
        </CollapsibleSection>
      )
    }
    default:
      return null
  }
}

export const PluginCardRenderer = memo(function PluginCardRenderer({ card }: PluginCardRendererProps) {
  const state = usePluginCardLiveUpdates(card.cardInstanceId, card.state)

  const resolved = useMemo(() => {
    const interpolated = interpolate(card.layout, state)
    return Array.isArray(interpolated) ? interpolated : []
  }, [card.layout, state])

  return (
    <div className="my-1 flex flex-col gap-2.5 rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      {resolved.map((prim, idx) => renderPrimitive(prim, card.cardInstanceId, idx))}
    </div>
  )
})
