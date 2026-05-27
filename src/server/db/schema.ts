import { sqliteTable, text, integer, real, blob, primaryKey, uniqueIndex, index, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

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

// ─── Custom KinBot tables ──────────────────────────────────────────────────────

export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id').primaryKey().references(() => user.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  pseudonym: text('pseudonym').notNull(),
  language: text('language').notNull().default('fr'),
  role: text('role').notNull().default('member'),
  kinOrder: text('kin_order'), // JSON array of kin IDs, e.g. '["id1","id2","id3"]'
  cronOrder: text('cron_order'), // JSON array of cron IDs, e.g. '["id1","id2","id3"]'
})

export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  /** Stable human-readable identifier (e.g. "openai-codex", "claude-max").
   *  Used in tool calls (spawn_self/spawn_kin) where a Kin would otherwise
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

export const kins = sqliteTable('kins', {
  id: text('id').primaryKey(),
  slug: text('slug').unique(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  avatarPath: text('avatar_path'),
  character: text('character').notNull(),
  expertise: text('expertise').notNull(),
  model: text('model').notNull(),
  providerId: text('provider_id').references(() => providers.id, { onDelete: 'set null' }),
  workspacePath: text('workspace_path').notNull(),
  toolConfig: text('tool_config'), // JSON: KinToolConfig
  compactingConfig: text('compacting_config'), // JSON: KinCompactingConfig
  thinkingConfig: text('thinking_config'), // JSON: KinThinkingConfig
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
  createdByKinId: text('created_by_kin_id').references(() => kins.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const kinMcpServers = sqliteTable('kin_mcp_servers', {
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  mcpServerId: text('mcp_server_id').notNull().references(() => mcpServers.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.kinId, table.mcpServerId] }),
])

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
  taskId: text('task_id').references(() => tasks.id),
  sessionId: text('session_id').references(() => quickSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system' | 'tool'
  content: text('content'),
  sourceType: text('source_type').notNull(), // 'user' | 'kin' | 'task' | 'cron' | 'system'
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
  index('idx_messages_kin_id').on(table.kinId),
  index('idx_messages_task_id').on(table.taskId),
  index('idx_messages_kin_created').on(table.kinId, table.createdAt),
  index('idx_messages_source').on(table.sourceType, table.sourceId),
  index('idx_messages_session_id').on(table.sessionId),
])

export const compactingSnapshots = sqliteTable('compacting_snapshots', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
  summary: text('summary').notNull(),
  messagesUpToId: text('messages_up_to_id').notNull().references(() => messages.id),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_compacting_kin_active').on(table.kinId, table.isActive),
])

export const compactingSummaries = sqliteTable('compacting_summaries', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
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
  index('idx_compacting_summaries_kin').on(table.kinId, table.isInContext),
])

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
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
  index('idx_memories_kin_id').on(table.kinId),
  index('idx_memories_kin_category').on(table.kinId, table.category),
  index('idx_memories_kin_subject').on(table.kinId, table.subject),
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
  kinId: text('kin_id').references(() => kins.id),
  userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  scope: text('scope').notNull(), // 'private' | 'global' | 'user'
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_contact_notes_unique').on(table.contactId, table.kinId, table.userId, table.scope),
  index('idx_contact_notes_contact_id').on(table.contactId),
  index('idx_contact_notes_kin_id').on(table.kinId),
  index('idx_contact_notes_user_id').on(table.userId),
])

export const customTools = sqliteTable('custom_tools', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
  name: text('name').notNull(),
  description: text('description').notNull(),
  parameters: text('parameters').notNull(), // JSON Schema
  scriptPath: text('script_path').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_custom_tools_kin_name').on(table.kinId, table.name),
])

export const quickSessions = sqliteTable('quick_sessions', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title'),
  status: text('status').notNull().default('active'), // 'active' | 'closed'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  closedAt: integer('closed_at', { mode: 'timestamp_ms' }),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
}, (table) => [
  index('idx_quick_sessions_kin_status').on(table.kinId, table.status),
  index('idx_quick_sessions_user').on(table.createdBy),
])

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  parentKinId: text('parent_kin_id').notNull().references(() => kins.id),
  sourceKinId: text('source_kin_id').references(() => kins.id),
  spawnType: text('spawn_type').notNull(), // 'self' | 'other'
  /** Specialized variant of a task. 'execute' (default) is the regular sub-Kin
   *  run; 'enrich' is a ticket-enrichment task that rewrites title/description/tags
   *  rather than executing the ticket. Always paired with a non-null ticketId. */
  kind: text('kind').notNull().default('execute'), // 'execute' | 'enrich'
  mode: text('mode').notNull().default('await'), // 'await' | 'async'
  model: text('model'),
  providerId: text('provider_id'),
  title: text('title'),
  description: text('description').notNull(),
  status: text('status').notNull().default('pending'), // 'queued' | 'pending' | 'in_progress' | 'paused' | 'awaiting_human_input' | 'awaiting_kin_response' | 'completed' | 'failed' | 'cancelled'
  result: text('result'),
  error: text('error'),
  depth: integer('depth').notNull().default(1),
  parentTaskId: text('parent_task_id').references((): AnySQLiteColumn => tasks.id),
  cronId: text('cron_id').references(() => crons.id),
  requestInputCount: integer('request_input_count').notNull().default(0),
  interKinRequestCount: integer('inter_kin_request_count').notNull().default(0),
  pendingRequestId: text('pending_request_id'),
  channelOriginId: text('channel_origin_id'),
  webhookId: text('webhook_id').references(() => webhooks.id, { onDelete: 'set null' }),
  ticketId: text('ticket_id').references((): AnySQLiteColumn => tickets.id, { onDelete: 'set null' }),
  /** Frozen JSON snapshot of `TicketAssignmentInfo` captured at spawn time.
   *  Used to keep the sub-Kin's system prompt stable for the lifetime of the
   *  task — external changes to the ticket (new comments, status flips, tag
   *  edits) won't invalidate the Anthropic prompt cache mid-execution. Null
   *  for non-ticket tasks and for legacy ticket tasks spawned before this
   *  column existed (those fall back to a live fetch). */
  ticketAssignmentSnapshot: text('ticket_assignment_snapshot'),
  /** Frozen JSON snapshot of the rest of the prompt context captured at spawn
   *  time: Kin identity (name/slug/role/character/expertise/workspacePath +
   *  model/provider/thinkingConfig/toolConfig), global platform prompt, Kin
   *  directory, and cron context (previous runs + accumulated learnings) when
   *  the task is cron-bound. Together with `ticketAssignmentSnapshot` this
   *  freezes the entire stable system prefix for the task's lifetime, so the
   *  Anthropic prompt cache survives all re-entries (request_input replies,
   *  sub-sub-task completions, human-prompt answers, nudges, parent replies).
   *  The shape is `TaskPromptContextSnapshot` in services/tasks.ts. Null on
   *  legacy tasks → callers fall back to live DB reads. */
  promptContextSnapshot: text('prompt_context_snapshot'),
  allowHumanPrompt: integer('allow_human_prompt', { mode: 'boolean' }).notNull().default(true),
  thinkingConfig: text('thinking_config'), // JSON: KinThinkingConfig — overrides parent Kin if set
  /** Optional sub-Kin tool preset. When set, overrides the auto-picker
   *  (defaultPresetForTask). 'all' explicitly disables filtering. Null
   *  falls back to the auto-picker behaviour (ticket → code, else full). */
  toolPreset: text('tool_preset'), // 'code' | 'research' | 'ops' | 'all' | null
  /** Optional run-specific instructions provided at task spawn (ticket tasks).
   *  Injected as a dedicated block in the sub-Kin's brief so the agent can be
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
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_tasks_parent_kin').on(table.parentKinId),
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_cron').on(table.cronId),
  index('idx_tasks_concurrency').on(table.concurrencyGroup, table.status, table.queuedAt),
  index('idx_tasks_webhook').on(table.webhookId),
  index('idx_tasks_ticket').on(table.ticketId),
])

export const crons = sqliteTable('crons', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
  name: text('name').notNull(),
  schedule: text('schedule').notNull(),
  taskDescription: text('task_description').notNull(),
  targetKinId: text('target_kin_id').references(() => kins.id),
  model: text('model'),
  providerId: text('provider_id'),
  thinkingConfig: text('thinking_config'), // JSON: KinThinkingConfig — overrides parent Kin if set
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  requiresApproval: integer('requires_approval', { mode: 'boolean' }).notNull().default(false),
  runOnce: integer('run_once', { mode: 'boolean' }).notNull().default(false),
  lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp_ms' }),
  createdBy: text('created_by'), // 'user' | 'kin'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
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
  kinId: text('kin_id').notNull().references(() => kins.id),
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
  createdBy: text('created_by'), // 'user' | 'kin'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_webhooks_kin_id').on(table.kinId),
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

export const vaultSecrets = sqliteTable('vault_secrets', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  encryptedValue: text('encrypted_value').notNull(),
  description: text('description'),
  entryType: text('entry_type').notNull().default('text'), // 'text'|'credential'|'card'|'note'|'identity'|custom slug
  vaultTypeId: text('vault_type_id').references(() => vaultTypes.id, { onDelete: 'set null' }),
  isFavorite: integer('is_favorite', { mode: 'boolean' }).notNull().default(false),
  createdByKinId: text('created_by_kin_id').references(() => kins.id),
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
  createdByKinId: text('created_by_kin_id').references(() => kins.id, { onDelete: 'set null' }),
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
  kinId: text('kin_id').notNull().references(() => kins.id),
  messageType: text('message_type').notNull(), // 'user' | 'kin_request' | 'kin_inform' | 'kin_reply' | 'task_result' | 'task_input'
  content: text('content').notNull(),
  sourceType: text('source_type').notNull(), // 'user' | 'kin' | 'task'
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
  index('idx_queue_kin_status_priority').on(table.kinId, table.status, table.priority, table.createdAt),
])

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id),
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
  kinId: text('kin_id').notNull().references(() => kins.id),
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
  index('idx_human_prompts_kin').on(table.kinId),
  index('idx_human_prompts_task').on(table.taskId),
  index('idx_human_prompts_status').on(table.status),
])

// ─── Channels ────────────────────────────────────────────────────────────────

export const channels = sqliteTable('channels', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform').notNull(), // 'telegram' (+ 'discord' in phase 2)
  platformConfig: text('platform_config').notNull(), // JSON (botTokenVaultKey, allowedChatIds, etc.)
  status: text('status').notNull().default('inactive'), // 'active' | 'inactive' | 'error'
  statusMessage: text('status_message'),
  autoCreateContacts: integer('auto_create_contacts', { mode: 'boolean' }).notNull().default(false),
  messagesReceived: integer('messages_received').notNull().default(0),
  messagesSent: integer('messages_sent').notNull().default(0),
  lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }),
  createdBy: text('created_by').notNull().default('user'), // 'user' | 'kin'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_channels_kin_id').on(table.kinId),
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
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  platformMessageId: text('platform_message_id').notNull(),
  platformChatId: text('platform_chat_id').notNull(),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
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
  kinId: text('kin_id').references(() => kins.id, { onDelete: 'set null' }),
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
  kinId: text('kin_id').references(() => kins.id, { onDelete: 'set null' }),
  relatedId: text('related_id'),
  relatedType: text('related_type'), // 'prompt' | 'channel' | 'cron' | 'mcp' | 'kin'
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
  callerKinId: text('caller_kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  targetKinId: text('target_kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  reason: text('reason'),
  fireAt: integer('fire_at').notNull(), // Unix ms
  intervalSeconds: integer('interval_seconds'), // null = one-shot, >0 = recurring
  expiresAt: integer('expires_at'), // Unix ms — null = no expiry (for one-shot) or until cancelled
  status: text('status').notNull().default('pending'), // 'pending' | 'fired' | 'cancelled'
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_wakeups_target_status').on(table.targetKinId, table.status),
  index('idx_wakeups_caller').on(table.callerKinId),
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

// ─── Mini-Apps ──────────────────────────────────────────────────────────────

export const miniApps = sqliteTable('mini_apps', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  icon: text('icon'),                        // emoji or Lucide icon name
  iconUrl: text('icon_url'),                  // URL path to generated logo image
  entryFile: text('entry_file').notNull().default('index.html'),
  hasBackend: integer('has_backend', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  version: integer('version').notNull().default(1),     // incremented on each file write (cache busting)
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  uniqueIndex('idx_mini_apps_kin_slug').on(table.kinId, table.slug),
  index('idx_mini_apps_kin_id').on(table.kinId),
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
  kinId: text('kin_id').notNull().references(() => kins.id),
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
  createdByKinId: text('created_by_kin_id').references(() => kins.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_file_storage_token').on(table.accessToken),
  index('idx_file_storage_kin').on(table.kinId),
  index('idx_file_storage_expires').on(table.expiresAt),
])

// ─── Knowledge Base ─────────────────────────────────────────────────────────

export const knowledgeSources = sqliteTable('knowledge_sources', {
  id: text('id').primaryKey(),
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
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
  index('idx_knowledge_sources_kin_id').on(table.kinId),
])

export const knowledgeChunks = sqliteTable('knowledge_chunks', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => knowledgeSources.id, { onDelete: 'cascade' }),
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  embedding: blob('embedding'),
  position: integer('position').notNull(),
  tokenCount: integer('token_count').notNull(),
  metadata: text('metadata'), // JSON
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_knowledge_chunks_kin_id').on(table.kinId),
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
  kinId: text('kin_id'),                 // Nullable for non-kin calls
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
}, (table) => [
  index('idx_llm_usage_created').on(table.createdAt),
  index('idx_llm_usage_kin').on(table.kinId, table.createdAt),
  index('idx_llm_usage_provider_type').on(table.providerType, table.createdAt),
  index('idx_llm_usage_model').on(table.modelId, table.createdAt),
  index('idx_llm_usage_task').on(table.taskId),
  index('idx_llm_usage_cron').on(table.cronId),
])

export const kinReadState = sqliteTable('kin_read_state', {
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  kinId: text('kin_id').notNull().references(() => kins.id, { onDelete: 'cascade' }),
  lastReadAt: integer('last_read_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.kinId] }),
  index('idx_kin_read_state_user').on(table.userId),
])

// ─── Projects ─────────────────────────────────────────────────────────────────
// Independent entities shared across all users. Any Kin can select any project
// via kins.active_project_id. See projects.md for the full spec.

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  // Human-readable identifier used to qualify ticket numbers (e.g. kinbot#42).
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
  /** Optional default model for sub-Kin tasks spawned on tickets of this
   *  project. Frozen into `tasks.model` at spawn time when no explicit task
   *  override is provided. Falls back to the parent Kin's own model. */
  model: text('model'),
  providerId: text('provider_id'),
  /** Optional default thinking/reasoning config for sub-Kin tasks spawned on
   *  tickets of this project. JSON: KinThinkingConfig. Same freeze-at-spawn
   *  pattern as `model`: copied into `tasks.thinking_config` if no explicit
   *  task override is given. Falls back to the parent Kin's own config. */
  thinkingConfig: text('thinking_config'),
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
   *  reporter_kin_id is set (or both NULL for legacy/seeded rows). */
  reporterUserId: text('reporter_user_id').references(() => user.id, { onDelete: 'set null' }),
  reporterKinId: text('reporter_kin_id').references(() => kins.id, { onDelete: 'set null' }),
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
  authorType: text('author_type').notNull(), // 'user' | 'kin'
  authorUserId: text('author_user_id').references(() => user.id, { onDelete: 'set null' }),
  authorKinId: text('author_kin_id').references(() => kins.id, { onDelete: 'set null' }),
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
  uploadedByKinId: text('uploaded_by_kin_id').references(() => kins.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_ticket_attachments_ticket').on(table.ticketId),
  index('idx_ticket_attachments_ticket_created').on(table.ticketId, table.createdAt),
])

/**
 * Durable, curated knowledge entries scoped to a project. Shared across all
 * Kins acting on the project (main Kin with active_project_id, or sub-Kin of
 * a ticket-bound task). Distinct from `memories` (kin-scoped, decay-aware)
 * and `knowledge_chunks` (kin-scoped, ingested docs).
 *
 * Pinned entries (max 10/project, enforced at the service layer) are injected
 * into the system prompt's Active project / Ticket assignment block. The rest
 * is reachable via the `search_project_knowledge` tool.
 *
 * authorKinId is nullable: a NULL value means the entry was created by the
 * end-user via the REST API / UI rather than by a Kin tool call.
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
   *  prompt. When false, only the title appears in the index and the Kin
   *  reads the body via get_project_knowledge(id). */
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  authorKinId: text('author_kin_id').references(() => kins.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (table) => [
  index('idx_project_knowledge_project').on(table.projectId),
  index('idx_project_knowledge_project_pinned').on(table.projectId, table.pinned),
])
