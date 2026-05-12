import { resolve, join, basename } from 'path'
import { readdir, readFile, access, rm, mkdir } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { eq, and, like } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { pluginStates, pluginStorage } from '@/server/db/schema'
import { encrypt, decrypt } from '@/server/services/encryption'
import { createLogger } from '@/server/logger'
import { toolRegistry } from '@/server/tools/index'
import { hookRegistry } from '@/server/hooks/index'
import { sseManager } from '@/server/sse/index'
import type { ToolRegistration } from '@/server/tools/types'
import type { HookName, HookHandler } from '@/server/hooks/types'
import type { PluginManifest, PluginConfigField, PluginSummary, PluginHealthStats, PluginProviderMeta, PluginChannelMeta, PluginInstallSource, PluginInstallMeta } from '@/shared/types/plugin'
import { satisfiesSemver } from '@/shared/semver'
import type { ProviderDefinition } from '@/server/providers/types'
import type { ChannelAdapter } from '@/server/channels/adapter'
import { registerPluginProvider, unregisterPluginProvider } from '@/server/providers/index'
import { channelAdapters } from '@/server/channels/index'
import { emitPluginCard, updatePluginCard } from '@/server/services/plugin-cards'
import type { PluginCardPrimitive } from '@/shared/types/plugin-cards'

const log = createLogger('plugins')

// ─── Types ───────────────────────────────────────────────────────────────────

interface PluginLogger {
  debug(msg: string): void
  debug(obj: Record<string, any>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, any>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, any>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, any>, msg: string): void
}

interface PluginStorageAPI {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  clear(): Promise<void>
}

interface PluginHTTPClient {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

/**
 * Card APIs exposed to plugins. The plugin name is captured at context
 * creation time so plugins cannot accidentally emit cards under another
 * plugin's identity.
 */
export interface PluginCardsAPI {
  emit(params: {
    kinId: string
    cardType: string
    layout: PluginCardPrimitive[]
    initialState: Record<string, unknown>
  }): Promise<{ messageId: string; cardInstanceId: string }>
  update(params: {
    cardInstanceId: string
    state: Record<string, unknown>
  }): Promise<void>
}

interface PluginContext {
  config: Record<string, any>
  log: PluginLogger
  storage: PluginStorageAPI
  http: PluginHTTPClient
  manifest: PluginManifest
  cards: PluginCardsAPI
}

interface PluginProviderRegistration {
  definition: ProviderDefinition
  displayName: string
  capabilities: string[]
  noApiKey?: boolean
  apiKeyUrl?: string
}

/** Payload delivered to a plugin when a user clicks an action on its card. */
export interface PluginCardActionContext {
  cardInstanceId: string
  actionId: string
  input?: string
  kinId: string
}

export type PluginCardActionResult = { ok: true } | { ok: false; error: string }

interface PluginExports {
  tools?: Record<string, ToolRegistration>
  providers?: Record<string, PluginProviderRegistration>
  channels?: Record<string, ChannelAdapter>
  hooks?: Partial<Record<HookName, HookHandler>>
  /** Handle user clicks on action-row buttons emitted by this plugin's cards. */
  onCardAction?(ctx: PluginCardActionContext): Promise<PluginCardActionResult>
  activate?(): Promise<void>
  deactivate?(): Promise<void>
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

export function validateManifest(data: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'] }
  }

  const m = data as Record<string, unknown>

  if (typeof m.name !== 'string' || !NAME_PATTERN.test(m.name)) {
    errors.push('name must match [a-z0-9-]+')
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

  // Validate kinbot version constraint syntax if present
  if (m.kinbot !== undefined) {
    if (typeof m.kinbot !== 'string') {
      errors.push('kinbot must be a semver range string (e.g. ">=0.15.0")')
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

  // Validate permissions
  if (m.permissions !== undefined) {
    if (!Array.isArray(m.permissions)) {
      errors.push('permissions must be an array of strings')
    } else {
      for (const p of m.permissions) {
        if (typeof p !== 'string') {
          errors.push('Each permission must be a string')
        }
      }
    }
  }

  // Validate optional channels metadata (permissive: shape only, no value
  // checks). See PluginManifest.channels in src/shared/types/plugin.ts.
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
          }
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
          const validAvail = ['main', 'sub-kin']
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

  // Validate providers
  if (ex.providers !== undefined) {
    if (typeof ex.providers !== 'object' || ex.providers === null || Array.isArray(ex.providers)) {
      errors.push('"providers" must be a Record<string, PluginProviderRegistration>')
    } else {
      for (const [provName, provReg] of Object.entries(ex.providers as Record<string, unknown>)) {
        if (!provReg || typeof provReg !== 'object') {
          warnings.push(`providers.${provName}: must be an object`)
          continue
        }
        const reg = provReg as Record<string, unknown>
        if (!reg.definition || typeof reg.definition !== 'object') {
          warnings.push(`providers.${provName}: missing "definition" object`)
        }
        if (typeof reg.displayName !== 'string') {
          warnings.push(`providers.${provName}: missing "displayName" string`)
        }
        if (!Array.isArray(reg.capabilities)) {
          warnings.push(`providers.${provName}: missing "capabilities" array`)
        }
      }
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
  private watcher: FSWatcher | null = null
  private reloadTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private kinbotVersion: string | null = null

  constructor() {
    this.pluginsDir = resolve(process.cwd(), 'plugins')
  }

  /** Get the current KinBot version from package.json (cached) */
  private async getKinBotVersion(): Promise<string> {
    if (this.kinbotVersion) return this.kinbotVersion
    try {
      const raw = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8')
      this.kinbotVersion = JSON.parse(raw).version ?? '0.0.0'
    } catch {
      this.kinbotVersion = '0.0.0'
    }
    return this.kinbotVersion!
  }

  /** Check if a plugin's kinbot version requirement is satisfied */
  private async checkCompatibility(manifest: PluginManifest): Promise<{ compatible: boolean; error?: string }> {
    if (!manifest.kinbot) return { compatible: true }
    const version = await this.getKinBotVersion()
    const compatible = satisfiesSemver(version, manifest.kinbot)
    if (!compatible) {
      return {
        compatible: false,
        error: `Requires KinBot ${manifest.kinbot} (current: ${version})`,
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
        log.warn({ plugin: name, error: compat.error }, 'Plugin incompatible with current KinBot version')
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

          // Plugin tools are always opt-in (defaultDisabled)
          toolRegistry.register(prefixedName, {
            ...toolReg,
            create: wrappedCreate,
            defaultDisabled: true,
          })
          plugin.registeredTools.push(prefixedName)
        }
      }

      // Register hooks
      if (exports.hooks) {
        for (const [hookName, handler] of Object.entries(exports.hooks)) {
          if (handler) {
            const wrappedHandler: HookHandler = async (ctx) => {
              try {
                const result = await handler(ctx)
                // Successful execution resets consecutive error count
                plugin.health.consecutiveErrors = 0
                return result
              } catch (err) {
                this.recordPluginError(name, err instanceof Error ? err.message : 'Hook error', `hook:${hookName}`)
                return ctx
              }
            }
            hookRegistry.register(hookName as HookName, wrappedHandler)
            plugin.registeredHooks.push({ name: hookName as HookName, handler: wrappedHandler })
          }
        }
      }

      // Register providers
      if (exports.providers) {
        for (const [providerType, reg] of Object.entries(exports.providers)) {
          const prefixedType = `plugin_${name}_${providerType}`
          try {
            registerPluginProvider(prefixedType, reg.definition, {
              capabilities: reg.capabilities as any,
              displayName: reg.displayName,
              noApiKey: reg.noApiKey,
              apiKeyUrl: reg.apiKeyUrl,
            })
            plugin.registeredProviders.push({
              type: prefixedType,
              displayName: reg.displayName,
              capabilities: reg.capabilities,
            })
          } catch (err) {
            log.warn({ plugin: name, provider: providerType, err }, 'Failed to register plugin provider')
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
      const errMessage = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Activation failed')
      const errStack = err instanceof Error ? err.stack : undefined
      const causeMessage = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined
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

    // Unregister providers
    for (const prov of plugin.registeredProviders) {
      unregisterPluginProvider(prov.type)
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

    // HTTP client with permission checking
    const allowedHosts = (manifest.permissions ?? [])
      .filter(p => p.startsWith('http:'))
      .map(p => p.slice(5))

    const http: PluginHTTPClient = {
      async fetch(url: string, init?: RequestInit): Promise<Response> {
        const parsed = new URL(url)
        const hostname = parsed.hostname

        const allowed = allowedHosts.some(pattern => {
          if (pattern.startsWith('*.')) {
            return hostname.endsWith(pattern.slice(1)) || hostname === pattern.slice(2)
          }
          return hostname === pattern
        })

        if (!allowed) {
          throw new Error(`Plugin "${manifest.name}" does not have permission to access "${hostname}". Declare "http:${hostname}" in permissions.`)
        }

        return globalThis.fetch(url, init)
      },
    }

    const cards: PluginCardsAPI = {
      emit: (params) => emitPluginCard({
        kinId: params.kinId,
        pluginId: manifest.name,
        cardType: params.cardType,
        layout: params.layout,
        initialState: params.initialState,
      }),
      update: (params) => updatePluginCard(params),
    }

    return {
      config,
      log: pluginLog as unknown as PluginLogger,
      storage,
      http,
      manifest,
      cards,
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
    const version = this.kinbotVersion ?? '0.0.0'
    return Array.from(this.plugins.values()).map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      homepage: p.manifest.homepage,
      license: p.manifest.license,
      icon: p.manifest.icon,
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
      compatible: p.manifest.kinbot ? satisfiesSemver(version, p.manifest.kinbot) : true,
      compatibilityError: p.manifest.kinbot && !satisfiesSemver(version, p.manifest.kinbot)
        ? `Requires KinBot ${p.manifest.kinbot} (current: ${version})`
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

    // Ensure plugins dir exists
    await mkdir(this.pluginsDir, { recursive: true })

    // Clone to a temp directory first
    const tempName = `_installing_${Date.now()}`
    const tempDir = join(this.pluginsDir, tempName)

    try {
      // Clone the repo
      const proc = Bun.spawn(['git', 'clone', '--depth', '1', url, tempDir], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
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
      const renameProc = Bun.spawn(['mv', tempDir, targetDir], { stdout: 'pipe', stderr: 'pipe' })
      await renameProc.exited

      // Remove .git directory to save space (keep it simple)
      // Actually keep .git for updates via git pull

      // Save install source in DB
      const now = new Date()
      const installMeta: PluginInstallMeta = {
        url,
        version: manifest.version,
        installedAt: now.toISOString(),
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

    // Use a temp directory approach: create plugin dir, init, install
    const tempName = `_npm_${Date.now()}`
    const tempDir = join(this.pluginsDir, tempName)

    try {
      await mkdir(tempDir, { recursive: true })

      // Initialize a minimal package.json and install the package
      await Bun.write(join(tempDir, 'package.json'), JSON.stringify({ name: 'kinbot-plugin-install', private: true }))

      const proc = Bun.spawn(['bun', 'add', packageName], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`npm install failed: ${stderr.trim()}`)
      }

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
      const mvProc = Bun.spawn(['mv', nodeModulesDir, targetDir], { stdout: 'pipe', stderr: 'pipe' })
      await mvProc.exited

      // Cleanup temp dir
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})

      // Save state
      const now = new Date()
      const installMeta: PluginInstallMeta = {
        package: packageName,
        version: manifest.version,
        installedAt: now.toISOString(),
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

      await this.activatePlugin(manifest.name)

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
  async installFromStore(storeName: string): Promise<{ name: string }> {
    if (storeName.includes('..') || storeName.includes('/') || storeName.includes('\\')) {
      throw new Error('Invalid store plugin name')
    }
    const storeDir = resolve(process.cwd(), 'store', storeName)

    // Verify the store plugin exists
    let raw: string
    try {
      raw = await readFile(join(storeDir, 'plugin.json'), 'utf-8')
    } catch {
      throw new Error(`Store plugin "${storeName}" not found`)
    }

    const data = JSON.parse(raw)
    const validation = validateManifest(data)
    if (!validation.valid) {
      throw new Error(`Invalid manifest: ${validation.errors.join('; ')}`)
    }

    const manifest = data as PluginManifest

    // Check version compatibility
    const compat = await this.checkCompatibility(manifest)
    if (!compat.compatible) {
      throw new Error(compat.error!)
    }

    // Check if already installed
    if (this.plugins.has(manifest.name)) {
      throw new Error(`Plugin "${manifest.name}" is already installed`)
    }

    await mkdir(this.pluginsDir, { recursive: true })
    const targetDir = join(this.pluginsDir, manifest.name)

    // Copy store plugin to plugins directory
    const cpProc = Bun.spawn(['cp', '-r', storeDir, targetDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await cpProc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(cpProc.stderr).text()
      throw new Error(`Failed to copy store plugin: ${stderr.trim()}`)
    }

    // Save install source in DB
    const now = new Date()
    const installMeta: PluginInstallMeta = {
      version: manifest.version,
      installedAt: now.toISOString(),
    }

    const existing = await this.getState(manifest.name)
    if (existing) {
      await db.update(pluginStates).set({
        enabled: true,
        installSource: 'store',
        installMeta: JSON.stringify(installMeta),
        updatedAt: now,
      }).where(eq(pluginStates.name, manifest.name))
    } else {
      await db.insert(pluginStates).values({
        name: manifest.name,
        enabled: true,
        installSource: 'store',
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
      installSource: 'store',
      installMeta,
    })

    await this.activatePlugin(manifest.name)

    sseManager.broadcast({
      type: 'plugin:installed',
      data: { name: manifest.name, source: 'store' },
    })

    log.info({ plugin: manifest.name, storeName }, 'Plugin installed from store')
    return { name: manifest.name }
  }

  /** Uninstall a plugin: deactivate, remove files, clean DB */
  async uninstallPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

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

    // Remove plugin directory
    const pluginDir = join(this.pluginsDir, name)
    await rm(pluginDir, { recursive: true, force: true })

    // Clean up DB
    await db.delete(pluginStorage).where(eq(pluginStorage.pluginName, name))
    await db.delete(pluginStates).where(eq(pluginStates.name, name))

    // Remove from memory
    this.plugins.delete(name)

    sseManager.broadcast({
      type: 'plugin:uninstalled',
      data: { name },
    })

    log.info({ plugin: name }, 'Plugin uninstalled')
  }

  /** Update a plugin (git pull or npm update) */
  async updatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) throw new Error(`Plugin "${name}" not found`)

    const source = plugin.installSource
    const pluginDir = join(this.pluginsDir, name)

    if (source === 'git') {
      // Git pull
      const proc = Bun.spawn(['git', 'pull'], {
        cwd: pluginDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`Git pull failed: ${stderr.trim()}`)
      }
    } else if (source === 'npm') {
      const packageName = plugin.installMeta?.package
      if (!packageName) throw new Error('No package name stored for npm plugin')

      // Re-install from npm (overwrite)
      const tempDir = join(this.pluginsDir, `_update_${Date.now()}`)
      await mkdir(tempDir, { recursive: true })
      await Bun.write(join(tempDir, 'package.json'), JSON.stringify({ name: 'kinbot-plugin-update', private: true }))

      const proc = Bun.spawn(['bun', 'add', packageName], { cwd: tempDir, stdout: 'pipe', stderr: 'pipe' })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => {})
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`npm update failed: ${stderr.trim()}`)
      }

      // Replace plugin dir
      await rm(pluginDir, { recursive: true, force: true })
      const mvProc = Bun.spawn(['mv', join(tempDir, 'node_modules', packageName), pluginDir], { stdout: 'pipe', stderr: 'pipe' })
      await mvProc.exited
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    } else if (source === 'store') {
      // Re-copy from store directory
      const storeDir = resolve(process.cwd(), 'store', name)
      try {
        await access(join(storeDir, 'plugin.json'))
      } catch {
        throw new Error(`Store plugin "${name}" no longer exists in store/`)
      }

      // Remove old and copy fresh
      await rm(pluginDir, { recursive: true, force: true })
      const cpProc = Bun.spawn(['cp', '-r', storeDir, pluginDir], { stdout: 'pipe', stderr: 'pipe' })
      const cpExit = await cpProc.exited
      if (cpExit !== 0) {
        const stderr = await new Response(cpProc.stderr).text()
        throw new Error(`Failed to copy store plugin: ${stderr.trim()}`)
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

    // Deactivate and re-activate
    const wasEnabled = plugin.enabled
    if (wasEnabled) {
      await this.deactivatePlugin(name)
    }

    plugin.manifest = manifest
    if (plugin.installMeta) {
      plugin.installMeta.version = manifest.version
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
        if (source === 'store') {
          const storeManifestPath = join(resolve(process.cwd(), 'store', name), 'plugin.json')
          try {
            const raw = await readFile(storeManifestPath, 'utf-8')
            const storeManifest = JSON.parse(raw) as PluginManifest
            if (storeManifest.version !== plugin.manifest.version) {
              updates.push({
                name,
                currentVersion: plugin.manifest.version,
                availableVersion: storeManifest.version,
                source,
              })
            }
          } catch {
            // Store plugin removed or unreadable, skip
          }
        } else if (source === 'git') {
          // Fetch remote refs and compare local HEAD with remote HEAD
          const pluginDir = join(this.pluginsDir, name)
          const fetchProc = Bun.spawn(['git', 'fetch'], {
            cwd: pluginDir,
            stdout: 'pipe',
            stderr: 'pipe',
          })
          await fetchProc.exited

          // Compare local and remote HEAD
          const localProc = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd: pluginDir, stdout: 'pipe', stderr: 'pipe' })
          await localProc.exited
          const localHead = (await new Response(localProc.stdout).text()).trim()

          const remoteProc = Bun.spawn(['git', 'rev-parse', '@{u}'], { cwd: pluginDir, stdout: 'pipe', stderr: 'pipe' })
          const remoteExit = await remoteProc.exited
          const remoteHead = (await new Response(remoteProc.stdout).text()).trim()

          if (remoteExit === 0 && localHead !== remoteHead) {
            // Try to read remote manifest version
            let availableVersion = 'newer commit available'
            try {
              const showProc = Bun.spawn(['git', 'show', '@{u}:plugin.json'], { cwd: pluginDir, stdout: 'pipe', stderr: 'pipe' })
              const showExit = await showProc.exited
              if (showExit === 0) {
                const remoteManifest = JSON.parse(await new Response(showProc.stdout).text())
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
              if (data.version && data.version !== plugin.manifest.version) {
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

        // Extract plugin name (first path segment)
        const pluginName = filename.split('/')[0]?.split('\\')[0]
        if (!pluginName || pluginName.startsWith('_')) return

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
