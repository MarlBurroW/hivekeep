import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentDetails,
  generateAndSaveAvatar,
} from '@/server/services/agents'
import { resolveAgentId } from '@/server/services/agent-resolver'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:agent-management')

/**
 * create_agent — create a new permanent Agent on the platform.
 * Opt-in tool: disabled by default.
 */
export const createAgentTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Create a new Agent on the platform. Immediately available after creation.',
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
            'Names of toolboxes granting this Agent its tools. An Agent with NO toolbox can only use the core floor (read/write files, shell, basic) — so give it the toolboxes it needs (don\'t be stingy). Built-ins: "all" (everything), "research" (web + memory), "ops" (memory + vault + http), "code" (task introspection + web docs + read-only memory), "scout", "email", "calendar", "address-book". Omit to default to "all". Use list_toolboxes to discover more.',
          ),
        generate_avatar: z
          .boolean()
          .optional()
          .default(false),
      }),
      execute: async ({ name, role, character, expertise, model, toolboxes, generate_avatar }) => {
        log.info({ agentId: ctx.agentId, newAgentName: name }, 'Agent creation requested via tool')

        try {
          // Default the model + provider to the platform default LLM when not
          // specified, so the new Agent row has a concrete, UI-selectable model
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
          // caller didn't specify, so the Agent isn't left tool-less.
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

          const newAgent = await createAgent({
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
              avatarUrl = await generateAndSaveAvatar(newAgent.id)
            } catch (err) {
              log.warn({ agentId: newAgent.id, err }, 'Avatar generation failed during agent creation')
            }
          }

          return {
            id: newAgent.id,
            slug: newAgent.slug,
            name: newAgent.name,
            role: newAgent.role,
            model: newAgent.model,
            avatarUrl,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to create Agent' }
        }
      },
    }),
}

/**
 * update_agent — update an existing Agent's properties and/or tool configuration.
 * Opt-in tool: disabled by default.
 */
export const updateAgentTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        "Update an Agent's properties or tool grants. On YOURSELF you may refine your persona (name, role, character, expertise) and regenerate your avatar (generate_avatar: true), but you may NOT change your own toolboxes, model, or slug — ask a user or another Agent for those.",
      inputSchema: z.object({
        agent_id: z.string().describe('Slug or UUID'),
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
            'Names of the toolboxes whose tools this Agent may use. The Agent\'s toolset is the mandatory core floor unioned with every chosen toolbox\'s tools. Built-ins: "all" (everything), "research", "ops", "code", "scout", "email", "calendar", "address-book". Use list_toolboxes to discover more. Pass [] to remove ALL toolboxes — the Agent then only has the core floor (it will say it lacks tools for most things), so prefer a real selection.',
          ),
        generate_avatar: z
          .boolean()
          .optional()
          .default(false),
      }),
      execute: async ({ agent_id, name, role, character, expertise, model, slug, toolboxes, generate_avatar }) => {
        const targetAgentId = resolveAgentId(agent_id)
        if (!targetAgentId) {
          return { error: `Agent "${agent_id}" not found` }
        }

        // An Agent may refine its OWN persona (name, role, character, expertise) and
        // regenerate its OWN avatar — this powers the self-improving flow (e.g.
        // Queenie refreshing its look when the user changes the avatar
        // art-direction). But it may NOT change its toolboxes (privilege
        // escalation), its model (cost/capability), or its slug (which breaks
        // channel / cron / mention references). Block only those.
        if (targetAgentId === ctx.agentId) {
          const touchesProtected =
            toolboxes !== undefined || model !== undefined || slug !== undefined
          if (touchesProtected) {
            return {
              error:
                'You can update your own persona (name, role, character, expertise) and avatar, but not your toolboxes, model, or slug. Ask a user or another Agent to change those.',
            }
          }
        }

        log.info({ agentId: ctx.agentId, targetAgentId, targetSlug: agent_id }, 'Agent update requested via tool')

        // Resolve toolbox names to ids when provided. An explicit empty array
        // resets the Agent to the 'all' built-in (null → 'all' at resolution).
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
          const result = await updateAgent(targetAgentId, {
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

          const { agent: updated } = result

          let avatarUrl = updated.avatarUrl
          if (generate_avatar) {
            try {
              avatarUrl = await generateAndSaveAvatar(targetAgentId)
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
          return { error: err instanceof Error ? err.message : 'Failed to update Agent' }
        }
      },
    }),
}

/**
 * delete_agent — permanently delete an Agent and all its data.
 * Opt-in tool: disabled by default.
 */
export const deleteAgentTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Permanently delete an Agent and all its data. Irreversible. Cannot delete yourself.',
      inputSchema: z.object({
        agent_id: z.string().describe('Slug or UUID'),
        confirm: z.literal(true).describe('Must be true'),
      }),
      execute: async ({ agent_id, confirm }) => {
        if (!confirm) {
          return { error: 'Deletion must be explicitly confirmed with confirm: true' }
        }

        const targetAgentId = resolveAgentId(agent_id)
        if (!targetAgentId) {
          return { error: `Agent "${agent_id}" not found` }
        }

        if (targetAgentId === ctx.agentId) {
          return { error: 'You cannot delete yourself. Ask a user or another Agent to do this.' }
        }

        log.warn({ agentId: ctx.agentId, targetAgentId, targetSlug: agent_id }, 'Agent deletion requested via tool')

        try {
          const deleted = await deleteAgent(targetAgentId)
          if (!deleted) {
            return { error: 'Agent not found' }
          }
          return { success: true, deletedAgent: agent_id }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to delete Agent' }
        }
      },
    }),
}

/**
 * get_agent_details — get detailed information about an Agent.
 * Opt-in tool: disabled by default.
 */
export const getAgentDetailsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Get detailed information about an Agent including config, MCP servers, and tool settings.',
      inputSchema: z.object({
        agent_id: z.string().describe('Slug or UUID'),
      }),
      execute: async ({ agent_id }) => {
        const targetAgentId = resolveAgentId(agent_id)
        if (!targetAgentId) {
          return { error: `Agent "${agent_id}" not found` }
        }

        const details = await getAgentDetails(targetAgentId)
        if (!details) {
          return { error: 'Agent not found' }
        }

        // Resolve the Agent's toolbox ids to display names. Null/empty → the Agent
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
