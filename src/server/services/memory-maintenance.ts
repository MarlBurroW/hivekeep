import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { memories } from '@/server/db/schema'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { safeGenerateText } from '@/server/services/llm-helpers'
import { getExtractionModel, getExtractionProviderId } from '@/server/services/app-settings'
import { isDuplicateMemory, createMemory, updateMemory } from '@/server/services/memory'
import {
  getProfile,
  setProfile,
  getProfileBudget,
  parseSections,
  serializeSections,
  PINNED_SECTION,
} from '@/server/services/agent-profile'
import { countTokens } from '@/shared/token-estimator'
import type { MemoryCategory } from '@/shared/types'

const log = createLogger('memory-maintenance')

/**
 * The single boundary test shared by every profile-vs-archive decision point:
 * this prompt, the `## Your memory` prompt block, and the memorize /
 * edit_profile tool descriptions (see memory.md §3).
 */
export const BOUNDARY_TEST =
  `Should this influence the Agent's behavior in most future conversations, without anyone mentioning it? ` +
  `Yes -> the profile. No, but it may matter when a topic comes back -> the archive.`

export interface ArchiveItem {
  action: 'add' | 'update'
  content: string
  category: string
  subject?: string | null
  importance?: number | null
  sourceContext?: string | null
  updateIndex?: number
}

export interface MaintenanceResponse {
  archive: ArchiveItem[]
  /** null when the model returned no usable profile — the caller keeps the old one. */
  profile: string | null
}

// ─── Response parsing ────────────────────────────────────────────────────────

function stripCodeFence(text: string): string {
  return text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '').trim()
}

function extractTag(text: string, tag: string): string | null {
  const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))
  return match ? match[1]!.trim() : null
}

/**
 * Parse the maintenance response.
 *
 * The profile is delimited by tags rather than carried inside JSON: a
 * multi-line markdown document embedded in a JSON string is a reliable way to
 * get broken escaping out of smaller models, and a failed parse there would
 * cost us the archive items too.
 */
export function parseMaintenanceResponse(text: string): MaintenanceResponse {
  const archiveRaw = extractTag(text, 'archive')
  // Fall back to the first bracketed array anywhere in the response so a model
  // that drops the tags still gets its archive items applied.
  const arrayMatch = (archiveRaw ?? text).match(/\[[\s\S]*\]/)

  let archive: ArchiveItem[] = []
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]) as unknown
      if (Array.isArray(parsed)) {
        archive = parsed.filter(
          (item): item is ArchiveItem =>
            !!item && typeof item === 'object'
            && typeof (item as ArchiveItem).content === 'string'
            && typeof (item as ArchiveItem).category === 'string',
        )
      }
    } catch {
      // Unparseable archive JSON must not cost us the profile rewrite.
      log.debug('Maintenance archive JSON unparseable, skipping archive items')
    }
  }

  const profileRaw = extractTag(text, 'profile')
  const profile = profileRaw ? stripCodeFence(profileRaw) : null

  return { archive, profile: profile && profile.length > 0 ? profile : null }
}

// ─── Guards ──────────────────────────────────────────────────────────────────

/**
 * Reinstate the previous `## Pinned` section verbatim.
 *
 * The prompt asks the model to copy it unchanged, but pinned entries are the
 * one thing a user explicitly asked to keep forever, so it is enforced in code
 * rather than trusted to instruction-following.
 */
export function enforcePinned(previous: string, next: string): string {
  const previousPinned = parseSections(previous).find(
    (s) => s.title.toLowerCase() === PINNED_SECTION.toLowerCase(),
  )
  if (!previousPinned || !previousPinned.lines.some((l) => l.trim())) return next

  const sections = parseSections(next)
  const index = sections.findIndex((s) => s.title.toLowerCase() === PINNED_SECTION.toLowerCase())
  if (index === -1) sections.unshift(previousPinned)
  else sections[index] = previousPinned

  return serializeSections(sections)
}

/**
 * Hard-truncate a rewrite that blew well past the budget.
 *
 * The prompt states the budget; a small overshoot is tolerated rather than
 * cutting a document mid-sentence. Beyond the tolerance we drop whole trailing
 * sections, keeping Pinned, so the result stays valid markdown.
 */
export function enforceBudget(content: string, budget: number, tolerance = 1.2): string {
  if (budget <= 0 || countTokens(content) <= budget * tolerance) return content

  const sections = parseSections(content)
  const kept: typeof sections = []
  let tokens = 0

  // Pinned first, whatever its position: it must survive the truncation.
  const ordered = [
    ...sections.filter((s) => s.title.toLowerCase() === PINNED_SECTION.toLowerCase()),
    ...sections.filter((s) => s.title.toLowerCase() !== PINNED_SECTION.toLowerCase()),
  ]

  for (const section of ordered) {
    const cost = countTokens(serializeSections([section]))
    if (kept.length > 0 && tokens + cost > budget) break
    kept.push(section)
    tokens += cost
  }

  const dropped = sections.length - kept.length
  if (dropped === 0) {
    // A single section over budget: there is nothing to drop without cutting
    // the document mid-line, so it is left alone.
    log.warn({ budget, tokens: countTokens(content) }, 'Profile rewrite is over budget but has no section to drop')
    return content
  }

  const truncated = serializeSections(kept)
  log.warn(
    { budget, before: countTokens(content), after: countTokens(truncated), droppedSections: dropped },
    'Profile rewrite exceeded its budget — trailing sections dropped',
  )
  return truncated
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * Upper bound on how many archive memories are listed in the maintenance
 * prompt. The list exists so the model can pick an `updateIndex` instead of
 * duplicating an existing memory; it is not meant to be the whole archive.
 * Unbounded, a long-lived Agent would ship its entire archive to the LLM on
 * every single compaction.
 */
export const MAX_ARCHIVE_INDEX = 150

export interface ArchiveIndexEntry {
  id: string
  content: string
  category: string
  subject: string | null
  updatedAt: Date | null
}

/**
 * Pick which archive memories to show the maintenance call.
 *
 * Two things make a memory worth listing: it is recent (so likely still live),
 * or the batch being compacted talks about its subject (so it is a likely
 * update target). Subject matches are capped at half the budget so a batch
 * about one busy subject cannot crowd out everything recent.
 *
 * Returns newest-first, which is also the order the prompt numbers them in.
 */
export function selectArchiveIndex(
  all: ArchiveIndexEntry[],
  batchText: string,
  limit = MAX_ARCHIVE_INDEX,
): ArchiveIndexEntry[] {
  if (all.length <= limit) {
    return [...all].sort(byNewest)
  }

  const haystack = batchText.toLowerCase()
  const sorted = [...all].sort(byNewest)

  const picked = new Map<string, ArchiveIndexEntry>()
  const subjectBudget = Math.floor(limit / 2)

  for (const entry of sorted) {
    if (picked.size >= subjectBudget) break
    const subject = entry.subject?.trim().toLowerCase()
    if (subject && haystack.includes(subject)) picked.set(entry.id, entry)
  }

  for (const entry of sorted) {
    if (picked.size >= limit) break
    if (!picked.has(entry.id)) picked.set(entry.id, entry)
  }

  return [...picked.values()].sort(byNewest)
}

function byNewest(a: ArchiveIndexEntry, b: ArchiveIndexEntry): number {
  return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
}

export function buildMaintenancePrompt(params: {
  currentProfile: string
  summary: string
  existingMemoriesSummary: string
  /** How many memories the index below lists, when it is only a slice of the archive. */
  listedCount?: number
  formattedMessages: string
  budget: number
}): string {
  return (
    `You maintain the long-term memory of an AI agent. You are given the exchanges that were just archived from its conversation, and you update two stores.\n\n` +
    `**1. The PROFILE** — a small curated document, always present in the agent's context. It is what the agent *knows*: current state, standing preferences, active work.\n` +
    `**2. The ARCHIVE** — an unbounded, searchable store of individual memories. It is what *happened*: dated events, past details, one-off facts. The agent searches it on demand.\n\n` +
    `Decide where each piece of information goes with this test:\n` +
    `> ${BOUNDARY_TEST}\n\n` +
    `Moving something to the archive is filing, not forgetting: the agent can always find it again. So keep the profile small and let the archive be exhaustive.\n\n` +
    `## Output format\n\n` +
    `Return EXACTLY these two blocks, nothing else:\n\n` +
    `<archive>\n` +
    `[ {"action": "add", "content": "...", "category": "fact", "subject": "...", "importance": 5, "sourceContext": "..."} ]\n` +
    `</archive>\n\n` +
    `<profile>\n` +
    `## Pinned\n(...)\n\n## Active projects\n(...)\n` +
    `</profile>\n\n` +
    `### The archive block\n\n` +
    `A JSON array (use [] if there is nothing to add). Each object has:\n` +
    `- "action": "add" (new) | "update" (contradicts, supersedes, or enriches an existing memory)\n` +
    `- "content": a clear, standalone sentence\n` +
    `- "category": "fact" | "preference" | "decision" | "knowledge"\n` +
    `- "subject": the person or context concerned (name, project, or "general")\n` +
    `- "importance": 1-10 (1 = mundane, 5 = moderately useful, 10 = critical). Most should be 3-7.\n` +
    `- "sourceContext": 1-2 sentences of the conversational context it was mentioned in\n` +
    `- "updateIndex": for "update" only, the index [N] of the existing memory to update\n\n` +
    `DO archive: dated events and decisions with their reasoning, task outcomes, concrete details worth looking up later, identity facts, lasting preferences, meaningful experiences.\n` +
    `DO NOT archive: transient states (feeling sick today, traffic this morning), trivia with no follow-up implication, general knowledge the model already has.\n\n` +
    `### The profile block\n\n` +
    `The COMPLETE new document in markdown, replacing the current one. Rules:\n` +
    `- Carry forward everything still relevant. Integrate what is new and durable.\n` +
    `- Drop resolved threads and finished projects — their trace stays in the archive.\n` +
    `- Copy the "## Pinned" section VERBATIM if there is one. Never edit or drop a pinned entry.\n` +
    `- Suggested sections: Pinned, Active projects, Preferences & conventions, Key decisions, Open threads. Add others if useful.\n` +
    `- Use absolute dates ("decided on 2026-07-17"), never relative ones ("last week").\n` +
    `- Write in English. Stay under ${params.budget} tokens (roughly ${Math.round(params.budget * 3.5)} characters).\n` +
    `- If nothing durable changed, return the current profile unchanged.\n\n` +
    `## Current profile\n\n${params.currentProfile.trim() || '(empty — build it from what you learn here)'}\n\n` +
    `## Summary of the exchanges just archived\n\n${params.summary}\n\n` +
    (params.listedCount && params.listedCount > 0
      ? `## Existing archive memories (indexed)\n\nThese are the most relevant ${params.listedCount} of a larger archive, listed so you can target an "update". Anything absent here is not gone: treat it as unseen rather than missing, and prefer "add" when unsure.\n\n${params.existingMemoriesSummary}\n\n`
      : `## Existing archive memories (indexed)\n\n${params.existingMemoriesSummary}\n\n`) +
    `## Exchanges to analyze\n\n${params.formattedMessages}`
  )
}

// ─── Runner ──────────────────────────────────────────────────────────────────

async function addIfNotDuplicate(
  agentId: string,
  item: ArchiveItem,
  importance: number | null,
  lastMessageId: string,
): Promise<boolean> {
  if (await isDuplicateMemory(agentId, item.content)) return false

  await createMemory(agentId, {
    content: item.content,
    category: item.category as MemoryCategory,
    subject: item.subject || null,
    sourceContext: item.sourceContext || null,
    importance,
    sourceMessageId: lastMessageId,
    sourceChannel: 'automatic',
  })
  return true
}

/**
 * One LLM call per compaction that both extracts episodic memories and
 * rewrites the profile. Fusing them keeps the cost identical to the v1
 * extraction-only call and makes the two outputs consistent by construction.
 *
 * Never throws: memory maintenance must not fail a compaction.
 */
export async function runMemoryMaintenance(params: {
  agentId: string
  agentModel: string
  agentProviderId: string | null
  messagesToAnalyze: Array<{ id: string; content: string | null; role: string }>
  lastMessageId: string
  summary: string
}): Promise<{ memoriesExtracted: number; profileUpdated: boolean }> {
  const { agentId, agentModel, agentProviderId, messagesToAnalyze, lastMessageId, summary } = params
  const none = { memoriesExtracted: 0, profileUpdated: false }

  const { resolveLLM } = await import('@/server/llm/core/resolve')
  const settingsModel = await getExtractionModel()
  const settingsProviderId = await getExtractionProviderId()
  const effectiveModel = settingsModel ?? config.memory.extractionModel
  const providerId = settingsProviderId
    ?? config.memory.extractionProviderId
    ?? (effectiveModel ? null : agentProviderId)

  let resolved
  try {
    resolved = await resolveLLM({ modelId: effectiveModel ?? agentModel, providerId })
  } catch {
    return none
  }

  const allMemories = await db
    .select({ id: memories.id, content: memories.content, category: memories.category, subject: memories.subject, updatedAt: memories.updatedAt })
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .all()

  const formattedMessages = messagesToAnalyze
    .filter((m) => m.content)
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n\n')

  // `updateIndex` in the response indexes into THIS list, so it is the one
  // that must be applied later — never the full archive.
  const existingMemories = selectArchiveIndex(allMemories, formattedMessages)
  if (existingMemories.length < allMemories.length) {
    log.info(
      { agentId, listed: existingMemories.length, archiveTotal: allMemories.length },
      'Archive index truncated for the maintenance prompt',
    )
  }

  const existingMemoriesSummary =
    existingMemories.length > 0
      ? existingMemories
          .map((m, i) => `[${i}] [${m.category}] ${m.content}${m.subject ? ` (subject: ${m.subject})` : ''}`)
          .join('\n')
      : '(none)'

  const currentProfile = await getProfile(agentId)
  const budget = getProfileBudget()

  let text: string
  try {
    const result = await safeGenerateText({
      resolved,
      prompt: buildMaintenancePrompt({
        currentProfile: currentProfile.content,
        summary,
        existingMemoriesSummary,
        listedCount: existingMemories.length < allMemories.length ? existingMemories.length : undefined,
        formattedMessages,
        budget,
      }),
      // The profile rewrite is a whole document, so this needs more room than
      // the v1 extraction-only call (4000).
      maxTokens: 8000,
      // Hard timeout: this runs inside runCompacting, which holds the
      // per-Agent compacting lock. A stuck call would block the Agent's queue.
      timeoutMs: 3 * 60 * 1000,
      callSite: 'memory-maintenance',
      agentId,
    })
    text = result.text
  } catch (err) {
    log.error({ agentId, err }, 'Memory maintenance LLM error')
    return none
  }

  const { archive, profile } = parseMaintenanceResponse(text)

  let memoriesExtracted = 0
  for (const item of archive) {
    try {
      const importance = typeof item.importance === 'number'
        ? Math.max(1, Math.min(10, Math.round(item.importance)))
        : null

      if (item.action === 'update' && typeof item.updateIndex === 'number') {
        const target = existingMemories[item.updateIndex]
        if (target) {
          await updateMemory(target.id, agentId, {
            content: item.content,
            category: item.category as MemoryCategory,
            subject: item.subject || null,
            sourceContext: item.sourceContext || null,
            importance,
          })
          memoriesExtracted++
          continue
        }
        // Stale or hallucinated index — treat it as a new memory.
      }

      if (await addIfNotDuplicate(agentId, item, importance, lastMessageId)) memoriesExtracted++
    } catch (err) {
      log.warn({ agentId, err, content: item.content.slice(0, 80) }, 'Failed to apply an archive item')
    }
  }

  // A missing or empty profile block leaves the existing document untouched:
  // losing a curated profile to one bad generation is worse than a stale one.
  let profileUpdated = false
  if (profile) {
    try {
      const guarded = enforceBudget(enforcePinned(currentProfile.content, profile), budget)
      await setProfile(agentId, guarded, 'maintenance')
      profileUpdated = true
    } catch (err) {
      log.error({ agentId, err }, 'Failed to write the rewritten profile — keeping the previous one')
    }
  } else {
    log.debug({ agentId }, 'Maintenance returned no profile block — keeping the previous one')
  }

  log.info({ agentId, memoriesExtracted, profileUpdated }, 'Memory maintenance complete')
  return { memoriesExtracted, profileUpdated }
}
