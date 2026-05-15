// Shared constants used by both client and server
// 🤖 KinBot — Where AI agents collaborate!

export const SUPPORTED_LANGUAGES = ['en', 'fr'] as const

/** Maximum length (in characters) for a user message. Enforced server-side. */
export const MAX_MESSAGE_LENGTH = 32_000

/** Default maximum number of concurrency-safe tools that can run in parallel
 *  within a single step batch. Override at runtime with the
 *  KINBOT_MAX_TOOL_USE_CONCURRENCY env var. */
export const KINBOT_MAX_TOOL_USE_CONCURRENCY_DEFAULT = 10

// ---------------------------------------------------------------------------
// Provider constants — all derived from PROVIDER_META (single source of truth)
// To add a provider: add one entry to src/shared/provider-metadata.ts
// ---------------------------------------------------------------------------
import { PROVIDER_META, type ProviderType, type ProviderMeta } from '@/shared/provider-metadata'
export type { ProviderType } from '@/shared/provider-metadata'

type MetaEntries = [ProviderType, ProviderMeta][]
const metaEntries = Object.entries(PROVIDER_META) as MetaEntries

export const PROVIDER_TYPES = metaEntries.map(([t]) => t)

/** AI providers (llm, embedding, image capabilities) */
export const AI_PROVIDER_TYPES = metaEntries
  .filter(([, m]) => (m.capabilities as readonly string[]).some(c => c !== 'search'))
  .map(([t]) => t)

/** Search providers (search capability) */
export const SEARCH_PROVIDER_TYPES = metaEntries
  .filter(([, m]) => (m.capabilities as readonly string[]).includes('search'))
  .map(([t]) => t)

export const PROVIDER_CAPABILITIES: Record<string, readonly string[]> = Object.fromEntries(
  metaEntries.map(([t, m]) => [t, m.capabilities]),
)

/** Human-readable display names for provider types */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  metaEntries.map(([t, m]) => [t, m.displayName]),
)

/** URLs where users can obtain or manage their API keys */
export const PROVIDER_API_KEY_URLS: Record<string, string> = Object.fromEntries(
  metaEntries.filter(([, m]) => m.apiKeyUrl).map(([t, m]) => [t, m.apiKeyUrl!]),
)

/** Provider types where the API key field is absent (auto-detected credentials, e.g. anthropic-oauth) */
export const PROVIDERS_WITHOUT_API_KEY = metaEntries
  .filter(([, m]) => m.noApiKey)
  .map(([t]) => t)

/** Provider types where the API key is optional (works without one but supports one, e.g. local Ollama vs Ollama Cloud) */
export const PROVIDERS_WITH_OPTIONAL_API_KEY = metaEntries
  .filter(([, m]) => m.optionalApiKey)
  .map(([t]) => t)

export const REQUIRED_CAPABILITIES = ['llm', 'embedding'] as const

export const MEMORY_CATEGORIES = ['fact', 'preference', 'decision', 'knowledge'] as const

export const MEMORY_SCOPES = ['private', 'shared'] as const

export const MESSAGE_SOURCES = ['user', 'kin', 'task', 'cron', 'system', 'webhook', 'channel'] as const

export const KNOWN_CHANNEL_PLATFORMS = ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'matrix'] as const

/** @deprecated Use KNOWN_CHANNEL_PLATFORMS for built-in platforms or fetch from /api/channels/platforms for all registered platforms */
export const CHANNEL_PLATFORMS = KNOWN_CHANNEL_PLATFORMS

export const TASK_STATUSES = ['pending', 'in_progress', 'awaiting_human_input', 'completed', 'failed', 'cancelled'] as const

export const NOTIFICATION_TYPES = [
  'prompt:pending',
  'channel:user-pending',
  'cron:pending-approval',
  'mcp:pending-approval',
  'kin:error',
  'kin:alert',
  'mention',
] as const

/** Regex to detect @mentions in message content. Shared between client (rendering) and server (parsing). */
export const MENTION_REGEX = /@([a-zA-Z0-9_-]+)/g

export const PALETTE_IDS = ['aurora', 'ocean', 'forest', 'sunset', 'monochrome'] as const

// ---------------------------------------------------------------------------
// Tool domains — centralized metadata for consistent UI across the app
// ---------------------------------------------------------------------------

import type { ToolDomain } from '@/shared/types'

/** Metadata for a tool domain: icon name (Lucide), CSS classes, i18n key */
export interface ToolDomainMeta {
  /** Lucide icon name (resolved client-side) */
  icon: string
  /** Tailwind bg class for subtle backgrounds (badges, containers) */
  bg: string
  /** Tailwind text class for foreground (text, icons) */
  text: string
  /** Tailwind border class */
  border: string
  /** i18n key under tools.domains.* */
  labelKey: string
}

/** Complete metadata per tool domain — single source of truth.
 *  - `bg`/`border` are used only for icon containers and badges, NOT for full cards.
 *  - Cards use neutral `bg-muted` / `border-border` — domain identity comes from the icon color only.
 *  - Avoid green (success) and red (destructive) for domain colors to prevent confusion with statuses. */
export const TOOL_DOMAIN_META: Record<ToolDomain, ToolDomainMeta> = {
  search:     { icon: 'Search',       bg: 'bg-info/40',      text: 'text-info',             border: 'border-info/40',              labelKey: 'tools.domains.search' },
  browse:     { icon: 'Globe',        bg: 'bg-chart-1/40',   text: 'text-chart-1',          border: 'border-chart-1/40',           labelKey: 'tools.domains.browse' },
  contacts:   { icon: 'Users',        bg: 'bg-primary/40',   text: 'text-primary',          border: 'border-primary/40',           labelKey: 'tools.domains.contacts' },
  memory:     { icon: 'Brain',        bg: 'bg-chart-2/40',   text: 'text-chart-2',          border: 'border-chart-2/40',           labelKey: 'tools.domains.memory' },
  vault:      { icon: 'ShieldCheck',  bg: 'bg-warning/40',   text: 'text-warning',          border: 'border-warning/40',           labelKey: 'tools.domains.vault' },
  tasks:      { icon: 'ListTodo',     bg: 'bg-chart-1/40',   text: 'text-chart-1',          border: 'border-chart-1/40',           labelKey: 'tools.domains.tasks' },
  'inter-kin':{ icon: 'MessageCircle',bg: 'bg-chart-4/40',   text: 'text-chart-4',          border: 'border-chart-4/40',           labelKey: 'tools.domains.inter-kin' },
  crons:      { icon: 'Clock',        bg: 'bg-chart-5/40',   text: 'text-chart-5',          border: 'border-chart-5/40',           labelKey: 'tools.domains.crons' },
  custom:     { icon: 'Puzzle',       bg: 'bg-chart-3/40',   text: 'text-chart-3',          border: 'border-chart-3/40',           labelKey: 'tools.domains.custom' },
  images:     { icon: 'Image',        bg: 'bg-primary/40',   text: 'text-primary',          border: 'border-primary/40',           labelKey: 'tools.domains.images' },
  shell:           { icon: 'Terminal',     bg: 'bg-chart-5/40',   text: 'text-chart-5',          border: 'border-chart-5/40',           labelKey: 'tools.domains.shell' },
  filesystem:      { icon: 'FileCode',    bg: 'bg-chart-1/40',   text: 'text-chart-1',          border: 'border-chart-1/40',           labelKey: 'tools.domains.filesystem' },
  'file-storage':  { icon: 'HardDrive',   bg: 'bg-accent/40',   text: 'text-accent-foreground',border: 'border-accent/40',            labelKey: 'tools.domains.file-storage' },
  mcp:             { icon: 'Plug',         bg: 'bg-muted',        text: 'text-muted-foreground', border: 'border-muted-foreground/40',  labelKey: 'tools.domains.mcp' },
  'kin-management':{ icon: 'Crown',       bg: 'bg-chart-3/40',   text: 'text-chart-3',          border: 'border-chart-3/40',           labelKey: 'tools.domains.kin-management' },
  webhooks:        { icon: 'Webhook',     bg: 'bg-info/40',      text: 'text-info',             border: 'border-info/40',              labelKey: 'tools.domains.webhooks' },
  channels:        { icon: 'Radio',       bg: 'bg-chart-4/40',   text: 'text-chart-4',          border: 'border-chart-4/40',           labelKey: 'tools.domains.channels' },
  system:          { icon: 'ScrollText',  bg: 'bg-chart-5/40',   text: 'text-chart-5',          border: 'border-chart-5/40',           labelKey: 'tools.domains.system' },
  users:           { icon: 'UserCog',     bg: 'bg-chart-2/40',   text: 'text-chart-2',          border: 'border-chart-2/40',           labelKey: 'tools.domains.users' },
  database:        { icon: 'Database',    bg: 'bg-destructive/20', text: 'text-destructive',      border: 'border-destructive/20',       labelKey: 'tools.domains.database' },
  'mini-apps':     { icon: 'AppWindow',  bg: 'bg-chart-3/40',    text: 'text-chart-3',          border: 'border-chart-3/40',           labelKey: 'tools.domains.mini-apps' },
  plugins:         { icon: 'Puzzle',      bg: 'bg-chart-4/40',   text: 'text-chart-4',          border: 'border-chart-4/40',           labelKey: 'tools.domains.plugins' },
  projects:        { icon: 'Kanban',      bg: 'bg-chart-2/40',   text: 'text-chart-2',          border: 'border-chart-2/40',           labelKey: 'tools.domains.projects' },
} as const

/** Map tool names to their UI domain category */
export const TOOL_DOMAIN_MAP: Record<string, ToolDomain> = {
  // Search
  web_search: 'search',
  // Browse
  browse_url: 'browse',
  extract_links: 'browse',
  screenshot_url: 'browse',
  http_request: 'browse',
  // Browse — stateful sessions (opt-in)
  browser_open_session: 'browse',
  browser_close_session: 'browse',
  browser_list_sessions: 'browse',
  browser_navigate: 'browse',
  browser_click: 'browse',
  browser_type: 'browse',
  browser_select: 'browse',
  browser_press_key: 'browse',
  browser_scroll: 'browse',
  browser_wait_for: 'browse',
  browser_screenshot: 'browse',
  browser_set_cookies: 'browse',
  browser_get_cookies: 'browse',
  browser_clear_cookies: 'browse',
  browser_request_human: 'browse',
  browser_save_state: 'browse',
  browser_list_states: 'browse',
  browser_delete_state: 'browse',
  // Contacts
  get_contact: 'contacts',
  search_contacts: 'contacts',
  create_contact: 'contacts',
  update_contact: 'contacts',
  delete_contact: 'contacts',
  set_contact_note: 'contacts',
  find_contact_by_identifier: 'contacts',
  // Memory
  recall: 'memory',
  memorize: 'memory',
  update_memory: 'memory',
  forget: 'memory',
  list_memories: 'memory',
  review_memories: 'memory',
  search_history: 'memory',
  browse_history: 'memory',
  list_summaries: 'memory',
  read_summary: 'memory',
  // Knowledge base (folded under memory until it gets >2 tools)
  search_knowledge: 'memory',
  list_knowledge_sources: 'memory',
  // Vault
  get_secret: 'vault',
  redact_message: 'vault',
  create_secret: 'vault',
  update_secret: 'vault',
  delete_secret: 'vault',
  search_secrets: 'vault',
  get_vault_entry: 'vault',
  create_vault_entry: 'vault',
  create_vault_type: 'vault',
  get_vault_attachment: 'vault',
  // Tasks
  spawn_self: 'tasks',
  spawn_kin: 'tasks',
  respond_to_task: 'tasks',
  cancel_task: 'tasks',
  list_tasks: 'tasks',
  list_active_queues: 'tasks',
  get_task_detail: 'tasks',
  get_task_messages: 'tasks',
  report_to_parent: 'tasks',
  update_task_status: 'tasks',
  request_input: 'tasks',
  prompt_human: 'tasks',
  notify: 'tasks',
  save_run_learning: 'tasks',
  delete_run_learning: 'tasks',
  // Inter-Kin
  send_message: 'inter-kin',
  reply: 'inter-kin',
  list_kins: 'inter-kin',
  // Crons (recurring scheduled tasks + one-shot wakeups)
  create_cron: 'crons',
  update_cron: 'crons',
  delete_cron: 'crons',
  list_crons: 'crons',
  get_cron_journal: 'crons',
  trigger_cron: 'crons',
  wake_me_in: 'crons',
  wake_me_every: 'crons',
  cancel_wakeup: 'crons',
  list_wakeups: 'crons',
  // Custom
  register_tool: 'custom',
  run_custom_tool: 'custom',
  list_custom_tools: 'custom',
  // Images
  generate_image: 'images',
  list_image_models: 'images',
  // Shell
  run_shell: 'shell',
  // Filesystem
  read_file: 'filesystem',
  write_file: 'filesystem',
  edit_file: 'filesystem',
  list_directory: 'filesystem',
  multi_edit: 'filesystem',
  grep: 'filesystem',
  // File Storage
  store_file: 'file-storage',
  get_stored_file: 'file-storage',
  list_stored_files: 'file-storage',
  search_stored_files: 'file-storage',
  update_stored_file: 'file-storage',
  delete_stored_file: 'file-storage',
  // MCP
  add_mcp_server: 'mcp',
  update_mcp_server: 'mcp',
  remove_mcp_server: 'mcp',
  list_mcp_servers: 'mcp',
  // Kin Management
  create_kin: 'kin-management',
  update_kin: 'kin-management',
  delete_kin: 'kin-management',
  get_kin_details: 'kin-management',
  // Webhooks
  create_webhook: 'webhooks',
  update_webhook: 'webhooks',
  delete_webhook: 'webhooks',
  list_webhooks: 'webhooks',
  // Channels
  list_channels: 'channels',
  list_channel_conversations: 'channels',
  send_channel_message: 'channels',
  create_channel: 'channels',
  update_channel: 'channels',
  delete_channel: 'channels',
  activate_channel: 'channels',
  deactivate_channel: 'channels',
  transfer_channel: 'channels',
  attach_file: 'channels',
  // System
  get_platform_logs: 'system',
  get_platform_config: 'system',
  list_platform_config_options: 'system',
  update_platform_config: 'system',
  restart_platform: 'system',
  get_system_info: 'system',
  list_providers: 'system',
  list_models: 'system',
  // Users
  list_users: 'users',
  get_user: 'users',
  create_invitation: 'users',
  // Database
  execute_sql: 'database',
  // Mini-Apps
  create_mini_app: 'mini-apps',
  update_mini_app: 'mini-apps',
  delete_mini_app: 'mini-apps',
  list_mini_apps: 'mini-apps',
  write_mini_app_file: 'mini-apps',
  read_mini_app_file: 'mini-apps',
  delete_mini_app_file: 'mini-apps',
  list_mini_app_files: 'mini-apps',
  edit_mini_app_file: 'mini-apps',
  multi_edit_mini_app_file: 'mini-apps',
  get_mini_app_storage: 'mini-apps',
  set_mini_app_storage: 'mini-apps',
  delete_mini_app_storage: 'mini-apps',
  list_mini_app_storage: 'mini-apps',
  clear_mini_app_storage: 'mini-apps',
  create_mini_app_snapshot: 'mini-apps',
  list_mini_app_snapshots: 'mini-apps',
  rollback_mini_app: 'mini-apps',
  generate_mini_app_icon: 'mini-apps',
  get_mini_app_console: 'mini-apps',
  get_mini_app_templates: 'mini-apps',
  get_mini_app_docs: 'mini-apps',
  browse_mini_apps: 'mini-apps',
  // Plugin management
  list_installed_plugins: 'plugins',
  browse_plugin_store: 'plugins',
  install_plugin: 'plugins',
  uninstall_plugin: 'plugins',
  enable_plugin: 'plugins',
  disable_plugin: 'plugins',
  configure_plugin: 'plugins',
  get_plugin_details: 'plugins',
  check_plugin_updates: 'plugins',
  update_plugin: 'plugins',
  // Projects (phase 26 — projects, tags, tickets, ticket tasks)
  list_projects: 'projects',
  get_project: 'projects',
  create_project: 'projects',
  update_project: 'projects',
  delete_project: 'projects',
  update_project_description: 'projects',
  append_project_description: 'projects',
  patch_project_description: 'projects',
  set_active_project: 'projects',
  list_project_tags: 'projects',
  create_tag: 'projects',
  update_tag: 'projects',
  delete_tag: 'projects',
  list_tickets: 'projects',
  get_ticket: 'projects',
  create_ticket: 'projects',
  update_ticket: 'projects',
  add_ticket_tag: 'projects',
  remove_ticket_tag: 'projects',
  delete_ticket: 'projects',
  start_ticket_task: 'projects',
} as const

// ---------------------------------------------------------------------------
// Vault — built-in entry types and their field schemas
// ---------------------------------------------------------------------------

import type { VaultBuiltInEntryType, VaultTypeField } from '@/shared/types'

/** All built-in vault entry type slugs */
export const VAULT_BUILTIN_TYPES: VaultBuiltInEntryType[] = [
  'text',
  'credential',
  'card',
  'note',
  'identity',
]

/** Field definitions for each built-in vault entry type */
export const VAULT_TYPE_META: Record<VaultBuiltInEntryType, {
  icon: string
  labelKey: string
  fields: VaultTypeField[]
}> = {
  text: {
    icon: 'KeyRound',
    labelKey: 'vault.types.text',
    fields: [
      { name: 'value', label: 'Value', type: 'password', required: true },
    ],
  },
  credential: {
    icon: 'Globe',
    labelKey: 'vault.types.credential',
    fields: [
      { name: 'url', label: 'URL', type: 'url' },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  card: {
    icon: 'CreditCard',
    labelKey: 'vault.types.card',
    fields: [
      { name: 'number', label: 'Card Number', type: 'password', required: true },
      { name: 'expiry', label: 'Expiry (MM/YY)', type: 'text', required: true },
      { name: 'cvv', label: 'CVV', type: 'password', required: true },
      { name: 'holderName', label: 'Cardholder Name', type: 'text' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  note: {
    icon: 'StickyNote',
    labelKey: 'vault.types.note',
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'content', label: 'Content', type: 'textarea', required: true },
    ],
  },
  identity: {
    icon: 'UserSquare',
    labelKey: 'vault.types.identity',
    fields: [
      { name: 'fullName', label: 'Full Name', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'phone' },
      { name: 'address', label: 'Address', type: 'textarea' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
}

/** Suggested labels for contact identifiers (UI combo suggestions, not restrictive).
 *  Platform IDs (telegram, discord, etc.) are now managed via contactPlatformIds. */
export const CONTACT_IDENTIFIER_SUGGESTIONS = [
  'email', 'phone', 'mobile',
  'twitter', 'instagram', 'linkedin', 'github',
  'slack', 'website',
] as const

// ─── Projects ─────────────────────────────────────────────────────────────────

export const TICKET_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'done'] as const

/** Validation regex for project slugs.
 *  - lowercase alphanumeric + hyphens
 *  - starts with a letter
 *  - 2-32 chars total
 *  - no leading hyphen (handled by leading-letter rule)
 *  Examples: `kinbot`, `soupcon-de-magie`, `x-1`. */
export const PROJECT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/

/** Regex to capture a ticket reference in free text. Two shapes:
 *  - `slug#42` (qualified) — group 1 = slug, group 2 = number
 *  - `#42` (bare) — group 1 = undefined, group 2 = number
 *  Anchored as a token: preceded by start-of-string or non-word, followed by
 *  end-of-string or non-word. Use with the `g` flag when scanning. */
export const TICKET_MENTION_REGEX = /(?:^|(?<=[^\w-]))(?:([a-z][a-z0-9-]{1,31})#|#)(\d{1,10})(?=$|[^\w-])/g

/** Tags applied to every newly created project. Editable by user/Kin afterward. */
export const DEFAULT_PROJECT_TAGS: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'bug', color: '#ef4444' },
  { label: 'feature', color: '#3b82f6' },
  { label: 'chore', color: '#6b7280' },
  { label: 'doc', color: '#f59e0b' },
]
