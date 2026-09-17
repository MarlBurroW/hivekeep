import type { AgentThinkingConfig, AgentThinkingEffort } from '@/shared/types'

/**
 * A single-select choice for a thinking/effort dial in a form.
 *
 * - `'inherit'` → no override; fall back to the Agent default (config = `null`).
 * - `'off'`     → reasoning explicitly disabled (`{ enabled: false }`).
 * - `'on'`      → reasoning enabled with no effort dial (toggle-only models —
 *                 `{ enabled: true }`, effort left unset).
 * - effort      → reasoning enabled at the given effort (`{ enabled: true, effort }`).
 *
 * Used by the Agent settings and task-start dialogs so every effort dial maps
 * to/from the on-the-wire `AgentThinkingConfig | null` shape identically.
 */
export type ThinkingChoice = 'inherit' | 'off' | 'on' | AgentThinkingEffort

/** Map a stored thinking config (or `null` = inherit) to a form choice.
 *  Pass `toggleOnly` for models with no effort granularity so an enabled
 *  config maps to `'on'` instead of a (meaningless) effort level. */
export function configToChoice(cfg: AgentThinkingConfig | null | undefined, toggleOnly = false): ThinkingChoice {
  if (cfg == null) return 'inherit'
  if (!cfg.enabled) return 'off'
  if (toggleOnly) return 'on'
  return (cfg.effort ?? 'medium') as AgentThinkingEffort
}

/** Map a form choice back to a thinking config (`null` = inherit/no override). */
export function choiceToConfig(choice: ThinkingChoice): AgentThinkingConfig | null {
  if (choice === 'inherit') return null
  if (choice === 'off') return { enabled: false }
  if (choice === 'on') return { enabled: true }
  return { enabled: true, effort: choice }
}
