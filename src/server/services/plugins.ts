import { resolve, join, basename } from 'path'
import { readdir, readFile, access, rm, mkdir } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { eq, and, like } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { pluginStates, pluginStorage, providers, channels, vaultSecrets } from '@/server/db/schema'
import { encrypt, decrypt } from '@/server/services/encryption'
import {
  getSecretValue as vaultGetSecretValue,
  getSecretByKey as vaultGetSecretByKey,
  createSecret as vaultCreateSecret,
  updateSecretValueByKey as vaultUpdateSecretValueByKey,
  deleteSecret as vaultDeleteSecret,
  listKeysByPrefix as vaultListKeysByPrefix,
} from '@/server/services/vault'
import { createLogger } from '@/server/logger'
import { toolRegistry } from '@/server/tools/index'
import { hookRegistry } from '@/server/hooks/index'
import { sseManager } from '@/server/sse/index'
import type { HookName, HookHandler } from '@/server/hooks/types'
import type { PluginManifest, PluginConfigField, PluginSummary, PluginHealthStats, PluginProviderMeta, PluginChannelMeta, PluginInstallSource, PluginInstallMeta } from '@/shared/types/plugin'
import { satisfiesSemver, isVersionNewer } from '@/shared/semver'
import { registerLLMProvider, unregisterLLMProvider } from '@/server/llm/llm/registry'
import { registerEmbeddingProvider, unregisterEmbeddingProvider } from '@/server/llm/embedding/registry'
import { registerImageProvider, unregisterImageProvider } from '@/server/llm/image/registry'
import { registerSearchProvider, unregisterSearchProvider } from '@/server/llm/search/registry'
import { registerTTSProvider, unregisterTTSProvider } from '@/server/llm/tts/registry'
import { registerSTTProvider, unregisterSTTProvider } from '@/server/llm/stt/registry'
import { registerEmailProvider, unregisterEmailProvider } from '@/server/email/registry'
import { registerContactsProvider, unregisterContactsProvider } from '@/server/contacts/registry'
import { registerCalendarProvider, unregisterCalendarProvider } from '@/server/calendar/registry'
import { channelAdapters } from '@/server/channels/index'
import type { LLMProvider, EmbeddingProvider, ImageProvider, SearchProvider, TTSProvider, STTProvider, EmailProvider, ContactsProvider, CalendarProvider, PluginProvider, ProviderCapability, ProviderConfig } from '@gezy/sdk'
import { emitPluginCard, updatePluginCard } from '@/server/services/plugin-cards'
import { getVaultOAuthToken } from '@/server/llm/llm/_oauth-vault-access'
import type {
  PluginContext,
  PluginExports,
  PluginCardActionContext,
  PluginCardActionResult,
  PluginCardsAPI,
  PluginLogger,
  PluginStorageAPI,
  PluginHTTPClient,
  PluginVaultAPI,
  PluginOAuthAPI,
} from '@gezy/sdk'

// Re-export the plugin-facing surface so other internal modules keep their
// existing import paths. The SDK is the source of truth.
export type { PluginCardActionContext, PluginCardActionResult }

const log = createLogger('plugins')

/**
 * Returns true when `hostname` is allowed by the `permissions` array (a
 * subset of plugin.manifest.permissions). Recognized patterns:
 *
 *   - `http:*`              — any hostname (use sparingly).
 *   - `http:example.com`    — exact match.
 *   - `http:*.example.com`  — any subdomain of example.com, plus the
 *                             apex `example.com` itself.
 *
 * Anything not matching one of those forms is ignored. Used by
 * `ctx.http.fetch` and exported for unit testing.
 */
export function isHostAllowed(
  hostname: string,
  permissions: readonly string[],
): boolean {
  for (const perm of permissions) {
    if (!perm.startsWith('http:')) continue
    const pattern = perm.slice(5)
    if (pattern === '*') return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1) // ".example.com"
      const apex = pattern.slice(2)   // "example.com"
      if (hostname === apex || hostname.endsWith(suffix)) return true
      continue
    }
    if (hostname === pattern) return true
  }
  return false
}

/**
 * Thrown by `ctx.http.fetch()` when the plugin's manifest doesn't grant
 * access to the target hostname. Carries a stable `code` so callers can
 * branch on the kind of failure without sniffing message strings.
 */
export class PluginPermissionError extends Error {
  readonly code = 'PLUGIN_PERMISSION_DENIED'
  constructor(
    public readonly pluginName: string,
    public readonly hostname: string,
  ) {
    super(
      `Plugin "${pluginName}" does not have permission to access "${hostname}". ` +
        `Declare "http:${hostname}" (or "http:*.${hostname.replace(/^[^.]+\./, '')}", or "http:*") in the plugin's manifest permissions.`,
    )
    this.name = 'PluginPermissionError'
  }
}

/**
 * Detect which native provider family a plugin-exported provider implements,
 * based on the chat/embed/generate/search/speak/transcribe method it carries.
 * Returns null when the shape doesn't match any of the six native interfaces.
 */
function detectProviderFamily(
  p: PluginProvider,
): 'llm' | 'embedding' | 'image' | 'search' | 'tts' | 'stt' | 'email' | 'contacts' | 'calendar' | null {
  if (typeof (p as { chat?: unknown }).chat === 'function') return 'llm'
  if (typeof (p as { embed?: unknown }).embed === 'function') return 'embedding'
  if (typeof (p as { generate?: unknown }).generate === 'function') return 'image'
  if (typeof (p as { search?: unknown }).search === 'function') return 'search'
  if (typeof (p as { speak?: unknown }).speak === 'function') return 'tts'
  if (typeof (p as { transcribe?: unknown }).transcribe === 'function') return 'stt'
  if (
    typeof (p as { sendMessage?: unknown }).sendMessage === 'function' &&
    typeof (p as { listMessages?: unknown }).listMessages === 'function'
  )
    return 'email'
  if (
    typeof (p as { listContacts?: unknown }).listContacts === 'function' &&
    typeof (p as { getContact?: unknown }).getContact === 'function'
  )
    return 'contacts'
  if (
    typeof (p as { listEvents?: unknown }).listEvents === 'function' &&
    typeof (p as { listCalendars?: unknown }).listCalendars === 'function'
  )
    return 'calendar'
  return null
}

/**
 * Build the `ctx.vault` API for a plugin.
 *
 * Read (`getSecret`) is permissive: plugins read any vault key, since the
 * key typically arrives via their config (e.g. `authTokenVaultKey` for a
 * channel password field stored by Hivekeep core).
 *
 * Write (`setSecret`), delete, and list are strictly scoped to a
 * `plugin:<pluginName>:` namespace so plugins cannot overwrite each other's
 * secrets or those managed by Hivekeep core.
 *
 * Exported for unit testing. Production callers go through `createContext`.
 */
export function createPluginVault(pluginName: string): PluginVaultAPI {
  const prefix = `plugin:${pluginName}:`
  return {
    async getSecret(key) {
      return vaultGetSecretValue(key)
    },
    async setSecret(key, value, description) {
      const scopedKey = `${prefix}${key}`
      const existing = await vaultGetSecretByKey(scopedKey)
      if (existing) {
        await vaultUpdateSecretValueByKey(scopedKey, value)
      } else {
        await vaultCreateSecret(
          scopedKey,
          value,
          undefined,
          description ?? `Plugin "${pluginName}" secret: ${key}`,
        )
      }
    },
    async deleteSecret(key) {
      const scopedKey = `${prefix}${key}`
      const existing = await vaultGetSecretByKey(scopedKey)
      if (existing) await vaultDeleteSecret(existing.id)
    },
    async listKeys() {
      const keys = await vaultListKeysByPrefix(prefix)
      return keys.map((k) => k.slice(prefix.length))
    },
  }
}


interface LoadedPlugin {
  manifest: PluginManifest
  exports: PluginExports | null
  error?: string
  enabled: boolean
  registeredTools: string[]
  registeredHooks: Array<{ name: HookName; handler: HookHandler }>
  registeredProviders: PluginProviderMeta[]
  registeredChannels: PluginChannelMeta[]
  installSource?: PluginInstallSource
  installMeta?: PluginInstallMeta
  health: PluginHealthStats
}

// ─── Topological sort ────────────────────────────────────────────────────────

/**
 * Topological sort of plugin names by their dependency graph.
 * Returns names in activation order (dependencies first).
 * Detects cycles and returns them separately.
 */
export function topologicalSortPlugins(
  names: string[],
  getDeps: (name: string) => string[],
): { sorted: string[]; cycles: string[] } {
  const nameSet = new Set(names)
  const visited = new Set<string>()
  const visiting = new Set<string>() // in current DFS path — for cycle detection
  const sorted: string[] = []
  const cycles: string[] = []

  const visit = (name: string) => {
    if (visited.has(name)) return
    if (visiting.has(name)) {
      cycles.push(name)
      return
    }

    visiting.add(name)

    for (const depName of getDeps(name)) {
      if (nameSet.has(depName)) {
        visit(depName)
      }
    }

    visiting.delete(name)
    visited.add(name)
    sorted.push(name)
  }

  for (const name of names) {
    visit(name)
  }

  return { sorted, cycles }
}

// ─── Manifest validation ─────────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z0-9-]+$/

/**
 * Mirror of the JSON schema's `permissions.items.pattern`. Anything
 * outside this set is rejected at manifest-validation time so plugin
 * authors get immediate feedback instead of a silent runtime gate.
 */
const PERMISSION_PATTERN = /^(http:[^\s]+|storage|cards|vault|cron|agents)$/

/**
 * Allowed `type` enum on a channel adapter's config field. Matches
 * the JSON schema's ChannelConfigField.type enum exactly.
 */
const CHANNEL_FIELD_TYPES = ['text', 'password', 'number', 'select', 'switch']

export function validateManifest(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'] }
  }

  const m = data as Record<string, unknown>

  if (typeof m.name !== 'string' || !NAME_PATTERN.test(m.name)) {
    errors.push('name must match [a-z0-9-]+')
  }
  if (m.displayName !== undefined && (typeof m.displayName !== 'string' || !m.displayName.trim())) {
    errors.push('displayName must be a non-empty string when present')
  }
  if (typeof m.version !== 'string' || !m.version) {
    errors.push('version is required')
  }
  if (typeof m.description !== 'string' || !m.description) {
    errors.push('description is required')
  }
  if (typeof m.main !== 'string' || !m.main) {
    errors.push('main entry point is required')
  }

  // Validate hivekeep version constraint syntax if present
  if (m.hivekeep !== undefined) {
    if (typeof m.hivekeep !== 'string') {
      errors.push('hivekeep must be a semver range string (e.g. ">=0.15.0")')
    }
  }

  // Validate config schema if present
  if (m.config !== undefined) {
    if (typeof m.config !== 'object' || m.config === null) {
      errors.push('config must be an object')
    } else {
      const cfg = m.config as Record<string, unknown>
      for (const [key, field] of Object.entries(cfg)) {
        if (!field || typeof field !== 'object') {
          errors.push(`config.${key} must be an object`)
          continue
        }
        const f = field as Record<string, unknown>
        const validTypes = ['string', 'number', 'boolean', 'select', 'text', 'password']
        if (!validTypes.includes(f.type as string)) {
          errors.push(`config.${key}.type must be one of: ${validTypes.join(', ')}`)
        }
        if (typeof f.label !== 'string') {
          errors.push(`config.${key}.label is required`)
        }
        if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
          errors.push(`config.${key} with type "select" requires non-empty options array`)
        }
        // Validate regex pattern syntax
        if (f.type === 'string' && typeof f.pattern === 'string') {
          try {
            new RegExp(f.pattern)
          } catch {
            errors.push(`config.${key}.pattern is not a valid regular expression`)
          }
        }
      }
    }
  }

  // Validate dependencies
  if (m.dependencies !== undefined) {
    if (typeof m.dependencies !== 'object' || m.dependencies === null || Array.isArray(m.dependencies)) {
      errors.push('dependencies must be an object mapping plugin names to semver ranges')
    } else {
      const deps = m.dependencies as Record<string, unknown>
      for (const [depName, depRange] of Object.entries(deps)) {
        if (!NAME_PATTERN.test(depName)) {
          errors.push(`dependencies key "${depName}" must match [a-z0-9-]+`)
        }
        if (typeof depRange !== 'string' || !depRange) {
          errors.push(`dependencies["${depName}"] must be a non-empty semver range string`)
        }
      }
    }
  }

  // Validate permissions. The JSON schema published alongside the SDK
  // enforces the same regex — we mirror it here so the runtime catches
  // typos ("htp:foo.com" / "telemetry" / "http:" with no domain)
  // before the plugin loads. Without this, the only feedback was at
  // ctx.http.fetch time when the HTTP gate refused the URL.
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array of strings')
    } else {
      for (const p of m.permissions) {
        if (typeof p !== 'string') {
          errors.push('Each permission must be a string')
          continue
        }
        if (!PERMISSION_PATTERN.test(p)) {
          errors.push(
            `permission "${p}" is invalid — must be either an http permission ("http:<host>" or "http:*") or one of: storage, cards, vault, cron, agents`,
          )
        }
      }
    }
  }

  // Validate optional tags (string array — schema documents it, parser
  // used to ignore it).
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string')) {
      errors.push('tags must be an array of strings')
    }
  }

  // Validate channel metadata. The schema declares per-field shape
  // (name + label + type enum); the parser used to stop at "fields is
  // an array", which let malformed field entries slip past plugin load
  // and only surface when the channels UI failed to render them.
  if (m.channels !== undefined) {
    if (typeof m.channels !== 'object' || m.channels === null || Array.isArray(m.channels)) {
      errors.push('channels must be an object keyed by platform name')
    } else {
      const chans = m.channels as Record<string, unknown>
      for (const [platform, entry] of Object.entries(chans)) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`channels.${platform} must be an object`)
          continue
        }
        const e = entry as Record<string, unknown>
        if (e.configSchema !== undefined) {
          if (typeof e.configSchema !== 'object' || e.configSchema === null || Array.isArray(e.configSchema)) {
            errors.push(`channels.${platform}.configSchema must be an object`)
            continue
          }
          const cs = e.configSchema as Record<string, unknown>
          if (!Array.isArray(cs.fields)) {
            errors.push(`channels.${platform}.configSchema.fields must be an array`)
            continue
          }
          cs.fields.forEach((field, i) => {
            if (!field || typeof field !== 'object') {
              errors.push(`channels.${platform}.configSchema.fields[${i}] must be an object`)
              return
            }
            const f = field as Record<string, unknown>
            if (typeof f.name !== 'string' || !f.name) {
              errors.push(`channels.${platform}.configSchema.fields[${i}].name is required`)
            }
            if (typeof f.label !== 'string' || !f.label) {
              errors.push(`channels.${platform}.configSchema.fields[${i}].label is required`)
            }
            if (!CHANNEL_FIELD_TYPES.includes(f.type as string)) {
              errors.push(
                `channels.${platform}.configSchema.fields[${i}].type must be one of: ${CHANNEL_FIELD_TYPES.join(', ')}`,
              )
            }
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate config values against a plugin's config schema.
 * Returns validation errors (empty array = valid).
 */
export function validateConfig(
  values: Record<string, any>,
  schema: Record<string, PluginConfigField>,
): string[] {
  const errors: string[] = []

  // Check required fields
  for (const [key, field] of Object.entries(schema)) {
    const value = values[key]

    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`"${key}" is required`)
      continue
    }

    // Skip validation for absent optional fields
    if (value === undefined || value === null) continue

    // Type checks
    switch (field.type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push(`"${key}" must be a boolean`)
        }
        break

      case 'number': {
        const num = typeof value === 'string' ? Number(value) : value
        if (typeof num !== 'number' || Number.isNaN(num)) {
          errors.push(`"${key}" must be a number`)
        } else {
          if (field.min !== undefined && num < field.min) {
            errors.push(`"${key}" must be >= ${field.min}`)
          }
          if (field.max !== undefined && num > field.max) {
            errors.push(`"${key}" must be <= ${field.max}`)
          }
        }
        break
      }

      case 'select':
        if (field.options && !field.options.includes(String(value))) {
          errors.push(`"${key}" must be one of: ${field.options.join(', ')}`)
        }
        break

      case 'string':
      case 'text':
      case 'password':
        if (typeof value !== 'string') {
          errors.push(`"${key}" must be a string`)
        } else if (field.type === 'string' && field.pattern) {
          try {
            if (!new RegExp(field.pattern).test(value)) {
              errors.push(`"${key}" does not match required pattern`)
            }
          } catch {
            // Invalid regex in schema — skip pattern check
          }
        }
        break
    }
  }

  return errors
}

// ─── Valid hook names (must match HookName type) ─────────────────────────────

const VALID_HOOK_NAMES = new Set([
  'beforeChat', 'afterChat',
  'beforeToolCall', 'afterToolCall',
  'beforeCompacting', 'afterCompacting',
  'onTaskSpawn', 'onCronTrigger',
])

/**
 * Validate the exports object returned by a plugin's init function.
 * Returns warnings (non-fatal) for individual invalid entries, and errors (fatal) for structural issues.
 */
export function validatePluginExports(
  exports: unknown,
  pluginName: string,
): { valid: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  if (exports === null || exports === undefined) {
    return { valid: false, errors: ['Plugin init function returned null/undefined — must return an exports object'], warnings }
  }

  if (typeof exports !== 'object' || Array.isArray(exports)) {
    return { valid: false, errors: ['Plugin init function must return a plain object'], warnings }
  }

  const ex = exports as Record<string, unknown>

  // Validate tools
  if (ex.tools !== undefined) {
    if (typeof ex.tools !== 'object' || ex.tools === null || Array.isArray(ex.tools)) {
      errors.push('"tools" must be a Record<string, ToolRegistration>')
    } else {
      for (const [toolName, toolReg] of Object.entries(ex.tools as Record<string, unknown>)) {
        if (!toolReg || typeof toolReg !== 'object') {
          warnings.push(`tools.${toolName}: must be an object with { availability, create }`)
          continue
        }
        const reg = toolReg as Record<string, unknown>
        if (!Array.isArray(reg.availability)) {
          warnings.push(`tools.${toolName}: missing or invalid "availability" array`)
        } else {
          const validAvail = ['main', 'sub-agent']
          for (const a of reg.availability) {
            if (!validAvail.includes(a as string)) {
              warnings.push(`tools.${toolName}: unknown availability "${a}" (expected: ${validAvail.join(', ')})`)
            }
          }
        }
        if (typeof reg.create !== 'function') {
          warnings.push(`tools.${toolName}: missing "create" function`)
        }
      }
    }
  }

  // Validate hooks
  if (ex.hooks !== undefined) {
    if (typeof ex.hooks !== 'object' || ex.hooks === null || Array.isArray(ex.hooks)) {
      errors.push('"hooks" must be a Record<HookName, HookHandler>')
    } else {
      for (const [hookName, handler] of Object.entries(ex.hooks as Record<string, unknown>)) {
        if (!VALID_HOOK_NAMES.has(hookName)) {
          warnings.push(`hooks.${hookName}: unknown hook name (valid: ${[...VALID_HOOK_NAMES].join(', ')})`)
        }
        if (handler !== undefined && handler !== null && typeof handler !== 'function') {
          warnings.push(`hooks.${hookName}: handler must be a function`)
        }
      }
    }
  }

  // Validate providers — must be an array of native provider instances
  // matching one of the six SDK interfaces. The plugin loader detects
  // each provider's family at registration time by inspecting which
  // method it carries (chat / embed / generate / search / speak /
  // transcribe).
  if (ex.providers !== undefined) {
    if (!Array.isArray(ex.providers)) {
      errors.push('"providers" must be an array of LLMProvider | EmbeddingProvider | ImageProvider | SearchProvider | TTSProvider | STTProvider')
    } else {
      ex.providers.forEach((p, i) => {
        if (!p || typeof p !== 'object') {
          warnings.push(`providers[${i}]: must be an object implementing a native provider interface`)
          return
        }
        const prov = p as Record<string, unknown>
        if (typeof prov.type !== 'string' || !prov.type) {
          warnings.push(`providers[${i}]: missing "type" string`)
        }
        if (typeof prov.displayName !== 'string' || !prov.displayName) {
          warnings.push(`providers[${i}]: missing "displayName" string`)
        }
        if (typeof prov.authenticate !== 'function') {
          warnings.push(`providers[${i}] (${String(prov.type)}): missing authenticate() method`)
        }
        const hasChat = typeof prov.chat === 'function'
        const hasEmbed = typeof prov.embed === 'function'
        const hasGenerate = typeof prov.generate === 'function'
        const hasSearch = typeof prov.search === 'function'
        const hasSpeak = typeof prov.speak === 'function'
        const hasTranscribe = typeof prov.transcribe === 'function'
        const hasListVoices = typeof prov.listVoices === 'function'
        // listModels is required for the model-bearing families. Search
        // has no models (one provider == one endpoint); TTS uses
        // listVoices() instead.
        const usesListModels = !hasSearch && !hasSpeak
        if (usesListModels && typeof prov.listModels !== 'function') {
          warnings.push(`providers[${i}] (${String(prov.type)}): missing listModels() method`)
        }
        if (hasSpeak && !hasListVoices) {
          warnings.push(`providers[${i}] (${String(prov.type)}): TTSProvider must implement listVoices()`)
        }
        if (!hasChat && !hasEmbed && !hasGenerate && !hasSearch && !hasSpeak && !hasTranscribe) {
          warnings.push(
            `providers[${i}] (${String(prov.type)}): must implement one of chat() (LLM), embed() (Embedding), generate() (Image), search() (Search), speak() (TTS), or transcribe() (STT)`,
          )
        }
        if ((hasSearch || hasSpeak || hasTranscribe) && (!prov.capabilities || typeof prov.capabilities !== 'object')) {
          warnings.push(
            `providers[${i}] (${String(prov.type)}): SearchProvider / TTSProvider / STTProvider must declare a "capabilities" object (use {} for none)`,
          )
        }
      })
    }
  }

  // Validate channels
  if (ex.channels !== undefined) {
    if (typeof ex.channels !== 'object' || ex.channels === null || Array.isArray(ex.channels)) {
      errors.push('"channels" must be a Record<string, ChannelAdapter>')
    } else {
      for (const [chanName, adapter] of Object.entries(ex.channels as Record<string, unknown>)) {
        if (!adapter || typeof adapter !== 'object') {
          warnings.push(`channels.${chanName}: must be an object implementing ChannelAdapter`)
          continue
        }
        const a = adapter as Record<string, unknown>
        if (typeof a.platform !== 'string') {
          warnings.push(`channels.${chanName}: missing "platform" string`)
        }
      }
    }
  }

  // Validate lifecycle functions
  if (ex.activate !== undefined && typeof ex.activate !== 'function') {
    errors.push('"activate" must be a function or undefined')
  }
  if (ex.deactivate !== undefined && typeof ex.deactivate !== 'function') {
    errors.push('"deactivate" must be a function or undefined')
  }
  if (ex.onCardAction !== undefined && typeof ex.onCardAction !== 'function') {
    errors.push('"onCardAction" must be a function or undefined')
  }

  // Warn about unknown top-level keys
  const knownKeys = new Set(['tools', 'hooks', 'providers', 'channels', 'activate', 'deactivate', 'onCardAction'])
  for (const key of Object.keys(ex)) {
    if (!knownKeys.has(key)) {
      warnings.push(`Unknown export key "${key}" — will be ignored`)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ─── Plugin Manager ──────────────────────────────────────────────────────────

/** Max consecutive hook/tool errors before a plugin is auto-disabled */
const MAX_CONSECUTIVE_ERRORS = 10

/** Max time (ms) for a plugin's activate() or deactivate() to complete */
const LIFECYCLE_TIMEOUT_MS = 30_000

class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private pluginsDir: string
  // Workspace for install operations — temp dirs + bun cache. Lives OUTSIDE
  // `plugins/` so the internal file watcher doesn't see it as a new plugin
  // and trigger a full rescan mid-install (which deadlocks `bun add`).
  private installWorkspace: string
  private watcher: FSWatcher | null = null
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private gezyVersion: string | null = null

  constructor() {
    this.pluginsDir = resolve(process.cwd(), 'plugins')
    this.installWorkspace = resolve(process.cwd(), 'data', '.plugin-install')
  }

  /** Get the current Hivekeep version from package.json (cached) */
  private async getGezyVersion(): Promise<string> {
    if (this.gezyVersion) return this.gezyVersion
    try {
      const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8')
      this.gezyVersion = JSON.parse(raw).version ?? '0.0.0'
    } catch {
      this.gezyVersion = '0.0.0'
    }
    return this.gezyVersion!
  }

  /** Check if a plugin's hivekeep version requirement is satisfied */
  private async checkCompatibility(manifest: PluginManifest): Promise<{ compatible: boolean; error?: string }> {
    if (!manifest.hivekeep) return { compatible: true }
    const version = await this.getGezyVersion()
    const compatible = satisfiesSemver(version, manifest.hivekeep)
    if (!compatible) {
      return {
        compatible: false,
        error: `Requires Gezy ${manifest.hivekeep} (current: ${version})`,
      }
    }
    return { compatible: true }
  }

  /** Check that all declared plugin dependencies are met */
  private checkDependencies(manifest: PluginManifest): string[] {
    const deps = manifest.dependencies
    if (!deps || Object.keys(deps).length === 0) return []

    const errors: string[] = []
    for (const [depName, depRange] of Object.entries(deps)) {
      const dep = this.plugins.get(depName)
      if (!dep) {
        errors.push(`"${depName}" is not installed`)
        continue
      }
      if (!dep.enabled) {
        errors.push(`"${depName}" is installed but not enabled`)
        continue
      }
      if (!satisfiesSemver(dep.manifest.version, depRange)) {
        errors.push(`"${depName}" version ${dep.manifest.version} does not satisfy ${depRange}`)
      }
    }
    return errors
  }

  /** Get list of enabled plugins that depend on the given plugin */
  private getDependents(pluginName: string): string[] {
    const dependents: string[] = []
    for (const [name, plugin] of this.plugins) {
      if (!plugin.enabled) continue
      const deps = plugin.manifest.dependencies
      if (deps && pluginName in deps) {
        dependents.push(name)
      }
    }
    return dependents
  }

  /** Scan plugins/ directory and load all valid plugins */
  async scan(): Promise<void> {
    log.info({ dir: this.pluginsDir }, 'Scanning for plugins')

    let entries: string[] = []
    try {
      entries = await readdir(this.pluginsDir)
    } catch {
      log.info('No plugins/ directory found — skipping plugin scan')
      return
    }

    // Phase 1: Discover all plugins (without activating)
    const enabledPluginNames: string[] = []

    for (const entry of entries.sort()) {
      const pluginDir = join(this.pluginsDir, entry)
      const manifestPath = join(pluginDir, 'plugin.json')

      try {
        await access(manifestPath)
      } catch {
        continue // Not a plugin directory
      }

      try {
        const raw = await readFile(manifestPath, 'utf-8')
        const data = JSON.parse(raw)
        const validation = validateManifest(data)

        if (!validation.valid) {
          log.warn({ plugin: entry, errors: validation.errors }, 'Invalid plugin manifest')
          this.plugins.set(entry, {
            manifest: data as PluginManifest,
            exports: null,
            error: `Invalid manifest: ${validation.errors.join('; ')}`,
            enabled: false,
            registeredTools: [],
            registeredHooks: [],
            registeredProviders: [],
            registeredChannels: [],
            health: { totalErrors: 0, consecutiveErrors: 0, autoDisabled: false },
          })
          continue
        }

        const manifest = data as PluginManifest

        if (manifest.name !== entry) {
          log.warn({ folder: entry, name: manifest.name }, 'Plugin folder name does not match manifest name')
        }

        const state = await this.getState(manifest.name)

        this.plugins.set(manifest.name, {
          manifest,
          exports: null,
          enabled: state?.enabled ?? false,
          registeredTools: [],
          registeredHooks: [],
          registeredProviders: [],
          registeredChannels: [],
          health: { totalErrors: 0, consecutiveErrors: 0, autoDisabled: false },
          installSource: (state?.installSource as PluginInstallSource) ?? 'local',
          installMeta: state?.installMeta ? JSON.parse(state.installMeta) : undefined,
        })

        log.info({ plugin: manifest.name, version: manifest.version, enabled: state?.enabled ?? false }, 'Plugin discovered')

        if (state?.enabled) {
          enabledPluginNames.push(manifest.name)
        }
      } catch (err) {
        log.error({ plugin: entry, err }, 'Failed to load plugin')
        this.plugins.set(entry, {
          manifest: { name: entry, version: '0.0.0', description: 'Failed to load', main: '' } as PluginManifest,
          exports: null,
          error: err instanceof Error ? err.message : 'Unknown error',
          enabled: false,
          registeredTools: [],
          registeredHooks: [],
          registeredProviders: [],
          registeredChannels: [],
          health: { totalErrors: 0, consecutiveErrors: 0, autoDisabled: false },
        })
      }
    }

    // Phase 2: Activate enabled plugins in dependency order (topological sort)
    const { sorted, cycles } = topologicalSortPlugins(enabledPluginNames, (name) => {
      const plugin = this.plugins.get(name)
      const deps = plugin?.manifest.dependencies
      return deps ? Object.keys(deps) : []
    })

    for (const cycleName of cycles) {
      const plugin = this.plugins.get(cycleName)
      if (plugin) {
        plugin.error = 'Circular dependency detected'
        plugin.enabled = false
        log.error({ plugin: cycleName }, 'Plugin has circular dependencies, skipping activation')
      }
    }

    for (const name of sorted) {
      if (cycles.includes(name)) continue
      await this.activatePlugin(name)
    }

    log.info({ total: this.plugins.size, enabled: Array.from(this.plugins.values()).filter(p => p.enabled).length }, 'Plugin scan complete')
  }

  /** Activate a plugin: load entry point, register tools/hooks */
  private async activatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

    const pluginDir = join(this.pluginsDir, name)
    const entryPath = join(pluginDir, plugin.manifest.main)

    try {
      // Check version compatibility
      const compat = await this.checkCompatibility(plugin.manifest)
      if (!compat.compatible) {
        plugin.error = compat.error
        plugin.enabled = false
        log.warn({ plugin: name, error: compat.error }, 'Plugin incompatible with current Hivekeep version')
        return
      }

      // Check plugin dependencies
      const depErrors = this.checkDependencies(plugin.manifest)
      if (depErrors.length > 0) {
        plugin.error = `Missing dependencies: ${depErrors.join('; ')}`
        plugin.enabled = false
        log.warn({ plugin: name, errors: depErrors }, 'Plugin dependency check failed')
        return
      }

      // Build context
      const config = await this.getResolvedConfig(name)
      const ctx = this.createContext(plugin.manifest, config)

      // Load entry point (append cache-busting query to force re-import on hot-reload)
      const mod = await import(`${entryPath}?t=${Date.now()}`)
      const initFn = mod.default || mod
      if (typeof initFn !== 'function') {
        throw new Error(`Plugin "${name}" main file must default-export a function`)
      }

      const result = initFn(ctx)
      // Support both sync and async init functions
      const exports: PluginExports = result instanceof Promise ? await result : result

      // Validate exports structure before registration
      const validation = validatePluginExports(exports, name)
      if (!validation.valid) {
        throw new Error(`Invalid plugin exports: ${validation.errors.join('; ')}`)
      }
      for (const warning of validation.warnings) {
        log.warn({ plugin: name }, `Plugin export warning: ${warning}`)
      }

      plugin.exports = exports

      // Register tools
      if (exports.tools) {
        for (const [toolName, toolReg] of Object.entries(exports.tools)) {
          const prefixedName = `plugin_${name}_${toolName}`

          // Check for collision with core tools
          const existingTools = toolRegistry.list().map(t => t.name)
          if (existingTools.includes(prefixedName)) {
            log.warn({ plugin: name, tool: toolName }, 'Plugin tool name conflicts — skipping')
            continue
          }

          // Wrap the tool factory to track errors in the plugin health system
          const originalCreate = toolReg.create
          const wrappedCreate: typeof originalCreate = (ctx) => {
            const aiTool = originalCreate(ctx)
            if (aiTool.execute) {
              const originalExecute = aiTool.execute
              aiTool.execute = async (...args: any[]) => {
                try {
                  const result = await (originalExecute as any)(...args)
                  // Successful execution resets consecutive error count
                  plugin.health.consecutiveErrors = 0
                  return result
                } catch (err) {
                  this.recordPluginError(name, err instanceof Error ? err.message : 'Tool execution error', `tool:${toolName}`)
                  throw err // Re-throw so the AI SDK reports the error normally
                }
              }
            }
            return aiTool
          }

          // Plugin tools are always opt-in (defaultDisabled). Domain is
          // 'plugins' but in practice the bucket builder routes them
          // through the plugin-tools section regardless — the domain is a
          // safety net for code that hits the registry directly.
          toolRegistry.register(prefixedName, {
            ...toolReg,
            create: wrappedCreate,
            defaultDisabled: true,
          }, 'plugins')
          plugin.registeredTools.push(prefixedName)
        }
      }

      // Register hooks. The iteration loses the per-hook discriminant, so we
      // erase the handler's payload type and cast at the registry boundary —
      // the registry stores handlers in a discriminant-agnostic map anyway.
      if (exports.hooks) {
        for (const [hookName, handler] of Object.entries(exports.hooks)) {
          if (handler) {
            const wrappedHandler = async (ctx: unknown): Promise<unknown> => {
              try {
                const result = await (handler as (c: unknown) => unknown)(ctx)
                // Successful execution resets consecutive error count
                plugin.health.consecutiveErrors = 0
                return result
              } catch (err) {
                this.recordPluginError(name, err instanceof Error ? err.message : 'Hook error', `hook:${hookName}`)
                return ctx
              }
            }
            hookRegistry.register(
              hookName as HookName,
              wrappedHandler as unknown as HookHandler<HookName>,
            )
            plugin.registeredHooks.push({
              name: hookName as HookName,
              handler: wrappedHandler as unknown as HookHandler<HookName>,
            })
          }
        }
      }

      // Register providers. Each entry is a native LLMProvider /
      // EmbeddingProvider / ImageProvider — the same interfaces the
      // built-in providers implement. The loader detects the family by
      // inspecting which method the provider exposes and routes to the
      // matching native registry. The provider's `type` field is prefixed
      // with `plugin:<plugin-name>:` to avoid colliding with built-ins or
      // other plugins.
      if (exports.providers) {
        for (const rawProvider of exports.providers) {
          const family = detectProviderFamily(rawProvider)
          if (!family) {
            log.warn(
              { plugin: name, type: rawProvider.type },
              'Plugin provider does not implement chat/embed/generate — skipping',
            )
            continue
          }
          const prefixedType = `plugin:${name}:${rawProvider.type}`
          // Wrap the provider so its `type` reflects the prefixed name
          // Hivekeep uses internally, without mutating the plugin's instance.
          const wrapped = new Proxy(rawProvider, {
            get(target, prop) {
              if (prop === 'type') return prefixedType
              return Reflect.get(target, prop)
            },
          }) as PluginProvider
          try {
            if (family === 'llm') registerLLMProvider(wrapped as LLMProvider)
            else if (family === 'embedding') registerEmbeddingProvider(wrapped as EmbeddingProvider)
            else if (family === 'image') registerImageProvider(wrapped as ImageProvider)
            else if (family === 'search') registerSearchProvider(wrapped as SearchProvider)
            else if (family === 'tts') registerTTSProvider(wrapped as TTSProvider)
            else if (family === 'stt') registerSTTProvider(wrapped as STTProvider)
            else if (family === 'email') registerEmailProvider(wrapped as EmailProvider)
            else if (family === 'contacts') registerContactsProvider(wrapped as ContactsProvider)
            else if (family === 'calendar') registerCalendarProvider(wrapped as CalendarProvider)
            plugin.registeredProviders.push({
              type: prefixedType,
              displayName: rawProvider.displayName,
              capabilities: [family satisfies ProviderCapability],
            })
          } catch (err) {
            log.warn({ plugin: name, type: rawProvider.type, family, err }, 'Failed to register plugin provider')
          }
        }
      }

      // Register channels. If the manifest declares
      // `channels.<platform>.configSchema` for this adapter and the adapter
      // doesn't already expose one, attach the manifest schema so that
      // `channelAdapters.listWithMeta()` and the route-level Zod validator
      // pick it up. Manifest-level declarations are encouraged for plugins
      // because they remain discoverable without executing plugin code.
      if (exports.channels) {
        for (const [channelName, adapter] of Object.entries(exports.channels)) {
          try {
            const manifestEntry = plugin.manifest.channels?.[adapter.platform]
            if (manifestEntry?.configSchema && !adapter.configSchema) {
              ;(adapter as { configSchema?: typeof manifestEntry.configSchema }).configSchema = manifestEntry.configSchema
            }
            // Enrich the adapter's `meta` from the plugin manifest so
            // the channels picker / cards show the plugin's brand
            // assets without the adapter author having to repeat them.
            // Adapter-level values still win when present — this is
            // pure default-fill.
            const manifestLogoUrl = plugin.manifest.iconUrl
              ? `/api/plugins/${encodeURIComponent(name)}/logo`
              : undefined
            const enrichedMeta = {
              displayName: adapter.meta?.displayName ?? plugin.manifest.displayName ?? channelName,
              ...(adapter.meta?.brandColor ? { brandColor: adapter.meta.brandColor } : {}),
              ...(adapter.meta?.iconUrl
                ? { iconUrl: adapter.meta.iconUrl }
                : manifestLogoUrl
                  ? { iconUrl: manifestLogoUrl }
                  : {}),
            }
            ;(adapter as { meta?: typeof enrichedMeta }).meta = enrichedMeta
            channelAdapters.registerPlugin(adapter)
            plugin.registeredChannels.push({
              platform: adapter.platform,
              displayName: channelName,
            })
          } catch (err) {
            log.warn({ plugin: name, channel: channelName, err }, 'Failed to register plugin channel')
          }
        }
      }

      // Call activate (with timeout to prevent hanging)
      if (exports.activate) {
        await Promise.race([
          exports.activate(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Plugin "${name}" activate() timed out after ${LIFECYCLE_TIMEOUT_MS / 1000}s`)), LIFECYCLE_TIMEOUT_MS)
          ),
        ])
      }

      plugin.enabled = true
      plugin.error = undefined
      log.info({
        plugin: name,
        tools: plugin.registeredTools.length,
        hooks: plugin.registeredHooks.length,
        providers: plugin.registeredProviders.length,
        channels: plugin.registeredChannels.length,
      }, 'Plugin activated')
    } catch (err) {
      // Extract structured error info to avoid pino circular-reference issues
      // when err carries SDK objects (AbortController, sockets, etc.) on its stack.
      //
      // Real-world throws aren't always `Error` instances — Bun's failed
      // dynamic imports, `Promise.reject(undefined)`, plugin code that
      // does `throw { code: 'BAD' }`, etc. all bypass the Error path. The
      // final fallback used to be the literal string "Activation failed"
      // which gave the user nothing to debug from. Now we serialize the
      // value with type info so something useful always reaches the log
      // AND the UI's plugin.error field.
      let errMessage: string
      let errStack: string | undefined
      let causeMessage: string | undefined

      if (err instanceof Error) {
        errMessage = err.message || `${err.name} (empty message)`
        errStack = err.stack
        if (err.cause instanceof Error) causeMessage = err.cause.message
      } else if (typeof err === 'string') {
        errMessage = err || 'Activation threw an empty string'
      } else if (err === undefined) {
        errMessage = 'Activation threw undefined (likely a missing module or a Promise rejected without a reason)'
      } else if (err === null) {
        errMessage = 'Activation threw null'
      } else {
        // Last-resort: serialise the value. Bun.inspect gives the cleanest
        // output for objects with toJSON, getters, or circular refs.
        let serialised: string
        try {
          serialised = Bun.inspect(err, { depth: 2 })
        } catch {
          try { serialised = JSON.stringify(err) } catch { serialised = String(err) }
        }
        errMessage = `Activation threw a non-Error value (${typeof err}): ${serialised}`
      }

      plugin.error = errMessage
      plugin.enabled = false
      log.error({ plugin: name, errMessage, errStack, causeMessage }, 'Plugin activation failed')

      // Clean up any partial registrations (tools/hooks/providers/channels
      // that were registered before the error occurred)
      await this.deactivatePlugin(name)
    }
  }

  /** Deactivate a plugin: unregister tools/hooks, call deactivate */
  private async deactivatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) return

    // Call deactivate (with timeout to prevent hanging)
    if (plugin.exports?.deactivate) {
      try {
        await Promise.race([
          plugin.exports.deactivate(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Plugin "${name}" deactivate() timed out after ${LIFECYCLE_TIMEOUT_MS / 1000}s`)), LIFECYCLE_TIMEOUT_MS)
          ),
        ])
      } catch (err) {
        log.error({ plugin: name, err }, 'Plugin deactivate() error')
      }
    }

    // Unregister hooks
    for (const { name: hookName, handler } of plugin.registeredHooks) {
      hookRegistry.unregister(hookName, handler)
    }
    plugin.registeredHooks = []

    // Unregister tools
    for (const toolName of plugin.registeredTools) {
      toolRegistry.unregister(toolName)
    }
    plugin.registeredTools = []

    // Unregister providers. We track the family in the meta so we know
    // which native registry to hit. (Built-in providers are never tracked
    // here — only plugin-contributed ones.)
    for (const prov of plugin.registeredProviders) {
      const family = prov.capabilities[0]
      if (family === 'llm') unregisterLLMProvider(prov.type)
      else if (family === 'embedding') unregisterEmbeddingProvider(prov.type)
      else if (family === 'image') unregisterImageProvider(prov.type)
      else if (family === 'search') unregisterSearchProvider(prov.type)
      else if (family === 'tts') unregisterTTSProvider(prov.type)
      else if (family === 'stt') unregisterSTTProvider(prov.type)
      else if (family === 'email') unregisterEmailProvider(prov.type)
      else if (family === 'contacts') unregisterContactsProvider(prov.type)
      else if (family === 'calendar') unregisterCalendarProvider(prov.type)
    }
    plugin.registeredProviders = []

    // Unregister channels
    for (const ch of plugin.registeredChannels) {
      channelAdapters.unregisterPlugin(ch.platform)
    }
    plugin.registeredChannels = []

    plugin.exports = null
    plugin.enabled = false
    log.info({ plugin: name }, 'Plugin deactivated')
  }

  /** Create a PluginContext for a plugin */
  private createContext(manifest: PluginManifest, config: Record<string, any>): PluginContext {
    const pluginLog = createLogger(`plugin:${manifest.name}`)

    const storage: PluginStorageAPI = {
      async get<T = unknown>(key: string): Promise<T | null> {
        const row = await db
          .select()
          .from(pluginStorage)
          .where(and(eq(pluginStorage.pluginName, manifest.name), eq(pluginStorage.key, key)))
          .get()
        if (!row) return null
        return JSON.parse(row.value) as T
      },
      async set<T = unknown>(key: string, value: T): Promise<void> {
        const now = new Date()
        const jsonValue = JSON.stringify(value)
        const existing = await db
          .select()
          .from(pluginStorage)
          .where(and(eq(pluginStorage.pluginName, manifest.name), eq(pluginStorage.key, key)))
          .get()
        if (existing) {
          await db
            .update(pluginStorage)
            .set({ value: jsonValue, updatedAt: now })
            .where(eq(pluginStorage.id, existing.id))
        } else {
          await db.insert(pluginStorage).values({
            pluginName: manifest.name,
            key,
            value: jsonValue,
            updatedAt: now,
          })
        }
      },
      async delete(key: string): Promise<void> {
        await db
          .delete(pluginStorage)
          .where(and(eq(pluginStorage.pluginName, manifest.name), eq(pluginStorage.key, key)))
      },
      async list(prefix?: string): Promise<string[]> {
        const rows = prefix
          ? await db.select({ key: pluginStorage.key }).from(pluginStorage)
              .where(and(eq(pluginStorage.pluginName, manifest.name), like(pluginStorage.key, `${prefix}%`)))
              .all()
          : await db.select({ key: pluginStorage.key }).from(pluginStorage)
              .where(eq(pluginStorage.pluginName, manifest.name))
              .all()
        return rows.map(r => r.key)
      },
      async clear(): Promise<void> {
        await db.delete(pluginStorage).where(eq(pluginStorage.pluginName, manifest.name))
      },
    }

    // HTTP client with permission enforcement. The plugin can reach a
    // hostname only when its manifest declares the matching `http:<host>`
    // permission. Raw `fetch()` from inside the plugin is not blocked here
    // (we can't sandbox the runtime), so `ctx.http.fetch` is opt-in
    // hardening for plugins that want their network footprint declared
    // and audited.
    const permissions = manifest.permissions ?? []
    const http: PluginHTTPClient = {
      async fetch(url: string, init?: RequestInit): Promise<Response> {
        const parsed = new URL(url)
        if (!isHostAllowed(parsed.hostname, permissions)) {
          throw new PluginPermissionError(manifest.name, parsed.hostname)
        }
        return globalThis.fetch(url, init)
      },
    }

    const cards: PluginCardsAPI = {
      emit: (params) => emitPluginCard({
        agentId: params.agentId,
        pluginId: manifest.name,
        cardType: params.cardType,
        layout: params.layout,
        initialState: params.initialState,
      }),
      update: (params) => updatePluginCard(params),
    }

    const vault: PluginVaultAPI = createPluginVault(manifest.name)

    // OAuth helper, scoped to THIS plugin's own providers. The reserved
    // `__providerType` in the runtime config must be in the plugin's namespace
    // (`plugin:<name>:…`) — otherwise a plugin could read another provider's
    // (or a built-in's) vault tokens.
    const oauth: PluginOAuthAPI = {
      getAccessToken: async (cfg) => {
        const type = (cfg as Record<string, unknown>)?.['__providerType']
        if (typeof type !== 'string' || !type.startsWith(`plugin:${manifest.name}:`)) {
          return null
        }
        return getVaultOAuthToken(cfg as ProviderConfig)
      },
    }

    return {
      config,
      log: pluginLog as unknown as PluginLogger,
      storage,
      http,
      vault,
      manifest,
      cards,
      oauth,
    }
  }

  // ─── State management ──────────────────────────────────────────────────────

  /** Record an error for a plugin and auto-disable if threshold exceeded */
  private recordPluginError(name: string, message: string, source: string): void {
    const plugin = this.plugins.get(name)
    if (!plugin) return

    plugin.health.totalErrors++
    plugin.health.consecutiveErrors++
    plugin.health.lastError = `[${source}] ${message}`
    plugin.health.lastErrorAt = new Date().toISOString()

    log.error({ plugin: name, source, error: message, consecutive: plugin.health.consecutiveErrors }, 'Plugin error')

    // Circuit breaker: auto-disable after too many consecutive errors
    if (plugin.health.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && plugin.enabled) {
      plugin.health.autoDisabled = true
      plugin.health.autoDisabledAt = new Date().toISOString()
      log.warn({ plugin: name, errors: plugin.health.consecutiveErrors }, 'Plugin auto-disabled due to repeated errors')

      // Disable async (don't await in error handler)
      this.disablePlugin(name).catch(err => {
        log.error({ plugin: name, err }, 'Failed to auto-disable plugin')
      })

      sseManager.broadcast({
        type: 'plugin:autoDisabled',
        data: { name, reason: `${plugin.health.consecutiveErrors} consecutive errors`, lastError: message },
      })
    }
  }

  /** Reset health stats for a plugin (e.g. after manual re-enable) */
  resetPluginHealth(name: string): void {
    const plugin = this.plugins.get(name)
    if (!plugin) return
    plugin.health = { totalErrors: 0, consecutiveErrors: 0, autoDisabled: false }
  }

  private async getState(name: string) {
    return db.select().from(pluginStates).where(eq(pluginStates.name, name)).get()
  }

  private async setState(name: string, enabled: boolean): Promise<void> {
    const now = new Date()
    const existing = await this.getState(name)
    if (existing) {
      await db.update(pluginStates).set({ enabled, updatedAt: now }).where(eq(pluginStates.name, name))
    } else {
      await db.insert(pluginStates).values({ name, enabled, createdAt: now, updatedAt: now })
    }
  }

  // ─── Config management ─────────────────────────────────────────────────────

  async getResolvedConfig(name: string): Promise<Record<string, any>> {
    const plugin = this.plugins.get(name)
    if (!plugin) return {}

    const state = await this.getState(name)
    if (!state?.configEncrypted) {
      // Return defaults
      const defaults: Record<string, any> = {}
      if (plugin.manifest.config) {
        for (const [key, field] of Object.entries(plugin.manifest.config)) {
          if (field.default !== undefined) {
            defaults[key] = field.default
          }
        }
      }
      return defaults
    }

    try {
      const decrypted = await decrypt(state.configEncrypted)
      return JSON.parse(decrypted)
    } catch {
      return {}
    }
  }

  /** Get config for API (secrets masked) */
  async getConfigForAPI(name: string): Promise<Record<string, any>> {
    const config = await this.getResolvedConfig(name)
    const plugin = this.plugins.get(name)
    if (!plugin?.manifest.config) return config

    const masked = { ...config }
    for (const [key, field] of Object.entries(plugin.manifest.config)) {
      if (field.secret && masked[key]) {
        masked[key] = '••••••••'
      }
    }
    return masked
  }

  async setConfig(name: string, config: Record<string, any>): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

    // Merge with existing config (preserve secrets that are masked)
    const existing = await this.getResolvedConfig(name)
    const merged = { ...existing }
    const schemaKeys = plugin.manifest.config ? new Set(Object.keys(plugin.manifest.config)) : new Set<string>()

    for (const [key, value] of Object.entries(config)) {
      // Don't overwrite secrets with the mask value
      if (value === '••••••••' && plugin.manifest.config?.[key]?.secret) {
        continue
      }
      merged[key] = value
    }

    // Strip keys not in the config schema to prevent stale data accumulation
    if (plugin.manifest.config) {
      for (const key of Object.keys(merged)) {
        if (!schemaKeys.has(key)) {
          log.debug({ plugin: name, key }, 'Stripping unknown config key')
          delete merged[key]
        }
      }

      const errors = validateConfig(merged, plugin.manifest.config)
      if (errors.length > 0) {
        throw new Error(`Invalid config: ${errors.join('; ')}`)
      }
    }

    const encrypted = await encrypt(JSON.stringify(merged))
    const now = new Date()
    const state = await this.getState(name)

    if (state) {
      await db.update(pluginStates).set({ configEncrypted: encrypted, updatedAt: now }).where(eq(pluginStates.name, name))
    } else {
      await db.insert(pluginStates).values({ name, enabled: false, configEncrypted: encrypted, createdAt: now, updatedAt: now })
    }

    // If plugin is enabled, re-activate with new config
    if (plugin.enabled) {
      await this.deactivatePlugin(name)
      await this.activatePlugin(name)
    }

    sseManager.broadcast({
      type: 'plugin:configUpdated',
      data: { name },
    })
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async enablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

    // Reset health stats on manual enable (fresh start after auto-disable)
    this.resetPluginHealth(name)

    await this.setState(name, true)
    await this.activatePlugin(name)

    sseManager.broadcast({
      type: 'plugin:enabled',
      data: { name, version: plugin.manifest.version },
    })
  }

  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

    // Prevent disabling if other enabled plugins depend on this one
    const dependents = this.getDependents(name)
    if (dependents.length > 0) {
      throw new Error(`Cannot disable "${name}": required by ${dependents.join(', ')}`)
    }

    await this.setState(name, false)
    await this.deactivatePlugin(name)

    sseManager.broadcast({
      type: 'plugin:disabled',
      data: { name },
    })
  }

  /** List all discovered plugins as summaries */
  listPlugins(): PluginSummary[] {
    const version = this.gezyVersion ?? '0.0.0'
    return Array.from(this.plugins.values()).map(p => ({
      name: p.manifest.name,
      displayName: p.manifest.displayName,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      homepage: p.manifest.homepage,
      license: p.manifest.license,
      icon: p.manifest.icon,
      logoUrl: p.manifest.iconUrl ? `/api/plugins/${encodeURIComponent(p.manifest.name)}/logo` : undefined,
      repositoryUrl: p.installMeta?.repository,
      npmUrl: p.installSource === 'npm' && p.installMeta?.package
        ? `https://www.npmjs.com/package/${encodeURIComponent(p.installMeta.package)}`
        : undefined,
      permissions: p.manifest.permissions ?? [],
      enabled: p.enabled,
      error: p.error,
      toolCount: p.registeredTools.length,
      hookCount: p.registeredHooks.length,
      providerCount: p.registeredProviders.length,
      channelCount: p.registeredChannels.length,
      providers: p.registeredProviders,
      channels: p.registeredChannels,
      configSchema: p.manifest.config ?? {},
      dependencies: p.manifest.dependencies ?? {},
      dependents: this.getDependents(p.manifest.name),
      installSource: p.installSource,
      installMeta: p.installMeta,
      compatible: p.manifest.hivekeep ? satisfiesSemver(version, p.manifest.hivekeep) : true,
      compatibilityError: p.manifest.hivekeep && !satisfiesSemver(version, p.manifest.hivekeep)
        ? `Requires Gezy ${p.manifest.hivekeep} (current: ${version})`
        : undefined,
      health: { ...p.health },
    }))
  }

  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name)
  }

  /** Get tool names provided by a specific plugin */
  getPluginToolNames(name: string): string[] {
    return this.plugins.get(name)?.registeredTools ?? []
  }

  /** Get all plugin tool names (for UI) */
  getAllPluginToolNames(): string[] {
    return Array.from(this.plugins.values()).flatMap(p => p.registeredTools)
  }

  /**
   * Tools registered by each loaded plugin, grouped by plugin name. Returns
   * one entry per plugin that currently has at least one registered tool.
   * Used by the Agent Tools route to render plugin tools as their own UI
   * groups (the bucket builder splits plugin tools off from native ones
   * regardless of their registry domain).
   *
   * The grouping is sourced from `LoadedPlugin.registeredTools` directly,
   * so plugin names containing hyphens and tool names containing
   * underscores both round-trip safely; we never parse them back from the
   * concatenated `plugin_<name>_<tool>` identifier.
   */
  listToolsByPlugin(): Array<{
    pluginName: string
    displayName?: string
    logoUrl?: string
    icon?: string
    toolNames: string[]
  }> {
    const groups: Array<{
      pluginName: string
      displayName?: string
      logoUrl?: string
      icon?: string
      toolNames: string[]
    }> = []
    for (const [name, plugin] of this.plugins) {
      if (plugin.registeredTools.length === 0) continue
      groups.push({
        pluginName: name,
        ...(plugin.manifest.displayName ? { displayName: plugin.manifest.displayName } : {}),
        ...(plugin.manifest.iconUrl ? { logoUrl: `/api/plugins/${encodeURIComponent(name)}/logo` } : {}),
        ...(plugin.manifest.icon ? { icon: plugin.manifest.icon } : {}),
        toolNames: [...plugin.registeredTools],
      })
    }
    return groups
  }

  /** Reload all plugins (rescan) */
  async reload(): Promise<void> {
    // Deactivate all
    for (const [name, plugin] of this.plugins) {
      if (plugin.enabled) {
        await this.deactivatePlugin(name)
      }
    }
    this.plugins.clear()
    await this.scan()
  }

  // ─── Install / Uninstall / Update ────────────────────────────────────────

  /**
   * Convert an npm-style or git-style repository URL into something a
   * browser anchor can open. npm accepts `git+https://`, `git://`,
   * `git@host:owner/repo.git`, etc. — none of which are valid `href` values.
   */
  private normalizeRepositoryUrl(url: string): string {
    let r = url.trim()
    if (r.startsWith('git+')) r = r.slice(4)
    if (r.startsWith('git://')) r = 'https://' + r.slice(6)
    const ssh = r.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (ssh) r = `https://${ssh[1]}/${ssh[2]}`
    if (r.endsWith('.git')) r = r.slice(0, -4)
    return r
  }

  /**
   * Read `package.json.repository` from an installed package and return
   * a normalized HTTP(S) URL ready for an anchor. Returns undefined if
   * the file is missing or the field is absent/unparseable.
   */
  private async readPackageRepository(pluginDir: string): Promise<string | undefined> {
    try {
      const raw = await readFile(join(pluginDir, 'package.json'), 'utf-8')
      const pkg = JSON.parse(raw) as { repository?: string | { url?: string } }
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      if (!repo) return undefined
      return this.normalizeRepositoryUrl(repo)
    } catch {
      return undefined
    }
  }

  // Always drain stdout+stderr in parallel: piping without reading can deadlock the
  // child once the kernel pipe buffer (~64KB) fills.
  //
  // Optional timeoutMs guards against silent hangs (e.g. lock contention on
  // `~/.bun/install/cache` when our parent process is itself a bun runtime
  // that holds a shared lock on the cache). Without a ceiling the handler
  // sits on `proc.exited` indefinitely and the UI spinner spins forever.
  private async runSpawn(
    cmd: string[],
    opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : undefined,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      })
    } catch (err) {
      // Bun.spawn throws synchronously when the executable isn't in PATH.
      // Wrap with an actionable message — the raw 'Executable not found
      // in $PATH' is correct but doesn't tell the user where to install
      // the missing binary, which matters most for `npm` (Docker users
      // need to rebuild the image after the npm-in-Dockerfile fix; bare-
      // metal self-hosters need Node.js installed).
      const message = err instanceof Error ? err.message : String(err)
      const bin = cmd[0]
      if (/Executable not found/i.test(message) || /ENOENT/i.test(message)) {
        if (bin === 'npm') {
          throw new Error(
            `Plugin installation requires \`npm\` to be available in PATH, but it isn't on this host. ` +
              `Install Node.js (which ships npm) or, for Docker deployments, rebuild from the latest image — ` +
              `the production Dockerfile now bundles npm specifically for plugin installs.`,
          )
        }
        if (bin === 'git') {
          throw new Error(
            `Plugin installation from a git URL requires \`git\` to be available in PATH, but it isn't on this host. Install git and retry.`,
          )
        }
        throw new Error(`Required executable not found in PATH: "${bin}". Install it and retry.`)
      }
      throw err
    }

    let timedOut = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    if (opts.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        try { proc.kill() } catch {}
      }, opts.timeoutMs)
    }

    // proc.stdout/stderr are typed as a union (number | ReadableStream)
    // because the union we narrowed away earlier no longer participates
    // in the return overload — at runtime they're always ReadableStreams
    // since we passed `stdout: 'pipe', stderr: 'pipe'`.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ])
    const exitCode = await proc.exited
    if (timeoutHandle) clearTimeout(timeoutHandle)

    if (timedOut) {
      throw new Error(
        `Command timed out after ${opts.timeoutMs}ms: ${cmd.join(' ')}` +
          (stderr.trim() ? ` — stderr: ${stderr.trim()}` : ''),
      )
    }
    return { exitCode, stdout, stderr }
  }

  /** Install a plugin from a git URL */
  async installFromGit(url: string): Promise<{ name: string }> {
    // Validate URL protocol (prevent SSRF via file://, ssh://, etc.)
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new Error('Invalid git URL')
    }
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTPS and HTTP git URLs are allowed')
    }

    // Ensure plugins dir + install workspace exist
    await mkdir(this.pluginsDir, { recursive: true })
    await mkdir(this.installWorkspace, { recursive: true })

    // Clone into install workspace (outside plugins/ to bypass the internal
    // file watcher) then mv into plugins/<name> once validated.
    const tempName = `_installing_${Date.now()}`
    const tempDir = join(this.installWorkspace, tempName)

    try {
      // Clone the repo
      const { exitCode, stderr } = await this.runSpawn(['git', 'clone', '--depth', '1', url, tempDir])
      if (exitCode !== 0) {
        throw new Error(`Git clone failed: ${stderr.trim()}`)
      }

      // Read and validate manifest
      const manifestPath = join(tempDir, 'plugin.json')
      let raw: string
      try {
        raw = await readFile(manifestPath, 'utf-8')
      } catch {
        throw new Error('No plugin.json found in repository')
      }

      const data = JSON.parse(raw)
      const validation = validateManifest(data)
      if (!validation.valid) {
        throw new Error(`Invalid manifest: ${validation.errors.join('; ')}`)
      }

      const manifest = data as PluginManifest
      const targetDir = join(this.pluginsDir, manifest.name)

      // Check version compatibility
      const compat = await this.checkCompatibility(manifest)
      if (!compat.compatible) {
        throw new Error(compat.error!)
      }

      // Check if already installed
      if (this.plugins.has(manifest.name)) {
        throw new Error(`Plugin "${manifest.name}" is already installed`)
      }

      // Rename temp dir to plugin name
      await this.runSpawn(['mv', tempDir, targetDir])

      // Remove .git directory to save space (keep it simple)
      // Actually keep .git for updates via git pull

      // Save install source in DB
      const now = new Date()
      const installMeta: PluginInstallMeta = {
        url,
        version: manifest.version,
        installedAt: now.toISOString(),
        // The install URL is the source repo — normalize so the UI can
        // link directly to it without further parsing.
        repository: this.normalizeRepositoryUrl(url),
      }

      const existing = await this.getState(manifest.name)
      if (existing) {
        await db.update(pluginStates).set({
          enabled: true,
          installSource: 'git',
          installMeta: JSON.stringify(installMeta),
          updatedAt: now,
        }).where(eq(pluginStates.name, manifest.name))
      } else {
        await db.insert(pluginStates).values({
          name: manifest.name,
          enabled: true,
          installSource: 'git',
          installMeta: JSON.stringify(installMeta),
          createdAt: now,
          updatedAt: now,
        })
      }

      // Register and activate
      this.plugins.set(manifest.name, {
        manifest,
        exports: null,
        enabled: false,
        registeredTools: [],
        registeredHooks: [],
        registeredProviders: [],
        registeredChannels: [],
            health: { totalErrors: 0, consecutiveErrors: 0, autoDisabled: false },
        installSource: 'git',
        installMeta,
      })

      await this.activatePlugin(manifest.name)

      // Broadcast SSE
      sseManager.broadcast({
        type: 'plugin:installed',
        data: { name: manifest.name, source: 'git', url },
      })

      log.info({ plugin: manifest.name, url }, 'Plugin installed from git')
      return { name: manifest.name }
    } catch (err) {
      // Cleanup temp dir on failure
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /** Install a plugin from an npm package */
  async installFromNpm(packageName: string): Promise<{ name: string }> {
    log.info({ package: packageName }, 'npm install: start')

    // Validate package name (prevent path traversal and command injection)
    if (packageName.includes('..') || packageName.includes('/') && !packageName.startsWith('@')) {
      throw new Error('Invalid npm package name')
    }
    // Scoped packages: @scope/name - validate both parts
    if (packageName.startsWith('@')) {
      const parts = packageName.split('/')
      if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].includes('..')) {
        throw new Error('Invalid scoped npm package name')
      }
    }

    await mkdir(this.pluginsDir, { recursive: true })
    await mkdir(this.installWorkspace, { recursive: true })

    // Workspace and cache live OUTSIDE plugins/ so they don't trigger the
    // PluginManager's internal file watcher (which would kick off a full
    // rescan mid-install and deadlock `bun add`).
    const tempName = `_npm_${Date.now()}`
    const tempDir = join(this.installWorkspace, tempName)

    try {
      await mkdir(tempDir, { recursive: true })

      // Initialize a minimal package.json and install the package
      await Bun.write(join(tempDir, 'package.json'), JSON.stringify({ name: 'gezy-plugin-install', private: true }))

      log.info({ package: packageName, tempDir }, 'npm install: running npm install (90s timeout)')

      // We use `npm install` rather than `bun add` here even though the
      // host runtime is bun. When `bun add` is spawned from a bun parent
      // process via Bun.spawn() it hangs indefinitely on "Resolving
      // dependencies" — the two bun processes contend on internal state
      // that can't be isolated via BUN_INSTALL_CACHE_DIR. Manual `bun
      // add` in a fresh shell works fine, so the issue is specific to
      // the parent/child bun pair. npm has no such relationship with bun,
      // installs reliably from this context.
      //
      // `--loglevel error` (not `--silent`) so npm still prints its
      // actual error text on failure; `--silent` swallowed everything
      // including ENOSPC / EACCES / peer-dep errors and left users
      // staring at '(no output)' with no way to diagnose.
      const { exitCode, stderr, stdout } = await this.runSpawn(
        ['npm', 'install', packageName, '--no-audit', '--no-fund', '--loglevel', 'error'],
        {
          cwd: tempDir,
          timeoutMs: 90_000,
        },
      )
      if (exitCode !== 0) {
        throw new Error(`npm install failed (exit ${exitCode}): ${stderr.trim() || stdout.trim() || '(no output — try `npm install ' + packageName + '` manually to see the real error)'}`)
      }
      log.info({ package: packageName }, 'npm install: bun add done')

      // Find the installed package's plugin.json
      const nodeModulesDir = join(tempDir, 'node_modules', packageName)
      const manifestPath = join(nodeModulesDir, 'plugin.json')
      let raw: string
      try {
        raw = await readFile(manifestPath, 'utf-8')
      } catch {
        throw new Error(`Package "${packageName}" does not contain a plugin.json`)
      }

      const data = JSON.parse(raw)
      const validation = validateManifest(data)
      if (!validation.valid) {
        throw new Error(`Invalid manifest: ${validation.errors.join('; ')}`)
      }

      const manifest = data as PluginManifest
      log.info({ plugin: manifest.name, version: manifest.version }, 'npm install: manifest validated')

      // Sanity check: package.json.version is the version the npm registry
      // resolves; plugin.json.version is what Hivekeep displays. If the
      // plugin author forgot to bump plugin.json alongside package.json,
      // checkUpdates() will keep offering an "update" that doesn't change
      // anything visible. Surface a clear log so the author can fix it.
      try {
        const pkgRaw = await readFile(join(nodeModulesDir, 'package.json'), 'utf-8')
        const pkgVersion = (JSON.parse(pkgRaw) as { version?: string }).version
        if (pkgVersion && pkgVersion !== manifest.version) {
          log.warn(
            { plugin: manifest.name, packageJsonVersion: pkgVersion, pluginJsonVersion: manifest.version },
            'Plugin package.json and plugin.json have mismatched versions — bump both together to keep update detection accurate',
          )
        }
      } catch {
        // package.json missing or malformed — not fatal for Hivekeep
      }

      // Check version compatibility
      const compat = await this.checkCompatibility(manifest)
      if (!compat.compatible) {
        throw new Error(compat.error!)
      }

      if (this.plugins.has(manifest.name)) {
        throw new Error(`Plugin "${manifest.name}" is already installed`)
      }

      // Move the package contents to plugins/<name>
      const targetDir = join(this.pluginsDir, manifest.name)
      await this.runSpawn(['mv', nodeModulesDir, targetDir], { timeoutMs: 10_000 })
      log.info({ plugin: manifest.name, targetDir }, 'npm install: mv to plugins/ done')

      // Cleanup temp dir
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})

      // Save state — captures the package's repository URL so the UI
      // can link to the source without re-fetching the npm registry.
      const now = new Date()
      const installMeta: PluginInstallMeta = {
        package: packageName,
        version: manifest.version,
        installedAt: now.toISOString(),
        ...(await this.readPackageRepository(targetDir).then((r) => r ? { repository: r } : {})),
      }

      await db.insert(pluginStates).values({
        name: manifest.name,
        enabled: true,
        installSource: 'npm',
        installMeta: JSON.stringify(installMeta),
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: pluginStates.name,
        set: { enabled: true, installSource: 'npm', installMeta: JSON.stringify(installMeta), updatedAt: now },
      })

      this.plugins.set(manifest.name, {
        manifest,
        exports: null,
        enabled: false,
        registeredTools: [],
        registeredHooks: [],
        registeredProviders: [],
        registeredChannels: [],
            health: { totalErrors: 0, consecutiveErrors: 0, autoDisabled: false },
        installSource: 'npm',
        installMeta,
      })
      log.info({ plugin: manifest.name }, 'npm install: db + state updated, activating')

      await this.activatePlugin(manifest.name)
      log.info({ plugin: manifest.name }, 'npm install: activation done')

      sseManager.broadcast({
        type: 'plugin:installed',
        data: { name: manifest.name, source: 'npm', package: packageName },
      })

      log.info({ plugin: manifest.name, package: packageName }, 'Plugin installed from npm')
      return { name: manifest.name }
    } catch (err) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /** Install a plugin from the in-repo store/ directory */
  /**
   * Delete every DB row that lives under the plugin's namespace
   * (`plugin:<name>:`). Run as part of uninstall so config (provider
   * API keys, channel tokens, vault secrets the plugin stashed)
   * doesn't survive a reinstall and re-appear.
   *
   * Returns a breakdown so callers can log / report what was purged.
   * pluginStorage is intentionally NOT included here — uninstallPlugin
   * already deletes it via pluginName equality, no namespace trick
   * needed.
   */
  private async purgePluginNamespacedRows(name: string): Promise<{
    providers: number
    channels: number
    vaultSecrets: number
  }> {
    const pattern = `plugin:${name}:%`
    const provRows = await db.delete(providers).where(like(providers.type, pattern)).returning({ id: providers.id })
    const chanRows = await db.delete(channels).where(like(channels.platform, pattern)).returning({ id: channels.id })
    const vaultRows = await db.delete(vaultSecrets).where(like(vaultSecrets.key, pattern)).returning({ id: vaultSecrets.id })
    return {
      providers: provRows.length,
      channels: chanRows.length,
      vaultSecrets: vaultRows.length,
    }
  }

  /** Uninstall a plugin: deactivate, remove files, clean DB */
  async uninstallPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    const pluginDir = join(this.pluginsDir, name)

    // Orphan recovery: not in memory, but maybe an orphan row/dir is lying around.
    // Reclaim it instead of returning "not found" — the user has no other path back.
    if (!plugin) {
      const state = await this.getState(name)
      let dirExists = false
      try {
        await access(pluginDir)
        dirExists = true
      } catch {}

      if (!state && !dirExists) {
        throw new Error(`Plugin "${name}" not found`)
      }

      if (state) {
        await db.delete(pluginStorage).where(eq(pluginStorage.pluginName, name))
        await db.delete(pluginStates).where(eq(pluginStates.name, name))
      }
      const purged = await this.purgePluginNamespacedRows(name)

      sseManager.broadcast({ type: 'plugin:uninstalled', data: { name } })
      log.info({ plugin: name, recovery: true, purged }, 'Plugin uninstalled (orphan recovery)')

      // Filesystem cleanup delayed (same reason as the regular path).
      if (dirExists) {
        setTimeout(() => {
          rm(pluginDir, { recursive: true, force: true }).catch((err) => {
            log.warn({ plugin: name, err }, 'Plugin directory cleanup failed (non-fatal)')
          })
        }, 2000)
      }
      return
    }

    // Prevent uninstall if other plugins depend on this one
    const dependents = this.getDependents(name)
    if (dependents.length > 0) {
      throw new Error(`Cannot uninstall "${name}": required by ${dependents.join(', ')}`)
    }

    const source = plugin.installSource ?? 'local'
    if (source === 'local') {
      throw new Error('Cannot uninstall a local plugin — remove its folder manually')
    }

    // Deactivate if active
    if (plugin.enabled) {
      await this.deactivatePlugin(name)
    }

    // Clean DB + memory BEFORE removing the plugin directory. `bun --watch`
    // tracks dynamic-imported plugin modules; deleting their source file
    // triggers a server reload that would kill an in-flight request before
    // the response is flushed and before the DB delete commits.
    await db.delete(pluginStorage).where(eq(pluginStorage.pluginName, name))
    await db.delete(pluginStates).where(eq(pluginStates.name, name))
    const purged = await this.purgePluginNamespacedRows(name)
    this.plugins.delete(name)

    sseManager.broadcast({
      type: 'plugin:uninstalled',
      data: { name },
    })

    log.info({ plugin: name, purged }, 'Plugin uninstalled')

    // Filesystem cleanup last — and delayed so the watch-induced reload
    // (if any) happens after the client's follow-up refresh request has
    // already been served. `bun --watch` tracks dynamic-imported plugin
    // modules; deleting their source file triggers a full server reload
    // that would otherwise kill the immediate follow-up `/plugins`-listing
    // request the UI fires after the toast (manifests as a 500 + empty list
    // until the user manually refreshes). 2s covers the worst-case round-trip.
    setTimeout(() => {
      rm(pluginDir, { recursive: true, force: true }).catch((err) => {
        log.warn({ plugin: name, err }, 'Plugin directory cleanup failed (non-fatal)')
      })
    }, 2000)
  }

  /** Update a plugin (git pull or npm update) */
  async updatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

    const source = plugin.installSource
    const pluginDir = join(this.pluginsDir, name)

    if (source === 'git') {
      const { exitCode, stderr } = await this.runSpawn(['git', 'pull'], { cwd: pluginDir })
      if (exitCode !== 0) {
        throw new Error(`Git pull failed: ${stderr.trim()}`)
      }
    } else if (source === 'npm') {
      const packageName = plugin.installMeta?.package
      if (!packageName) throw new Error('No package name stored for npm plugin')

      log.info({ plugin: name, package: packageName }, 'npm update: start')

      // Re-install from npm (overwrite) — workspace outside plugins/
      await mkdir(this.installWorkspace, { recursive: true })
      const tempDir = join(this.installWorkspace, `_update_${Date.now()}`)
      await mkdir(tempDir, { recursive: true })
      // Try/finally guarantees the tempDir is removed even if bun add
      // times out — without it the workspace accumulates `_update_*`
      // shells forever.
      try {
        await Bun.write(join(tempDir, 'package.json'), JSON.stringify({ name: 'gezy-plugin-update', private: true }))

        // Same `npm install` (rather than `bun add`) trick as installFromNpm —
        // see the comment there for why we can't spawn bun from a bun parent.
        // `--loglevel error` instead of `--silent` so npm's failure text
        // actually surfaces in the thrown message; `--silent` left users
        // looking at '(no output)' with nothing to debug from.
        const { exitCode, stderr, stdout } = await this.runSpawn(
          ['npm', 'install', `${packageName}@latest`, '--no-audit', '--no-fund', '--loglevel', 'error'],
          {
            cwd: tempDir,
            timeoutMs: 90_000,
          },
        )
        if (exitCode !== 0) {
          throw new Error(`npm update failed (exit ${exitCode}): ${stderr.trim() || stdout.trim() || '(no output — try `npm install ' + packageName + '@latest` manually to see the real error)'}`)
        }
        log.info({ plugin: name }, 'npm update: npm install done')

        // Replace plugin dir
        await rm(pluginDir, { recursive: true, force: true })
        await this.runSpawn(['mv', join(tempDir, 'node_modules', packageName), pluginDir], { timeoutMs: 10_000 })
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
      }
    } else {
      throw new Error('Cannot update a local plugin')
    }

    // Re-read manifest
    const raw = await readFile(join(pluginDir, 'plugin.json'), 'utf-8')
    const data = JSON.parse(raw)
    const validation = validateManifest(data)
    if (!validation.valid) {
      throw new Error(`Updated manifest is invalid: ${validation.errors.join('; ')}`)
    }

    const manifest = data as PluginManifest

    // Same version-mismatch check as installFromNpm — if the author bumped
    // package.json but forgot plugin.json, the UI keeps offering an update
    // that doesn't change anything visible.
    try {
      const pkgRaw = await readFile(join(pluginDir, 'package.json'), 'utf-8')
      const pkgVersion = (JSON.parse(pkgRaw) as { version?: string }).version
      if (pkgVersion && pkgVersion !== manifest.version) {
        log.warn(
          { plugin: name, packageJsonVersion: pkgVersion, pluginJsonVersion: manifest.version },
          'Plugin package.json and plugin.json have mismatched versions — bump both together to keep update detection accurate',
        )
      }
    } catch {
      // package.json missing or malformed
    }

    // Deactivate and re-activate
    const wasEnabled = plugin.enabled
    if (wasEnabled) {
      await this.deactivatePlugin(name)
    }

    plugin.manifest = manifest
    if (plugin.installMeta) {
      plugin.installMeta.version = manifest.version
      // Re-read repository URL in case the plugin author switched repos
      // between versions (rare but cheap to keep in sync).
      const repo = await this.readPackageRepository(pluginDir)
      if (repo) plugin.installMeta.repository = repo
    }

    // Update DB
    const now = new Date()
    await db.update(pluginStates).set({
      installMeta: JSON.stringify(plugin.installMeta),
      updatedAt: now,
    }).where(eq(pluginStates.name, name))

    // Re-activate if was enabled before the update
    if (wasEnabled) {
      await this.activatePlugin(name)
      await this.setState(name, true)
    }

    sseManager.broadcast({
      type: 'plugin:updated',
      data: { name, version: manifest.version },
    })

    log.info({ plugin: name, version: manifest.version }, 'Plugin updated')
  }

  // ─── Update Checks ─────────────────────────────────────────────────────────

  /** Check which installed plugins have updates available */
  async checkUpdates(): Promise<Array<{ name: string; currentVersion: string; availableVersion: string; source: PluginInstallSource }>> {
    const updates: Array<{ name: string; currentVersion: string; availableVersion: string; source: PluginInstallSource }> = []

    for (const [name, plugin] of this.plugins) {
      const source = plugin.installSource
      if (!source || source === 'local') continue

      try {
        if (source === 'git') {
          // Fetch remote refs and compare local HEAD with remote HEAD
          const pluginDir = join(this.pluginsDir, name)
          await this.runSpawn(['git', 'fetch'], { cwd: pluginDir })

          // Compare local and remote HEAD
          const { stdout: localOut } = await this.runSpawn(['git', 'rev-parse', 'HEAD'], { cwd: pluginDir })
          const localHead = localOut.trim()

          const { exitCode: remoteExit, stdout: remoteOut } = await this.runSpawn(['git', 'rev-parse', '@{u}'], { cwd: pluginDir })
          const remoteHead = remoteOut.trim()

          if (remoteExit === 0 && localHead !== remoteHead) {
            // Try to read remote manifest version
            let availableVersion = 'newer commit available'
            try {
              const { exitCode: showExit, stdout: showOut } = await this.runSpawn(['git', 'show', '@{u}:plugin.json'], { cwd: pluginDir })
              if (showExit === 0) {
                const remoteManifest = JSON.parse(showOut)
                if (remoteManifest.version && remoteManifest.version !== plugin.manifest.version) {
                  availableVersion = remoteManifest.version
                }
              }
            } catch {
              // Keep generic message
            }

            updates.push({
              name,
              currentVersion: plugin.manifest.version,
              availableVersion,
              source,
            })
          }
        } else if (source === 'npm') {
          // Check npm registry for newer version
          const packageName = plugin.installMeta?.package
          if (!packageName) continue

          try {
            const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
              signal: AbortSignal.timeout(5000),
            })
            if (res.ok) {
              const data = await res.json() as { version?: string }
              // Only flag an update when npm's `latest` is STRICTLY
              // NEWER than what's installed. `!==` would also trigger
              // when the registry's CDN cache is briefly behind a
              // fresh publish — making the just-updated UI flash
              // "Update available" until the cache catches up.
              if (data.version && isVersionNewer(data.version, plugin.manifest.version)) {
                updates.push({
                  name,
                  currentVersion: plugin.manifest.version,
                  availableVersion: data.version,
                  source,
                })
              }
            }
          } catch {
            // Registry unreachable, skip
          }
        }
      } catch {
        // Skip plugins that fail update check
      }
    }

    return updates
  }

  // ─── Hot Reload (File Watcher) ───────────────────────────────────────────

  /** Start watching the plugins directory for changes */
  startWatching(): void {
    if (this.watcher) return

    try {
      this.watcher = watch(this.pluginsDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return

        // Extract plugin name (first path segment). Skip leading `_` (install
        // tempdirs) and `.` (hidden caches / workspace residue) — neither
        // should ever trigger a hot-reload.
        const pluginName = filename.split('/')[0]?.split('\\')[0]
        if (!pluginName || pluginName.startsWith('_') || pluginName.startsWith('.')) return

        // Debounce: wait 500ms after last change
        const existing = this.reloadTimers.get(pluginName)
        if (existing) clearTimeout(existing)

        this.reloadTimers.set(pluginName, setTimeout(async () => {
          this.reloadTimers.delete(pluginName)
          await this.hotReloadPlugin(pluginName)
        }, 500))
      })

      log.info('Plugin file watcher started')
    } catch {
      log.warn('Could not start plugin file watcher (plugins/ dir may not exist)')
    }
  }

  /** Stop watching */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    for (const timer of this.reloadTimers.values()) {
      clearTimeout(timer)
    }
    this.reloadTimers.clear()
  }

  /** Hot-reload a single plugin */
  private async hotReloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) {
      // New plugin added? Rescan
      log.info({ plugin: name }, 'New plugin detected, rescanning')
      await this.reload()
      return
    }

    if (!plugin.enabled) return // Don't reload disabled plugins

    log.info({ plugin: name }, 'Hot-reloading plugin')

    try {
      // Re-read manifest
      const manifestPath = join(this.pluginsDir, name, 'plugin.json')
      const raw = await readFile(manifestPath, 'utf-8')
      const data = JSON.parse(raw)
      const validation = validateManifest(data)
      if (!validation.valid) {
        log.warn({ plugin: name, errors: validation.errors }, 'Hot-reload skipped: invalid manifest')
        return
      }

      // Deactivate and re-activate
      await this.deactivatePlugin(name)
      plugin.manifest = data as PluginManifest
      await this.activatePlugin(name)

      sseManager.broadcast({
        type: 'plugin:reloaded',
        data: { name, version: plugin.manifest.version },
      })

      log.info({ plugin: name }, 'Plugin hot-reloaded')
    } catch (err) {
      log.error({ plugin: name, err }, 'Hot-reload failed')
    }
  }
}

export const pluginManager = new PluginManager()
