import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  createCron,
  updateCron,
  deleteCron,
  listCrons,
  triggerCronManually,
} from '@/server/services/crons'
import { fetchPreviousCronRuns } from '@/server/services/tasks'
import { resolveKinId } from '@/server/services/kin-resolver'
import { resolveToolboxNamesToIds, getToolbox } from '@/server/services/toolboxes'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'
import type { KinThinkingConfig, KinThinkingEffort } from '@/shared/types'

const log = createLogger('tools:cron')

const THINKING_EFFORT_VALUES = ['off', 'low', 'medium', 'high', 'max'] as const
type ThinkingEffortInput = typeof THINKING_EFFORT_VALUES[number]

/** Map the LLM-facing effort string to a stored thinking config. */
function effortToConfig(effort: ThinkingEffortInput): KinThinkingConfig {
  if (effort === 'off') return { enabled: false, effort: null }
  return { enabled: true, effort: effort as KinThinkingEffort }
}

/** Resolve a stored `toolbox_ids` JSON string into human-readable toolbox names
 *  for tool output. Empty when none set (→ full native surface). */
function toolboxNamesFromJson(raw: string | null): string[] {
  if (!raw) return []
  try {
    const ids = JSON.parse(raw)
    if (!Array.isArray(ids)) return []
    return ids
      .map((id) => (typeof id === 'string' ? getToolbox(id)?.name ?? null : null))
      .filter((n): n is string => n !== null)
  } catch {
    return []
  }
}

/**
 * create_cron — create a new scheduled task.
 * Kin-created crons require user approval before activation.
 * Available to main agents only.
 */
export const createCronTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Create a new scheduled task (cron). Kin-created crons require user approval before activation.',
      inputSchema: z.object({
        name: z.string(),
        schedule: z
          .string()
          .describe('Cron expression (e.g. "0 9 * * *") or ISO 8601 datetime when run_once=true'),
        task_description: z.string(),
        target_kin_slug: z
          .string()
          .optional()
          .describe('Target Kin slug. Omit to execute yourself.'),
        model: z
          .string()
          .optional(),
        provider_id: z
          .string()
          .optional()
          .describe('Provider ID for the model override'),
        run_once: z
          .boolean()
          .optional()
          .describe('If true, fires once then auto-deactivates.'),
        trigger_parent_turn: z
          .boolean()
          .optional()
          .describe('If true, the final report of each execution wakes the parent Kin for an LLM turn. Useful for self-calibrating crons (the Kin re-reads its report and adjusts its behavior). Costly in tokens if the cron is frequent. Default false.'),
        thinking_effort: z
          .enum(THINKING_EFFORT_VALUES)
          .optional()
          .describe('Reasoning effort for tasks spawned by this cron. "off" disables thinking. Defaults to "medium" if omitted.'),
        toolboxes: z
          .array(z.string())
          .optional()
          .describe('Names of the toolboxes whose tools the tasks spawned by this cron may use. The task\'s native toolset is the mandatory core floor unioned with every chosen toolbox\'s tools. Built-ins: "code", "research", "ops", "scout" (read-only), "all" (full surface). Use list_toolboxes to discover available toolboxes. Omit for the full native surface ("all").'),
      }),
      execute: async ({ name, schedule, task_description, target_kin_slug, model, provider_id, run_once, trigger_parent_turn, thinking_effort, toolboxes }) => {
        let targetKinId: string | undefined
        if (target_kin_slug) {
          const resolved = resolveKinId(target_kin_slug)
          if (!resolved) {
            return { error: `Kin not found for slug "${target_kin_slug}"` }
          }
          targetKinId = resolved
        }
        log.debug({ kinId: ctx.kinId, cronName: name, schedule, toolboxes }, 'Cron creation requested')
        try {
          const cron = await createCron({
            kinId: ctx.kinId,
            name,
            schedule,
            taskDescription: task_description,
            targetKinId,
            model,
            providerId: provider_id,
            createdBy: 'kin',
            runOnce: run_once,
            triggerParentTurn: trigger_parent_turn,
            thinkingConfig: effortToConfig(thinking_effort ?? 'medium'),
            toolboxIds: resolveToolboxNamesToIds(toolboxes),
          })
          return {
            cronId: cron.id,
            name: cron.name,
            schedule: cron.schedule,
            runOnce: cron.runOnce,
            triggerParentTurn: cron.triggerParentTurn,
            requiresApproval: true,
            message: 'Cron created — awaiting user approval before activation.',
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * update_cron — modify a scheduled task.
 * Available to main agents only.
 */
export const updateCronTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Update any field of an existing cron (schedule, description, active state, target Kin, model, provider, thinking, toolboxes, run_once). Omit a field to keep its current value.',
      inputSchema: z.object({
        cron_id: z.string(),
        name: z.string().optional(),
        schedule: z.string().optional()
          .describe('New cron expression or ISO 8601 datetime (when run_once)'),
        task_description: z.string().optional(),
        is_active: z.boolean().optional(),
        target_kin_slug: z.string().nullable().optional()
          .describe('Re-target the cron to a different Kin (use the slug). Pass null to clear and run on yourself.'),
        model: z.string().nullable().optional()
          .describe('Override the model used for spawned tasks. Pass null to clear and inherit from the target Kin.'),
        provider_id: z.string().nullable().optional()
          .describe('Provider ID for the model override. Pass null to clear.'),
        run_once: z.boolean().optional()
          .describe('Toggle one-shot vs recurring behavior.'),
        trigger_parent_turn: z.boolean().optional()
          .describe('If true, the final report of each execution wakes the parent Kin for an LLM turn (self-calibration / conditional actions). Costly in tokens if frequent. Omit to keep current.'),
        thinking_effort: z.enum(THINKING_EFFORT_VALUES).optional()
          .describe('Change reasoning effort. "off" disables thinking. Omit to keep current.'),
        toolboxes: z.array(z.string()).nullable().optional()
          .describe('Replace the toolboxes the spawned tasks may use (by name). Built-ins: "code", "research", "ops", "scout", "all". Pass null or an empty array to clear and fall back to the full native surface ("all"). Omit to keep current.'),
      }),
      execute: async ({ cron_id, name, schedule, task_description, is_active, target_kin_slug, model, provider_id, run_once, trigger_parent_turn, thinking_effort, toolboxes }) => {
        try {
          const updates: Parameters<typeof updateCron>[1] = {}
          if (name !== undefined) updates.name = name
          if (schedule !== undefined) updates.schedule = schedule
          if (task_description !== undefined) updates.taskDescription = task_description
          if (is_active !== undefined) updates.isActive = is_active
          if (run_once !== undefined) updates.runOnce = run_once
          if (trigger_parent_turn !== undefined) updates.triggerParentTurn = trigger_parent_turn
          if (model !== undefined) updates.model = model
          if (provider_id !== undefined) updates.providerId = provider_id

          if (target_kin_slug !== undefined) {
            if (target_kin_slug === null) {
              updates.targetKinId = null
            } else {
              const resolved = resolveKinId(target_kin_slug)
              if (!resolved) return { error: `Kin not found for slug "${target_kin_slug}"` }
              updates.targetKinId = resolved
            }
          }

          if (thinking_effort !== undefined) {
            updates.thinkingConfig = JSON.stringify(effortToConfig(thinking_effort))
          }

          if (toolboxes !== undefined) {
            const ids = toolboxes ? resolveToolboxNamesToIds(toolboxes) : undefined
            updates.toolboxIds = ids ? JSON.stringify(ids) : null
          }

          const updated = await updateCron(cron_id, updates)
          if (!updated) return { error: 'Cron not found' }
          return {
            success: true,
            cronId: updated.id,
            name: updated.name,
            schedule: updated.schedule,
            isActive: updated.isActive,
            runOnce: updated.runOnce,
            triggerParentTurn: updated.triggerParentTurn,
            targetKinId: updated.targetKinId,
            model: updated.model,
            providerId: updated.providerId,
            thinkingConfig: updated.thinkingConfig,
            toolboxes: toolboxNamesFromJson(updated.toolboxIds),
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * delete_cron — delete a scheduled task.
 * Available to main agents only.
 */
export const deleteCronTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Delete a cron permanently. Cannot be undone.',
      inputSchema: z.object({
        cron_id: z.string(),
      }),
      execute: async ({ cron_id }) => {
        try {
          await deleteCron(cron_id)
          return { success: true }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * list_crons — list all scheduled tasks for this Kin.
 * Available to main agents only.
 */
export const listCronsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List all your scheduled tasks (crons) with their full configuration.',
      inputSchema: z.object({}),
      execute: async () => {
        const allCrons = await listCrons(ctx.kinId)
        return {
          crons: allCrons.map((c) => ({
            id: c.id,
            name: c.name,
            schedule: c.schedule,
            taskDescription: c.taskDescription,
            isActive: c.isActive,
            runOnce: c.runOnce,
            triggerParentTurn: c.triggerParentTurn,
            requiresApproval: c.requiresApproval,
            targetKinId: c.targetKinId,
            model: c.model,
            providerId: c.providerId,
            thinkingConfig: c.thinkingConfig,
            toolboxes: toolboxNamesFromJson(c.toolboxIds),
            lastTriggeredAt: c.lastTriggeredAt ? c.lastTriggeredAt.toISOString() : null,
          })),
        }
      },
    }),
}

/**
 * get_cron_journal — retrieve the execution history of a cron.
 * Returns recent run results so the Kin can review what happened.
 * Available to main agents only.
 */
export const getCronJournalTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Retrieve execution history of a scheduled task.',
      inputSchema: z.object({
        cron_id: z.string(),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe('Default: 10'),
      }),
      execute: async ({ cron_id, limit }) => {
        try {
          const runs = await fetchPreviousCronRuns(cron_id, limit)
          return {
            cronId: cron_id,
            totalRuns: runs.length,
            runs: runs.map((r) => ({
              status: r.status,
              result: r.result,
              executedAt: r.createdAt.toISOString(),
              completedAt: r.updatedAt.toISOString(),
              durationSeconds: Math.round(
                (r.updatedAt.getTime() - r.createdAt.getTime()) / 1000,
              ),
            })),
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * trigger_cron — manually trigger a cron for immediate execution.
 * Does not affect the regular schedule.
 * Available to main agents only.
 */
export const triggerCronTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Trigger a cron for immediate execution without affecting its regular schedule.',
      inputSchema: z.object({
        cron_id: z.string(),
      }),
      execute: async ({ cron_id }) => {
        try {
          const { taskId } = await triggerCronManually(cron_id)
          return {
            success: true,
            cronId: cron_id,
            taskId,
            message: 'Cron triggered successfully. The task is now running.',
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}
