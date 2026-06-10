import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Pencil, Wrench } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Badge } from '@/client/components/ui/badge'
import { Skeleton } from '@/client/components/ui/skeleton'
import { ToolSelector, type ToolSelectorTool } from '@/client/components/common/ToolSelector'
import { useToolCatalog } from '@/client/hooks/useToolCatalog'
import { getToolDomain } from '@/client/lib/tool-domain-lookup'
import type { AgentToolInfo } from '@/client/hooks/useAgentTools'

interface AgentToolsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string
  agentName: string
  /** The agent's RESOLVED toolset (GET /agents/:id/tools) — the names define
   *  which catalog entries are shown. */
  tools: AgentToolInfo[]
  /** Variant label — quick sessions expose a reduced set. */
  isQuickSession?: boolean
  /** Opens the agent's tools management (the Agent form's Tools tab). */
  onEditTools?: () => void
}

/**
 * Read-only listing of every tool currently exposed to the agent — opened from
 * the composer's tools badge. Renders with the SAME ToolSelector used by the
 * toolbox editor and the Agent Tools tab (source/domain collapsible groups,
 * friendly names, provenance), in read-only mode with everything "on".
 */
export function AgentToolsModal({ open, onOpenChange, agentId, agentName, tools, isQuickSession, onEditTools }: AgentToolsModalProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const { tools: catalog, isLoading: catalogLoading } = useToolCatalog(agentId)

  const resolvedNames = useMemo(() => new Set(tools.map((tool) => tool.name)), [tools])

  // The catalog entry carries the display metadata (source, domain, label,
  // provenance). Resolved names missing from the catalog (e.g. a transient MCP
  // hiccup) still show, with a minimal synthesized entry.
  const exposedEntries = useMemo<ToolSelectorTool[]>(() => {
    const byName = new Map(catalog.map((entry) => [entry.name, entry]))
    return tools.map((tool) =>
      byName.get(tool.name) ?? {
        name: tool.name,
        source: 'native' as const,
        domain: getToolDomain(tool.name),
        label: null,
        description: tool.description || null,
        defaultDisabled: false,
        readOnly: false,
        destructive: false,
        hardExcludedFromSubAgent: false,
      },
    )
  }, [tools, catalog])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return exposedEntries
    return exposedEntries.filter((entry) =>
      entry.name.toLowerCase().includes(q)
      || (typeof entry.label === 'string' && entry.label.toLowerCase().includes(q))
      || (entry.description ?? '').toLowerCase().includes(q),
    )
  }, [exposedEntries, query])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="panel" size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="size-4 text-primary" />
            {t('chat.toolsModal.title', { name: agentName, defaultValue: '{{name}} — tools' })}
            <Badge variant="secondary" className="ml-1">{tools.length}</Badge>
          </DialogTitle>
          <DialogDescription>
            {isQuickSession
              ? t('chat.toolsModal.descriptionQuick', 'Tools exposed in this quick session (session-restricted tools like tasks, crons and inter-agent messaging are excluded).')
              : t('chat.toolsModal.description', 'Every tool currently exposed to this agent, grouped by domain.')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search', 'Search')}
              className="pl-8"
            />
          </div>

          {catalogLoading && exposedEntries.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.noResults', 'No results')}</p>
          ) : (
            <ToolSelector
              tools={filtered}
              selected={resolvedNames}
              onChange={() => {}}
              readOnly
              hideSwitches
            />
          )}
        </DialogBody>

        <DialogFooter>
          {onEditTools && (
            <Button variant="outline" onClick={() => { onOpenChange(false); onEditTools() }}>
              <Pencil className="size-4" />
              {t('chat.toolsModal.edit', 'Edit tools')}
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t('common.close', 'Close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
