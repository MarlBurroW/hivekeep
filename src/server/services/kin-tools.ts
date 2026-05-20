import type { KinToolConfig, ToolDomain } from '@/shared/types'

/**
 * Pure bucketing helper for the Kin Tools route.
 *
 * Takes the flat list of registered tools (each tagged with the domain
 * declared at registration time), the per-plugin tool-name grouping, and
 * the Kin's tool config, and returns the per-bucket structure the UI
 * consumes. Native tools are grouped by ToolDomain; plugin tools are
 * grouped per plugin, sourced from `pluginGroups` directly so plugin
 * names and tool names round-trip safely.
 */

export interface ToolEntry {
  name: string
  domain: ToolDomain
  defaultDisabled: boolean
  /** Author-supplied display label. May be locale-keyed. */
  label?: string | Record<string, string>
}

export interface ToolListItem {
  name: string
  enabled: boolean
  defaultDisabled: boolean
  /** Author-supplied display label, locale-keyed. The frontend
   *  picks the user's locale, falls back to `en`, then to any first
   *  entry, then to a prettified `name`. */
  label?: string | Record<string, string>
}

export interface KinNativeToolGroup {
  domain: ToolDomain
  tools: ToolListItem[]
}

export interface KinPluginToolGroup {
  pluginName: string
  tools: ToolListItem[]
}

export interface BuildKinToolBucketsInput {
  /** Every tool currently in the registry (core + plugin), flat. */
  registered: ToolEntry[]
  /** Plugin tool ownership, sourced from PluginManager.listToolsByPlugin(). */
  pluginGroups: Array<{ pluginName: string; toolNames: string[] }>
  /** The Kin's persisted tool config; null when nothing has been saved yet. */
  toolConfig: KinToolConfig | null
}

export interface BuildKinToolBucketsResult {
  nativeTools: KinNativeToolGroup[]
  pluginTools: KinPluginToolGroup[]
}

function isEnabled(tool: ToolEntry, toolConfig: KinToolConfig | null): boolean {
  if (tool.defaultDisabled) {
    return toolConfig?.enabledOptInTools?.includes(tool.name) ?? false
  }
  return !toolConfig?.disabledNativeTools?.includes(tool.name)
}

export function buildKinToolBuckets(input: BuildKinToolBucketsInput): BuildKinToolBucketsResult {
  const { registered, pluginGroups, toolConfig } = input

  const pluginToolNameSet = new Set(pluginGroups.flatMap((g) => g.toolNames))
  const registeredByName = new Map(registered.map((t) => [t.name, t]))

  // Native bucket: every registered non-plugin tool grouped by its domain.
  // The domain is part of the registration (single source of truth) so a
  // new tool can't accidentally be invisible in the UI.
  const domainGroupsMap = new Map<ToolDomain, ToolListItem[]>()
  for (const t of registered) {
    if (pluginToolNameSet.has(t.name)) continue
    if (!domainGroupsMap.has(t.domain)) domainGroupsMap.set(t.domain, [])
    domainGroupsMap.get(t.domain)!.push({
      name: t.name,
      enabled: isEnabled(t, toolConfig),
      defaultDisabled: t.defaultDisabled,
      ...(t.label !== undefined ? { label: t.label } : {}),
    })
  }
  const nativeTools: KinNativeToolGroup[] = Array.from(domainGroupsMap.entries()).map(([domain, tools]) => ({
    domain,
    tools,
  }))

  // Plugin bucket: one group per plugin that has at least one registered
  // tool. We resolve each tool name back through the registry to pick up
  // the defaultDisabled flag the plugin loader set (always true today,
  // but we honor whatever the registry says rather than assume).
  const pluginTools: KinPluginToolGroup[] = pluginGroups
    .map(({ pluginName, toolNames }) => {
      const tools: ToolListItem[] = []
      for (const name of toolNames) {
        const reg = registeredByName.get(name)
        if (!reg) continue
        tools.push({
          name: reg.name,
          enabled: isEnabled(reg, toolConfig),
          defaultDisabled: reg.defaultDisabled,
          ...(reg.label !== undefined ? { label: reg.label } : {}),
        })
      }
      return { pluginName, tools }
    })
    .filter((g) => g.tools.length > 0)

  return { nativeTools, pluginTools }
}
