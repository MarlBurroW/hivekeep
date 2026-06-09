/**
 * Toolboxes — global, user-defined (and built-in) named sets of tools.
 *
 * A toolbox is an explicit allow-list of individual tool names. The special
 * value "*" inside a toolbox's `toolNames` means "all native tools + all
 * (enabled) custom tools" (used by the built-in 'all' toolbox). MCP and plugin
 * tools are NOT covered by "*" — they must be listed by their explicit name.
 *
 * A task references an ARRAY of toolboxes (tasks.toolboxIds). The task's
 * resolved native toolset is:
 *
 *     CORE_TOOLS  UNION  (union of every referenced toolbox's toolNames)
 *
 * where "*" expands to every registered native tool name plus every enabled
 * custom tool (`custom_<slug>`). CORE_TOOLS is a mandatory floor that is always
 * present regardless of the chosen toolboxes — see tool-presets.ts (the
 * authoritative list lives there).
 *
 * Custom tools join the "*" wildcard because they are the user's own
 * first-class extensions. MCP servers and plugin tools are NOT covered by "*";
 * to grant one a toolbox must list it by name.
 *
 * Built-in toolboxes (builtin=true) are seeded idempotently at startup from the
 * exact lists in tool-presets.ts and cannot be edited or deleted.
 */

import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { toolboxes } from '@/server/db/schema'
import { toolRegistry } from '@/server/tools/index'
import { listCustomTools } from '@/server/services/custom-tools'
import { CORE_TOOLS } from '@/server/services/tool-presets'
import { createLogger } from '@/server/logger'
import { sseManager } from '@/server/sse/index'
import type { Toolbox } from '@/shared/types'

const log = createLogger('toolboxes')

// ─── Built-in toolbox definitions ──────────────────────────────────────────────
// These mirror tool-presets.ts exactly. The 'code' / 'research' / 'ops' lists
// are the `extras` of the matching preset (CORE_TOOLS is layered on top at
// resolution time, so it is intentionally NOT duplicated here). 'all' is the
// wildcard, and 'scout' is a new read-only exploration set.

export interface BuiltinToolboxDef {
  name: string
  description: string
  toolNames: string[]
}

export const BUILTIN_TOOLBOXES: readonly BuiltinToolboxDef[] = [
  {
    name: 'code',
    description: 'Ticket-bound implementation work: project/ticket tools, web docs lookup, read-only memory, and project knowledge.',
    toolNames: [
      // Project & ticket tools.
      'list_projects',
      'get_project',
      'list_project_tags',
      'list_tickets',
      'get_ticket',
      'get_task_detail',
      'get_task_messages',
      'update_ticket',
      'create_ticket',
      'add_ticket_tag',
      'remove_ticket_tag',
      'set_active_project',
      // Web.
      'web_search',
      'browse_url',
      'extract_links',
      // Memory (read-only).
      'recall',
      'list_memories',
      // Project knowledge.
      'add_project_knowledge',
      'search_project_knowledge',
      'list_project_knowledge',
      'get_project_knowledge',
      'update_project_knowledge',
      'pin_project_knowledge',
      // Delegation — offload heavy read-only exploration to a cheap scout model.
      'scout',
    ],
  },
  {
    name: 'research',
    description: 'Web research and knowledge capture: browsing, history, summaries, and full memory read/write.',
    toolNames: [
      'web_search',
      'browse_url',
      'extract_links',
      'screenshot_url',
      'search_history',
      'browse_history',
      'read_message',
      'list_summaries',
      'read_summary',
      'recall',
      'memorize',
      'update_memory',
      'forget',
      'list_memories',
      'review_memories',
      // Delegation — offload heavy read-only exploration to a cheap scout model.
      'scout',
    ],
  },
  {
    name: 'ops',
    description: 'Operations and integrations: memory, vault secrets, redaction, HTTP requests, and system info.',
    toolNames: [
      'recall',
      'memorize',
      'list_memories',
      'get_secret',
      'search_secrets',
      'redact_message',
      'http_request',
      'get_system_info',
      // Delegation — offload heavy read-only exploration to a cheap scout model.
      'scout',
    ],
  },
  {
    name: 'all',
    description: 'All native tools plus all custom tools (no filtering beyond the safety floor). MCP and plugin tools must still be granted by name.',
    toolNames: ['*'],
  },
  {
    name: 'scout',
    description: 'Read-only exploration: grep, file/directory reads, and web lookups. No writes.',
    toolNames: [
      'grep',
      'read_file',
      'list_directory',
      'web_search',
      'browse_url',
      'extract_links',
    ],
  },
  {
    name: 'email',
    description: 'Email account access: list, read, search, and send mail through connected accounts. Set up triggers that react to incoming email.',
    toolNames: [
      'list_email_accounts',
      'list_emails',
      'read_email',
      'search_emails',
      'send_email',
      'download_email_attachment',
      'describe_trigger_conditions',
      'list_email_folders',
      'create_account_trigger',
      'list_account_triggers',
      'update_account_trigger',
      'delete_account_trigger',
    ],
  },
  {
    name: 'address-book',
    description:
      "Read-only EXTERNAL address books (iCloud, …): list and search contacts (names, phones, emails). Separate from Hivekeep's own contacts.",
    toolNames: [
      'list_address_books',
      'list_address_book_contacts',
      'get_address_book_contact',
      'search_address_book',
    ],
  },
  {
    name: 'calendar',
    description: 'Calendar access (Google, Outlook, CalDAV): list and search events, create, update and delete events.',
    toolNames: [
      'list_calendar_accounts',
      'list_calendars',
      'list_events',
      'get_event',
      'create_event',
      'update_event',
      'delete_event',
    ],
  },
  {
    name: 'configurator',
    description:
      "Platform configuration set for the onboarding guide (Queenie): connect/test AI providers (secure popup), set defaults, configure channels, customize the avatar style, edit the global prompt, manage contacts/memory, set up email triggers, and create the user's first Agents.",
    toolNames: [
      // Provider discovery + secure setup + defaults.
      'describe_provider_config',
      'list_provider_types',
      'list_providers',
      'list_models',
      'request_provider_setup',
      'test_provider',
      'enable_provider_capability',
      'set_default_provider',
      'set_default_model',
      'get_default_models',
      // Global prompt + avatar style.
      'get_global_prompt',
      'set_global_prompt',
      'get_avatar_style',
      'set_avatar_style',
      'set_avatar_subject',
      'list_avatar_presets',
      'set_avatar_base_enabled',
      'generate_avatar_base',
      'reset_avatar_base',
      // Agent creation + discovery.
      'create_agent',
      'update_agent',
      'get_agent_details',
      'list_kins',
      // Toolbox composition: discover tools, then build/edit minimal toolboxes
      // so a new Agent gets exactly what it needs (not the broad "all").
      'list_tools',
      'list_toolboxes',
      'create_toolbox',
      'update_toolbox',
      'delete_toolbox',
      // Image generation (empirical avatar-style agreement).
      'generate_image',
      'list_image_models',
      'describe_image_model',
      // Contacts (the user "fiche").
      'create_contact',
      'update_contact',
      'get_contact',
      'set_contact_note',
      'search_contacts',
      // Memory.
      'memorize',
      'recall',
      'list_memories',
      // Secure secret entry.
      'prompt_secret',
      // Channels (Discord/Telegram).
      'list_channels',
      'request_channel_setup',
      'test_channel',
      // Connected accounts (read-only discovery). Connecting is OAuth/UI-driven —
      // Queenie can SEE what's linked and guide the user to the Settings UI, but
      // there is no "connect account" tool.
      'list_email_accounts',
      'list_calendar_accounts',
      'list_address_books',
      // Email triggers — connecting an account is UI-only, but automating
      // reactions to incoming mail IS tool-driven, so Queenie can set these up.
      'describe_trigger_conditions',
      'list_email_folders',
      'create_account_trigger',
      'list_account_triggers',
      'update_account_trigger',
      'delete_account_trigger',
      // Search + web (to find provider key pages).
      'list_search_providers',
      'web_search',
      'browse_url',
      'extract_links',
      // Platform / system administration.
      'get_system_info',
      // Read-only "doctor 2.0" diagnostic — CALL FIRST on any rescue: capability
      // coverage, invalid providers (with lastError), stale defaults, channel
      // status, public-URL sanity + a prioritized fix list.
      'get_setup_health',
      'get_platform_config',
      'list_platform_config_options',
      'update_platform_config',
      'get_platform_logs',
      'restart_platform',
    ],
  },
]

const BUILTIN_NAMES = new Set<string>(BUILTIN_TOOLBOXES.map((b) => b.name))

// ─── Row mapping ────────────────────────────────────────────────────────────────

function parseToolNames(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // fallthrough
  }
  return []
}

function rowToToolbox(row: typeof toolboxes.$inferSelect): Toolbox {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    toolNames: parseToolNames(row.toolNames),
    builtin: row.builtin,
    createdAt: row.createdAt.getTime?.() ?? (row.createdAt as unknown as number),
    updatedAt: row.updatedAt.getTime?.() ?? (row.updatedAt as unknown as number),
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function listToolboxes(): Toolbox[] {
  const rows = db.select().from(toolboxes).all()
  return rows.map(rowToToolbox)
}

export function getToolbox(id: string): Toolbox | null {
  const row = db.select().from(toolboxes).where(eq(toolboxes.id, id)).get()
  return row ? rowToToolbox(row) : null
}

export function getToolboxByName(name: string): Toolbox | null {
  const row = db.select().from(toolboxes).where(eq(toolboxes.name, name)).get()
  return row ? rowToToolbox(row) : null
}

/**
 * Resolve an array of toolbox **names** (as accepted by the spawn/cron tools)
 * into toolbox **ids**. Unknown names are skipped. Returns `undefined` when
 * nothing resolves, so the caller falls back to its own default.
 */
export function resolveToolboxNamesToIds(names: string[] | undefined): string[] | undefined {
  if (!names || names.length === 0) return undefined
  const ids: string[] = []
  for (const name of names) {
    const box = getToolboxByName(name.trim())
    if (box) ids.push(box.id)
  }
  return ids.length > 0 ? ids : undefined
}

export function createToolbox(input: {
  name: string
  description?: string | null
  toolNames: string[]
}): Toolbox {
  const name = input.name.trim()
  if (!name) throw new Error('TOOLBOX_NAME_REQUIRED')
  if (getToolboxByName(name)) throw new Error('TOOLBOX_NAME_TAKEN')

  const now = new Date()
  const id = uuid()
  db.insert(toolboxes)
    .values({
      id,
      name,
      description: input.description ?? null,
      toolNames: JSON.stringify(input.toolNames ?? []),
      builtin: false,
      createdAt: now,
      updatedAt: now,
    })
    .run()

  const created = getToolbox(id)
  if (!created) throw new Error('Toolbox creation failed: not found after insert')
  sseManager.broadcast({ type: 'toolbox:created', data: created as unknown as Record<string, unknown> })
  return created
}

export function updateToolbox(
  id: string,
  input: { name?: string; description?: string | null; toolNames?: string[] },
): Toolbox {
  const existing = getToolbox(id)
  if (!existing) throw new Error('TOOLBOX_NOT_FOUND')
  if (existing.builtin) throw new Error('TOOLBOX_BUILTIN_READONLY')

  const patch: Partial<typeof toolboxes.$inferInsert> = { updatedAt: new Date() }

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) throw new Error('TOOLBOX_NAME_REQUIRED')
    const clash = getToolboxByName(name)
    if (clash && clash.id !== id) throw new Error('TOOLBOX_NAME_TAKEN')
    patch.name = name
  }
  if (input.description !== undefined) patch.description = input.description
  if (input.toolNames !== undefined) patch.toolNames = JSON.stringify(input.toolNames)

  db.update(toolboxes).set(patch).where(eq(toolboxes.id, id)).run()

  const updated = getToolbox(id)
  if (!updated) throw new Error('TOOLBOX_NOT_FOUND')
  sseManager.broadcast({ type: 'toolbox:updated', data: updated as unknown as Record<string, unknown> })
  return updated
}

export function deleteToolbox(id: string): void {
  const existing = getToolbox(id)
  if (!existing) throw new Error('TOOLBOX_NOT_FOUND')
  if (existing.builtin) throw new Error('TOOLBOX_BUILTIN_READONLY')
  db.delete(toolboxes).where(eq(toolboxes.id, id)).run()
  sseManager.broadcast({ type: 'toolbox:deleted', data: { toolboxId: id } })
}

// ─── Resolution ─────────────────────────────────────────────────────────────────

/**
 * Resolve an array of toolbox ids into the union of their listed tool names.
 *
 * A toolbox may list any grantable tool name across all four sources: native,
 * plugin (`plugin_*`), MCP (`mcp_*`), and custom (`custom_*`). Those explicit
 * names are returned verbatim — the unified resolver intersects them with the
 * Agent/task universe, so a name absent from the universe is silently dropped
 * there.
 *
 * The single special value "*" expands to every registered NATIVE tool name
 * plus every ENABLED custom tool (`custom_<slug>`) — it is the 'all' built-in.
 * Plugin tools live in the same registry but are explicitly excluded from the
 * "*" expansion by their `plugin_` prefix; MCP tools are excluded too. To grant
 * a plugin or MCP tool a toolbox must list it by name. Custom tools are the
 * user's own first-class extensions, so they ride the wildcard.
 *
 * CORE_TOOLS is NOT added here — callers layer the floor on top (see
 * tool-presets / the unified resolver). Unknown ids are silently skipped.
 */
export function resolveToolboxNames(ids: string[]): string[] {
  if (!ids || ids.length === 0) return []

  const result = new Set<string>()
  let wildcard = false

  for (const id of ids) {
    const box = getToolbox(id)
    if (!box) continue
    for (const name of box.toolNames) {
      if (name === '*') {
        wildcard = true
      } else {
        result.add(name)
      }
    }
  }

  if (wildcard) {
    // "*" = native + custom. Plugin tools share the registry but are namespaced
    // with a `plugin_` prefix, so we exclude them from the wildcard expansion;
    // MCP tools must also be listed by name. Custom tools are the user's own
    // first-class extensions, so they ride the wildcard (enabled-only — disabled
    // ones are dead names in the allow-list and the resolver's universe is
    // enabled-only anyway).
    for (const t of toolRegistry.list()) {
      if (!t.name.startsWith('plugin_')) result.add(t.name)
    }
    for (const ct of listCustomTools()) {
      if (ct.enabled) result.add(`custom_${ct.slug}`)
    }
  }

  return Array.from(result)
}

// ─── Seeding ─────────────────────────────────────────────────────────────────────

/**
 * Idempotently upsert the 5 built-in toolboxes (code / research / ops / all /
 * scout). Matched by `name`. Built-in rows are kept in sync with the
 * definitions above (toolNames / description refreshed) and flagged builtin=1.
 * Safe to call on every boot.
 */
export function seedBuiltinToolboxes(): void {
  const now = new Date()
  let inserted = 0
  let updated = 0

  for (const def of BUILTIN_TOOLBOXES) {
    const existing = getToolboxByName(def.name)
    const toolNamesJson = JSON.stringify(def.toolNames)

    if (!existing) {
      db.insert(toolboxes)
        .values({
          id: uuid(),
          name: def.name,
          description: def.description,
          toolNames: toolNamesJson,
          builtin: true,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      inserted++
      continue
    }

    // Keep built-ins in sync with the source of truth; only write when drift
    // is detected so updatedAt stays meaningful.
    const drifted =
      !existing.builtin ||
      existing.description !== def.description ||
      JSON.stringify(existing.toolNames) !== toolNamesJson

    if (drifted) {
      db.update(toolboxes)
        .set({
          description: def.description,
          toolNames: toolNamesJson,
          builtin: true,
          updatedAt: now,
        })
        .where(eq(toolboxes.id, existing.id))
        .run()
      updated++
    }
  }

  log.info({ inserted, updated, total: BUILTIN_TOOLBOXES.length }, 'Built-in toolboxes seeded')
}

/** Whether a name belongs to a built-in toolbox. */
export function isBuiltinToolboxName(name: string): boolean {
  return BUILTIN_NAMES.has(name)
}

/** Re-export the core floor so callers don't reach into tool-presets. */
export { CORE_TOOLS }
