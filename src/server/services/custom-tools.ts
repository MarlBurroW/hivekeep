/**
 * Global custom tools.
 *
 * A custom tool is a platform-wide, user/Agent-authored script (any language,
 * with its own dependencies) exposed to Agents as a first-class tool named
 * `custom_<slug>`. Access is scoped by TOOLBOXES (a toolbox lists the tool by
 * name) exactly like MCP tools — there is no per-Agent ownership.
 *
 * Storage model
 * -------------
 *   DB (`custom_tools`)  : metadata only (slug, name, description, JSON-Schema
 *                          params, entrypoint, language, domain, timeout, …).
 *   Disk (`<baseDir>/<slug>/`) : the entrypoint + any extra files + installed
 *                          dependencies (venv / node_modules). This is why the
 *                          executable lives on disk, not in the DB: a script
 *                          can `pip install` / `bun install` real deps.
 *
 * Resolution follows the MCP pattern: `resolveCustomTools()` returns a
 * `Record<custom_<slug>, Tool>` for ENABLED tools, merged into the universe by
 * services/toolset-resolver.ts and intersected with the toolbox allow-list.
 * Custom tools are NOT registered in the in-memory toolRegistry.
 *
 * Runtime binding contract (see executeCustomTool):
 *   - interpreter: explicit `language` → shebang → file extension → bun.
 *   - args: a single JSON object on stdin (+ `CUSTOM_TOOL_ARGS` env, back-compat).
 *   - cwd: the tool's managed dir (relative imports / venv / node_modules resolve).
 *   - result: stdout (JSON-parsed when possible, else trimmed text); stderr →
 *     `error`; non-zero exit → success=false.
 *   - timeout: clamped; on timeout the whole process tree is killed.
 *   - output: capped to protect the context window.
 */

import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { resolve, relative, dirname, join } from 'node:path'
import { mkdir, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { customTools } from '@/server/db/schema'
import { config } from '@/server/config'
import { tool as aiTool } from '@/server/tools/tool-helper'
import { augmentedPath, killProcessTree } from '@/server/lib/process'
import { z } from 'zod'
import type { Tool } from '@/server/tools/tool-helper'
import type { CustomTool, CustomToolTranslations } from '@/shared/types'
import { subprocessEnv } from '@/server/services/subprocess-env'

const log = createLogger('custom-tools')

/** Slug → tool name `custom_<slug>`. Lowercase identifier (no hyphens, so the
 *  resulting tool name stays a valid identifier). Immutable after creation. */
const SLUG_RE = /^[a-z][a-z0-9_]*$/

export type CustomToolRow = typeof customTools.$inferSelect

// ─── Path helpers ──────────────────────────────────────────────────────────────

/** Absolute managed directory for a tool's files. */
export function toolDir(slug: string): string {
  return resolve(config.customTools.baseDir, slug)
}

/** Validate + resolve a relative path within a tool's managed dir (no traversal). */
export function validateToolPath(slug: string, relPath: string): string {
  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    throw new Error('Path must be relative')
  }
  const dir = toolDir(slug)
  const resolved = resolve(dir, relPath)
  const rel = relative(dir, resolved)
  if (rel.startsWith('..') || resolve(resolved) !== resolved) {
    throw new Error('Path traversal detected — file must stay within the tool directory')
  }
  return resolved
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

interface CreateCustomToolParams {
  slug: string
  name: string
  description: string
  parameters: string // JSON Schema as string
  entrypoint: string
  language?: string | null
  domainSlug?: string | null
  timeoutMs?: number | null
  createdBy?: 'user' | 'agent'
  /** UI-only localized overrides (object or JSON string). Stored as JSON text. */
  translations?: CustomToolTranslations | string | null
}

/** Normalize a translations input (object | JSON string | null) to a stored JSON
 *  string, or null when empty. Validates it parses to an object. */
function normalizeTranslations(input: CustomToolTranslations | string | null | undefined): string | null {
  if (input == null) return null
  let obj: unknown
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null
    try {
      obj = JSON.parse(trimmed)
    } catch {
      throw new Error('Translations must be valid JSON')
    }
  } else {
    obj = input
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('Translations must be a JSON object keyed by locale')
  }
  if (Object.keys(obj as Record<string, unknown>).length === 0) return null
  return JSON.stringify(obj)
}

/** Parse the stored translations JSON into a typed object (null on absent/invalid). */
export function parseTranslations(raw: string | null | undefined): CustomToolTranslations | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
      return obj as CustomToolTranslations
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function createCustomTool(params: CreateCustomToolParams): Promise<CustomToolRow> {
  const slug = params.slug.trim()
  if (!SLUG_RE.test(slug)) {
    throw new Error('Slug must match ^[a-z][a-z0-9_]*$ (lowercase, digits, underscore)')
  }
  const existing = getCustomTool(slug)
  if (existing) throw new Error(`A custom tool with slug "${slug}" already exists`)

  validateJsonSchema(params.parameters)
  const translations = normalizeTranslations(params.translations)
  // Validate the entrypoint path stays within the (yet to be created) tool dir.
  validateToolPath(slug, params.entrypoint)

  await mkdir(toolDir(slug), { recursive: true })

  const id = uuid()
  const now = new Date()
  db.insert(customTools)
    .values({
      id,
      slug,
      name: params.name,
      description: params.description,
      parameters: params.parameters,
      entrypoint: params.entrypoint,
      translations,
      language: params.language ?? null,
      domainSlug: params.domainSlug ?? 'custom',
      timeoutMs: params.timeoutMs ?? null,
      enabled: true,
      createdBy: params.createdBy ?? 'user',
      createdAt: now,
      updatedAt: now,
    })
    .run()

  log.info({ slug, createdBy: params.createdBy ?? 'user' }, 'Custom tool created')
  const created = getCustomTool(slug)
  if (!created) throw new Error('Custom tool creation failed: not found after insert')
  return created
}

interface UpdateCustomToolParams {
  name?: string
  description?: string
  parameters?: string
  entrypoint?: string
  language?: string | null
  domainSlug?: string
  timeoutMs?: number | null
  enabled?: boolean
  /** UI-only localized overrides (object or JSON string; null clears them). */
  translations?: CustomToolTranslations | string | null
}

export function updateCustomTool(slug: string, patch: UpdateCustomToolParams): CustomToolRow {
  const existing = getCustomTool(slug)
  if (!existing) throw new Error('CUSTOM_TOOL_NOT_FOUND')

  const set: Partial<typeof customTools.$inferInsert> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.description !== undefined) set.description = patch.description
  if (patch.parameters !== undefined) {
    validateJsonSchema(patch.parameters)
    set.parameters = patch.parameters
  }
  if (patch.entrypoint !== undefined) {
    validateToolPath(slug, patch.entrypoint)
    set.entrypoint = patch.entrypoint
  }
  if (patch.language !== undefined) set.language = patch.language
  if (patch.domainSlug !== undefined) set.domainSlug = patch.domainSlug
  if (patch.timeoutMs !== undefined) set.timeoutMs = patch.timeoutMs
  if (patch.enabled !== undefined) set.enabled = patch.enabled
  if (patch.translations !== undefined) set.translations = normalizeTranslations(patch.translations)

  db.update(customTools).set(set).where(eq(customTools.slug, slug)).run()
  const updated = getCustomTool(slug)
  if (!updated) throw new Error('CUSTOM_TOOL_NOT_FOUND')
  return updated
}

export async function deleteCustomTool(slug: string): Promise<boolean> {
  const existing = getCustomTool(slug)
  if (!existing) return false
  db.delete(customTools).where(eq(customTools.slug, slug)).run()
  // Remove the managed dir (best-effort).
  try {
    await rm(toolDir(slug), { recursive: true, force: true })
  } catch (err) {
    log.warn({ slug, err }, 'Failed to remove custom tool dir')
  }
  log.info({ slug }, 'Custom tool deleted')
  return true
}

export function getCustomTool(slug: string): CustomToolRow | undefined {
  return db.select().from(customTools).where(eq(customTools.slug, slug)).get()
}

/** All custom tools (global — no agentId). */
export function listCustomTools(): CustomToolRow[] {
  return db.select().from(customTools).all()
}

// ─── UI display (localized; NEVER fed to the LLM) ──────────────────────────────

/** Resolved per-parameter UI label/description. */
export interface CustomToolParamDisplay {
  label?: string
  description?: string
}

/** Localized display metadata for a custom tool. Used ONLY for UI rendering
 *  (chat tool-call names, catalog labels, settings list). The base
 *  `name`/`description` and the raw JSON-Schema `parameters` remain the source
 *  of truth for the LLM tool definition. */
export interface CustomToolDisplay {
  name: string
  description: string
  parameters: Record<string, CustomToolParamDisplay>
}

/**
 * Merge translations[locale] over the base name/description + JSON-Schema param
 * descriptions. Falls back to the base values for any field the locale omits.
 * `locale` is best-effort: an unknown locale yields the base display.
 */
export function resolveCustomToolDisplay(tool: CustomToolRow, locale?: string | null): CustomToolDisplay {
  const tr = parseTranslations(tool.translations)
  const loc = locale ? tr?.[locale] : undefined

  // Base param descriptions come from the JSON Schema property `description`.
  const params: Record<string, CustomToolParamDisplay> = {}
  try {
    const schema = JSON.parse(tool.parameters) as { properties?: Record<string, { description?: string }> }
    if (schema && typeof schema === 'object' && schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        params[key] = {
          label: undefined,
          description: typeof prop?.description === 'string' ? prop.description : undefined,
        }
      }
    }
  } catch {
    /* malformed schema → no base params */
  }

  // Overlay localized param label/description.
  if (loc?.parameters) {
    for (const [key, ov] of Object.entries(loc.parameters)) {
      const cur = params[key] ?? {}
      params[key] = {
        label: ov.label ?? cur.label,
        description: ov.description ?? cur.description,
      }
    }
  }

  return {
    name: loc?.name?.trim() || tool.name,
    description: loc?.description?.trim() || tool.description,
    parameters: params,
  }
}

/**
 * Map of `custom_<slug>` → localized display name for the given locale. Includes
 * every custom tool (enabled or not) so the UI can label any tool-call it has
 * seen. Falls back to the base name when no translation exists for the locale.
 */
export function buildCustomToolNameMap(locale?: string | null): Record<string, string> {
  const map: Record<string, string> = {}
  for (const t of listCustomTools()) {
    map[`custom_${t.slug}`] = resolveCustomToolDisplay(t, locale).name
  }
  return map
}

/** Serialize a DB row into the client-facing CustomTool shape (parsing the
 *  translations JSON). Use this anywhere a row is returned to the UI/API. */
export function toCustomToolDTO(row: CustomToolRow): CustomTool {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    parameters: row.parameters,
    entrypoint: row.entrypoint,
    language: row.language,
    domainSlug: row.domainSlug,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    createdBy: row.createdBy,
    translations: parseTranslations(row.translations),
  }
}

// ─── File authoring (managed dir) ───────────────────────────────────────────────

/** Write a file into the tool's managed dir (creates parent dirs). */
export async function writeCustomToolFile(slug: string, relPath: string, content: string): Promise<void> {
  if (!getCustomTool(slug)) throw new Error('CUSTOM_TOOL_NOT_FOUND')
  const abs = validateToolPath(slug, relPath)
  await mkdir(dirname(abs), { recursive: true })
  await Bun.write(abs, content)
}

export async function readCustomToolFile(slug: string, relPath: string): Promise<string> {
  if (!getCustomTool(slug)) throw new Error('CUSTOM_TOOL_NOT_FOUND')
  const abs = validateToolPath(slug, relPath)
  return Bun.file(abs).text()
}

export async function deleteCustomToolFile(slug: string, relPath: string): Promise<void> {
  if (!getCustomTool(slug)) throw new Error('CUSTOM_TOOL_NOT_FOUND')
  const abs = validateToolPath(slug, relPath)
  await rm(abs, { force: true })
}

/** List files (recursively) under a tool's managed dir, relative paths. */
export async function listCustomToolFiles(slug: string): Promise<string[]> {
  if (!getCustomTool(slug)) throw new Error('CUSTOM_TOOL_NOT_FOUND')
  const dir = toolDir(slug)
  if (!existsSync(dir)) return []
  const out: string[] = []
  async function walk(abs: string): Promise<void> {
    const entries = await readdir(abs, { withFileTypes: true })
    for (const e of entries) {
      // Skip dependency / vcs dirs from the listing.
      if (e.isDirectory() && ['node_modules', '.venv', '.git', '__pycache__'].includes(e.name)) continue
      const child = join(abs, e.name)
      if (e.isDirectory()) await walk(child)
      else out.push(relative(dir, child))
    }
  }
  await walk(dir)
  return out
}

// ─── Dependency setup ──────────────────────────────────────────────────────────

interface SetupResult {
  success: boolean
  output: string
  error?: string
}

/**
 * Install a tool's dependencies inside its managed dir. Detects:
 *   - requirements.txt → create a `.venv` and pip-install into it.
 *   - package.json     → `bun install` (node_modules in the dir).
 * Returns the installer's combined output. Never run implicitly at invoke time.
 */
export async function runToolSetup(slug: string): Promise<SetupResult> {
  if (!getCustomTool(slug)) throw new Error('CUSTOM_TOOL_NOT_FOUND')
  const dir = toolDir(slug)
  const steps: string[] = []

  const hasReqs = existsSync(join(dir, 'requirements.txt'))
  const hasPkg = existsSync(join(dir, 'package.json'))
  if (!hasReqs && !hasPkg) {
    return { success: true, output: 'No requirements.txt or package.json found — nothing to install.' }
  }

  if (hasReqs) {
    const venvDir = join(dir, '.venv')
    const venv = await runInDir(dir, ['python3', '-m', 'venv', '.venv'])
    steps.push(`$ python3 -m venv .venv\n${venv.output}`)
    if (venv.exitCode !== 0) return { success: false, output: steps.join('\n\n'), error: venv.error }
    const pip = await runInDir(dir, [join(venvDir, 'bin', 'pip'), 'install', '-r', 'requirements.txt'])
    steps.push(`$ .venv/bin/pip install -r requirements.txt\n${pip.output}`)
    if (pip.exitCode !== 0) return { success: false, output: steps.join('\n\n'), error: pip.error }
  }

  if (hasPkg) {
    const install = await runInDir(dir, ['bun', 'install'])
    steps.push(`$ bun install\n${install.output}`)
    if (install.exitCode !== 0) return { success: false, output: steps.join('\n\n'), error: install.error }
  }

  return { success: true, output: steps.join('\n\n') }
}

/** Spawn a command in a dir with the setup timeout, capturing combined output. */
async function runInDir(
  dir: string,
  argv: string[],
): Promise<{ exitCode: number; output: string; error?: string }> {
  const proc = Bun.spawn(argv, {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...subprocessEnv(), PATH: augmentedPath },
  })
  const stdoutP = new Response(proc.stdout).text()
  const stderrP = new Response(proc.stderr).text()
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      if (proc.pid) void killProcessTree(proc.pid)
      reject(new Error('Setup timeout'))
    }, config.customTools.setupTimeoutMs),
  )
  try {
    const exitCode = (await Promise.race([proc.exited, timeoutPromise])) as number
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP])
    return { exitCode, output: capOutput(stdout + (stderr ? `\n${stderr}` : '')), error: exitCode !== 0 ? stderr.trim() || undefined : undefined }
  } catch (err) {
    return { exitCode: -1, output: '', error: err instanceof Error ? err.message : 'Setup failed' }
  }
}

// ─── Execution ───────────────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean
  output: unknown
  error?: string
  exitCode: number
  executionTime: number
}

/** Resolve effective timeout: per-call override → per-tool → default; clamped. */
export function resolveTimeout(timeoutMs?: number | null): number {
  const value = timeoutMs ?? config.customTools.defaultTimeoutMs
  return Math.max(1_000, Math.min(value, config.customTools.maxTimeoutMs))
}

function capOutput(s: string): string {
  const max = config.customTools.maxOutputBytes
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`
}

/**
 * Resolve the interpreter argv for an entrypoint.
 * Precedence: explicit language → shebang → extension → bun. For Python, a
 * `.venv` created by runToolSetup is preferred over the system interpreter.
 */
export async function resolveInterpreter(
  dir: string,
  absEntry: string,
  language?: string | null,
): Promise<string[]> {
  const venvPython = join(dir, '.venv', 'bin', 'python')
  const python = existsSync(venvPython) ? venvPython : 'python3'

  if (language) {
    switch (language.toLowerCase()) {
      case 'python':
      case 'py':
        return [python, absEntry]
      case 'node':
      case 'javascript':
      case 'js':
        return ['node', absEntry]
      case 'bun':
        return ['bun', absEntry]
      case 'typescript':
      case 'ts':
        return ['bun', absEntry]
      case 'bash':
        return ['bash', absEntry]
      case 'sh':
        return ['sh', absEntry]
      case 'deno':
        return ['deno', 'run', '-A', absEntry]
      default:
        return [language, absEntry]
    }
  }

  // Shebang
  try {
    const head = (await Bun.file(absEntry).text()).split('\n', 1)[0] ?? ''
    if (head.startsWith('#!')) {
      const parts = head.slice(2).trim().split(/\s+/).filter(Boolean)
      if (parts.length > 0) return [...parts, absEntry]
    }
  } catch {
    /* unreadable — fall through to extension */
  }

  // Extension
  if (absEntry.endsWith('.py')) return [python, absEntry]
  if (absEntry.endsWith('.js') || absEntry.endsWith('.mjs') || absEntry.endsWith('.cjs')) return ['node', absEntry]
  if (absEntry.endsWith('.ts')) return ['bun', absEntry]
  if (absEntry.endsWith('.sh')) return ['bash', absEntry]
  return ['bun', absEntry]
}

export async function executeCustomTool(
  slug: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<ExecutionResult> {
  const tool = getCustomTool(slug)
  if (!tool) {
    return { success: false, output: '', error: 'Tool not found', exitCode: -1, executionTime: 0 }
  }

  const dir = toolDir(slug)
  let absEntry: string
  try {
    absEntry = validateToolPath(slug, tool.entrypoint)
  } catch (err) {
    return { success: false, output: '', error: err instanceof Error ? err.message : 'Invalid entrypoint', exitCode: -1, executionTime: 0 }
  }
  if (!existsSync(absEntry)) {
    return { success: false, output: '', error: `Entrypoint not found: ${tool.entrypoint}`, exitCode: -1, executionTime: 0 }
  }

  const argv = await resolveInterpreter(dir, absEntry, tool.language)
  const start = Date.now()

  try {
    const proc = Bun.spawn(argv, {
      cwd: dir,
      stdin: new Blob([JSON.stringify(args)]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...subprocessEnv(),
        PATH: augmentedPath,
        CUSTOM_TOOL_ARGS: JSON.stringify(args),
        HIVEKEEP_CUSTOM_TOOL_DIR: dir,
        HIVEKEEP_CUSTOM_TOOL_SLUG: slug,
      },
    })

    // Drain stdout/stderr concurrently so a full pipe buffer can't deadlock the
    // process before it exits (the old read-after-exit pattern could hang).
    const stdoutP = new Response(proc.stdout).text()
    const stderrP = new Response(proc.stderr).text()

    const effectiveTimeout = resolveTimeout(timeoutMs ?? tool.timeoutMs)
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => {
        if (proc.pid) void killProcessTree(proc.pid)
        reject(new Error('Execution timeout'))
      }, effectiveTimeout),
    )

    const exitCode = (await Promise.race([proc.exited, timeoutPromise])) as number
    const [stdoutRaw, stderrRaw] = await Promise.all([stdoutP, stderrP])
    const stdout = capOutput(stdoutRaw)
    const stderr = capOutput(stderrRaw)
    const executionTime = Date.now() - start

    log.info({ slug, executionTime, exitCode, success: exitCode === 0 }, 'Custom tool executed')

    // Result protocol: JSON when parseable, else trimmed text.
    let output: unknown = stdout.trim()
    if (output) {
      try {
        output = JSON.parse(output as string)
      } catch {
        /* keep as text */
      }
    }

    return {
      success: exitCode === 0,
      output,
      error: stderr.trim() || undefined,
      exitCode,
      executionTime,
    }
  } catch (err) {
    log.error({ slug, err }, 'Custom tool execution failed')
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : 'Execution failed',
      exitCode: -1,
      executionTime: Date.now() - start,
    }
  }
}

// ─── Resolve custom tools as AI SDK tools (MCP-style separate injection) ────────

/**
 * All ENABLED custom tools as AI SDK tools, keyed `custom_<slug>`. Merged into
 * the universe by toolset-resolver and granted when a toolbox lists the name OR
 * via the `*` wildcard (the 'all' built-in), which expands to every native tool
 * plus every enabled custom tool. MCP and plugin tools still need an explicit
 * name.
 */
export function resolveCustomTools(): Record<string, Tool<any, any>> {
  const tools = listCustomTools().filter((t) => t.enabled)
  if (tools.length === 0) return {}

  const resolved: Record<string, Tool<any, any>> = {}

  for (const ct of tools) {
    const toolKey = `custom_${ct.slug}`
    let schema: Record<string, unknown>
    try {
      schema = JSON.parse(ct.parameters)
    } catch {
      continue // Skip malformed schema
    }

    const baseSchema = jsonSchemaToZod(schema)
    const inputSchema =
      baseSchema instanceof z.ZodObject
        ? baseSchema.extend({
            timeout: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Execution timeout in ms, capped at server max'),
          })
        : baseSchema

    resolved[toolKey] = aiTool({
      description: `[Custom] ${ct.description}`,
      inputSchema,
      execute: async (allArgs) => {
        const { timeout, ...toolArgs } = allArgs as Record<string, unknown>
        return executeCustomTool(ct.slug, toolArgs, timeout as number | undefined)
      },
    })
  }

  return resolved
}

// ─── Validation helpers ──────────────────────────────────────────────────────

function validateJsonSchema(parameters: string): void {
  try {
    JSON.parse(parameters)
  } catch {
    throw new Error('Parameters must be valid JSON Schema')
  }
}

// ─── JSON Schema → Zod (same shape as services/mcp.ts) ─────────────────────────

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  if (schema.type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>
    const required = (schema.required as string[]) ?? []
    const shape: Record<string, z.ZodType> = {}

    for (const [key, prop] of Object.entries(props)) {
      let field = jsonSchemaPropertyToZod(prop)
      if (!required.includes(key)) {
        field = field.optional() as any
      }
      shape[key] = field
    }

    return z.object(shape)
  }

  return z.object({}).passthrough()
}

function jsonSchemaPropertyToZod(prop: Record<string, unknown>): z.ZodType {
  const desc = (prop.description as string) ?? undefined

  switch (prop.type) {
    case 'string':
      if (prop.enum) return z.enum(prop.enum as [string, ...string[]]).describe(desc ?? '')
      return desc ? z.string().describe(desc) : z.string()
    case 'number':
    case 'integer':
      return desc ? z.number().describe(desc) : z.number()
    case 'boolean':
      return desc ? z.boolean().describe(desc) : z.boolean()
    case 'array':
      if (prop.items) return z.array(jsonSchemaPropertyToZod(prop.items as Record<string, unknown>))
      return z.array(z.unknown())
    case 'object':
      return jsonSchemaToZod(prop)
    default:
      return z.unknown()
  }
}
