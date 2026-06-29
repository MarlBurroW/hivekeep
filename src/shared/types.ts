// Shared types used by both client and server

/** A fully-qualified model reference (model + provider pair) */
export interface ModelRef {
  modelId: string
  providerId: string
}

export type UserRole = 'admin' | 'member'

/** UI translation language codes (see SUPPORTED_LANGUAGES in constants.ts). */
export type Language = 'en' | 'fr' | 'es' | 'de' | 'pt-BR' | 'zh-CN' | 'ja' | 'ru' | 'it' | 'pl'

// ─── Notification types ────────────────────────────────────────────────────

export type NotificationType =
  | 'prompt:pending'
  | 'channel:user-pending'
  | 'cron:pending-approval'
  | 'mcp:pending-approval'
  | 'email:pending-send-approval'
  | 'agent:error'
  | 'agent:alert'
  | 'mention'
  | 'miniapp:notify'

export type NotificationRelatedType = 'prompt' | 'channel' | 'cron' | 'mcp' | 'email' | 'agent' | 'message' | 'miniapp'

/** An email send queued for human approval (account in send_mode='approval'). */
export interface PendingEmailSend {
  id: string
  accountId: string
  accountEmail: string
  agentId: string
  agentName: string
  to: string[]
  cc?: string[]
  subject: string
  body: string
  status: 'pending' | 'sent' | 'rejected' | 'failed'
  error: string | null
  createdAt: number
}

export interface NotificationSummary {
  id: string
  type: NotificationType
  title: string
  body: string | null
  agentId: string | null
  agentName: string | null
  agentSlug: string | null
  agentAvatarUrl: string | null
  relatedId: string | null
  relatedType: NotificationRelatedType | null
  isRead: boolean
  createdAt: number
}

/** User's external notification delivery channel */
export interface NotificationChannelSummary {
  id: string
  channelId: string
  channelName: string
  platform: ChannelPlatform
  platformChatId: string
  label: string | null
  isActive: boolean
  typeFilter: NotificationType[] | null
  lastDeliveredAt: number | null
  lastError: string | null
  consecutiveErrors: number
  createdAt: number
}

/** Available channel for notification delivery */
export interface AvailableNotificationChannel {
  channelId: string
  channelName: string
  platform: ChannelPlatform
  agentName: string
}

/** Contact with a platform ID, used for notification channel creation */
export interface ContactForNotification {
  contactId: string
  contactName: string
  platformId: string
}

export type ProviderType = 'anthropic' | 'anthropic-oauth' | 'openai' | 'openai-codex' | 'gemini'

// ProviderCapability lives in the SDK (single source of truth shared
// with plugin authors). The SDK version includes the forward-looking
// 'rerank' family which the host doesn't yet implement but new
// provider plugins might.
export type { ProviderCapability } from '@gezy/sdk'

export type MessageSource = 'user' | 'agent' | 'task' | 'cron' | 'system' | 'webhook' | 'channel'

export type TaskStatus = 'queued' | 'pending' | 'in_progress' | 'paused' | 'awaiting_human_input' | 'awaiting_agent_response' | 'awaiting_subtask' | 'completed' | 'failed' | 'cancelled'

export type TaskMode = 'await' | 'async'

export type TaskTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** Structured plan item maintained by a sub-Agent during a task. */
export interface TaskTodo {
  id: string
  subject: string
  status: TaskTodoStatus
}

export type InterAgentMessageType = 'request' | 'inform' | 'reply'

export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'knowledge'

export type MemoryScope = 'private' | 'shared'

/** Memory summary as returned by memory API endpoints */
export interface MemorySummary {
  id: string
  agentId: string
  content: string
  category: MemoryCategory
  subject: string | null
  scope: MemoryScope
  sourceChannel: 'automatic' | 'explicit'
  sourceContext: string | null
  importance: number | null
  retrievalCount: number
  lastRetrievedAt: number | null
  consolidationGeneration: number
  /** Author Agent name, populated when viewing shared memories from another Agent */
  authorAgentName?: string | null
  createdAt: number
  updatedAt: number
}

export type QueueItemPriority = 'user' | 'agent' | 'task'

export type McpServerStatus = 'active' | 'pending_approval'

export type PaletteId = 'aurora' | 'ocean' | 'forest' | 'sunset' | 'monochrome' | 'sakura' | 'neon' | 'lavender' | 'midnight' | 'copper' | 'jade' | 'crimson' | 'galaxy' | 'amber' | 'slate' | 'rose' | 'mint' | 'citrus'

export interface ApiError {
  error: {
    code: string
    message: string
  }
}

/** A single tool call as stored in messages.tool_calls JSON */
export interface ToolCallEntry {
  id: string
  name: string
  args: unknown
  result?: unknown
  /** Character offset in the message content where this tool call was triggered */
  offset?: number
}

/** A global, named set of native tools assignable to tasks. The resolved
 *  native toolset of a task is CORE_TOOLS unioned with every referenced
 *  toolbox's `toolNames` (the special value "*" expands to all native tools).
 *  Built-in toolboxes (builtin=true) are seeded at startup and cannot be
 *  edited or deleted. */
export interface Toolbox {
  id: string
  name: string
  description: string | null
  /** Explicit allow-list of individual native tool names. The single special
   *  value "*" means "all native tools" (used by the built-in 'all' toolbox). */
  toolNames: string[]
  builtin: boolean
  createdAt: number
  updatedAt: number
}

/** Author-supplied tool display label. Either a single string (same text in
 *  every locale) or a `{ lang: text }` map. Mirrors the SDK `ToolLabel`. */
export type ToolLabel = string | Record<string, string>

/** Where a catalog tool originates. Drives the source grouping/badges in the
 *  toolbox editor and the unified resolver's universe:
 *   - native : built into Hivekeep (toolRegistry, name has no special prefix)
 *   - plugin : contributed by an installed plugin (name `plugin_<plugin>_*`)
 *   - mcp    : exposed by a global MCP server (name `mcp_<server>_<tool>`)
 *   - custom : per-Agent user script (name `custom_<name>`)
 *  "*" inside a toolbox still expands to NATIVE tools only — mcp/custom/plugin
 *  tools must be listed by their stable name. */
export type ToolSource = 'native' | 'plugin' | 'mcp' | 'custom'

/** A single entry of the tool catalog returned by GET /api/tools/catalog.
 *  Carries metadata only (no per-Agent enabled state) so the toolbox editor can
 *  render every grantable tool with its source, domain, label, and a
 *  `hardExcludedFromSubAgent` flag warning the tool can never run in a task.
 *
 *  Native + plugin tools come from the registry. MCP tools come from ALL global
 *  active servers (no per-Agent gate). Custom tools are GLOBAL too (no per-Agent
 *  gate) — each carries its own (possibly custom) domain via `domain`. */
export interface ToolCatalogEntry {
  name: string
  /** Provenance of the tool. */
  source: ToolSource
  domain: ToolDomain
  label: ToolLabel | null
  description: string | null
  defaultDisabled: boolean
  readOnly: boolean
  destructive: boolean
  /** True when the tool is in HARD_EXCLUDED_FROM_SUBKIN — it cannot run inside a
   *  task even if a toolbox lists it. The UI surfaces a soft warning. */
  hardExcludedFromSubAgent: boolean
  /** MCP only: the display name of the originating server. */
  mcpServerName?: string
  /** Custom only: whether the tool is currently enabled (disabled tools are
   *  listed in the catalog but never resolved into a toolset). */
  enabled?: boolean
  /** @deprecated Per-Agent custom tools are gone; kept optional for back-compat. */
  customAgentId?: string
  /** @deprecated Per-Agent custom tools are gone; kept optional for back-compat. */
  customAgentName?: string
}

/** UI-ONLY localized overrides for a custom tool, keyed by locale. NEVER sent to
 *  the LLM — the base `name`/`description` + raw JSON-Schema `parameters` stay
 *  verbatim in the tool definition. Each locale may override the display name,
 *  the display description, and per-parameter label/description (matched by the
 *  JSON-Schema property key). */
export type CustomToolTranslations = Record<
  string,
  {
    name?: string
    description?: string
    parameters?: Record<string, { label?: string; description?: string }>
  }
>

/** A global custom tool (DB-backed metadata; the executable + deps live on disk
 *  under config.customTools.baseDir/<slug>/). Exposed to Agents as `custom_<slug>`
 *  and granted via toolboxes. */
export interface CustomTool {
  id: string
  slug: string
  name: string
  description: string
  parameters: string // JSON Schema string
  entrypoint: string
  language: string | null
  domainSlug: string
  timeoutMs: number | null
  enabled: boolean
  createdBy: string // 'user' | 'agent'
  /** UI-only localized overrides. Null/absent when none defined. */
  translations: CustomToolTranslations | null
}

/** A tool domain row (DB-backed). Built-in domains are read-only and carry an
 *  i18n `labelKey`; custom domains carry a literal `label` + a curated `color`
 *  token. See `TOOL_DOMAIN_META` (builtin visual source) and the
 *  `tool_domains` table. */
export interface ToolDomainEntry {
  slug: string
  label: string | null
  labelKey: string | null
  icon: string
  color: string | null
  description: string | null
  builtin: boolean
  createdAt: number
  updatedAt: number
}

/** Resolved visual metadata for a domain, served by GET /api/tools/domain-meta
 *  so the client can render custom-domain badges/icons without hardcoding. For
 *  builtins the triple comes from `TOOL_DOMAIN_META`; for custom domains from
 *  the curated color token. */
export interface ToolDomainMetaResolved {
  slug: string
  icon: string
  bg: string
  text: string
  border: string
  builtin: boolean
  /** i18n key (builtin) — client translates it. */
  labelKey: string | null
  /** literal label (custom) — used when `labelKey` is null. */
  label: string | null
}

/** Agent kind discriminator. 'configurator' marks the seeded conversational
 *  onboarding guide (Queenie) — drives its special prompt blocks, the
 *  `configurator` toolbox, and exclusion from "first real Agent" counts.
 *  All user-created Agents are 'regular'. See queenie.md. */
export type AgentKind = 'regular' | 'configurator'

/** Per-Agent compacting configuration (stored as JSON in agents.compacting_config) */
export interface AgentCompactingConfig {
  /** Model used for compaction (null = same as Agent's model) */
  compactingModel?: string | null
  /** Provider ID for compacting model (null = auto-resolve) */
  compactingProviderId?: string | null
  /** Trigger compaction when context exceeds this % of context window (null = use global default) */
  thresholdPercent?: number | null
  /** Keep recent messages fitting within this % of context window (null = use global default) */
  keepPercent?: number | null
  /** Max % of context window for summaries before merging (null = use global default) */
  summaryBudgetPercent?: number | null
  /** Max active summaries in context before forcing merge (null = use global default) */
  maxSummaries?: number | null
  /** Absolute ceiling (real tokens) on the raw-message keep-window — caps keepPercent (null = use global default) */
  keepMaxTokens?: number | null
  /** Absolute ceiling (real tokens) on context size before compaction triggers — caps thresholdPercent (null = use global default) */
  triggerMaxTokens?: number | null
  /** Absolute ceiling (real tokens) on total summary tokens before telescopic merge — caps summaryBudgetPercent (null = use global default) */
  summaryMaxTokens?: number | null
}

/** Effort level for thinking/reasoning — maps to provider-specific budgets/flags.
 *  Mirrors the SDK's `ThinkingEffort` union (kept inline so the client bundle
 *  never imports SDK values). Canonical order in `THINKING_EFFORTS`
 *  (shared/constants.ts). */
export type AgentThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Per-Agent thinking/reasoning configuration (stored as JSON in agents.thinking_config) */
export interface AgentThinkingConfig {
  /** Whether thinking/reasoning is enabled for this Agent */
  enabled: boolean
  /** Effort level — mapped per-provider to budget tokens or reasoning_effort. Defaults to 'medium' when enabled and unset. */
  effort?: AgentThinkingEffort | null
  /** @deprecated Use `effort` instead. Raw token budget kept for backwards compatibility on existing rows. */
  budgetTokens?: number | null
}

/** Task summary as returned by GET /api/tasks */
export interface TaskSummary {
  id: string
  parentAgentId: string
  parentAgentName: string
  parentAgentAvatarUrl: string | null
  sourceAgentId: string | null
  sourceAgentName: string | null
  sourceAgentAvatarUrl: string | null
  title: string | null
  description: string
  status: TaskStatus
  mode: string
  model: string | null
  /** Provider family resolved from the effective model — surfaced as a label
   *  on the token usage tooltip. */
  providerType?: string | null
  providerId: string | null
  cronId: string | null
  depth: number
  thinkingEnabled?: boolean
  thinkingEffort?: AgentThinkingEffort | null
  concurrencyGroup: string | null
  concurrencyMax: number | null
  queuePosition: number | null
  /** Task-level token roll-up. Null/undefined when no LLM call has been
   *  recorded yet (queued / just-spawned). Updated live via the
   *  `task:token-usage` SSE event. */
  tokenUsage?: TaskTokenUsage | null
  /** Unix-ms (as string, like createdAt/updatedAt) when the task first entered
   *  in_progress. Null while queued/pending. Source of truth for the live +
   *  persisted run duration shown in the tasks list. */
  startedAt?: string | null
  /** When the task reached a terminal status. Null while still active. */
  endedAt?: string | null
  createdAt: string
  updatedAt: string
}

/** Cron summary as returned by GET /api/crons */
export interface CronSummary {
  id: string
  agentId: string
  agentName: string
  agentAvatarUrl: string | null
  name: string
  schedule: string
  taskDescription: string
  targetAgentId: string | null
  targetAgentName: string | null
  targetAgentAvatarUrl: string | null
  model: string | null
  providerId: string | null
  thinkingEnabled: boolean
  thinkingEffort: AgentThinkingEffort | null
  /** Toolbox ids defining the native toolset of tasks spawned by this cron.
   *  Empty → full native surface ("all"). */
  toolboxIds: string[]
  runOnce: boolean
  triggerParentTurn: boolean
  isActive: boolean
  requiresApproval: boolean
  lastTriggeredAt: number | null
  /** Number of tasks this cron has spawned so far (one per execution). */
  executionCount: number
  createdBy: 'user' | 'agent'
  createdAt: number
}

export type WebhookFilterMode = 'simple' | 'advanced'
export type WebhookDispatchMode = 'conversation' | 'task'

/** Webhook summary as returned by GET /api/webhooks */
export interface WebhookSummary {
  id: string
  agentId: string
  agentName: string
  agentAvatarUrl: string | null
  name: string
  description: string | null
  isActive: boolean
  triggerCount: number
  lastTriggeredAt: number | null
  filterMode: WebhookFilterMode | null
  filterField: string | null
  filterAllowedValues: string[] | null
  filterExpression: string | null
  filteredCount: number
  dispatchMode: WebhookDispatchMode
  taskTitleTemplate: string | null
  taskPromptTemplate: string | null
  maxConcurrentTasks: number
  createdBy: 'user' | 'agent'
  createdAt: number
  /** Full incoming URL (scheme + host + path) */
  url: string
}

/** Webhook trigger log entry as returned by GET /api/webhooks/:id/logs */
export interface WebhookLog {
  id: string
  webhookId: string
  payload: string | null
  sourceIp: string | null
  filtered: boolean
  createdAt: number
}

/** Result of testing a webhook filter against a payload */
export interface WebhookFilterTestResult {
  passed: boolean
  extractedValue?: string | null
  error?: string
}

// ─── Account triggers ────────────────────────────────────────────────────────

/** How a matched email reaches the target Agent. */
export type TriggerDispatchMode = 'conversation' | 'task'

/** A condition leaf field. Fields above the divider come free from the message
 *  summary; `body` / `attachment_*` require fetching the full message. */
export type ConditionField =
  | 'sender_email' | 'sender_domain' | 'sender_name' | 'subject' | 'snippet'
  | 'recipient' | 'has_attachment' | 'unread' | 'label' | 'thread_id' | 'in_reply_to'
  | 'body' | 'attachment_name' | 'attachment_type'

export type ConditionOp =
  | 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'matches' | 'in' | 'is_true' | 'is_false'

export interface ConditionLeaf {
  type: 'leaf'
  field: ConditionField
  op: ConditionOp
  /** string for text ops, string[] for `in`, ignored for `is_true`/`is_false`. */
  value: string | string[] | boolean
  negate?: boolean
}

export interface ConditionGroup {
  type: 'group'
  op: 'and' | 'or'
  children: ConditionNode[]
}

export type ConditionNode = ConditionGroup | ConditionLeaf

/** Account trigger as returned by GET /api/account-triggers */
export interface AccountTriggerSummary {
  id: string
  accountId: string
  accountLabel: string
  name: string
  isActive: boolean
  folder: string
  conditions: ConditionNode
  conditionsSummary: string
  prompt: string
  targetAgentId: string
  targetAgentName: string
  targetAgentAvatarUrl: string | null
  dispatchMode: TriggerDispatchMode
  maxConcurrentTasks: number
  /** One-shot: the trigger disables itself after its first match. Used by the
   *  send_email reply-watch, which only needs to catch the first reply. */
  disableAfterFire: boolean
  triggerCount: number
  lastTriggeredAt: number | null
  createdBy: 'user' | 'agent'
  requiresApproval: boolean
  createdAt: number
}

/** Trigger evaluation log entry as returned by GET /api/account-triggers/:id/logs */
export interface TriggerLogEntry {
  id: string
  triggerId: string
  summary: string | null
  matched: boolean
  action: TriggerDispatchMode | null
  createdAt: number
}

// ─── Human Prompt types ──────────────────────────────────────────────────────

export type HumanPromptType = 'confirm' | 'select' | 'multi_select' | 'text' | 'tool_access'

export type HumanPromptStatus = 'pending' | 'answered' | 'expired' | 'cancelled'

export type HumanPromptOptionVariant = 'default' | 'success' | 'warning' | 'destructive' | 'primary'

export interface HumanPromptOption {
  label: string
  value: string
  description?: string
  variant?: HumanPromptOptionVariant
}

export interface HumanPromptSummary {
  id: string
  agentId: string
  taskId: string | null
  promptType: HumanPromptType
  question: string
  description: string | null
  options: HumanPromptOption[]
  response: unknown | null
  status: HumanPromptStatus
  createdAt: number
  respondedAt: number | null
}

// ─── Secret prompts (secure input) ───────────────────────────────────────────

export type SecretPromptPurpose = 'provider' | 'channel' | 'vault' | 'reveal'

/** One field the user must fill in the secure-input popup. `secret: true`
 *  fields render as masked password inputs and go straight to the vault. */
export interface SecretPromptField {
  key: string
  label: string
  secret: boolean
  placeholder?: string
  description?: string
  /** Optional URL where the user can generate the credential (provider key page). */
  keyUrl?: string
}

/** Payload of the `prompt:secret-request` SSE event — drives the secure-input modal. */
export interface SecretPromptRequest {
  promptId: string
  agentId: string
  purpose: SecretPromptPurpose
  title: string
  description?: string
  fields: SecretPromptField[]
  /** Setup-card kind (interactive-setup.md). Absent ⇒ 'fields' (today's
   *  secret-input popup). 'oauth' / 'qr' carry the extra payload below. */
  kind?: SetupCardKind
  /** Present when `kind === 'oauth'`. */
  oauth?: OAuthCardPayload
  /** Present when `kind === 'qr'`. */
  qr?: QrCardPayload
}

/**
 * Setup cards generalize the secure-input popup beyond pasting a secret. The
 * `kind` (carried inside the prompt's JSON `spec`; absent ⇒ `'fields'`) selects
 * how the card renders and how it resolves. See `interactive-setup.md`.
 *   - `fields` — masked/secret field inputs (today's behavior)
 *   - `oauth`  — interactive browser sign-in (button + authorization code)
 *   - `qr`     — pair by scanning a QR code (live; resolves on connect)
 */
export type SetupCardKind = 'fields' | 'oauth' | 'qr'

/** Extra payload for the `oauth` card kind (in the `prompt:secret-request` SSE). */
export interface OAuthCardPayload {
  /** Authorize URL the user opens to sign in. */
  authorizeUrl: string
  /** Provider display name, for the button/copy. */
  providerDisplayName: string
  /** How the code is surfaced, so the paste hint is worded generically. */
  redirectStyle: 'page' | 'loopback'
}

/** Extra payload for the `qr` card kind. The QR image arrives live via the
 *  `channel:pairing` SSE event, keyed by `channelId`; `qrImage` carries the
 *  latest known one for cards that mount late / on resync. */
export interface QrCardPayload {
  channelId: string
  /** Latest QR as a data-URL PNG, when one has already been emitted. */
  qrImage?: string
}

/** Serialized file as returned by the API and displayed in chat */
export interface MessageFile {
  id: string
  name: string
  mimeType: string
  size: number
  url: string
}

// ─── Quick Session types ─────────────────────────────────────────────────────

export type QuickSessionStatus = 'active' | 'closed'

export interface QuickSessionSummary {
  id: string
  agentId: string
  title: string | null
  status: QuickSessionStatus
  createdAt: number
  closedAt: number | null
  expiresAt: number | null
  messageCount?: number
  /** Per-session LLM override — null means "inherit the agent's model". */
  model?: string | null
  providerId?: string | null
  /** Per-session thinking override — null means "inherit the agent's config". */
  thinkingEnabled?: boolean | null
  thinkingEffort?: AgentThinkingEffort | null
}

// ─── Channel types ──────────────────────────────────────────────────────────

export type KnownChannelPlatform = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'signal' | 'matrix'
export type ChannelPlatform = KnownChannelPlatform | (string & {})

export type ChannelStatus = 'active' | 'inactive' | 'error'

export type ChannelUserMappingStatus = 'pending'

/**
 * A single field declared by a channel adapter so the UI can render a dynamic
 * configuration form and the server can validate the payload before storing it
 * in `channels.platformConfig`.
 *
 * Mirrored to plugin manifests via `PluginChannelConfigField` in
 * `src/shared/types/plugin.ts`.
 */
// ChannelConfigField + ChannelConfigSchema live in the SDK now (single
// source of truth shared with plugin authors). Re-exported here so
// existing imports from `@/shared/types` keep working unchanged.
export type { ChannelConfigField, ChannelConfigSchema } from '@gezy/sdk'

/** Channel summary as returned by GET /api/channels */
export interface ChannelSummary {
  id: string
  agentId: string
  agentName: string
  agentAvatarUrl: string | null
  name: string
  platform: ChannelPlatform
  status: ChannelStatus
  statusMessage: string | null
  autoCreateContacts: boolean
  messagesReceived: number
  messagesSent: number
  lastActivityAt: number | null
  createdBy: 'user' | 'agent'
  createdAt: number
  pendingApprovalCount: number
  /**
   * Public inbound-webhook URL to paste into the external platform's console
   * (e.g. Twilio). Set only for plugin channels whose adapter handles inbound
   * webhooks; `null` for built-in or non-webhook channels.
   */
  webhookUrl: string | null
}

/** Pending channel user awaiting approval */
export interface ChannelPendingUser {
  id: string
  channelId: string
  platformUserId: string
  platformUsername: string | null
  platformDisplayName: string | null
  createdAt: number
  /** Messages buffered while awaiting approval (replayed as one turn on approve) */
  bufferedCount: number
}

/** Platform ID linked to a contact (for channel authorization) */
export interface ContactPlatformId {
  id: string
  contactId: string
  platform: string
  platformId: string
  createdAt: number
}

// ─── User management types ──────────────────────────────────────────────────

/** User summary as returned by GET /api/users */
export interface UserSummary {
  id: string
  name: string
  email: string
  firstName: string
  lastName: string
  pseudonym: string
  language: string
  role: string
  avatarUrl: string | null
  createdAt: number
}

/** Invitation summary as returned by GET /api/invitations */
export interface InvitationSummary {
  id: string
  token: string
  label: string | null
  url: string
  createdBy: string
  creatorName: string
  agentId: string | null
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
  usedByName: string | null
  createdAt: number
}

// ─── Vault types ────────────────────────────────────────────────────────────

/** Built-in vault entry types */
export type VaultBuiltInEntryType = 'text' | 'credential' | 'card' | 'note' | 'identity'

/** Entry type — built-in or custom slug */
export type VaultEntryType = VaultBuiltInEntryType | (string & {})

/** Field data types for vault type definitions */
export type VaultFieldType = 'text' | 'password' | 'textarea' | 'url' | 'email' | 'phone' | 'date' | 'number'

/** Single field definition within a vault type */
export interface VaultTypeField {
  name: string        // machine name (e.g. "username")
  label: string       // display label (e.g. "Username")
  type: VaultFieldType
  required?: boolean
  placeholder?: string
}

/** Vault type summary for list views */
export interface VaultTypeSummary {
  id: string
  slug: string
  name: string
  icon: string | null
  fields: VaultTypeField[]
  isBuiltIn: boolean
  createdByAgentId: string | null
  createdAt: number
}

/** Vault entry summary (list view — no decrypted value) */
export interface VaultEntrySummary {
  id: string
  key: string
  description: string | null
  entryType: VaultEntryType
  isFavorite: boolean
  attachmentCount: number
  createdByAgentId: string | null
  createdAt: number
  updatedAt: number
}

/** Vault attachment metadata */
export interface VaultAttachmentSummary {
  id: string
  name: string
  mimeType: string
  size: number
  createdAt: number
}

/** Mini-app summary as returned by GET /api/mini-apps */
export interface MiniAppSummary {
  id: string
  /** Agent responsible for the app (reassignable); any Agent can edit it. */
  maintainerAgentId: string
  maintainerAgentName: string
  maintainerAgentAvatarUrl: string | null
  name: string
  slug: string
  description: string | null
  icon: string | null
  iconUrl: string | null
  entryFile: string
  hasBackend: boolean
  isActive: boolean
  version: number
  createdAt: number
  updatedAt: number
}

/** Tool domain categories for UI grouping and color coding */

// ─── Platform update system ──────────────────────────────────────────────────

/** Update channel: stable follows GitHub releases (tags), edge follows main HEAD. */
export type UpdateChannel = 'stable' | 'edge'

/** How this Hivekeep instance was installed (drives the update UX). */
export type InstallationType = 'docker' | 'systemd-system' | 'systemd-user' | 'launchd' | 'manual'

/** One entry of the cumulative changelog between the running version and the
 *  proposed one. Stable channel: one entry per intermediate release (markdown
 *  notes). Edge channel: one entry per commit on main. */
export interface ChangelogEntry {
  /** Release tag without the leading v (stable) or short commit sha (edge) */
  version: string
  /** Release title (stable) or commit subject (edge) */
  title: string
  /** Markdown release notes (stable only) */
  notes: string | null
  url: string | null
  publishedAt: number | null
}

/** Version check info returned by the version-check API */
export interface VersionInfo {
  currentVersion: string
  /** Short git sha of the running code (null when not determinable) */
  currentSha: string | null
  channel: UpdateChannel
  installationType: InstallationType
  /** Latest release semver (stable) or main HEAD short sha (edge) */
  latestVersion: string | null
  isUpdateAvailable: boolean
  /** Whether this install can apply the update itself from the UI.
   *  False for docker (image repull) and dev/manual non-git setups. */
  canSelfUpdate: boolean
  /** When canSelfUpdate is false, a machine-readable reason for the UI */
  selfUpdateBlockedReason: 'docker' | 'not-git' | 'dev-mode' | null
  releaseUrl: string | null
  /** Cumulative changelog from current → latest (newest first) */
  changelog: ChangelogEntry[]
  publishedAt: number | null
  lastCheckedAt: number | null
}

/** Steps of a self-update run, in execution order. */
export type UpdateStepId =
  | 'preflight'
  | 'snapshot'
  | 'backup'
  | 'download'
  | 'apply'
  | 'dependencies'
  | 'assets'
  | 'restart'

export type UpdateRunStatus =
  /** Update is being prepared (pre-restart steps running) */
  | 'running'
  /** Files swapped, server is restarting into the new version */
  | 'restarting'
  /** New version booted and is healthy */
  | 'success'
  /** Update aborted before restart; previous version still running */
  | 'failed'
  /** New version failed to boot; automatic rollback restored the previous one */
  | 'rolled-back'

/** Persisted record of the latest self-update attempt (data/update/journal.json).
 *  Written by the orchestrator, finalized by the boot guard after restart. */
export interface UpdateRunInfo {
  id: string
  channel: UpdateChannel
  fromVersion: string
  fromSha: string | null
  toVersion: string
  status: UpdateRunStatus
  /** Step currently running (while status is 'running') */
  currentStep: UpdateStepId | null
  error: string | null
  startedAt: number
  finishedAt: number | null
}

/**
 * The well-known built-in tool domains. Each has static metadata
 * (icon/colors/i18n label) in `TOOL_DOMAIN_META`. Native tool registration
 * (`src/server/tools/register.ts`) passes these literals, so keeping the union
 * gives IDE autocomplete + an exhaustiveness anchor for `TOOL_DOMAIN_META`.
 */
export type BuiltinToolDomain =
  | 'search'
  | 'browse'
  | 'voice'
  | 'contacts'
  | 'calendar'
  | 'memory'
  | 'vault'
  | 'tasks'
  | 'inter-agent'
  | 'crons'
  | 'custom'
  | 'images'
  | 'shell'
  | 'filesystem'
  | 'file-storage'
  | 'mcp'
  | 'agent-management'
  | 'webhooks'
  | 'channels'
  | 'email'
  | 'system'
  | 'users'
  | 'database'
  | 'mini-apps'
  | 'plugins'
  | 'projects'

/**
 * A tool domain slug. Built-in domains are the well-known ones in
 * `BuiltinToolDomain`; user-created domains (DB-backed `tool_domains`) widen
 * this to any string. Visual metadata for a domain is resolved at runtime
 * (builtins from `TOOL_DOMAIN_META`, customs from the DB) — never assume the
 * value is a member of `BuiltinToolDomain`.
 */
export type ToolDomain = string

// ─── Context token breakdown ──────────────────────────────────────────────

/** Breakdown of token usage by category in the LLM context. */
export interface ContextTokenBreakdown {
  systemPrompt: number
  messages: number
  tools: number
  /** Tokens from the compacting summary (split from systemPrompt). */
  summary: number
  /** Tokens from previous cron run results (only for cron-spawned tasks). */
  cronRuns?: number
  /** Tokens from accumulated cron learnings (only for cron-spawned tasks). */
  cronLearnings?: number
  total: number
}

/** Status of the progressive compaction pipeline. */
export interface ContextPipelineStatus {
  /** Number of tool call groups whose results were fully collapsed. */
  maskedToolGroups: number
  /** Number of messages compacted by observation compaction (truncated). */
  observationCompactedCount: number
  /** Estimated tokens saved by tool result masking + observation compaction. */
  estimatedTokensSavedByMasking: number
  /** Number of messages dropped by emergency token-budget trimming. */
  emergencyTrimmedCount: number
  /** Per-tool-result size cap (`toolResultSizeCapTokens`) trim activity for the
   *  current turn — counts a single tool-result block trimmed, summing the
   *  original (pre-cap) tokens. Surfaced in the UI so the user knows when the
   *  caps actually fire and how much they save. */
  trimmedToolResultsCount: number
  trimmedToolResultsTokensSaved: number
  /** Per-tool-call args size cap (`toolCallArgsSizeCapTokens`) trim activity. */
  trimmedToolCallArgsCount: number
  trimmedToolCallArgsTokensSaved: number
  /** Per-assistant-content size cap (`assistantContentSizeCapTokens`) trim. */
  trimmedAssistantContentCount: number
  trimmedAssistantContentTokensSaved: number
  /** Per-user-content size cap (`userContentSizeCapTokens`) trim. */
  trimmedUserContentCount: number
  trimmedUserContentTokensSaved: number
}

// ─── LLM Usage Tracking ───────────────────────────────────────────────────────

export type LlmUsageCallSite =
  | 'chat'
  | 'quick-session'
  | 'task'
  | 'compacting'
  | 'consolidation'
  | 'memory-review'
  | 'memory-multi-query'
  | 'memory-hyde'
  | 'memory-rerank'
  | 'memory-contextual-rewrite'
  | 'importance-backfill'
  | 'embedding'
  | 'image-gen'
  | 'avatar-prompt'
  | 'icon-prompt'
  | 'agent-generate'

export type LlmUsageCallType = 'stream-text' | 'generate-text' | 'embed' | 'generate-image'

export interface LlmUsageRow {
  id: string
  createdAt: number
  callSite: string
  callType: string
  providerType: string | null
  providerId: string | null
  modelId: string | null
  agentId: string | null
  taskId: string | null
  cronId: string | null
  sessionId: string | null
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  embeddingTokens: number | null
  stepCount: number
  /** Estimated USD cost, frozen at the registry price when recorded (null when
   *  the model had no pricing). */
  costUsd: number | null
}

/** Per-message token usage stored in message metadata and sent via SSE. */
export interface MessageTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  stepCount?: number
}

/** Task-level roll-up of every LLM call attributed to a task (call_site='task'
 *  plus any side-channels like compacting that pass the taskId). Returned by
 *  GET /api/tasks/:id and pushed live via the `task:token-usage` SSE event so
 *  the task panel can surface a running total without polling.
 *
 *  The shape extends `MessageTokenUsage` so the existing `TokenUsageIndicator`
 *  popover can render it without changes; `callCount` is a task-specific extra
 *  (the indicator ignores it when unused). */
export interface TaskTokenUsage extends MessageTokenUsage {
  /** Number of `llm_usage` rows aggregated. Useful when the user wants to know
   *  "how many LLM round-trips did this task make?". */
  callCount: number
}

export interface UsageSummaryRow {
  group: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Estimated USD cost for the group (sum of per-row frozen costs). */
  costUsd: number
  count: number
}

// ─── Projects & tickets ────────────────────────────────────────────────────────

export type TicketStatus = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'

export interface ProjectTag {
  id: string
  label: string
  color: string
}

export interface ProjectSummary {
  id: string
  /** Stable, human-readable identifier used to qualify ticket numbers (e.g.
   *  `hivekeep#42`). Empty string ('') for legacy rows pre-dating the backfill. */
  slug: string
  title: string
  githubUrl: string | null
  /** Surfaced in summaries so list views and the project header can show the
   *  clone state badge without re-fetching the full Project. */
  githubRepo: string | null
  cloneStatus: CloneStatus
  ticketCount: number
  openTicketCount: number
  createdAt: number
  updatedAt: number
}

/** Lifecycle state of the per-project local git clone used by sub-task
 *  worktrees. `'none'` covers both "no repo configured" and "configured
 *  but clone not kicked off yet" — disambiguate via `githubRepo`. */
export type CloneStatus = 'none' | 'cloning' | 'ready' | 'error'

/** Subset of a GitHub repo returned by the repo-picker route. Mirrors the
 *  server's `GitHubRepoSummary` (kept in sync with `src/server/services/github.ts`). */
export interface GitHubRepoSummary {
  /** Canonical "owner/name" — the value we persist on `projects.githubRepo`. */
  fullName: string
  owner: string
  name: string
  private: boolean
  defaultBranch: string
  description: string | null
  htmlUrl: string
  /** Whether the PAT can push. `null` on `/search/repositories` results
   *  (GitHub omits permissions there). */
  canPush: boolean | null
}

export interface Project {
  id: string
  /** Human-readable identifier — see ProjectSummary.slug. */
  slug: string
  title: string
  description: string
  githubUrl: string | null
  /** Vault key (not value) referencing the PAT used to clone + push for this
   *  project. The PAT itself is resolved on demand via the vault service and
   *  is never embedded in `Project` payloads. */
  githubPatVaultKey: string | null
  /** Canonical "owner/name" of the GitHub repo backing this project. Drives
   *  the local clone path (`<repos>/<slug>/`) and the worktree branch base. */
  githubRepo: string | null
  /** Branch sub-task worktrees are created from. Defaults to 'main'. */
  defaultBranch: string
  cloneStatus: CloneStatus
  /** Last clone failure message, surfaced in the project header so the user
   *  can retry. Cleared on a successful clone. */
  cloneError: string | null
  /** Unix ms of the last successful clone, or null if never cloned. */
  clonedAt: number | null
  /** Optional default model for sub-Agent tasks spawned on tickets of this
   *  project. Frozen into the task at spawn time; falls back to the Agent's
   *  own model when null. An explicit model passed at spawn still wins. */
  model: string | null
  providerId: string | null
  /** Optional default scout model for work in this project's context. One tier
   *  of resolveScoutModel()'s chain, BETWEEN the per-call override and the
   *  per-Agent scout (project beats Agent). Coupled with `scoutProviderId`.
   *  Null falls through to the Agent scout → global default → Agent main model. */
  scoutModel: string | null
  scoutProviderId: string | null
  /** Optional reasoning config for scouts dispatched in this project's context.
   *  Same chain position as `scoutModel` (project beats Agent). Null = unset
   *  tier (falls through to the Agent scout thinking → global default → the
   *  calling Agent's own general config). */
  scoutThinkingConfig: AgentThinkingConfig | null
  /** Optional default thinking/reasoning config for sub-Agent tasks spawned on
   *  tickets of this project. Same freeze-at-spawn semantics as `model`.
   *  Null means "inherit from each Agent". */
  thinkingConfig: AgentThinkingConfig | null
  /** Optional default toolbox selection (toolbox ids) for sub-Agent tasks
   *  spawned on tickets of this project. Frozen into the task at spawn when no
   *  explicit toolbox selection is provided. Null means "inherit the runtime
   *  default" ('code' for ticket tasks). An explicit selection at spawn wins. */
  defaultToolboxIds: string[] | null
  tags: ProjectTag[]
  ticketCounts: Record<TicketStatus, number>
  createdAt: number
  updatedAt: number
}

/**
 * A curated piece of durable knowledge attached to a project (architectural
 * decisions, conventions, gotchas, domain facts). Shared across Agents acting
 * on the project.
 *
 * Every entry's `title` always lands in the system-prompt knowledge index.
 * When `pinned` is true, the full markdown `content` is also injected
 * inline — no tool call needed to read it. When false, the Agent reads
 * the content via `get_project_knowledge(id)`.
 */
export interface ProjectKnowledge {
  id: string
  projectId: string
  /** Short human-readable title (always shown in the prompt index). */
  title: string
  /** Markdown body. Inlined into the prompt only when `pinned` is true. */
  content: string
  /** Optional free-text bucket (e.g. 'arch', 'decision', 'gotcha'). */
  category: string | null
  pinned: boolean
  /** Agent that created the entry, or null when created by the end-user via UI. */
  authorAgentId: string | null
  /** Resolved Agent name for display (null when authorAgentId is null = user). */
  authorAgentName: string | null
  createdAt: number
  updatedAt: number
}

/** Lightweight projection used to render the system-prompt index without
 *  shipping the full markdown body for every entry. */
export interface ProjectKnowledgeIndexEntry {
  id: string
  title: string
  category: string | null
  pinned: boolean
  authorAgentName: string | null
}

/** A single hit returned by `searchProjectKnowledge`. */
export interface ProjectKnowledgeSearchHit extends ProjectKnowledge {
  score: number
}

export interface RunningAgentOnTicket {
  agentId: string
  agentName: string
  agentSlug: string | null
  avatarUrl: string | null
  taskId: string
}

/** Whoever created a ticket — either a platform user (UI) or an Agent (tool). */
export type TicketReporter =
  | { type: 'user'; id: string; name: string; avatarUrl: string | null }
  | { type: 'agent'; id: string; slug: string | null; name: string; avatarUrl: string | null }

export interface TicketSummary {
  id: string
  projectId: string
  /** Per-project monotonic ticket number (`#42`). Null for legacy rows still
   *  awaiting the startup backfill — never null for tickets created via
   *  createTicket() once the slug/number feature shipped. */
  number: number | null
  title: string
  description: string
  status: TicketStatus
  position: number
  tags: ProjectTag[]
  taskCount: number
  runningTaskCount: number
  /** Number of tasks on this ticket currently in `awaiting_human_input` —
   *  i.e. a sub-Agent is suspended on a prompt_human / request_input call and
   *  needs the user to answer before resuming. */
  awaitingHumanInputCount: number
  /** Agents currently executing a task on this ticket (status queued/pending/in_progress).
   *  One entry per running task — same Agent can appear twice if it has multiple in flight. */
  runningAgents: RunningAgentOnTicket[]
  /** Who created this ticket. Null for legacy rows. */
  reporter: TicketReporter | null
  /** Number of attachments on this ticket. Refreshes via SSE
   *  `ticket:updated` after each attachment mutation. */
  attachmentCount: number
  /** Unix-ms when the ticket last entered the in_progress column. This tracks
   *  the kanban *column* transition only (project-management state), NOT task
   *  activity. Null when the ticket has never been moved to in_progress. */
  inProgressAt: number | null
  /** Unix-ms when the EARLIEST currently-running task on this ticket started
   *  being processed (min over tasks in queued/pending/in_progress, using
   *  startedAt → queuedAt → createdAt). This is decoupled from the kanban
   *  column: it reflects whether the ticket has live task work, which is what
   *  drives the "running" framing + live chrono on the card. Null when no task
   *  is currently running. */
  runningSince: number | null
  createdAt: number
  updatedAt: number
}

export interface TicketTaskSummary {
  id: string
  parentAgentId: string
  parentAgentName: string
  /** Avatar URL of the parent Agent (so the side panel can display the right
   *  avatar when opened from a ticket). Null if the Agent has no avatar. */
  parentAgentAvatarUrl: string | null
  status: TaskStatus
  mode: TaskMode
  /** Task variant. 'execute' is a regular ticket task; 'enrich' is a
   *  ticket-enrichment pass that rewrites title/description/tags. */
  kind: 'execute' | 'enrich'
  /** Unix-ms when the task first entered in_progress. Null while queued/pending.
   *  Used (with endedAt / now) to show the run duration on the ticket panel. */
  startedAt: number | null
  /** Unix-ms when the task reached a terminal status. Null while still active. */
  endedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Ticket extends Omit<TicketSummary, 'description'> {
  description: string
  tasks: TicketTaskSummary[]
}

// ─── Ticket comments ────────────────────────────────────────────────────────

export interface TicketCommentAuthor {
  type: 'user' | 'agent'
  id: string
  name: string
  avatarUrl: string | null
  /** Agent slug, only set when type === 'agent' */
  slug?: string
}

export interface TicketCommentMetadata {
  fromTaskId?: string
  autoGenerated?: boolean
}

export interface TicketComment {
  id: string
  ticketId: string
  author: TicketCommentAuthor
  content: string
  metadata: TicketCommentMetadata | null
  createdAt: number
  updatedAt: number
}

// ─── Ticket attachments ─────────────────────────────────────────────────────

/** Who uploaded a ticket attachment. Mirrors TicketReporter but only carries the
 *  shape needed by the UI (no slug). */
export type TicketAttachmentUploader =
  | { type: 'user'; id: string; name: string; avatarUrl: string | null }
  | { type: 'agent'; id: string; name: string; avatarUrl: string | null }
  | null

/** A single file attached to a ticket. The `url` field points at the
 *  ticket-attachment raw stream and is safe to embed in `<img>` / `<iframe>`.
 *  `storedPath` is the absolute on-disk path; only exposed to Agent tools, never
 *  to the UI (server stripes it before serializing for REST). */
export interface TicketAttachment {
  id: string
  ticketId: string
  name: string
  mimeType: string
  size: number
  description: string | null
  uploadedBy: TicketAttachmentUploader
  /** Endpoint to fetch the raw bytes (relative to the API origin). */
  url: string
  createdAt: number
  updatedAt: number
}

// ─── Workspace files (Files section, see files.md) ──────────────────────────

/** How the server decided a workspace file should be presented. */
export type WorkspaceFileKind = 'text' | 'image' | 'pdf' | 'binary' | 'too-large'

/** One row of a workspace directory listing (GET /workspace/ls). */
export interface WorkspaceEntry {
  name: string
  /** Path relative to the workspace root. */
  path: string
  type: 'file' | 'dir'
  /** 0 for directories. */
  size: number
  /** Unix ms mtime. */
  modifiedAt: number
  isSymlink: boolean
}

/** Full read of a workspace file (GET /workspace/file). */
export interface WorkspaceFileInfo {
  path: string
  name: string
  size: number
  /** Unix ms mtime — echo back as `baseModifiedAt` on PUT (optimistic concurrency). */
  modifiedAt: number
  mimeType: string
  kind: WorkspaceFileKind
  /** Only set when kind === 'text'. */
  content: string | null
}

// ─── Workspace sources (Files section selector — agent / project / folder) ──

export type WorkspaceSourceType = 'agent' | 'project' | 'folder' | 'miniapp'

/**
 * Identifies a browse source for the Files section. `agent` is the legacy
 * per-agent workspace; `project` browses a cloned repo (optionally a specific
 * git worktree); `folder` browses a user-added absolute FS path; `miniapp`
 * browses a mini-app's source directory (id = the mini-app id).
 */
export interface WorkspaceSourceRef {
  type: WorkspaceSourceType
  id: string
  /** Selected git worktree id (project sources only; absent = the base clone). */
  worktree?: string
}

/** A worktree of a project repo, as listed for the worktree sub-selector. */
export interface WorkspaceWorktreeDTO {
  /** Stable id used in WorkspaceSourceRef.worktree (the worktree dir basename; '' = base clone). */
  id: string
  branch: string
  isMain: boolean
  /** Ticket number this worktree was created for, when derivable. */
  ticketNumber?: number
}

/** Lightweight git status shown as a badge over a project/repo source. */
export interface WorkspaceGitStatusDTO {
  branch: string
  /** Number of changed (dirty) entries from `git status --porcelain`. */
  dirtyCount: number
  ahead?: number
  behind?: number
}

/** A user-added arbitrary FS folder source (table workspace_folders). */
export interface WorkspaceFolderDTO {
  id: string
  label: string
  path: string
  createdAt: number
}

// ─── Terminal (admin web terminal — see api.md "Terminal") ──────────────────

/** A live PTY session as shown in the Terminal page's sessions sidebar. */
export interface TerminalSessionDTO {
  id: string
  name: string
  /** Unix ms. */
  createdAt: number
  /** Unix ms — last PTY output or client input. */
  lastActiveAt: number
  /** True while a client (any device) is connected to this session. */
  attached: boolean
  /** True when the session was restored from the DB after a restart and has no
   *  live shell yet — reattaching revives it. */
  dormant: boolean
  /** True when the session is backed by tmux, so its running processes survive
   *  a process-only server restart (not just its scrollback). */
  persistent: boolean
  /** Working directory of the foreground process (or shell when idle). Linux
   *  only and best-effort: undefined when it can't be inspected. */
  cwd?: string
  /** Foreground command currently running, if any (idle shell → undefined). */
  command?: string
}

/** A reusable terminal session preset (working directory + init script). */
export interface TerminalPresetDTO {
  id: string
  name: string
  /** Directory the shell starts in (`~` expanded server-side). Null = home. */
  cwd: string | null
  /** Multi-line script run once when the session is created. Null = none. */
  initScript: string | null
  createdAt: number
  updatedAt: number
}
