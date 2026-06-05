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
export const AI_PROVIDER_TYPES = metaEntries.map(([t]) => t)

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

/** Preference order (case-insensitive substring match against model ids) used
 *  to pick a balanced, tool-use-reliable model when seeding the configurator
 *  Kin (Sherpa) on a freshly added native LLM provider. resolveConfiguratorModel()
 *  returns the first listed model whose id matches the earliest preference; if
 *  none match it falls back to the provider's first listed model. Keyed by
 *  provider `type`. Drift-proof (always validated against the live model list).
 *  See sherpa.md §4.2. */
export const CONFIGURATOR_MODEL_PREFERENCES: Record<string, readonly string[]> = {
  anthropic: ['sonnet', 'opus', 'haiku'],
  'anthropic-oauth': ['sonnet', 'opus', 'haiku'],
  openai: ['gpt-5', 'gpt-4.1', 'gpt-4o', 'o4', 'gpt-4'],
  'openai-codex': ['gpt-5', 'gpt-4.1', 'gpt-4o'],
  gemini: ['flash', 'pro'],
  openrouter: ['sonnet', 'gpt-4o', 'gpt-4.1', 'llama'],
  xai: ['grok-4', 'grok-3', 'grok-2', 'grok'],
}

/** Avatar appearance is two independent global axes the prompt-writer agent is
 *  guided by: the art STYLE (how it's drawn) and the SUBJECT/type (what it
 *  depicts). Presets are UI/onboarding shortcuts; both axes accept free text
 *  ("Other"). The agent writes the per-Kin character (axis C) guided by A+B.
 *  See sherpa.md §9. */
export interface AvatarPreset {
  id: string
  /** Short label shown in the UI / proposed by the configurator. */
  label: string
  /** The directive text injected into the avatar prompt. */
  prompt: string
}

export const AVATAR_STYLE_PRESETS: readonly AvatarPreset[] = [
  { id: 'pixar', label: 'Pixar 3D', prompt: 'Pixar / 3D-animation style, soft lighting' },
  { id: 'anime', label: 'Anime', prompt: 'anime art style, clean linework, cel shading' },
  { id: 'watercolor', label: 'Watercolor', prompt: 'soft watercolor painting style' },
  { id: 'heroic-fantasy', label: 'Heroic fantasy', prompt: 'heroic-fantasy oil painting, dramatic lighting, painterly' },
  { id: 'pixel-art', label: 'Pixel art', prompt: 'detailed retro pixel-art style' },
]

export const AVATAR_SUBJECT_PRESETS: readonly AvatarPreset[] = [
  { id: 'robot', label: 'Robot', prompt: 'a small, friendly, cute robot' },
  { id: 'human', label: 'Human', prompt: 'a human character' },
  { id: 'elf', label: 'Elf', prompt: 'an elf character with pointed ears' },
  { id: 'animal', label: 'Animal', prompt: 'a cute anthropomorphic animal character' },
  { id: 'alien', label: 'Alien', prompt: 'a friendly alien creature' },
  { id: 'mythical', label: 'Mythical creature', prompt: 'a small mythical creature (dragon-like)' },
]

/** Defaults used when the user hasn't customized the avatar axes. The default
 *  subject is a robot because the bundled img2img base image is a robot. */
export const DEFAULT_AVATAR_STYLE = AVATAR_STYLE_PRESETS[0]!.prompt
export const DEFAULT_AVATAR_SUBJECT = AVATAR_SUBJECT_PRESETS[0]!.prompt

export const MEMORY_CATEGORIES = ['fact', 'preference', 'decision', 'knowledge'] as const

export const MEMORY_SCOPES = ['private', 'shared'] as const

export const MESSAGE_SOURCES = ['user', 'kin', 'task', 'cron', 'system', 'webhook', 'channel'] as const

export const KNOWN_CHANNEL_PLATFORMS = ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'matrix'] as const

export const TASK_STATUSES = ['pending', 'in_progress', 'awaiting_human_input', 'completed', 'failed', 'cancelled'] as const

/**
 * Task statuses that mean "this task is still actively attached to its ticket"
 * and must therefore keep the ticket framed as running (primary ring + spinner
 * + live chrono).
 *
 * Crucially this includes the SUSPENDED-BUT-ALIVE states a task enters while it
 * delegates work downward or waits on something:
 *   - `paused`               — manually paused, still owns the slot
 *   - `awaiting_kin_response`— blocked on an inter-Kin request it sent
 *   - `awaiting_subtask`     — blocked on a child it spawned (e.g. the `scout`
 *                              tool) via suspendTaskForChild
 *
 * Without these, a ticket whose task spawns a scout would briefly lose its
 * "running" framing even though the work is merely delegated one level down.
 *
 * `awaiting_human_input` is deliberately EXCLUDED: it gets its own (louder,
 * warning-colored) treatment via `awaitingHumanInputCount`, and the card/panel
 * surface that state separately. */
export const TICKET_RUNNING_TASK_STATUSES = [
  'queued',
  'pending',
  'in_progress',
  'paused',
  'awaiting_kin_response',
  'awaiting_subtask',
] as const

export const NOTIFICATION_TYPES = [
  'prompt:pending',
  'channel:user-pending',
  'cron:pending-approval',
  'mcp:pending-approval',
  'email:pending-send-approval',
  'kin:error',
  'kin:alert',
  'mention',
] as const

/** Regex to detect @mentions in message content. Shared between client (rendering) and server (parsing). */
export const MENTION_REGEX = /@([a-zA-Z0-9_-]+)/g

export const PALETTE_IDS = [
  'aurora',
  'ocean',
  'forest',
  'sunset',
  'monochrome',
  'sakura',
  'neon',
  'lavender',
  'midnight',
  'copper',
  'jade',
  'crimson',
  'galaxy',
  'amber',
  'slate',
  'rose',
  'mint',
  'citrus',
] as const

// ---------------------------------------------------------------------------
// Tool domains — centralized metadata for consistent UI across the app
// ---------------------------------------------------------------------------

import type { BuiltinToolDomain } from '@/shared/types'

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
export const TOOL_DOMAIN_META: Record<BuiltinToolDomain, ToolDomainMeta> = {
  search:     { icon: 'Search',       bg: 'bg-info/40',      text: 'text-info',             border: 'border-info/40',              labelKey: 'tools.domains.search' },
  browse:     { icon: 'Globe',        bg: 'bg-chart-1/40',   text: 'text-chart-1',          border: 'border-chart-1/40',           labelKey: 'tools.domains.browse' },
  voice:      { icon: 'Mic',          bg: 'bg-chart-4/40',   text: 'text-chart-4',          border: 'border-chart-4/40',           labelKey: 'tools.domains.voice' },
  contacts:   { icon: 'Users',        bg: 'bg-primary/40',   text: 'text-primary',          border: 'border-primary/40',           labelKey: 'tools.domains.contacts' },
  calendar:   { icon: 'Calendar',     bg: 'bg-chart-3/40',   text: 'text-chart-3',          border: 'border-chart-3/40',           labelKey: 'tools.domains.calendar' },
  email:      { icon: 'Mail',         bg: 'bg-chart-4/40',   text: 'text-chart-4',          border: 'border-chart-4/40',           labelKey: 'tools.domains.email' },
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

// ---------------------------------------------------------------------------
// Custom tool domains — curated color palette for USER-CREATED domains.
//
// Built-in domains keep their bespoke triples above (some use special cases
// like `bg-muted`, `text-accent-foreground`, `/20` opacity). User-created
// domains may NOT pick arbitrary Tailwind/hex — that would break static class
// extraction, the palette/theme system, and WCAG AA. Instead the UI offers
// this curated token set; every triple below already appears in
// TOOL_DOMAIN_META, so Tailwind's static extractor keeps them.
// `success` / `destructive` are intentionally excluded (status colors).
// ---------------------------------------------------------------------------

export const DOMAIN_COLOR_TOKENS = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'info',
  'warning',
  'primary',
  'accent',
] as const

export type DomainColorToken = (typeof DOMAIN_COLOR_TOKENS)[number]

/** token → the full {bg,text,border} Tailwind triple used by custom domains. */
export const CURATED_DOMAIN_COLORS: Record<
  DomainColorToken,
  { bg: string; text: string; border: string }
> = {
  'chart-1': { bg: 'bg-chart-1/40', text: 'text-chart-1', border: 'border-chart-1/40' },
  'chart-2': { bg: 'bg-chart-2/40', text: 'text-chart-2', border: 'border-chart-2/40' },
  'chart-3': { bg: 'bg-chart-3/40', text: 'text-chart-3', border: 'border-chart-3/40' },
  'chart-4': { bg: 'bg-chart-4/40', text: 'text-chart-4', border: 'border-chart-4/40' },
  'chart-5': { bg: 'bg-chart-5/40', text: 'text-chart-5', border: 'border-chart-5/40' },
  info: { bg: 'bg-info/40', text: 'text-info', border: 'border-info/40' },
  warning: { bg: 'bg-warning/40', text: 'text-warning', border: 'border-warning/40' },
  primary: { bg: 'bg-primary/40', text: 'text-primary', border: 'border-primary/40' },
  accent: { bg: 'bg-accent/40', text: 'text-accent-foreground', border: 'border-accent/40' },
} as const

/** Fallback visual meta for an unknown/deleted domain slug — never throws. */
export const FALLBACK_DOMAIN_META: ToolDomainMeta = {
  icon: 'Puzzle',
  bg: 'bg-muted',
  text: 'text-muted-foreground',
  border: 'border-muted-foreground/40',
  labelKey: 'tools.domains.custom',
}


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

/** GitHub `owner/name` shape. GitHub itself allows letters, digits, `-`, `_`,
 *  and `.` in both segments. We validate at the API boundary so we can safely
 *  interpolate into a clone URL and a filesystem path. Length capped at 100
 *  per segment to match GitHub's own limit. */
export const GITHUB_REPO_REGEX = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** Conservative git branch name validator used at the API boundary so the
 *  `defaultBranch` field can be safely interpolated into `git fetch / rebase
 *  / worktree add` argv without git arg injection (e.g. `--upload-pack=…`).
 *  Stricter than git's own rules: must start with `[A-Za-z0-9_]`, then the
 *  usual ref-name char set, no `..`/`@{` substrings, capped at 128. */
export const GIT_BRANCH_REGEX = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,127}$/

/** Returns true if `name` is a safe git branch reference per the V1 policy.
 *  Wrapper around `GIT_BRANCH_REGEX` plus the substring blacklist git itself
 *  enforces — kept as a function so callers don't duplicate the post-checks. */
export function isValidGitBranch(name: string): boolean {
  if (!GIT_BRANCH_REGEX.test(name)) return false
  if (name.includes('..')) return false
  if (name.includes('@{')) return false
  if (name.endsWith('.') || name.endsWith('/') || name.endsWith('.lock')) return false
  return true
}

/** Lifecycle states of the per-project local clone. Kept as a `const` tuple
 *  so the `CloneStatus` type in `types.ts` and any runtime guard stay in
 *  sync. */
export const CLONE_STATUSES = ['none', 'cloning', 'ready', 'error'] as const

/** Tags applied to every newly created project. Editable by user/Kin afterward. */
export const DEFAULT_PROJECT_TAGS: ReadonlyArray<{ label: string; color: string }> = [
  { label: 'bug', color: '#ef4444' },
  { label: 'feature', color: '#3b82f6' },
  { label: 'chore', color: '#6b7280' },
  { label: 'doc', color: '#f59e0b' },
]

/**
 * Mandatory tool floor present in EVERY resolved toolset (main Kins and tasks)
 * regardless of toolbox selection, because the system protocol assumes them.
 * The toolbox resolver unions this with the selected toolboxes' listed tools.
 *
 * This is the single source of truth, shared between the server resolver and
 * the client (Kin tools preview). `@/server/services/tool-presets` re-exports
 * it so existing server imports keep working.
 */
export const CORE_TOOLS: readonly string[] = [
  // Filesystem (read + write paths). multi_edit is non-optional for
  // efficient single-file refactors.
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'list_directory',
  'grep',

  // Shell (with the wrapper-refusal gate already in place).
  'run_shell',

  // Sub-Kin protocol — strictly required by the runner.
  'update_task_status',
  'request_input',
  'report_to_parent',

  // Human in the loop.
  'prompt_human',
  'notify',

  // File attachments (sub-Kins often need to surface screenshots / files
  // back to the user without going through write_file + a separate channel
  // call).
  'attach_file',

  // Reasoning aid (no-op tool that logs a thought). Cheap, no side effects,
  // available to every sub-Kin regardless of preset so it can be leaned on
  // for planning before committing to concrete tool calls.
  'think',

  // Structured planning (TodoWrite-equivalent). Sub-Kins use it to lay out
  // a plan up-front on multi-step work and surface progress to the user.
  'task_todos',
]
