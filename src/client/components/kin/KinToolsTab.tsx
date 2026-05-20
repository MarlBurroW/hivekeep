import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/client/components/ui/switch'
import { Label } from '@/client/components/ui/label'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/components/ui/collapsible'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { Badge } from '@/client/components/ui/badge'
import { useKinTools, type NativeToolGroup, type McpToolGroup, type PluginToolGroup, type ToolLabel } from '@/client/hooks/useKinTools'
import { TOOL_DOMAIN_META } from '@/shared/constants'
import { ChevronRight, Loader2, Plug, Puzzle } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import type { KinToolConfig, ToolDomain } from '@/shared/types'

interface KinToolsTabProps {
  kinId: string | null
  toolConfig: KinToolConfig | null
  onToolConfigChange: (config: KinToolConfig | null) => void
  isHub?: boolean
}

function getEffectiveConfig(config: KinToolConfig | null): KinToolConfig {
  return config ?? { disabledNativeTools: [], mcpAccess: {}, enabledOptInTools: [] }
}

/**
 * Resolve a tool label for display:
 *   - string label → use as-is
 *   - locale map → user's lang, then `en`, then any first entry
 *   - undefined → strip the `plugin_<plugin-name>_` prefix from the
 *     raw tool name so we don't render `plugin_kinbot-plugin-…_x`
 *     unless the plugin author explicitly opted out of providing a label
 */
function resolveToolLabel(name: string, label: ToolLabel | undefined, lang: string): string {
  if (typeof label === 'string') return label
  if (label && typeof label === 'object') {
    return label[lang] ?? label.en ?? label[Object.keys(label)[0] ?? ''] ?? prettifyToolName(name)
  }
  return prettifyToolName(name)
}

function prettifyToolName(name: string): string {
  // `plugin_<plugin-name>_<tool>` → `<tool>`. Plugin scope is already
  // shown as the group header, no need to repeat it on every row.
  // The plugin name uses dashes (npm convention) so `[^_]+` greedily
  // matches it in one shot.
  const match = name.match(/^plugin_[^_]+_(.+)$/)
  return match ? match[1]! : name
}

export function KinToolsTab({ kinId, toolConfig, onToolConfigChange, isHub }: KinToolsTabProps) {
  const { t, i18n } = useTranslation()
  const { nativeTools, pluginTools, mcpTools, isLoading } = useKinTools(kinId)
  const userLang = (i18n.language || 'en').split('-')[0]! // 'fr-FR' → 'fr'

  const config = getEffectiveConfig(toolConfig)

  // ─── Native tool toggle (dual model: deny-list + opt-in allow-list) ──

  const isNativeToolEnabled = (toolName: string, defaultDisabled?: boolean) => {
    if (defaultDisabled) {
      // Opt-in tool: enabled only if in enabledOptInTools
      return config.enabledOptInTools?.includes(toolName) ?? false
    }
    // Standard tool: enabled unless in disabledNativeTools
    return !config.disabledNativeTools.includes(toolName)
  }

  const toggleNativeTool = (toolName: string, defaultDisabled?: boolean) => {
    if (defaultDisabled) {
      // Toggle in the opt-in allow-list
      const optIn = new Set(config.enabledOptInTools ?? [])
      if (optIn.has(toolName)) {
        optIn.delete(toolName)
      } else {
        optIn.add(toolName)
      }
      onToolConfigChange({
        ...config,
        enabledOptInTools: Array.from(optIn),
      })
    } else {
      // Existing deny-list toggle
      const disabled = new Set(config.disabledNativeTools)
      if (disabled.has(toolName)) {
        disabled.delete(toolName)
      } else {
        disabled.add(toolName)
      }
      onToolConfigChange({
        ...config,
        disabledNativeTools: Array.from(disabled),
      })
    }
  }

  const toggleDomain = (group: NativeToolGroup) => {
    const isOptIn = group.tools.some((t) => t.defaultDisabled)
    const allEnabled = group.tools.every((t) => isNativeToolEnabled(t.name, t.defaultDisabled))

    if (isOptIn) {
      // Opt-in domain: toggle in enabledOptInTools
      const optIn = new Set(config.enabledOptInTools ?? [])
      for (const tool of group.tools) {
        if (allEnabled) {
          optIn.delete(tool.name)
        } else {
          optIn.add(tool.name)
        }
      }
      onToolConfigChange({
        ...config,
        enabledOptInTools: Array.from(optIn),
      })
    } else {
      // Standard domain: toggle in disabledNativeTools
      const disabled = new Set(config.disabledNativeTools)
      for (const tool of group.tools) {
        if (allEnabled) {
          disabled.add(tool.name)
        } else {
          disabled.delete(tool.name)
        }
      }
      onToolConfigChange({
        ...config,
        disabledNativeTools: Array.from(disabled),
      })
    }
  }

  // ─── Plugin tool toggles ────────────────────────────────────────────
  // Plugin tools are always opt-in (the plugin loader forces
  // defaultDisabled: true), so individual rows reuse the same
  // enabledOptInTools allow-list as opt-in native tools. The group
  // toggle bulk-adds/removes every tool name in the plugin.

  const togglePluginGroup = (group: PluginToolGroup) => {
    const allEnabled = group.tools.every((t) => isNativeToolEnabled(t.name, true))
    const optIn = new Set(config.enabledOptInTools ?? [])
    for (const tool of group.tools) {
      if (allEnabled) optIn.delete(tool.name)
      else optIn.add(tool.name)
    }
    onToolConfigChange({ ...config, enabledOptInTools: Array.from(optIn) })
  }

  // ─── MCP tool toggle ──────────────────────────────────────────────

  const isMcpToolEnabled = (serverId: string, toolName: string, autoEnabled: boolean) => {
    const access = config.mcpAccess[serverId]
    if (access) return access.includes('*') || access.includes(toolName)
    return autoEnabled
  }

  const toggleMcpTool = (server: McpToolGroup, toolName: string) => {
    const newAccess = { ...config.mcpAccess }
    const current = newAccess[server.serverId] ?? (server.autoEnabled ? ['*'] : [])

    // Expand '*' to the full list of tool names
    let toolList: string[]
    if (current.includes('*')) {
      toolList = server.tools.map((t) => t.name)
    } else {
      toolList = [...current]
    }

    if (toolList.includes(toolName)) {
      toolList = toolList.filter((n) => n !== toolName)
    } else {
      toolList.push(toolName)
    }

    // If all tools are enabled, store '*' for compactness
    if (toolList.length === server.tools.length) {
      newAccess[server.serverId] = ['*']
    } else if (toolList.length === 0) {
      delete newAccess[server.serverId]
    } else {
      newAccess[server.serverId] = toolList
    }

    onToolConfigChange({ ...config, mcpAccess: newAccess })
  }

  const toggleMcpServer = (server: McpToolGroup) => {
    const allEnabled = server.tools.length > 0 && server.tools.every((t) =>
      isMcpToolEnabled(server.serverId, t.name, server.autoEnabled),
    )

    const newAccess = { ...config.mcpAccess }
    if (allEnabled) {
      delete newAccess[server.serverId]
      // If it was auto-enabled, we need to explicitly disable by setting empty
      if (server.autoEnabled) {
        newAccess[server.serverId] = []
      }
    } else {
      newAccess[server.serverId] = ['*']
    }

    onToolConfigChange({ ...config, mcpAccess: newAccess })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {isHub && (
        <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <Plug className="mt-0.5 size-4 shrink-0 text-primary" />
          <p className="text-sm text-muted-foreground">
            {t('kin.tools.hubNotice')}
          </p>
        </div>
      )}
      {/* Native tools */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('kin.tools.native')}</h3>

        {nativeTools.map((group) => {
          const isOptIn = group.tools.some((t) => t.defaultDisabled)
          const enabledCount = group.tools.filter((t) => isNativeToolEnabled(t.name, t.defaultDisabled)).length
          const allEnabled = enabledCount === group.tools.length

          return (
            <DomainGroup
              key={group.domain}
              domain={group.domain}
              enabledCount={enabledCount}
              totalCount={group.tools.length}
              allEnabled={allEnabled}
              isOptIn={isOptIn}
              onToggleAll={() => toggleDomain(group)}
            >
              {group.tools.map((tool) => {
                const friendlyLabel = t(`tools.names.${tool.name}`, tool.name)
                const showKey = friendlyLabel !== tool.name
                return (
                  <ToolRow
                    key={tool.name}
                    label={friendlyLabel}
                    toolKey={showKey ? tool.name : undefined}
                    enabled={isNativeToolEnabled(tool.name, tool.defaultDisabled)}
                    onToggle={() => toggleNativeTool(tool.name, tool.defaultDisabled)}
                  />
                )
              })}
            </DomainGroup>
          )
        })}
      </div>

      {/* Plugin tools */}
      {pluginTools.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t('kin.tools.plugins')}</h3>

          {pluginTools.map((group) => {
            const enabledCount = group.tools.filter((t) => isNativeToolEnabled(t.name, true)).length
            const allEnabled = enabledCount === group.tools.length
            return (
              <PluginGroup
                key={group.pluginName}
                pluginName={group.pluginName}
                enabledCount={enabledCount}
                totalCount={group.tools.length}
                allEnabled={allEnabled}
                onToggleAll={() => togglePluginGroup(group)}
              >
                {group.tools.map((tool) => (
                  <ToolRow
                    key={tool.name}
                    label={resolveToolLabel(tool.name, tool.label, userLang)}
                    enabled={isNativeToolEnabled(tool.name, true)}
                    onToggle={() => toggleNativeTool(tool.name, true)}
                  />
                ))}
              </PluginGroup>
            )
          })}
        </div>
      )}

      {/* MCP tools */}
      {(mcpTools.length > 0 || kinId) && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">{t('kin.tools.mcp')}</h3>

          {!kinId ? (
            <p className="text-sm text-muted-foreground">{t('kin.tools.saveMcpHint')}</p>
          ) : mcpTools.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('kin.tools.noMcp')}</p>
          ) : (
            mcpTools.map((server) => {
              const enabledCount = server.tools.filter((t) =>
                isMcpToolEnabled(server.serverId, t.name, server.autoEnabled),
              ).length
              const allEnabled = server.tools.length > 0 && enabledCount === server.tools.length

              return (
                <McpServerGroup
                  key={server.serverId}
                  serverName={server.serverName}
                  autoEnabled={server.autoEnabled}
                  enabledCount={enabledCount}
                  totalCount={server.tools.length}
                  allEnabled={allEnabled}
                  disabled={server.tools.length === 0}
                  onToggleAll={() => toggleMcpServer(server)}
                >
                  {server.tools.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground italic">
                      {t('kin.tools.connectionFailed')}
                    </div>
                  ) : (
                    server.tools.map((tool) => (
                      <ToolRow
                        key={tool.name}
                        label={tool.name}
                        description={tool.description}
                        enabled={isMcpToolEnabled(server.serverId, tool.name, server.autoEnabled)}
                        onToggle={() => toggleMcpTool(server, tool.name)}
                      />
                    ))
                  )}
                </McpServerGroup>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────

function DomainGroup({
  domain,
  enabledCount,
  totalCount,
  allEnabled,
  isOptIn,
  onToggleAll,
  children,
}: {
  domain: ToolDomain
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  isOptIn?: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const meta = TOOL_DOMAIN_META[domain]
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        {/* Domain header */}
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left"
            >
              <ChevronRight className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )} />
              <span className={`flex size-6 items-center justify-center rounded-md ${meta.bg}`}>
                <ToolDomainIcon domain={domain} className={`size-3.5 ${meta.text}`} />
              </span>
              <span className="text-sm font-medium">{t(meta.labelKey)}</span>
              {isOptIn && (
 <Badge variant="secondary" size="xs">
                  {t('kin.tools.optIn')}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {t('kin.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            size="sm"
            checked={allEnabled}
            onCheckedChange={onToggleAll}
          />
        </div>

        {/* Tool list */}
        <CollapsibleContent>
          <div className="border-t">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function PluginGroup({
  pluginName,
  enabledCount,
  totalCount,
  allEnabled,
  onToggleAll,
  children,
}: {
  pluginName: string
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left"
            >
              <ChevronRight className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )} />
              <span className="flex size-6 items-center justify-center rounded-md bg-primary/10">
                <Puzzle className="size-3.5 text-primary" />
              </span>
              <span className="text-sm font-medium">{t('kin.tools.pluginGroup', { name: pluginName })}</span>
              <Badge variant="secondary" size="xs">
                {t('kin.tools.optIn')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t('kin.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            size="sm"
            checked={allEnabled}
            onCheckedChange={onToggleAll}
          />
        </div>

        <CollapsibleContent>
          <div className="border-t">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function McpServerGroup({
  serverName,
  autoEnabled,
  enabledCount,
  totalCount,
  allEnabled,
  disabled,
  onToggleAll,
  children,
}: {
  serverName: string
  autoEnabled: boolean
  enabledCount: number
  totalCount: number
  allEnabled: boolean
  disabled?: boolean
  onToggleAll: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-lg border bg-card/50">
        {/* Server header */}
        <div className="flex items-center justify-between px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-2 text-left"
            >
              <ChevronRight className={cn(
                'size-3.5 text-muted-foreground transition-transform',
                open && 'rotate-90',
              )} />
              <span className="flex size-6 items-center justify-center rounded-md bg-muted">
                <Plug className="size-3.5 text-muted-foreground" />
              </span>
              <span className="text-sm font-medium">{serverName}</span>
              {autoEnabled && (
 <Badge variant="secondary" size="xs">
                  {t('kin.tools.autoEnabled')}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">
                {t('kin.tools.countEnabled', { count: enabledCount, total: totalCount })}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            size="sm"
            checked={allEnabled}
            disabled={disabled}
            onCheckedChange={onToggleAll}
          />
        </div>

        {/* Tool list */}
        <CollapsibleContent>
          <div className="border-t">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function ToolRow({
  label,
  toolKey,
  description,
  enabled,
  onToggle,
}: {
  label: string
  /** Optional tool identifier (e.g. "browser_open_session") shown muted next to the label */
  toolKey?: string
  description?: string
  enabled: boolean
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
        {description && (
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch
        size="sm"
        checked={enabled}
        onCheckedChange={onToggle}
      />
    </div>
  )
}
