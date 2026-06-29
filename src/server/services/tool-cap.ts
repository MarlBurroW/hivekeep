/**
 * Tool-cap helper — extracted from agent-engine.ts so it's testable
 * without dragging in the full engine module graph (and the mock-
 * pollution surface that comes with it).
 *
 * Resolution chain for the effective cap on a single chat request:
 *
 *   1. `LLMModel.maxTools` — per-model override declared by the
 *      provider's `listModels()`. Lets a plugin marketplace
 *      (Replicate, Together, Ollama, …) flag specific models that
 *      can't tool-call (set to `0`) while leaving others on the
 *      provider default.
 *   2. `LLMProvider.defaultMaxTools` — provider-wide cap. Set by
 *      built-ins (OpenAI: 128, Anthropic: 512) and any plugin that
 *      hosts a uniform catalogue.
 *   3. `DEFAULT_MAX_LLM_TOOLS` (128) — conservative fallback when
 *      neither layer declared anything.
 *
 * Special value `0` propagates: any layer returning `0` means "no
 * tools" and the engine's tool-cap pass drops every tool. The prompt
 * builder is fed the same number so it can skip tool-heavy sections.
 *
 * Provider-agnostic on purpose: zero hardcoded type names here. New
 * providers (built-in or plugin) declare their cap on themselves and
 * Hivekeep picks it up automatically.
 */

import type { LLMModel } from '@gezy/sdk'
import { getLLMProvider } from '@/server/llm/llm/registry'

/** OpenAI-compatible conservative limit — matches every major
 *  provider's documented cap when one exists. Used when the provider
 *  type is unknown or declined to declare its own limit. */
export const DEFAULT_MAX_LLM_TOOLS = 128

/**
 * Effective tool cap for a `(providerType, model)` pair. Model-level
 * override wins; falls back to provider default; falls back to
 * `DEFAULT_MAX_LLM_TOOLS`. `0` is a real return value meaning "no
 * tools at all" — callers MUST treat it as a signal, not noise.
 */
export function getMaxToolsForRequest(
  providerType: string | null,
  model?: Pick<LLMModel, 'maxTools'> | null,
): number {
  if (model?.maxTools != null) return model.maxTools
  if (!providerType) return DEFAULT_MAX_LLM_TOOLS
  const provider = getLLMProvider(providerType)
  return provider?.defaultMaxTools ?? DEFAULT_MAX_LLM_TOOLS
}

/**
 * Legacy entry point — kept for callers that don't have a resolved
 * model handy. Equivalent to `getMaxToolsForRequest(providerType, null)`.
 * Prefer the model-aware version when you can.
 */
export function getMaxToolsForProvider(providerType: string | null): number {
  return getMaxToolsForRequest(providerType, null)
}
