import { eq, desc } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { agents, memories, agentProfiles } from '@/server/db/schema'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { safeGenerateText } from '@/server/services/llm-helpers'
import { getExtractionModel, getExtractionProviderId, getSetting, setSetting } from '@/server/services/app-settings'
import { setProfile, getProfile, getProfileBudget } from '@/server/services/agent-profile'
import { enforcePinned, enforceBudget, BOUNDARY_TEST } from '@/server/services/memory-maintenance'

const log = createLogger('agent-profile-bootstrap')

const BOOTSTRAP_FLAG = 'memory_profile_bootstrap_done'

/** Cap on how many archive memories are fed to one compile call. */
const MAX_MEMORIES_PER_COMPILE = 300

export function buildCompilePrompt(params: {
  agentName: string
  agentRole: string
  memoriesList: string
  currentProfile: string
  budget: number
}): string {
  return (
    `You are building the memory profile of an AI agent named ${params.agentName} (${params.agentRole}).\n\n` +
    `The profile is a small curated document that will be present in the agent's context on EVERY turn. ` +
    `It holds what the agent *knows*: current state, standing preferences, active work.\n\n` +
    `Below is the agent's existing memory archive, accumulated over time. The archive stays searchable, ` +
    `so you do NOT need to reproduce it. Compile from it only what passes this test:\n` +
    `> ${BOUNDARY_TEST}\n\n` +
    `## Rules\n` +
    `- Output ONLY the markdown document, no preamble and no code fence.\n` +
    `- Suggested sections: Pinned, Active projects, Preferences & conventions, Key decisions, Open threads.\n` +
    `- Merge related memories into single clear entries rather than listing them one by one.\n` +
    `- Skip anything that reads as finished, superseded, or purely episodic — it stays in the archive.\n` +
    `- Use absolute dates ("decided on 2026-07-17"), never relative ones.\n` +
    `- Write in English. Stay under ${params.budget} tokens.\n` +
    (params.currentProfile.trim()
      ? `- Preserve everything already in the current profile below, especially "## Pinned".\n\n## Current profile\n\n${params.currentProfile}\n`
      : '') +
    `\n## Memory archive\n\n${params.memoriesList}`
  )
}

/**
 * Compile one Agent's existing archive into an initial profile document.
 * Returns false when nothing was written (no memories, or the LLM call failed).
 */
export async function compileProfileFromArchive(agentId: string): Promise<boolean> {
  const agent = await db
    .select({ name: agents.name, role: agents.role, model: agents.model, providerId: agents.providerId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!agent) return false

  const rows = await db
    .select({
      content: memories.content,
      category: memories.category,
      subject: memories.subject,
      importance: memories.importance,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .where(eq(memories.agentId, agentId))
    .orderBy(desc(memories.updatedAt))
    .limit(MAX_MEMORIES_PER_COMPILE)
    .all()

  if (rows.length === 0) return false

  const memoriesList = rows
    .map((m) => {
      const date = m.updatedAt ? m.updatedAt.toISOString().slice(0, 10) : 'undated'
      return `- [${m.category}]${m.subject ? ` (${m.subject})` : ''} ${m.content} — last updated ${date}`
    })
    .join('\n')

  const { resolveLLM } = await import('@/server/llm/core/resolve')
  const settingsModel = await getExtractionModel()
  const settingsProviderId = await getExtractionProviderId()
  const effectiveModel = settingsModel ?? config.memory.extractionModel
  const providerId = settingsProviderId
    ?? config.memory.extractionProviderId
    ?? (effectiveModel ? null : agent.providerId)

  let resolved
  try {
    resolved = await resolveLLM({ modelId: effectiveModel ?? agent.model, providerId })
  } catch (err) {
    log.warn({ agentId, err }, 'Cannot resolve a model to compile the profile')
    return false
  }

  const current = await getProfile(agentId)
  const budget = getProfileBudget()

  let text: string
  try {
    const result = await safeGenerateText({
      resolved,
      prompt: buildCompilePrompt({
        agentName: agent.name,
        agentRole: agent.role,
        memoriesList,
        currentProfile: current.content,
        budget,
      }),
      maxTokens: 8000,
      timeoutMs: 3 * 60 * 1000,
      callSite: 'memory-maintenance',
      agentId,
    })
    text = result.text
  } catch (err) {
    log.warn({ agentId, err }, 'Profile compile LLM call failed')
    return false
  }

  const compiled = text.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim()
  if (!compiled) return false

  await setProfile(agentId, enforceBudget(enforcePinned(current.content, compiled), budget), 'regenerate')
  log.info({ agentId, memoriesUsed: rows.length }, 'Profile compiled from archive')
  return true
}

/**
 * One-shot migration: give every Agent that already has memories an initial
 * profile, so memory v2 does not start blank on an existing install.
 *
 * The flag is only set once every Agent either succeeded or had nothing to
 * compile, so a provider outage at boot means a retry next start rather than a
 * permanently empty profile. Runs in the background: it must never delay boot.
 */
export async function bootstrapProfiles(): Promise<void> {
  if (await getSetting(BOOTSTRAP_FLAG)) return

  const rows = await db.select({ id: agents.id }).from(agents).all()
  const existing = await db.select({ agentId: agentProfiles.agentId }).from(agentProfiles).all()
  const haveProfile = new Set(existing.map((p) => p.agentId))

  let compiled = 0
  let skipped = 0
  let failed = 0

  for (const agent of rows) {
    if (haveProfile.has(agent.id)) {
      skipped++
      continue
    }
    try {
      const ok = await compileProfileFromArchive(agent.id)
      if (ok) compiled++
      else skipped++ // no memories to compile from
    } catch (err) {
      failed++
      log.warn({ agentId: agent.id, err }, 'Profile bootstrap failed for this Agent')
    }
  }

  if (failed === 0) {
    await setSetting(BOOTSTRAP_FLAG, String(Date.now()))
  }

  log.info({ compiled, skipped, failed, retryNextBoot: failed > 0 }, 'Memory profile bootstrap complete')
}
