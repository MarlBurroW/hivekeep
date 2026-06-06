import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { toolRegistry } from '@/server/tools/index'
import {
  listToolboxes,
  getToolbox,
  getToolboxByName,
  createToolbox,
  updateToolbox,
  deleteToolbox,
  resolveToolboxNames,
} from '@/server/services/toolboxes'
import { listCustomTools } from '@/server/services/custom-tools'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:toolbox-management')

// ─── Shared helpers ────────────────────────────────────────────────────────────

/** Map a service-layer toolbox error code to a human message for the LLM. */
function mapToolboxError(err: unknown): string {
  const code = err instanceof Error ? err.message : 'INTERNAL'
  switch (code) {
    case 'TOOLBOX_NAME_TAKEN':
      return 'A toolbox with this name already exists — pick another name or update the existing one.'
    case 'TOOLBOX_NAME_REQUIRED':
      return 'A toolbox name is required.'
    case 'TOOLBOX_BUILTIN_READONLY':
      return 'Built-in toolboxes cannot be edited or deleted.'
    case 'TOOLBOX_NOT_FOUND':
      return 'Toolbox not found.'
    default:
      return code
  }
}

/** The set of grantable tool names a toolbox may legitimately reference:
 *  native + plugin tools (the registry) + enabled/disabled custom tools.
 *  MCP names (`mcp_*`) are dynamic and validated leniently (allowed through). */
function knownToolNames(): Set<string> {
  const set = new Set<string>()
  for (const t of toolRegistry.list()) set.add(t.name)
  try {
    for (const ct of listCustomTools()) set.add(`custom_${ct.slug}`)
  } catch {
    // best-effort — a custom-tools read failure shouldn't block validation
  }
  return set
}

/** Return the names that don't correspond to any grantable tool. `*` (the
 *  wildcard) and `mcp_*` (dynamic) are always accepted. */
function findUnknownToolNames(names: string[]): string[] {
  const known = knownToolNames()
  return names.filter((n) => n !== '*' && !n.startsWith('mcp_') && !known.has(n))
}

/** Normalize a tool-name list: trim, drop empties, de-duplicate (preserve order). */
function cleanToolNames(names: string[]): string[] {
  return Array.from(new Set(names.map((n) => n.trim()).filter((n) => n.length > 0)))
}

/** Resolve a toolbox by id OR name. */
function resolveToolbox(idOrName: string) {
  return getToolbox(idOrName) ?? getToolboxByName(idOrName.trim())
}

// ─── list_tools — the catalog (no schemas) ──────────────────────────────────────

/**
 * list_tools — enumerate every grantable tool (native / plugin / MCP / custom)
 * with a one-line description, WITHOUT input schemas. This lets a Kin discover
 * tools it doesn't itself hold so it can compose a minimal toolbox. Read-only.
 */
export const listToolsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  defaultDisabled: true,
  create: () =>
    tool({
      description:
        'List the catalog of EVERY grantable tool (native, plugin, MCP, custom) with a short description — WITHOUT input schemas (those are too large). Use this to discover tools you do not yourself have access to, then reference their exact names in create_toolbox / update_toolbox to give a Kin exactly what it needs. Optional filters narrow the (large) list: domain, source, or a free-text query matched against name + description.',
      inputSchema: z.object({
        query: z.string().optional().describe('Case-insensitive substring matched against tool name + description (e.g. "calendar", "memory").'),
        domain: z.string().optional().describe('Restrict to one domain (e.g. "memory", "email", "filesystem"). See the domain field in results.'),
        source: z.enum(['native', 'plugin', 'mcp', 'custom']).optional().describe('Restrict to one source.'),
      }),
      execute: async ({ query, domain, source }) => {
        type Entry = {
          name: string
          source: 'native' | 'plugin' | 'mcp' | 'custom'
          domain: string
          description: string | null
          readOnly: boolean
          destructive: boolean
        }
        const entries: Entry[] = []

        // native + plugin (the registry; plugin tools carry the plugin_ prefix)
        for (const t of toolRegistry.list()) {
          entries.push({
            name: t.name,
            source: t.name.startsWith('plugin_') ? 'plugin' : 'native',
            domain: t.domain,
            description: toolRegistry.describe(t.name) ?? null,
            readOnly: t.readOnly,
            destructive: t.destructive,
          })
        }

        // custom (GLOBAL scripts, callable as custom_<slug> once a toolbox grants them)
        try {
          for (const ct of listCustomTools()) {
            entries.push({
              name: `custom_${ct.slug}`,
              source: 'custom',
              domain: (ct.domainSlug as string) ?? 'custom',
              description: ct.description ?? null,
              readOnly: false,
              destructive: false,
            })
          }
        } catch (err) {
          log.warn({ err }, 'list_tools: custom tool enumeration failed')
        }

        // MCP (all global active servers — best-effort; a flaky server must not fail the call)
        try {
          const { listAllMCPCatalogTools } = await import('@/server/services/mcp')
          const mcp = await listAllMCPCatalogTools()
          for (const m of mcp) {
            entries.push({
              name: m.name,
              source: 'mcp',
              domain: 'mcp',
              description: m.description ?? null,
              readOnly: false,
              destructive: false,
            })
          }
        } catch (err) {
          log.warn({ err }, 'list_tools: MCP tool enumeration failed')
        }

        let out = entries
        if (source) out = out.filter((e) => e.source === source)
        if (domain) out = out.filter((e) => e.domain === domain)
        if (query) {
          const q = query.toLowerCase()
          out = out.filter(
            (e) => e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q),
          )
        }
        out.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))

        return {
          total: out.length,
          note: 'Schemas are omitted. The "all" toolbox already grants every native + custom tool; build a narrower toolbox only when a Kin needs a focused subset.',
          tools: out,
        }
      },
    }),
}

// ─── list_toolboxes — discover toolboxes ────────────────────────────────────────

/**
 * list_toolboxes — discover the toolboxes available to grant a Kin.
 * Read-only. Backs the "Use list_toolboxes to discover more" guidance in
 * create_kin / update_kin.
 */
export const listToolboxesTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  defaultDisabled: true,
  create: () =>
    tool({
      description:
        "List the toolboxes you can grant a Kin (built-in and user-defined). A Kin's toolset is the mandatory core floor unioned with every granted toolbox. Use the returned names with create_kin / update_kin; edit user-defined ones with update_toolbox / delete_toolbox (built-ins are read-only).",
      inputSchema: z.object({}),
      execute: async () => {
        const boxes = listToolboxes()
        return {
          toolboxes: boxes.map((b) => {
            const wildcard = b.toolNames.includes('*')
            return {
              name: b.name,
              description: b.description ?? null,
              builtin: b.builtin,
              // "*" means "all native + enabled custom tools" — report the
              // expanded count so the model sees how broad it is.
              toolCount: wildcard ? resolveToolboxNames([b.id]).length : b.toolNames.length,
              // Raw declared names so the model can inspect/edit a toolbox's
              // contents ("*" is shown verbatim rather than expanded).
              tools: b.toolNames,
            }
          }),
        }
      },
    }),
}

// ─── create_toolbox ─────────────────────────────────────────────────────────────

/**
 * create_toolbox — define a new user toolbox (a named, minimal allow-list of
 * tools) so a Kin can be granted exactly what it needs. Validates tool names
 * against the catalog to reject typos/hallucinations.
 */
export const createToolboxTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: () =>
    tool({
      description:
        'Create a new user-defined toolbox: a named, minimal set of tools to grant a Kin exactly what its job needs (instead of the broad "all"). Discover valid tool names with list_tools first. Tool names are validated — unknown names are rejected. The core floor is always added on top automatically, so list only the extra tools.',
      inputSchema: z.object({
        name: z.string().describe('Unique toolbox name (lowercase-kebab recommended). Cannot collide with a built-in (all/research/ops/code/scout/email/calendar/address-book/configurator) or an existing toolbox.'),
        description: z.string().optional().describe('What this toolbox is for (shown in the UI and to list_toolboxes).'),
        tools: z.array(z.string()).describe('Exact tool names to include (from list_tools). Keep it minimal — only what the Kin needs. Do NOT include core-floor tools (always present). "*" would grant everything (that is just the "all" box).'),
      }),
      execute: async ({ name, description, tools }) => {
        const cleaned = cleanToolNames(tools)
        const unknown = findUnknownToolNames(cleaned)
        if (unknown.length > 0) {
          return { error: `Unknown tool name(s): ${unknown.join(', ')}. Call list_tools to see exact names.` }
        }
        try {
          const box = createToolbox({ name, description: description ?? null, toolNames: cleaned })
          log.info({ name: box.name, count: cleaned.length }, 'Toolbox created via tool')
          return { id: box.id, name: box.name, description: box.description, tools: box.toolNames }
        } catch (err) {
          return { error: mapToolboxError(err) }
        }
      },
    }),
}

// ─── update_toolbox ─────────────────────────────────────────────────────────────

/**
 * update_toolbox — edit a user-defined toolbox (rename, re-describe, or change
 * its tools via full replace or incremental add/remove). Built-ins are rejected.
 */
export const updateToolboxTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: () =>
    tool({
      description:
        "Edit a user-defined toolbox. Change its name/description, replace its full tool list (`tools`), or adjust incrementally (`add` / `remove`). Built-in toolboxes cannot be edited. Inspect a toolbox's current tools with list_toolboxes first. Tool names are validated against the catalog.",
      inputSchema: z.object({
        toolbox: z.string().describe('Name or id of the user-defined toolbox to edit.'),
        name: z.string().optional().describe('New name.'),
        description: z.string().optional().describe('New description.'),
        tools: z.array(z.string()).optional().describe('Replace the ENTIRE tool list with this set (ignores add/remove).'),
        add: z.array(z.string()).optional().describe('Tool names to add to the current set.'),
        remove: z.array(z.string()).optional().describe('Tool names to remove from the current set.'),
      }),
      execute: async ({ toolbox, name, description, tools, add, remove }) => {
        const box = resolveToolbox(toolbox)
        if (!box) return { error: `Toolbox "${toolbox}" not found.` }
        if (box.builtin) return { error: `"${box.name}" is a built-in toolbox and cannot be edited.` }

        const patch: { name?: string; description?: string | null; toolNames?: string[] } = {}
        if (name !== undefined) patch.name = name
        if (description !== undefined) patch.description = description

        let nextTools: string[] | undefined
        if (tools !== undefined) {
          nextTools = tools
        } else if (add !== undefined || remove !== undefined) {
          const set = new Set(box.toolNames)
          for (const a of add ?? []) {
            const t = a.trim()
            if (t) set.add(t)
          }
          for (const r of remove ?? []) set.delete(r.trim())
          nextTools = Array.from(set)
        }

        if (nextTools !== undefined) {
          const cleaned = cleanToolNames(nextTools)
          const unknown = findUnknownToolNames(cleaned)
          if (unknown.length > 0) {
            return { error: `Unknown tool name(s): ${unknown.join(', ')}. Call list_tools to see exact names.` }
          }
          patch.toolNames = cleaned
        }

        if (Object.keys(patch).length === 0) {
          return { error: 'Nothing to update — provide name, description, tools, add, or remove.' }
        }

        try {
          const updated = updateToolbox(box.id, patch)
          log.info({ name: updated.name }, 'Toolbox updated via tool')
          return { id: updated.id, name: updated.name, description: updated.description, tools: updated.toolNames }
        } catch (err) {
          return { error: mapToolboxError(err) }
        }
      },
    }),
}

// ─── delete_toolbox ─────────────────────────────────────────────────────────────

/**
 * delete_toolbox — remove a user-defined toolbox. Built-ins are rejected. Kins
 * that referenced it silently lose those tools (the reference is dropped at
 * resolution), so warn the user before deleting a toolbox in use.
 */
export const deleteToolboxTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  destructive: true,
  create: () =>
    tool({
      description:
        'Delete a user-defined toolbox. Irreversible. Built-in toolboxes cannot be deleted. Any Kin that was granted this toolbox silently loses those tools, so check first and warn the user.',
      inputSchema: z.object({
        toolbox: z.string().describe('Name or id of the user-defined toolbox to delete.'),
        confirm: z.literal(true).describe('Must be true to confirm deletion.'),
      }),
      execute: async ({ toolbox, confirm }) => {
        if (!confirm) return { error: 'Deletion must be explicitly confirmed with confirm: true.' }
        const box = resolveToolbox(toolbox)
        if (!box) return { error: `Toolbox "${toolbox}" not found.` }
        if (box.builtin) return { error: `"${box.name}" is a built-in toolbox and cannot be deleted.` }
        try {
          deleteToolbox(box.id)
          log.warn({ name: box.name }, 'Toolbox deleted via tool')
          return { success: true, deleted: box.name }
        } catch (err) {
          return { error: mapToolboxError(err) }
        }
      },
    }),
}
