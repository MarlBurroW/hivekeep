/**
 * Resolve the "scout" model — the cheap model an Agent (or one of its sub-tasks)
 * delegates read-only exploration to via the `scout` tool, mirroring how
 * Claude Code hands heavy exploration to a Haiku sub-agent instead of burning
 * Opus steps.
 *
 * The model is resolved through a fallback chain, most-specific first:
 *
 *   1. per-spawn override   (explicit { modelId, providerId } passed at call)
 *   2. Agent scout          (agents.scout_model / agents.scout_provider_id)
 *   3. global scout default (app_settings default_scout_model / _provider_id)
 *   4. Agent's own main model (agents.model / agents.provider_id) — the safety net
 *
 * A scout/main model pair is "set" only when its model is a non-empty string.
 * The providerId is allowed to be null at every tier (null = auto-resolve, the
 * same convention used everywhere else for model/provider pairs). This means a
 * scout-less install — no scout columns, no global default — transparently
 * runs scouts on the Agent's main model, so the feature is purely additive.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { getDefaultScoutModel, getDefaultScoutProviderId, getDefaultScoutThinking } from '@/server/services/app-settings'
import type { AgentThinkingConfig } from '@/shared/types'

/** A resolved model target. `providerId` may be null (auto-resolve at call). */
export interface ResolvedScoutModel {
  modelId: string
  providerId: string | null
}

/** A model/provider override candidate. A candidate "counts" only when its
 *  `modelId` is a non-empty string; the providerId is optional/nullable. */
export interface ScoutModelOverride {
  modelId?: string | null
  providerId?: string | null
}

export interface ResolveScoutModelOptions {
  /** Agent that owns the scout (the parent Agent of the task, or the main Agent). */
  agentId: string
  /** Highest-priority per-spawn override (e.g. an explicit scout tool arg). */
  override?: ScoutModelOverride | null
}

function asTier(
  modelId: string | null | undefined,
  providerId: string | null | undefined,
): ResolvedScoutModel | null {
  if (typeof modelId === 'string' && modelId.trim() !== '') {
    return { modelId: modelId.trim(), providerId: providerId ?? null }
  }
  return null
}

/**
 * Resolve the effective scout model for an Agent, honoring an optional
 * per-spawn override. Always returns a concrete model —
 * it falls back to the Agent's own main model, which is `notNull` in the schema.
 *
 * Throws only if the Agent does not exist (programmer error — callers already
 * hold a valid agentId).
 */
export async function resolveScoutModel(
  opts: ResolveScoutModelOptions,
): Promise<ResolvedScoutModel> {
  const { agentId, override } = opts

  // 1. Per-spawn override.
  const fromOverride = asTier(override?.modelId, override?.providerId)
  if (fromOverride) return fromOverride

  const agent = db
    .select({
      model: agents.model,
      providerId: agents.providerId,
      scoutModel: agents.scoutModel,
      scoutProviderId: agents.scoutProviderId,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!agent) throw new Error(`resolveScoutModel: agent not found: ${agentId}`)

  // 2. Agent-level scout model.
  const fromAgent = asTier(agent.scoutModel, agent.scoutProviderId)
  if (fromAgent) return fromAgent

  // 3. Global scout default (k/v app setting).
  const [globalModel, globalProviderId] = await Promise.all([
    getDefaultScoutModel(),
    getDefaultScoutProviderId(),
  ])
  const fromGlobal = asTier(globalModel, globalProviderId)
  if (fromGlobal) return fromGlobal

  // 4. Safety net: the Agent's own main model (notNull in schema).
  return { modelId: agent.model, providerId: agent.providerId ?? null }
}

// ─── Scout reasoning ──────────────────────────────────────────────────────────

export interface ResolveScoutThinkingOptions {
  /** Agent that owns the scout. */
  agentId: string
  /** Highest-priority per-call override (built from the scout tool's
   *  `thinking_effort` argument). */
  override?: AgentThinkingConfig | null
}

function parseThinking(raw: string | null | undefined): AgentThinkingConfig | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AgentThinkingConfig
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Resolve the reasoning config a scout should run with — same priority
 * principle as the scout model:
 *
 *   1. per-call override        (the scout tool's `thinking_effort` argument)
 *   2. Agent scout thinking     (agents.scout_thinking_config)
 *   3. global scout default     (app_settings default_scout_thinking)
 *   4. null — the spawned task row stays unset and the execution-time fallback
 *      applies (the calling Agent's own general thinking config).
 *
 * Unlike the model chain this can return null: "no scout-specific reasoning
 * configured anywhere" is a valid state and means "behave like the Agent".
 */
export async function resolveScoutThinking(
  opts: ResolveScoutThinkingOptions,
): Promise<AgentThinkingConfig | null> {
  const { agentId, override } = opts

  // 1. Per-call override.
  if (override) return override

  // 2. Agent scout thinking.
  const agent = db
    .select({ scoutThinkingConfig: agents.scoutThinkingConfig })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  const fromAgent = parseThinking(agent?.scoutThinkingConfig)
  if (fromAgent) return fromAgent

  // 3. Global scout default.
  return getDefaultScoutThinking()
}
