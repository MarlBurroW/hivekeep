/**
 * Unified tool-grant resolver.
 *
 * The TOOLBOX is the sole tool-grant primitive for main Agents AND tasks, across
 * all four tool sources: native, plugin, MCP, and custom. There is no per-Agent
 * gate and no capability flags.
 *
 * Resolution model
 * ----------------
 *   universe = native + plugin            (toolRegistry.resolve — both)
 *            + ALL global active MCP tools (resolveMCPTools — no per-Agent gate)
 *            + the Agent's custom tools      (resolveCustomTools)
 *
 *   allowed  = CORE_TOOLS ∪ resolveToolboxNames(toolboxIds)
 *              where a null/empty toolbox selection resolves to the 'all'
 *              built-in (by NAME, at runtime — never a SQL backfill).
 *
 *   toolset  = { name ∈ universe | name ∈ allowed }
 *
 * "*" inside a toolbox (the 'all' built-in) expands to all NATIVE tool names
 * plus all ENABLED custom tools — MCP and plugin tools must still be listed by
 * their stable name to be granted. A toolbox-listed name that is absent from
 * the universe is silently skipped (so a disabled custom tool added to the
 * allow-list is dropped — the custom part of the universe is enabled-only).
 *
 * For sub-Agents the HARD_EXCLUDED_FROM_SUBKIN floor is subtracted AFTER the
 * allow-list, so even an 'all' toolbox can't smuggle a main-session-only tool
 * into a task. (`spawn_self` / `spawn_agent` are intentionally NOT excluded.)
 *
 * This is the single tool-resolution path for every surface (main Agents, quick
 * sessions, and tasks). The toolbox is the sole tool-grant primitive — there is
 * no per-Agent tool config, no MCP access gate, and no network flag.
 */

import type { Tool } from '@/server/tools/tool-helper'
import { toolRegistry } from '@/server/tools/index'
import { resolveMCPTools } from '@/server/services/mcp'
import { resolveCustomTools } from '@/server/services/custom-tools'
import { CORE_TOOLS, getToolboxByName, resolveToolboxNames } from '@/server/services/toolboxes'
import { HARD_EXCLUDED_FROM_SUBKIN } from '@/server/services/tasks'
import { db } from '@/server/db'
import { agents } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import { createLogger } from '@/server/logger'

const log = createLogger('toolset-resolver')

/** Parse `agents.extra_tool_names` for an Agent (empty array when unset/malformed). */
export async function getAgentExtraToolNames(agentId: string): Promise<string[]> {
  const row = await db
    .select({ extraToolNames: agents.extraToolNames })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!row?.extraToolNames) return []
  try {
    const parsed = JSON.parse(row.extraToolNames)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Resolve a raw `agents.toolbox_ids` / `tasks.toolbox_ids` selection into a clean
 * array of toolbox **ids**.
 *
 * A null / empty / malformed selection resolves to NO toolboxes → the Agent's
 * toolset is just the mandatory CORE_TOOLS floor. Tools are granted by attaching
 * toolboxes (the 'all' built-in grants everything). This changed from the legacy
 * "null = all tools" rule, which predated toolboxes; existing null-toolbox Agents
 * are migrated to an explicit ['all'] selection at boot (migrate-agent-toolboxes)
 * so their behavior is preserved. Callers that create Agents (configurator,
 * AgentFormModal) assign explicit toolboxes.
 */
export function resolveAgentToolboxIds(raw: string[] | string | null | undefined): string[] {
  let ids: string[] = []

  if (Array.isArray(raw)) {
    ids = raw.filter((x): x is string => typeof x === 'string')
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        ids = parsed.filter((x): x is string => typeof x === 'string')
      }
    } catch {
      // Malformed — treat as absent.
    }
  }

  // No explicit selection → no toolboxes (CORE_TOOLS floor only).
  return ids
}

export interface ResolveToolsetOptions {
  agentId: string
  /** Raw toolbox selection from the Agent or task row (JSON string, array, or
   *  null). Null / empty → the 'all' built-in. */
  toolboxIds: string[] | string | null | undefined
  isSubAgent: boolean
  taskId?: string
  taskDepth?: number
  channelOriginId?: string
  cronId?: string
  userId?: string
  /** Reserved for quick-session callers (Stage 3 applies
   *  QUICK_SESSION_EXCLUDED_TOOLS at the call site, not here). */
  quick?: boolean
}

/**
 * Resolve the final toolset (Record<name, Tool>) for an Agent or task from its
 * toolbox selection, unifying native + plugin + MCP + custom under one
 * allow-list. See the module header for the exact model.
 */
export async function resolveToolset(
  opts: ResolveToolsetOptions,
): Promise<Record<string, Tool<any, any>>> {
  const {
    agentId,
    toolboxIds,
    isSubAgent,
    taskId,
    taskDepth,
    channelOriginId,
    cronId,
    userId,
  } = opts

  // ── Universe ──────────────────────────────────────────────────────────────
  // native + plugin (both from the tool registry).
  const registryTools = toolRegistry.resolve({
    agentId,
    userId,
    isSubAgent,
    taskId,
    taskDepth,
    channelOriginId,
    cronId,
  })

  // ALL global active MCP tools + ALL enabled GLOBAL custom tools (both
  // toolbox-gated by name; neither is per-Agent).
  const mcpTools = await resolveMCPTools(agentId)
  const customTools = resolveCustomTools()

  const universe: Record<string, Tool<any, any>> = {
    ...registryTools,
    ...mcpTools,
    ...customTools,
  }

  // ── Allow-list ──────────────────────────────────────────────────────────────
  // CORE_TOOLS ∪ (the toolboxes' listed names) ∪ the Agent's individual grants
  // (`agents.extra_tool_names`: manual additions + approved request_tool_access
  // requests). "*" → all native + all enabled custom. Extras are fetched here
  // (not threaded by callers) so every resolution path honours them; the
  // sub-Agent hard floor below still subtracts as usual.
  const resolvedIds = resolveAgentToolboxIds(toolboxIds)
  const allowed = new Set<string>([...CORE_TOOLS, ...resolveToolboxNames(resolvedIds)])
  for (const name of await getAgentExtraToolNames(agentId)) allowed.add(name)

  // ── Filter universe → toolset ─────────────────────────────────────────────────
  const toolset: Record<string, Tool<any, any>> = {}
  for (const [name, tool] of Object.entries(universe)) {
    if (allowed.has(name)) toolset[name] = tool
  }

  // ── Sub-Agent hard floor ──────────────────────────────────────────────────────
  if (isSubAgent) {
    for (const name of HARD_EXCLUDED_FROM_SUBKIN) {
      delete toolset[name]
    }
  }

  log.debug(
    {
      agentId,
      taskId,
      isSubAgent,
      toolboxIds: resolvedIds,
      universeCount: Object.keys(universe).length,
      toolsetCount: Object.keys(toolset).length,
      mcpCount: Object.keys(mcpTools).length,
      customCount: Object.keys(customTools).length,
    },
    'Unified toolset resolved',
  )

  return toolset
}
