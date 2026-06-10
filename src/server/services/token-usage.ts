import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { llmUsage } from '@/server/db/schema'
import { and, eq, gte, lte, sql, desc, isNull, isNotNull } from 'drizzle-orm'
import { createLogger } from '@/server/logger'
import { computeUsageCostUsd, type UsagePricing } from '@/server/services/usage-cost'
import type { LlmUsageCallSite, LlmUsageCallType, MessageTokenUsage, TaskTokenUsage } from '@/shared/types'

const log = createLogger('token-usage')

// Pricing is injected (DI) at startup rather than imported statically, so this
// hot module — pulled in everywhere `recordUsage` is called — never drags the
// model-registry import graph (and its `schema.modelRegistry` link) into test
// files that mock `@/server/db/schema`. Wired in `index.ts`.
let getPricingHook: ((providerId: string | null | undefined, modelId: string) => UsagePricing | null) | null = null
let listPricedModelsHook: (() => Array<{ modelId: string; pricing: UsagePricing }>) | null = null

export function setUsageCostHooks(hooks: {
  getPricing: (providerId: string | null | undefined, modelId: string) => UsagePricing | null
  listPricedModels: () => Array<{ modelId: string; pricing: UsagePricing }>
}): void {
  getPricingHook = hooks.getPricing
  listPricedModelsHook = hooks.listPricedModels
}

// ─── Step Usage Aggregation ────────────────────────────────────────────────

/**
 * Aggregate already-resolved per-step `Usage` objects (hivekeep LLMProvider
 * shape) into a single `MessageTokenUsage` with a `peakStepInputTokens`
 * extra. Sync version of `aggregateStepUsage` for the new abstraction.
 */
export function aggregateUsages(
  usages: ReadonlyArray<{
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }>,
): (MessageTokenUsage & { peakStepInputTokens?: number }) | null {
  if (usages.length === 0) return null
  const turn = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let hasData = false
  let peakStepInputTokens = 0
  for (const u of usages) {
    if (!u) continue
    const stepInput = u.inputTokens ?? 0
    if (stepInput > peakStepInputTokens) peakStepInputTokens = stepInput
    turn.inputTokens += stepInput
    turn.outputTokens += u.outputTokens ?? 0
    turn.cacheReadTokens += u.cacheReadTokens ?? 0
    turn.cacheWriteTokens += u.cacheWriteTokens ?? 0
    turn.reasoningTokens += u.reasoningTokens ?? 0
    hasData = true
  }
  if (!hasData) return null
  turn.totalTokens = turn.inputTokens + turn.outputTokens
  return {
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    totalTokens: turn.totalTokens,
    ...(turn.cacheReadTokens > 0 ? { cacheReadTokens: turn.cacheReadTokens } : {}),
    ...(turn.cacheWriteTokens > 0 ? { cacheWriteTokens: turn.cacheWriteTokens } : {}),
    ...(turn.reasoningTokens > 0 ? { reasoningTokens: turn.reasoningTokens } : {}),
    stepCount: usages.length,
    ...(peakStepInputTokens > 0 ? { peakStepInputTokens } : {}),
  }
}

// ─── Record ─────────────────────────────────────────────────────────────────

export interface RecordUsageParams {
  callSite: LlmUsageCallSite | string
  callType: LlmUsageCallType
  providerType?: string | null
  providerId?: string | null
  modelId?: string | null
  agentId?: string | null
  taskId?: string | null
  cronId?: string | null
  sessionId?: string | null
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
  }
  embeddingTokens?: number
  stepCount?: number
}

/**
 * Record an LLM usage entry. Fire-and-forget — never throws.
 */
export function recordUsage(params: RecordUsageParams): void {
  try {
    const u = params.usage
    // For embedding calls, also populate inputTokens/totalTokens so aggregates work
    const embTokens = params.embeddingTokens ?? null
    const inputTokens = u?.inputTokens ?? embTokens
    const outputTokens = u?.outputTokens ?? null
    const totalTokens = u?.totalTokens ?? (inputTokens != null || outputTokens != null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null)

    const cacheReadTokens = u?.inputTokenDetails?.cacheReadTokens ?? null
    const cacheWriteTokens = u?.inputTokenDetails?.cacheWriteTokens ?? null

    // Freeze the cost at the current registry price, so a later price change
    // never rewrites this row's history. Null when the model has no pricing.
    let costUsd: number | null = null
    if (params.modelId && getPricingHook && (inputTokens != null || outputTokens != null)) {
      const pricing = getPricingHook(params.providerId, params.modelId)
      if (pricing) costUsd = computeUsageCostUsd(pricing, { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens })
    }

    db.insert(llmUsage).values({
      id: uuid(),
      createdAt: new Date(Date.now()),
      callSite: params.callSite,
      callType: params.callType,
      providerType: params.providerType ?? null,
      providerId: params.providerId ?? null,
      modelId: params.modelId ?? null,
      agentId: params.agentId ?? null,
      taskId: params.taskId ?? null,
      cronId: params.cronId ?? null,
      sessionId: params.sessionId ?? null,
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens: u?.outputTokenDetails?.reasoningTokens ?? null,
      embeddingTokens: embTokens,
      stepCount: params.stepCount ?? 1,
      costUsd,
    }).run()
  } catch (err) {
    log.warn({ err }, 'Failed to record LLM usage')
  }
}

/**
 * One-time backfill: estimate `cost_usd` for historical rows recorded before the
 * cost feature, using the CURRENT registry price (a best-effort estimate for the
 * past — future rows freeze their price at record time). Idempotent: only fills
 * `cost_usd IS NULL` rows, so it no-ops once the history is priced. Cheap-guarded
 * so it doesn't scan every startup.
 */
export function backfillUsageCosts(): void {
  try {
    if (!listPricedModelsHook) return
    const pending = db.select({ id: llmUsage.id }).from(llmUsage).where(isNull(llmUsage.costUsd)).limit(1).get()
    if (!pending) return // nothing to backfill

    // One bulk UPDATE per distinct priced model, at its current price.
    let models = 0
    for (const { modelId, pricing: p } of listPricedModelsHook()) {
      const cr = p.cacheRead ?? p.input
      const cw = p.cacheWrite ?? p.input
      db.update(llmUsage)
        .set({
          costUsd: sql`(
            COALESCE(${llmUsage.inputTokens}, 0) * ${p.input}
            + COALESCE(${llmUsage.outputTokens}, 0) * ${p.output}
            + COALESCE(${llmUsage.cacheReadTokens}, 0) * ${cr}
            + COALESCE(${llmUsage.cacheWriteTokens}, 0) * ${cw}
          ) / 1000000.0`,
        })
        .where(and(isNull(llmUsage.costUsd), eq(llmUsage.modelId, modelId), isNotNull(llmUsage.totalTokens)))
        .run()
      models++
    }
    log.info({ models }, 'Backfilled historical LLM usage costs (current-price estimate)')
  } catch (err) {
    log.warn({ err }, 'Usage cost backfill failed')
  }
}

// ─── Query ──────────────────────────────────────────────────────────────────

export interface UsageQueryFilters {
  agentId?: string
  providerId?: string
  providerType?: string
  modelId?: string
  taskId?: string
  cronId?: string
  callSite?: string
  from?: number // timestamp ms
  to?: number   // timestamp ms
  limit?: number
  offset?: number
}

export function queryUsage(filters: UsageQueryFilters) {
  const conditions = buildConditions(filters)

  const rows = db
    .select()
    .from(llmUsage)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(llmUsage.createdAt))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0)
    .all()

  const [totals] = db
    .select({
      inputTokens: sql<number>`COALESCE(SUM(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${llmUsage.outputTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheWriteTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(llmUsage)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all()

  return { rows, totals: totals!, count: totals!.count }
}

export type UsageGroupBy = 'provider_type' | 'model_id' | 'agent_id' | 'call_site' | 'day'

export function getUsageSummary(filters: UsageQueryFilters & { groupBy: UsageGroupBy }) {
  const conditions = buildConditions(filters)
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const groupColumn = (() => {
    switch (filters.groupBy) {
      case 'provider_type': return llmUsage.providerType
      case 'model_id': return llmUsage.modelId
      case 'agent_id': return llmUsage.agentId
      case 'call_site': return llmUsage.callSite
      case 'day': return sql`date(${llmUsage.createdAt} / 1000, 'unixepoch')`
    }
  })()

  const rows = db
    .select({
      group: sql<string>`${groupColumn}`.as('grp'),
      inputTokens: sql<number>`COALESCE(SUM(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${llmUsage.outputTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheWriteTokens}), 0)`,
      costUsd: sql<number>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
      count: sql<number>`COUNT(*)`,
    })
    .from(llmUsage)
    .where(whereClause)
    .groupBy(groupColumn)
    .orderBy(desc(sql`COALESCE(SUM(${llmUsage.inputTokens}), 0)`))
    .all()

  return rows
}

// ─── Task roll-up ──────────────────────────────────────────────────────────

/**
 * Aggregate every `llm_usage` row attributed to a task into a single
 * `TaskTokenUsage` roll-up. Returns null when the task has not produced any
 * recorded usage yet (queued task, immediate cancel, etc.) so the UI can
 * suppress the badge instead of rendering a row of zeros.
 *
 * Covers every `callSite` (not just `task`) — `compacting`, `memory-review`,
 * `embedding`, etc. all flow through `recordUsage` and are tagged with the
 * `taskId` whenever they run on behalf of a task, which is what the user
 * wants in the "total task cost" reading.
 */
export function getTaskTotals(taskId: string): TaskTokenUsage | null {
  const [row] = db
    .select({
      inputTokens: sql<number>`COALESCE(SUM(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${llmUsage.outputTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheWriteTokens}), 0)`,
      reasoningTokens: sql<number>`COALESCE(SUM(${llmUsage.reasoningTokens}), 0)`,
      stepCount: sql<number>`COALESCE(SUM(${llmUsage.stepCount}), 0)`,
      callCount: sql<number>`COUNT(*)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.taskId, taskId))
    .all()

  if (!row || row.callCount === 0) return null

  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    ...(row.cacheReadTokens > 0 ? { cacheReadTokens: row.cacheReadTokens } : {}),
    ...(row.cacheWriteTokens > 0 ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
    ...(row.reasoningTokens > 0 ? { reasoningTokens: row.reasoningTokens } : {}),
    stepCount: row.stepCount,
    callCount: row.callCount,
  }
}

/**
 * Same roll-up as `getTaskTotals` but for a batch of task IDs in a single
 * GROUP BY query. Used by the task list route so the sidebar can render
 * per-task usage chips without firing one query per row.
 *
 * Returns a `Map<taskId, TaskTokenUsage>`. Task IDs with no recorded usage
 * are simply absent from the map (the UI suppresses the chip).
 */
export function getTaskTotalsBatch(taskIds: string[]): Map<string, TaskTokenUsage> {
  const out = new Map<string, TaskTokenUsage>()
  if (taskIds.length === 0) return out
  const rows = db
    .select({
      taskId: llmUsage.taskId,
      inputTokens: sql<number>`COALESCE(SUM(${llmUsage.inputTokens}), 0)`,
      outputTokens: sql<number>`COALESCE(SUM(${llmUsage.outputTokens}), 0)`,
      totalTokens: sql<number>`COALESCE(SUM(${llmUsage.totalTokens}), 0)`,
      cacheReadTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<number>`COALESCE(SUM(${llmUsage.cacheWriteTokens}), 0)`,
      reasoningTokens: sql<number>`COALESCE(SUM(${llmUsage.reasoningTokens}), 0)`,
      stepCount: sql<number>`COALESCE(SUM(${llmUsage.stepCount}), 0)`,
      callCount: sql<number>`COUNT(*)`,
    })
    .from(llmUsage)
    .where(sql`${llmUsage.taskId} IN (${sql.join(taskIds.map((id) => sql`${id}`), sql`, `)})`)
    .groupBy(llmUsage.taskId)
    .all()

  for (const r of rows) {
    if (!r.taskId || r.callCount === 0) continue
    out.set(r.taskId, {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      ...(r.cacheReadTokens > 0 ? { cacheReadTokens: r.cacheReadTokens } : {}),
      ...(r.cacheWriteTokens > 0 ? { cacheWriteTokens: r.cacheWriteTokens } : {}),
      ...(r.reasoningTokens > 0 ? { reasoningTokens: r.reasoningTokens } : {}),
      stepCount: r.stepCount,
      callCount: r.callCount,
    })
  }
  return out
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildConditions(filters: UsageQueryFilters) {
  const conditions = []
  if (filters.agentId) conditions.push(eq(llmUsage.agentId, filters.agentId))
  if (filters.providerId) conditions.push(eq(llmUsage.providerId, filters.providerId))
  if (filters.providerType) conditions.push(eq(llmUsage.providerType, filters.providerType))
  if (filters.modelId) conditions.push(eq(llmUsage.modelId, filters.modelId))
  if (filters.taskId) conditions.push(eq(llmUsage.taskId, filters.taskId))
  if (filters.cronId) conditions.push(eq(llmUsage.cronId, filters.cronId))
  if (filters.callSite) conditions.push(eq(llmUsage.callSite, filters.callSite))
  if (filters.from) conditions.push(gte(llmUsage.createdAt, new Date(filters.from)))
  if (filters.to) conditions.push(lte(llmUsage.createdAt, new Date(filters.to)))
  return conditions
}
