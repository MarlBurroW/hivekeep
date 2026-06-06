import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  createKin,
  updateKin,
  deleteKin,
  getKinDetails,
  generateAndSaveAvatar,
} from '@/server/services/kins'
import { resolveKinId } from '@/server/services/kin-resolver'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:kin-management')

/**
 * create_kin — create a new permanent Kin on the platform.
 * Opt-in tool: disabled by default.
 */
export const createKinTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Create a new Kin on the platform. Immediately available after creation.',
      inputSchema: z.object({
        name: z.string(),
        role: z.string(),
        character: z.string().describe('Personality and communication style'),
        expertise: z.string(),
        model: z
          .string()
          .optional()
          .describe('LLM model ID. Omit to use the platform default LLM (recommended unless the user asked for a specific model).'),
        toolboxes: z
          .array(z.string())
          .optional()
          .describe(
            'Names of toolboxes granting this Kin its tools. A Kin with NO toolbox can only use the core floor (read/write files, shell, basic) — so give it the toolboxes it needs (don\'t be stingy). Built-ins: "all" (everything), "research" (web + memory), "ops" (memory + vault + http), "code" (projects/tickets), "scout", "email", "calendar", "address-book". Omit to default to "all". Use list_toolboxes to discover more.',
          ),
        generate_avatar: z
          .boolean()
          .optional()
          .default(false),
      }),
      execute: async ({ name, role, character, expertise, model, toolboxes, generate_avatar }) => {
        log.info({ kinId: ctx.kinId, newKinName: name }, 'Kin creation requested via tool')

        try {
          // Default the model + provider to the platform default LLM when not
          // specified, so the new Kin row has a concrete, UI-selectable model
          // (avoids the "Select a model" desync). When a model is given
          // explicitly, its provider is resolved at runtime as before.
          const { getDefaultLlmModel, getDefaultLlmProviderId } = await import('@/server/services/app-settings')
          let finalModel = model?.trim() || undefined
          let providerId: string | null = null
          if (!finalModel) {
            finalModel = (await getDefaultLlmModel()) ?? undefined
            providerId = await getDefaultLlmProviderId()
          }
          if (!finalModel) {
            return { error: 'No LLM model available — configure a default LLM first.' }
          }

          // Resolve toolbox names → ids. Default to "all" (functional) when the
          // caller didn't specify, so the Kin isn't left tool-less.
          const { getToolboxByName } = await import('@/server/services/toolboxes')
          let toolboxIds: string[] | null
          if (toolboxes && toolboxes.length > 0) {
            const ids: string[] = []
            for (const tbName of toolboxes) {
              const box = getToolboxByName(tbName.trim())
              if (box) ids.push(box.id)
              else return { error: `Unknown toolbox "${tbName}". Use list_toolboxes to see available toolboxes.` }
            }
            toolboxIds = ids
          } else {
            const allBox = getToolboxByName('all')
            toolboxIds = allBox ? [allBox.id] : null
          }

          const newKin = await createKin({
            name,
            role,
            character,
            expertise,
            model: finalModel,
            providerId,
            toolboxIds,
            createdBy: ctx.userId ?? null,
          })

          let avatarUrl: string | null = null
          if (generate_avatar) {
            try {
              avatarUrl = await generateAndSaveAvatar(newKin.id)
            } catch (err) {
              log.warn({ kinId: newKin.id, err }, 'Avatar generation failed during kin creation')
            }
          }

          return {
            id: newKin.id,
            slug: newKin.slug,
            name: newKin.name,
            role: newKin.role,
            model: newKin.model,
            avatarUrl,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to create Kin' }
        }
      },
    }),
}

/**
 * update_kin — update an existing Kin's properties and/or tool configuration.
 * Opt-in tool: disabled by default.
 */
export const updateKinTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        "Update a Kin's properties or tool grants. Cannot modify yourself.",
      inputSchema: z.object({
        kin_id: z.string().describe('Slug or UUID'),
        name: z.string().optional(),
        role: z.string().optional(),
        character: z.string().optional(),
        expertise: z.string().optional(),
        model: z.string().optional(),
        slug: z.string().optional().describe('Lowercase, hyphens, 2-50 chars'),
        toolboxes: z
          .array(z.string())
          .optional()
          .describe(
            'Names of the toolboxes whose tools this Kin may use. The Kin\'s toolset is the mandatory core floor unioned with every chosen toolbox\'s tools. Built-ins: "all" (everything), "research", "ops", "code", "scout", "email", "calendar", "address-book". Use list_toolboxes to discover more. Pass [] to remove ALL toolboxes — the Kin then only has the core floor (it will say it lacks tools for most things), so prefer a real selection.',
          ),
        generate_avatar: z
          .boolean()
          .optional()
          .default(false),
      }),
      execute: async ({ kin_id, name, role, character, expertise, model, slug, toolboxes, generate_avatar }) => {
        const targetKinId = resolveKinId(kin_id)
        if (!targetKinId) {
          return { error: `Kin "${kin_id}" not found` }
        }

        if (targetKinId === ctx.kinId) {
          return { error: 'You cannot modify your own configuration. Ask a user or another Kin to do this.' }
        }

        log.info({ kinId: ctx.kinId, targetKinId, targetSlug: kin_id }, 'Kin update requested via tool')

        // Resolve toolbox names to ids when provided. An explicit empty array
        // resets the Kin to the 'all' built-in (null → 'all' at resolution).
        let toolboxIds: string[] | null | undefined
        if (toolboxes !== undefined) {
          if (toolboxes.length === 0) {
            toolboxIds = null
          } else {
            const { getToolboxByName } = await import('@/server/services/toolboxes')
            const ids: string[] = []
            for (const tbName of toolboxes) {
              const box = getToolboxByName(tbName.trim())
              if (box) ids.push(box.id)
              else return { error: `Unknown toolbox "${tbName}". Use list_toolboxes to see available toolboxes.` }
            }
            toolboxIds = ids
          }
        }

        try {
          const result = await updateKin(targetKinId, {
            name,
            role,
            character,
            expertise,
            model,
            slug,
            toolboxIds,
          })

          if ('error' in result) {
            return { error: result.error.message }
          }

          const { kin: updated } = result

          let avatarUrl = updated.avatarUrl
          if (generate_avatar) {
            try {
              avatarUrl = await generateAndSaveAvatar(targetKinId)
            } catch {
              // Non-fatal: update succeeded, avatar generation is optional
            }
          }

          return {
            id: updated.id,
            slug: updated.slug,
            name: updated.name,
            role: updated.role,
            model: updated.model,
            avatarUrl,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to update Kin' }
        }
      },
    }),
}

/**
 * delete_kin — permanently delete a Kin and all its data.
 * Opt-in tool: disabled by default.
 */
export const deleteKinTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Permanently delete a Kin and all its data. Irreversible. Cannot delete yourself.',
      inputSchema: z.object({
        kin_id: z.string().describe('Slug or UUID'),
        confirm: z.literal(true).describe('Must be true'),
      }),
      execute: async ({ kin_id, confirm }) => {
        if (!confirm) {
          return { error: 'Deletion must be explicitly confirmed with confirm: true' }
        }

        const targetKinId = resolveKinId(kin_id)
        if (!targetKinId) {
          return { error: `Kin "${kin_id}" not found` }
        }

        if (targetKinId === ctx.kinId) {
          return { error: 'You cannot delete yourself. Ask a user or another Kin to do this.' }
        }

        log.warn({ kinId: ctx.kinId, targetKinId, targetSlug: kin_id }, 'Kin deletion requested via tool')

        try {
          const deleted = await deleteKin(targetKinId)
          if (!deleted) {
            return { error: 'Kin not found' }
          }
          return { success: true, deletedKin: kin_id }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to delete Kin' }
        }
      },
    }),
}

/**
 * get_kin_details — get detailed information about a Kin.
 * Opt-in tool: disabled by default.
 */
export const getKinDetailsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Get detailed information about a Kin including config, MCP servers, and tool settings.',
      inputSchema: z.object({
        kin_id: z.string().describe('Slug or UUID'),
      }),
      execute: async ({ kin_id }) => {
        const targetKinId = resolveKinId(kin_id)
        if (!targetKinId) {
          return { error: `Kin "${kin_id}" not found` }
        }

        const details = await getKinDetails(targetKinId)
        if (!details) {
          return { error: 'Kin not found' }
        }

        // Resolve the Kin's toolbox ids to display names. Null/empty → the Kin
        // defaults to the 'all' built-in at resolution time.
        let toolboxNames: string[] = []
        if (details.toolboxIds) {
          try {
            const ids = JSON.parse(details.toolboxIds)
            if (Array.isArray(ids) && ids.length > 0) {
              const { getToolbox } = await import('@/server/services/toolboxes')
              toolboxNames = ids
                .map((id: unknown) => (typeof id === 'string' ? getToolbox(id)?.name : undefined))
                .filter((n): n is string => typeof n === 'string')
            }
          } catch {
            // Malformed — treat as default (all).
          }
        }

        return {
          id: details.id,
          slug: details.slug,
          name: details.name,
          role: details.role,
          character: details.character,
          expertise: details.expertise,
          model: details.model,
          mcpServers: details.mcpServers.map((s) => ({ id: s.id, name: s.name })),
          toolboxes: toolboxNames.length > 0 ? toolboxNames : ['all'],
          createdAt: details.createdAt.toISOString(),
        }
      },
    }),
}
