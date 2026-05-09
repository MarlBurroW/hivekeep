import { safeGenerateText } from '@/server/services/llm-helpers'
import { eq, and, desc, asc, isNull, inArray, ne } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import {
  messages,
  compactingSummaries,
  memories,
  kins,
  userProfiles,
} from '@/server/db/schema'
import { config } from '@/server/config'
import { getExtractionModel, getExtractionProviderId, getDefaultCompactingModel, getDefaultCompactingProviderId } from '@/server/services/app-settings'
import { createMemory, updateMemory, isDuplicateMemory, pruneStaleMemories } from '@/server/services/memory'
import { sseManager } from '@/server/sse/index'
import { getModelContextWindow } from '@/shared/model-context-windows'
import type { KinCompactingConfig, MemoryCategory } from '@/shared/types'

const log = createLogger('compacting')

// Rough token estimation: ~4 characters per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─── Per-Kin Effective Config ─────────────────────────────────────────────────

interface EffectiveCompactingConfig {
  thresholdPercent: number
  keepPercent: number
  summaryBudgetPercent: number
  maxSummaries: number
  model: string
  providerId: string | null
}

/**
 * Resolve effective compacting config for a Kin.
 * Per-Kin overrides > global env vars > defaults.
 */
async function getEffectiveCompactingConfig(kinId: string): Promise<EffectiveCompactingConfig> {
  const kin = await db.select().from(kins).where(eq(kins.id, kinId)).get()
  if (!kin) throw new Error(`Kin ${kinId} not found`)

  let perKin: KinCompactingConfig | null = null
  if (kin.compactingConfig) {
    try { perKin = JSON.parse(kin.compactingConfig) as KinCompactingConfig } catch { /* ignore */ }
  }

  const thresholdPercent = perKin?.thresholdPercent ?? config.compacting.thresholdPercent
  const keepPercent = perKin?.keepPercent ?? config.compacting.keepPercent
  const summaryBudgetPercent = perKin?.summaryBudgetPercent ?? config.compacting.summaryBudgetPercent
  const maxSummaries = perKin?.maxSummaries ?? config.compacting.maxSummaries

  // Model: per-Kin override > app_setting default > env COMPACTING_MODEL > Kin's own model
  // Sentinel '__kin_own__' means "use this kin's own model" (skips defaults)
  let model: string
  let providerId: string | null

  const defaultCompactingModel = await getDefaultCompactingModel()
  const defaultCompactingProviderId = await getDefaultCompactingProviderId()

  if (perKin?.compactingModel === '__kin_own__') {
    model = kin.model
    providerId = kin.providerId
  } else if (perKin?.compactingModel) {
    model = perKin.compactingModel
    providerId = perKin.compactingProviderId ?? null
  } else if (defaultCompactingModel) {
    model = defaultCompactingModel
    providerId = defaultCompactingProviderId
  } else if (config.compacting.model) {
    model = config.compacting.model
    providerId = null
  } else {
    model = kin.model
    providerId = kin.providerId
  }

  return { thresholdPercent, keepPercent, summaryBudgetPercent, maxSummaries, model, providerId }
}

// ─── Threshold Evaluation ────────────────────────────────────────────────────

/**
 * Evaluate whether compacting should trigger for a Kin.
 * Uses token-based threshold: triggers when context tokens exceed thresholdPercent of context window.
 *
 * Prefers the provider-reported `apiContextTokens` from the cache (ground
 * truth from the last LLM roundtrip) over the local BPE estimate, since the
 * local estimator typically under-counts JSON / tool-heavy contexts by
 * 30-60% — which would otherwise let compacting silently miss its threshold.
 */
export async function shouldCompact(kinId: string, contextTokens?: number, contextWindow?: number): Promise<boolean> {
  const effectiveConfig = await getEffectiveCompactingConfig(kinId)

  if (contextTokens != null && contextWindow != null && contextWindow > 0) {
    // If the cache has a fresh provider-reported size from the most recent
    // turn and it exceeds the caller-supplied estimate, trust the ground
    // truth — the next call will be at least as large.
    const { getLastContextUsage } = await import('@/server/services/kin-engine')
    const cached = await getLastContextUsage(kinId)
    const effectiveTokens = cached?.apiContextTokens != null && cached.apiContextTokens > contextTokens
      ? cached.apiContextTokens
      : contextTokens
    const usagePercent = (effectiveTokens / contextWindow) * 100
    return usagePercent > effectiveConfig.thresholdPercent
  }

  // Fallback: estimate from DB
  const kin = await db.select({ model: kins.model }).from(kins).where(eq(kins.id, kinId)).get()
  if (!kin) return false

  const ctxWindow = getModelContextWindow(kin.model)
  if (ctxWindow <= 0) return false

  // Estimate non-compacted message tokens
  const activeSummaries = await getActiveSummaries(kinId)
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null
  const cutoffTimestamp = latestSummary ? (latestSummary.lastMessageAt as unknown as number) : null

  const nonCompactedMessages = await getNonCompactedMessages(kinId, cutoffTimestamp)
  // Same reason as in runCompacting: counting only content under-counts
  // tool-heavy Kins by 10-100× and lets shouldCompact silently miss its
  // threshold when there's no fresh apiContextTokens in the cache yet.
  const messageTokens = nonCompactedMessages.reduce(
    (sum, m) => sum + estimateTokens(m.content ?? '') + estimateTokens((m.toolCalls as string | null) ?? ''),
    0,
  )
  const summaryTokens = activeSummaries.reduce((sum, s) => sum + estimateTokens(s.summary), 0)

  // Rough estimate: messages + summaries + ~2000 for system prompt + ~1000 for tools
  const estimatedTotal = messageTokens + summaryTokens + 3000
  const usagePercent = (estimatedTotal / ctxWindow) * 100
  return usagePercent > effectiveConfig.thresholdPercent
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
export async function getCompactingProximity(kinId: string): Promise<CompactingProximity> {
  const effectiveConfig = await getEffectiveCompactingConfig(kinId)

  // Try to get cached context usage from kin-engine
  const { getLastContextUsage } = await import('@/server/services/kin-engine')
  const cached = await getLastContextUsage(kinId)

  let currentPercent = 0
  const contextWindow = cached?.contextWindow ?? 0
  if (cached && contextWindow > 0) {
    // Prefer provider-reported ground truth over local estimate — same
    // reason as in shouldCompact: estimates routinely under-count, which
    // makes the displayed proximity bar lie about how close the Kin is
    // to compacting.
    const tokens = cached.apiContextTokens ?? cached.contextTokens
    currentPercent = Math.round((tokens / contextWindow) * 100)
  }

  const activeSummaries = await getActiveSummaries(kinId)
  const summaryTokens = activeSummaries.reduce((sum, s) => sum + (s.tokenEstimate ?? estimateTokens(s.summary)), 0)
  const summaryBudgetTokens = contextWindow > 0
    ? Math.floor((effectiveConfig.summaryBudgetPercent / 100) * contextWindow)
    : 0

  return {
    currentPercent,
    thresholdPercent: effectiveConfig.thresholdPercent,
    summaryCount: activeSummaries.length,
    maxSummaries: effectiveConfig.maxSummaries,
    summaryTokens,
    summaryBudgetTokens,
    keepPercent: effectiveConfig.keepPercent,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Get all active (in-context) summaries for a Kin, ordered oldest to newest */
async function getActiveSummaries(kinId: string) {
  return db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.kinId, kinId), eq(compactingSummaries.isInContext, true)))
    .orderBy(asc(compactingSummaries.lastMessageAt))
    .all()
}

/** Get non-compacted messages after a cutoff timestamp */
async function getNonCompactedMessages(kinId: string, cutoffTimestamp: number | null) {
  const allMessages = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.kinId, kinId),
        isNull(messages.taskId),
        isNull(messages.sessionId),
        eq(messages.redactPending, false),
        ne(messages.sourceType, 'compacting'),
      ),
    )
    .orderBy(asc(messages.createdAt))
    .all()

  if (!cutoffTimestamp) return allMessages
  return allMessages.filter((m) => m.createdAt && (m.createdAt as unknown as number) > cutoffTimestamp)
}

// ─── Core Compacting ─────────────────────────────────────────────────────────

export interface CompactingResult {
  summary: string
  memoriesExtracted: number
}

/**
 * Run the compacting process for a Kin.
 * 1. Find the keep-window boundary (keep recent messages fitting keepPercent of context)
 * 2. Summarize everything before the boundary into a NEW summary
 * 3. Run memory extraction on compacted messages
 * 4. Check if telescopic merge is needed
 */
export async function runCompacting(kinId: string, contextWindow?: number): Promise<CompactingResult | null> {
  const kin = await db.select().from(kins).where(eq(kins.id, kinId)).get()
  if (!kin) return null

  const effectiveConfig = await getEffectiveCompactingConfig(kinId)
  const ctxWindow = contextWindow ?? getModelContextWindow(kin.model)

  // Get the latest summary to determine the cutoff point
  const activeSummaries = await getActiveSummaries(kinId)
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null
  const cutoffTimestamp = latestSummary ? (latestSummary.lastMessageAt as unknown as number) : null

  // Get non-compacted messages
  const nonCompacted = await getNonCompactedMessages(kinId, cutoffTimestamp)
  if (nonCompacted.length === 0) return null

  // Compute keep-window: walk backward from newest, accumulating tokens until keepPercent budget.
  //
  // The per-message size MUST include the toolCalls JSON, not just the text
  // content. For tool-heavy Kins (kubectl, browser, file reads) the JSON is
  // 10-100× the text — counting only content makes the budget budget look
  // empty, every message fits in the keep window, messagesToSummarize ends
  // up empty, and runCompacting silently returns null every time. The Kin
  // then accumulates context unboundedly until the main turn itself crashes.
  const keepBudget = Math.floor((effectiveConfig.keepPercent / 100) * ctxWindow)
  let keepTokens = 0
  let keepStartIndex = nonCompacted.length
  for (let i = nonCompacted.length - 1; i >= 0; i--) {
    const m = nonCompacted[i]!
    const msgTokens = estimateTokens(m.content ?? '') + estimateTokens((m.toolCalls as string | null) ?? '')
    if (keepTokens + msgTokens > keepBudget) break
    keepTokens += msgTokens
    keepStartIndex = i
  }

  // Messages to summarize = everything before the keep window
  const messagesToSummarize = nonCompacted.slice(0, keepStartIndex)
  if (messagesToSummarize.length < 2) return null // need at least a couple messages

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
            ? kin.name
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
  // Kin's own model — which by definition handled the original payload, so
  // it can handle the same payload reformatted as a summarization prompt.
  // Without this, the API call throws "prompt is too long" and the Kin's
  // context grows unboundedly because compacting silently fails every turn.
  const { resolveLLMModel } = await import('@/server/services/kin-engine')
  let effectiveModelId = effectiveConfig.model
  let effectiveProviderId = effectiveConfig.providerId
  const promptTokens = estimateTokens(systemPrompt)
  const compactingModelWindow = getModelContextWindow(effectiveModelId)
  // Reserve ~2k tokens for the LLM's own output. If the prompt alone already
  // takes 95%+ of the window, fallback even before the API rejects it.
  const usableWindow = compactingModelWindow > 0 ? compactingModelWindow - 2000 : 0
  if (compactingModelWindow > 0 && promptTokens > usableWindow && effectiveModelId !== kin.model) {
    log.warn({
      kinId,
      configuredModel: effectiveModelId,
      configuredWindow: compactingModelWindow,
      promptTokens,
      fallbackModel: kin.model,
    }, 'Compacting prompt exceeds configured model window — falling back to Kin model')
    effectiveModelId = kin.model
    effectiveProviderId = kin.providerId
  }

  const model = await resolveLLMModel(effectiveModelId, effectiveProviderId)
  if (!model) {
    // Distinct from "no messages to summarize" (which legitimately returns
    // null and gets a quiet compacting:done): this is a misconfiguration
    // (provider deleted, model retired, OAuth expired). Throw so the catch
    // surfaces compacting:error with an actionable message instead of a
    // misleading "no-op" success.
    log.warn({ kinId, effectiveModelId, effectiveProviderId }, 'No LLM model available for compacting — provider/model misconfiguration')
    throw new Error(`Compacting model '${effectiveModelId}' is unavailable. Check the Kin's compacting model + provider in settings.`)
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
    // hold the compactingKins lock indefinitely, blocking every subsequent
    // user message for this Kin. 5 min covers slow providers / large prompts
    // while still surfacing a real hang within a tolerable window.
    const result = await safeGenerateText({
      model,
      providerId: effectiveProviderId,
      prompt: systemPrompt,
      maxTokens: summaryMaxTokens,
      timeoutMs: 5 * 60 * 1000,
      callSite: 'compacting',
      modelId: effectiveModelId,
      kinId,
    })

    const summary = result.text
    if (!summary) return null

    // Sanity check: warn if the summary is still oversized despite the cap
    // (cap might have been raised by maxOutputTokens=… being honored as a
    // soft limit on some providers).
    const actualTokens = estimateTokens(summary)
    if (actualTokens > perSummaryBudget * 2) {
      log.warn(
        { kinId, actualTokens, perSummaryBudget, summaryMaxTokens },
        'Generated summary exceeds 2x its per-summary budget — consider lowering keepPercent or raising maxSummaries',
      )
    }

    const firstMsgAt = firstSummarizedMessage.createdAt as unknown as number
    const lastMsgAt = lastSummarizedMessage.createdAt as unknown as number

    // Save new summary
    const newSummaryId = uuid()
    await db.insert(compactingSummaries).values({
      id: newSummaryId,
      kinId,
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

    // Extract memories (awaited so we can report count)
    const memoriesExtracted = await extractMemories(kinId, kin.model, kin.providerId, messagesToSummarize, lastSummarizedMessage.id)

    // Run memory consolidation to merge near-duplicate memories
    let memoriesConsolidated = 0
    try {
      const { consolidateMemories } = await import('@/server/services/consolidation')
      memoriesConsolidated = await consolidateMemories(kinId)
      if (memoriesConsolidated > 0) {
        log.info({ kinId, memoriesConsolidated }, 'Memories consolidated after extraction')
      }
    } catch (err) {
      log.error({ kinId, err }, 'Memory consolidation error')
    }

    // Recalibrate importance scores based on retrieval patterns
    let memoriesRecalibrated = 0
    try {
      const { recalibrateImportance } = await import('@/server/services/memory')
      memoriesRecalibrated = await recalibrateImportance(kinId)
      if (memoriesRecalibrated > 0) {
        log.info({ kinId, memoriesRecalibrated }, 'Memory importance recalibrated')
      }
    } catch (err) {
      log.error({ kinId, err }, 'Memory importance recalibration error')
    }

    // Prune stale memories (low importance, never retrieved, old)
    let memoriesPruned = 0
    try {
      memoriesPruned = await pruneStaleMemories(kinId)
      if (memoriesPruned > 0) {
        log.info({ kinId, memoriesPruned }, 'Stale memories pruned')
      }
    } catch (err) {
      log.error({ kinId, err }, 'Stale memory pruning error')
    }

    // Persist a system message so the compaction trace survives page refresh
    // role='system' is skipped by buildMessageHistory → won't pollute LLM context
    const compactingMessageId = uuid()
    await db.insert(messages).values({
      id: compactingMessageId,
      kinId,
      role: 'system',
      content: summary,
      sourceType: 'compacting',
      isRedacted: false,
      redactPending: false,
      metadata: JSON.stringify({ memoriesExtracted, memoriesConsolidated, memoriesPruned }),
      createdAt: new Date(),
    })

    log.info({ kinId, summaryId: newSummaryId, summarizedMessages: messagesToSummarize.length, memoriesExtracted }, 'Compacting batch completed')

    // Emit SSE: compaction done. messageCount lets the UI tell the user
    // "compacted N messages" — concrete signal of what just happened
    // beyond the abstract "compacting done" status.
    sseManager.sendToKin(kinId, {
      type: 'compacting:done',
      kinId,
      data: { kinId, summary, memoriesExtracted, messageCount: messagesToSummarize.length },
    })

    // The cached apiContextTokens (provider ground truth from the last main
    // turn) was for a payload that no longer corresponds to the current
    // context — leaving it would have the navbar still showing the
    // pre-compaction "real 750k" until the next main turn. Drop it so the
    // UI falls back to the (calibrated) estimate, which reflects reality
    // until the next roundtrip restores ground truth.
    const { invalidateApiContextSize } = await import('@/server/services/kin-engine')
    invalidateApiContextSize(kinId)
    sseManager.sendToKin(kinId, {
      type: 'queue:update',
      kinId,
      // null (not undefined) signals to the client SSE handler that we want
      // to actively clear apiContextTokens, not just "no update for this
      // field". The handler treats null distinctly from omission.
      data: { kinId, queueSize: 0, isProcessing: false, apiContextTokens: null },
    })

    // Check if telescopic merge is needed after adding new summary
    await maybeMergeSummaries(kinId, ctxWindow)

    // Clean up old archived summaries beyond retention limit
    await cleanupSummaries(kinId)

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

    log.error({ kinId, err, model: effectiveConfig.model, providerId: effectiveConfig.providerId }, 'Compacting LLM call failed')

    // Persist error in conversation history
    await db.insert(messages).values({
      id: uuid(),
      kinId,
      role: 'system',
      content: '',
      sourceType: 'compacting',
      isRedacted: false,
      redactPending: false,
      metadata: JSON.stringify({ error: errorMessage }),
      createdAt: new Date(),
    })

    // Emit SSE: compaction failed (so UI can clear the spinner)
    sseManager.sendToKin(kinId, {
      type: 'compacting:error',
      kinId,
      data: { kinId, error: errorMessage },
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
async function maybeMergeSummaries(kinId: string, contextWindow: number): Promise<void> {
  const effectiveConfig = await getEffectiveCompactingConfig(kinId)
  const activeSummaries = await getActiveSummaries(kinId)

  if (activeSummaries.length <= 2) return // nothing to merge

  const totalSummaryTokens = activeSummaries.reduce((sum, s) => sum + (s.tokenEstimate ?? estimateTokens(s.summary)), 0)
  const summaryBudget = Math.floor((effectiveConfig.summaryBudgetPercent / 100) * contextWindow)

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

  const { resolveLLMModel } = await import('@/server/services/kin-engine')
  const model = await resolveLLMModel(effectiveConfig.model, effectiveConfig.providerId)
  if (!model) return

  try {
    const result = await safeGenerateText({
      model,
      providerId: effectiveConfig.providerId,
      prompt: mergePrompt,
      callSite: 'compacting',
      modelId: effectiveConfig.model,
      kinId,
    })

    const mergedSummary = result.text
    if (!mergedSummary) return

    const maxDepth = Math.max(...toMerge.map((s) => s.depth ?? 0))
    const sourceIds = toMerge.map((s) => s.id)

    // Insert merged summary
    await db.insert(compactingSummaries).values({
      id: uuid(),
      kinId,
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
    })

    // Archive merged originals
    await db
      .update(compactingSummaries)
      .set({ isInContext: false })
      .where(inArray(compactingSummaries.id, sourceIds))

    log.info({ kinId, mergedCount: toMerge.length, newDepth: maxDepth + 1 }, 'Telescopic summary merge completed')
  } catch (err) {
    log.error({ kinId, err }, 'Summary merge LLM error')
  }
}

// ─── Summary Cleanup ─────────────────────────────────────────────────────────

async function cleanupSummaries(kinId: string) {
  const allSummaries = await db
    .select()
    .from(compactingSummaries)
    .where(eq(compactingSummaries.kinId, kinId))
    .orderBy(desc(compactingSummaries.createdAt))
    .all()

  if (allSummaries.length > config.compacting.maxSummariesPerKin) {
    const toDelete = allSummaries.slice(config.compacting.maxSummariesPerKin)
    const idsToDelete = toDelete.filter((s) => !s.isInContext).map((s) => s.id)

    if (idsToDelete.length > 0) {
      await db
        .delete(compactingSummaries)
        .where(inArray(compactingSummaries.id, idsToDelete))
    }
  }
}

// ─── Memory Extraction Pipeline ──────────────────────────────────────────────

async function addIfNotDuplicate(
  kinId: string,
  item: { content: string; category: string; subject?: string | null; sourceContext?: string | null },
  importance: number | null,
  lastMessageId: string,
): Promise<boolean> {
  if (await isDuplicateMemory(kinId, item.content)) return false

  await createMemory(kinId, {
    content: item.content,
    category: item.category as MemoryCategory,
    subject: item.subject || null,
    sourceContext: item.sourceContext || null,
    importance,
    sourceMessageId: lastMessageId,
    sourceChannel: 'automatic',
  })
  return true
}

async function extractMemories(
  kinId: string,
  kinModel: string,
  kinProviderId: string | null,
  messagesToAnalyze: Array<{ id: string; content: string | null; role: string }>,
  lastMessageId: string,
): Promise<number> {
  const { resolveLLMModel } = await import('@/server/services/kin-engine')
  const settingsExtractionModel = await getExtractionModel()
  const settingsExtractionProviderId = await getExtractionProviderId()
  const effectiveExtractionModel = settingsExtractionModel ?? config.memory.extractionModel
  const extractionProviderId = settingsExtractionProviderId
    ?? config.memory.extractionProviderId
    ?? (effectiveExtractionModel ? null : kinProviderId)
  const model = await resolveLLMModel(effectiveExtractionModel ?? kinModel, extractionProviderId)
  if (!model) return 0

  // Get existing memories for dedup context (include IDs for UPDATE actions)
  const existingMemories = await db
    .select({ id: memories.id, content: memories.content, category: memories.category, subject: memories.subject })
    .from(memories)
    .where(eq(memories.kinId, kinId))
    .all()

  const existingMemoriesSummary =
    existingMemories.length > 0
      ? existingMemories
          .map((m, i) => `[${i}] [${m.category}] ${m.content}${m.subject ? ` (subject: ${m.subject})` : ''}`)
          .join('\n')
      : '(none)'

  const formattedMessages = messagesToAnalyze
    .filter((m) => m.content)
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n\n')

  const extractionPrompt =
    `You are an assistant specialized in information extraction.\n` +
    `Analyze the exchanges below and extract information worth remembering long-term.\n\n` +
    `For each piece of information, decide what action to take:\n` +
    `- **"add"**: New information not present in existing memories\n` +
    `- **"update"**: Information that contradicts, supersedes, or enriches an existing memory (e.g., a preference changed, a fact was corrected, new details about something already known)\n` +
    `- Skip entirely if the information is already accurately captured\n\n` +
    `Return a JSON array of objects with:\n` +
    `- "action": "add" | "update"\n` +
    `- "content": the fact or knowledge (a clear, standalone sentence)\n` +
    `- "category": "fact" | "preference" | "decision" | "knowledge"\n` +
    `- "subject": the person or context concerned (name or "general")\n` +
    `- "importance": a number from 1 to 10\n` +
    `  1 = mundane/trivial, 5 = moderately useful, 10 = critical/life-changing\n` +
    `- "sourceContext": a brief 1-2 sentence summary of the conversational context in which this fact was mentioned (e.g. "While discussing weekend plans, user mentioned...")\n` +
    `- "updateIndex": (only for "update" action) the index number [N] of the existing memory to update\n\n` +
    `Rules:\n` +
    `- Only extract **durable** information (not ephemeral details)\n` +
    `- Use "update" when new info CONTRADICTS or SUPERSEDES an existing memory (e.g., "likes Python" → "switched to Rust")\n` +
    `- Use "update" to ENRICH an existing memory with significant new details\n` +
    `- Do NOT update if the existing memory is already accurate and complete\n` +
    `- Be honest with importance scores — most memories should be 3-7\n\n` +
    `**Durability test — before adding ANY memory, ask yourself:**\n` +
    `Will this still be true/relevant in 3 months? If not, skip it.\n\n` +
    `**DO NOT extract:**\n` +
    `- One-time events or situations (car broke down, had a party, weather today)\n` +
    `- Temporary states (will be ready by Friday, feeling sick today)\n` +
    `- Reasons/explanations for decisions (extract the decision, not the reasoning)\n` +
    `- Specific orders, meals, or purchases (unless it reveals a lasting preference)\n` +
    `- Trivial details about objects (toy names, specific gift items)\n` +
    `- General knowledge or widely known facts\n\n` +
    `**DO extract:**\n` +
    `- Identity facts (name, age, family, job, location)\n` +
    `- Lasting preferences (tools, foods, styles)\n` +
    `- Life changes (moving, new job, relationship changes)\n` +
    `- Possessions that define the person (car model, pets)\n` +
    `- Recurring habits (weekly restaurant, morning routine)\n` +
    `- Skills and interests being actively pursued\n` +
    `- Important relationships (family members, close contacts)\n\n` +
    `## Existing memories (indexed)\n\n${existingMemoriesSummary}\n\n` +
    `## Exchanges to analyze\n\n${formattedMessages}\n\n` +
    `Return a JSON array. If nothing new to remember or update, return [].`

  try {
    const result = await safeGenerateText({
      model,
      providerId: extractionProviderId,
      prompt: extractionPrompt,
      callSite: 'compacting',
      modelId: effectiveExtractionModel ?? kinModel,
      kinId,
    })

    // Parse JSON array from response
    const jsonMatch = result.text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return 0

    const extracted = JSON.parse(jsonMatch[0]) as Array<{
      action?: string
      content: string
      category: string
      subject: string
      importance?: number
      sourceContext?: string
      updateIndex?: number
    }>

    let count = 0
    for (const item of extracted) {
      if (!item.content || !item.category) continue

      // Clamp importance to [1, 10], default to null if missing
      const importance = typeof item.importance === 'number'
        ? Math.max(1, Math.min(10, Math.round(item.importance)))
        : null

      const action = item.action ?? 'add'

      if (action === 'update' && typeof item.updateIndex === 'number') {
        // Update an existing memory
        const target = existingMemories[item.updateIndex]
        if (target) {
          await updateMemory(target.id, kinId, {
            content: item.content,
            category: item.category as MemoryCategory,
            subject: item.subject || null,
            sourceContext: item.sourceContext || null,
            importance,
          })
          count++
          log.debug({ kinId, memoryId: target.id, oldContent: target.content, newContent: item.content }, 'Memory updated via extraction')
        } else {
          // Invalid index, fall back to add
          await addIfNotDuplicate(kinId, item, importance, lastMessageId)
          count++
        }
      } else {
        // Add new memory (with dedup check)
        const added = await addIfNotDuplicate(kinId, item, importance, lastMessageId)
        if (added) count++
      }
    }
    return count
  } catch (err) {
    log.error({ kinId, err }, 'Memory extraction LLM error')
    return 0
  }
}

// ─── Public: trigger compacting if thresholds are met ────────────────────────

/**
 * Check thresholds and run compacting if needed.
 * Called after each LLM turn in kin-engine.ts.
 * Accepts contextTokens/contextWindow from the engine to avoid recomputation.
 */
export async function maybeCompact(kinId: string, contextTokens?: number, contextWindow?: number): Promise<void> {
  try {
    let cycles = 0
    const maxCycles = 5

    while (await shouldCompact(kinId, contextTokens, contextWindow) && cycles < maxCycles) {
      cycles++
      sseManager.sendToKin(kinId, {
        type: 'compacting:start',
        kinId,
        data: { kinId, cycle: cycles, estimatedTotal: maxCycles },
      })
      const result = await runCompacting(kinId, contextWindow)

      // No-op cycle: runCompacting returned null because there weren't enough
      // messages to summarize, the keep-window already covered everything, etc.
      // shouldCompact would still return true (the threshold is exceeded by
      // pieces compacting can't touch — system prompt, tools, memories — so
      // looping again would just waste cycles and block the next user message
      // for nothing. Break and let the operator widen the threshold or shrink
      // tools / memories instead.
      if (result === null) {
        log.warn(
          { kinId, cycle: cycles },
          'Compacting cycle was a no-op (nothing to summarize) — breaking catch-up loop',
        )
        sseManager.sendToKin(kinId, {
          type: 'compacting:done',
          kinId,
          data: { kinId, summary: '', memoriesExtracted: 0 },
        })
        break
      }

      // After the first compaction, clear the passed-in values so subsequent
      // iterations re-estimate from DB (context has changed)
      contextTokens = undefined
      contextWindow = undefined
    }

    if (cycles > 1) {
      log.info({ kinId, cycles }, 'Compacting catch-up completed')
    }
  } catch (err) {
    log.error({ kinId, err }, 'Compacting error')
    sseManager.sendToKin(kinId, {
      type: 'compacting:error',
      kinId,
      data: { kinId, error: err instanceof Error ? err.message : 'Unknown compacting error' },
    })
  }
}
