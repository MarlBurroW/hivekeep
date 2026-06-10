import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/client/components/ui/switch'
import { Badge } from '@/client/components/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/components/ui/collapsible'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { getToolDomainMeta } from '@/client/lib/tool-domain-lookup'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { ToolCatalogEntry, ToolDomain, ToolLabel, ToolSource } from '@/shared/types'

/** Stable render order for the four sources. Native first (the bulk of the
 *  catalog and the only thing `*` expands to), then the explicit-grant sources. */
const SOURCE_ORDER: ToolSource[] = ['native', 'plugin', 'mcp', 'custom']

/**
 * Resolve a tool's display label:
 *   - string label → use as-is
 *   - locale map → user's lang, then `en`, then any first entry
 *   - null/undefined → strip a `plugin_<plugin>_` prefix from the raw name
 */
function resolveToolLabel(name: string, label: ToolLabel | null | undefined, lang: string): string {
  if (typeof label === 'string') return label
  if (label && typeof label === 'object') {
    return label[lang] ?? label.en ?? label[Object.keys(label)[0] ?? ''] ?? prettifyToolName(name)
  }
  return prettifyToolName(name)
}

function prettifyToolName(name: string): string {
  const match = name.match(/^plugin_[^_]+_(.+)$/)
  return match ? match[1]! : name
}

export interface ToolSelectorTool extends ToolCatalogEntry {}

/** Optional per-tool decoration the host can inject (e.g. a capability or
 *  hard-exclusion warning rendered under the tool label). */
export type ToolNoteResolver = (tool: ToolSelectorTool) => string | undefined

interface ToolSelectorProps {
  /** Native tool catalog (GET /api/tools/catalog). */
  tools: ToolSelectorTool[]
  /** Controlled set of currently-selected tool names. */
  selected: Set<string>
  /** Called with the next full selection set whenever a row/domain toggles. */
  onChange: (next: Set<string>) => void
  /** When true, every switch is rendered disabled (read-only built-in view). */
  readOnly?: boolean
  /** Pure-listing mode: no switches at all and plain counts instead of
   *  "x/y enabled" — for surfaces that only DISPLAY a toolset (e.g. the
   *  composer's tools modal), where a wall of disabled switches reads as
   *  broken interactivity rather than information. Implies readOnly. */
  hideSwitches?: boolean
  /** Optional soft note shown under a tool row (warnings etc.). */
  toolNote?: ToolNoteResolver
  /** Show the friendly i18n name (tools.names.*) instead of the raw key as the
   *  primary label. Defaults to true. The raw tool key is always shown muted. */
  useFriendlyNames?: boolean
}

interface DomainBucket {
  domain: ToolDomain
  tools: ToolSelectorTool[]
}

interface SourceBucket {
  source: ToolSource
  tools: ToolSelectorTool[]
  domains: DomainBucket[]
}

/**
 * Reusable presentational picker for grantable tools, grouped first by SOURCE
 * (native / plugin / MCP / custom) and then by domain within each source, with
 * a per-tool toggle, a per-domain "toggle the whole category" switch, and a
 * per-source "toggle the whole source" switch. Fully controlled: the parent
 * owns the selected `Set<string>` of tool names and is notified through
 * `onChange`. Used by the toolbox editor (and adapted by the Agent tools tab).
 *
 * A catalog that contains only native tools (no plugin/MCP/custom entries)
 * renders exactly one source group, so existing single-source callers keep
 * their familiar domain-grouped layout.
 */
export function ToolSelector({
  tools,
  selected,
  onChange,
  readOnly = false,
  hideSwitches = false,
  toolNote,
  useFriendlyNames = true,
}: ToolSelectorProps) {
  const { t, i18n } = useTranslation()
  const userLang = (i18n.language || 'en').split('-')[0]!

  // Bucket tools by source, then by domain inside each source. Order: sources
  // follow SOURCE_ORDER; domains follow first-appearance order within the
  // source so the list stays stable across renders.
  const sourceBuckets = useMemo<SourceBucket[]>(() => {
    const bySource = new Map<ToolSource, ToolSelectorTool[]>()
    for (const tool of tools) {
      const src = tool.source ?? 'native'
      const arr = bySource.get(src)
      if (arr) arr.push(tool)
      else bySource.set(src, [tool])
    }

    const ordered: ToolSource[] = [
      ...SOURCE_ORDER.filter((s) => bySource.has(s)),
      ...Array.from(bySource.keys()).filter((s) => !SOURCE_ORDER.includes(s)),
    ]

    return ordered.map((source) => {
      const srcTools = bySource.get(source)!
      const byDomain = new Map<ToolDomain, ToolSelectorTool[]>()
      for (const tool of srcTools) {
        const arr = byDomain.get(tool.domain)
        if (arr) arr.push(tool)
        else byDomain.set(tool.domain, [tool])
      }
      return {
        source,
        tools: srcTools,
        domains: Array.from(byDomain.entries()).map(([domain, dt]) => ({ domain, tools: dt })),
      }
    })
  }, [tools])

  const toggleTool = (name: string) => {
    if (readOnly) return
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    onChange(next)
  }

  const toggleMany = (bucketTools: ToolSelectorTool[]) => {
    if (readOnly) return
    const allSelected = bucketTools.every((tool) => selected.has(tool.name))
    const next = new Set(selected)
    for (const tool of bucketTools) {
      if (allSelected) next.delete(tool.name)
      else next.add(tool.name)
    }
    onChange(next)
  }

  // Single-source catalog → render the domain groups directly (no redundant
  // source header), preserving the original layout for native-only callers.
  const singleSource = sourceBuckets.length === 1

  return (
    <div className="space-y-3">
      {sourceBuckets.map((srcBucket) => {
        const domainGroups = (
          <div className="space-y-3">
            {srcBucket.domains.map((bucket) => {
              const enabledCount = bucket.tools.filter((tool) => selected.has(tool.name)).length
              const allEnabled = enabledCount === bucket.tools.length
              return (
                <DomainGroup
                  key={bucket.domain}
                  domain={bucket.domain}
                  enabledCount={enabledCount}
                  totalCount={bucket.tools.length}
                  allEnabled={allEnabled}
                  readOnly={readOnly}
                  hideSwitches={hideSwitches}
                  onToggleAll={() => toggleMany(bucket.tools)}
                >
                  {bucket.tools.map((tool) => {
                    const friendly = useFriendlyNames
                      ? t(`tools.names.${tool.name}`, resolveToolLabel(tool.name, tool.label, userLang))
                      : resolveToolLabel(tool.name, tool.label, userLang)
                    const showKey = friendly !== tool.name
                    const subLabel =
                      tool.source === 'mcp'
                        ? tool.mcpServerName ?? undefined
                        : tool.source === 'custom'
                          ? tool.customAgentName ?? undefined
                          : undefined
                    return (
                      <ToolRow
                        key={tool.name}
                        label={friendly}
                        toolKey={showKey ? tool.name : undefined}
                        subLabel={subLabel}
                        enabled={selected.has(tool.name)}
                        readOnly={readOnly}
                        hideSwitch={hideSwitches}
                        note={toolNote?.(tool)}
                        onToggle={() => toggleTool(tool.name)}
                      />
                    )
                  })}
                </DomainGroup>
              )
            })}
          </div>
        )

        if (singleSource) return <div key={srcBucket.source}>{domainGroups}</div>

        const srcEnabled = srcBucket.tools.filter((tool) => selected.has(tool.name)).length
        return (
          <SourceGroup
            key={srcBucket.source}
            source={srcBucket.source}
            enabledCount={srcEnabled}
            totalCount={srcBucket.tools.length}
            allEnabled={srcEnabled === srcBucket.tools.length}
            readOnly={readOnly}
            hideSwitches={hideSwitches}
            onToggleAll={() => toggleMany(srcBucket.tools)}
          >
            {domainGroups}
          </SourceGroup>
        )
      })}
    </div>
  )
}

function SourceGroup({
  source,
  enabledCount,
  totalCount,
  allEnabled,
  readOnly,
  hideSwitches,
  onToggleAll,
  children,
}: {
  source: ToolSource
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  readOnly?: boolean
  hideSwitches?: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex flex-1 items-center gap-2 text-left">
              <ChevronRight
                className={cn(
                  'size-3.5 text-muted-foreground transition-transform',
                  open && 'rotate-90',
                )}
              />
              <span className="text-sm font-semibold">
                {t(`toolboxes.sourceGroup.${source}`)}
              </span>
              <Badge variant="secondary" size="xs">
                {t(`toolboxes.sources.${source}`)}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {hideSwitches ? totalCount : t('agent.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          {!hideSwitches && (
            <Switch
              size="sm"
              checked={allEnabled}
              disabled={readOnly}
              onCheckedChange={onToggleAll}
            />
          )}
        </div>
        <CollapsibleContent>
          <div className="border-t p-3">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function DomainGroup({
  domain,
  enabledCount,
  totalCount,
  allEnabled,
  readOnly,
  hideSwitches,
  onToggleAll,
  children,
}: {
  domain: ToolDomain
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  readOnly?: boolean
  hideSwitches?: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const meta = getToolDomainMeta(domain)
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button type="button" className="flex flex-1 items-center gap-2 text-left">
              <ChevronRight
                className={cn(
                  'size-3.5 text-muted-foreground transition-transform',
                  open && 'rotate-90',
                )}
              />
              <span className={`flex size-6 items-center justify-center rounded-md ${meta.bg}`}>
                <ToolDomainIcon domain={domain} className={`size-3.5 ${meta.text}`} />
              </span>
              <span className="text-sm font-medium">{meta.labelKey ? t(meta.labelKey) : (meta.label ?? domain)}</span>
              <span className="text-xs text-muted-foreground">
                {hideSwitches ? totalCount : t('agent.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          {!hideSwitches && (
            <Switch
              size="sm"
              checked={allEnabled}
              disabled={readOnly}
              onCheckedChange={onToggleAll}
            />
          )}
        </div>
        <CollapsibleContent>
          <div className="border-t">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolRow({
  label,
  toolKey,
  subLabel,
  enabled,
  readOnly,
  hideSwitch,
  note,
  onToggle,
}: {
  label: string
  toolKey?: string
  /** Secondary provenance line, e.g. the MCP server or owning Agent. */
  subLabel?: string
  enabled: boolean
  readOnly?: boolean
  hideSwitch?: boolean
  note?: string
  onToggle: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 pr-3 pl-12 hover:bg-accent/30 transition-colors">
      <div className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm text-foreground">{label}</span>
          {toolKey && (
            <span className="font-mono text-[11px] text-muted-foreground/70">{toolKey}</span>
          )}
        </span>
        {subLabel && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{subLabel}</p>
        )}
        {note && (
          <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{note}</p>
        )}
      </div>
      {!hideSwitch && <Switch size="sm" checked={enabled} disabled={readOnly} onCheckedChange={onToggle} />}
    </div>
  )
}

/** Convenience re-export so hosts can render a hard-exclusion Badge inline. */
export function HardExcludedBadge() {
  const { t } = useTranslation()
  return (
    <Badge variant="secondary" size="xs">
      {t('toolboxes.hardExcluded')}
    </Badge>
  )
}
