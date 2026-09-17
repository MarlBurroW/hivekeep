import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Wrench, Settings2, ShieldPlus, Plus, X } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { ToolSelector, type ToolSelectorTool } from '@/client/components/common/ToolSelector'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { FormDialog } from '@/client/components/common/FormDialog'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { useToolCatalog } from '@/client/hooks/useToolCatalog'
import { EmptyState } from '@/client/components/common/EmptyState'
import { CORE_TOOLS } from '@/shared/constants'

interface AgentToolsTabProps {
  agentId: string | null
  /** Current toolbox selection. Null/empty → the 'all' built-in at resolution. */
  toolboxIds: string[] | null
  onToolboxIdsChange: (next: string[] | null) => void
  /** Individual tool grants on top of toolboxes (agents.extra_tool_names).
   *  Approved request_tool_access requests land here too. Null → none. The
   *  section only renders when `onExtraToolNamesChange` is provided (edit mode). */
  extraToolNames?: string[] | null
  onExtraToolNamesChange?: (next: string[] | null) => void
  /** Opens the Toolboxes management (Settings → Toolboxes). Renders a shortcut
   *  next to the assignment picker when provided. */
  onManageToolboxes?: () => void
}

/**
 * The TOOLBOX is the sole tool-grant primitive for an Agent. This tab lets the
 * user assign one or more toolboxes; the resolved toolset is CORE_TOOLS unioned
 * with every selected toolbox's listed tools (intersected with what actually
 * exists). A null/empty selection grants only core tools.
 *
 * Below the picker we render a read-only preview of the tools the current
 * selection grants, sourced from the unified tool catalog (native + plugin +
 * MCP + custom). The preview reuses the shared ToolSelector in read-only mode.
 */
export function AgentToolsTab({ agentId, toolboxIds, onToolboxIdsChange, extraToolNames, onExtraToolNamesChange, onManageToolboxes }: AgentToolsTabProps) {
  const { t } = useTranslation()
  const { toolboxes, isLoading: toolboxesLoading } = useToolboxes()
  // Custom tools are per-Agent, so thread agentId so the preview includes them.
  const { tools: catalog, isLoading: catalogLoading } = useToolCatalog(agentId ?? undefined)

  // ── Individual grants picker dialog state ────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set())
  const extras = useMemo(() => extraToolNames ?? [], [extraToolNames])

  const openPicker = () => {
    setPickerSelected(new Set(extras))
    setPickerOpen(true)
  }
  const applyPicker = () => {
    const next = Array.from(pickerSelected).sort()
    onExtraToolNamesChange?.(next.length > 0 ? next : null)
    setPickerOpen(false)
  }
  const removeExtra = (name: string) => {
    const next = extras.filter((n) => n !== name)
    onExtraToolNamesChange?.(next.length > 0 ? next : null)
  }

  // Null/empty grants only core tools. Legacy agents were migrated explicitly;
  // never preview or assign the "all" toolbox as an implicit fallback.
  const allBuiltin = useMemo(() => toolboxes.find((tb) => tb.builtin && tb.name === 'all') ?? null, [toolboxes])
  const effectiveIds = useMemo(() => toolboxIds ?? [], [toolboxIds])

  // Compute the set of tool names the selection grants. Mirror the server
  // resolver: CORE_TOOLS ∪ (selected toolboxes' listed names); "*" expands to
  // all NATIVE catalog tools plus all CUSTOM catalog tools (MCP/plugin still
  // need an explicit name); names absent from the catalog are dropped.
  const grantedNames = useMemo<Set<string>>(() => {
    const granted = new Set<string>(CORE_TOOLS)
    const selectedBoxes = toolboxes.filter((tb) => effectiveIds.includes(tb.id))
    const wildcardNames = catalog
      .filter(
        (tool) =>
          tool.source === 'native' ||
          // Custom tools ride the wildcard, but only the ENABLED ones (matching
          // the server's enabled-only universe). MCP/plugin still need a name.
          (tool.source === 'custom' && tool.enabled !== false),
      )
      .map((tool) => tool.name)
    for (const box of selectedBoxes) {
      for (const name of box.toolNames) {
        if (name === '*') {
          for (const n of wildcardNames) granted.add(n)
        } else {
          granted.add(name)
        }
      }
    }
    // Individual grants (extra_tool_names) union in on top of toolboxes,
    // mirroring the server resolver.
    for (const name of extras) granted.add(name)
    return granted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolboxes, effectiveIds, catalog, extras])

  // The preview only shows tools that are BOTH granted and present in the
  // universe (catalog). This silently drops toolbox names with no matching
  // tool, exactly like the server's universe-intersection step.
  const previewSelected = useMemo<Set<string>>(() => {
    const set = new Set<string>()
    for (const tool of catalog) {
      if (grantedNames.has(tool.name)) set.add(tool.name)
    }
    return set
  }, [catalog, grantedNames])

  const previewTools = useMemo<ToolSelectorTool[]>(() => catalog as ToolSelectorTool[], [catalog])

  if (toolboxesLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-muted/30 p-4 space-y-3">
        <p className="text-sm font-medium">{t('experience.agent.effectiveCapabilities', '{{count}} available capabilities', { count: previewSelected.size })}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('experience.agent.grantHint', 'Choose only what this Agent needs. All native tools includes enabled custom tools; MCP and plugins remain explicit choices.')}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { onToolboxIdsChange(null); onExtraToolNamesChange?.(null) }}>{t('experience.agent.minimal', 'Minimal')}</Button>
          {allBuiltin && <Button type="button" variant="outline" size="sm" onClick={() => onToolboxIdsChange(Array.from(new Set([...effectiveIds, allBuiltin.id])))}>{t('experience.agent.allNative', 'Add all native tools')}</Button>}
        </div>
      </div>
      {/* ── Toolbox selection ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Wrench className="size-4" />
              {t('agent.tools.toolboxesTitle')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('agent.tools.toolboxesHint')}</p>
          </div>
          {onManageToolboxes && (
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onManageToolboxes}>
              <Settings2 className="size-3.5" />
              {t('agent.tools.manageToolboxes', 'Manage toolboxes')}
            </Button>
          )}
        </div>

        {toolboxes.length === 0 ? (
          <EmptyState
            minimal
            icon={Wrench}
            title={t('agent.tools.noToolboxesTitle')}
            description={t('agent.tools.noToolboxesDescription')}
          />
        ) : (
          <ToolboxMultiSelect
            toolboxes={toolboxes}
            selected={toolboxIds ?? []}
            onChange={(next) => onToolboxIdsChange(next.length > 0 ? next : null)}
          />
        )}

        {(!toolboxIds || toolboxIds.length === 0) && toolboxes.length > 0 && (
          <p className="text-xs text-muted-foreground">{t('experience.agent.minimalHint', 'No toolbox selected: only core capabilities are available. Plugins and MCP tools always require an explicit grant.')}</p>
        )}
      </div>

      {/* ── Individual grants (extra_tool_names) ──────────────────────── */}
      {onExtraToolNamesChange && (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <ShieldPlus className="size-4" />
                {t('agent.tools.extras.title')}
              </h3>
              <p className="text-xs text-muted-foreground">{t('agent.tools.extras.hint')}</p>
            </div>
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={openPicker}>
              <Plus className="size-3.5" />
              {t('agent.tools.extras.add')}
            </Button>
          </div>

          {extras.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('agent.tools.extras.empty')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {extras.map((name) => {
                const entry = catalog.find((c) => c.name === name)
                const fallback = typeof entry?.label === 'string' ? entry.label : entry?.label?.en ?? name
                const friendly = t(`tools.names.${name}`, fallback)
                return (
                <Badge key={name} variant="secondary" className="gap-1 pr-1 text-xs">
                  {entry && <ToolDomainIcon domain={entry.domain} className="size-3 text-muted-foreground" />}
                  {friendly}
                  <button
                    type="button"
                    aria-label={t('agent.tools.extras.remove', { name })}
                    className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                    onClick={() => removeExtra(name)}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
                )
              })}
            </div>
          )}

          <FormDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            title={t('agent.tools.extras.dialogTitle')}
            description={t('agent.tools.extras.dialogHint')}
            onSubmit={applyPicker}
            submitLabel={t('agent.tools.extras.apply')}
          >
            {catalogLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <ToolSelector
                tools={catalog as ToolSelectorTool[]}
                selected={pickerSelected}
                onChange={setPickerSelected}
              />
            )}
          </FormDialog>
        </div>
      )}

      {/* ── Resolved tools preview (read-only) ────────────────────────── */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">{t('agent.tools.resolvedPreviewTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('agent.tools.resolvedPreviewHint')}</p>
        </div>

        {catalogLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : previewSelected.size === 0 ? (
          <p className="text-sm text-muted-foreground">{t('agent.tools.resolvedPreviewEmpty')}</p>
        ) : (
          <ToolSelector
            tools={previewTools.filter((tool) => previewSelected.has(tool.name))}
            selected={previewSelected}
            onChange={() => {}}
            readOnly
            hideSwitches
          />
        )}
      </div>
    </div>
  )
}
