import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { createHumanPrompt } from '@/server/services/human-prompts'
import { getAgentExtraToolNames } from '@/server/services/toolset-resolver'
import { toolRegistry } from '@/server/tools/index'
import { resolveCustomTools } from '@/server/services/custom-tools'
import { getToolboxByName, resolveToolboxNames, CORE_TOOLS } from '@/server/services/toolboxes'
import { resolveAgentToolboxIds } from '@/server/services/toolset-resolver'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:tool-access')

/**
 * request_tool_access — let an Agent ask the user for access to tools it does
 * not currently have. Creates a `tool_access` human prompt: the user sees a
 * card with one checkbox per requested tool plus the Agent's reason, can grant
 * a subset (or deny), and the approved names land in `agents.extra_tool_names`
 * (permanent, revocable from the Agent's Tools tab). Every tool known to the
 * platform is requestable — the human approval is the gate.
 */
export const requestToolAccessTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) => {
    let requestedThisTurn = false
    return tool({
      description:
        'Request access to tools you do not currently have. Use list_tools first to discover what exists (names + domains). Pass the exact tool names you need and a short reason — the user is prompted to grant or deny, and granted tools become permanently available to you. One request per turn.',
      inputSchema: z.object({
        tool_names: z
          .array(z.string())
          .min(1)
          .max(25)
          .describe('Exact tool names to request (from list_tools). To request a whole domain, pass its tools explicitly.'),
        reason: z
          .string()
          .min(10)
          .max(500)
          .describe('Why you need these tools — shown verbatim to the user on the approval card.'),
      }),
      execute: async ({ tool_names, reason }) => {
        if (requestedThisTurn) {
          return { error: 'You already requested tool access this turn. Wait for the user to respond before requesting again.' }
        }
        requestedThisTurn = true

        // Universe check: native + plugin (registry) + enabled custom tools.
        const registryNames = new Set(toolRegistry.list().map((t) => t.name))
        const customNames = new Set(Object.keys(resolveCustomTools()))
        const unknown = tool_names.filter((n) => !registryNames.has(n) && !customNames.has(n))
        if (unknown.length > 0) {
          return {
            error: `Unknown tool name${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Use list_tools to discover the exact names.`,
          }
        }

        // Drop tools the Agent can already use (toolboxes ∪ extras ∪ core floor).
        const agentRow = await db.select().from(agents).where(eq(agents.id, ctx.agentId)).get()
        const boxNames = new Set([
          ...CORE_TOOLS,
          ...resolveToolboxNames(resolveAgentToolboxIds(agentRow?.toolboxIds)),
          ...(await getAgentExtraToolNames(ctx.agentId)),
        ])
        const missing = tool_names.filter((n) => !boxNames.has(n))
        if (missing.length === 0) {
          return { message: 'You already have access to all of the requested tools — no request was sent.' }
        }

        const domains = new Map(toolRegistry.list().map((t) => [t.name, t.domain]))
        const { promptId } = await createHumanPrompt({
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          promptType: 'tool_access',
          question: `Tool access request (${missing.length} tool${missing.length > 1 ? 's' : ''})`,
          description: reason,
          options: missing.map((name) => ({
            label: name,
            value: name,
            description: domains.has(name) ? `domain: ${domains.get(name)}` : 'custom tool',
          })),
        })

        log.info({ agentId: ctx.agentId, promptId, tools: missing }, 'Tool access requested')
        return {
          promptId,
          status: 'pending',
          requested: missing,
          message: 'The user has been asked to grant access. Their decision will arrive as a new message — granted tools become available on your next turn. Please wait.',
        }
      },
    })
  },
}
