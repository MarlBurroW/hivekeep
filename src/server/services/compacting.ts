import { safeGenerateText } from '@/server/services/llm-helpers'
import { eq, and, desc, asc, isNull, inArray, ne, sql } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db, sqlite } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import {
  messages,
  compactingSummaries,
  agents,
  userProfiles,
} from '@/server/db/schema'
import { config } from '@/server/config'
import { getQueueSize } from '@/server/services/queue'
import { getDefaultCompactingModel, getDefaultCompactingProviderId } from '@/server/services/app-settings'
import { sseManager } from '@/server/sse/index'
import { getModelContextWindow } from '@/shared/model-context-windows'
import { countTokens } from '@/shared/token-estimator'
import type { AgentCompactingConfig } from '@/shared/types'

const log = createLogger('compacting')

// Token counting for every compaction budget (keep-window, trigger, summaries).
// Uses the shared BPE tokenizer (gpt-tokenizer / o200k_base) — within ~5-15% of
// the real provider count, vs chars/4 which under-counts JSON/tool-heavy history
// by ~2×. The encoder is preloaded at server boot (src/server/index.ts), so the
// synchronous path hits BPE; it falls back to chars/4 only on a cold first call.
// Because budgets are measured in the same honest unit as the context window,
// no estimate→real calibration factor is needed.
function estimateTokens(text: string): number {
  return countTokens(text)
}

// ─── Budget resolution (pure, exported for tests) ─────────────────────────────
//
// Each percentage knob scales with the context window, so on a 1M-token model a
// "small" 25% keep-window is 250k tokens. An absolute ceiling bounds the real
// footprint regardless of window size: `effective = min(percent × window, cap)`.
// On a 200k model the percent still dominates, so the caps only engage on
// large-window models.

/** Raw-message keep-window budget (real tokens). */
export function resolveKeepBudget(keepPercent: number, contextWindow: number, keepMaxTokens: number): number {
  return Math.min(Math.floor((keepPercent / 100) * contextWindow), keepMaxTokens)
}

/** Context size that triggers compaction (real tokens). */
export function resolveTriggerTokens(thresholdPercent: number, contextWindow: number, triggerMaxTokens: number): number {
  return Math.min(Math.floor((thresholdPercent / 100) * contextWindow), triggerMaxTokens)
}

/** Total active-summary budget before telescopic merge (real tokens). */
export function resolveSummaryBudget(summaryBudgetPercent: number, contextWindow: number, summaryMaxTokens: number): number {
  return Math.min(Math.floor((summaryBudgetPercent / 100) * contextWindow), summaryMaxTokens)
}

// ─── Per-Agent Effective Config ─────────────────────────────────────────────────

interface EffectiveCompactingConfig {
  thresholdPercent: number
  keepPercent: number
  summaryBudgetPercent: number
  maxSummaries: number
  keepMaxTokens: number
  triggerMaxTokens: number
  summaryMaxTokens: number
  model: string
  providerId: string | null
}

/**
 * Resolve effective compacting config for an Agent.
 * Per-Agent overrides > global env vars > defaults.
 */
async function getEffectiveCompactingConfig(agentId: string): Promise<EffectiveCompactingConfig> {
  const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) throw new Error(`Agent ${agentId} not found`)

  let perAgent: AgentCompactingConfig | null = null
  if (agent.compactingConfig) {
    try { perAgent = JSON.parse(agent.compactingConfig) as AgentCompactingConfig } catch { /* ignore */ }
  }

  const thresholdPercent = perAgent?.thresholdPercent ?? config.compacting.thresholdPercent
  const keepPercent = perAgent?.keepPercent ?? config.compacting.keepPercent
  const summaryBudgetPercent = perAgent?.summaryBudgetPercent ?? config.compacting.summaryBudgetPercent
  const maxSummaries = perAgent?.maxSummaries ?? config.compacting.maxSummaries
  const keepMaxTokens = perAgent?.keepMaxTokens ?? config.compacting.keepMaxTokens
  const triggerMaxTokens = perAgent?.triggerMaxTokens ?? config.compacting.triggerMaxTokens
  const summaryMaxTokens = perAgent?.summaryMaxTokens ?? config.compacting.summaryMaxTokens

  // Model: per-Agent override > app_setting default > env COMPACTING_MODEL > Agent's own model
  // Sentinel '__agent_own__' means "use this agent's own model" (skips defaults)
  let model: string
  let providerId: string | null

  const defaultCompactingModel = await getDefaultCompactingModel()
  const defaultCompactingProviderId = await getDefaultCompactingProviderId()

  if (perAgent?.compactingModel === '__agent_own__') {
    model = agent.model
    providerId = agent.providerId
  } else if (perAgent?.compactingModel) {
    model = perAgent.compactingModel
    providerId = perAgent.compactingProviderId ?? null
  } else if (defaultCompactingModel) {
    model = defaultCompactingModel
    providerId = defaultCompactingProviderId
  } else if (config.compacting.model) {
    model = config.compacting.model
    providerId = null
  } else {
    model = agent.model
    providerId = agent.providerId
  }

  return { thresholdPercent, keepPercent, summaryBudgetPercent, maxSummaries, keepMaxTokens, triggerMaxTokens, summaryMaxTokens, model, providerId }
}

// ─── Threshold Evaluation ────────────────────────────────────────────────────

/**
 * Evaluate whether compacting should trigger for an Agent.
 * Uses token-based threshold: triggers when context tokens exceed thresholdPercent of context window.
 *
 * Prefers the provider-reported `apiContextTokens` from the cache (ground
 * truth from the last LLM roundtrip) over the local BPE estimate. The BPE
 * estimate (gpt-tokenizer) is within ~5-15% of the real count, but the exact
 * provider number is better still when we have a fresh one.
 */
export async function shouldCompact(agentId: string, contextTokens?: number, contextWindow?: number): Promise<boolean> {
  const effectiveConfig = await getEffectiveCompactingConfig(agentId)

  if (contextTokens != null && contextWindow != null && contextWindow > 0) {
    // If the cache has a fresh provider-reported size from the most recent
    // turn and it exceeds the caller-supplied estimate, trust the ground
    // truth — the next call will be at least as large.
    const { getLastContextUsage } = await import('@/server/services/agent-engine')
    const cached = await getLastContextUsage(agentId)
    const effectiveTokens = cached?.apiContextTokens != null && cached.apiContextTokens > contextTokens
      ? cached.apiContextTokens
      : contextTokens
    const triggerAt = resolveTriggerTokens(
      effectiveConfig.thresholdPercent,
      contextWindow,
      effectiveConfig.triggerMaxTokens,
    )
    return effectiveTokens > triggerAt
  }

  // Fallback: estimate from DB
  const agent = await db.select({ model: agents.model }).from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return false

  const ctxWindow = getModelContextWindow(agent.model)
  if (ctxWindow <= 0) return false

  // Estimate non-compacted message tokens
  const activeSummaries = await getActiveSummaries(agentId)
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null

  const nonCompactedMessages = await getNonCompactedMessages(agentId, latestSummary)
  // Same reason as in runCompacting: counting only content under-counts
  // tool-heavy Agents by 10-100× and lets shouldCompact silently miss its
  // threshold when there's no fresh apiContextTokens in the cache yet.
  const messageTokens = nonCompactedMessages.reduce(
    (sum, m) => sum + estimateTokens(m.content ?? '') + estimateTokens((m.toolCalls as string | null) ?? ''),
    0,
  )
  const summaryTokens = activeSummaries.reduce((sum, s) => sum + estimateTokens(s.summary), 0)

  // Rough estimate: messages + summaries + ~2000 for system prompt + ~1000 for tools
  const estimatedTotal = messageTokens + summaryTokens + 3000
  const triggerAt = resolveTriggerTokens(
    effectiveConfig.thresholdPercent,
    ctxWindow,
    effectiveConfig.triggerMaxTokens,
  )
  return estimatedTotal > triggerAt
}

// ─── Public: compacting proximity for UI ─────────────────────────────────────

export interface CompactingProximity {
  currentPercent: number
  thresholdPercent: number
  summaryCount: number
  maxSummaries: number
  summaryTokens: number
  summaryBudgetTokens: number
  keepPercent: number
}

/** Get compacting proximity data for display in the chat UI (percentage-based) */
export async function getCompactingProximity(agentId: string): Promise<CompactingProximity> {
  const effectiveConfig = await getEffectiveCompactingConfig(agentId)

  // Try to get cached context usage from agent-engine
  const { getLastContextUsage } = await import('@/server/services/agent-engine')
  const cached = await getLastContextUsage(agentId)

  let currentPercent = 0
  const contextWindow = cached?.contextWindow ?? 0
  if (cached && contextWindow > 0) {
    // Prefer provider-reported ground truth over local estimate — same
    // reason as in shouldCompact: estimates routinely under-count, which
    // makes the displayed proximity bar lie about how close the Agent is
    // to compacting.
    const tokens = cached.apiContextTokens ?? cached.contextTokens
    currentPercent = Math.round((tokens / contextWindow) * 100)
  }

  const activeSummaries = await getActiveSummaries(agentId)
  // Calibrate to real tokens (same per-Agent factor as the keep-window / merge)
  // so the displayed summary figure matches the real-token summary budget.
  const calibration = cached?.calibrationFactor ?? 1
  const summaryTokens = activeSummaries.reduce((sum, s) => sum + Math.round(estimateTokens(s.summary) * calibration), 0)
  // Report the EFFECTIVE budgets (after the absolute caps), not the raw
  // percentages — otherwise on a 1M-window model the bar would claim
  // "triggers at 75%" while compaction actually fires at 300k (≈30%).
  const summaryBudgetTokens = contextWindow > 0
    ? resolveSummaryBudget(effectiveConfig.summaryBudgetPercent, contextWindow, effectiveConfig.summaryMaxTokens)
    : 0
  const effectiveThresholdPercent = contextWindow > 0
    ? Math.round(
        (resolveTriggerTokens(effectiveConfig.thresholdPercent, contextWindow, effectiveConfig.triggerMaxTokens) /
          contextWindow) * 100,
      )
    : effectiveConfig.thresholdPercent

  return {
    currentPercent,
    thresholdPercent: effectiveThresholdPercent,
    summaryCount: activeSummaries.length,
    maxSummaries: effectiveConfig.maxSummaries,
    summaryTokens,
    summaryBudgetTokens,
    keepPercent: effectiveConfig.keepPercent,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get all active (in-context) summaries for an Agent, ordered oldest to newest */
async function getActiveSummaries(agentId: string) {
  return db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.agentId, agentId), eq(compactingSummaries.isInContext, true)))
    .orderBy(asc(compactingSummaries.lastMessageAt))
    .all()
}

/** Get non-compacted messages after a cutoff timestamp */
/**
 * The compaction boundary, resolved to an insertion rowid when possible.
 *
 * Timestamps are milliseconds and one LLM step inserts several rows
 * back-to-back (assistant + tool results often share one ms), so a strict
 * `createdAt > lastMessageAt` filter can permanently drop a same-ms sibling
 * that was never summarized — silent context loss. The messages rowid is
 * insertion-ordered and unique, so "after the boundary" is exactly
 * "rowid > the boundary row's rowid". Falls back to the timestamp when the
 * boundary message no longer exists (summaries repaired after deletion).
 */
export type CompactionBoundary = { rowid: number } | { timestamp: number } | null

export function resolveCompactionBoundary(
  latestSummary: { lastMessageAt: unknown; lastMessageId: string | null } | null,
): CompactionBoundary {
  if (!latestSummary) return null
  if (latestSummary.lastMessageId) {
    const row = sqlite
      .query<{ rowid: number }, [string]>('SELECT rowid FROM messages WHERE id = ?')
      .get(latestSummary.lastMessageId)
    if (row) return { rowid: row.rowid }
  }
  const ts = latestSummary.lastMessageAt instanceof Date
    ? latestSummary.lastMessageAt.getTime()
    : (latestSummary.lastMessageAt as number)
  return { timestamp: ts }
}

/** Row filter matching resolveCompactionBoundary, for callers that already
 *  hold hydrated rows (engine history load, context preview). */
export function isAfterCompactionBoundary(
  boundary: CompactionBoundary,
  m: { createdAt: unknown; rowid?: number },
): boolean {
  if (!boundary) return true
  if ('rowid' in boundary) return (m.rowid ?? Number.MAX_SAFE_INTEGER) > boundary.rowid
  const ts = m.createdAt instanceof Date ? m.createdAt.getTime() : (m.createdAt as number | null)
  return !!ts && ts > boundary.timestamp
}

async function getNonCompactedMessages(
  agentId: string,
  latestSummary: { lastMessageAt: unknown; lastMessageId: string | null } | null,
) {
  const boundary = resolveCompactionBoundary(latestSummary)
  const conditions = [
    eq(messages.agentId, agentId),
    isNull(messages.taskId),
    isNull(messages.sessionId),
    eq(messages.redactPending, false),
    ne(messages.sourceType, 'compacting'),
  ]
  // Cutoff in SQL: this runs after every LLM turn and messages are never
  // deleted by design, so loading the full history to filter in JS grew
  // unboundedly with conversation age.
  if (boundary) {
    conditions.push(
      'rowid' in boundary
        ? sql`rowid > ${boundary.rowid}`
        : sql`${messages.createdAt} > ${boundary.timestamp}`,
    )
  }
  return db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.createdAt), asc(sql`rowid`))
    .all()
}

// ─── Core Compacting ─────────────────────────────────────────────────────────

export interface CompactingResult {
  summary: string
  memoriesExtracted: number
}

/**
 * Run the compacting process for an Agent.
 * 1. Find the keep-window boundary (keep recent messages fitting keepPercent of context)
 * 2. Summarize everything before the boundary into a NEW summary
 * 3. Run memory extraction on compacted messages
 * 4. Check if telescopic merge is needed
 */
export async function runCompacting(
  agentId: string,
  contextWindow?: number,
  options?: { aggressive?: boolean },
): Promise<CompactingResult | null> {
  const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  const effectiveConfig = await getEffectiveCompactingConfig(agentId)
  const ctxWindow = contextWindow ?? getModelContextWindow(agent.model)
  const keepPercent = effectiveConfig.keepPercent

  // Get the latest summary to determine the cutoff point
  const activeSummaries = await getActiveSummaries(agentId)
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null

  // Get non-compacted messages
  const nonCompacted = await getNonCompactedMessages(agentId, latestSummary)
  if (nonCompacted.length === 0) return null

  // Compute keep-window: walk backward from newest, accumulating tokens until keepPercent budget.
  //
  // The per-message size MUST include the toolCalls JSON, not just the text
  // content. For tool-heavy Agents (kubectl, browser, file reads) the JSON is
  // 10-100× the text — counting only content makes the budget budget look
  // empty, every message fits in the keep window, messagesToSummarize ends
  // up empty, and runCompacting silently returns null every time. The Agent
  // then accumulates context unboundedly until the main turn itself crashes.
  // Two budget modes:
  //  - regular: keepPercent of ctxWindow (e.g. 25% of 1M = 250k)
  //  - aggressive (force-compact): min(regular, half of CURRENT non-compacted
  //    total). Halving relative to current-state guarantees the algo always
  //    finds something to summarize when the user explicitly asks, even when
  //    the recent tail already fits the regular budget. Without the relative
  //    cap, an Agent sitting at 90k of messages with 250k budget got "nothing to
  //    compact" forever despite the user wanting more relief.
  // Calibrate raw BPE up to the Agent's measured real-token count, using the same
  // per-Agent EMA factor (api/raw, clamped [0.7,3.0]) the navbar/visualizer use.
  // countTokens (o200k) under-counts Anthropic by ~1.7× on tool-heavy Agents, so
  // an un-calibrated 100k cap really kept ~170k. Anchoring on the measured factor
  // makes "keep 100k" mean 100k REAL tokens — the same unit as the context window.
  const { getLastContextUsage } = await import('@/server/services/agent-engine')
  const calibration = (await getLastContextUsage(agentId))?.calibrationFactor ?? 1
  const msgTokensOf = (m: (typeof nonCompacted)[number]) =>
    Math.round((estimateTokens(m.content ?? '') + estimateTokens((m.toolCalls as string | null) ?? '')) * calibration)

  const totalNonCompactedTokens = nonCompacted.reduce((sum, m) => sum + msgTokensOf(m), 0)
  // min(keepPercent% of window, keepMaxTokens) — the absolute cap keeps the
  // post-compaction footprint bounded on large-window models (e.g. 1M), where
  // 25% would otherwise be 250k tokens of raw messages.
  const regularBudget = resolveKeepBudget(keepPercent, ctxWindow, effectiveConfig.keepMaxTokens)
  const keepBudget = options?.aggressive
    ? Math.min(regularBudget, Math.floor(totalNonCompactedTokens / 2))
    : regularBudget
  let keepTokens = 0
  let keepStartIndex = nonCompacted.length
  for (let i = nonCompacted.length - 1; i >= 0; i--) {
    const m = nonCompacted[i]!
    const msgTokens = msgTokensOf(m)
    if (keepTokens + msgTokens > keepBudget) break
    keepTokens += msgTokens
    keepStartIndex = i
  }

  // Messages to summarize = everything before the keep window
  const messagesToSummarize = nonCompacted.slice(0, keepStartIndex)
  if (messagesToSummarize.length === 0) return null

  // Skip when the summarizable batch is tiny (not worth a summarization LLM
  // call). Token-based threshold instead of message count: a single 100k+
  // tool-result message MUST be compactable on its own — refusing it because
  // "only 1 message" is the bug that left users stuck at 343k of non-compacted
  // history forever (the oldest non-compacted message can be huge enough that
  // the keep-window walk leaves a single-message slice).
  const summarizeTokens = messagesToSummarize.reduce((sum, m) => sum + msgTokensOf(m), 0)
  const MIN_SUMMARIZE_TOKENS = 2000
  if (summarizeTokens < MIN_SUMMARIZE_TOKENS) return null

  const lastSummarizedMessage = messagesToSummarize[messagesToSummarize.length - 1]!
  const firstSummarizedMessage = messagesToSummarize[0]!

  // Build pseudonym map for user messages
  const userSourceIds = [
    ...new Set(
      messagesToSummarize
        .filter((m) => m.sourceType === 'user' && m.sourceId)
        .map((m) => m.sourceId!),
    ),
  ]
  const pseudonymMap = new Map<string, string>()
  for (const uid of userSourceIds) {
    const profile = await db.select().from(userProfiles).where(eq(userProfiles.userId, uid)).get()
    if (profile?.pseudonym) pseudonymMap.set(uid, profile.pseudonym)
  }

  // Format messages for the prompt, masking verbose tool results
  const formattedMessages = messagesToSummarize
    .map((m) => {
      const sender =
        m.role === 'user' && m.sourceId
          ? pseudonymMap.get(m.sourceId) ?? 'User'
          : m.role === 'assistant'
            ? agent.name
            : m.role
      const ts = m.createdAt ? new Date(m.createdAt as unknown as number).toISOString() : ''

      let content = m.content ?? ''

      // Mask tool results — the summarization LLM doesn't need raw JSON
      if (m.role === 'tool' && content.length > 500) {
        content = `[Tool result — ${content.length} chars, collapsed for summarization]`
      }

      // For assistant messages with toolCalls JSON, keep only the text content
      if (m.role === 'assistant' && m.toolCalls) {
        try {
          const calls = JSON.parse(m.toolCalls as string) as Array<{ toolName?: string }>
          const toolNames = calls.map((c) => c.toolName ?? 'unknown').join(', ')
          const textContent = content || ''
          content = textContent
            ? `${textContent}\n[Called tools: ${toolNames}]`
            : `[Called tools: ${toolNames}]`
        } catch {
          // keep original content if toolCalls isn't valid JSON
        }
      }

      return `[${ts}] ${sender}: ${content}`
    })
    .join('\n\n')

  // Compute time range
  const firstTs = firstSummarizedMessage.createdAt ? new Date(firstSummarizedMessage.createdAt as unknown as number).toISOString() : 'unknown'
  const lastTs = lastSummarizedMessage.createdAt ? new Date(lastSummarizedMessage.createdAt as unknown as number).toISOString() : 'unknown'

  // Build compacting prompt — no "integrate previous summary" since summaries now stack
  const systemPrompt =
    `You are an assistant specialized in conversation summarization.\n` +
    `Your role is to produce a faithful, structured summary of the exchanges below.\n\n` +
    `Time range: ${firstTs} to ${lastTs} (${messagesToSummarize.length} messages)\n\n` +
    `## Output structure\n\n` +
    `Organize your summary using these sections (skip any that are empty):\n\n` +
    `### Key facts & decisions\n` +
    `Bullet points of important information learned, decisions made, preferences expressed. Attribute to the person who said it.\n\n` +
    `### Completed work\n` +
    `What was accomplished: tasks finished, research done, problems solved, results obtained.\n\n` +
    `### Open threads\n` +
    `Unresolved questions, pending tasks, things promised but not yet done, topics that need follow-up. This section is CRITICAL — it ensures nothing falls through the cracks.\n\n` +
    `### Conversation dynamics\n` +
    `Only if relevant: who was active, any notable interactions, tone shifts, or relationship context worth preserving.\n\n` +
    `## Rules\n\n` +
    `- Preserve ALL important facts, decisions made, commitments, and expressed preferences\n` +
    `- Preserve the identity of who said what (use names/pseudonyms)\n` +
    `- Preserve results of research, calculations, or work performed\n` +
    `- Do not invent anything — only summarize what is explicitly present\n` +
    `- Be concise but complete. Prefer bullet points\n` +
    `- Pay special attention to OPEN THREADS — unfinished business is the most important thing to preserve\n\n` +
    `## Exchanges to summarize\n\n${formattedMessages}`

  // Resolve model for compacting. If the configured compacting model is
  // smaller than the prompt we're about to send (typical: a cheap Haiku at
  // 200k window summarizing 600k of tool-heavy history), fall back to the
  // Agent's own model — which by definition handled the original payload, so
  // it can handle the same payload reformatted as a summarization prompt.
  // Without this, the API call throws "prompt is too long" and the Agent's
  // context grows unboundedly because compacting silently fails every turn.
  const { resolveLLM } = await import('@/server/llm/core/resolve')
  let effectiveModelId = effectiveConfig.model
  let effectiveProviderId = effectiveConfig.providerId
  const promptTokens = estimateTokens(systemPrompt)
  const compactingModelWindow = getModelContextWindow(effectiveModelId)
  // Reserve ~2k tokens for the LLM's own output. If the prompt alone already
  // takes 95%+ of the window, fallback even before the API rejects it.
  const usableWindow = compactingModelWindow > 0 ? compactingModelWindow - 2000 : 0
  if (compactingModelWindow > 0 && promptTokens > usableWindow && effectiveModelId !== agent.model) {
    log.warn({
      agentId,
      configuredModel: effectiveModelId,
      configuredWindow: compactingModelWindow,
      promptTokens,
      fallbackModel: agent.model,
    }, 'Compacting prompt exceeds configured model window — falling back to Agent model')
    effectiveModelId = agent.model
    effectiveProviderId = agent.providerId
  }

  let resolved
  try {
    resolved = await resolveLLM({ modelId: effectiveModelId, providerId: effectiveProviderId })
  } catch (err) {
    log.warn({ agentId, effectiveModelId, effectiveProviderId, err }, 'No LLM model available for compacting — provider/model misconfiguration')
    throw new Error(`Compacting model '${effectiveModelId}' is unavailable. Check the Agent's compacting model + provider in settings.`)
  }

  // Cap the generated summary at one summary's slice of the budget so the
  // LLM can't produce a 100k summary that itself triggers compacting next
  // turn. Reserves a 50% headroom so a slightly chatty model still fits.
  const perSummaryBudget = Math.max(
    1500,
    Math.floor((effectiveConfig.summaryBudgetPercent / 100) * ctxWindow / Math.max(1, effectiveConfig.maxSummaries)),
  )
  const summaryMaxTokens = Math.floor(perSummaryBudget * 1.5)

  try {
    // Generate summary. Hard timeout: a stuck provider call would otherwise
    // hold the compactingAgents lock indefinitely, blocking every subsequent
    // user message for this Agent. 5 min covers slow providers / large prompts
    // while still surfacing a real hang within a tolerable window.
    const result = await safeGenerateText({
      resolved,
      prompt: systemPrompt,
      maxTokens: summaryMaxTokens,
      timeoutMs: 5 * 60 * 1000,
      callSite: 'compacting',
      agentId,
    })

    const summary = result.text
    if (!summary) return null

    // Sanity check: warn if the summary is still oversized despite the cap
    // (cap might have been raised by maxOutputTokens=… being honored as a
    // soft limit on some providers).
    const actualTokens = estimateTokens(summary)
    if (actualTokens > perSummaryBudget * 2) {
      log.warn(
        { agentId, actualTokens, perSummaryBudget, summaryMaxTokens },
        'Generated summary exceeds 2x its per-summary budget — consider lowering keepPercent or raising maxSummaries',
      )
    }

    const firstMsgAt = firstSummarizedMessage.createdAt as unknown as number
    const lastMsgAt = lastSummarizedMessage.createdAt as unknown as number

    // Save new summary
    const newSummaryId = uuid()
    await db.insert(compactingSummaries).values({
      id: newSummaryId,
      agentId,
      summary,
      firstMessageAt: new Date(firstMsgAt),
      lastMessageAt: new Date(lastMsgAt),
      firstMessageId: firstSummarizedMessage.id,
      lastMessageId: lastSummarizedMessage.id,
      messageCount: messagesToSummarize.length,
      tokenEstimate: estimateTokens(summary),
      isInContext: true,
      depth: 0,
      createdAt: new Date(),
    })

    // Memory maintenance: extract episodic memories into the archive AND
    // rewrite the always-injected profile document, in one LLM call.
    const { runMemoryMaintenance } = await import('@/server/services/memory-maintenance')
    const { memoriesExtracted } = await runMemoryMaintenance({
      agentId,
      agentModel: agent.model,
      agentProviderId: agent.providerId,
      messagesToAnalyze: messagesToSummarize,
      lastMessageId: lastSummarizedMessage.id,
      summary,
    })

    // Persist a system message so the compaction trace survives page refresh
    // role='system' is skipped by buildMessageHistory → won't pollute LLM context
    const compactingMessageId = uuid()
    await db.insert(messages).values({
      id: compactingMessageId,
      agentId,
      role: 'system',
      content: summary,
      sourceType: 'compacting',
      isRedacted: false,
      redactPending: false,
      metadata: JSON.stringify({ memoriesExtracted }),
      createdAt: new Date(),
    })

    log.info({ agentId, summaryId: newSummaryId, summarizedMessages: messagesToSummarize.length, memoriesExtracted }, 'Compacting batch completed')

    // Emit SSE: compaction done. messageCount lets the UI tell the user
    // "compacted N messages" — concrete signal of what just happened
    // beyond the abstract "compacting done" status.
    sseManager.sendToAgent(agentId, {
      type: 'compacting:done',
      agentId,
      data: { agentId, summary, memoriesExtracted, messageCount: messagesToSummarize.length },
    })

    // The cached apiContextTokens (provider ground truth from the last main
    // turn) was for a payload that no longer corresponds to the current
    // context — leaving it would have the navbar still showing the
    // pre-compaction "real 750k" until the next main turn. Drop it so the
    // UI falls back to the (calibrated) estimate, which reflects reality
    // until the next roundtrip restores ground truth.
    const { invalidateApiContextSize } = await import('@/server/services/agent-engine')
    invalidateApiContextSize(agentId)
    sseManager.sendToAgent(agentId, {
      type: 'queue:update',
      agentId,
      // null (not undefined) signals to the client SSE handler that we want
      // to actively clear apiContextTokens, not just "no update for this
      // field". The handler treats null distinctly from omission.
      data: { agentId, queueSize: await getQueueSize(agentId), isProcessing: false, apiContextTokens: null },
    })

    // Check if telescopic merge is needed after adding new summary
    await maybeMergeSummaries(agentId, ctxWindow)

    // Clean up old archived summaries beyond retention limit
    await cleanupSummaries(agentId)

    return { summary, memoriesExtracted }
  } catch (err) {
    // Extract detailed error info (API errors often have status/statusCode)
    let errorMessage = 'Unknown compacting error'
    if (err instanceof Error) {
      const apiErr = err as Error & { status?: number; statusCode?: number; responseBody?: string }
      const status = apiErr.status ?? apiErr.statusCode
      errorMessage = status
        ? `${err.message} (HTTP ${status})`
        : err.message
    }

    log.error({ agentId, err, model: effectiveConfig.model, providerId: effectiveConfig.providerId }, 'Compacting LLM call failed')

    // Persist error in conversation history
    await db.insert(messages).values({
      id: uuid(),
      agentId,
      role: 'system',
      content: '',
      sourceType: 'compacting',
      isRedacted: false,
      redactPending: false,
      metadata: JSON.stringify({ error: errorMessage }),
      createdAt: new Date(),
    })

    // Emit SSE: compaction failed (so UI can clear the spinner)
    sseManager.sendToAgent(agentId, {
      type: 'compacting:error',
      agentId,
      data: { agentId, error: errorMessage },
    })
    throw err // re-throw for maybeCompact to log
  }
}

// ─── Telescopic Summary Merge ────────────────────────────────────────────────

/**
 * Merge the oldest active summaries when they exceed the budget.
 * This creates a higher-level (depth+1) summary and archives the originals.
 * NO memory extraction during merge — memories were already extracted at depth 0.
 */
async function maybeMergeSummaries(agentId: string, contextWindow: number): Promise<void> {
  const effectiveConfig = await getEffectiveCompactingConfig(agentId)
  const activeSummaries = await getActiveSummaries(agentId)

  if (activeSummaries.length <= 2) return // nothing to merge

  // Calibrate to real tokens (same per-Agent factor as the keep-window) so the
  // budget comparison is in the same unit as summaryMaxTokens.
  const { getLastContextUsage } = await import('@/server/services/agent-engine')
  const calibration = (await getLastContextUsage(agentId))?.calibrationFactor ?? 1
  const totalSummaryTokens = activeSummaries.reduce(
    (sum, s) => sum + Math.round(estimateTokens(s.summary) * calibration),
    0,
  )
  // min(summaryBudgetPercent% of window, summaryMaxTokens) — the absolute cap
  // keeps the summary block from ballooning to 20% of a 1M window (200k).
  const summaryBudget = resolveSummaryBudget(
    effectiveConfig.summaryBudgetPercent,
    contextWindow,
    effectiveConfig.summaryMaxTokens,
  )

  const needsMerge = activeSummaries.length > effectiveConfig.maxSummaries || totalSummaryTokens > summaryBudget
  if (!needsMerge) return

  // Take the oldest half of summaries to merge (min 2)
  const mergeCount = Math.max(2, Math.floor(activeSummaries.length / 2))
  const toMerge = activeSummaries.slice(0, mergeCount)

  // Build merge prompt
  const summaryTexts = toMerge
    .map((s) => {
      const from = new Date(s.firstMessageAt as unknown as number).toISOString()
      const to = new Date(s.lastMessageAt as unknown as number).toISOString()
      return `### Summary (${from} → ${to})\n\n${s.summary}`
    })
    .join('\n\n---\n\n')

  const firstSummary = toMerge[0]!
  const lastSummary = toMerge[toMerge.length - 1]!
  const firstTs = new Date(firstSummary.firstMessageAt as unknown as number).toISOString()
  const lastTs = new Date(lastSummary.lastMessageAt as unknown as number).toISOString()

  const mergePrompt =
    `You are an assistant specialized in summary consolidation.\n` +
    `Merge the following ${toMerge.length} conversation summaries into one concise, unified summary.\n\n` +
    `Combined time range: ${firstTs} to ${lastTs}\n\n` +
    `## Rules\n\n` +
    `- Preserve all key facts, decisions, and important outcomes\n` +
    `- Remove redundancy and consolidate overlapping information\n` +
    `- Close open threads that were resolved in later summaries\n` +
    `- Keep unresolved open threads\n` +
    `- Be more concise than the originals — this is a higher-level summary\n` +
    `- Preserve attribution (who said/did what)\n\n` +
    `## Summaries to merge\n\n${summaryTexts}`

  // Same fallback + cap + timeout pattern as runCompacting (a4cd40bf,
  // 1787d529, fa161f30): when the merge prompt exceeds the compacting
  // model's window, fall back to the Agent's own model; cap output to the
  // merged-summary budget; hard-timeout to avoid holding things up.
  const { resolveLLM } = await import('@/server/llm/core/resolve')
  const agent = await db.select({ model: agents.model, providerId: agents.providerId }).from(agents).where(eq(agents.id, agentId)).get()
  let mergeModelId = effectiveConfig.model
  let mergeProviderId = effectiveConfig.providerId
  const mergePromptTokens = estimateTokens(mergePrompt)
  const mergeModelWindow = getModelContextWindow(mergeModelId)
  const usableMergeWindow = mergeModelWindow > 0 ? mergeModelWindow - 2000 : 0
  if (agent && mergeModelWindow > 0 && mergePromptTokens > usableMergeWindow && mergeModelId !== agent.model) {
    log.warn(
      { agentId, configuredModel: mergeModelId, configuredWindow: mergeModelWindow, promptTokens: mergePromptTokens, fallbackModel: agent.model },
      'Merge prompt exceeds configured model window — falling back to Agent model',
    )
    mergeModelId = agent.model
    mergeProviderId = agent.providerId
  }

  let resolved
  try {
    resolved = await resolveLLM({ modelId: mergeModelId, providerId: mergeProviderId })
  } catch {
    return
  }

  // Cap merged summary at one summary-slot worth of budget (same math as
  // runCompacting). A merged summary should be MORE compressed than its
  // sources, not less.
  const perSummaryBudget = Math.max(
    1500,
    Math.floor(summaryBudget / Math.max(1, effectiveConfig.maxSummaries)),
  )
  const mergeMaxTokens = Math.floor(perSummaryBudget * 1.5)

  try {
    const result = await safeGenerateText({
      resolved,
      prompt: mergePrompt,
      maxTokens: mergeMaxTokens,
      timeoutMs: 5 * 60 * 1000,
      callSite: 'compacting',
      agentId,
    })

    const mergedSummary = result.text
    if (!mergedSummary) return

    const maxDepth = Math.max(...toMerge.map((s) => s.depth ?? 0))
    const sourceIds = toMerge.map((s) => s.id)

    // Insert the merged summary and archive its sources ATOMICALLY: a crash
    // in between used to leave the merged summary AND all originals active,
    // doubling that span of context in the prompt with nothing reconciling it
    // (the next merge compounds the duplication).
    const txn = sqlite.transaction(() => {
      db.insert(compactingSummaries).values({
        id: uuid(),
        agentId,
        summary: mergedSummary,
        firstMessageAt: firstSummary.firstMessageAt,
        lastMessageAt: lastSummary.lastMessageAt,
        firstMessageId: firstSummary.firstMessageId,
        lastMessageId: lastSummary.lastMessageId,
        messageCount: toMerge.reduce((sum, s) => sum + (s.messageCount ?? 0), 0),
        tokenEstimate: estimateTokens(mergedSummary),
        isInContext: true,
        depth: maxDepth + 1,
        sourceSummaryIds: JSON.stringify(sourceIds),
        createdAt: new Date(),
      }).run()
      db.update(compactingSummaries)
        .set({ isInContext: false })
        .where(inArray(compactingSummaries.id, sourceIds))
        .run()
    })
    txn()

    log.info({ agentId, mergedCount: toMerge.length, newDepth: maxDepth + 1 }, 'Telescopic summary merge completed')
  } catch (err) {
    log.error({ agentId, err }, 'Summary merge LLM error')
  }
}

// ─── Summary Cleanup ─────────────────────────────────────────────────────────

async function cleanupSummaries(agentId: string) {
  const allSummaries = await db
    .select()
    .from(compactingSummaries)
    .where(eq(compactingSummaries.agentId, agentId))
    .orderBy(desc(compactingSummaries.createdAt))
    .all()

  if (allSummaries.length > config.compacting.maxSummariesPerAgent) {
    const toDelete = allSummaries.slice(config.compacting.maxSummariesPerAgent)
    const idsToDelete = toDelete.filter((s) => !s.isInContext).map((s) => s.id)

    if (idsToDelete.length > 0) {
      await db
        .delete(compactingSummaries)
        .where(inArray(compactingSummaries.id, idsToDelete))
    }
  }
}

// ─── Public: trigger compacting if thresholds are met ────────────────────────

/**
 * Check thresholds and run compacting if needed.
 * Called after each LLM turn in agent-engine.ts.
 * Accepts contextTokens/contextWindow from the engine to avoid recomputation.
 */
export async function maybeCompact(agentId: string, contextTokens?: number, contextWindow?: number): Promise<void> {
  try {
    let cycles = 0
    let compacted = false
    const maxCycles = 5

    while (await shouldCompact(agentId, contextTokens, contextWindow) && cycles < maxCycles) {
      cycles++
      sseManager.sendToAgent(agentId, {
        type: 'compacting:start',
        agentId,
        data: { agentId, cycle: cycles, estimatedTotal: maxCycles },
      })
      const result = await runCompacting(agentId, contextWindow)

      // No-op cycle: runCompacting returned null because there weren't enough
      // messages to summarize, the keep-window already covered everything, etc.
      // shouldCompact would still return true (the threshold is exceeded by
      // pieces compacting can't touch — system prompt, tools, memories — so
      // looping again would just waste cycles and block the next user message
      // for nothing. Break and let the operator widen the threshold or shrink
      // tools / memories instead.
      if (result === null) {
        log.warn(
          { agentId, cycle: cycles },
          'Compacting cycle was a no-op (nothing to summarize) — breaking catch-up loop',
        )
        sseManager.sendToAgent(agentId, {
          type: 'compacting:done',
          agentId,
          data: { agentId, summary: '', memoriesExtracted: 0, messageCount: 0 },
        })
        break
      }
      compacted = true

      // After the first compaction, clear the passed-in values so subsequent
      // iterations re-estimate from DB (context has changed)
      contextTokens = undefined
      contextWindow = undefined
    }

    // Compaction runs no main-model turn, so nothing else would refresh the
    // navbar's context figure until the next user message — it would keep
    // showing the pre-compaction estimate. Recompute once (post-settle) and
    // broadcast the fresh calibrated estimate + effective threshold so the
    // badge/tooltip update immediately. apiContextTokens stays cleared (no
    // fresh provider count until the next roundtrip).
    if (compacted) {
      try {
        const { buildContextPreview } = await import('@/server/services/context-preview')
        const preview = await buildContextPreview(agentId)
        sseManager.sendToAgent(agentId, {
          type: 'queue:update',
          agentId,
          data: {
            agentId,
            queueSize: await getQueueSize(agentId),
            isProcessing: false,
            apiContextTokens: null,
            contextTokens: preview.tokenEstimate.total,
            contextWindow: preview.contextWindow,
            contextBreakdown: {
              systemPrompt: preview.tokenEstimate.systemPrompt,
              messages: preview.tokenEstimate.messages,
              tools: preview.tokenEstimate.tools,
              summary: preview.tokenEstimate.summary,
              cronRuns: preview.tokenEstimate.cronRuns,
              cronLearnings: preview.tokenEstimate.cronLearnings,
              total: preview.tokenEstimate.total,
            },
            ...(preview.compactingThresholdPercent != null
              ? { compactingThresholdPercent: preview.compactingThresholdPercent }
              : {}),
          },
        })
      } catch (err) {
        log.warn({ agentId, err }, 'post-compaction context refresh failed')
      }
    }

    if (cycles > 1) {
      log.info({ agentId, cycles }, 'Compacting catch-up completed')
    }
  } catch (err) {
    log.error({ agentId, err }, 'Compacting error')
    sseManager.sendToAgent(agentId, {
      type: 'compacting:error',
      agentId,
      data: { agentId, error: err instanceof Error ? err.message : 'Unknown compacting error' },
    })
  }
}
