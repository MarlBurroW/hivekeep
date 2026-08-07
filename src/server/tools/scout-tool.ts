import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { spawnTask, suspendTaskForChild } from '@/server/services/tasks'
import { resolveScoutModel, resolveScoutThinking } from '@/server/llm/core/resolve-scout'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'
import type { AgentThinkingConfig, AgentThinkingEffort } from '@/shared/types'
import { THINKING_EFFORTS } from '@/shared/constants'

const log = createLogger('tools:scout')

/**
 * scout — delegate heavy, read-only exploration to a CHEAP "scout" model,
 * the way Claude Code hands a Haiku sub-agent the grunt work instead of
 * burning Opus steps on it.
 *
 * Behaviour: spawn an `await` sub-task on the resolved scout model
 * (resolveScoutModel: per-spawn override → Agent scout → global
 * scout default → the Agent's own model) with the read-only 'scout' built-in
 * toolbox (grep / read_file / list_directory / web_search / browse_url /
 * extract_links — NO writes, NO scout/spawn tools, so a scout is always a
 * LEAF), then BLOCK until the scout returns its digest, which becomes the
 * scout tool's result.
 *
 * Two parent shapes, both handled:
 *   - MAIN Agent (ctx.taskId undefined): the child is a normal `await` spawn on
 *     the main Agent. When it resolves, the existing await → task_result →
 *     processNextMessage re-entry delivers the digest. The tool returns a
 *     placeholder immediately and the main turn ends after this step.
 *   - SUB-Agent task (ctx.taskId set): the child is spawned with parentTaskId =
 *     the calling task, then the calling task SUSPENDS into 'awaiting_subtask'
 *     (suspendTaskForChild). The runner ends the run WITHOUT resolving; on the
 *     child's completion resolveTask → resumeTaskFromChildResult re-enters the
 *     parent with the digest injected.
 *
 * Either way the calling agent must emit nothing further on this turn — see the
 * `note` in the returned payload (mirrors request_input).
 */
export const scoutTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Delegate heavy, READ-ONLY exploration (searching a codebase, mapping files, gathering web context) to a fast, cheap scout model and BLOCK until it returns a digest. Use this instead of grinding through dozens of your own read/grep/browse steps. The scout runs with a read-only toolset (grep, read_file, list_directory, web_search, browse_url, extract_links) and cannot write, spawn, or scout further. Your turn pauses until the scout reports back — DO NOT emit any further tool calls on this turn. The scout\'s digest arrives as your next message and becomes this call\'s result.',
      inputSchema: z.object({
        task_description: z
          .string()
          .describe(
            'A precise, self-contained brief for the scout: what to find/read/map and exactly what to report back. The scout has no access to your conversation — spell out the question, the relevant paths/areas, and the shape of digest you want (e.g. "list every file that references X with a one-line summary each").',
          ),
        title: z
          .string()
          .optional()
          .describe('Short label for the scout task, max ~60 chars. Defaults to a generic "Scout" label.'),
        hints: z
          .object({
            paths: z
              .array(z.string())
              .optional()
              .describe('Files/directories the scout should focus on first.'),
            queries: z
              .array(z.string())
              .optional()
              .describe('Search terms / questions to guide the scout.'),
          })
          .optional()
          .describe('Optional starting hints folded into the scout\'s brief.'),
        model: z
          .string()
          .optional()
          .describe('Override the scout model for this call only (e.g. "claude-haiku-4-6"). Omit to use the configured scout chain. Requires provider_id when set.'),
        provider_id: z
          .string()
          .optional()
          .describe('Provider slug or UUID for the overridden scout model. Required whenever `model` is set.'),
        thinking_effort: z
          .enum(['off', ...THINKING_EFFORTS] as [string, ...string[]])
          .optional()
          .describe('Reasoning effort for this scout only. "off" disables thinking. Omit to inherit the project default, then the calling Agent\'s config. Scouts are meant to be fast and cheap — prefer low efforts.'),
      }),
      execute: async ({ task_description, title, hints, model, provider_id, thinking_effort }) => {
        if (model && !provider_id) {
          return {
            error:
              'When overriding the scout model you must pass provider_id too — the same model name can be served by several providers, and hivekeep cannot guess which one you mean.',
          }
        }

        // Resolve the cheap scout model via the fallback chain.
        const scout = await resolveScoutModel({
          agentId: ctx.agentId,
          override: model ? { modelId: model, providerId: provider_id ?? null } : null,
        })

        // Reasoning for the scout — same priority principle as the model:
        // per-call override → Agent scout thinking → global scout default →
        // (at execution) the calling Agent's own general thinking config.
        // Frozen on the task row when a tier hits; left null otherwise so the
        // execution-time Agent fallback applies.
        const thinkingOverride: AgentThinkingConfig | null = thinking_effort === 'off'
          ? { enabled: false }
          : thinking_effort
            ? { enabled: true, effort: thinking_effort as AgentThinkingEffort }
            : null
        const thinkingConfig = await resolveScoutThinking({
          agentId: ctx.agentId,
          override: thinkingOverride,
        })

        // Resolve the read-only 'scout' built-in toolbox. It excludes
        // scout/spawn_self/spawn_agent, so a scout sub-task is always a LEAF.
        const { getToolboxByName } = await import('@/server/services/toolboxes')
        const scoutBox = getToolboxByName('scout')
        if (!scoutBox) {
          return { error: 'The built-in "scout" toolbox is missing — cannot dispatch a scout.' }
        }

        // Fold hints into the brief so the scout (which has no view of the
        // calling conversation) starts with concrete pointers.
        const hintLines: string[] = []
        if (hints?.paths?.length) hintLines.push(`Focus paths: ${hints.paths.join(', ')}`)
        if (hints?.queries?.length) hintLines.push(`Suggested searches: ${hints.queries.join(' | ')}`)
        const brief = hintLines.length > 0
          ? `${task_description}\n\n[Scout hints]\n${hintLines.join('\n')}`
          : task_description

        const scoutTitle = (title?.trim() || 'Scout').slice(0, 60)

        log.debug(
          {
            agentId: ctx.agentId,
            taskId: ctx.taskId,
            scoutModel: scout.modelId,
            scoutProviderId: scout.providerId,
            isSubAgent: !!ctx.taskId,
          },
          'scout dispatch requested',
        )

        // Spawn the scout as an AWAIT child on the cheap model with the
        // read-only toolbox. parentTaskId is the calling task (when we're in a
        // sub-Agent) so the resume linkage in resolveTask can find this parent.
        let spawned: { taskId: string; queued: boolean }
        try {
          spawned = await spawnTask({
            parentAgentId: ctx.agentId,
            title: scoutTitle,
            description: brief,
            mode: 'await',
            spawnType: 'self',
            model: scout.modelId,
            providerId: scout.providerId ?? undefined,
            toolboxIds: [scoutBox.id],
            thinkingConfig: thinkingConfig ?? undefined,
            channelOriginId: ctx.channelOriginId,
            parentTaskId: ctx.taskId ?? undefined,
            depth: ctx.taskDepth ? ctx.taskDepth + 1 : undefined,
          })
        } catch (err) {
          // Depth/concurrency limits or a missing provider — surface as a tool
          // error so the calling agent can react (it is NOT suspended).
          return { error: err instanceof Error ? err.message : 'Failed to dispatch scout' }
        }

        // MAIN-Agent caller: no task to suspend. The existing await re-entry
        // (task_result → processNextMessage) delivers the digest. Just tell the
        // model to stop emitting on this turn.
        if (!ctx.taskId) {
          return {
            scout_dispatched: true as const,
            scout_task_id: spawned.taskId,
            scout_model: scout.modelId,
            note:
              'A scout sub-task is now running on the scout model and your turn will resume with its digest once it finishes. Do NOT emit any further tool calls on this turn — wait for the scout\'s report to arrive.',
          }
        }

        // SUB-Agent caller: suspend the calling task on the scout child. The
        // runner ends this run without resolving; resolveTask resumes us when
        // the child finishes.
        const suspended = await suspendTaskForChild(ctx.taskId, spawned.taskId)
        if (!suspended.success) {
          // Could not suspend (task no longer active). The scout will still run
          // and resolve; without a waiting parent its result is dropped. Report
          // the failure so the agent doesn't silently wait forever.
          return { error: suspended.error }
        }

        return {
          scout_dispatched: true as const,
          scout_task_id: spawned.taskId,
          scout_model: scout.modelId,
          paused: true as const,
          note:
            'Your task is now PAUSED waiting for the scout\'s digest. Do NOT emit any further tool calls on this turn — the runner stops the loop after this step and resumes your sub-Agent once the scout reports back in your message history.',
        }
      },
    }),
}
