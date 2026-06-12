import { sqliteTable, text, integer, real, blob, primaryKey, uniqueIndex, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { AgentKind } from '@/shared/types'

// ─── Better Auth tables ────────────────────────────────────────────────────────
// These tables are managed by Better Auth. Defined here for Drizzle relations
// and type inference only — never modify them directly.

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

// ─── Custom Hivekeep tables ──────────────────────────────────────────────────────

export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id').primaryKey().references(() => user.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  pseudonym: text('pseudonym').notNull(),
  language: text('language').notNull().default('fr'),
  // Language Agents speak to this user (any AGENT_LANGUAGES code — broader than
  // the UI's SUPPORTED_LANGUAGES). Null = follow `language` (UI language).
  agentLanguage: text('agent_language'),
  role: text('role').notNull().default('member'),
  agentOrder: text('agent_order'), // JSON array of agent IDs, e.g. '["id1","id2","id3"]'
  cronOrder: text('cron_order'), // JSON array of cron IDs, e.g. '["id1","id2","id3"]'
  // Set once the user dismisses the conversational onboarding modal (Queenie).
  // Prevents the modal from auto-reopening; the Agent remains in the list. See queenie.md.
  onboardingModalDismissed: integer('onboarding_modal_dismissed', { mode: 'boolean' }).notNull().default(false),
  // Appearance preferences (DB-backed so they sync across devices). Null = unset
  // (the client falls back to its localStorage cache / defaults). `theme` is the
  // next-themes mode ('light' | 'dark' | 'system'); `palette` is a PaletteId;
  // `contrastMode` is 'normal' | 'soft'.
  theme: text('theme'),
  palette: text('palette'),
  contrastMode: text('contrast_mode'),
})

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  /** Stable human-readable identifier (e.g. "openai-codex", "claude-max").
   *  Used in tool calls (spawn_self/spawn_agent) where an Agent would otherwise
   *  have to manipulate the UUID. Auto-generated from `name` at creation,
   *  unique across all providers. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  configEncrypted: text('config_encrypted').notNull(),
  capabilities: text('capabilities').notNull(), // JSON array
  isValid: integer('is_valid', { mode: 'boolean' }).notNull().default(true),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

/**
 * Model registry — the source of truth for per-model metadata (context, modalities,
 * reasoning, pricing), seeded from the bundled models.dev snapshot and editable by
 * the admin. One row per (provider, upstream model id). See `model-metadata.md`.
 *
 * Capability flags are NULLABLE on purpose: `null` = "unknown" (fail-open), which
 * is distinct from an explicit `false`. `overridden_fields` lists the fields the
 * admin has pinned (they survive models.dev re-syncs); `manual` mode freezes the
 * whole row. Wiring is gated behind the `HIVEKEEP_MODEL_REGISTRY` flag.
 */
export const modelRegistry = sqliteTable('model_registry', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  displayName: text('display_name'),
  mappingMode: text('mapping_mode').notNull().default('auto'), // 'auto' | 'manual'
  modelsDevKey: text('models_dev_key'), // e.g. "deepseek/deepseek-v4-flash"
  matchConfidence: text('match_confidence'), // 'exact' | 'normalized' | 'family' | 'none'
  contextWindow: integer('context_window'),
  maxOutput: integer('max_output'),
  supportsToolCall: integer('supports_tool_call', { mode: 'boolean' }), // null = unknown
  supportsImageInput: integer('supports_image_input', { mode: 'boolean' }), // null = unknown
  supportsPdfInput: integer('supports_pdf_input', { mode: 'boolean' }), // null = unknown
  reasoning: text('reasoning'), // JSON: { enabled: boolean, efforts: string[] }
  pricing: text('pricing'), // JSON: { input, output, cacheRead?, cacheWrite? }
  overriddenFields: text('overridden_fields'), // JSON string[] of admin-pinned field names
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false), // auto-pick low confidence → "à vérifier"
  stale: integer('stale', { mode: 'boolean' }).notNull().default(false), // id no longer returned by the provider API
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_model_registry_provider_model').on(table.providerId, table.modelId),
  index('idx_model_registry_provider').on(table.providerId),
])

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  slug: text('slug').unique(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  avatarPath: text('avatar_path'),
  character: text('character').notNull(),
  expertise: text('expertise').notNull(),
  /** Agent kind. 'regular' for user-created Agents; 'configurator' for the seeded
   *  onboarding guide (Queenie) — drives the [Configurator mission]/[knowledge]
   *  prompt blocks, the `configurator` toolbox, and exclusion from the
   *  "first real Agent" onboarding counts. See queenie.md. */
  kind: text('kind').$type<AgentKind>().notNull().default('regular'),
  model: text('model').notNull(),
  providerId: text('provider_id').references(() => providers.id, { onDelete: 'set null' }),
  /** Optional cheap "scout" model used when this Agent (or a sub-task it owns)
   *  delegates read-only exploration via the `scout` tool. Resolved by
   *  resolveScoutModel() with a fallback chain that ultimately lands on the
   *  Agent's own main `model` when null. Coupled with `scoutProviderId` (one
   *  being set without the other is treated as "no scout override"). */
  scoutModel: text('scout_model'),
  scoutProviderId: text('scout_provider_id').references(() => providers.id, { onDelete: 'set null' }),
  /** Optional reasoning config for this Agent's scouts (JSON:
   *  AgentThinkingConfig). One step in resolveScoutThinking()'s chain:
   *  per-call override → project scout thinking → THIS → global default →
   *  the calling Agent's own general thinking config. Null = unset tier. */
  scoutThinkingConfig: text('scout_thinking_config'),
  workspacePath: text('workspace_path').notNull(),
  toolboxIds: text('toolbox_ids'), // JSON string[] of toolbox ids; null/empty → 'all' built-in at resolution
  /** JSON string[] of individual tool names granted on top of toolboxes
   *  (manual grants + approved request_tool_access requests). */
  extraToolNames: text('extra_tool_names'),
  compactingConfig: text('compacting_config'), // JSON: AgentCompactingConfig
  thinkingConfig: text('thinking_config'), // JSON: AgentThinkingConfig
  activeProjectId: text('active_project_id').references((): AnySQLiteColumn => projects.id, { onDelete: 'set null' }),
  createdBy: text('created_by').references(() => user.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  command: text('command').notNull(),
  args: text('args'), // JSON array
  env: text('env'), // JSON object
  status: text('status').notNull().default('active'), // 'active' | 'pending_approval'
  createdByAgentId: text('created_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const agentMcpServers = sqliteTable('agent_mcp_servers', {
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  mcpServerId: text('mcp_server_id').notNull().references(() => mcpServers.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.mcpServerId] }),
])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  taskId: text('task_id').references(() => tasks.id),
  sessionId: text('session_id').references(() => quickSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system' | 'tool'
  content: text('content'),
  sourceType: text('source_type').notNull(), // 'user' | 'agent' | 'task' | 'cron' | 'system'
  sourceId: text('source_id'),
  toolCalls: text('tool_calls'), // JSON array
  toolCallId: text('tool_call_id'),
  requestId: text('request_id'),
  inReplyTo: text('in_reply_to'),
  channelOriginId: text('channel_origin_id'),
  isRedacted: integer('is_redacted', { mode: 'boolean' }).notNull().default(false),
  redactPending: integer('redact_pending', { mode: 'boolean' }).notNull().default(false),
  reasoning: text('reasoning'), // LLM thinking/reasoning (ephemeral for LLM, persisted for display)
  metadata: text('metadata'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_messages_agent_id').on(table.agentId),
  index('idx_messages_task_id').on(table.taskId),
  index('idx_messages_agent_created').on(table.agentId, table.createdAt),
  index('idx_messages_source').on(table.sourceType, table.sourceId),
  index('idx_messages_session_id').on(table.sessionId),
])

export const compactingSnapshots = sqliteTable('compacting_snapshots', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  summary: text('summary').notNull(),
  messagesUpToId: text('messages_up_to_id').notNull().references(() => messages.id),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_compacting_agent_active').on(table.agentId, table.isActive),
])

export const compactingSummaries = sqliteTable('compacting_summaries', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  summary: text('summary').notNull(),
  firstMessageAt: integer('first_message_at', { mode: 'timestamp_ms' }).notNull(),
  lastMessageAt: integer('last_message_at', { mode: 'timestamp_ms' }).notNull(),
  firstMessageId: text('first_message_id').references(() => messages.id),
  lastMessageId: text('last_message_id').notNull().references(() => messages.id),
  messageCount: integer('message_count').notNull().default(0),
  tokenEstimate: integer('token_estimate').notNull().default(0),
  isInContext: integer('is_in_context', { mode: 'boolean' }).notNull().default(true),
  depth: integer('depth').notNull().default(0),
  sourceSummaryIds: text('source_summary_ids'), // JSON array of merged summary IDs (null for depth 0)
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_compacting_summaries_agent').on(table.agentId, table.isInContext),
])

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  content: text('content').notNull(),
  embedding: blob('embedding'),
  category: text('category').notNull(), // 'fact' | 'preference' | 'decision' | 'knowledge'
  subject: text('subject'),
  sourceMessageId: text('source_message_id').references(() => messages.id),
  sourceChannel: text('source_channel').notNull().default('automatic'), // 'automatic' | 'explicit'
  sourceContext: text('source_context'), // Brief conversational context around the extracted memory
  importance: real('importance'), // 1-10 scale, null = unscored (treated as 5)
  retrievalCount: integer('retrieval_count').notNull().default(0), // How many times this memory has been retrieved
  lastRetrievedAt: integer('last_retrieved_at', { mode: 'timestamp_ms' }), // When it was last retrieved
  consolidationGeneration: integer('consolidation_generation').notNull().default(0), // 0 = original, 1+ = consolidated
  consolidatedFromIds: text('consolidated_from_ids'), // JSON array of source memory IDs (null for originals)
  scope: text('scope').notNull().default('private'), // 'private' | 'shared'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_memories_agent_id').on(table.agentId),
  index('idx_memories_agent_category').on(table.agentId, table.category),
  index('idx_memories_agent_subject').on(table.agentId, table.subject),
  index('idx_memories_scope').on(table.scope),
  index('idx_memories_scope_category').on(table.scope, table.category),
])

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  linkedUserId: text('linked_user_id').references(() => user.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const contactNicknames = sqliteTable('contact_nicknames', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  nickname: text('nickname').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_contact_nicknames_contact').on(table.contactId),
])

export const contactIdentifiers = sqliteTable('contact_identifiers', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  label: text('label').notNull(), // e.g. "email", "phone pro", "WhatsApp", "Discord"...
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_contact_identifiers_contact_id').on(table.contactId),
])

export const contactPlatformIds = sqliteTable('contact_platform_ids', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'telegram', 'discord', etc.
  platformId: text('platform_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_contact_platform_ids_unique').on(table.platform, table.platformId),
  index('idx_contact_platform_ids_contact').on(table.contactId),
])

export const contactNotes = sqliteTable('contact_notes', {
  id: text('id').primaryKey(),
  contactId: text('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').references(() => agents.id),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(), // 'private' | 'global' | 'user'
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_contact_notes_unique').on(table.contactId, table.agentId, table.userId, table.scope),
  index('idx_contact_notes_contact_id').on(table.contactId),
  index('idx_contact_notes_agent_id').on(table.agentId),
  index('idx_contact_notes_user_id').on(table.userId),
])

// Custom tools are now GLOBAL (platform-wide), not per-Agent. Access is scoped by
// toolboxes (a toolbox lists `custom_<slug>` by name), exactly like MCP tools.
// The executable script + its deps live on disk under
// `config.customTools.baseDir/<slug>/`; this table holds metadata only.
export const customTools = sqliteTable('custom_tools', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull(),                  // → tool name `custom_<slug>`, immutable
  name: text('name').notNull(),
  description: text('description').notNull(),
  parameters: text('parameters').notNull(),      // JSON Schema string
  entrypoint: text('entrypoint').notNull(),      // relative path inside the tool dir
  // UI-ONLY localized overrides for name/description/param labels, keyed by
  // locale. Never injected into the LLM tool definition (the base description +
  // raw JSON-Schema parameters stay verbatim). See resolveCustomToolDisplay().
  // Shape: { "<locale>": { name?, description?, parameters?: { "<param>": { label?, description? } } } }
  translations: text('translations'),
  language: text('language'),                    // explicit interpreter override (optional)
  domainSlug: text('domain_slug')
    .notNull()
    .default('custom')
    .references(() => toolDomains.slug),
  timeoutMs: integer('timeout_ms'),              // per-tool timeout override (optional)
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdBy: text('created_by').notNull().default('user'), // 'user' | 'agent'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_custom_tools_slug').on(table.slug),
])

export const quickSessions = sqliteTable('quick_sessions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title'),
  status: text('status').notNull().default('active'), // 'active' | 'closed'
  /** Per-session LLM override (null = inherit the agent's model) — lets the
   *  user try another model in an ephemeral session without touching the
   *  agent's configuration (the whole point of quick sessions). */
  model: text('model'),
  providerId: text('provider_id').references(() => providers.id, { onDelete: 'set null' }),
  /** Per-session thinking override (null = inherit the agent's config). */
  thinkingEnabled: integer('thinking_enabled', { mode: 'boolean' }),
  thinkingEffort: text('thinking_effort'), // 'low' | 'medium' | 'high' | 'max'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('idx_quick_sessions_agent_status').on(table.agentId, table.status),
  index('idx_quick_sessions_user').on(table.createdBy),
])

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  parentAgentId: text('parent_agent_id').notNull().references(() => agents.id),
  sourceAgentId: text('source_agent_id').references(() => agents.id),
  spawnType: text('spawn_type').notNull(), // 'self' | 'other'
  /** Specialized variant of a task. 'execute' (default) is the regular sub-Agent
   *  run; 'enrich' is a ticket-enrichment task that rewrites title/description/tags
   *  rather than executing the ticket. Always paired with a non-null ticketId. */
  kind: text('kind').notNull().default('execute'), // 'execute' | 'enrich'
  mode: text('mode').notNull().default('await'), // 'await' | 'async'
  model: text('model'),
  providerId: text('provider_id'),
  title: text('title'),
  description: text('description').notNull(),
  status: text('status').notNull().default('pending'), // 'queued' | 'pending' | 'in_progress' | 'paused' | 'awaiting_human_input' | 'awaiting_agent_response' | 'awaiting_subtask' | 'completed' | 'failed' | 'cancelled'
  result: text('result'),
  error: text('error'),
  depth: integer('depth').notNull().default(1),
  parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id),
  cronId: text('cron_id').references(() => crons.id),
  requestInputCount: integer('request_input_count').notNull().default(0),
  interAgentRequestCount: integer('inter_agent_request_count').notNull().default(0),
  pendingRequestId: text('pending_request_id'),
  /** When a TASK (sub-Agent) parent spawns an `await` child and suspends itself
   *  into status 'awaiting_subtask', this holds the child task's id. On the
   *  child's resolveTask() the runtime finds the waiting parent via this column,
   *  injects the child's result, clears it, and re-enters executeSubAgent. Mirrors
   *  `pendingRequestId` for the inter-Agent suspend/resume path. Null otherwise. */
  pendingChildTaskId: text('pending_child_task_id'),
  channelOriginId: text('channel_origin_id'),
  webhookId: text('webhook_id').references(() => webhooks.id, { onDelete: 'set null' }),
  ticketId: text('ticket_id').references((): AnySQLiteColumn => tickets.id, { onDelete: 'set null' }),
  /** Frozen JSON snapshot of `TicketAssignmentInfo` captured at spawn time.
   *  Used to keep the sub-Agent's system prompt stable for the lifetime of the
   *  task — external changes to the ticket (new comments, status flips, tag
   *  edits) won't invalidate the Anthropic prompt cache mid-execution. Null
   *  for non-ticket tasks and for legacy ticket tasks spawned before this
   *  column existed (those fall back to a live fetch). */
  ticketAssignmentSnapshot: text('ticket_assignment_snapshot'),
  /** Frozen JSON snapshot of the rest of the prompt context captured at spawn
   *  time: Agent identity (name/slug/role/character/expertise/workspacePath +
   *  model/provider/thinkingConfig), global platform prompt, Agent
   *  directory, and cron context (previous runs + accumulated learnings) when
   *  the task is cron-bound. Together with `ticketAssignmentSnapshot` this
   *  freezes the entire stable system prefix for the task's lifetime, so the
   *  Anthropic prompt cache survives all re-entries (request_input replies,
   *  sub-sub-task completions, human-prompt answers, nudges, parent replies).
   *  The shape is `TaskPromptContextSnapshot` in services/tasks.ts. Null on
   *  legacy tasks → callers fall back to live DB reads. */
  promptContextSnapshot: text('prompt_context_snapshot'),
  allowHumanPrompt: integer('allow_human_prompt', { mode: 'boolean' }).notNull().default(true),
  thinkingConfig: text('thinking_config'), // JSON: AgentThinkingConfig — overrides parent Agent if set
  /** Legacy sub-Agent tool preset alias. Superseded by `toolboxIds`; kept only
   *  for back-compat — when set and `toolboxIds` is null, the preset name maps
   *  to the built-in toolbox of the same name (see resolveTaskToolboxIds). */
  toolPreset: text('tool_preset'), // 'code' | 'research' | 'ops' | 'all' | null
  /** Optional array of toolbox ids (JSON string[]) defining the task's native
   *  toolset. The resolved native allow-list is CORE_TOOLS unioned with every
   *  referenced toolbox's tool_names ("*" expands to all native tools). Null
   *  falls back to the built-in toolbox matching the legacy `toolPreset`
   *  (or 'code' for tickets / 'all' otherwise) to preserve old behaviour. */
  toolboxIds: text('toolbox_ids'), // JSON string[] of toolbox ids
  /** Optional run-specific instructions provided at task spawn (ticket tasks).
   *  Injected as a dedicated block in the sub-Agent's brief so the agent can be
   *  scoped to a slice of the ticket (e.g. "focus only on backend",
   *  "stop after the DB migration phase"). Soft-limit 500 chars at the API
   *  surface. Null on tasks spawned without a sur-prompt. */
  runPrompt: text('run_prompt'),
  concurrencyGroup: text('concurrency_group'),
  concurrencyMax: integer('concurrency_max'),
  /** Provider-reported peak input tokens from the most recent LLM turn of
   *  this task (max over all stepResults of that turn). Source of truth for
   *  the "real" context bar on the task panel, vs the local BPE estimate
   *  that buildTaskContextPreview produces. Null until the first turn lands. */
  lastApiContextTokens: integer('last_api_context_tokens'),
  queuedAt: integer('queued_at', { mode: 'timestamp_ms' }),
  /** When the task first transitioned to 'in_progress' (actual execution start,
   *  distinct from createdAt which is the spawn/queue time). Set once via
   *  COALESCE so re-entries (resume, request_input replies) never reset it.
   *  Null while queued/pending. Source of truth for the live + persisted run
   *  duration shown in the UI. */
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  /** When the task reached a terminal status (completed/failed/cancelled).
   *  Together with startedAt this freezes the final run duration. Null while
   *  the task is still active. */
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_tasks_parent_agent').on(table.parentAgentId),
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_cron').on(table.cronId),
  index('idx_tasks_concurrency').on(table.concurrencyGroup, table.status, table.queuedAt),
  index('idx_tasks_webhook').on(table.webhookId),
  index('idx_tasks_ticket').on(table.ticketId),
])

export const crons = sqliteTable('crons', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  taskDescription: text('task_description').notNull(),
  targetAgentId: text('target_agent_id').references(() => agents.id),
  model: text('model'),
  providerId: text('provider_id'),
  thinkingConfig: text('thinking_config'), // JSON: AgentThinkingConfig — overrides parent Agent if set
  // JSON string[] of toolbox ids defining the native toolset of tasks spawned by
  // this cron (frozen onto the task row at spawn). Null → spawn default, which
  // is 'all' for crons (the full native surface).
  toolboxIds: text('toolbox_ids'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull().default(false),
  runOnce: integer('run_once', { mode: 'boolean' }).notNull().default(false),
  // When true, each execution's final report wakes the parent Agent for an LLM turn
  // (spawnTask mode 'await'). Default false preserves silent 'async' behavior.
  triggerParentTurn: integer('trigger_parent_turn', { mode: 'boolean' }).notNull().default(false),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp_ms' }),
  createdBy: text('created_by'), // 'user' | 'agent'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

// Email sends queued for human approval (only when the account's send_mode is
// 'approval'). The user approves → the email is actually sent; rejects → dropped.
export const pendingEmailSends = sqliteTable('pending_email_sends', {
  id: text('id').primaryKey(),
  /** The email account (a `providers` row) the message would be sent from. */
  accountId: text('account_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  /** The Agent that requested the send (already allow-list-checked at request time). */
  agentId: text('agent_id').notNull().references(() => agents.id),
  /** The task that requested it, if any. No FK — tasks are ephemeral. */
  taskId: text('task_id'),
  /** JSON SendEmailParams (to/cc/bcc/subject/body/html/replyToMessageId). */
  payload: text('payload').notNull(),
  /** Short "to · subject" used in lists and the notification body. */
  summary: text('summary'),
  status: text('status').notNull().default('pending'), // 'pending' | 'sent' | 'rejected' | 'failed'
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
})

export const cronLearnings = sqliteTable('cron_learnings', {
  id: text('id').primaryKey(),
  cronId: text('cron_id').notNull().references(() => crons.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  category: text('category'), // 'error_recovery' | 'optimization' | 'environment' | 'general'
  taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_cron_learnings_cron').on(table.cronId),
])

export const webhooks = sqliteTable('webhooks', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  name: text('name').notNull(),
  token: text('token').notNull().unique(),
  description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp_ms' }),
  triggerCount: integer('trigger_count').notNull().default(0),
  filterMode: text('filter_mode'), // null | 'simple' | 'advanced'
  filterField: text('filter_field'), // dot-notation path (simple mode)
  filterAllowedValues: text('filter_allowed_values'), // JSON array of strings (simple mode)
  filterExpression: text('filter_expression'), // regex pattern (advanced mode)
  dispatchMode: text('dispatch_mode').notNull().default('conversation'), // 'conversation' | 'task'
  taskTitleTemplate: text('task_title_template'), // Template for task title (task mode)
  taskPromptTemplate: text('task_prompt_template'), // Template for task description (task mode)
  maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(1), // 0 = unlimited
  createdBy: text('created_by'), // 'user' | 'agent'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_webhooks_agent_id').on(table.agentId),
])

export const webhookLogs = sqliteTable('webhook_logs', {
  id: text('id').primaryKey(),
  webhookId: text('webhook_id').notNull().references(() => webhooks.id, { onDelete: 'cascade' }),
  payload: text('payload'),
  sourceIp: text('source_ip'),
  filtered: integer('filtered', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_webhook_logs_webhook_created').on(table.webhookId, table.createdAt),
])

// ─── Account triggers ──────────────────────────────────────────────────────────
// Per connected-account automation: when a new email matches the condition tree,
// inject into the target Agent's conversation or spawn a task. Polled (no push).

export const accountTriggers = sqliteTable('account_triggers', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  folder: text('folder').notNull().default('INBOX'),
  conditions: text('conditions').notNull(), // JSON ConditionNode tree
  prompt: text('prompt').notNull(),
  targetAgentId: text('target_agent_id').notNull().references(() => agents.id),
  dispatchMode: text('dispatch_mode').notNull().default('conversation'), // 'conversation' | 'task'
  maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(1), // 0 = unlimited
  needsBody: integer('needs_body', { mode: 'boolean' }).notNull().default(false), // tree references body/attachment_*
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp_ms' }),
  triggerCount: integer('trigger_count').notNull().default(0),
  createdBy: text('created_by').notNull().default('user'), // 'user' | 'agent'
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_account_triggers_account').on(table.accountId),
  index('idx_account_triggers_target_agent').on(table.targetAgentId),
])

// Polling cursor + dedup, keyed per (account, folder) since triggers can target
// different folders on the same account (each folder is a distinct message stream).
export const accountSyncState = sqliteTable('account_sync_state', {
  accountId: text('account_id').notNull().references(() => providers.id, { onDelete: 'cascade' }),
  folder: text('folder').notNull(),
  lastSeenDate: integer('last_seen_date').notNull(), // Unix ms watermark
  seenIds: text('seen_ids').notNull().default('[]'), // JSON ring of provider msg ids at the watermark boundary
  lastPolledAt: integer('last_polled_at'), // Unix ms
  lastError: text('last_error'),
}, (table) => [
  primaryKey({ columns: [table.accountId, table.folder] }),
])

export const triggerLogs = sqliteTable('trigger_logs', {
  id: text('id').primaryKey(),
  triggerId: text('trigger_id').notNull().references(() => accountTriggers.id, { onDelete: 'cascade' }),
  summary: text('summary'), // "from · subject"
  matched: integer('matched', { mode: 'boolean' }).notNull(),
  action: text('action'), // 'conversation' | 'task' | null when not matched
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_trigger_logs_trigger_created').on(table.triggerId, table.createdAt),
])

export const vaultSecrets = sqliteTable('vault_secrets', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  encryptedValue: text('encrypted_value').notNull(),
  description: text('description'),
  entryType: text('entry_type').notNull().default('text'), // 'text'|'credential'|'card'|'note'|'identity'|custom slug
  vaultTypeId: text('vault_type_id').references(() => vaultTypes.id, { onDelete: 'set null' }),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
  createdByAgentId: text('created_by_agent_id').references(() => agents.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_vault_secrets_entry_type').on(table.entryType),
])

export const vaultTypes = sqliteTable('vault_types', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  icon: text('icon'), // Lucide icon name
  fields: text('fields').notNull(), // JSON: VaultTypeField[]
  isBuiltIn: integer('is_built_in', { mode: 'boolean' }).notNull().default(false),
  createdByAgentId: text('created_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const vaultAttachments = sqliteTable('vault_attachments', {
  id: text('id').primaryKey(),
  entryId: text('entry_id').notNull().references(() => vaultSecrets.id, { onDelete: 'cascade' }),
  originalName: text('original_name').notNull(),
  storedPath: text('stored_path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_vault_attachments_entry').on(table.entryId),
])

export const queueItems = sqliteTable('queue_items', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  messageType: text('message_type').notNull(), // 'user' | 'agent_request' | 'agent_inform' | 'agent_reply' | 'task_result' | 'task_input'
  content: text('content').notNull(),
  sourceType: text('source_type').notNull(), // 'user' | 'agent' | 'task'
  sourceId: text('source_id'),
  priority: integer('priority').notNull().default(0),
  requestId: text('request_id'),
  inReplyTo: text('in_reply_to'),
  taskId: text('task_id').references(() => tasks.id),
  sessionId: text('session_id'),
  channelOriginId: text('channel_origin_id'),
  status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'done'
  createdMessageId: text('created_message_id'), // tracks whether the user message was already inserted (idempotency on recovery)
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('idx_queue_agent_status_priority').on(table.agentId, table.status, table.priority, table.createdAt),
])

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  messageId: text('message_id').references(() => messages.id),
  uploadedBy: text('uploaded_by').references(() => user.id),
  originalName: text('original_name').notNull(),
  storedPath: text('stored_path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const humanPrompts = sqliteTable('human_prompts', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  taskId: text('task_id').references(() => tasks.id),
  messageId: text('message_id').references(() => messages.id),
  promptType: text('prompt_type').notNull(), // 'confirm' | 'select' | 'multi_select'
  question: text('question').notNull(),
  description: text('description'),
  options: text('options').notNull(), // JSON array of HumanPromptOption[]
  response: text('response'), // JSON — structured response, NULL until answered
  status: text('status').notNull().default('pending'), // 'pending' | 'answered' | 'expired' | 'cancelled'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  respondedAt: integer('responded_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('idx_human_prompts_agent').on(table.agentId),
  index('idx_human_prompts_task').on(table.taskId),
  index('idx_human_prompts_status').on(table.status),
])

// ─── Secret prompts (secure input) ───────────────────────────────────────────
// Pending requests for the user to type a secret (API key, token) into a UI
// popup. The raw value NEVER lands here — on response it goes straight to the
// vault and the side effect (create+test provider, store secret) runs; only a
// non-sensitive reference (providerId / vault key) is recorded. See queenie.md §7.
export const secretPrompts = sqliteTable('secret_prompts', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  taskId: text('task_id').references(() => tasks.id),
  purpose: text('purpose').notNull(), // 'provider' | 'channel' | 'vault'
  spec: text('spec').notNull(), // JSON: { fields:[{key,label,secret,...}], + purpose-specific (type/name/families/config | key) }
  status: text('status').notNull().default('pending'), // 'pending' | 'answered' | 'cancelled' | 'expired'
  resultRef: text('result_ref'), // JSON: { providerId? | channelId? | vaultKeys? } — never a secret value
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  respondedAt: integer('responded_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('idx_secret_prompts_agent').on(table.agentId),
  index('idx_secret_prompts_status').on(table.status),
])

// ─── Channels ────────────────────────────────────────────────────────────────

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform').notNull(), // 'telegram' (+ 'discord' in phase 2)
  platformConfig: text('platform_config').notNull(), // JSON (botTokenVaultKey, allowedChatIds, etc.)
  status: text('status').notNull().default('inactive'), // 'active' | 'inactive' | 'error'
  statusMessage: text('status_message'),
  autoCreateContacts: integer('auto_create_contacts', { mode: 'boolean' }).notNull().default(false),
  messagesReceived: integer('messages_received').notNull().default(0),
  messagesSent: integer('messages_sent').notNull().default(0),
  lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }),
  createdBy: text('created_by').notNull().default('user'), // 'user' | 'agent'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_channels_agent_id').on(table.agentId),
])

export const channelUserMappings = sqliteTable('channel_user_mappings', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  platformUserId: text('platform_user_id').notNull(),
  platformUsername: text('platform_username'),
  platformDisplayName: text('platform_display_name'),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('approved'), // 'pending' | 'approved' | 'blocked'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_channel_user_map').on(table.channelId, table.platformUserId),
  index('idx_channel_user_map_status').on(table.channelId, table.status),
])

export const channelMessageLinks = sqliteTable('channel_message_links', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  // Nullable: proactive sends (send_channel_message / send_to_contact) leave an
  // audit link with no originating assistant `messages` row. Auto-delivered Agent
  // replies still set this to the assistant message id.
  messageId: text('message_id').references(() => messages.id, { onDelete: 'cascade' }),
  platformMessageId: text('platform_message_id').notNull(),
  platformChatId: text('platform_chat_id').notNull(),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  // Agent that actually authored/sent the message. Distinct from the channel's
  // owner (channels.agentId) when an Agent borrows another Agent's channel (cross-Agent
  // send). Null for legacy rows and inbound links. FK set null on Agent delete so
  // the audit row survives.
  sentByAgentId: text('sent_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_cml_message').on(table.messageId),
  index('idx_cml_channel').on(table.channelId),
])

// ─── Invitations ────────────────────────────────────────────────────────────

export const invitations = sqliteTable('invitations', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  label: text('label'),
  createdBy: text('created_by').notNull().references(() => user.id),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  usedBy: text('used_by').references(() => user.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_invitations_created_by').on(table.createdBy),
])

// ─── Notifications ──────────────────────────────────────────────────────────

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // NotificationType
  title: text('title').notNull(),
  body: text('body'),
  agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
  relatedId: text('related_id'),
  relatedType: text('related_type'), // 'prompt' | 'channel' | 'cron' | 'mcp' | 'agent'
  isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_notifications_user_read').on(table.userId, table.isRead, table.createdAt),
  index('idx_notifications_user_created').on(table.userId, table.createdAt),
])

export const notificationPreferences = sqliteTable('notification_preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // NotificationType
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, (table) => [
  uniqueIndex('idx_notif_pref_user_type').on(table.userId, table.type),
])

// ─── Notification Channels (external delivery) ──────────────────────────────

export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
  platformChatId: text('platform_chat_id').notNull(),
  label: text('label'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  typeFilter: text('type_filter'), // JSON: NotificationType[] | null (null = all)
  lastDeliveredAt: integer('last_delivered_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  consecutiveErrors: integer('consecutive_errors').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_notif_channels_user').on(table.userId),
  uniqueIndex('idx_notif_channels_unique').on(table.userId, table.channelId, table.platformChatId),
])

// ─── Scheduled Wake-ups ──────────────────────────────────────────────────────

export const scheduledWakeups = sqliteTable('scheduled_wakeups', {
  id: text('id').primaryKey(),
  callerAgentId: text('caller_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  targetAgentId: text('target_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  fireAt: integer('fire_at').notNull(), // Unix ms
  intervalSeconds: integer('interval_seconds'), // null = one-shot, >0 = recurring
  expiresAt: integer('expires_at'), // Unix ms — null = no expiry (for one-shot) or until cancelled
  status: text('status').notNull().default('pending'), // 'pending' | 'fired' | 'cancelled'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_wakeups_target_status').on(table.targetAgentId, table.status),
  index('idx_wakeups_caller').on(table.callerAgentId),
])

// ─── Message Reactions ───────────────────────────────────────────────────────

export const messageReactions = sqliteTable('message_reactions', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_message_reactions_unique').on(table.messageId, table.userId, table.emoji),
  index('idx_message_reactions_message').on(table.messageId),
])

// ─── App Settings ────────────────────────────────────────────────────────────

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(), // Unix ms
})

// ─── Toolboxes ────────────────────────────────────────────────────────────────
// Global, user-defined (and built-in) named sets of native tools. A task
// references an array of toolbox ids; the resolved native toolset is
// CORE_TOOLS unioned with every referenced toolbox's tool_names. The special
// value "*" inside tool_names expands to all registered native tool names.

export const toolboxes = sqliteTable('toolboxes', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  toolNames: text('tool_names'), // JSON string[] of native tool names ("*" = all)
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

// ─── Tool domains ─────────────────────────────────────────────────────────────
// Dynamic, DB-backed categories used to group tools in the UI (icon + color +
// label). The 26 built-in domains are seeded idempotently at boot from
// TOOL_DOMAIN_META (builtin=1, read-only); users/Agents can create custom domains
// to organize their custom tools. `slug` is the stable key referenced by
// custom_tools.domain_slug and by the registry's name→domain map. For builtin
// rows the visual triple is resolved from TOOL_DOMAIN_META and the label from
// `label_key` (i18n); custom rows carry a literal `label` and a `color` token
// from the curated DOMAIN_COLOR_TOKENS set (see shared/constants.ts).

export const toolDomains = sqliteTable('tool_domains', {
  slug: text('slug').primaryKey(),
  label: text('label'),                 // literal label (custom domains)
  labelKey: text('label_key'),          // i18n key (builtin domains)
  icon: text('icon').notNull(),         // Lucide icon name
  color: text('color'),                 // curated color token (custom domains)
  description: text('description'),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

// ─── Mini-Apps ──────────────────────────────────────────────────────────────

export const miniApps = sqliteTable('mini_apps', {
  id: text('id').primaryKey(),
  // Maintainer Agent (reassignable). Any Agent can edit/delete an app; `agentId` is the
  // Agent responsible for it and the target of "improve this app" requests. Exposed
  // as `maintainerAgentId` in the API. On reassignment the on-disk app directory is
  // moved (see setMiniAppMaintainer in services/mini-apps.ts).
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  icon: text('icon'),                        // emoji or Lucide icon name
  iconUrl: text('icon_url'),                  // URL path to generated logo image
  entryFile: text('entry_file').notNull().default('index.html'),
  hasBackend: integer('has_backend', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  version: integer('version').notNull().default(1),     // incremented on each file write (cache busting)
  /** JSON string[] of user-approved capability permissions (subset of the
   *  `permissions` requested in app.json — e.g. "llm", "secrets:MY_KEY"). */
  grantedPermissions: text('granted_permissions'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_mini_apps_agent_slug').on(table.agentId, table.slug),
  index('idx_mini_apps_agent_id').on(table.agentId),
])

// ─── Mini-App Key-Value Storage ──────────────────────────────────────────────

export const miniAppStorage = sqliteTable('mini_app_storage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  appId: text('app_id').notNull().references(() => miniApps.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),      // JSON-encoded
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_mini_app_storage_app_key').on(table.appId, table.key),
  index('idx_mini_app_storage_app_id').on(table.appId),
])

// ─── Mini-App Version Snapshots ──────────────────────────────────────────────

export const miniAppSnapshots = sqliteTable('mini_app_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  appId: text('app_id').notNull().references(() => miniApps.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  label: text('label'),                      // optional human-readable label (e.g. "before major refactor")
  fileManifest: text('file_manifest').notNull(), // JSON: [{path, size, hash}]
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_mini_app_snapshots_app_id').on(table.appId),
  index('idx_mini_app_snapshots_app_version').on(table.appId, table.version),
])

// ─── File Storage ────────────────────────────────────────────────────────────

export const fileStorage = sqliteTable('file_storage', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id),
  name: text('name').notNull(),
  description: text('description'),
  originalName: text('original_name').notNull(),
  storedPath: text('stored_path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  accessToken: text('access_token').notNull().unique(),
  passwordHash: text('password_hash'),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(true),
  readAndBurn: integer('read_and_burn', { mode: 'boolean' }).notNull().default(false),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  downloadCount: integer('download_count').notNull().default(0),
  createdByAgentId: text('created_by_agent_id').references(() => agents.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_file_storage_token').on(table.accessToken),
  index('idx_file_storage_agent').on(table.agentId),
  index('idx_file_storage_expires').on(table.expiresAt),
])

// ─── Knowledge Base ─────────────────────────────────────────────────────────

export const knowledgeSources = sqliteTable('knowledge_sources', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: text('type').notNull(), // 'file' | 'text' | 'url'
  status: text('status').notNull().default('pending'), // 'pending' | 'processing' | 'ready' | 'error'
  errorMessage: text('error_message'),
  originalFilename: text('original_filename'),
  mimeType: text('mime_type'),
  storedPath: text('stored_path'),
  sourceUrl: text('source_url'),
  rawContent: text('raw_content'),
  chunkCount: integer('chunk_count').notNull().default(0),
  tokenCount: integer('token_count').notNull().default(0),
  metadata: text('metadata'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_knowledge_sources_agent_id').on(table.agentId),
])

export const knowledgeChunks = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  embedding: blob('embedding'),
  position: integer('position').notNull(),
  tokenCount: integer('token_count').notNull(),
  metadata: text('metadata'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_knowledge_chunks_agent_id').on(table.agentId),
  index('idx_knowledge_chunks_source_id').on(table.sourceId),
])

// ─── Plugin System ───────────────────────────────────────────────────────────

export const pluginStates = sqliteTable('plugin_states', {
  name: text('name').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  configEncrypted: text('config_encrypted'), // JSON, secrets encrypted
  approvedPermissions: text('approved_permissions'), // JSON array
  installSource: text('install_source'), // 'local' | 'git' | 'npm'
  installMeta: text('install_meta'), // JSON: { url, package, version, ... }
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const pluginStorage = sqliteTable('plugin_storage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  pluginName: text('plugin_name').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(), // JSON-encoded
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_plugin_storage_name_key').on(table.pluginName, table.key),
  index('idx_plugin_storage_plugin').on(table.pluginName),
])

// ─── LLM Usage Tracking ───────────────────────────────────────────────────────

export const llmUsage = sqliteTable('llm_usage', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),

  // Call classification
  callSite: text('call_site').notNull(), // 'chat' | 'quick-session' | 'task' | 'compacting' | 'consolidation' | 'memory-review' | 'embedding' | 'image-gen' | etc.
  callType: text('call_type').notNull(), // 'stream-text' | 'generate-text' | 'embed' | 'generate-image'

  // Dimensions
  providerType: text('provider_type'),   // 'anthropic' | 'openai' | 'gemini' | etc.
  providerId: text('provider_id'),       // Provider UUID (nullable — provider may be deleted)
  modelId: text('model_id'),             // e.g. 'claude-sonnet-4-20250514'
  agentId: text('agent_id'),                 // Nullable for non-agent calls
  taskId: text('task_id'),               // Nullable
  cronId: text('cron_id'),               // Nullable
  sessionId: text('session_id'),         // Quick session ID, nullable

  // Token counts (from LanguageModelUsage)
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  totalTokens: integer('total_tokens'),

  // Input details
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),

  // Output details
  reasoningTokens: integer('reasoning_tokens'),

  // Embedding-specific
  embeddingTokens: integer('embedding_tokens'),

  // Multi-step context (for streamText multi-step loops)
  stepCount: integer('step_count').notNull().default(1),

  // Estimated cost in USD, computed from the model registry pricing at record
  // time (frozen — survives later price changes). Null for rows recorded before
  // the cost feature (backfilled at current price) or models with no pricing.
  costUsd: real('cost_usd'),
}, (table) => [
  index('idx_llm_usage_created').on(table.createdAt),
  index('idx_llm_usage_agent').on(table.agentId, table.createdAt),
  index('idx_llm_usage_provider_type').on(table.providerType, table.createdAt),
  index('idx_llm_usage_model').on(table.modelId, table.createdAt),
  index('idx_llm_usage_task').on(table.taskId),
  index('idx_llm_usage_cron').on(table.cronId),
])

export const agentReadState = sqliteTable('agent_read_state', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  lastReadAt: integer('last_read_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.agentId] }),
  index('idx_agent_read_state_user').on(table.userId),
])

// ─── Projects ─────────────────────────────────────────────────────────────────
// Independent entities shared across all users. Any Agent can select any project
// via agents.active_project_id. See projects.md for the full spec.

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  // Human-readable identifier used to qualify ticket numbers (e.g. hivekeep#42).
  // Nullable in the schema for migration purposes; backfilled at startup and
  // enforced at the application layer (createProject always sets one).
  slug: text('slug').unique(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  githubUrl: text('github_url'),
  // GitHub integration for sub-task worktree isolation. See idea.md.
  // `githubRepo` is the authoritative "owner/name" used by the clone +
  // worktree pipeline; `githubUrl` (above) stays a free-form display link.
  githubPatVaultKey: text('github_pat_vault_key'),
  githubRepo: text('github_repo'),
  defaultBranch: text('default_branch').notNull().default('main'),
  // 'none' | 'cloning' | 'ready' | 'error'. 'none' means no repo configured
  // OR repo configured but clone has not been kicked off yet.
  cloneStatus: text('clone_status').notNull().default('none'),
  cloneError: text('clone_error'),
  clonedAt: integer('cloned_at', { mode: 'timestamp_ms' }),
  /** Optional default model for sub-Agent tasks spawned on tickets of this
   *  project. Frozen into `tasks.model` at spawn time when no explicit task
   *  override is provided. Falls back to the parent Agent's own model. */
  model: text('model'),
  providerId: text('provider_id'),
  /** Optional default scout model for work in a project context (ticket tasks
   *  + active-project sessions). One step in resolveScoutModel()'s chain,
   *  BETWEEN the per-call override and the per-Agent scout (project beats
   *  Agent, like the main-task model chain). Coupled with `scoutProviderId`.
   *  Null falls through to the Agent scout → global default → Agent main
   *  model. */
  scoutModel: text('scout_model'),
  scoutProviderId: text('scout_provider_id'),
  /** Optional reasoning config for scouts dispatched in this project's context
   *  (JSON: AgentThinkingConfig). Beats the per-Agent scout thinking, like the
   *  scout model chain. Null = unset tier. */
  scoutThinkingConfig: text('scout_thinking_config'),
  /** Optional default thinking/reasoning config for sub-Agent tasks spawned on
   *  tickets of this project. JSON: AgentThinkingConfig. Same freeze-at-spawn
   *  pattern as `model`: copied into `tasks.thinking_config` if no explicit
   *  task override is given. Falls back to the parent Agent's own config.
   *  (Scouts use the dedicated `scoutThinkingConfig` instead.) */
  thinkingConfig: text('thinking_config'),
  /** Optional default toolbox selection for sub-Agent tasks spawned on tickets
   *  of this project. JSON: string[] of toolbox ids. Frozen into
   *  `tasks.toolbox_ids` at spawn when no explicit task override is provided.
   *  Null means "inherit the runtime default" ('code' for ticket tasks via
   *  resolveTaskToolboxIds). An explicit toolbox selection passed at spawn
   *  still wins. */
  defaultToolboxIds: text('default_toolbox_ids'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_projects_created').on(table.createdAt),
])

export const projectTags = sqliteTable('project_tags', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  color: text('color').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('uniq_project_tags_label').on(table.projectId, table.label),
  index('idx_project_tags_project').on(table.projectId),
])

export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Per-project monotonic ticket number (GitHub-style #42). Nullable for
  // migration purposes; backfilled at startup and enforced at the application
  // layer (createTicket always assigns one).
  number: integer('number'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('backlog'), // 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
  position: integer('position').notNull().default(0),
  /** Reporter — who created this ticket. Exactly one of reporter_user_id /
   *  reporter_agent_id is set (or both NULL for legacy/seeded rows). */
  reporterUserId: text('reporter_user_id').references(() => user.id, { onDelete: 'set null' }),
  reporterAgentId: text('reporter_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  /** When the ticket last entered the 'in_progress' column. Updated on every
   *  transition into 'in_progress' (and cleared when it leaves). Drives the
   *  "in progress since" duration on the kanban card. Null for tickets that
   *  have never been moved to in_progress. */
  inProgressAt: integer('in_progress_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_tickets_project_status_position').on(table.projectId, table.status, table.position),
  index('idx_tickets_project_updated').on(table.projectId, table.updatedAt),
  uniqueIndex('uniq_tickets_project_number').on(table.projectId, table.number),
])

export const ticketTags = sqliteTable('ticket_tags', {
  ticketId: text('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => projectTags.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.ticketId, table.tagId] }),
  index('idx_ticket_tags_ticket').on(table.ticketId),
  index('idx_ticket_tags_tag').on(table.tagId),
])

export const ticketComments = sqliteTable('ticket_comments', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  authorType: text('author_type').notNull(), // 'user' | 'agent'
  authorUserId: text('author_user_id').references(() => user.id, { onDelete: 'set null' }),
  authorAgentId: text('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  content: text('content').notNull(),
  metadata: text('metadata'), // JSON: { fromTaskId?: string; autoGenerated?: boolean }
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_ticket_comments_ticket_created').on(table.ticketId, table.createdAt),
])

/**
 * Files attached to a ticket. Stored on disk under
 * `${UPLOAD_DIR}/tickets/<projectId>/<ticketId>/<id>.<ext>` and rows here
 * carry the metadata + back-reference. The disk file is removed by the
 * service when the row is deleted; ticket deletion cascades via the FK so
 * the service's cleanup hook runs on `deleteTicket`.
 *
 * Distinct from the `files` table (chat message attachments, channel media)
 * and the `file_storage` table (public share-link storage with access tokens).
 */
export const ticketAttachments = sqliteTable('ticket_attachments', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  originalName: text('original_name').notNull(),
  storedPath: text('stored_path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  description: text('description'),
  uploadedByUserId: text('uploaded_by_user_id').references(() => user.id, { onDelete: 'set null' }),
  uploadedByAgentId: text('uploaded_by_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_ticket_attachments_ticket').on(table.ticketId),
  index('idx_ticket_attachments_ticket_created').on(table.ticketId, table.createdAt),
])

/**
 * Durable, curated knowledge entries scoped to a project. Shared across all
 * Agents acting on the project (main Agent with active_project_id, or sub-Agent of
 * a ticket-bound task). Distinct from `memories` (agent-scoped, decay-aware)
 * and `knowledge_chunks` (agent-scoped, ingested docs).
 *
 * Pinned entries (max 10/project, enforced at the service layer) are injected
 * into the system prompt's Active project / Ticket assignment block. The rest
 * is reachable via the `search_project_knowledge` tool.
 *
 * authorAgentId is nullable: a NULL value means the entry was created by the
 * end-user via the REST API / UI rather than by an Agent tool call.
 */
export const projectKnowledge = sqliteTable('project_knowledge', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** Short human-readable title. Rendered in the system-prompt knowledge
   *  index for every entry (pinned or not). Service layer rejects empty
   *  or whitespace-only titles. */
  title: text('title').notNull().default(''),
  content: text('content').notNull(),
  embedding: blob('embedding'), // nullable — FTS5 still works if embedding fails
  category: text('category'), // free-text (e.g. 'arch', 'decision', 'gotcha', 'convention')
  /** When true, the full markdown content is injected inline in the system
   *  prompt. When false, only the title appears in the index and the Agent
   *  reads the body via get_project_knowledge(id). */
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  authorAgentId: text('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_project_knowledge_project').on(table.projectId),
  index('idx_project_knowledge_project_pinned').on(table.projectId, table.pinned),
])
