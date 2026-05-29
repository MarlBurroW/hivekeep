// Shared types used by both client and server

/** A fully-qualified model reference (model + provider pair) */
export interface ModelRef {
  modelId: string
  providerId: string
}

export type UserRole = 'admin' | 'member'

export type Language = 'en' | 'fr'

// ─── Notification types ────────────────────────────────────────────────────

export type NotificationType =
  | 'prompt:pending'
  | 'channel:user-pending'
  | 'cron:pending-approval'
  | 'mcp:pending-approval'
  | 'kin:error'
  | 'kin:alert'
  | 'mention'

export type NotificationRelatedType = 'prompt' | 'channel' | 'cron' | 'mcp' | 'kin' | 'message'

export interface NotificationSummary {
  id: string
  type: NotificationType
  title: string
  body: string | null
  kinId: string | null
  kinName: string | null
  kinSlug: string | null
  kinAvatarUrl: string | null
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
  kinName: string
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
export type { ProviderCapability } from '@kinbot-developer/sdk'

export type MessageSource = 'user' | 'kin' | 'task' | 'cron' | 'system' | 'webhook' | 'channel'

export type TaskStatus = 'queued' | 'pending' | 'in_progress' | 'paused' | 'awaiting_human_input' | 'awaiting_kin_response' | 'completed' | 'failed' | 'cancelled'

export type TaskMode = 'await' | 'async'

export type TaskTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/** Structured plan item maintained by a sub-Kin during a task. */
export interface TaskTodo {
  id: string
  subject: string
  status: TaskTodoStatus
}

export type InterKinMessageType = 'request' | 'inform' | 'reply'

export type MemoryCategory = 'fact' | 'preference' | 'decision' | 'knowledge'

export type MemoryScope = 'private' | 'shared'

/** Memory summary as returned by memory API endpoints */
export interface MemorySummary {
  id: string
  kinId: string
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
  /** Author Kin name, populated when viewing shared memories from another Kin */
  authorKinName?: string | null
  createdAt: number
  updatedAt: number
}

export type QueueItemPriority = 'user' | 'kin' | 'task'

export type McpServerStatus = 'active' | 'pending_approval'

export type PaletteId = 'aurora' | 'ocean' | 'forest' | 'sunset' | 'monochrome' | 'sakura' | 'neon' | 'lavender'

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

/** Per-Kin tool authorization config (stored as JSON in kins.tool_config) */
export interface KinToolConfig {
  /** Native tool names that are DISABLED (deny-list, empty means all enabled) */
  disabledNativeTools: string[]
  /** MCP server access, serverId -> ['*'] (all tools) or specific tool names */
  mcpAccess: Record<string, string[]>
  /** Native tool names that are explicitly ENABLED despite being defaultDisabled (allow-list) */
  enabledOptInTools?: string[]
  /** Allow http_request to reach RFC1918 and local-network hostnames for this Kin */
  allowPrivateNetworkHttpRequests?: boolean
}

/** Per-Kin compacting configuration (stored as JSON in kins.compacting_config) */
export interface KinCompactingConfig {
  /** Model used for compaction (null = same as Kin's model) */
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
}

/** Effort level for thinking/reasoning — maps to provider-specific budgets/flags. */
export type KinThinkingEffort = 'low' | 'medium' | 'high' | 'max'

/** Per-Kin thinking/reasoning configuration (stored as JSON in kins.thinking_config) */
export interface KinThinkingConfig {
  /** Whether thinking/reasoning is enabled for this Kin */
  enabled: boolean
  /** Effort level — mapped per-provider to budget tokens or reasoning_effort. Defaults to 'medium' when enabled and unset. */
  effort?: KinThinkingEffort | null
  /** @deprecated Use `effort` instead. Raw token budget kept for backwards compatibility on existing rows. */
  budgetTokens?: number | null
}

/** Task summary as returned by GET /api/tasks */
export interface TaskSummary {
  id: string
  parentKinId: string
  parentKinName: string
  parentKinAvatarUrl: string | null
  sourceKinId: string | null
  sourceKinName: string | null
  sourceKinAvatarUrl: string | null
  title: string | null
  description: string
  status: TaskStatus
  mode: string
  model: string | null
  /** Provider family resolved from the effective model — needed by the token
   *  chip to pick the right cache multipliers. */
  providerType?: string | null
  providerId: string | null
  cronId: string | null
  depth: number
  thinkingEnabled?: boolean
  thinkingEffort?: KinThinkingEffort | null
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
  kinId: string
  kinName: string
  kinAvatarUrl: string | null
  name: string
  schedule: string
  taskDescription: string
  targetKinId: string | null
  targetKinName: string | null
  targetKinAvatarUrl: string | null
  model: string | null
  providerId: string | null
  thinkingEnabled: boolean
  thinkingEffort: KinThinkingEffort | null
  runOnce: boolean
  isActive: boolean
  requiresApproval: boolean
  lastTriggeredAt: number | null
  createdBy: 'user' | 'kin'
  createdAt: number
}

export type WebhookFilterMode = 'simple' | 'advanced'
export type WebhookDispatchMode = 'conversation' | 'task'

/** Webhook summary as returned by GET /api/webhooks */
export interface WebhookSummary {
  id: string
  kinId: string
  kinName: string
  kinAvatarUrl: string | null
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
  createdBy: 'user' | 'kin'
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

// ─── Human Prompt types ──────────────────────────────────────────────────────

export type HumanPromptType = 'confirm' | 'select' | 'multi_select' | 'text'

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
  kinId: string
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
  kinId: string
  title: string | null
  status: QuickSessionStatus
  createdAt: number
  closedAt: number | null
  expiresAt: number | null
  messageCount?: number
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
export type { ChannelConfigField, ChannelConfigSchema } from '@kinbot-developer/sdk'

/** Channel summary as returned by GET /api/channels */
export interface ChannelSummary {
  id: string
  kinId: string
  kinName: string
  kinAvatarUrl: string | null
  name: string
  platform: ChannelPlatform
  status: ChannelStatus
  statusMessage: string | null
  autoCreateContacts: boolean
  messagesReceived: number
  messagesSent: number
  lastActivityAt: number | null
  createdBy: 'user' | 'kin'
  createdAt: number
  pendingApprovalCount: number
}

/** Pending channel user awaiting approval */
export interface ChannelPendingUser {
  id: string
  channelId: string
  platformUserId: string
  platformUsername: string | null
  platformDisplayName: string | null
  createdAt: number
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
  kinId: string | null
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
  createdByKinId: string | null
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
  createdByKinId: string | null
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
  kinId: string
  kinName: string
  kinAvatarUrl: string | null
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
/** Version check info returned by the version-check API */
export interface VersionInfo {
  currentVersion: string
  latestVersion: string | null
  isUpdateAvailable: boolean
  releaseUrl: string | null
  releaseNotes: string | null
  publishedAt: number | null
  lastCheckedAt: number | null
}

export type ToolDomain =
  | 'search'
  | 'browse'
  | 'voice'
  | 'contacts'
  | 'memory'
  | 'vault'
  | 'tasks'
  | 'inter-kin'
  | 'crons'
  | 'custom'
  | 'images'
  | 'shell'
  | 'filesystem'
  | 'file-storage'
  | 'mcp'
  | 'kin-management'
  | 'webhooks'
  | 'channels'
  | 'system'
  | 'users'
  | 'database'
  | 'mini-apps'
  | 'plugins'
  | 'projects'

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
  | 'kin-generate'

export type LlmUsageCallType = 'stream-text' | 'generate-text' | 'embed' | 'generate-image'

export interface LlmUsageRow {
  id: string
  createdAt: number
  callSite: string
  callType: string
  providerType: string | null
  providerId: string | null
  modelId: string | null
  kinId: string | null
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
 *  popover can render it without changes; `billableInputTokens` and
 *  `callCount` are task-specific extras (the indicator ignores them when
 *  unused). */
export interface TaskTokenUsage extends MessageTokenUsage {
  /** Provider-aware billable input equivalent (cache reads / writes weighted
   *  by `PROVIDER_CACHE_MULTIPLIERS`). Mirrors what the dashboard surfaces. */
  billableInputTokens: number
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
  /** Provider-aware billable input equivalent (sum of per-row CASE WHEN). */
  billableInputTokens: number
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
   *  `kinbot#42`). Empty string ('') for legacy rows pre-dating the backfill. */
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
  /** Optional default model for sub-Kin tasks spawned on tickets of this
   *  project. Frozen into the task at spawn time; falls back to the Kin's
   *  own model when null. An explicit model passed at spawn still wins. */
  model: string | null
  providerId: string | null
  /** Optional default thinking/reasoning config for sub-Kin tasks spawned on
   *  tickets of this project. Same freeze-at-spawn semantics as `model`.
   *  Null means "inherit from each Kin". */
  thinkingConfig: KinThinkingConfig | null
  tags: ProjectTag[]
  ticketCounts: Record<TicketStatus, number>
  createdAt: number
  updatedAt: number
}

/**
 * A curated piece of durable knowledge attached to a project (architectural
 * decisions, conventions, gotchas, domain facts). Shared across Kins acting
 * on the project.
 *
 * Every entry's `title` always lands in the system-prompt knowledge index.
 * When `pinned` is true, the full markdown `content` is also injected
 * inline — no tool call needed to read it. When false, the Kin reads
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
  /** Kin that created the entry, or null when created by the end-user via UI. */
  authorKinId: string | null
  /** Resolved Kin name for display (null when authorKinId is null = user). */
  authorKinName: string | null
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
  authorKinName: string | null
}

/** A single hit returned by `searchProjectKnowledge`. */
export interface ProjectKnowledgeSearchHit extends ProjectKnowledge {
  score: number
}

export interface RunningKinOnTicket {
  kinId: string
  kinName: string
  kinSlug: string | null
  avatarUrl: string | null
  taskId: string
}

/** Whoever created a ticket — either a platform user (UI) or a Kin (tool). */
export type TicketReporter =
  | { type: 'user'; id: string; name: string; avatarUrl: string | null }
  | { type: 'kin'; id: string; slug: string | null; name: string; avatarUrl: string | null }

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
   *  i.e. a sub-Kin is suspended on a prompt_human / request_input call and
   *  needs the user to answer before resuming. */
  awaitingHumanInputCount: number
  /** Kins currently executing a task on this ticket (status queued/pending/in_progress).
   *  One entry per running task — same Kin can appear twice if it has multiple in flight. */
  runningKins: RunningKinOnTicket[]
  /** Who created this ticket. Null for legacy rows. */
  reporter: TicketReporter | null
  /** Number of attachments on this ticket. Refreshes via SSE
   *  `ticket:updated` after each attachment mutation. */
  attachmentCount: number
  /** Unix-ms when the ticket last entered the in_progress column. Drives the
   *  live "in progress since" duration on the kanban card. Null when the
   *  ticket has never been moved to in_progress. */
  inProgressAt: number | null
  createdAt: number
  updatedAt: number
}

export interface TicketTaskSummary {
  id: string
  parentKinId: string
  parentKinName: string
  /** Avatar URL of the parent Kin (so the side panel can display the right
   *  avatar when opened from a ticket). Null if the Kin has no avatar. */
  parentKinAvatarUrl: string | null
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
  type: 'user' | 'kin'
  id: string
  name: string
  avatarUrl: string | null
  /** Kin slug, only set when type === 'kin' */
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
  | { type: 'kin'; id: string; name: string; avatarUrl: string | null }
  | null

/** A single file attached to a ticket. The `url` field points at the
 *  ticket-attachment raw stream and is safe to embed in `<img>` / `<iframe>`.
 *  `storedPath` is the absolute on-disk path; only exposed to Kin tools, never
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
