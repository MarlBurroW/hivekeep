import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { Tool } from '@/server/tools/tool-helper'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { countTokens } from '@/shared/token-estimator'

const log = createLogger('tool-output-spill')

/** Tools exempt from spilling (they already have offset/limit or produce small metadata) */
const SPILL_EXEMPT_TOOLS = new Set(['read_file'])

const SPILL_DIR_NAME = '.tool-outputs'

// ─── Core Spill ──────────────────────────────────────────────────────────────

interface SpillReference {
  __spilled: true
  toolName: string
  file: string
  sizeBytes: number
  lineCount: number
  preview: string
  hint: string
}

/**
 * Cut a preview out of the serialized result, bounded by BOTH the line count
 * and a hard character budget.
 *
 * The character bound is the one that matters: `JSON.stringify` escapes
 * newlines, so a result whose bulk is a single string (an email body, grep
 * output, shell stdout) serializes to a few enormous lines. Slicing by line
 * count alone then returns the whole payload, and a "spilled" output costs the
 * same context as an inline one. That is how a 109k-token email survived into
 * every subsequent turn.
 */
export function buildPreview(lines: string[], maxLines: number, maxChars: number): string {
  const byLines = lines.slice(0, Math.max(1, maxLines)).join('\n')
  if (maxChars <= 0 || byLines.length <= maxChars) return byLines
  const omitted = byLines.length - maxChars
  return `${byLines.slice(0, maxChars)}\n… [preview truncated, ${omitted.toLocaleString()} more characters — read the file for the rest]`
}

/**
 * Cap a tool result that is about to be replayed to the model.
 *
 * The keep-window cap in `buildMessageHistory` only runs when the NEXT turn
 * rebuilds history from the DB. Within the current turn, results are appended
 * raw and re-sent at every subsequent step, so one oversized result (a
 * spill-exempt `read_file`, anything the spill threshold let through) is paid
 * for again on each step. Same placeholder wording as the rebuild path, so the
 * model sees a consistent story across turns.
 */
export function capToolResultText(text: string, toolName: string, capTokens: number): string {
  if (capTokens <= 0) return text
  // ~4 chars/token; cheap guard before paying for a real token count.
  if (text.length <= capTokens * 4) return text
  const tokens = countTokens(text)
  if (tokens <= capTokens) return text
  return `[Tool result trimmed: ${toolName} returned ~${tokens.toLocaleString()} tokens, exceeding the ${capTokens.toLocaleString()}-token keep-window cap. Re-run the tool if you need the full output.]`
}

/**
 * If a tool result exceeds the configured byte threshold, save the full
 * serialized result to a temp file and return a compact reference with a
 * preview. Otherwise return the result unchanged.
 */
export function maybeSpillToolOutput(
  workspacePath: string,
  toolName: string,
  result: unknown,
): unknown {
  if (SPILL_EXEMPT_TOOLS.has(toolName)) return result

  const threshold = config.toolOutputs?.spillThreshold ?? 10000
  if (threshold <= 0) return result // spilling disabled

  let serialized: string
  try {
    serialized = JSON.stringify(result, null, 2)
  } catch {
    return result // not serializable — return as-is
  }

  const sizeBytes = Buffer.byteLength(serialized, 'utf-8')
  if (sizeBytes <= threshold) return result

  // Spill to file
  const spillDir = join(workspacePath, SPILL_DIR_NAME)
  mkdirSync(spillDir, { recursive: true })

  const hash = createHash('sha256').update(serialized).digest('hex').slice(0, 8)
  const filename = `tool-result-${Date.now()}-${hash}.txt`
  const filePath = join(spillDir, filename)

  try {
    writeFileSync(filePath, serialized, 'utf-8')
  } catch (err) {
    log.warn({ err, filePath }, 'Failed to write spilled tool output')
    return result // fallback to inline
  }

  const lines = serialized.split('\n')
  const lineCount = lines.length
  const previewLines = config.toolOutputs?.previewLines ?? 200
  const previewMaxChars = config.toolOutputs?.previewMaxChars ?? 4000
  const preview = buildPreview(lines, previewLines, previewMaxChars)
  const relativePath = `${SPILL_DIR_NAME}/${filename}`

  const ref: SpillReference = {
    __spilled: true,
    toolName,
    file: relativePath,
    sizeBytes,
    lineCount,
    preview,
    hint: `Full output saved to file. Use read_file("${relativePath}", offset=N, limit=M) to read specific sections.`,
  }

  log.debug({ toolName, sizeBytes, lineCount, file: relativePath }, 'Tool output spilled to file')

  return ref
}

// ─── Tool Wrapping ───────────────────────────────────────────────────────────

/**
 * Wrap all tools in a record so that large results are automatically
 * spilled to temp files. Exempt tools and tools without execute are
 * passed through unchanged.
 */
export function wrapToolsWithSpill(
  tools: Record<string, Tool<any, any>>,
  workspacePath: string,
): Record<string, Tool<any, any>> {
  const wrapped: Record<string, Tool<any, any>> = {}

  for (const [name, tool] of Object.entries(tools)) {
    if (!('execute' in tool) || typeof tool.execute !== 'function' || SPILL_EXEMPT_TOOLS.has(name)) {
      wrapped[name] = tool
      continue
    }

    const originalExecute = tool.execute
    wrapped[name] = {
      ...tool,
      execute: async (args: unknown, options: unknown) => {
        const result = await (originalExecute as Function)(args, options)
        return maybeSpillToolOutput(workspacePath, name, result)
      },
    }
  }

  return wrapped
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Delete spilled tool output files older than the configured TTL.
 * Scans all workspace subdirectories for `.tool-outputs/` dirs.
 * Returns the number of files deleted.
 */
export function cleanupSpilledOutputs(workspacesBaseDir: string): number {
  const ttlMs = (config.toolOutputs?.ttlHours ?? 24) * 60 * 60 * 1000
  if (ttlMs <= 0) return 0

  const now = Date.now()
  let deletedCount = 0

  let workspaces: string[]
  try {
    workspaces = readdirSync(workspacesBaseDir)
  } catch {
    return 0
  }

  for (const ws of workspaces) {
    const spillDir = join(workspacesBaseDir, ws, SPILL_DIR_NAME)
    let files: string[]
    try {
      files = readdirSync(spillDir)
    } catch {
      continue // no .tool-outputs dir
    }

    for (const file of files) {
      const filePath = join(spillDir, file)
      try {
        const stat = statSync(filePath)
        if (!stat.isFile()) continue
        if (now - stat.mtimeMs > ttlMs) {
          unlinkSync(filePath)
          deletedCount++
        }
      } catch {
        // skip inaccessible files
      }
    }
  }

  if (deletedCount > 0) {
    log.debug({ deletedCount }, 'Cleaned up spilled tool outputs')
  }

  return deletedCount
}
