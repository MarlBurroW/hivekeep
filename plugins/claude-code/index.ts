/**
 * KinBot plugin: claude-code
 *
 * Lets a Kin spawn a Claude Code session via the official
 * @anthropic-ai/claude-agent-sdk and watch its progress live in the
 * conversation through a plugin card. The SDK wraps the `claude` CLI
 * binary, which must be installed system-wide:
 *   npm install -g @anthropic-ai/claude-code
 *
 * Auth is selected per-instance in the plugin config (subscription mode
 * reads ~/.claude/.credentials.json, apiKey mode reads an Anthropic API
 * key from the encrypted plugin config).
 *
 * The tool implementation, card layout, and onCardAction handler land in
 * the next commit. This file establishes the plugin entry shape so the
 * loader picks the plugin up at startup.
 */

import type {
  PluginCardActionContext,
  PluginCardActionResult,
} from '@/server/services/plugins'
import type { PluginCardPrimitive } from '@/shared/types/plugin-cards'

// ─── Plugin context typing ──────────────────────────────────────────────────
// We mirror the loose typing convention used by twilio-sms and teamspeak:
// each plugin declares only the slice of context it needs.

interface PluginCtxLog {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

interface ClaudeCodeConfig {
  authMode?: 'subscription' | 'apiKey'
  apiKey?: string
  defaultWorkingDir?: string
  defaultMaxTurns?: number
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan'
}

interface PluginCtx {
  config: ClaudeCodeConfig
  log: PluginCtxLog
  manifest: { name: string; version: string }
  cards: {
    emit(params: {
      kinId: string
      cardType: string
      layout: PluginCardPrimitive[]
      initialState: Record<string, unknown>
    }): Promise<{ messageId: string; cardInstanceId: string }>
    update(params: {
      cardInstanceId: string
      state: Record<string, unknown>
    }): Promise<void>
  }
}

// ─── Plugin entry point ─────────────────────────────────────────────────────

export default function claudeCodePlugin(ctx: PluginCtx) {
  return {
    // Tool and action handler land in the next commit. The exports object
    // returned here is intentionally minimal so the plugin loads cleanly,
    // surfaces in the plugin manager UI, and can be configured before its
    // runtime behavior is wired up.

    onCardAction: async (_action: PluginCardActionContext): Promise<PluginCardActionResult> => {
      return { ok: false, error: 'Claude Code card actions are not implemented yet' }
    },

    async activate(): Promise<void> {
      ctx.log.info(
        { plugin: ctx.manifest.name, version: ctx.manifest.version, authMode: ctx.config.authMode ?? 'subscription' },
        'claude-code plugin activated',
      )
    },

    async deactivate(): Promise<void> {
      ctx.log.info('claude-code plugin deactivated')
    },
  }
}
