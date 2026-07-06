/**
 * models.dev lookup + matching for the model registry.
 *
 * Loads the bundled snapshot (`models-dev-snapshot.json`, produced by
 * `scripts/fetch-models-dev.ts`) and resolves a Hivekeep `(providerType, modelId)`
 * to a models.dev entry, then maps that entry onto our `LLMModel` metadata fields.
 *
 * This module is pure data — no DB, no network. The DB registry (admin overrides)
 * and the runtime resync layer build on top of it (see `model-metadata.md`).
 */

import { readFileSync } from 'node:fs'

import type { ThinkingEffort } from '@/server/llm/llm/types'
import { THINKING_EFFORT_ORDER } from '@/server/llm/llm/types'

/** Trimmed per-model shape stored in the snapshot (see fetch-models-dev.ts). */
export interface ModelsDevModel {
  name?: string
  family?: string
  context?: number
  output?: number
  input?: string[]
  reasoning?: boolean
  reasoning_efforts?: string[]
  tool_call?: boolean
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
}

type Snapshot = Record<string, Record<string, ModelsDevModel>>

// Loaded once. The file ships in the build; the server runs from source so it is
// on disk at runtime (no bundler/JSON-type-blowup concerns).
let snapshotCache: Snapshot | null = null
function snapshot(): Snapshot {
  if (!snapshotCache) {
    const url = new URL('./models-dev-snapshot.json', import.meta.url)
    snapshotCache = JSON.parse(readFileSync(url, 'utf8')) as Snapshot
  }
  return snapshotCache
}

/** Override the snapshot (tests only). */
export function __setSnapshotForTests(s: Snapshot | null): void {
  snapshotCache = s
}

/**
 * Install a runtime snapshot override (e.g. a freshly-refreshed models.dev
 * snapshot persisted in the data dir, loaded at startup or after a manual
 * refresh). Replaces the bundled snapshot for all subsequent lookups.
 */
export function setSnapshot(s: Snapshot): void {
  snapshotCache = s
}

/**
 * Hivekeep provider `type` → models.dev provider id. Most are identical; only a
 * few diverge. Plugin providers (`plugin:<name>:<type>`) are never in models.dev.
 */
const PROVIDER_ID_MAP: Record<string, string> = {
  moonshot: 'moonshotai',
  gemini: 'google',
  ollama: 'ollama-cloud', // Ollama Cloud is keyed as `ollama-cloud` in models.dev

  // Subscription / CLI providers serve the SAME underlying models as the base
  // provider, so they match the base provider's models.dev entries.
  'anthropic-oauth': 'anthropic', // Claude Pro/Max (used by Claude Code)
  'openai-codex': 'openai', // OpenAI Codex CLI subscription
}
export function toModelsDevProviderId(providerType: string): string {
  return PROVIDER_ID_MAP[providerType] ?? providerType
}

export type MatchConfidence = 'exact' | 'normalized' | 'family' | 'none'

export interface ModelsDevMatch {
  /** "<modelsDevProviderId>/<modelId>" */
  key: string
  confidence: MatchConfidence
  model: ModelsDevModel
}

/**
 * Lowercase, unify separators, and strip trailing release markers so dated
 * snapshots collapse onto their base model:
 *   gpt-4-0613 → gpt-4, gemini-2.0-flash-001 → gemini-2.0-flash,
 *   kimi-k2-0905-preview → kimi-k2, claude-haiku-4-5-20241022 → claude-haiku-4-5,
 *   gpt-5-2025-08-07 → gpt-5 (OpenAI's dashed ISO date), o3-2025-04-16 → o3.
 * Repeated until stable so combined suffixes (date + "-preview") both go.
 * Recognised version/date stamps: a dashed ISO date (`-YYYY-MM-DD`) or a
 * pure-digit run of 3+ digits (`-0613`, `-20241022`). Context markers like
 * `-16k`/`-128k` keep their letter and survive.
 */
function normalizeId(id: string): string {
  let s = id.toLowerCase().replace(/[\s_]+/g, '-')
  let prev: string
  do {
    prev = s
    s = s
      .replace(/-(latest|preview)$/g, '')
      // Dashed ISO date, e.g. `-2025-08-07` (OpenAI). The 2-digit month/day
      // wouldn't be caught by the pure-digit rule below.
      .replace(/-\d{4}-\d{2}-\d{2}$/g, '')
      .replace(/-\d{3,}$/g, '')
  } while (s !== prev)
  return s
}

/**
 * Best-effort match of `(providerType, modelId)` to a models.dev entry.
 * Order: exact id → normalized id → family/prefix. Returns null when the provider
 * isn't in models.dev (incl. all `plugin:*` providers) or nothing plausibly matches.
 */
export function matchModelsDev(providerType: string, modelId: string): ModelsDevMatch | null {
  if (!modelId || providerType.startsWith('plugin:')) return null
  const provId = toModelsDevProviderId(providerType)
  const prov = snapshot()[provId]
  if (!prov) return null

  // 1. exact
  const exact = prov[modelId]
  if (exact) return { key: `${provId}/${modelId}`, confidence: 'exact', model: exact }

  // 2. normalized (case / separators / suffixes)
  const target = normalizeId(modelId)
  for (const [id, m] of Object.entries(prov)) {
    if (normalizeId(id) === target) return { key: `${provId}/${id}`, confidence: 'normalized', model: m }
  }

  // 3. family / prefix — one is a prefix of the other after normalization.
  //    Pick the longest such id (most specific). Low confidence → flagged for review.
  let best: { id: string; m: ModelsDevModel } | null = null
  for (const [id, m] of Object.entries(prov)) {
    const n = normalizeId(id)
    if (n === target || target.startsWith(n + '-') || n.startsWith(target + '-')) {
      if (!best || n.length > normalizeId(best.id).length) best = { id, m }
    }
  }
  if (best) return { key: `${provId}/${best.id}`, confidence: 'family', model: best.m }

  return null
}

// ─── Mapping models.dev → LLMModel metadata ──────────────────────────────────

// models.dev also emits 'none' (= reasoning off — our separate enabled toggle)
// and the odd junk value ('default'); the enum filter below drops those.
const VALID_EFFORTS: readonly ThinkingEffort[] = THINKING_EFFORT_ORDER

/** The subset of `LLMModel` the registry owns. */
export interface ResolvedModelMetadata {
  /** Human-readable label (models.dev `name`, e.g. "Claude Haiku 3.5"). */
  displayName?: string
  contextWindow?: number
  maxOutput?: number
  supportsImageInput?: boolean
  supportsPdfInput?: boolean
  supportsToolCall?: boolean
  /** undefined = not a reasoning model; `efforts: []` = reasoning, toggle-only. */
  thinking?: { efforts: ThinkingEffort[] }
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

/** Map a models.dev entry onto our metadata shape. */
export function modelsDevToMetadata(m: ModelsDevModel): ResolvedModelMetadata {
  const out: ResolvedModelMetadata = {}
  if (m.name) out.displayName = m.name
  if (typeof m.context === 'number') out.contextWindow = m.context
  if (typeof m.output === 'number') out.maxOutput = m.output
  if (Array.isArray(m.input)) {
    out.supportsImageInput = m.input.includes('image')
    out.supportsPdfInput = m.input.includes('pdf')
  }
  if (typeof m.tool_call === 'boolean') out.supportsToolCall = m.tool_call
  if (m.reasoning) {
    const efforts = (m.reasoning_efforts ?? []).filter((e): e is ThinkingEffort =>
      (VALID_EFFORTS as readonly string[]).includes(e),
    )
    out.thinking = { efforts }
  }
  if (m.cost && (typeof m.cost.input === 'number' || typeof m.cost.output === 'number')) {
    out.pricing = {
      input: m.cost.input ?? 0,
      output: m.cost.output ?? 0,
      ...(typeof m.cost.cache_read === 'number' ? { cacheRead: m.cost.cache_read } : {}),
      ...(typeof m.cost.cache_write === 'number' ? { cacheWrite: m.cost.cache_write } : {}),
    }
  }
  return out
}

/** All models.dev keys for a provider type ("<provId>/<modelId>"), for the
 *  admin "remap" picker in the Models view. Empty when the provider isn't in
 *  models.dev (e.g. plugins). */
export function listModelsDevKeys(providerType: string): string[] {
  const provId = toModelsDevProviderId(providerType)
  const prov = snapshot()[provId]
  if (!prov) return []
  return Object.keys(prov).map((id) => `${provId}/${id}`)
}

/** Every models.dev key ("<provId>/<modelId>") across ALL providers, sorted —
 *  for the admin remap combobox (search the whole catalogue, since a
 *  subscription/plugin provider may map to a different provider's entry). */
export function listAllModelsDevKeys(): string[] {
  const out: string[] = []
  for (const [prov, models] of Object.entries(snapshot())) {
    for (const id of Object.keys(models)) out.push(`${prov}/${id}`)
  }
  return out.sort()
}

/** Look up a models.dev entry by its "<provId>/<modelId>" key (for admin remap). */
export function getModelsDevByKey(key: string): ModelsDevModel | null {
  const slash = key.indexOf('/')
  if (slash < 0) return null
  const prov = snapshot()[key.slice(0, slash)]
  return prov?.[key.slice(slash + 1)] ?? null
}

/** Convenience: match + map in one call. Null when no plausible match. */
export function resolveFromModelsDev(
  providerType: string,
  modelId: string,
): { match: ModelsDevMatch; metadata: ResolvedModelMetadata } | null {
  const match = matchModelsDev(providerType, modelId)
  if (!match) return null
  return { match, metadata: modelsDevToMetadata(match.model) }
}
