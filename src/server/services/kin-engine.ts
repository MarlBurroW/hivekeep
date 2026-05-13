import { streamText, type ModelMessage, type UserContent, type Tool } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { eq, and, isNull, ne, asc, desc } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import {
  kins,
  messages,
  providers,
  memories,
  compactingSummaries,
  userProfiles,
  queueItems,
  channels,
} from '@/server/db/schema'
import { guessProviderType } from '@/shared/model-ref'
import { getContactDisplayName } from '@/shared/contact-display'
import { decrypt } from '@/server/services/encryption'
import { buildSystemPrompt, joinSystemPrompt } from '@/server/services/prompt-builder'
import {
  buildSegmentedMessages,
  markLastToolCacheable,
} from '@/server/services/llm-cache-hints'
import { dequeueMessage, markQueueItemDone, isKinProcessing, getQueueSize, recoverStaleProcessingItems, popQueueMessageMetadata } from '@/server/services/queue'
import { recoverStaleTasks } from '@/server/services/tasks'
import { sseManager } from '@/server/sse/index'
import { eventBus } from '@/server/services/events'
import { hookRegistry } from '@/server/hooks/index'
import { toolRegistry } from '@/server/tools/index'
import { config } from '@/server/config'
import { getOAuthAccessToken, OAUTH_HEADERS, REQUIRED_SYSTEM_BLOCK, getOAuthUserId, buildBillingHeaderText } from '@/server/providers/anthropic-oauth'
import { getCodexOAuthCredentials, CODEX_BASE_URL } from '@/server/providers/openai-codex'
import { getRelevantMemories, rewriteQueryWithContext } from '@/server/services/memory'
import { maybeCompact } from '@/server/services/compacting'
import { resolveMCPTools, getMCPToolsSummary } from '@/server/services/mcp'
import { resolveCustomTools } from '@/server/services/custom-tools'
import type { KinToolConfig, KinThinkingConfig, KinThinkingEffort, ContextTokenBreakdown, ContextPipelineStatus } from '@/shared/types'
import { listAvailableKins } from '@/server/services/inter-kin'
import { listContactsForPrompt, findContactByLinkedUserId } from '@/server/services/contacts'
import { contactNotes as contactNotesTable } from '@/server/db/schema'
import { linkFilesToMessage, getFilesForMessage } from '@/server/services/files'
import { popChannelQueueMeta, getChannelQueueMeta, deliverChannelResponse, getActiveChannelsForKin, getChannel, findContactByPlatformId, getChannelOriginMeta } from '@/server/services/channels'
import { popStagedAttachments, clearStagedAttachments } from '@/server/tools/attach-file-tool'
import { parseMentions, notifyMentionedUsers } from '@/server/services/mentions'
import { getGlobalPrompt, getHubKinId, getSetting, setSetting } from '@/server/services/app-settings'
import { wrapToolsWithSpill } from '@/server/services/tool-output-spill'
import { executeToolBatch } from '@/server/services/tool-executor'
import { recordUsage, aggregateStepUsage } from '@/server/services/token-usage'
import { channelAdapters } from '@/server/channels/index'
import { getModelContextWindow } from '@/shared/model-context-windows'

const log = createLogger('kin-engine')

/**
 * Default maximum number of tools to send to the LLM in a single request.
 * Used as a safe fallback when the provider type is unknown.
 * OpenAI enforces a hard limit of 128 tools; assume that for unknown providers.
 */
const DEFAULT_MAX_LLM_TOOLS = 128

/**
 * Core file tools that must always be preserved when truncation is needed.
 * These are the primary interface for Kins to read/write/search files in their
 * workspace; silently dropping them breaks most workflows.
 */
const PROTECTED_CORE_TOOLS = new Set<string>([
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'list_directory',
  'grep',
])

/**
 * Tool key prefixes that should be preserved when truncation is needed.
 * - `mcp_`    : tools registered by MCP servers (see resolveMCPTools)
 * - `custom_` : user-defined custom tools (see resolveCustomTools)
 */
const PROTECTED_PREFIXES = ['mcp_', 'custom_'] as const

function isProtectedToolName(name: string): boolean {
  if (PROTECTED_CORE_TOOLS.has(name)) return true
  for (const prefix of PROTECTED_PREFIXES) {
    if (name.startsWith(prefix)) return true
  }
  return false
}

/**
 * Return the max number of tools the given provider type accepts in a single
 * LLM call.
 *
 * - OpenAI / openai-codex: hard limit of 128 tools (rejected above that).
 * - Anthropic: no documented hard limit — supports hundreds of tools in
 *   practice. We use a high soft cap (512) purely as a safety net, not as
 *   a real provider restriction.
 * - Gemini: no documented hard limit — we use the same high soft cap (512).
 * - DeepSeek: exposes an OpenAI-compatible API, so 128 is the safe bound.
 * - Unknown / null: fall back to the OpenAI-compatible 128 limit.
 */
function getMaxToolsForProvider(providerType: string | null): number {
  switch (providerType) {
    case 'openai':
    case 'openai-codex':
    case 'deepseek':
      return 128
    case 'anthropic':
      // No documented hard limit; high soft cap only as a safety net.
      return 512
    case 'gemini':
      return 512
    default:
      return DEFAULT_MAX_LLM_TOOLS
  }
}

/**
 * Cap the number of tools to the provider-specific limit. When truncation IS
 * required, protected tools (core file tools, MCP tools, custom tools) are
 * preserved first; remaining slots are filled with the other tools in
 * insertion order. Logs a warning when truncation occurs, including the
 * effective cap, the kept list, and the dropped list.
 */
function capTools(
  tools: Record<string, Tool<any, any>>,
  kinId: string,
  providerType: string | null,
): Record<string, Tool<any, any>> {
  const cap = getMaxToolsForProvider(providerType)
  const names = Object.keys(tools)
  if (names.length <= cap) return tools

  // Partition into protected and droppable buckets, preserving insertion order
  const protectedNames: string[] = []
  const droppableNames: string[] = []
  for (const name of names) {
    if (isProtectedToolName(name)) protectedNames.push(name)
    else droppableNames.push(name)
  }

  const capped: Record<string, Tool<any, any>> = {}

  if (protectedNames.length > cap) {
    // Extremely unlikely: protected tools alone exceed the provider cap.
    // Keep the first `cap` protected tools and log an error with details.
    const keptProtected = protectedNames.slice(0, cap)
    const droppedProtected = protectedNames.slice(cap)
    log.error(
      {
        kinId,
        providerType,
        total: names.length,
        cap,
        protectedCount: protectedNames.length,
        keptProtected,
        droppedProtected,
        droppedOther: droppableNames,
      },
      `Protected tool set (${protectedNames.length}) exceeds provider cap (${cap}). Dropping ${droppedProtected.length} protected tool(s) and all ${droppableNames.length} other tool(s).`,
    )
    for (const name of keptProtected) capped[name] = tools[name]!
    return capped
  }

  // Fill with protected first, then remaining droppable tools up to the cap
  for (const name of protectedNames) capped[name] = tools[name]!
  const remainingSlots = cap - protectedNames.length
  const keptDroppable = droppableNames.slice(0, remainingSlots)
  const droppedNames = droppableNames.slice(remainingSlots)
  for (const name of keptDroppable) capped[name] = tools[name]!

  log.warn(
    {
      kinId,
      providerType,
      total: names.length,
      cap,
      keptCount: Object.keys(capped).length,
      droppedCount: droppedNames.length,
      protectedCount: protectedNames.length,
      keptNames: Object.keys(capped),
      droppedNames,
    },
    `Tool array exceeds provider cap (${names.length}/${cap} for ${providerType ?? 'unknown'}). Dropping ${droppedNames.length} non-critical tool(s) after protecting core/MCP/custom tools.`,
  )

  return capped
}

/**
 * Strip execute functions from tools so the SDK only collects tool call intents
 * without executing them. This allows our custom loop to execute tools
 * sequentially between LLM steps, preventing hallucinated tool results.
 */
function stripToolExecute(tools: Record<string, Tool>): Record<string, Tool> {
  const schemas: Record<string, Tool> = {}
  for (const [name, t] of Object.entries(tools)) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { execute, ...rest } = t as Record<string, unknown>
    schemas[name] = rest as Tool
  }
  return schemas
}


// In-memory lock to prevent overlapping setInterval ticks from double-processing
const kinLocks = new Set<string>()

// Quick session locks — separate from main to allow parallel processing
const quickLocks = new Set<string>()

// In-memory lock to prevent queue processing while compacting is running
// Exported so the API can report compacting state to the frontend
export const compactingKins = new Set<string>()

// AbortController registry — one per actively-streaming Kin
const activeAbortControllers = new Map<string, AbortController>()

// AbortController registry for quick sessions — keyed by sessionId
const quickAbortControllers = new Map<string, AbortController>()

// Cache of last computed context usage per Kin. Two values are kept side by
// side instead of one + a source flag — that earlier design caused subtle
// sync issues between the SSE-fed navbar and the REST-fed visualizer when
// one read picked up the source field and the other didn't.
//
//   contextTokens     : local BPE estimate (always present once computed).
//                       Built from the systemPrompt / messages / tools sums.
//                       Available before any API roundtrip — useful for the
//                       first message of a session and for the per-section
//                       breakdown bar.
//   apiContextTokens  : provider-reported peak step input from the most
//                       recent LLM call (ground truth). Only present after
//                       the first turn. Independent of the estimate; the
//                       UI shows it on a separate solid bar.
const lastContextUsage = new Map<string, {
  /** Calibrated estimate (= raw BPE × calibrationFactor) — what the UI shows
   *  on the "estimate" bar. Closer to the provider count than the raw value. */
  contextTokens: number
  /** Untouched BPE total — kept so we can recompute calibration each turn
   *  by comparing to apiContextTokens. Never displayed directly. */
  contextTokensRaw?: number
  apiContextTokens?: number
  contextWindow: number
  updatedAt: number
  /** Calibrated section sizes (each scaled by calibrationFactor). Sums to
   *  contextTokens. Drives the colored breakdown bar. */
  breakdown?: ContextTokenBreakdown
  /** Raw section sizes from the BPE estimator (no calibration). */
  breakdownRaw?: ContextTokenBreakdown
  pipelineStatus?: ContextPipelineStatus
  /** EMA-smoothed ratio observed from past API roundtrips (api / raw_estimate).
   *  Defaults to 1.0 before any roundtrip. Clamped to [0.7, 3.0] for safety. */
  calibrationFactor?: number
}>()

const CALIBRATION_EMA_ALPHA = 0.4 // weight given to the new observation
const CALIBRATION_MIN = 0.7
const CALIBRATION_MAX = 3.0

function scaleBreakdown(b: ContextTokenBreakdown, factor: number): ContextTokenBreakdown {
  const scale = (n: number) => Math.round(n * factor)
  return {
    systemPrompt: scale(b.systemPrompt),
    messages: scale(b.messages),
    tools: scale(b.tools),
    summary: scale(b.summary ?? 0),
    cronRuns: b.cronRuns != null ? scale(b.cronRuns) : undefined,
    cronLearnings: b.cronLearnings != null ? scale(b.cronLearnings) : undefined,
    total: scale(b.total),
  }
}

/** Store the local-estimate context size for a Kin (called BEFORE each LLM
 *  call). Does NOT touch apiContextTokens — that field is owned by
 *  recordApiContextSize and reflects the most recent provider roundtrip.
 *
 *  Applies the per-Kin calibration factor learned from past roundtrips so
 *  the displayed estimate tracks the provider count instead of under-counting
 *  by 30-60% on JSON / tool-heavy contexts (the BPE tokenizer is OpenAI's
 *  o200k_base, less efficient than Claude's tokenizer on structured text). */
export function setLastContextUsage(
  kinId: string,
  contextTokensRaw: number,
  contextWindow: number,
  breakdownRaw?: ContextTokenBreakdown,
  pipelineStatus?: ContextPipelineStatus,
) {
  const existing = lastContextUsage.get(kinId)
  const calibrationFactor = existing?.calibrationFactor ?? 1
  const data = {
    contextTokens: Math.round(contextTokensRaw * calibrationFactor),
    contextTokensRaw,
    apiContextTokens: existing?.apiContextTokens,
    contextWindow,
    updatedAt: Date.now(),
    breakdown: breakdownRaw ? scaleBreakdown(breakdownRaw, calibrationFactor) : undefined,
    breakdownRaw,
    pipelineStatus,
    calibrationFactor,
  }
  lastContextUsage.set(kinId, data)
  setSetting(`context_usage:${kinId}`, JSON.stringify(data)).catch(() => {})
}

/** Drop the cached apiContextTokens (provider ground truth) for a Kin
 *  without otherwise touching the entry. Used by the compacting service
 *  after a successful summary write — the previous API count was for a
 *  payload that no longer reflects reality, so leaving it as the
 *  displayed "real" value would lie to the user until the next main
 *  turn happens to update it. The contextTokens estimate stays as the
 *  best-available signal in the meantime. */
export function invalidateApiContextSize(kinId: string): void {
  const existing = lastContextUsage.get(kinId)
  if (!existing || existing.apiContextTokens == null) return
  const data = { ...existing, apiContextTokens: undefined, updatedAt: Date.now() }
  lastContextUsage.set(kinId, data)
  setSetting(`context_usage:${kinId}`, JSON.stringify(data)).catch(() => {})
}

/** Update the cached api-reported context size (ground truth) for a Kin and
 *  refine the per-Kin calibration factor by EMA-blending the new observed
 *  ratio. Called from the kin-engine after each LLM turn. */
export function recordApiContextSize(kinId: string, peakStepInputTokens: number) {
  const existing = lastContextUsage.get(kinId)
  let calibrationFactor = existing?.calibrationFactor ?? 1
  // Update calibration only when we have a meaningful raw estimate to compare
  // against. The first turn has contextTokensRaw set by setLastContextUsage
  // immediately before this call.
  if (existing?.contextTokensRaw && existing.contextTokensRaw > 1000) {
    const observed = peakStepInputTokens / existing.contextTokensRaw
    const blended = calibrationFactor * (1 - CALIBRATION_EMA_ALPHA) + observed * CALIBRATION_EMA_ALPHA
    calibrationFactor = Math.max(CALIBRATION_MIN, Math.min(CALIBRATION_MAX, blended))
  }
  const data = {
    contextTokens: existing?.contextTokens ?? peakStepInputTokens,
    contextTokensRaw: existing?.contextTokensRaw,
    apiContextTokens: peakStepInputTokens,
    contextWindow: existing?.contextWindow ?? 0,
    updatedAt: Date.now(),
    breakdown: existing?.breakdown,
    breakdownRaw: existing?.breakdownRaw,
    pipelineStatus: existing?.pipelineStatus,
    calibrationFactor,
  }
  lastContextUsage.set(kinId, data)
  setSetting(`context_usage:${kinId}`, JSON.stringify(data)).catch(() => {})
}

/** Get the cached context usage for a Kin, if available.
 *
 *  `contextTokens` (current usage) is read from the cache.
 *  `contextWindow` (model's max) is always recomputed from the Kin's current
 *  model — it doesn't depend on the conversation, and caching it would
 *  return stale values when:
 *    - the model spec was updated by the provider (e.g. Anthropic raised
 *      Opus 4.7 to 1M tokens since the last LLM call)
 *    - the Kin's model was changed in the UI
 */
/** Drop all in-memory + persisted context usage state for a Kin. Called by
 *  deleteKin so the lastContextUsage map and the corresponding app_settings
 *  row don't leak after the Kin is gone (uncleaned, both grow unboundedly
 *  on a deployment with high Kin churn). */
export async function clearKinContextUsage(kinId: string): Promise<void> {
  lastContextUsage.delete(kinId)
  try {
    const { deleteSetting } = await import('@/server/services/app-settings')
    await deleteSetting(`context_usage:${kinId}`)
  } catch {
    // Best-effort — the in-memory entry is gone either way
  }
}

export async function getLastContextUsage(kinId: string) {
  // Check in-memory cache first, fall back to DB (survives restarts)
  let cached = lastContextUsage.get(kinId)
  if (!cached) {
    const persisted = await getSetting(`context_usage:${kinId}`)
    if (persisted) {
      try {
        const parsed = JSON.parse(persisted) as Record<string, unknown>
        if (parsed && typeof parsed === 'object') {
          // Migrate older payloads that used contextSource='api' to populate
          // the new dedicated apiContextTokens field. Estimates stay where
          // they are — older payloads' contextTokens were the source of truth
          // for whichever source produced them.
          if (parsed.contextSource === 'api' && parsed.apiContextTokens == null) {
            parsed.apiContextTokens = parsed.contextTokens
          }
          delete parsed.contextSource
          cached = parsed as unknown as NonNullable<ReturnType<typeof lastContextUsage.get>>
          lastContextUsage.set(kinId, cached)
        }
      } catch { /* ignore corrupt data */ }
    }
  }
  if (!cached) return null

  // Refresh contextWindow from the current model.
  const kinRow = db.select({ model: kins.model }).from(kins).where(eq(kins.id, kinId)).get()
  if (kinRow?.model) {
    return { ...cached, contextWindow: getModelContextWindow(kinRow.model) }
  }
  return cached
}

// Cache of last computed compacting proximity per Kin
const lastCompactingProximity = new Map<string, { compactingPercent: number; compactingThresholdPercent: number; summaryCount: number }>()

/**
 * Extract a human-readable message from a raw API error object.
 * Handles nested structures like { error: { message: "..." } } from Anthropic/OpenAI.
 */
function extractApiErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err !== 'object' || err === null) return String(err)
  const obj = err as Record<string, unknown>
  // Direct .message (e.g. Error-like objects)
  if (typeof obj.message === 'string') return obj.message
  // Nested .error.message (e.g. Anthropic/OpenAI raw API responses)
  if (typeof obj.error === 'object' && obj.error !== null) {
    const nested = obj.error as Record<string, unknown>
    if (typeof nested.message === 'string') return nested.message
  }
  return JSON.stringify(err)
}

/**
 * Match the various ways providers report "you sent too many tokens".
 * Anthropic: "prompt is too long: X tokens > Y maximum"
 * OpenAI:    "This model's maximum context length is X tokens..." or `code:context_length_exceeded`
 * Google:    "input token count (X) exceeds the maximum number of tokens allowed (Y)"
 * Generic:   "context window" appears in many provider messages.
 *
 * Used both to friendly-format the error AND to decide whether to fire a
 * background recovery compacting in the catch block.
 */
const CONTEXT_TOO_LARGE_RE = /prompt is too long|context[\s_-]?length[\s_-]?exceed|maximum context length|context window|exceeds the maximum number of tokens|input token count[^.]{0,40}exceed/i

export function isContextTooLargeError(errorMsg: string): boolean {
  return CONTEXT_TOO_LARGE_RE.test(errorMsg)
}

/**
 * Convert a raw error message into a user-friendly display message.
 */
function friendlyErrorMessage(errorMsg: string): string {
  const lower = errorMsg.toLowerCase()
  if (lower.includes('rate limit') || errorMsg.includes('429') || lower.includes('too many requests')) {
    return 'Rate limit reached — please wait a moment and try again.'
  }
  if (isContextTooLargeError(errorMsg)) {
    return 'The conversation is too long for this model\'s context window. Compaction has been triggered automatically — please retry in a few seconds.'
  }
  return errorMsg
}

/**
 * Token estimation backed by gpt-tokenizer (BPE) — accurate to within ~5-15%
 * of what providers actually count. The shared helper falls back to chars/4
 * only during the very first call after a cold start while the encoder loads.
 */
import { countTokens as countTokensShared } from '@/shared/token-estimator'
function estimateTokens(text: string): number {
  return countTokensShared(text)
}

/** Max characters to inline from a text-based attachment. */
const MAX_INLINE_TEXT_LENGTH = 100_000

/** Max file size (bytes) to attempt inlining at all. */
const MAX_INLINE_FILE_SIZE = 20 * 1024 * 1024

/**
 * Check if a MIME type represents a text-readable file whose content
 * can be inlined directly into the LLM context as text.
 */
function isTextReadable(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true
  const textMimes = [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/toml',
    'application/x-sh',
    'application/sql',
    'application/graphql',
    'application/x-httpd-php',
    'application/xhtml+xml',
  ]
  return textMimes.includes(mimeType)
}

/**
 * Defensively sanitize tool calls parsed from the persisted `messages.toolCalls`
 * JSON column before they are replayed into an LLM request.
 *
 * The Vercel AI SDK's `ModelMessage[]` zod schema rejects `tool-call` parts that:
 *   - are missing `toolCallId` (empty string) or `toolName`
 *   - have `input === undefined` (undefined is not a valid JSON value)
 *
 * Historical sessions can legitimately contain such entries when:
 *   - A previous run dropped a tool via the tool cap (pre-#354) and the LLM
 *     called the dropped tool anyway — the persisted args can round-trip as
 *     `undefined` depending on the provider and abort timing.
 *   - A stream was aborted mid tool-call-delta, leaving a partial entry.
 *   - Older code paths or bugs persisted malformed entries.
 *
 * Once such an entry is in the history, *every* subsequent turn fails with
 * `Invalid prompt: messages do not match the ModelMessage[] schema`, which
 * permanently breaks the session (#355) — container restart and compaction
 * do not help because the bad entry is reloaded from SQLite every time.
 *
 * This function drops entries that are unrecoverable (missing id/name) and
 * normalizes `undefined` args to `{}` so the schema validator accepts them.
 * It is called from every place that rebuilds history from persisted
 * `toolCalls` JSON (buildMessageHistory + the quick-session resume path).
 */
function sanitizePersistedToolCalls<T extends { id: unknown; name: unknown; args: unknown; result?: unknown }>(
  toolCalls: T[],
  kinId: string,
): Array<T & { id: string; name: string; args: unknown }> {
  const out: Array<T & { id: string; name: string; args: unknown }> = []
  let dropped = 0
  let normalized = 0
  for (const tc of toolCalls) {
    if (!tc || typeof tc.id !== 'string' || tc.id.length === 0 || typeof tc.name !== 'string' || tc.name.length === 0) {
      dropped++
      continue
    }
    // `undefined` is not a valid JSON value — the Vercel AI SDK ModelMessage
    // schema rejects `input: undefined`. Normalize to `{}` so the history
    // replay stays structurally valid. Any other value (null, object, array,
    // primitive) passes through untouched.
    let args: unknown = tc.args
    if (args === undefined) {
      args = {}
      normalized++
    }
    out.push({ ...tc, id: tc.id, name: tc.name, args })
  }
  if (dropped > 0 || normalized > 0) {
    log.warn(
      { kinId, droppedMalformed: dropped, normalizedUndefinedArgs: normalized, total: toolCalls.length },
      'Sanitized malformed persisted tool calls before LLM replay (#355 recovery)',
    )
  }
  return out
}

/**
 * Convert each tool's Zod inputSchema to its JSON Schema form (what actually
 * reaches the LLM), so token counts match what the API sees. Falls back to
 * the raw schema when no `.toJSONSchema()` method is exposed.
 */
function buildToolSchemaPayload(tools: Record<string, unknown>): Array<{ name: string; description: string; parameters: unknown }> {
  return Object.entries(tools).map(([name, t]) => {
    const toolObj = t as { description?: string; inputSchema?: unknown }
    const schema = toolObj.inputSchema
    let parameters: unknown = null
    if (schema && typeof schema === 'object' && 'toJSONSchema' in schema && typeof (schema as { toJSONSchema: unknown }).toJSONSchema === 'function') {
      try {
        parameters = (schema as { toJSONSchema(): unknown }).toJSONSchema()
      } catch {
        parameters = null
      }
    }
    return {
      name,
      description: toolObj.description ?? '',
      parameters,
    }
  })
}

/**
 * Estimate the total token count of a full LLM request payload.
 * When `summaryTokens` is provided, that amount is split out of the system prompt total
 * and reported as a separate `summary` field.
 *
 * Exported so context-preview.ts can compute the visualizer's section totals
 * from the SAME masked/trimmed messageHistory that this turn's API call will
 * see — otherwise the dialog over-counts pre-trim content while the navbar
 * shows post-trim, and the two diverge by hundreds of thousands of tokens on
 * tool-heavy Kins.
 */
export function estimateContextTokens(
  systemPrompt: string,
  messageHistory: ModelMessage[],
  tools: Record<string, unknown> | undefined,
  summaryTokens?: number,
): ContextTokenBreakdown {
  const rawSystemPromptTokens = estimateTokens(systemPrompt)
  const summary = summaryTokens ?? 0
  const systemPromptTokens = Math.max(0, rawSystemPromptTokens - summary)
  let messagesTokens = 0
  for (const msg of messageHistory) {
    if (typeof msg.content === 'string') {
      messagesTokens += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          messagesTokens += estimateTokens(part.text)
        } else if ('type' in part && part.type === 'image') {
          // Anthropic vision pricing scales with pixel count. PNGs compress
          // to roughly 1 byte per pixel on average and Anthropic charges
          // ~1 token per 750 pixels, so bytes/750 is a usable heuristic.
          // Floor at 1500 (≈ a typical 1280×720 screenshot) since the prior
          // 85-token flat estimate was 15-60× too low and silently masked
          // huge contexts.
          const img = (part as { image?: unknown }).image
          const bytes = img instanceof Uint8Array
            ? img.length
            : typeof img === 'string' ? img.length * 0.75 // assume base64
            : 0
          messagesTokens += bytes > 0 ? Math.max(1500, Math.round(bytes / 750)) : 1500
        } else if ('type' in part && part.type === 'file') {
          // Rough estimate for PDF: ~500 tokens per page, ~3KB per page
          const dataLen = 'data' in part && typeof part.data === 'string' ? part.data.length * 0.75 : 0
          messagesTokens += Math.max(500, Math.ceil(dataLen / 3000) * 500)
        } else if ('type' in part && part.type === 'tool-call') {
          // Vercel AI SDK's tool-call part uses `input` (not `args`) for the
          // serialized tool arguments. Counted because they reach the API as
          // part of the assistant's tool_use block.
          const input = (part as { input?: unknown }).input
          const inputStr = input !== undefined ? JSON.stringify(input) : ''
          messagesTokens += estimateTokens(inputStr)
        } else if ('type' in part && part.type === 'tool-result') {
          // tool-result part shape: `output: { type: 'json' | 'text', value: ... }`.
          // The `value` is the actual tool result content — kubectl outputs,
          // file reads, page_state YAMLs, etc. — and is typically the LARGEST
          // unbilled hidden cost in tool-heavy Kins. Previous versions of this
          // code looked for a non-existent `result` field and silently
          // counted 0 tokens, leading to displayed context sizes that were
          // 10-20× lower than reality.
          const output = (part as { output?: { type?: string; value?: unknown } }).output
          const value = output?.value
          const valueStr = typeof value === 'string'
            ? value
            : value !== undefined ? JSON.stringify(value) : ''
          messagesTokens += estimateTokens(valueStr)
        }
      }
    }
  }
  // Tools are sent to the LLM as JSON Schema (not as the raw Zod object that
  // lives in the Vercel AI SDK's tool registry), so we count the JSON Schema
  // representation. JSON.stringify(tools) would inflate by serializing Zod's
  // internal fields that never reach the API and would diverge from the
  // visualizer's count of the same data.
  const toolsTokens = (tools && Object.keys(tools).length > 0)
    ? estimateTokens(JSON.stringify(buildToolSchemaPayload(tools)))
    : 0
  const total = systemPromptTokens + summary + messagesTokens + toolsTokens
  return {
    systemPrompt: systemPromptTokens,
    messages: messagesTokens,
    tools: toolsTokens,
    summary,
    total,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool result masking — collapse old tool results to save context tokens
// ────────────────────────────────────────────────────────────────────────────

export interface ToolMaskingResult {
  messages: ModelMessage[]
  maskedGroupCount: number
  observationCompactedCount: number
  estimatedTokensSaved: number
}

/** Tool names that produce files or images — keep a one-line summary instead of fully collapsing. */
const FILE_TOOL_NAMES = new Set(['generate_image', 'list_image_models', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'attach_file', 'save_to_storage', 'read_from_storage'])

/**
 * Generate a compact summary for a tool result value that is being collapsed.
 * For image/file tools, keeps a one-line summary of what was produced.
 */
function summarizeToolResultValue(value: unknown, toolName?: string): string {
  // Special handling for image/file tools — keep a meaningful one-liner
  if (toolName && FILE_TOOL_NAMES.has(toolName)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      // Image generation: keep url/path + prompt info
      if (obj.url || obj.path || obj.storagePath) {
        const path = (obj.url ?? obj.path ?? obj.storagePath) as string
        return `[${toolName}: ${path}${obj.prompt ? ` — "${String(obj.prompt).slice(0, 60)}"` : ''}]`
      }
      // File operations: keep path + success/status
      if (obj.success !== undefined) {
        return `[${toolName}: ${obj.path ?? 'done'} — ${obj.success ? 'success' : 'failed'}]`
      }
    }
    // For read_file with string content
    if (typeof value === 'string' && value.length > 100) {
      return `[${toolName}: text content (${value.length} chars). Use tool again if needed.]`
    }
  }

  if (Array.isArray(value)) {
    return `[Collapsed — returned ${value.length} items. Use tool again if needed.]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const keyList = keys.slice(0, 5).join(', ')
    const suffix = keys.length > 5 ? ', ...' : ''
    return `[Collapsed — object with keys: ${keyList}${suffix}. Use tool again if needed.]`
  }
  if (typeof value === 'string' && value.length > 100) {
    return `[Collapsed — text response (${value.length} chars). Use tool again if needed.]`
  }
  // Small primitives are cheap — keep as-is
  return String(value)
}

/**
 * Truncate a tool result value to maxChars, keeping the beginning.
 */
function truncateToolResultValue(value: unknown, maxChars: number): { text: string; savedChars: number } {
  const json = JSON.stringify(value ?? null)
  if (json.length <= maxChars) return { text: json, savedChars: 0 }
  return { text: json.slice(0, maxChars) + ' [truncated]', savedChars: json.length - maxChars }
}

/**
 * Compact a text string: collapse redundant whitespace and truncate if needed.
 */
function compactText(text: string, maxChars: number): { text: string; savedChars: number } {
  // Collapse multiple blank lines and trim excessive whitespace
  let compacted = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
  if (compacted.length <= maxChars) {
    return { text: compacted, savedChars: text.length - compacted.length }
  }
  const savedChars = text.length - maxChars
  compacted = compacted.slice(0, maxChars) + ' [truncated]'
  return { text: compacted, savedChars }
}

/**
 * Progressive context compaction pipeline — applies three zones of compression:
 *
 * 1. **Intact zone** (last `keepLastN` tool groups): fully preserved
 * 2. **Observation zone** (next `observationWindow` turns back): tool results
 *    truncated to `observationMaxChars`, long text trimmed
 * 3. **Collapse zone** (everything older): tool results replaced with one-line
 *    summaries, long text aggressively trimmed
 *
 * Also compacts non-tool messages (user/assistant text) in the observation
 * and collapse zones by collapsing whitespace and truncating.
 *
 * Pure function — returns a new array without mutating the input.
 */
export function maskOldToolResults(
  messages: ModelMessage[],
  keepLastN: number,
  observationWindow: number = 0,
  observationMaxChars: number = 200,
): ToolMaskingResult {
  if (keepLastN < 0) keepLastN = 0

  // 1. Identify all tool call group indices (index of the 'tool' message in each pair)
  const toolGroupIndices: number[] = []
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!
    const curr = messages[i]!
    if (
      prev.role === 'assistant' &&
      Array.isArray(prev.content) &&
      prev.content.some((p: { type: string }) => p.type === 'tool-call') &&
      curr.role === 'tool' &&
      Array.isArray(curr.content)
    ) {
      toolGroupIndices.push(i)
    }
  }

  // Determine zone boundaries for tool groups
  const totalGroups = toolGroupIndices.length
  const intactStart = Math.max(0, totalGroups - keepLastN)
  const observationStart = Math.max(0, intactStart - observationWindow)

  // Classify each tool group index into zones
  const collapseSet = new Set<number>() // fully collapse
  const truncateSet = new Set<number>() // truncate to maxChars
  for (let g = 0; g < totalGroups; g++) {
    if (g < observationStart) {
      collapseSet.add(toolGroupIndices[g]!)
    } else if (g < intactStart) {
      truncateSet.add(toolGroupIndices[g]!)
    }
    // else: intact — no modification
  }

  // Determine the message index boundary for observation compaction of text.
  // Messages before the observation zone boundary get text compaction too.
  // The observation zone starts at the oldest tool group in that zone, or if no
  // tool groups, we use a turn-based heuristic from the end.
  const observationBoundaryIdx = observationStart < totalGroups
    ? toolGroupIndices[observationStart]!
    : Math.max(0, messages.length - (keepLastN + observationWindow) * 2)
  const collapseBoundaryIdx = observationStart > 0
    ? toolGroupIndices[observationStart - 1]! // last collapsed group index
    : -1 // nothing to collapse

  const hasWork = collapseSet.size > 0 || truncateSet.size > 0 || observationBoundaryIdx > 0
  if (!hasWork) {
    return { messages, maskedGroupCount: 0, observationCompactedCount: 0, estimatedTokensSaved: 0 }
  }

  // 2. Build a new message array with progressive compaction
  let tokensSaved = 0
  let maskedGroupCount = 0
  let observationCompactedCount = 0
  const result: ModelMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    // ── Tool result messages: collapse or truncate ──
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      if (collapseSet.has(i)) {
        // COLLAPSE zone: one-line summary
        maskedGroupCount++
        const maskedContent = (msg.content as Array<{ type: string; toolCallId: string; toolName: string; output: { type: string; value: unknown } }>).map((part) => {
          if (part.type !== 'tool-result') return part
          const originalJson = JSON.stringify(part.output?.value ?? null)
          const summary = summarizeToolResultValue(part.output?.value, part.toolName)
          const savedChars = originalJson.length - summary.length
          if (savedChars > 0) tokensSaved += Math.ceil(savedChars / 4)
          return { ...part, output: { type: 'text' as const, value: summary } }
        })
        result.push({ ...msg, content: maskedContent } as ModelMessage)
        continue
      }
      if (truncateSet.has(i)) {
        // OBSERVATION zone: truncate to maxChars
        observationCompactedCount++
        const truncatedContent = (msg.content as Array<{ type: string; toolCallId: string; toolName: string; output: { type: string; value: unknown } }>).map((part) => {
          if (part.type !== 'tool-result') return part
          const { text, savedChars } = truncateToolResultValue(part.output?.value, observationMaxChars)
          if (savedChars > 0) tokensSaved += Math.ceil(savedChars / 4)
          return { ...part, output: { type: 'text' as const, value: text } }
        })
        result.push({ ...msg, content: truncatedContent } as ModelMessage)
        continue
      }
    }

    // ── Non-tool messages: compact text in older zones ──
    if (i < observationBoundaryIdx) {
      const maxTextChars = i <= collapseBoundaryIdx ? 500 : 2000 // tighter in collapse zone
      if (typeof msg.content === 'string' && msg.content.length > maxTextChars) {
        const { text, savedChars } = compactText(msg.content, maxTextChars)
        if (savedChars > 0) {
          tokensSaved += Math.ceil(savedChars / 4)
          observationCompactedCount++
          result.push({ ...msg, content: text } as ModelMessage)
          continue
        }
      }
      // Multi-part content (assistant with text + tool-call): compact text parts only
      if (Array.isArray(msg.content) && msg.role === 'assistant') {
        let modified = false
        const compactedParts = (msg.content as Array<{ type: string; text?: string; [k: string]: unknown }>).map((part) => {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > maxTextChars) {
            const { text, savedChars } = compactText(part.text, maxTextChars)
            if (savedChars > 0) {
              tokensSaved += Math.ceil(savedChars / 4)
              modified = true
              return { ...part, text }
            }
          }
          return part
        })
        if (modified) {
          observationCompactedCount++
          result.push({ ...msg, content: compactedParts } as ModelMessage)
          continue
        }
      }
    }

    result.push(msg)
  }

  return {
    messages: result,
    maskedGroupCount,
    observationCompactedCount,
    estimatedTokensSaved: tokensSaved,
  }
}

/**
 * Abort the active LLM stream for a Kin, if any.
 * Returns true if a stream was aborted, false if none was active.
 */
export function abortKinStream(kinId: string): boolean {
  const controller = activeAbortControllers.get(kinId)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * Abort the active LLM stream for a quick session, if any.
 * Returns true if a stream was aborted, false if none was active.
 */
export function abortQuickSessionStream(sessionId: string): boolean {
  const controller = quickAbortControllers.get(sessionId)
  if (!controller) return false
  controller.abort()
  return true
}

/** Determines whether a follow-up queue item should be auto-delivered to the originating channel */
function shouldAutoDeliverToChannel(queueItem: { messageType: string }): boolean {
  return ['kin_reply', 'task_result', 'wakeup'].includes(queueItem.messageType)
}

/**
 * Process the next message in a Kin's queue.
 * Returns true if a message was processed, false if the queue was empty.
 */
export async function processNextMessage(kinId: string): Promise<boolean> {
  // In-memory lock — prevents overlapping ticks from racing
  if (kinLocks.has(kinId)) return false
  // Don't process while compacting is running
  if (compactingKins.has(kinId)) return false
  kinLocks.add(kinId)

  // Hoisted so the finally block can guarantee cleanup
  let queueItem: Awaited<ReturnType<typeof dequeueMessage>> = null

  try {
    // Don't process if already processing (DB-level check, main slot only)
    if (await isKinProcessing(kinId, 'main')) return false

    queueItem = await dequeueMessage(kinId, 'main')
    if (!queueItem) return false

    log.info({ kinId, queueItemId: queueItem.id, messageType: queueItem.messageType, sourceType: queueItem.sourceType }, 'Processing message')

    // Create an AbortController early so the stream can be cancelled even before
    // the LLM call starts (during prompt building, memory search, etc.)
    const abortController = new AbortController()
    activeAbortControllers.set(kinId, abortController)

    // Notify clients that this Kin started processing
    const pendingCount = await getQueueSize(kinId)
    const processingStartedAt = Date.now()
    sseManager.sendToKin(kinId, {
      type: 'queue:update',
      kinId,
      data: { kinId, queueSize: pendingCount, isProcessing: true, processingStartedAt },
    })

    const kin = await db.select().from(kins).where(eq(kins.id, kinId)).get()
    if (!kin) return false

    // Save the incoming user message to DB (idempotent: skip if already created during a previous attempt)
    let userMessageId: string
    if (queueItem.createdMessageId) {
      // Recovery path: message was already inserted before crash — reuse it
      userMessageId = queueItem.createdMessageId
      log.debug({ kinId, queueItemId: queueItem.id, userMessageId }, 'Reusing existing message from recovered queue item')
    } else {
      userMessageId = uuid()
      // Build the message metadata bag. We merge known reserved keys
      // (resolvedTaskId, isAddendum) with any free-form structured context
      // attached by an enqueuer (e.g. a channel adapter via incoming.metadata).
      // The free-form blob lives under the `channel` key (and other top-level
      // keys reserved by enqueueMessage callers) and is later injected into
      // the LLM prompt by buildMessageHistory.
      const sidebandMetadata = popQueueMessageMetadata(queueItem.id)
      const metaBag: Record<string, unknown> = {}
      if (queueItem.sourceType === 'task' && queueItem.taskId) {
        metaBag.resolvedTaskId = queueItem.taskId
      }
      if (queueItem.messageType === 'user_addendum') {
        metaBag.isAddendum = true
      }
      if (sidebandMetadata) {
        for (const [k, v] of Object.entries(sidebandMetadata)) {
          if (!(k in metaBag)) metaBag[k] = v
        }
      }
      const messageMetadata = Object.keys(metaBag).length > 0 ? JSON.stringify(metaBag) : null
      await db.insert(messages).values({
        id: userMessageId,
        kinId,
        role: 'user',
        content: queueItem.content,
        sourceType: queueItem.sourceType,
        sourceId: queueItem.sourceId,
        requestId: queueItem.requestId,
        inReplyTo: queueItem.inReplyTo,
        channelOriginId: queueItem.channelOriginId ?? null,
        metadata: messageMetadata,
        createdAt: new Date(),
      })
      // Record the created message ID on the queue item for crash recovery
      sqlite.run(
        `UPDATE queue_items SET created_message_id = ? WHERE id = ?`,
        [userMessageId, queueItem.id],
      )
    }

    // Link uploaded files to the actual message (fileIds come through the queue sideband)
    if (queueItem.fileIds && queueItem.fileIds.length > 0) {
      await linkFilesToMessage(queueItem.fileIds, userMessageId)
    }

    // Emit SSE so the web UI shows the incoming message immediately.
    // Skip 'user' sourceType (web UI) since those are already handled by optimistic updates.
    if (queueItem.sourceType !== 'user') {
      const fileList = queueItem.fileIds && queueItem.fileIds.length > 0
        ? await getFilesForMessage(userMessageId)
        : []

      // Channel inbound enrichment: surface the adapter-provided contextLine
      // and the platform brand metadata so the UI can render the brand accent
      // immediately, without waiting for the next fetchMessages refresh.
      let channelContextLine: string | null = null
      let channelMeta: { platform: string; displayName: string; brandColor: string | null } | null = null
      if (queueItem.sourceType === 'channel' && queueItem.sourceId) {
        // Read what we just persisted (covers both fresh insert and recovery paths).
        try {
          const row = db
            .select({ metadata: messages.metadata })
            .from(messages)
            .where(eq(messages.id, userMessageId))
            .get()
          if (row?.metadata) {
            try {
              const m = JSON.parse(row.metadata as string) as Record<string, unknown>
              if (typeof m.channelContextLine === 'string') channelContextLine = m.channelContextLine
            } catch { /* corrupted metadata, ignore */ }
          }
        } catch { /* ignore */ }
        try {
          const row = db
            .select({ platform: channels.platform })
            .from(channels)
            .where(eq(channels.id, queueItem.sourceId))
            .get()
          if (row?.platform) {
            const adapter = channelAdapters.get(row.platform)
            channelMeta = {
              platform: row.platform,
              displayName: adapter?.meta?.displayName ?? row.platform,
              brandColor: adapter?.meta?.brandColor ?? null,
            }
          }
        } catch { /* best-effort enrichment, ignore failures */ }
      }

      sseManager.sendToKin(kinId, {
        type: 'chat:message',
        kinId,
        data: {
          id: userMessageId,
          role: 'user',
          content: queueItem.content,
          sourceType: queueItem.sourceType,
          sourceId: queueItem.sourceId ?? null,
          sourceName: null,
          sourceAvatarUrl: null,
          files: fileList,
          resolvedTaskId: queueItem.sourceType === 'task' && queueItem.taskId ? queueItem.taskId : null,
          channelContextLine,
          channelMeta,
          createdAt: Date.now(),
        },
      })
    }

    // Get user language and speaker profile
    let userLanguage: 'fr' | 'en' = 'fr'
    let currentSpeaker: {
      firstName: string | null
      lastName: string | null
      pseudonym: string
      role: string
      contactId?: string
      contactNotes?: string[]   // Global notes (visible to all Kins)
      kinNotes?: string[]       // Private notes (this Kin only)
      userNotes?: string[]      // Notes from the platform user(s) — read-only
    } | undefined

    // Helper: enrich speaker data with contact notes (global + per-Kin + user-authored)
    const enrichSpeakerFromContact = (speakerData: NonNullable<typeof currentSpeaker>, contactId: string) => {
      speakerData.contactId = contactId
      const allNotes = db
        .select({ content: contactNotesTable.content, scope: contactNotesTable.scope, kinId: contactNotesTable.kinId })
        .from(contactNotesTable)
        .where(eq(contactNotesTable.contactId, contactId))
        .all()
      const globalNotes = allNotes.filter((n) => n.scope === 'global').map((n) => n.content)
      const kinNotes = allNotes.filter((n) => n.scope === 'private' && n.kinId === kinId).map((n) => n.content)
      const userNotes = allNotes.filter((n) => n.scope === 'user').map((n) => n.content)
      if (globalNotes.length > 0) speakerData.contactNotes = globalNotes
      if (kinNotes.length > 0) speakerData.kinNotes = kinNotes
      if (userNotes.length > 0) speakerData.userNotes = userNotes
    }

    if (queueItem.sourceType === 'user' && queueItem.sourceId) {
      const profile = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, queueItem.sourceId))
        .get()
      if (profile) {
        userLanguage = profile.language as 'fr' | 'en'
        const speakerData: NonNullable<typeof currentSpeaker> = {
          firstName: profile.firstName,
          lastName: profile.lastName,
          pseudonym: profile.pseudonym,
          role: profile.role,
        }
        const linkedContact = findContactByLinkedUserId(queueItem.sourceId)
        if (linkedContact) {
          enrichSpeakerFromContact(speakerData, linkedContact.id)
        }
        currentSpeaker = speakerData
      }
    }

    // Only propagate userId when the source is actually a user (not a kin or task)
    const effectiveUserId = queueItem.sourceType === 'user' ? (queueItem.sourceId ?? undefined) : undefined

    // Execute beforeChat hook
    await hookRegistry.execute('beforeChat', {
      kinId,
      userId: effectiveUserId,
      message: queueItem.content,
    })

    // Build system prompt
    // Fetch all global contacts with slug resolution and identifier summaries
    const contactsWithSlug = await listContactsForPrompt()

    // Fetch kin directory for inter-kin communication
    const kinDirectory = (await listAvailableKins(kinId)).map((k) => ({
      slug: k.slug,
      name: k.name,
      role: k.role,
    }))

    // Retrieve relevant memories via hybrid search (semantic + FTS5)
    // If contextual rewriting is enabled, enrich short/ambiguous queries with conversation context
    let relevantMemories: Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; updatedAt: Date | null; score: number }> = []
    try {
      let memoryQuery = queueItem.content
      if (config.memory.contextualRewriteModel) {
        // Fetch last few messages for context (lightweight — only content + role, limit 6)
        const recentMsgs = await db
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(and(eq(messages.kinId, kinId), isNull(messages.taskId), isNull(messages.sessionId)))
          .orderBy(desc(messages.createdAt))
          .limit(6)
          .all()
        // Reverse to chronological, exclude the current message (already inserted above), filter nulls
        const contextMsgs = recentMsgs
          .reverse()
          .slice(0, -1) // drop last (= current user message)
          .filter((m) => m.content)
          .map((m) => ({ role: m.role, content: m.content! }))
        memoryQuery = await rewriteQueryWithContext(queueItem.content, contextMsgs, kinId)
      }
      relevantMemories = await getRelevantMemories(kinId, memoryQuery)
    } catch {
      // Memory retrieval failure is non-fatal — proceed without memories
    }

    // Retrieve relevant knowledge base chunks
    let relevantKnowledge: Array<{ content: string; sourceId: string; score: number }> = []
    try {
      const { searchKnowledge } = await import('@/server/services/knowledge')
      relevantKnowledge = await searchKnowledge(kinId, queueItem.content, 5)
    } catch {
      // Knowledge retrieval failure is non-fatal
    }

    // Resolve MCP tool summaries for system prompt injection
    const mcpToolsSummary = await getMCPToolsSummary(kinId)

    // Fetch active channels for prompt context
    const activeChannelRows = await getActiveChannelsForKin(kinId)
    const activeChannels = activeChannelRows.map((ch) => ({ platform: ch.platform, name: ch.name }))

    const globalPrompt = await getGlobalPrompt()

    // Detect Hub status and build enriched directory if needed
    const hubKinId = await getHubKinId()
    const isHub = hubKinId === kinId

    let hubKinDirectory: Array<{ slug: string | null; name: string; role: string; expertiseSummary: string; activeChannels?: string[] }> | undefined
    if (isHub) {
      const otherKins = db
        .select({ id: kins.id, slug: kins.slug, name: kins.name, role: kins.role, expertise: kins.expertise })
        .from(kins)
        .where(ne(kins.id, kinId))
        .all()

      hubKinDirectory = await Promise.all(
        otherKins.map(async (k) => {
          const kinChannels = await getActiveChannelsForKin(k.id)
          return {
            slug: k.slug,
            name: k.name,
            role: k.role,
            expertiseSummary: k.expertise.length > 300
              ? k.expertise.slice(0, 300) + '...'
              : k.expertise,
            activeChannels: kinChannels.length > 0
              ? kinChannels.map((ch) => `${ch.platform}: "${ch.name}"`)
              : undefined,
          }
        }),
      )
    }

    // Build message history (also returns compacting summaries for system prompt injection)
    const { messages: messageHistory, compactingSummaries: compactingSummariesData, participants, visibleMessageCount, totalMessageCount, hasCompactedHistory, oldestVisibleMessageAt, maskedToolGroups, observationCompactedCount, estimatedTokensSavedByMasking, emergencyTrimmedCount, trimmedToolResultsCount, trimmedToolResultsTokensSaved, trimmedToolCallArgsCount, trimmedToolCallArgsTokensSaved, trimmedAssistantContentCount, trimmedAssistantContentTokensSaved, trimmedUserContentCount, trimmedUserContentTokensSaved } = await buildMessageHistory(kinId)

    // Resolve the current message's originating platform for formatting hints
    let currentMessageSource: { platform: string; senderName?: string } | undefined
    if (queueItem.sourceType === 'channel') {
      const meta = getChannelQueueMeta(queueItem.id)
      if (meta) {
        const ch = await getChannel(meta.channelId)
        if (ch) {
          currentMessageSource = { platform: ch.platform }
          // Extract sender name from message prefix "[platform:Name] ..."
          const prefixMatch = queueItem.content.match(/^\[[\w-]+:([^\]]+)\]/)
          if (prefixMatch?.[1]) {
            currentMessageSource.senderName = prefixMatch[1].trim()
          }
          // Resolve channel sender to contact for speaker profile
          if (!currentSpeaker) {
            const channelContact = findContactByPlatformId(ch.platform, meta.platformUserId)
            if (channelContact) {
              const contactDisplay = getContactDisplayName({
                firstName: channelContact.firstName,
                lastName: channelContact.lastName,
              })
              const senderName = currentMessageSource.senderName
                ?? (contactDisplay !== 'Unnamed contact' ? contactDisplay : 'Unknown')
              const speakerData = {
                firstName: channelContact.firstName,
                lastName: channelContact.lastName,
                pseudonym: senderName,
                role: 'external',
              }
              enrichSpeakerFromContact(speakerData, channelContact.id)
              currentSpeaker = speakerData
            }
          }
        }
      }
    } else if (queueItem.sourceType === 'user') {
      currentMessageSource = { platform: 'web' }
    }

    // Resolve channel origin context for non-channel turns (inter-Kin reply, task result, etc.)
    let pendingChannelContext: { platform: string; senderName: string; channelId: string } | undefined
    if (queueItem.sourceType !== 'channel' && queueItem.sourceType !== 'user' && queueItem.channelOriginId) {
      const originMeta = getChannelOriginMeta(queueItem.channelOriginId)
      if (originMeta) {
        const originChannel = await getChannel(originMeta.channelId)
        if (originChannel) {
          pendingChannelContext = {
            platform: originChannel.platform,
            senderName: 'user',
            channelId: originMeta.channelId,
          }
        }
      }
    }

    const systemSegments = buildSystemPrompt({
      kin: { name: kin.name, slug: kin.slug, role: kin.role, character: kin.character, expertise: kin.expertise },
      contacts: contactsWithSlug,
      relevantMemories,
      relevantKnowledge,
      kinDirectory,
      mcpTools: mcpToolsSummary,
      isSubKin: false,
      activeChannels: activeChannels.length > 0 ? activeChannels : undefined,
      globalPrompt,
      userLanguage,
      isHub,
      hubKinDirectory,
      compactingSummaries: compactingSummariesData,
      participants: participants.length > 0 ? participants : undefined,
      currentMessageSource,
      pendingChannelContext,
      currentSpeaker,
      conversationState: {
        visibleMessageCount,
        totalMessageCount,
        hasCompactedHistory,
        oldestVisibleMessageAt,
      },
      workspacePath: kin.workspacePath,
    })
    const systemPrompt = joinSystemPrompt(systemSegments)

    // ── E2E Mock LLM: stream a fake response without calling any provider ──
    if (process.env.E2E_MOCK_LLM === 'true') {
      const mockResponse = 'Great question! Fresh basil, oregano, rosemary, and thyme are the cornerstones of Italian cooking. Parsley and sage are also essential — together they bring depth to sauces, soups, and roasted dishes.'
      const mockAssistantId = uuid()
      const tokens = mockResponse.split(' ')
      for (const token of tokens) {
        sseManager.sendToKin(kinId, {
          type: 'chat:token',
          kinId,
          data: { kinId, messageId: mockAssistantId, token: token + ' ' },
        })
        await new Promise((r) => setTimeout(r, 50))
      }
      await db.insert(messages).values({
        id: mockAssistantId,
        kinId,
        role: 'assistant',
        content: mockResponse,
        sourceType: 'kin',
        createdAt: new Date(),
      })
      sseManager.sendToKin(kinId, {
        type: 'chat:done',
        kinId,
        data: { kinId, messageId: mockAssistantId },
      })
      sseManager.sendToKin(kinId, {
        type: 'queue:update',
        kinId,
        data: { kinId, queueSize: 0, isProcessing: false },
      })
      return true
    }

    // Resolve LLM model
    const model = await resolveLLMModel(kin.model, kin.providerId)
    if (!model) {
      log.warn({ kinId, modelId: kin.model }, 'No LLM provider available')
      sseManager.sendToKin(kinId, {
        type: 'kin:error',
        kinId,
        data: { error: 'No LLM provider available for this model' },
      })
      import('@/server/services/notifications').then(({ createNotification }) =>
        createNotification({ type: 'kin:error', title: 'Kin error', body: 'No LLM provider available for this model', kinId, relatedId: kinId, relatedType: 'kin' }),
      ).catch(() => {})
      return true
    }

    // Resolve tools for this Kin's context (native + MCP), filtered by toolConfig
    const toolConfig: KinToolConfig | null = kin.toolConfig
      ? JSON.parse(kin.toolConfig)
      : null

    // Resolve thinking config for this Kin (defaults to enabled if never configured)
    const thinkingConfig = resolveThinkingConfig(kin.thinkingConfig)
    const providerType = guessProviderType(kin.model) ?? kin.providerId ?? ''
    const thinkingProviderOptions = buildThinkingProviderOptions(providerType, thinkingConfig)

    const nativeTools = toolRegistry.resolve({
      kinId,
      userId: effectiveUserId,
      isSubKin: false,
      channelOriginId: queueItem.channelOriginId ?? undefined,
    })

    // Filter disabled native tools (deny-list)
    if (toolConfig?.disabledNativeTools?.length) {
      for (const name of toolConfig.disabledNativeTools) {
        delete nativeTools[name]
      }
    }

    // Filter out defaultDisabled tools not explicitly opted-in
    // Hub Kin gets ALL opt-in tools automatically
    if (!isHub) {
      const allRegistered = toolRegistry.list()
      const optInSet = new Set(toolConfig?.enabledOptInTools ?? [])
      for (const reg of allRegistered) {
        if (reg.defaultDisabled && !optInSet.has(reg.name)) {
          delete nativeTools[reg.name]
        }
      }
    }

    const mcpTools = await resolveMCPTools(kinId, toolConfig)
    const customToolDefs = await resolveCustomTools(kinId)
    const mergedTools = { ...nativeTools, ...mcpTools, ...customToolDefs }

    // When processing a kin_reply, remove inter-kin tools to prevent ping-pong
    if (queueItem.messageType === 'kin_reply') {
      delete mergedTools['send_message']
      delete mergedTools['reply']
      delete mergedTools['list_kins']
    }

    // Wrap tools to spill large results to temp files, then enforce sequential execution
    const tools = capTools(wrapToolsWithSpill(mergedTools, kin.workspacePath), kinId, providerType)

    const hasTools = Object.keys(tools).length > 0

    // Estimate total context tokens and resolve model context window
    const summaryTokens = compactingSummariesData
      ? compactingSummariesData.reduce((sum, s) => sum + estimateTokens(s.summary), 0)
      : 0
    const contextBreakdown = estimateContextTokens(systemPrompt, messageHistory, hasTools ? tools : undefined, summaryTokens)
    const contextTokens = contextBreakdown.total
    const contextWindow = getModelContextWindow(kin.model)
    const pipelineStatus: ContextPipelineStatus = {
      maskedToolGroups,
      observationCompactedCount,
      estimatedTokensSavedByMasking,
      emergencyTrimmedCount,
      trimmedToolResultsCount,
      trimmedToolResultsTokensSaved,
      trimmedToolCallArgsCount,
      trimmedToolCallArgsTokensSaved,
      trimmedAssistantContentCount,
      trimmedAssistantContentTokensSaved,
      trimmedUserContentCount,
      trimmedUserContentTokensSaved,
    }
    setLastContextUsage(kinId, contextTokens, contextWindow, contextBreakdown, pipelineStatus)
    log.debug({ kinId, toolCount: Object.keys(tools).length, modelId: kin.model, contextTokens, contextWindow }, 'Starting LLM stream')

    // Compute compacting proximity and cache it for lightweight SSE events
    const { getCompactingProximity } = await import('@/server/services/compacting')
    const compactingData = await getCompactingProximity(kinId)
    lastCompactingProximity.set(kinId, {
      compactingPercent: compactingData.currentPercent,
      compactingThresholdPercent: compactingData.thresholdPercent,
      summaryCount: compactingData.summaryCount,
    })

    // Update the queue event with real context usage (the initial queue:update
    // was sent before system prompt/tools were built — now we have the full picture)
    const preCallUsage = lastContextUsage.get(kinId)
    sseManager.sendToKin(kinId, {
      type: 'queue:update',
      kinId,
      data: {
        kinId, queueSize: 0, isProcessing: true, processingStartedAt,
        // Always send both: contextTokens is the local BPE estimate (drives
        // the breakdown bar), apiContextTokens is the provider ground truth
        // from the previous turn (drives the real bar). Frontend renders
        // whichever exist independently.
        contextTokens,
        apiContextTokens: preCallUsage?.apiContextTokens,
        contextWindow,
        contextBreakdown,
        pipelineStatus,
        ...lastCompactingProximity.get(kinId),
      },
    })

    // Send typing indicator on the channel when LLM processing starts (fire-and-forget)
    if (queueItem.sourceType === 'channel') {
      const meta = getChannelQueueMeta(queueItem.id)
      if (meta) {
        const ch = await getChannel(meta.channelId)
        if (ch) {
          const chAdapter = channelAdapters.get(ch.platform)
          if (chAdapter?.sendTypingIndicator) {
            const chCfg = JSON.parse(ch.platformConfig) as Record<string, unknown>
            chAdapter.sendTypingIndicator(ch.id, chCfg, meta.platformChatId).catch(() => {})
          }
        }
      }
    }

    // Call LLM with streaming — custom single-step loop to prevent hallucinated
    // tool results. The SDK's multi-step loop generates text referencing tool
    // results before tools actually execute. Our loop calls streamText() one step
    // at a time, executes tools sequentially between steps, then feeds real
    // results back to the LLM.
    const assistantMessageId = uuid()
    let fullContent = ''
    const reasoningSegments: Array<{ offset: number; text: string }> = []
    let currentReasoning = ''
    const toolCallsLog: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }> = []

    // Strip execute functions from tools so the SDK only collects intents
    // (we execute tools ourselves between steps), then mark the last tool as
    // cache-eligible for Anthropic prompt caching.
    const toolSchemas = hasTools ? markLastToolCacheable(stripToolExecute(tools)) : undefined

    const maxSteps = hasTools ? (config.tools.maxSteps > 0 ? config.tools.maxSteps : 100) : 1
    let wasAborted = false
    let silentStopAfterTools = false
    const stepResults: Array<ReturnType<typeof streamText>> = []

    let step = 0
    for (; step < maxSteps; step++) {
      if (abortController.signal.aborted) { wasAborted = true; break }

      const result = streamText({
        model,
        messages: buildSegmentedMessages(systemSegments, messageHistory),
        tools: toolSchemas,
        abortSignal: abortController.signal,
        ...(thinkingProviderOptions ? { providerOptions: thinkingProviderOptions as any } : {}),
      })
      stepResults.push(result)

      // Collect tool call intents from this step
      const stepToolCalls: Array<{ id: string; name: string; args: unknown; offset: number }> = []
      // Per-step text. fullContent keeps accumulating across steps for
      // persistence, offset math, and UI rendering, but only stepText is
      // pushed into the assistant history block so the model never sees
      // its own prior-step narration repeated back to it.
      let stepText = ''

      try {
        for await (const part of result.fullStream) {
          // Handle tool-call-streaming-start (not yet in AI SDK type union)
          if ((part.type as string) === 'tool-call-streaming-start') {
            const p = part as unknown as { toolCallId: string; toolName: string }
            sseManager.sendToKin(kinId, {
              type: 'chat:tool-call-start',
              kinId,
              data: {
                messageId: assistantMessageId,
                toolCallId: p.toolCallId,
                toolName: p.toolName,
                contentOffset: fullContent.length,
              },
            })
            continue
          }

          // Handle reasoning/thinking stream parts
          if ((part.type as string) === 'reasoning-start') {
            currentReasoning = ''
            continue
          }
          if ((part.type as string) === 'reasoning-delta') {
            const p = part as unknown as { text: string }
            currentReasoning += p.text
            sseManager.sendToKin(kinId, {
              type: 'chat:reasoning-token',
              kinId,
              data: { messageId: assistantMessageId, token: p.text },
            })
            continue
          }
          if ((part.type as string) === 'reasoning-end') {
            if (currentReasoning) {
              reasoningSegments.push({ offset: fullContent.length, text: currentReasoning })
              currentReasoning = ''
            }
            sseManager.sendToKin(kinId, {
              type: 'chat:reasoning-done',
              kinId,
              data: { messageId: assistantMessageId },
            })
            continue
          }

          switch (part.type) {
            case 'text-delta': {
              const isFirstToken = fullContent.length === 0
              fullContent += part.text
              stepText += part.text
              sseManager.sendToKin(kinId, {
                type: 'chat:token',
                kinId,
                data: {
                  messageId: assistantMessageId,
                  token: part.text,
                  // Include source metadata on first token so the client can
                  // render correct attribution from the start
                  ...(isFirstToken && {
                    sourceType: 'kin',
                    sourceId: kinId,
                    sourceName: kin.name,
                    sourceAvatarUrl: kin.avatarPath ? `/api/uploads/kins/${kin.id}/avatar.${kin.avatarPath.split('.').pop()}` : null,
                  }),
                },
              })
              break
            }

            case 'tool-call': {
              const contentOffset = fullContent.length
              stepToolCalls.push({
                id: part.toolCallId,
                name: part.toolName,
                args: part.input,
                offset: contentOffset,
              })
              sseManager.sendToKin(kinId, {
                type: 'chat:tool-call',
                kinId,
                data: {
                  messageId: assistantMessageId,
                  toolCallId: part.toolCallId,
                  toolName: part.toolName,
                  args: part.input,
                  contentOffset,
                },
              })
              break
            }

            case 'error': {
              // API-level errors (e.g. context_length_exceeded) arrive as stream parts,
              // not as thrown exceptions. Re-throw so the outer catch handles them
              // with proper user-visible feedback.
              const err = part.error
              if (err instanceof Error) throw err
              throw new Error(extractApiErrorMessage(err))
            }

            default:
              log.debug({ kinId, partType: part.type }, 'Unhandled stream part type')
          }
        }
      } catch (streamError) {
        // If the stream was aborted (user pressed Stop), handle gracefully
        if (abortController.signal.aborted) {
          wasAborted = true
        } else {
          throw streamError
        }
      }

      // No tool calls this step → LLM is done, exit loop.
      // Silent-stop detection: provider closed the stream with no text and no
      // tool calls at this step, AFTER at least one prior tool batch executed
      // and the overall turn produced no text either. The model has effectively
      // given up without a final answer (observed on very large contexts with
      // thinking models). Flag here, write the fallback after the loop.
      if (stepToolCalls.length === 0 || wasAborted) {
        if (!wasAborted && toolCallsLog.length > 0 && fullContent.length === 0) {
          silentStopAfterTools = true
        }
        break
      }

      // Build assistant content for history
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      if (stepText) assistantContent.push({ type: 'text', text: stepText })
      for (const tc of stepToolCalls) {
        assistantContent.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args })
      }

      // Execute tool calls (concurrently if all read-only, sequentially otherwise)
      const batch = await executeToolBatch({
        stepToolCalls,
        tools,
        abortController,
        kinId,
        assistantMessageId,
      })
      toolCallsLog.push(...batch.toolCallsLog)
      if (batch.wasAborted) { wasAborted = true; break }

      // Append assistant message (with tool calls) + tool results to history for next step
      messageHistory.push({ role: 'assistant', content: assistantContent })
      messageHistory.push({ role: 'tool' as const, content: batch.toolResults })

      // Text accumulates across steps so tool call offsets remain valid
    }

    activeAbortControllers.delete(kinId)

    // Aggregate token usage (awaited so we can persist in metadata + SSE)
    const tokenUsage = await aggregateStepUsage(stepResults)

    // Replace the pre-call BPE estimate with the provider-reported peak step
    // input — ground truth for the live banner. The estimator stays the
    // source on the very first turn (before any API roundtrip).
    if (tokenUsage?.peakStepInputTokens) {
      recordApiContextSize(kinId, tokenUsage.peakStepInputTokens)
    }

    // Fire-and-forget: record to llm_usage table for analytics
    if (tokenUsage) {
      recordUsage({
        callSite: 'chat',
        callType: 'stream-text',
        providerType: guessProviderType(kin.model),
        providerId: kin.providerId,
        modelId: kin.model,
        kinId,
        usage: {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
          inputTokenDetails: { cacheReadTokens: tokenUsage.cacheReadTokens ?? 0, cacheWriteTokens: tokenUsage.cacheWriteTokens ?? 0 },
          outputTokenDetails: { reasoningTokens: tokenUsage.reasoningTokens ?? 0 },
        },
        stepCount: stepResults.length,
      })

      // Log cache hit/miss to make prompt-caching effectiveness observable.
      // Always emit (even when cache is 0/0) so a missing log = misconfigured
      // pipeline, not just a cold cache.
      const cacheRead = tokenUsage.cacheReadTokens ?? 0
      const cacheWrite = tokenUsage.cacheWriteTokens ?? 0
      log.info({
        kinId, modelId: kin.model,
        inputTokens: tokenUsage.inputTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        cacheHitRatio: tokenUsage.inputTokens
          ? +(cacheRead / tokenUsage.inputTokens).toFixed(2)
          : null,
      }, 'Prompt cache stats')
    }

    log.info({ kinId, messageId: assistantMessageId, contentLength: fullContent.length, toolCalls: toolCallsLog.length, wasAborted, silentStopAfterTools }, 'LLM turn completed')

    // Surface silent-stop: the provider closed the stream with no text after
    // tool execution. Produce a user-visible fallback so the row is not
    // persisted as empty (Anthropic also rejects empty text content blocks
    // on the next turn, which would block the conversation entirely).
    if (silentStopAfterTools) {
      log.warn(
        { kinId, messageId: assistantMessageId, toolCalls: toolCallsLog.length, step },
        'LLM closed stream with no text after tool execution (silent stop)',
      )
      fullContent = `*(J'ai exécuté ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} mais le modèle n'a pas produit de réponse finale. Cela arrive parfois sur de très gros contextes. Demande-moi de continuer ou de résumer.)*`
      sseManager.sendToKin(kinId, {
        type: 'chat:token',
        kinId,
        data: {
          messageId: assistantMessageId,
          token: fullContent,
          isFirst: true,
        },
      })
    }

    // Detect truncated turns: tool calls executed but the step limit was hit before
    // the LLM could produce a final text-only response.
    const stepLimitReached = step >= maxSteps && toolCallsLog.length > 0 && !wasAborted && config.tools.maxSteps > 0
    if (stepLimitReached) {
      log.warn(
        { kinId, messageId: assistantMessageId, toolCalls: toolCallsLog.length, maxSteps: config.tools.maxSteps },
        'LLM turn produced tool calls but no text content (step limit truncation)',
      )
      fullContent = `*(Completed ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} but the response was truncated due to the tool step limit of ${config.tools.maxSteps}. You can ask me to continue or summarize the results.)*`
      sseManager.sendToKin(kinId, {
        type: 'chat:token',
        kinId,
        data: {
          messageId: assistantMessageId,
          token: fullContent,
          isFirst: true,
        },
      })
    }

    // Save assistant message (partial if aborted) with tool call metadata.
    // Do NOT persist when the row would carry no text AND no tool calls:
    // Anthropic rejects empty text content blocks ("text content blocks
    // must be non-empty") on the next turn, which permanently blocks the
    // conversation until the empty row is removed. The chat:done SSE below
    // still fires so the UI exits its typing state cleanly.
    if (fullContent || toolCallsLog.length > 0) {
      await db.insert(messages).values({
        id: assistantMessageId,
        kinId,
        role: 'assistant',
        content: fullContent || '',
        sourceType: 'kin',
        sourceId: kinId,
        toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        channelOriginId: queueItem.channelOriginId ?? null,
        reasoning: reasoningSegments.length > 0 ? JSON.stringify(reasoningSegments) : null,
        metadata: (() => {
          const meta: Record<string, unknown> = {}
          if (relevantMemories.length > 0) meta.injectedMemories = relevantMemories
          if (stepLimitReached) {
            meta.stepLimitReached = true
            meta.maxSteps = config.tools.maxSteps
            meta.toolCallCount = toolCallsLog.length
          }
          if (tokenUsage) meta.tokenUsage = tokenUsage
          return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
        })(),
        createdAt: new Date(),
      })
    }

    // Emit chat:done SSE event (include source metadata so the client can
    // attribute the message correctly without waiting for fetchMessages)
    sseManager.sendToKin(kinId, {
      type: 'chat:done',
      kinId,
      data: {
        messageId: assistantMessageId,
        content: fullContent,
        sourceType: 'kin',
        sourceId: kinId,
        sourceName: kin.name,
        sourceAvatarUrl: kin.avatarPath ? `/api/uploads/kins/${kin.id}/avatar.${kin.avatarPath.split('.').pop()}` : null,
        ...(stepLimitReached ? { stepLimitReached: true } : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
      },
    })

    if (!wasAborted) {
      // Execute afterChat hook
      await hookRegistry.execute('afterChat', {
        kinId,
        userId: effectiveUserId,
        message: queueItem.content,
        response: fullContent,
      })

      // Emit event
      eventBus.emit({
        type: 'kin.message.sent',
        data: { kinId, messageId: assistantMessageId },
        timestamp: Date.now(),
      })

      // Channel response delivery (fire-and-forget)
      if (queueItem.sourceType === 'channel' && fullContent) {
        // Direct channel response: one-shot pop of channel queue meta
        const channelMeta = popChannelQueueMeta(queueItem.id)
        if (channelMeta) {
          const stagedFiles = popStagedAttachments(kinId)
          deliverChannelResponse(channelMeta, assistantMessageId, fullContent, stagedFiles.length > 0 ? stagedFiles : undefined).catch((err) => {
            log.error({ kinId, channelId: channelMeta.channelId, err }, 'Channel response delivery failed')
          })
        } else {
          clearStagedAttachments(kinId)
        }
      } else if (queueItem.channelOriginId && fullContent && shouldAutoDeliverToChannel(queueItem)) {
        // Follow-up auto-delivery: this turn is part of a causal chain from an external channel
        const originMeta = getChannelOriginMeta(queueItem.channelOriginId)
        if (originMeta) {
          const stagedFiles = popStagedAttachments(kinId)
          deliverChannelResponse(
            { channelId: originMeta.channelId, platformChatId: originMeta.platformChatId, platformMessageId: originMeta.platformMessageId, platformUserId: originMeta.platformUserId },
            assistantMessageId,
            fullContent,
            stagedFiles.length > 0 ? stagedFiles : undefined,
          ).catch((err) => {
            log.error({ kinId, channelOriginId: queueItem!.channelOriginId, err }, 'Follow-up channel delivery failed')
          })
        } else {
          clearStagedAttachments(kinId)
        }
      } else {
        clearStagedAttachments(kinId)
      }

      // Mention notifications (fire-and-forget)
      if (fullContent) {
        parseMentions(fullContent).then((mentions) => {
          if (mentions.length > 0) {
            notifyMentionedUsers(mentions, kinId, assistantMessageId, kin.name).catch(() => {})
          }
        }).catch(() => {})
      }
    } else {
      // Aborted — clear any staged attachments
      clearStagedAttachments(kinId)
    }

    await markQueueItemDone(queueItem.id)

    if (!wasAborted) {
      // Trigger compacting if thresholds are exceeded (non-blocking, with lock)
      ;(async () => {
        compactingKins.add(kinId)
        try {
          await maybeCompact(kinId, contextTokens, contextWindow)
        } catch (err) {
          log.error({ kinId, err }, 'Post-turn compacting error')
        } finally {
          compactingKins.delete(kinId)
        }
      })()
    }

    // Emit queue update with the post-turn cached context. apiContextTokens
    // was just refreshed by recordApiContextSize (if usage data came back),
    // so the navbar picks up the ground-truth value here.
    const remainingQueue = await getQueueSize(kinId)
    const postTurnUsage = lastContextUsage.get(kinId)
    sseManager.sendToKin(kinId, {
      type: 'queue:update',
      kinId,
      data: {
        kinId,
        queueSize: remainingQueue,
        isProcessing: false,
        contextTokens: postTurnUsage?.contextTokens,
        apiContextTokens: postTurnUsage?.apiContextTokens,
        contextWindow: postTurnUsage?.contextWindow,
      },
    })

    return true
  } catch (error) {
    activeAbortControllers.delete(kinId)

    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    const displayError = friendlyErrorMessage(errorMsg)

    log.error({ kinId, error: errorMsg }, 'Kin engine error')

    // Recovery: if the main LLM call failed because the prompt exceeded the
    // model's context window (a state we should normally avoid via the 75%
    // compacting threshold, but reachable when compacting itself failed in a
    // previous turn), trigger a forced compacting in the background so the
    // user can retry without manual intervention.
    if (isContextTooLargeError(errorMsg)) {
      // Skip recovery if compacting is already running for this Kin — racing
      // would risk duplicate summaries (both reading the same message range)
      // AND the recovery's `finally` would clear the lock the other path
      // depends on. The in-flight compacting will deal with it.
      if (compactingKins.has(kinId)) {
        log.info({ kinId }, 'Prompt-too-long detected but compacting already in progress — skipping recovery trigger')
      } else {
        log.warn({ kinId }, 'Main turn failed with prompt-too-long — triggering recovery compacting')
        ;(async () => {
          compactingKins.add(kinId)
          try {
            // Re-fetch the Kin since `kin` was scoped to the try block.
            const recoveryKin = await db.select({ model: kins.model }).from(kins).where(eq(kins.id, kinId)).get()
            if (!recoveryKin) return
            const ctxWindow = getModelContextWindow(recoveryKin.model)
            const cached = lastContextUsage.get(kinId)
            await maybeCompact(kinId, cached?.apiContextTokens ?? cached?.contextTokens, ctxWindow)
          } catch (err) {
            log.error({ kinId, err }, 'Recovery compacting after prompt-too-long failed')
          } finally {
            compactingKins.delete(kinId)
          }
        })()
      }
    }

    // Send error as a system message visible in the chat
    const errorMessageId = uuid()
    await db.insert(messages).values({
      id: errorMessageId,
      kinId,
      role: 'assistant',
      content: `⚠️ ${displayError}`,
      sourceType: 'system',
      createdAt: new Date(),
    })

    sseManager.sendToKin(kinId, {
      type: 'chat:message',
      kinId,
      data: {
        id: errorMessageId,
        role: 'assistant',
        content: `⚠️ ${displayError}`,
        sourceType: 'system',
        createdAt: Date.now(),
      },
    })

    sseManager.sendToKin(kinId, {
      type: 'kin:error',
      kinId,
      data: { error: displayError },
    })
    import('@/server/services/notifications').then(({ createNotification }) =>
      createNotification({ type: 'kin:error', title: 'Kin error', body: displayError, kinId, relatedId: kinId, relatedType: 'kin' }),
    ).catch(() => {})

    // Emit queue update to clear processing state on error
    sseManager.sendToKin(kinId, {
      type: 'queue:update',
      kinId,
      data: { kinId, queueSize: 0, isProcessing: false },
    })

    return true
  } finally {
    // Safety net: guarantee queue item is marked done regardless of exit path.
    // markQueueItemDone is idempotent — safe to call even if already done above.
    if (queueItem) {
      await markQueueItemDone(queueItem.id).catch((err) =>
        log.error({ kinId, err }, 'Failed to mark queue item done in finally'),
      )
    }
    kinLocks.delete(kinId)
  }
}

// ─── Quick Session Tools Exclusion List ───────────────────────────────────

const QUICK_SESSION_EXCLUDED_TOOLS = new Set([
  // Spawning / Tasks
  'spawn_self', 'spawn_kin', 'respond_to_task', 'cancel_task', 'list_tasks',
  'report_to_parent', 'update_task_status', 'request_input',
  // Inter-Kin
  'send_message', 'reply', 'list_kins',
  // Crons
  'create_cron', 'update_cron', 'delete_cron', 'list_crons', 'get_cron_journal',
  // MCP management
  'add_mcp_server', 'update_mcp_server', 'remove_mcp_server', 'list_mcp_servers',
  // Custom tools management
  'register_tool', 'list_custom_tools',
  // Kin management
  'create_kin', 'update_kin', 'delete_kin', 'get_kin_details',
  // Webhooks
  'create_webhook', 'update_webhook', 'delete_webhook', 'list_webhooks',
  // Channels (proactive messaging not available in quick sessions)
  'send_channel_message', 'list_channel_conversations',
  // Platform
  'get_platform_logs',
  // Memory WRITE (read-only in quick sessions)
  'memorize', 'update_memory', 'forget',
])

/**
 * Process the next quick session message for a Kin.
 * Runs in a separate slot from the main session (parallel processing).
 */
export async function processQuickMessage(kinId: string): Promise<boolean> {
  if (quickLocks.has(kinId)) return false
  quickLocks.add(kinId)

  let queueItem: Awaited<ReturnType<typeof dequeueMessage>> = null

  try {
    if (await isKinProcessing(kinId, 'quick')) return false

    queueItem = await dequeueMessage(kinId, 'quick')
    if (!queueItem) return false
    if (!queueItem.sessionId) return false // Safety: should always have sessionId

    const sessionId = queueItem.sessionId
    log.info({ kinId, sessionId, queueItemId: queueItem.id }, 'Processing quick session message')

    const kin = await db.select().from(kins).where(eq(kins.id, kinId)).get()
    if (!kin) return false

    // Save the incoming user message to DB (with sessionId)
    const userMessageId = uuid()
    await db.insert(messages).values({
      id: userMessageId,
      kinId,
      sessionId,
      role: 'user',
      content: queueItem.content,
      sourceType: queueItem.sourceType,
      sourceId: queueItem.sourceId,
      createdAt: new Date(),
    })

    // Link uploaded files if any
    if (queueItem.fileIds && queueItem.fileIds.length > 0) {
      await linkFilesToMessage(queueItem.fileIds, userMessageId)
    }

    // Get user language
    let userLanguage: 'fr' | 'en' = 'fr'
    if (queueItem.sourceType === 'user' && queueItem.sourceId) {
      const profile = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, queueItem.sourceId))
        .get()
      if (profile) userLanguage = profile.language as 'fr' | 'en'
    }

    // Retrieve relevant memories (read-only) via hybrid search
    let relevantMemories: Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; updatedAt: Date | null; score: number }> = []
    try {
      relevantMemories = await getRelevantMemories(kinId, queueItem.content)
    } catch {
      // Non-fatal
    }

    // Retrieve relevant knowledge base chunks
    let relevantKnowledge: Array<{ content: string; sourceId: string; score: number }> = []
    try {
      const { searchKnowledge } = await import('@/server/services/knowledge')
      relevantKnowledge = await searchKnowledge(kinId, queueItem.content, 5)
    } catch {
      // Non-fatal
    }

    // Build quick session system prompt (minimal — no contacts, no kin directory, no hidden instructions)
    const globalPrompt = await getGlobalPrompt()

    const systemSegments = buildSystemPrompt({
      kin: { name: kin.name, slug: kin.slug, role: kin.role, character: kin.character, expertise: kin.expertise },
      contacts: [],
      relevantMemories,
      relevantKnowledge,
      kinDirectory: [],
      isSubKin: false,
      isQuickSession: true,
      globalPrompt,
      userLanguage,
      workspacePath: kin.workspacePath,
    })

    // Build quick session message history (only messages from this session, no compacting)
    const sessionMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.createdAt))
      .all()

    const messageHistory: ModelMessage[] = []
    for (const msg of sessionMessages) {
      if (msg.role === 'user') {
        messageHistory.push({ role: 'user', content: msg.content ?? '' })
      } else if (msg.role === 'assistant') {
        let toolCalls: Array<{ id: string; name: string; args: unknown; result?: unknown }> | null = null
        if (msg.toolCalls) {
          try { toolCalls = JSON.parse(msg.toolCalls as string) } catch { toolCalls = null }
        }
        // Sanitize defensively — see sanitizePersistedToolCalls for rationale (#355).
        const validToolCalls = toolCalls ? sanitizePersistedToolCalls(toolCalls, kinId) : []
        if (validToolCalls.length > 0) {
          const assistantContent: Array<
            | { type: 'text'; text: string }
            | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
          > = []
          if (msg.content) assistantContent.push({ type: 'text', text: msg.content })
          for (const tc of validToolCalls) {
            assistantContent.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args })
          }
          messageHistory.push({ role: 'assistant', content: assistantContent })
          messageHistory.push({
            role: 'tool' as const,
            content: validToolCalls.map((tc) => ({
              type: 'tool-result' as const,
              toolCallId: tc.id,
              toolName: tc.name,
              output: { type: 'json' as const, value: (tc.result ?? null) as import('ai').JSONValue },
            })),
          })
        } else {
          // Skip empty text-only rows: Anthropic rejects empty text content
          // blocks. See buildMessageHistory for the same defense.
          const text = msg.content ?? ''
          if (text) {
            messageHistory.push({ role: 'assistant', content: text })
          }
        }
      }
    }

    // Resolve LLM model
    const model = await resolveLLMModel(kin.model, kin.providerId)
    if (!model) {
      log.warn({ kinId, sessionId, modelId: kin.model }, 'No LLM provider available for quick session')
      sseManager.sendToKin(kinId, {
        type: 'kin:error',
        kinId,
        data: { error: 'No LLM provider available for this model', sessionId },
      })
      import('@/server/services/notifications').then(({ createNotification }) =>
        createNotification({ type: 'kin:error', title: 'Kin error', body: 'No LLM provider available for this model', kinId, relatedId: kinId, relatedType: 'kin' }),
      ).catch(() => {})
      return true
    }

    // Resolve thinking config for quick session (defaults to enabled)
    const qsThinkingConfig = resolveThinkingConfig(kin.thinkingConfig)
    const qsProviderType = guessProviderType(kin.model) ?? kin.providerId ?? ''
    const qsThinkingProviderOptions = buildThinkingProviderOptions(qsProviderType, qsThinkingConfig)

    // Resolve tools (with exclusion list for quick sessions)
    const toolConfig: KinToolConfig | null = kin.toolConfig ? JSON.parse(kin.toolConfig) : null
    const quickEffectiveUserId = queueItem.sourceType === 'user' ? (queueItem.sourceId ?? undefined) : undefined
    const nativeTools = toolRegistry.resolve({ kinId, userId: quickEffectiveUserId, isSubKin: false })

    // Apply Kin-level deny-list
    if (toolConfig?.disabledNativeTools?.length) {
      for (const name of toolConfig.disabledNativeTools) delete nativeTools[name]
    }
    // Filter out defaultDisabled tools not explicitly opted-in
    const allRegistered = toolRegistry.list()
    const optInSet = new Set(toolConfig?.enabledOptInTools ?? [])
    for (const reg of allRegistered) {
      if (reg.defaultDisabled && !optInSet.has(reg.name)) delete nativeTools[reg.name]
    }
    // Apply quick session exclusion list
    for (const name of QUICK_SESSION_EXCLUDED_TOOLS) delete nativeTools[name]

    const tools = capTools(wrapToolsWithSpill({ ...nativeTools }, kin.workspacePath), kinId, qsProviderType)
    const hasTools = Object.keys(tools).length > 0

    // Stream LLM response — custom single-step loop (same pattern as processKinQueue)
    const assistantMessageId = uuid()
    let fullContent = ''
    const reasoningSegments: Array<{ offset: number; text: string }> = []
    let currentReasoning = ''
    const toolCallsLog: Array<{ id: string; name: string; args: unknown; result?: unknown; offset: number }> = []

    const abortController = new AbortController()
    quickAbortControllers.set(sessionId, abortController)

    // Strip execute functions from tools so the SDK only collects intents,
    // then mark the last tool as cache-eligible for Anthropic prompt caching.
    const toolSchemas = hasTools ? markLastToolCacheable(stripToolExecute(tools)) : undefined

    const maxSteps = hasTools ? (config.tools.maxSteps > 0 ? config.tools.maxSteps : 100) : 1
    let wasAborted = false
    let silentStopAfterTools = false
    const stepResults: Array<ReturnType<typeof streamText>> = []

    let step = 0
    for (; step < maxSteps; step++) {
      if (abortController.signal.aborted) { wasAborted = true; break }

      const result = streamText({
        model,
        messages: buildSegmentedMessages(systemSegments, messageHistory),
        tools: toolSchemas,
        abortSignal: abortController.signal,
        ...(qsThinkingProviderOptions ? { providerOptions: qsThinkingProviderOptions as any } : {}),
      })
      stepResults.push(result)

      // Collect tool call intents from this step
      const stepToolCalls: Array<{ id: string; name: string; args: unknown; offset: number }> = []
      // Per-step text. fullContent keeps accumulating across steps for
      // persistence, offset math, and UI rendering, but only stepText is
      // pushed into the assistant history block so the model never sees
      // its own prior-step narration repeated back to it.
      let stepText = ''

      try {
        for await (const part of result.fullStream) {
          // Handle tool-call-streaming-start (not yet in AI SDK type union)
          if ((part.type as string) === 'tool-call-streaming-start') {
            const p = part as unknown as { toolCallId: string; toolName: string }
            sseManager.sendToKin(kinId, {
              type: 'chat:tool-call-start',
              kinId,
              data: { messageId: assistantMessageId, toolCallId: p.toolCallId, toolName: p.toolName, contentOffset: fullContent.length, sessionId },
            })
            continue
          }

          // Handle reasoning/thinking stream parts
          if ((part.type as string) === 'reasoning-start') {
            currentReasoning = ''
            continue
          }
          if ((part.type as string) === 'reasoning-delta') {
            const p = part as unknown as { text: string }
            currentReasoning += p.text
            sseManager.sendToKin(kinId, {
              type: 'chat:reasoning-token',
              kinId,
              data: { messageId: assistantMessageId, token: p.text, sessionId },
            })
            continue
          }
          if ((part.type as string) === 'reasoning-end') {
            if (currentReasoning) {
              reasoningSegments.push({ offset: fullContent.length, text: currentReasoning })
              currentReasoning = ''
            }
            sseManager.sendToKin(kinId, {
              type: 'chat:reasoning-done',
              kinId,
              data: { messageId: assistantMessageId, sessionId },
            })
            continue
          }

          switch (part.type) {
            case 'text-delta': {
              fullContent += part.text
              stepText += part.text
              sseManager.sendToKin(kinId, {
                type: 'chat:token',
                kinId,
                data: { messageId: assistantMessageId, token: part.text, sessionId },
              })
              break
            }
            case 'tool-call': {
              const contentOffset = fullContent.length
              stepToolCalls.push({ id: part.toolCallId, name: part.toolName, args: part.input, offset: contentOffset })
              sseManager.sendToKin(kinId, {
                type: 'chat:tool-call',
                kinId,
                data: { messageId: assistantMessageId, toolCallId: part.toolCallId, toolName: part.toolName, args: part.input, contentOffset, sessionId },
              })
              break
            }
            case 'error': {
              const err = part.error
              if (err instanceof Error) throw err
              throw new Error(extractApiErrorMessage(err))
            }
            default:
              break
          }
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          wasAborted = true
        } else {
          throw streamError
        }
      }

      // No tool calls this step → LLM is done, exit loop.
      // Silent-stop detection: see processNextMessage for rationale.
      if (stepToolCalls.length === 0 || wasAborted) {
        if (!wasAborted && toolCallsLog.length > 0 && fullContent.length === 0) {
          silentStopAfterTools = true
        }
        break
      }

      // Build assistant content for history
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = []
      if (stepText) assistantContent.push({ type: 'text', text: stepText })
      for (const tc of stepToolCalls) {
        assistantContent.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args })
      }

      // Execute tool calls (concurrently if all read-only, sequentially otherwise)
      const batch = await executeToolBatch({
        stepToolCalls,
        tools,
        abortController,
        kinId,
        assistantMessageId,
        sseExtra: { sessionId },
      })
      toolCallsLog.push(...batch.toolCallsLog)
      if (batch.wasAborted) { wasAborted = true; break }

      // Append assistant message (with tool calls) + tool results to history for next step
      messageHistory.push({ role: 'assistant', content: assistantContent })
      messageHistory.push({ role: 'tool' as const, content: batch.toolResults })

      // Text accumulates across steps so tool call offsets remain valid
    }

    quickAbortControllers.delete(sessionId)

    // Aggregate token usage (awaited so we can persist in metadata + SSE)
    const tokenUsage = await aggregateStepUsage(stepResults)

    // Fire-and-forget: record to llm_usage table for analytics
    if (tokenUsage) {
      recordUsage({
        callSite: 'quick-session',
        callType: 'stream-text',
        providerType: guessProviderType(kin.model),
        providerId: kin.providerId,
        modelId: kin.model,
        kinId,
        sessionId,
        usage: {
          inputTokens: tokenUsage.inputTokens,
          outputTokens: tokenUsage.outputTokens,
          totalTokens: tokenUsage.totalTokens,
          inputTokenDetails: { cacheReadTokens: tokenUsage.cacheReadTokens ?? 0, cacheWriteTokens: tokenUsage.cacheWriteTokens ?? 0 },
          outputTokenDetails: { reasoningTokens: tokenUsage.reasoningTokens ?? 0 },
        },
        stepCount: stepResults.length,
      })
    }

    // Surface silent-stop (same rationale as main path)
    if (silentStopAfterTools) {
      log.warn(
        { kinId, sessionId, messageId: assistantMessageId, toolCalls: toolCallsLog.length, step },
        'Quick session: LLM closed stream with no text after tool execution (silent stop)',
      )
      fullContent = `*(J'ai exécuté ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} mais le modèle n'a pas produit de réponse finale. Cela arrive parfois sur de très gros contextes. Demande-moi de continuer ou de résumer.)*`
      sseManager.sendToKin(kinId, {
        type: 'chat:token',
        kinId,
        data: { messageId: assistantMessageId, token: fullContent, sessionId },
      })
    }

    // Detect truncated turns (same as main path)
    const stepLimitReached = step >= maxSteps && toolCallsLog.length > 0 && !wasAborted && config.tools.maxSteps > 0
    if (stepLimitReached) {
      log.warn(
        { kinId, sessionId, toolCalls: toolCallsLog.length, maxSteps: config.tools.maxSteps },
        'Quick session LLM turn produced tool calls but no text content (step limit truncation)',
      )
      fullContent = `*(Completed ${toolCallsLog.length} tool call${toolCallsLog.length > 1 ? 's' : ''} but the response was truncated due to the tool step limit of ${config.tools.maxSteps}. You can ask me to continue or summarize.)*`
    }

    // Save assistant message (with sessionId). Skip when there's no text
    // and no tool calls (typically: user aborted before the model produced
    // anything). See the main-session insert above for the rationale.
    if (fullContent || toolCallsLog.length > 0) {
      await db.insert(messages).values({
        id: assistantMessageId,
        kinId,
        sessionId,
        role: 'assistant',
        content: fullContent || '',
        sourceType: 'kin',
        sourceId: kinId,
        toolCalls: toolCallsLog.length > 0 ? JSON.stringify(toolCallsLog) : null,
        reasoning: reasoningSegments.length > 0 ? JSON.stringify(reasoningSegments) : null,
        metadata: (() => {
          const meta: Record<string, unknown> = {}
          if (relevantMemories.length > 0) meta.injectedMemories = relevantMemories
          if (stepLimitReached) {
            meta.stepLimitReached = true
            meta.maxSteps = config.tools.maxSteps
            meta.toolCallCount = toolCallsLog.length
          }
          if (tokenUsage) meta.tokenUsage = tokenUsage
          return Object.keys(meta).length > 0 ? JSON.stringify(meta) : null
        })(),
        createdAt: new Date(),
      })
    }

    // Emit chat:done (with sessionId)
    sseManager.sendToKin(kinId, {
      type: 'chat:done',
      kinId,
      data: { messageId: assistantMessageId, content: fullContent, sessionId, ...(tokenUsage ? { tokenUsage } : {}) },
    })

    // No compacting, no memory extraction for quick sessions

    await markQueueItemDone(queueItem.id)

    return true
  } catch (error) {
    quickAbortControllers.delete(queueItem?.sessionId ?? '')

    const errorMsg = error instanceof Error ? error.message : 'Unknown error'
    // Quick sessions are ephemeral and have no compacting pipeline — the
    // generic friendlyErrorMessage promises "compaction triggered, retry in
    // a few seconds" which is a lie here. Override with quick-session-
    // specific wording when the error is a context overflow.
    const displayError = isContextTooLargeError(errorMsg)
      ? 'This quick session is too long for the model\'s context window. Close it and start a new one.'
      : friendlyErrorMessage(errorMsg)
    log.error({ kinId, sessionId: queueItem?.sessionId, error: errorMsg }, 'Quick session engine error')

    // Send error as system message in the quick session
    if (queueItem?.sessionId) {
      const errorMessageId = uuid()
      await db.insert(messages).values({
        id: errorMessageId,
        kinId,
        sessionId: queueItem.sessionId,
        role: 'assistant',
        content: `⚠️ ${displayError}`,
        sourceType: 'system',
        createdAt: new Date(),
      })

      sseManager.sendToKin(kinId, {
        type: 'chat:message',
        kinId,
        data: {
          id: errorMessageId,
          role: 'assistant',
          content: `⚠️ ${displayError}`,
          sourceType: 'system',
          sessionId: queueItem.sessionId,
          createdAt: Date.now(),
        },
      })
    }

    return true
  } finally {
    if (queueItem) {
      await markQueueItemDone(queueItem.id).catch((err) =>
        log.error({ kinId, err }, 'Failed to mark quick session queue item done in finally'),
      )
    }
    quickLocks.delete(kinId)
  }
}

/**
 * Build the message history for LLM context.
 * Includes compacted summary (if any) + recent non-compacted messages.
 */
export interface ConversationParticipant {
  name: string
  platform: string | null // null = KinBot web UI
  messageCount: number
  lastSeenAt: Date
}

export async function buildMessageHistory(kinId: string): Promise<{ messages: ModelMessage[]; compactingSummaries: Array<{ summary: string; firstMessageAt: Date; lastMessageAt: Date; depth: number }> | null; participants: ConversationParticipant[]; visibleMessageCount: number; totalMessageCount: number; hasCompactedHistory: boolean; oldestVisibleMessageAt?: Date; maskedToolGroups: number; observationCompactedCount: number; estimatedTokensSavedByMasking: number; emergencyTrimmedCount: number; trimmedToolResultsCount: number; trimmedToolResultsTokensSaved: number; trimmedToolCallArgsCount: number; trimmedToolCallArgsTokensSaved: number; trimmedAssistantContentCount: number; trimmedAssistantContentTokensSaved: number; trimmedUserContentCount: number; trimmedUserContentTokensSaved: number }> {
  const history: ModelMessage[] = []

  // Fetch all active (in-context) summaries, ordered oldest to newest
  const activeSummaries = await db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.kinId, kinId), eq(compactingSummaries.isInContext, true)))
    .orderBy(asc(compactingSummaries.lastMessageAt))
    .all()

  // Use the latest summary's lastMessageAt as the cutoff for message filtering
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null
  const cutoffTimestamp = latestSummary ? (latestSummary.lastMessageAt as unknown as number) : null

  // [10] Recent messages (main session only, not task or quick session messages)
  // Limit is configurable via HISTORY_MAX_MESSAGES (default 1000). A low limit
  // produces a sliding-window effect that breaks Anthropic prompt cache: every
  // new turn pushes 1-2 oldest messages out, shifting the prefix and
  // invalidating cross-turn cache. The compacting service is the proper
  // mechanism for keeping the LLM context within token-window limits.
  const recentMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.kinId, kinId), isNull(messages.taskId), isNull(messages.sessionId), ne(messages.sourceType, 'compacting')))
    .orderBy(desc(messages.createdAt))
    .limit(config.historyMaxMessages)
    .all()

  // Reverse to get chronological order
  recentMessages.reverse()

  // Only include messages after the latest summary's cutoff
  const postSnapshotMessages = (cutoffTimestamp
    ? recentMessages.filter(
        (m) => m.createdAt && (m.createdAt as unknown as number) > cutoffTimestamp,
      )
    : recentMessages
  ).filter((m) => {
    // UI-only audit markers must not reach the LLM prompt. They live in DB
    // so the conversation view can render them (channel handoff banners),
    // but they have no semantic value for the model and would only confuse
    // a turn. Discriminated via meta.systemEvent (same pattern as
    // meta.isAddendum / meta.resolvedTaskId).
    if (!m.metadata) return true
    try {
      const meta = JSON.parse(m.metadata as string)
      const ev = meta?.systemEvent
      return ev !== 'channel_transferred_out' && ev !== 'channel_transferred_in'
    } catch {
      return true
    }
  })

  // Token-budget trimming: drop oldest messages until we fit within the budget.
  // This is an emergency safety net — compacting + tool masking are the primary mechanisms.
  const tokenBudget = config.historyTokenBudget
  let filteredMessages = postSnapshotMessages
  let emergencyTrimmedCount = 0
  if (tokenBudget > 0) {
    // Estimate tokens per message (content + tool calls JSON)
    const msgTokens = postSnapshotMessages.map((m) => {
      let chars = (m.content ?? '').length
      if (m.toolCalls) chars += (m.toolCalls as string).length
      return Math.ceil(chars / 4)
    })
    let totalTokens = msgTokens.reduce((a, b) => a + b, 0)
    let startIdx = 0
    while (totalTokens > tokenBudget && startIdx < postSnapshotMessages.length - 1) {
      totalTokens -= msgTokens[startIdx]!
      startIdx++
    }
    if (startIdx > 0) {
      emergencyTrimmedCount = startIdx
      log.warn({ kinId, droppedMessages: startIdx, tokenBudget }, 'Emergency token-budget trim fired — messages silently dropped from context')
      filteredMessages = postSnapshotMessages.slice(startIdx)
    }
  }

  // Build a map of user pseudonyms for prefixing user messages in LLM context
  const userSourceIds = [
    ...new Set(filteredMessages.filter((m) => m.sourceType === 'user' && m.sourceId).map((m) => m.sourceId!)),
  ]
  const pseudonymMap = new Map<string, string>()
  for (const uid of userSourceIds) {
    const profile = await db.select().from(userProfiles).where(eq(userProfiles.userId, uid)).get()
    if (profile?.pseudonym) pseudonymMap.set(uid, profile.pseudonym)
  }

  // Build a map of kin names for inter-kin messages in LLM context
  const kinSourceIds = [
    ...new Set(filteredMessages.filter((m) => m.sourceType === 'kin' && m.sourceId).map((m) => m.sourceId!)),
  ]
  const kinNameMap = new Map<string, string>()
  for (const kid of kinSourceIds) {
    const kin = await db.select({ name: kins.name }).from(kins).where(eq(kins.id, kid)).get()
    if (kin?.name) kinNameMap.set(kid, kin.name)
  }

  // Fetch files for all user messages in one pass
  const userMessageIds = filteredMessages.filter((m) => m.role === 'user').map((m) => m.id)
  const filesByMessageId = new Map<string, Array<{ mimeType: string; storedPath: string; originalName: string }>>()
  for (const msgId of userMessageIds) {
    const msgFiles = await getFilesForMessage(msgId)
    if (msgFiles.length > 0) filesByMessageId.set(msgId, msgFiles)
  }

  for (const msg of filteredMessages) {
    if (msg.role === 'user') {
      let textContent = msg.content ?? ''
      // Prefix user messages with pseudonym so the LLM knows who's speaking
      if (msg.sourceType === 'user' && msg.sourceId) {
        const pseudo = pseudonymMap.get(msg.sourceId)
        if (pseudo) textContent = `[${pseudo}] ${textContent}`
      }
      // Addendum messages: prefix with context so the LLM knows this was injected mid-response.
      // Channel context: when a channel adapter attached structured metadata
      // (modality, presence, channel info...) we surface it to the LLM as a
      // <channel-context> block so the Kin can use it for routing decisions
      // without polluting the visible content.
      if (msg.metadata) {
        try {
          const meta = JSON.parse(msg.metadata as string)
          if (meta.isAddendum) {
            textContent += '\n\n[The user sent this additional context while you were in the middle of responding. Take it into account and continue.]'
          }
          const hasChannel = meta.channel && typeof meta.channel === 'object'
          const hasTransfer = meta.channelTransfer && typeof meta.channelTransfer === 'object'
          if (hasChannel || hasTransfer) {
            const blob: Record<string, unknown> = {}
            if (hasChannel) blob.channel = meta.channel
            if (hasTransfer) blob.channelTransfer = meta.channelTransfer
            textContent = `<channel-context>\n${JSON.stringify(blob)}\n</channel-context>\n${textContent}`
          }
        } catch { /* ignore parse errors */ }
      }
      // Inter-kin messages: prefix the content with context instead of a separate system message
      if (msg.sourceType === 'kin' && msg.sourceId) {
        const kinName = kinNameMap.get(msg.sourceId) ?? 'Unknown Kin'
        if (msg.inReplyTo) {
          textContent = `[Reply from Kin "${kinName}"]\n${textContent}`
        } else {
          let prefix = `[Message from Kin "${kinName}"]`
          if (msg.requestId) {
            prefix += ` (Inter-kin request — reply with request_id="${msg.requestId}")`
          }
          textContent = `${prefix}\n${textContent}`
        }
      }

      // Check for attached files (images become multimodal parts)
      const msgFiles = filesByMessageId.get(msg.id)
      if (msgFiles && msgFiles.length > 0) {
        const contentParts: UserContent & unknown[] = []

        if (textContent) {
          contentParts.push({ type: 'text' as const, text: textContent })
        }

        for (const f of msgFiles) {
          try {
            const fileBuffer = await Bun.file(f.storedPath).arrayBuffer()
            if (f.mimeType.startsWith('image/')) {
              contentParts.push({
                type: 'image' as const,
                image: new Uint8Array(fileBuffer),
                mimeType: f.mimeType,
              })
            } else if (isTextReadable(f.mimeType) && fileBuffer.byteLength <= MAX_INLINE_FILE_SIZE) {
              // Text-based files: inline content so the LLM can read it
              let textContent = new TextDecoder().decode(fileBuffer)
              let truncated = false
              if (textContent.length > MAX_INLINE_TEXT_LENGTH) {
                textContent = textContent.slice(0, MAX_INLINE_TEXT_LENGTH)
                truncated = true
              }
              contentParts.push({
                type: 'text' as const,
                text: `[Attached file: ${f.originalName} (${f.mimeType})]\n\n${textContent}${truncated ? '\n\n[... content truncated ...]' : ''}`,
              })
            } else if (f.mimeType === 'application/pdf' && fileBuffer.byteLength <= MAX_INLINE_FILE_SIZE) {
              // PDFs: pass as file content part for providers with native PDF support
              contentParts.push({
                type: 'text' as const,
                text: `[Attached PDF: ${f.originalName}]`,
              })
              contentParts.push({
                type: 'file' as const,
                data: new Uint8Array(fileBuffer),
                filename: f.originalName,
                mediaType: 'application/pdf',
              })
            } else {
              // Binary files or files too large to inline: mention with path for tool access
              contentParts.push({
                type: 'text' as const,
                text: `[Attached file: ${f.originalName} (${f.mimeType}) — use read_file with path: ${f.storedPath}]`,
              })
            }
          } catch {
            contentParts.push({
              type: 'text' as const,
              text: `[Attached file: ${f.originalName} — could not read]`,
            })
          }
        }

        history.push({ role: 'user', content: contentParts as UserContent })
      } else {
        history.push({ role: 'user', content: textContent })
      }
    } else if (msg.role === 'assistant') {
      // Parse tool calls from the JSON column
      let toolCalls: Array<{ id: string; name: string; args: unknown; result?: unknown }> | null = null
      if (msg.toolCalls) {
        try {
          toolCalls = JSON.parse(msg.toolCalls as string)
        } catch {
          toolCalls = null
        }
      }

      // Sanitize defensively before building ModelMessage parts. Malformed
      // tool calls (missing id/name or `args === undefined`) break the Vercel
      // AI SDK schema validator and permanently corrupt the session (#355).
      const validToolCalls = toolCalls ? sanitizePersistedToolCalls(toolCalls, kinId) : []

      if (validToolCalls.length > 0) {
        // Build structured content: text part (if any) + tool call parts
        const assistantContent: Array<
          | { type: 'text'; text: string }
          | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
        > = []

        const textContent = msg.content ?? ''
        if (textContent) {
          assistantContent.push({ type: 'text', text: textContent })
        }

        for (const tc of validToolCalls) {
          assistantContent.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          })
        }

        history.push({ role: 'assistant', content: assistantContent })

        // Emit a corresponding tool result message. Every tool-call in the
        // preceding assistant message MUST have a matching tool-result,
        // otherwise the SDK schema validator rejects the whole history —
        // using the same `validToolCalls` array keeps this invariant.
        history.push({
          role: 'tool' as const,
          content: validToolCalls.map((tc) => ({
            type: 'tool-result' as const,
            toolCallId: tc.id,
            toolName: tc.name,
            output: { type: 'json' as const, value: (tc.result ?? null) as import('ai').JSONValue },
          })),
        })
      } else {
        // Simple text-only assistant message (either no tool calls persisted,
        // or every persisted tool call was malformed and dropped by the
        // sanitizer — we keep the text portion so the turn is not lost).
        // Skip rows with empty content: Anthropic rejects empty text content
        // blocks on the next turn. These can exist as legacy rows from before
        // the abort-path guard was tightened.
        const text = msg.content ?? ''
        if (text) {
          history.push({ role: 'assistant', content: text })
        }
      }
    }
    // role === 'tool' and 'system' messages from DB are skipped —
    // tool results are reconstructed from the assistant's toolCalls JSON above
  }

  // Progressive compaction (tool result masking + observation compaction).
  //
  // Gated behind `progressiveCompactionEnabled` because it rewrites old tool
  // results between turns — intact → truncated → collapsed as new calls
  // accumulate — which invalidates Anthropic's prompt cache (the prefix
  // changes byte-for-byte every turn). When disabled, the proper compacting
  // service (which generates summaries) takes over at the configured threshold
  // for genuine token savings without breaking the cache.
  const maskResult = config.progressiveCompactionEnabled
    ? maskOldToolResults(history, config.toolResultMaskKeepLast, config.observationCompactionWindow, config.observationMaxChars)
    : { messages: history, maskedGroupCount: 0, observationCompactedCount: 0, estimatedTokensSaved: 0 }

  // Per-message size cap — independently of progressive compaction. A
  // single tool-result message can be 50-150k tokens (browser snapshots,
  // unspilled kubectl outputs from before tool-output spilling shipped).
  // After compacting these still dominate the keep-window, so even a
  // forced compaction barely reduces the total context.
  //
  // Cache-safe: the criterion is per-message and stable (a message at
  // 80k tokens stays at 80k → always trimmed; a message at 5k stays at
  // 5k → never trimmed). The transformation is deterministic per message
  // so the prefix stabilizes after the first apply.
  const SIZE_CAP_TOKENS = config.toolResultSizeCapTokens
  let oversizedTrimmedCount = 0
  let oversizedTrimmedTokens = 0
  const sizedHistory = SIZE_CAP_TOKENS > 0 ? maskResult.messages.map((msg) => {
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg
    let modified = false
    const content = (msg.content as Array<{ type: string; toolCallId?: string; toolName?: string; output?: { type?: string; value?: unknown } }>).map((part) => {
      if (part.type !== 'tool-result') return part
      const value = part.output?.value
      const json = value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value))
      const tokens = estimateTokens(json)
      if (tokens <= SIZE_CAP_TOKENS) return part
      modified = true
      oversizedTrimmedCount++
      oversizedTrimmedTokens += tokens
      const placeholder = `[Tool result trimmed: ${part.toolName ?? 'unknown'} returned ~${tokens.toLocaleString()} tokens, exceeding the ${SIZE_CAP_TOKENS.toLocaleString()}-token keep-window cap. Re-run the tool if you need the full output.]`
      return { ...part, output: { type: 'text' as const, value: placeholder } }
    })
    return modified ? { ...msg, content } as ModelMessage : msg
  }) : maskResult.messages
  if (oversizedTrimmedCount > 0) {
    log.debug({ kinId, count: oversizedTrimmedCount, totalOriginalTokens: oversizedTrimmedTokens, capTokens: SIZE_CAP_TOKENS }, 'Tool results above keep-window size cap trimmed')
  }

  // Per-tool-call args size cap (symmetric to the tool-result cap above).
  // Assistant messages with write_file/edit_file/multi_edit etc. carry the
  // file content inside the call arguments — these are kept verbatim for
  // the entire keep-window. A single 5k-line file edit becomes a 20-30k
  // token assistant message that dominates the keep budget for hours.
  //
  // Trim per-field on string values (path/name fields stay tiny, only the
  // bulk content/old_string/new_string get a placeholder). The toolCallId
  // and toolName are preserved so subsequent tool-result blocks still
  // match correctly. Cache-safe: deterministic per message.
  const ARGS_CAP_TOKENS = config.toolCallArgsSizeCapTokens
  let trimmedArgsCount = 0
  let trimmedArgsTokens = 0
  const argsCappedHistory = ARGS_CAP_TOKENS > 0 ? sizedHistory.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
    let modified = false
    const content = (msg.content as Array<{ type: string; toolCallId?: string; toolName?: string; input?: unknown }>).map((part) => {
      if (part.type !== 'tool-call' || !part.input || typeof part.input !== 'object') return part
      const trimmedInput: Record<string, unknown> = {}
      let partModified = false
      for (const [key, value] of Object.entries(part.input as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          trimmedInput[key] = value
          continue
        }
        const tokens = estimateTokens(value)
        if (tokens <= ARGS_CAP_TOKENS) {
          trimmedInput[key] = value
          continue
        }
        partModified = true
        trimmedArgsCount++
        trimmedArgsTokens += tokens
        const preview = value.slice(0, 200).replace(/\s+/g, ' ').trim()
        trimmedInput[key] = `[Truncated arg "${key}": ~${tokens.toLocaleString()} tokens, ${value.length.toLocaleString()} chars. Preview: ${preview}…]`
      }
      if (!partModified) return part
      modified = true
      return { ...part, input: trimmedInput }
    })
    return modified ? { ...msg, content } as ModelMessage : msg
  }) : sizedHistory
  if (trimmedArgsCount > 0) {
    log.debug({ kinId, count: trimmedArgsCount, totalOriginalTokens: trimmedArgsTokens, capTokens: ARGS_CAP_TOKENS }, 'Tool call args above per-field cap trimmed')
  }

  // Per-message assistant text content cap (third companion to the
  // tool-result and tool-call-args caps). A single long-form assistant turn
  // (file dump, exhaustive analysis, generated documentation) can be 30-50k
  // tokens of plain text — uncapped until now. Trimmed using head + tail
  // preservation so the LLM still sees the opening framing and the final
  // conclusion (the parts most often referenced later as "as I said earlier"
  // / "to summarize"). The middle bulk gets a placeholder with the cut size.
  // Cache-safe: deterministic per message.
  const CONTENT_CAP_TOKENS = config.assistantContentSizeCapTokens
  let trimmedContentCount = 0
  let trimmedContentTokens = 0
  const contentCappedHistory = CONTENT_CAP_TOKENS > 0 ? argsCappedHistory.map((msg) => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
    let modified = false
    const content = (msg.content as Array<{ type: string; text?: string }>).map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const tokens = estimateTokens(part.text)
      if (tokens <= CONTENT_CAP_TOKENS) return part
      modified = true
      trimmedContentCount++
      trimmedContentTokens += tokens
      const head = part.text.slice(0, 400).trimEnd()
      const tail = part.text.slice(-400).trimStart()
      const placeholder = `${head}\n\n[…assistant content truncated: ~${tokens.toLocaleString()} tokens, ${part.text.length.toLocaleString()} chars cut from middle. Head + tail preserved below…]\n\n${tail}`
      return { ...part, text: placeholder }
    })
    return modified ? { ...msg, content } as ModelMessage : msg
  }) : argsCappedHistory
  if (trimmedContentCount > 0) {
    log.debug({ kinId, count: trimmedContentCount, totalOriginalTokens: trimmedContentTokens, capTokens: CONTENT_CAP_TOKENS }, 'Assistant text content above per-message cap trimmed')
  }

  // Per-message USER text content cap (4th companion). User messages can
  // grow to 15-20k tokens when the user pastes a CSV / log dump / file
  // contents. Same head + tail preservation as assistant content. Default
  // cap is independent (often higher than assistant) since user pastes
  // tend to carry the actual question / data.
  const USER_CONTENT_CAP_TOKENS = config.userContentSizeCapTokens
  let trimmedUserContentCount = 0
  let trimmedUserContentTokens = 0
  const userContentCappedHistory = USER_CONTENT_CAP_TOKENS > 0 ? contentCappedHistory.map((msg) => {
    if (msg.role !== 'user') return msg
    if (typeof msg.content === 'string') {
      const tokens = estimateTokens(msg.content)
      if (tokens <= USER_CONTENT_CAP_TOKENS) return msg
      trimmedUserContentCount++
      trimmedUserContentTokens += tokens
      const head = msg.content.slice(0, 500).trimEnd()
      const tail = msg.content.slice(-500).trimStart()
      const placeholder = `${head}\n\n[…user content truncated: ~${tokens.toLocaleString()} tokens, ${msg.content.length.toLocaleString()} chars cut from middle. Head + tail preserved below…]\n\n${tail}`
      return { ...msg, content: placeholder } as ModelMessage
    }
    if (!Array.isArray(msg.content)) return msg
    let modified = false
    const content = (msg.content as Array<{ type: string; text?: string }>).map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part
      const tokens = estimateTokens(part.text)
      if (tokens <= USER_CONTENT_CAP_TOKENS) return part
      modified = true
      trimmedUserContentCount++
      trimmedUserContentTokens += tokens
      const head = part.text.slice(0, 500).trimEnd()
      const tail = part.text.slice(-500).trimStart()
      const placeholder = `${head}\n\n[…user content truncated: ~${tokens.toLocaleString()} tokens, ${part.text.length.toLocaleString()} chars cut from middle. Head + tail preserved below…]\n\n${tail}`
      return { ...part, text: placeholder }
    })
    return modified ? { ...msg, content } as ModelMessage : msg
  }) : contentCappedHistory
  if (trimmedUserContentCount > 0) {
    log.debug({ kinId, count: trimmedUserContentCount, totalOriginalTokens: trimmedUserContentTokens, capTokens: USER_CONTENT_CAP_TOKENS }, 'User text content above per-message cap trimmed')
  }
  const maskedHistory = userContentCappedHistory
  if (maskResult.maskedGroupCount > 0 || maskResult.observationCompactedCount > 0) {
    log.debug({ kinId, maskedGroups: maskResult.maskedGroupCount, observationCompacted: maskResult.observationCompactedCount, tokensSaved: maskResult.estimatedTokensSaved }, 'Context compaction pipeline applied')
  }

  // Extract conversation participant info from filtered messages
  const participantMap = new Map<string, { name: string; platform: string | null; messageCount: number; lastSeenAt: Date }>()
  for (const msg of filteredMessages) {
    if (msg.role !== 'user') continue
    let name = 'Unknown'
    let platform: string | null = null

    if (msg.sourceType === 'user' && msg.sourceId) {
      name = pseudonymMap.get(msg.sourceId) ?? 'User'
    } else if (msg.sourceType === 'channel') {
      // Channel messages have content prefixed with [platform:Name]
      const match = (msg.content ?? '').match(/^\[([^:]+):([^\]]+?)(?:\s*\(unknown[^)]*\))?\]/)
      if (match) {
        platform = match[1]!
        name = match[2]!.trim()
      }
    }

    const key = `${platform ?? 'kinbot'}:${name}`
    const existing = participantMap.get(key)
    const msgDate = msg.createdAt ? new Date(msg.createdAt as unknown as number) : new Date()
    if (existing) {
      existing.messageCount++
      if (msgDate > existing.lastSeenAt) existing.lastSeenAt = msgDate
    } else {
      participantMap.set(key, { name, platform, messageCount: 1, lastSeenAt: msgDate })
    }
  }
  const participants: ConversationParticipant[] = [...participantMap.values()]
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())

  const hasCompactedHistory = activeSummaries.length > 0
  const visibleMessageCount = filteredMessages.length
  const totalMessageCount = recentMessages.length + (hasCompactedHistory ? (recentMessages.length - postSnapshotMessages.length) : 0)
  const oldestVisibleMessageAt = filteredMessages.length > 0 ? (filteredMessages[0]!.createdAt ?? undefined) : undefined

  // Map summaries to the format expected by prompt builder
  const summariesForPrompt = activeSummaries.length > 0
    ? activeSummaries.map((s) => ({
        summary: s.summary,
        firstMessageAt: new Date(s.firstMessageAt as unknown as number),
        lastMessageAt: new Date(s.lastMessageAt as unknown as number),
        depth: s.depth ?? 0,
      }))
    : null

  const SIZE_CAP_PLACEHOLDER_TOKENS = 50  // approx tokens of the trim placeholder message
  return {
    messages: maskedHistory,
    compactingSummaries: summariesForPrompt,
    participants,
    visibleMessageCount,
    totalMessageCount: Math.max(totalMessageCount, visibleMessageCount),
    hasCompactedHistory,
    oldestVisibleMessageAt: oldestVisibleMessageAt ?? undefined,
    maskedToolGroups: maskResult.maskedGroupCount,
    observationCompactedCount: maskResult.observationCompactedCount,
    estimatedTokensSavedByMasking: maskResult.estimatedTokensSaved,
    emergencyTrimmedCount,
    trimmedToolResultsCount: oversizedTrimmedCount,
    trimmedToolResultsTokensSaved: Math.max(0, oversizedTrimmedTokens - oversizedTrimmedCount * SIZE_CAP_PLACEHOLDER_TOKENS),
    trimmedToolCallArgsCount: trimmedArgsCount,
    trimmedToolCallArgsTokensSaved: Math.max(0, trimmedArgsTokens - trimmedArgsCount * SIZE_CAP_PLACEHOLDER_TOKENS),
    trimmedAssistantContentCount: trimmedContentCount,
    trimmedAssistantContentTokensSaved: Math.max(0, trimmedContentTokens - trimmedContentCount * SIZE_CAP_PLACEHOLDER_TOKENS),
    trimmedUserContentCount,
    trimmedUserContentTokensSaved: Math.max(0, trimmedUserContentTokens - trimmedUserContentCount * SIZE_CAP_PLACEHOLDER_TOKENS),
  }
}

/**
 * Determine which provider type a model ID belongs to.
 * @deprecated Use guessProviderType from @/shared/model-ref instead.
 */
function getProviderTypeForModel(modelId: string): string | null {
  return guessProviderType(modelId)
}

/**
 * Resolve a Kin's thinking config from its raw JSON column.
 * Defaults to `{ enabled: true, effort: 'medium' }` when never configured —
 * interleaved thinking measurably reduces tool-result hallucinations on multi-step turns.
 * Explicit `{ enabled: false }` is respected as a user opt-out.
 * Legacy rows with `{ enabled: true }` (no effort, no custom budget) are migrated
 * in-memory to medium so the UI picker reflects the actual runtime behavior.
 */
const DEFAULT_THINKING_CONFIG: KinThinkingConfig = { enabled: true, effort: 'medium', budgetTokens: null }

export function resolveThinkingConfig(rawJson: string | null | undefined): KinThinkingConfig {
  if (!rawJson) return DEFAULT_THINKING_CONFIG
  try {
    const parsed = JSON.parse(rawJson) as KinThinkingConfig
    if (!parsed || typeof parsed !== 'object') return DEFAULT_THINKING_CONFIG
    if (parsed.enabled === true && !parsed.effort && parsed.budgetTokens == null) {
      return { ...parsed, effort: 'medium' }
    }
    return parsed
  } catch {
    return DEFAULT_THINKING_CONFIG
  }
}

/**
 * Effort → budget mapping per provider family.
 * Anthropic/Gemini accept a token budget. OpenAI reasoning models use a string enum.
 * Opus 4.7 ignores the `thinking` param silently (handles thinking internally).
 */
const ANTHROPIC_EFFORT_BUDGETS: Record<KinThinkingEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 24576,
  max: 32000,
}
const GEMINI_EFFORT_BUDGETS: Record<KinThinkingEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 24576,
  max: -1, // unlimited per Google convention
}
const OPENAI_EFFORT_LEVELS: Record<KinThinkingEffort, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'high', // OpenAI caps at 'high'
}

/** Resolve a config to a concrete budget for Anthropic-style providers. */
function resolveAnthropicBudget(config: KinThinkingConfig): number {
  if (config.effort) return ANTHROPIC_EFFORT_BUDGETS[config.effort]
  if (config.budgetTokens != null) return config.budgetTokens
  return ANTHROPIC_EFFORT_BUDGETS.medium
}

/** Resolve a config to a concrete budget for Gemini. */
function resolveGeminiBudget(config: KinThinkingConfig): number {
  if (config.effort) return GEMINI_EFFORT_BUDGETS[config.effort]
  if (config.budgetTokens != null) return config.budgetTokens
  return GEMINI_EFFORT_BUDGETS.medium
}

/**
 * Build provider-specific options to enable thinking/reasoning on the LLM call.
 * Returns undefined when thinking is disabled or the provider doesn't support it.
 */
export function buildThinkingProviderOptions(
  providerType: string,
  config: KinThinkingConfig | null,
): Record<string, Record<string, unknown>> | undefined {
  if (!config?.enabled) return undefined

  if (providerType === 'anthropic' || providerType === 'anthropic-oauth') {
    return {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: resolveAnthropicBudget(config) },
      },
    }
  }
  if (providerType === 'gemini') {
    const budget = resolveGeminiBudget(config)
    return {
      google: {
        thinkingConfig: {
          includeThoughts: true,
          ...(budget != null ? { thinkingBudget: budget } : {}),
        },
      },
    }
  }
  if (providerType === 'openai' || providerType === 'openai-codex') {
    const effort = config.effort ?? 'medium'
    return {
      openai: { reasoningEffort: OPENAI_EFFORT_LEVELS[effort] },
    }
  }
  // Other providers: thinking not supported, silently ignored
  return undefined
}

/**
 * Try to instantiate a Vercel AI SDK model from a specific provider.
 * Returns the model instance on success, or null if this provider can't serve the model.
 */
async function tryCreateModel(
  provider: typeof providers.$inferSelect,
  modelId: string,
  expectedType: string | null,
) {
  if (!provider.isValid) return null

  try {
    const capabilities = JSON.parse(provider.capabilities) as string[]
    if (!capabilities.includes('llm')) return null

    const providerFamily = provider.type === 'anthropic-oauth' ? 'anthropic'
      : provider.type === 'openai-codex' ? 'openai'
      : provider.type
    // OpenRouter can proxy any model, so skip the type check for it
    if (expectedType && providerFamily !== expectedType && providerFamily !== 'openrouter') return null

    const providerConfig = JSON.parse(await decrypt(provider.configEncrypted)) as {
      apiKey: string
      baseUrl?: string
    }

    if (provider.type === 'anthropic') {
      const anthropic = createAnthropic({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
      return anthropic(modelId)
    } else if (provider.type === 'anthropic-oauth') {
      const accessToken = await getOAuthAccessToken(providerConfig.apiKey || undefined)
      const anthropic = createAnthropic({
        apiKey: 'oauth', // placeholder — overridden by custom fetch below
        headers: OAUTH_HEADERS,
        fetch: (async (url: URL | RequestInfo, init: RequestInit | undefined) => {
          const headers = new Headers(init?.headers)
          headers.delete('x-api-key')
          headers.set('authorization', `Bearer ${accessToken}`)

          // Per-request Stainless headers — these change per call and can't
          // live in the static OAUTH_HEADERS. Without them, the request looks
          // like it's coming from a non-Anthropic-SDK client.
          if (!headers.has('x-stainless-retry-count')) {
            headers.set('x-stainless-retry-count', '0')
          }
          if (!headers.has('x-stainless-timeout')) {
            headers.set('x-stainless-timeout', '600')
          }

          // Rewrite `/v1/messages` → `/v1/messages?beta=true` so the request
          // shape matches the official Claude Code CLI (which uses the SDK's
          // `beta.messages.stream()` helper, hitting the `?beta=true` URL).
          // Without this query param, Anthropic likely classifies the request
          // as a non-beta-aware client and re-routes to the "extra usage" pool.
          let rewrittenUrl: URL | RequestInfo = url
          const urlString = typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.toString()
              : url instanceof Request
                ? url.url
                : String(url)
          if (urlString.includes('/v1/messages') && !urlString.includes('beta=true')) {
            const sep = urlString.includes('?') ? '&' : '?'
            const newUrl = `${urlString}${sep}beta=true`
            rewrittenUrl = typeof url === 'string' ? newUrl
              : url instanceof URL ? new URL(newUrl)
              : url instanceof Request ? new Request(newUrl, url)
              : newUrl
          }

          // Three body rewrites needed for OAuth:
          //
          // 1. Compute the signed billing tag and inject it as the FIRST
          //    text block in the system array (before the magic identity
          //    block). Anthropic's request router validates this signature
          //    to decide whether to bill the request against the plan pool
          //    (signature valid) or against "extra usage" (missing/invalid).
          //    The signature is derived from the first user message text
          //    plus a hardcoded salt — see buildBillingHeaderText().
          //
          // 2. Prepend the REQUIRED_SYSTEM_BLOCK identity prefix so the OAuth
          //    endpoint accepts the request. Do NOT add cache_control to
          //    existing blocks — the Vercel AI SDK already places cache_control
          //    on the right blocks (via providerOptions.anthropic.cacheControl
          //    in llm-cache-hints.ts). Forcing cache_control here would either
          //    blow past Anthropic's 4-breakpoint limit, or cache the volatile
          //    segment of the system prompt (which changes each turn —
          //    pure cache-write waste).
          //
          // 3. Inject `metadata.user_id` so the request shape matches the
          //    official Claude Code CLI. Anthropic prefers the OAuth account's
          //    UUID (from ~/.claude.json#oauthAccount.accountUuid) over a
          //    random installation ID.
          if (init?.body && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body)
              const billingBlock = {
                type: 'text' as const,
                text: buildBillingHeaderText(body.messages),
              }
              if (body.system === undefined) {
                body.system = [billingBlock, REQUIRED_SYSTEM_BLOCK]
              } else if (typeof body.system === 'string') {
                body.system = [
                  billingBlock,
                  REQUIRED_SYSTEM_BLOCK,
                  { type: 'text', text: body.system },
                ]
              } else if (Array.isArray(body.system)) {
                body.system = [billingBlock, REQUIRED_SYSTEM_BLOCK, ...body.system]
              }
              if (!body.metadata || typeof body.metadata !== 'object') {
                body.metadata = {}
              }
              if (!body.metadata.user_id) {
                body.metadata.user_id = getOAuthUserId()
              }

              // Debug: dump cache breakpoint layout when DEBUG_OAUTH_CACHE=1
              if (process.env.DEBUG_OAUTH_CACHE) {
                const summarize = (item: unknown, idx: number, kind: 'system' | 'message') => {
                  const it = item as { type?: string; text?: string; content?: unknown; cache_control?: unknown; role?: string }
                  let preview = ''
                  let length = 0
                  let hasCacheControl = false
                  if (kind === 'system') {
                    preview = (it.text ?? '').slice(0, 60)
                    length = (it.text ?? '').length
                    hasCacheControl = !!it.cache_control
                  } else {
                    if (typeof it.content === 'string') {
                      preview = it.content.slice(0, 60)
                      length = it.content.length
                    } else if (Array.isArray(it.content)) {
                      const blocks = it.content as Array<{ type: string; text?: string; cache_control?: unknown }>
                      preview = blocks.map(b => b.text ?? `<${b.type}>`).join('|').slice(0, 60)
                      length = blocks.reduce((acc, b) => acc + (b.text?.length ?? 0), 0)
                      hasCacheControl = blocks.some(b => !!b.cache_control)
                    }
                  }
                  return `  [${idx}] ${kind} role=${it.role ?? '-'} cc=${hasCacheControl ? 'YES' : 'no '} len=${length.toString().padStart(6)} | ${preview.replace(/\n/g, '\\n')}`
                }
                const lines: string[] = ['OAuth wire dump:']
                if (Array.isArray(body.system)) {
                  body.system.forEach((s: unknown, i: number) => lines.push(summarize(s, i, 'system')))
                }
                if (Array.isArray(body.messages)) {
                  body.messages.forEach((m: unknown, i: number) => lines.push(summarize(m, i, 'message')))
                }
                log.info({ provider: 'anthropic-oauth' }, lines.join('\n'))
              }

              init = { ...init, body: JSON.stringify(body) }
            } catch {
              // Not JSON, pass through
            }
          }

          return globalThis.fetch(rewrittenUrl, { ...init, headers })
        }) as unknown as typeof fetch,
      })
      return anthropic(modelId)
    } else if (provider.type === 'openai-codex') {
      const { accessToken, accountId } = await getCodexOAuthCredentials(providerConfig.apiKey || undefined)
      const openai = createOpenAI({
        apiKey: 'codex-oauth', // placeholder — overridden by custom fetch
        baseURL: CODEX_BASE_URL,
        fetch: (async (url: URL | RequestInfo, init: RequestInit | undefined) => {
          const headers = new Headers(init?.headers)
          headers.set('Authorization', `Bearer ${accessToken}`)
          headers.set('ChatGPT-Account-ID', accountId)

          // Modify request body: strip forbidden params, enforce store: false
          if (init?.body && typeof init.body === 'string') {
            try {
              const body = JSON.parse(init.body)
              delete body.max_output_tokens
              body.store = false
              init = { ...init, body: JSON.stringify(body) }
            } catch {
              // Not JSON, pass through
            }
          }

          return globalThis.fetch(url, { ...init, headers })
        }) as unknown as typeof fetch,
      })
      return openai.responses(modelId)
    } else if (provider.type === 'openai') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
      return openai.chat(modelId)
    } else if (provider.type === 'gemini') {
      const google = createGoogleGenerativeAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
      return google(modelId)
    } else if (provider.type === 'openrouter') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://openrouter.ai/api/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'deepseek') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.deepseek.com/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'groq') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.groq.com/openai/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'together') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.together.xyz/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'fireworks') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.fireworks.ai/inference/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'mistral') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.mistral.ai/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'xai') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.x.ai/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'perplexity') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.perplexity.ai' })
      return openai.chat(modelId)
    } else if (provider.type === 'cohere') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl ?? 'https://api.cohere.com/v2' })
      return openai.chat(modelId)
    } else if (provider.type === 'ollama') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey || 'ollama', baseURL: providerConfig.baseUrl ?? 'http://localhost:11434/v1' })
      return openai.chat(modelId)
    } else if (provider.type === 'openai-compatible') {
      const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
      return openai.chat(modelId)
    }
  } catch {
    return null
  }

  return null
}

/**
 * Resolve a model string (e.g. "claude-sonnet-4-20250514") to a Vercel AI SDK model.
 * If preferredProviderId is set, that provider is tried first before falling back to first-match.
 */
export async function resolveLLMModel(modelId: string, preferredProviderId?: string | null) {
  if (!preferredProviderId) {
    log.warn({ modelId }, 'resolveLLMModel called without providerId — using auto-detect (deprecated)')
  }
  const allProviders = await db.select().from(providers).all()
  const expectedType = getProviderTypeForModel(modelId)

  // If a preferred provider is specified, try it first — skip type heuristic since user explicitly chose this provider
  if (preferredProviderId) {
    const preferred = allProviders.find((p) => p.id === preferredProviderId)
    if (preferred) {
      const result = await tryCreateModel(preferred, modelId, null)
      if (result) return result
    }
  }

  // Fallback: first-match (skip the preferred one since we already tried it)
  for (const provider of allProviders) {
    if (preferredProviderId && provider.id === preferredProviderId) continue
    const result = await tryCreateModel(provider, modelId, expectedType)
    if (result) return result
  }

  return null
}

// ─── Queue Worker ───────────────────────────────────────────────────────────

let workerInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start the queue worker that polls all Kin queues.
 */
export function startQueueWorker() {
  if (workerInterval) return

  // On startup, reset any items stuck in 'processing' (e.g. after a crash)
  recoverStaleProcessingItems()
  recoverStaleTasks()

  workerInterval = setInterval(async () => {
    const allKins = await db.select({ id: kins.id }).from(kins).all()

    for (const kin of allKins) {
      // Slot 1: Main session — one message per Kin per tick
      await processNextMessage(kin.id)
      // Slot 2: Quick sessions — independent parallel slot
      await processQuickMessage(kin.id)
    }
  }, config.queue.pollIntervalMs)

  log.info({ pollIntervalMs: config.queue.pollIntervalMs }, 'Queue worker started')
}

/**
 * Stop the queue worker.
 */
export function stopQueueWorker() {
  if (workerInterval) {
    clearInterval(workerInterval)
    workerInterval = null
  }
}
