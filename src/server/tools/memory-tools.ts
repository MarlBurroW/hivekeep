import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq, inArray } from 'drizzle-orm'
import {
  searchMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  listMemories,
} from '@/server/services/memory'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import { getExtractionModel, getExtractionProviderId } from '@/server/services/app-settings'
import { recordUsage } from '@/server/services/token-usage'
import type { ToolRegistration } from '@/server/tools/types'
import type { MemoryCategory, MemoryScope } from '@/shared/types'

const log = createLogger('tools:memory')

const CATEGORIES: [string, ...string[]] = ['fact', 'preference', 'decision', 'knowledge']

/**
 * Format a memory's age as a human-readable relative time string.
 */
function formatMemoryAge(updatedAt: Date | null): string | null {
  if (!updatedAt) return null
  const diffMs = Date.now() - updatedAt.getTime()
  const diffMin = Math.round(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHours = Math.round(diffMin / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  const diffMonths = Math.round(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths}mo ago`
  return `${Math.round(diffDays / 365)}y ago`
}

/**
 * recall — semantic + keyword search in the Agent's long-term memory.
 * Available to main agents only.
 */
export const recallTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Search your memory archive: dated events, past details, one-off facts, and decisions from earlier interactions. ' +
        'Your profile already holds the durable context, so use this for anything episodic that is not there — and use it ' +
        'BEFORE telling someone you do not remember something.',
      inputSchema: z.object({
        query: z.string(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Default: 10'),
        subject: z
          .string()
          .optional()
          .describe('Narrow to one subject (person, project). Must match the stored subject exactly.'),
        category: z
          .enum(CATEGORIES)
          .optional()
          .describe('Narrow to one category.'),
        since: z
          .string()
          .optional()
          .describe('ISO date (e.g. "2026-07-01"). Only return memories updated on or after it.'),
      }),
      execute: async ({ query, limit, subject, category, since }) => {
        log.debug({ agentId: ctx.agentId, query, subject, category, since }, 'Recall invoked')

        let sinceDate: Date | undefined
        if (since) {
          const parsed = new Date(since)
          if (Number.isNaN(parsed.getTime())) {
            return { error: `Invalid "since" date: "${since}". Use an ISO date such as 2026-07-01.` }
          }
          sinceDate = parsed
        }

        const results = await searchMemories(ctx.agentId, query, limit, {
          subject,
          category,
          since: sinceDate,
        })
        return {
          memories: results.map((m) => ({
            id: m.id,
            content: m.content,
            category: m.category,
            subject: m.subject,
            importance: m.importance,
            scope: m.scope,
            ...(m.scope === 'shared' && m.authorAgentName ? { authorAgentName: m.authorAgentName } : {}),
            age: formatMemoryAge(m.updatedAt),
            ...(m.sourceContext ? { sourceContext: m.sourceContext } : {}),
          })),
        }
      },
    }),
}

/**
 * memorize — explicitly save a piece of information to long-term memory.
 * Available to main agents only.
 */
export const memorizeTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Save an episodic fact to your memory archive: something that may matter when a topic comes back later. ' +
        'If the information should instead shape your behavior in most future conversations without anyone mentioning it ' +
        '(a standing preference, an active project, a durable convention), use edit_profile instead.',
      inputSchema: z.object({
        content: z.string().describe('Clear, standalone sentence to remember'),
        category: z
          .enum(CATEGORIES),
        subject: z
          .string()
          .optional()
          .describe('Who/what this is about (e.g. a contact name)'),
        importance: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('1=mundane, 5=useful, 10=critical. Default: 5'),
        scope: z
          .enum(['private', 'shared'])
          .optional()
          .describe(
            '"private" (default) = only you can recall this memory. Use for: your own observations, ' +
            'task-specific context, personal interaction notes, anything only relevant to your domain. ' +
            '"shared" = all Agents can recall this memory. Use ONLY for information that would genuinely ' +
            'help other Agents: cross-domain facts (infrastructure details, user-wide preferences, ' +
            'project decisions affecting everyone), shared context (user availability, organizational ' +
            'changes). Do NOT share: your internal reasoning, task-specific details, domain-specific ' +
            'knowledge that other Agents would never need.',
          ),
      }),
      execute: async ({ content, category, subject, importance, scope }) => {
        log.debug({ agentId: ctx.agentId, category, subject, scope }, 'Memorize invoked')
        const memory = await createMemory(ctx.agentId, {
          content,
          category: category as MemoryCategory,
          subject,
          importance: importance ?? null,
          sourceChannel: 'explicit',
          scope: (scope as MemoryScope) ?? 'private',
        })
        return memory
          ? { id: memory.id, content: memory.content, category: memory.category, subject: memory.subject }
          : { error: 'Failed to create memory' }
      },
    }),
}

/**
 * update_memory — update an existing memory's content.
 * Available to main agents only.
 */
export const updateMemoryTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Update an existing memory with corrected or new information.',
      inputSchema: z.object({
        memory_id: z.string(),
        content: z.string().optional(),
        category: z
          .enum(CATEGORIES)
          .optional(),
        subject: z.string().optional(),
        scope: z
          .enum(['private', 'shared'])
          .optional()
          .describe('Change scope: "private" = only you, "shared" = all Agents'),
      }),
      execute: async ({ memory_id, content, category, subject, scope }) => {
        const updated = await updateMemory(memory_id, ctx.agentId, {
          content,
          category: category as MemoryCategory | undefined,
          subject,
          scope: scope as MemoryScope | undefined,
        })
        if (!updated) return { error: 'Memory not found' }
        return { id: updated.id, content: updated.content, category: updated.category, subject: updated.subject }
      },
    }),
}

/**
 * forget — delete a memory that is no longer relevant or accurate.
 * Available to main agents only.
 */
export const forgetTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Delete a memory that is outdated, incorrect, or no longer relevant.',
      inputSchema: z.object({
        memory_id: z.string(),
      }),
      execute: async ({ memory_id }) => {
        const deleted = await deleteMemory(memory_id, ctx.agentId)
        return deleted ? { success: true } : { error: 'Memory not found' }
      },
    }),
}

/**
 * list_memories — list all memories, optionally filtered by subject or category.
 * Available to main agents only.
 */
export const listMemoriesTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List stored memories, optionally filtered by subject or category.',
      inputSchema: z.object({
        subject: z.string().optional(),
        category: z
          .enum(CATEGORIES)
          .optional(),
        scope: z
          .enum(['private', 'shared'])
          .optional()
          .describe('Filter by scope. Omit to list own private memories. "shared" lists all shared memories from all Agents.'),
      }),
      execute: async ({ subject, category, scope }) => {
        const results = await listMemories(ctx.agentId, {
          subject,
          category: category as MemoryCategory | undefined,
          scope: scope as MemoryScope | undefined,
        })

        // Resolve author Agent names for shared memories from other Agents
        const otherAgentIds = [...new Set(results.filter((m) => m.scope === 'shared' && m.agentId !== ctx.agentId).map((m) => m.agentId))]
        const agentNameMap = new Map<string, string>()
        if (otherAgentIds.length > 0) {
          const agentRows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, otherAgentIds)).all()
          for (const k of agentRows) agentNameMap.set(k.id, k.name)
        }

        return {
          memories: results.map((m) => ({
            id: m.id,
            content: m.content,
            category: m.category,
            subject: m.subject,
            importance: m.importance,
            scope: m.scope,
            ...(m.scope === 'shared' && m.agentId !== ctx.agentId ? { authorAgentName: agentNameMap.get(m.agentId) ?? null } : {}),
            age: formatMemoryAge(m.updatedAt),
            ...(m.sourceContext ? { sourceContext: m.sourceContext } : {}),
          })),
        }
      },
    }),
}

/**
 * edit_profile — patch the curated profile document that is always in context.
 * Available to main agents only.
 */
export const editProfileTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Edit your memory profile: the curated document always present in your context. ' +
        'Use it only for information that should shape your behavior in most future conversations without anyone ' +
        'mentioning it (a standing preference, an active project, a durable convention, a decision that still applies). ' +
        'Anything episodic — dated events, one-off details you might look up later — belongs in the archive via memorize. ' +
        'The profile has a limited token budget, so keep entries short and remove what no longer applies.',
      inputSchema: z.object({
        section: z
          .string()
          .describe('Section heading, e.g. "Active projects", "Preferences & conventions", "Open threads". Created if absent.'),
        operation: z
          .enum(['append', 'replace_section', 'remove_line'])
          .describe(
            '"append" adds a line to the section. "replace_section" overwrites the whole section body. ' +
            '"remove_line" deletes the line matching `content` exactly.',
          ),
        content: z
          .string()
          .describe('The line to add or remove, or the full new body for replace_section. Use "- " bullets.'),
        pin: z
          .boolean()
          .optional()
          .describe(
            'Put the entry in the "Pinned" section, which is never altered by automatic rewrites. ' +
            'Use for instructions the user explicitly asked you to always follow.',
          ),
      }),
      execute: async ({ section, operation, content, pin }) => {
        log.debug({ agentId: ctx.agentId, section, operation, pin }, 'Edit profile invoked')
        const { editProfile, ProfileBudgetError, ProfileLineNotFoundError } = await import(
          '@/server/services/agent-profile'
        )
        try {
          const profile = await editProfile(ctx.agentId, { section, operation, content, pin })
          return {
            success: true,
            tokenEstimate: profile.tokenEstimate,
            budget: config.memory.profileMaxTokens,
            profile: profile.content,
          }
        } catch (err) {
          // Both carry an actionable message (what to prune / what was missing),
          // so the model can correct itself instead of retrying blindly.
          if (err instanceof ProfileBudgetError || err instanceof ProfileLineNotFoundError) {
            return { error: err.message }
          }
          throw err
        }
      },
    }),
}

/**
 * review_memories — audit memory health and identify issues.
 * Uses an LLM to detect contradictions, near-duplicates, stale entries, and clutter.
 * Available to main agents only.
 */
export const reviewMemoriesTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Audit memory for contradictions, duplicates, stale entries, and clutter. Returns actionable suggestions.',
      inputSchema: z.object({
        subject: z
          .string()
          .optional()
          .describe('Only review memories about this subject'),
        scope: z
          .enum(['private', 'shared'])
          .optional()
          .describe('Review only private or shared memories. Omit to review your own memories.'),
      }),
      execute: async ({ subject, scope }) => {
        log.debug({ agentId: ctx.agentId, subject, scope }, 'Review memories invoked')

        const allMemories = await listMemories(ctx.agentId, {
          subject: subject || undefined,
          scope: scope as MemoryScope | undefined,
        })

        if (allMemories.length === 0) {
          return { issues: [], summary: 'No memories to review.' }
        }

        // Cap at 200 memories to avoid huge prompts
        const memoriesToReview = allMemories.slice(0, 200)

        const memoriesList = memoriesToReview
          .map((m, i) => {
            const age = formatMemoryAge(m.updatedAt)
            const imp = m.importance != null ? ` [importance: ${m.importance}]` : ''
            const subj = m.subject ? ` (subject: ${m.subject})` : ''
            return `[${i}] id=${m.id} | ${m.category}${subj}${imp} | ${age}\n${m.content}`
          })
          .join('\n\n')

        const reviewPrompt =
          `You are a memory quality auditor. Review the following memories and identify issues.\n\n` +
          `Look for:\n` +
          `1. **Contradictions**: Two memories that state conflicting facts (e.g., "likes coffee" vs "hates coffee")\n` +
          `2. **Near-duplicates**: Memories that say essentially the same thing (redundant entries)\n` +
          `3. **Stale/outdated**: Memories that are likely no longer accurate based on context clues (e.g., "is 25 years old" stored 3 years ago)\n` +
          `4. **Low-value clutter**: Trivial, vague, or overly specific memories that waste space\n\n` +
          `Return a JSON object with:\n` +
          `{\n` +
          `  "issues": [\n` +
          `    {\n` +
          `      "type": "contradiction" | "duplicate" | "stale" | "clutter",\n` +
          `      "memoryIds": ["id1", "id2"],  // IDs of affected memories\n` +
          `      "description": "Brief explanation of the issue",\n` +
          `      "suggestion": "delete" | "merge" | "update",\n` +
          `      "suggestedContent": "Merged/corrected content if applicable"\n` +
          `    }\n` +
          `  ],\n` +
          `  "summary": "Brief overall health assessment"\n` +
          `}\n\n` +
          `Rules:\n` +
          `- Only flag genuine issues. Don't be overzealous.\n` +
          `- For duplicates, suggest merging into the better-worded version.\n` +
          `- For contradictions, flag both memories and let the Agent decide which is correct.\n` +
          `- If everything looks clean, return an empty issues array with a positive summary.\n` +
          `- Be conservative: when in doubt, don't flag it.\n\n` +
          `## Memories to review (${memoriesToReview.length} total)\n\n${memoriesList}`

        // Resolve provider+model. Preference chain: app-settings
        // extraction model, then env-configured extraction model, then
        // pickAnyLLMModel as last resort. Never hardcode a specific
        // provider's model id in core — the previous fallback
        // ('gpt-4.1-mini') made Hivekeep OpenAI-dependent for memory review.
        const { resolveLLM, pickAnyLLMModel } = await import('@/server/llm/core/resolve')
        const { runOneShot } = await import('@/server/llm/core/run-oneshot')
        const settingsExtractionModel = await getExtractionModel()
        const effectiveModel = settingsExtractionModel ?? config.memory.extractionModel
        const settingsProviderId = await getExtractionProviderId()
        let resolved
        try {
          resolved = effectiveModel
            ? await resolveLLM({
                modelId: effectiveModel,
                providerId: settingsProviderId ?? config.memory.extractionProviderId ?? null,
              })
            : await pickAnyLLMModel()
          if (!resolved) {
            return { issues: [], summary: 'No LLM model available for review.' }
          }
        } catch {
          return { issues: [], summary: 'No LLM model available for review.' }
        }

        try {
          const result = await runOneShot(resolved, {
            messages: [{ role: 'user', content: [{ type: 'text', text: reviewPrompt }] }],
          })

          recordUsage({
            callSite: 'memory-review',
            callType: 'generate-text',
            providerType: resolved.providerRow.type,
            providerId: resolved.providerRow.id,
            modelId: resolved.model.id,
            agentId: ctx.agentId,
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              inputTokenDetails: { cacheReadTokens: result.usage.cacheReadTokens, cacheWriteTokens: result.usage.cacheWriteTokens },
              outputTokenDetails: { reasoningTokens: result.usage.reasoningTokens },
            },
          })

          const jsonMatch = result.text.match(/\{[\s\S]*\}/)
          if (!jsonMatch) {
            return { issues: [], summary: 'Review completed but no issues detected.' }
          }

          const parsed = JSON.parse(jsonMatch[0]) as {
            issues: Array<{
              type: string
              memoryIds: string[]
              description: string
              suggestion: string
              suggestedContent?: string
            }>
            summary: string
          }

          return parsed
        } catch (err) {
          log.error({ agentId: ctx.agentId, err }, 'Memory review LLM error')
          return { issues: [], summary: 'Review failed due to an error.' }
        }
      },
    }),
}
