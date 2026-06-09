import { db } from '@/server/db/index'
import { agents, messages, userProfiles, compactingSummaries, tasks } from '@/server/db/schema'
import { eq, and, isNull, desc, ne, asc } from 'drizzle-orm'
import { getFilesForMessages } from '@/server/services/files'
import { buildSystemPrompt, joinSystemPrompt } from '@/server/services/prompt-builder'
import { listActiveTriggerSummariesForAgent } from '@/server/services/account-triggers'
import { getRelevantMemories } from '@/server/services/memory'
import { listContactsForPrompt } from '@/server/services/contacts'
import { listAvailableAgents } from '@/server/services/inter-agent'
import { getMCPToolsSummary } from '@/server/services/mcp'
import { toolRegistry } from '@/server/tools/index'
import { getGlobalPrompt } from '@/server/services/app-settings'
import { fetchPreviousCronRuns } from '@/server/services/tasks'
import { fetchCronLearnings } from '@/server/services/cron-learnings'
import { getActiveChannelsForAgent } from '@/server/services/channels'
import type { AgentCompactingConfig, ContextTokenBreakdown } from '@/shared/types'
import { getModelContextWindow } from '@/shared/model-context-windows'
import { resolveTriggerTokens } from '@/server/services/compacting'
import { config } from '@/server/config'

interface MessageMetadataTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Split a system prompt by `## ` headers and return tokens per section.
 *  The piece before the first `## ` (typically the role + identity intro) is
 *  labeled "(intro)" so it stays visible. Headers preserve their text after
 *  the `## ` marker, trimmed at the first newline. */
function decomposeSystemPrompt(prompt: string): Array<{ heading: string; tokens: number }> {
  if (!prompt) return []
  const sections: Array<{ heading: string; tokens: number }> = []
  const parts = prompt.split(/\n## /)
  if (parts.length === 0) return sections
  const intro = parts[0] ?? ''
  if (intro.trim().length > 0) {
    sections.push({ heading: '(intro)', tokens: estimateTokens(intro) })
  }
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i] ?? ''
    const newlineIdx = block.indexOf('\n')
    const heading = (newlineIdx === -1 ? block : block.slice(0, newlineIdx)).trim()
    const body = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1)
    sections.push({ heading: heading || '(unnamed)', tokens: estimateTokens(`## ${heading}\n${body}`) })
  }
  return sections
}

/** Pull the most recent assistant turn that reported cache stats and compute
 *  the hit rate. Returns null when no recent turn has cache data. */
function buildLastTurnCache(
  agentId: string,
): ContextPreviewResult['lastTurnCache'] | undefined {
  const recentAssistant = db
    .select({ metadata: messages.metadata, createdAt: messages.createdAt })
    .from(messages)
    .where(and(
      eq(messages.agentId, agentId),
      eq(messages.role, 'assistant'),
      isNull(messages.taskId),
      isNull(messages.sessionId),
    ))
    .orderBy(desc(messages.createdAt))
    .limit(20)
    .all()
  for (const m of recentAssistant) {
    if (!m.metadata) continue
    let tokenUsage: MessageMetadataTokenUsage | undefined
    try {
      const meta = JSON.parse(m.metadata as string) as { tokenUsage?: MessageMetadataTokenUsage }
      tokenUsage = meta?.tokenUsage
    } catch { continue }
    if (!tokenUsage || tokenUsage.inputTokens == null) continue
    const inputTokens = tokenUsage.inputTokens ?? 0
    const cacheReadTokens = tokenUsage.cacheReadTokens ?? 0
    const cacheWriteTokens = tokenUsage.cacheWriteTokens ?? 0
    if (cacheReadTokens === 0 && cacheWriteTokens === 0) continue
    const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
    return {
      inputTokens,
      outputTokens: tokenUsage.outputTokens ?? 0,
      cacheReadTokens,
      cacheWriteTokens,
      freshInputTokens,
      hitRate: inputTokens > 0 ? Math.min(1, cacheReadTokens / inputTokens) : 0,
      turnAt: new Date(m.createdAt as unknown as number).toISOString(),
    }
  }
  return undefined
}

type ToolSource = 'native' | 'mcp' | 'custom'

/**
 * Infer the display provenance of a resolved tool from its stable name prefix.
 * The unified `resolveToolset()` merges all four sources into one map, so the
 * preview reconstructs the per-source badge from the canonical naming:
 *   `mcp_*`    → MCP server, `custom_*` → user-defined custom tool.
 * Native and plugin tools (the latter prefixed `plugin_`) both come from the
 * registry and share the 'native' badge here (the preview's local source type
 * predates the 4-way catalog split — plugin tools were always lumped in).
 */
function inferToolSource(name: string): ToolSource {
  if (name.startsWith('mcp_')) return 'mcp'
  if (name.startsWith('custom_')) return 'custom'
  return 'native'
}

function buildSourceMap(tools: Record<string, unknown>): Map<string, ToolSource> {
  const m = new Map<string, ToolSource>()
  for (const name of Object.keys(tools)) m.set(name, inferToolSource(name))
  return m
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> | null
  /** Estimated token cost of this tool's serialized JSON-Schema payload
   *  (name + description + parameters). Lets the viewer rank the heaviest
   *  tools and surface candidates for description trimming. */
  tokenEstimate?: number
  /** Provenance — native registry, MCP server, or user-defined custom tool.
   *  Surfaced as a colored badge in the viewer so the user can attribute
   *  cost to the right layer (e.g. "MCP overhead is 8k of the 24k tools"). */
  source?: ToolSource
}

interface MessagePreview {
  role: string
  content: string | null
  hasToolCalls: boolean
  /** Number of tool calls if assistant; 0 otherwise. Surfaced in the viewer
   *  so users can spot tool-heavy turns at a glance. */
  toolCallCount: number
  /** Token estimate of the toolCalls JSON alone (subset of tokenEstimate).
   *  Lets the UI split the per-message bar into content vs tool-call tokens —
   *  the dominant signal for "why is this message huge?". */
  toolCallsTokens: number
  /** Server-side estimate covering content + toolCalls JSON content. The
   *  tool calls JSON is intentionally NOT sent in the preview (it would
   *  bloat the response), but its tokens DO count toward the context size. */
  tokenEstimate: number
  createdAt: number | null
}

interface SummaryPreview {
  summary: string
  firstMessageAt: string
  lastMessageAt: string
  depth: number
  tokenEstimate: number
  messageCount: number
}

interface CronRunPreview {
  status: string
  result: string | null
  createdAt: string
  updatedAt: string
  durationSec: number
}

interface CronLearningPreview {
  id: string
  content: string
  category: string | null
  createdAt: string
}

interface ContextPreviewResult {
  /** System prompt with tools block appended (for structured/markdown view) */
  systemPrompt: string
  /** Raw compacting summary — combined text (null if no compacting has occurred) */
  compactingSummary: string | null
  /** Individual summaries with metadata for detailed display */
  summaries: SummaryPreview[]
  /** Previous cron run results (only for cron-spawned tasks) */
  cronRuns: CronRunPreview[]
  /** Accumulated cron learnings (only for cron-spawned tasks) */
  cronLearnings: CronLearningPreview[]
  /** Full raw payload as JSON (system + messages + tools) */
  rawPayload: {
    system: string
    messages: MessagePreview[]
    tools: ToolDefinition[]
  }
  /** Estimated token breakdown by section */
  tokenEstimate: {
    systemPrompt: number
    summary: number
    cronRuns: number
    cronLearnings: number
    messages: number
    tools: number
    total: number
  }
  /** Model's max context window in tokens */
  contextWindow: number
  /** Compacting threshold as % of context window (null for tasks / quick sessions) */
  compactingThresholdPercent: number | null
  messageCount: number
  generatedAt: number
  /** Section-by-section breakdown of the system prompt, parsed by `## `
   *  headers. Lets the viewer show users which prompt blocks (Memories,
   *  Constraints, Personality, Available tools…) eat the most tokens.
   *  The "(intro)" section captures everything before the first ## header. */
  systemPromptBreakdown?: Array<{ heading: string; tokens: number }>
  /** Cache hit/miss breakdown of the most recent assistant turn that reported
   *  cache stats. Null when no recent turn has tokenUsage with cache fields
   *  (cold Agent, non-Anthropic provider, etc.). Used by the context viewer to
   *  surface cache observability inline with the breakdown. */
  lastTurnCache?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    freshInputTokens: number
    hitRate: number
    /** ISO timestamp of the turn this snapshot is from. */
    turnAt: string
  }
}

/**
 * Estimate the additional tokens contributed by attached files on a message.
 * Mirrors the file-handling logic in agent-engine's estimateContextTokens so
 * the visualizer matches the live banner.
 */
function estimateMessageFilesTokens(
  attachedFiles: Array<{ mimeType: string; size: number }> | undefined,
): number {
  if (!attachedFiles || attachedFiles.length === 0) return 0
  let total = 0
  for (const f of attachedFiles) {
    if (f.mimeType?.startsWith('image/')) {
      // Same heuristic as the live banner: ~bytes/750 with a 1500 floor for
      // typical screenshots. Beats the prior flat 85.
      total += Math.max(1500, Math.round(f.size / 750))
    } else if (f.mimeType === 'application/pdf') {
      total += Math.max(500, Math.ceil(f.size / 3000) * 500)
    } else if (f.size > 0 && f.size <= 100_000) {
      // Small text-readable files get inlined: ~bytes/4 tokens.
      total += Math.ceil(f.size / 4)
    }
    // Larger binary files are mentioned by path only (negligible tokens).
  }
  return total
}

// Backed by gpt-tokenizer (BPE) — within ~5-15% of provider tokenizers,
// vastly more accurate than chars/4 on JSON / YAML / CLI output that
// dominates tool-heavy Agents.
import { countTokens as countTokensShared } from '@/shared/token-estimator'
function estimateTokens(text: string): number {
  return countTokensShared(text)
}

/** Read the per-Agent EMA-smoothed calibration factor written by recordApiContextSize.
 *  Lazy-import to avoid a circular dep with agent-engine. */
async function getAgentCalibrationFactor(agentId: string): Promise<number> {
  try {
    const { getLastContextUsage } = await import('@/server/services/agent-engine')
    const cached = await getLastContextUsage(agentId)
    return cached?.calibrationFactor ?? 1
  } catch {
    return 1
  }
}

/**
 * Safely extract a JSON Schema from a Zod schema (Zod v4 .toJSONSchema()).
 * Falls back to null if the method is unavailable.
 */
function safeToJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (schema && typeof schema === 'object' && 'toJSONSchema' in schema && typeof (schema as { toJSONSchema: unknown }).toJSONSchema === 'function') {
    try {
      return (schema as { toJSONSchema(): Record<string, unknown> }).toJSONSchema()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Build a context preview for an Agent — the system prompt as it would be
 * assembled right now, plus the list of available tools and message history.
 *
 * This mirrors the data-gathering logic in agent-engine.processAgentQueue()
 * but without queue-specific concerns (no queue item, no speaker profile,
 * no channel context).
 */
export async function buildContextPreview(agentId: string): Promise<ContextPreviewResult> {
  // Load the Agent
  const agent = db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!agent) throw new Error('Agent not found')

  // Contacts
  const contactsWithSlug = await listContactsForPrompt()

  // Agent directory
  const agentDirectory = (await listAvailableAgents(agentId)).map((k) => ({
    slug: k.slug,
    name: k.name,
    role: k.role,
  }))

  // Relevant memories — use the last user message as query, or fallback
  let relevantMemories: Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; updatedAt: Date | null; score: number }> = []
  try {
    const lastUserMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.agentId, agentId), eq(messages.role, 'user'), isNull(messages.taskId), isNull(messages.sessionId)))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    const query = lastUserMsg?.content ?? agent.name
    relevantMemories = await getRelevantMemories(agentId, query)
  } catch {
    // Non-fatal
  }

  // Knowledge
  let relevantKnowledge: Array<{ content: string; sourceId: string; score: number }> = []
  try {
    const { searchKnowledge } = await import('@/server/services/knowledge')
    const lastUserMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.agentId, agentId), eq(messages.role, 'user'), isNull(messages.taskId), isNull(messages.sessionId)))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    relevantKnowledge = await searchKnowledge(agentId, lastUserMsg?.content ?? agent.name, 5)
  } catch {
    // Non-fatal
  }

  // MCP tools summary for prompt
  const mcpToolsSummary = await getMCPToolsSummary(agentId)

  // Active channels
  const activeChannelRows = await getActiveChannelsForAgent(agentId)
  const activeChannels = activeChannelRows.map((ch) => ({ platform: ch.platform, name: ch.name }))

  // Global prompt
  const globalPrompt = await getGlobalPrompt()

  // Compacting summaries (from active in-context summaries)
  const activeSummaries = db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.agentId, agentId), eq(compactingSummaries.isInContext, true)))
    .orderBy(asc(compactingSummaries.lastMessageAt))
    .all()

  const compactingSummariesData = activeSummaries.length > 0
    ? activeSummaries.map((s) => ({
        summary: s.summary,
        firstMessageAt: new Date(s.firstMessageAt as unknown as number),
        lastMessageAt: new Date(s.lastMessageAt as unknown as number),
        depth: s.depth ?? 0,
      }))
    : null

  // Resolve cutoff timestamp from the latest summary
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null
  const cutoffTimestamp = latestSummary ? (latestSummary.lastMessageAt as unknown as number) : null

  // Fetch recent messages for history preview
  const recentMessages = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      toolCalls: messages.toolCalls,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(
      eq(messages.agentId, agentId),
      isNull(messages.taskId),
      isNull(messages.sessionId),
      ne(messages.sourceType, 'compacting'),
    ))
    .orderBy(desc(messages.createdAt))
    // Match the live banner's history fetch limit so token estimates agree.
    // The previous limit(100) caused the visualizer to under-count by
    // hundreds of thousands of tokens on Agents with long histories — the
    // actual API call (agent-engine.buildMessageHistory) loads up to
    // config.historyMaxMessages messages.
    .limit(config.historyMaxMessages)
    .all()

  recentMessages.reverse()

  // Filter to post-snapshot messages (mirrors buildMessageHistory logic)
  const visibleMessages = cutoffTimestamp
    ? recentMessages.filter((m) => m.createdAt && (m.createdAt as unknown as number) > cutoffTimestamp)
    : recentMessages

  // Pre-load attached files for all visible messages so we can count their
  // tokens (images, inlined text files, PDFs) — matches what agent-engine sends
  // to the API.
  const visibleIds = visibleMessages.map((m) => m.id ?? null).filter((id): id is string => !!id)
  const filesByMessageId = visibleIds.length > 0 ? await getFilesForMessages(visibleIds) : new Map()

  const messagesPreviews: MessagePreview[] = visibleMessages.map((m) => {
    const toolCallsRaw = (m.toolCalls as string | null) ?? ''
    const toolCallsTokens = estimateTokens(toolCallsRaw)
    let toolCallCount = 0
    if (toolCallsRaw) {
      try {
        const parsed = JSON.parse(toolCallsRaw)
        if (Array.isArray(parsed)) toolCallCount = parsed.length
      } catch { /* keep 0 */ }
    }
    return {
      role: m.role,
      content: m.content,
      hasToolCalls: m.toolCalls !== null,
      toolCallCount,
      toolCallsTokens,
      tokenEstimate:
        estimateTokens(m.content ?? '')
        + toolCallsTokens
        + estimateMessageFilesTokens(filesByMessageId.get(m.id ?? '')),
      createdAt: m.createdAt ? (m.createdAt as unknown as number) : null,
    }
  })

  // Message counts for conversation state
  const totalMessageCount = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.agentId, agentId), isNull(messages.taskId), isNull(messages.sessionId)))
    .all()
    .length

  const visibleMessageCount = visibleMessages.length
  const hasCompactedHistory = activeSummaries.length > 0

  // User language — get from first user profile as fallback
  let userLanguage: 'fr' | 'en' = 'fr'
  const firstProfile = db.select({ language: userProfiles.language }).from(userProfiles).limit(1).get()
  if (firstProfile) {
    userLanguage = firstProfile.language as 'fr' | 'en'
  }

  // Active project block — mirrors agent-engine.processAgentQueue so the preview
  // shows the exact prompt the Agent will receive (including pinned project
  // knowledge). Without it, the preview misleads users editing knowledge in
  // the UI because they wouldn't see their pins land in the prompt.
  let activeProject: import('@/server/services/prompt-builder').ActiveProjectPromptInfo | null = null
  if (agent.activeProjectId) {
    const { buildActiveProjectInfo } = await import('@/server/services/projects')
    activeProject = await buildActiveProjectInfo(agent.activeProjectId)
  }

  const accountTriggerSummaries = await listActiveTriggerSummariesForAgent(agentId)

  // Build system prompt
  const systemPrompt = joinSystemPrompt(buildSystemPrompt({
    agent: { name: agent.name, slug: agent.slug, role: agent.role, character: agent.character, expertise: agent.expertise, kind: agent.kind },
    contacts: contactsWithSlug,
    relevantMemories,
    relevantKnowledge,
    agentDirectory,
    mcpTools: mcpToolsSummary,
    isSubAgent: false,
    activeChannels: activeChannels.length > 0 ? activeChannels : undefined,
    accountTriggers: accountTriggerSummaries.length > 0 ? accountTriggerSummaries : undefined,
    globalPrompt,
    userLanguage,
    compactingSummaries: compactingSummariesData,
    conversationState: {
      visibleMessageCount,
      totalMessageCount,
      hasCompactedHistory,
    },
    workspacePath: agent.workspacePath,
    activeProject: activeProject ?? undefined,
  }))

  // Resolve tools — unified resolver (toolbox is the sole grant primitive
  // across native + plugin + MCP + custom). Mirrors processNextMessage.
  const { resolveToolset } = await import('@/server/services/toolset-resolver')
  const allTools = await resolveToolset({
    agentId,
    toolboxIds: agent.toolboxIds,
    isSubAgent: false,
  })
  const toolDefinitions = buildToolDefs(allTools, buildSourceMap(allTools))

  const combinedSummary = compactingSummariesData
    ? compactingSummariesData.map((s) => s.summary).join('\n\n---\n\n')
    : null

  const summaryPreviews: SummaryPreview[] = activeSummaries.map((s) => ({
    summary: s.summary,
    firstMessageAt: new Date(s.firstMessageAt as unknown as number).toISOString(),
    lastMessageAt: new Date(s.lastMessageAt as unknown as number).toISOString(),
    depth: s.depth ?? 0,
    tokenEstimate: s.tokenEstimate ?? estimateTokens(s.summary),
    messageCount: s.messageCount ?? 0,
  }))

  // Resolve compacting threshold for this Agent
  let perAgentCompacting: AgentCompactingConfig | null = null
  if (agent.compactingConfig) {
    try { perAgentCompacting = JSON.parse(agent.compactingConfig) as AgentCompactingConfig } catch { /* ignore */ }
  }
  // Effective (capped) threshold — the SAME source of truth as the navbar
  // (resolveTriggerTokens). Without the cap the visualizer showed the raw
  // per-Agent 95% while the navbar showed the capped 30%, telling opposite
  // stories about how close compaction is.
  const rawThresholdPercent = perAgentCompacting?.thresholdPercent ?? config.compacting.thresholdPercent
  const triggerMaxTokens = perAgentCompacting?.triggerMaxTokens ?? config.compacting.triggerMaxTokens
  const ctxWindowForThreshold = getModelContextWindow(agent.model)
  const compactingThresholdPercent = ctxWindowForThreshold > 0
    ? Math.round((resolveTriggerTokens(rawThresholdPercent, ctxWindowForThreshold, triggerMaxTokens) / ctxWindowForThreshold) * 100)
    : rawThresholdPercent

  const calibrationFactor = await getAgentCalibrationFactor(agentId)
  const lastTurnCache = buildLastTurnCache(agentId)

  // Compute section totals against the SAME masked/trimmed messageHistory that
  // the next API call will see. Without this, the visualizer counts raw
  // pre-trim DB content while the navbar counts post-trim, and the two bars
  // can diverge by 200k+ tokens on tool-heavy Agents (large tool results,
  // file-write args, page_state YAMLs all get masked or capped before being
  // sent). Then × calibrationFactor compounds the gap, since the EMA is
  // calibrated against the post-trim count.
  //
  // The cost is a second buildMessageHistory pass per dialog open (re-reads
  // attached files from disk). Acceptable for an explicit user action.
  const { buildMessageHistory, estimateContextTokens } = await import('@/server/services/agent-engine')
  let trimmedBreakdown: ContextTokenBreakdown | undefined
  try {
    const historyResult = await buildMessageHistory(agentId)
    const summaryTokensFromMasked = historyResult.compactingSummaries
      ? historyResult.compactingSummaries.reduce((sum, s) => sum + estimateTokens(s.summary), 0)
      : 0
    trimmedBreakdown = estimateContextTokens(
      systemPrompt,
      historyResult.messages,
      Object.keys(allTools).length > 0 ? allTools : undefined,
      summaryTokensFromMasked,
    )
  } catch {
    // Fall back to the legacy raw sum when the masked-history build fails for
    // any reason — better an over-count than a missing bar.
  }

  return formatResult(systemPrompt, toolDefinitions, messagesPreviews, totalMessageCount, getModelContextWindow(agent.model), combinedSummary, summaryPreviews, compactingThresholdPercent, [], [], calibrationFactor, lastTurnCache, trimmedBreakdown)
}

/** Extract JSON Schema tool definitions from a tools map */
function buildToolDefs(
  tools: Record<string, unknown>,
  sourceMap?: Map<string, ToolSource>,
): ToolDefinition[] {
  return Object.entries(tools).map(([name, t]) => {
    const toolObj = t as { description?: string; inputSchema?: unknown }
    const description = toolObj.description ?? ''
    const parameters = safeToJsonSchema(toolObj.inputSchema)
    const serialized = JSON.stringify({ name, description, parameters })
    return {
      name,
      description,
      parameters,
      tokenEstimate: estimateTokens(serialized),
      source: sourceMap?.get(name),
    }
  })
}

const CRON_RUNS_HEADER = '## Previous runs'
const CRON_LEARNINGS_HEADER = '## Learnings from previous runs'

/** Extract token count for a prompt section identified by its header */
function extractSectionTokens(systemPrompt: string, header: string): number {
  const idx = systemPrompt.indexOf(header)
  if (idx === -1) return 0
  const afterHeader = systemPrompt.indexOf('\n## ', idx + header.length)
  const section = afterHeader === -1
    ? systemPrompt.slice(idx)
    : systemPrompt.slice(idx, afterHeader)
  return estimateTokens(section)
}

/** Format a ContextPreviewResult from the assembled parts */
function formatResult(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  messagesPreviews: MessagePreview[],
  messageCount: number,
  contextWindow: number,
  compactingSummary: string | null = null,
  summaries: SummaryPreview[] = [],
  compactingThresholdPercent: number | null = null,
  cronRuns: CronRunPreview[] = [],
  cronLearnings: CronLearningPreview[] = [],
  /** Per-Agent EMA-smoothed factor learned from past API roundtrips (api / raw_BPE).
   *  When > 1 (typical: 1.3-1.6 for Anthropic on tool-heavy contexts), the
   *  visualizer's section totals + per-message estimates are scaled to match
   *  what the navbar shows after calibration. Defaults to 1 when no roundtrip
   *  has been observed yet. */
  calibrationFactor: number = 1,
  lastTurnCache?: ContextPreviewResult['lastTurnCache'],
  /** Section breakdown computed against the masked/trimmed messageHistory the
   *  agent-engine will actually send to the provider on the next turn. When
   *  provided, used as the source of truth for the visualizer's bars so they
   *  match the navbar (which is set via setLastContextUsage with the same
   *  estimator). Without it, the bars sum raw per-message DB content and
   *  over-count tool-heavy Agents by hundreds of thousands of tokens. */
  precomputedBreakdown?: ContextTokenBreakdown,
): ContextPreviewResult {
  let fullPrompt = systemPrompt
  if (toolDefinitions.length > 0) {
    const toolLines = toolDefinitions
      .map((t) => `- **${t.name}**: ${t.description || '(no description)'}`)
      .join('\n')
    fullPrompt += `\n\n## Available tools (${toolDefinitions.length})\n\n${toolLines}`
  }

  // Estimate tokens from dedicated prompt sections (cron blocks are split out
  // of the system prompt total so they get their own bar segment).
  const cronRunsTokens = extractSectionTokens(systemPrompt, CRON_RUNS_HEADER)
  const cronLearningsTokens = extractSectionTokens(systemPrompt, CRON_LEARNINGS_HEADER)

  let summaryTokens: number
  let systemPromptTokens: number
  let messagesTokens: number
  let toolsTokens: number
  let rawTotal: number
  if (precomputedBreakdown) {
    // Source of truth: estimateContextTokens against the masked/trimmed
    // messageHistory that agent-engine will send next turn. Matches the navbar.
    summaryTokens = precomputedBreakdown.summary ?? 0
    systemPromptTokens = Math.max(0, precomputedBreakdown.systemPrompt - cronRunsTokens - cronLearningsTokens)
    messagesTokens = precomputedBreakdown.messages
    toolsTokens = precomputedBreakdown.tools
    rawTotal = precomputedBreakdown.total
  } else {
    // Legacy fallback: sum raw per-message DB content. Used by task and
    // quick-session previews where the trimming pipeline doesn't apply.
    summaryTokens = compactingSummary ? estimateTokens(compactingSummary) : 0
    const rawSystemTokens = estimateTokens(systemPrompt)
    systemPromptTokens = Math.max(0, rawSystemTokens - summaryTokens - cronRunsTokens - cronLearningsTokens)
    messagesTokens = 0
    for (const m of messagesPreviews) {
      messagesTokens += m.tokenEstimate
    }
    toolsTokens = toolDefinitions.length > 0 ? estimateTokens(JSON.stringify(toolDefinitions)) : 0
    rawTotal = systemPromptTokens + summaryTokens + cronRunsTokens + cronLearningsTokens + messagesTokens + toolsTokens
  }

  // Apply calibration uniformly across sections + per-message estimates so
  // every number summed in this response matches the navbar's calibrated
  // "estimate" bar. Without this, the visualizer modal shows raw BPE counts
  // (under-counted by 30-60%) while the navbar shows calibrated values —
  // confusing the user about which one is "right".
  const scale = (n: number) => Math.round(n * calibrationFactor)
  const calibratedMessagesPreviews = calibrationFactor === 1
    ? messagesPreviews
    : messagesPreviews.map((m) => ({
        ...m,
        tokenEstimate: scale(m.tokenEstimate),
        toolCallsTokens: scale(m.toolCallsTokens),
      }))

  const calibratedToolDefinitions = calibrationFactor === 1
    ? toolDefinitions
    : toolDefinitions.map((td) => ({
        ...td,
        tokenEstimate: td.tokenEstimate != null ? scale(td.tokenEstimate) : undefined,
      }))

  return {
    systemPrompt: fullPrompt,
    compactingSummary,
    summaries,
    cronRuns,
    cronLearnings,
    rawPayload: {
      system: systemPrompt,
      messages: calibratedMessagesPreviews,
      tools: calibratedToolDefinitions,
    },
    tokenEstimate: {
      systemPrompt: scale(systemPromptTokens),
      summary: scale(summaryTokens),
      cronRuns: scale(cronRunsTokens),
      cronLearnings: scale(cronLearningsTokens),
      messages: scale(messagesTokens),
      tools: scale(toolsTokens),
      total: scale(rawTotal),
    },
    contextWindow,
    compactingThresholdPercent,
    messageCount,
    generatedAt: Date.now(),
    systemPromptBreakdown: decomposeSystemPrompt(systemPrompt).map((s) => ({
      heading: s.heading,
      tokens: scale(s.tokens),
    })),
    lastTurnCache,
  }
}

// ---------------------------------------------------------------------------
// Task (sub-agent) context preview
// Mirrors executeSubAgent() in tasks.ts
// ---------------------------------------------------------------------------

export async function buildTaskContextPreview(taskId: string): Promise<ContextPreviewResult> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) throw new Error('Task not found')

  const parentAgent = db.select().from(agents).where(eq(agents.id, task.parentAgentId)).get()
  if (!parentAgent) throw new Error('Parent Agent not found')

  // Determine identity (same logic as executeSubAgent)
  let agentIdentity = parentAgent
  if (task.spawnType === 'other' && task.sourceAgentId) {
    const sourceAgent = db.select().from(agents).where(eq(agents.id, task.sourceAgentId)).get()
    if (sourceAgent) agentIdentity = sourceAgent
  }

  // Mirror executeSubAgent: prefer the spawn-time prompt-context snapshot so the
  // visualizer renders exactly what the sub-Agent actually sees (frozen identity,
  // frozen globalPrompt, frozen agentDirectory, frozen cron context). Legacy
  // tasks without a snapshot fall back to live DB reads.
  let promptSnapshot: import('@/server/services/tasks').TaskPromptContextSnapshot | null = null
  if (task.promptContextSnapshot) {
    try {
      promptSnapshot = JSON.parse(task.promptContextSnapshot) as import('@/server/services/tasks').TaskPromptContextSnapshot
    } catch {
      // Corrupt snapshot — fall through to live reads
    }
  }
  if (promptSnapshot) {
    agentIdentity = { ...agentIdentity, ...promptSnapshot.agent }
  }

  const globalPrompt = promptSnapshot?.globalPrompt !== undefined
    ? promptSnapshot.globalPrompt
    : await getGlobalPrompt()

  const agentDirectory = (promptSnapshot?.agentDirectory ?? (await listAvailableAgents(agentIdentity.id))).map((k) => ({
    slug: k.slug,
    name: k.name,
    role: k.role,
  }))

  const previousCronRuns = task.cronId
    ? (promptSnapshot?.previousCronRuns
        ? promptSnapshot.previousCronRuns.map((r) => ({
            status: r.status,
            result: r.result,
            createdAt: new Date(r.createdAt),
            updatedAt: new Date(r.updatedAt),
          }))
        : await fetchPreviousCronRuns(task.cronId, 5))
    : undefined

  const cronLearningsData = task.cronId
    ? (promptSnapshot?.cronLearnings
        ? promptSnapshot.cronLearnings.map((l) => ({
            id: l.id,
            content: l.content,
            category: l.category,
            createdAt: new Date(l.createdAt),
          }))
        : fetchCronLearnings(task.cronId))
    : undefined

  // Ticket assignment context — mirror executeSubAgent: prefer the spawn-time
  // snapshot so the visualizer shows exactly what the sub-Agent is actually
  // seeing (frozen for cache stability), and fall back to a live fetch for
  // legacy ticket tasks without a snapshot.
  let ticketAssignment: import('@/server/services/prompt-builder').TicketAssignmentInfo | null = null
  if (task.ticketId) {
    if (task.ticketAssignmentSnapshot) {
      try {
        ticketAssignment = JSON.parse(task.ticketAssignmentSnapshot) as import('@/server/services/prompt-builder').TicketAssignmentInfo
      } catch {
        // Corrupt snapshot, fall through to live fetch
      }
    }
    if (!ticketAssignment) {
      const { buildTicketAssignmentInfo } = await import('@/server/services/tickets')
      ticketAssignment = await buildTicketAssignmentInfo(task.ticketId, {
        runPrompt: task.runPrompt ?? null,
        currentTaskId: task.id,
      })
    }
  }

  const systemPrompt = joinSystemPrompt(buildSystemPrompt({
    agent: { name: agentIdentity.name, slug: agentIdentity.slug, role: agentIdentity.role, character: agentIdentity.character, expertise: agentIdentity.expertise },
    contacts: [],
    relevantMemories: [],
    agentDirectory,
    isSubAgent: true,
    taskDescription: task.description,
    previousCronRuns,
    cronLearnings: cronLearningsData,
    globalPrompt,
    userLanguage: 'en',
    workspacePath: agentIdentity.workspacePath,
    ticketAssignment: ticketAssignment ?? undefined,
  }))

  // Messages: only this task's messages
  const taskMessages = db
    .select({ id: messages.id, role: messages.role, content: messages.content, toolCalls: messages.toolCalls, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.agentId, task.parentAgentId), eq(messages.taskId, taskId)))
    .orderBy(asc(messages.createdAt))
    .all()

  const taskMsgIds = taskMessages.map((m) => m.id ?? null).filter((id): id is string => !!id)
  const taskFilesByMessageId = taskMsgIds.length > 0 ? await getFilesForMessages(taskMsgIds) : new Map()

  const messagesPreviews: MessagePreview[] = taskMessages.map((m) => {
    const toolCallsRaw = (m.toolCalls as string | null) ?? ''
    const toolCallsTokens = estimateTokens(toolCallsRaw)
    let toolCallCount = 0
    if (toolCallsRaw) {
      try {
        const parsed = JSON.parse(toolCallsRaw)
        if (Array.isArray(parsed)) toolCallCount = parsed.length
      } catch { /* keep 0 */ }
    }
    return {
      role: m.role,
      content: m.content,
      hasToolCalls: m.toolCalls !== null,
      toolCallCount,
      toolCallsTokens,
      tokenEstimate:
        estimateTokens(m.content ?? '')
        + toolCallsTokens
        + estimateMessageFilesTokens(taskFilesByMessageId.get(m.id ?? '')),
      createdAt: m.createdAt ? (m.createdAt as unknown as number) : null,
    }
  })

  // Tools: same resolution as executeSubAgent. Unified resolver gives the spawned
  // Agent's MAIN surface (isSubAgent:false) intersected with the task's toolboxes;
  // we subtract the hard sub-Agent floor AFTER the allow-list, then layer on the
  // sub-Agent-only comms tools (infrastructure, never toolbox-gated). Toolbox ids
  // resolve from the task row (explicit toolbox_ids → legacy tool_preset →
  // default).
  const { resolveTaskToolboxIds, HARD_EXCLUDED_FROM_SUBKIN } = await import('@/server/services/tasks')
  const { resolveToolset } = await import('@/server/services/toolset-resolver')
  const taskToolboxIds = await resolveTaskToolboxIds({
    toolboxIds: task.toolboxIds as string | null,
    toolPreset: task.toolPreset as string | null,
    ticketId: task.ticketId ?? null,
  })
  const mainSurface = await resolveToolset({
    agentId: agentIdentity.id,
    toolboxIds: taskToolboxIds,
    isSubAgent: false,
    taskId,
    taskDepth: task.depth,
  })
  for (const name of HARD_EXCLUDED_FROM_SUBKIN) {
    delete mainSurface[name]
  }

  const subAgentTools = toolRegistry.resolve({ agentId: task.parentAgentId, taskId, taskDepth: task.depth, isSubAgent: true })
  // Mirror executeSubAgent: ticket sub-Agents drop report_to_parent (the parent has
  // nothing actionable to do with intermediate reports — the user reads the UI).
  if (task.ticketId) {
    delete subAgentTools['report_to_parent']
  }
  const allTools = { ...mainSurface, ...subAgentTools }
  const taskSourceMap = buildSourceMap(allTools)

  // Build cron run previews
  const cronRunPreviews: CronRunPreview[] = previousCronRuns
    ? previousCronRuns.map((r) => ({
        status: r.status,
        result: r.result,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        durationSec: Math.round((r.updatedAt.getTime() - r.createdAt.getTime()) / 1000),
      }))
    : []

  // Build cron learning previews
  const cronLearningPreviews: CronLearningPreview[] = cronLearningsData
    ? cronLearningsData.map((l) => ({
        id: l.id,
        content: l.content,
        category: l.category,
        createdAt: l.createdAt.toISOString(),
      }))
    : []

  const modelId = task.model ?? agentIdentity.model
  // Tasks share the parent Agent's calibration factor — same model, same content
  // profile (tools, files, structured outputs).
  const calibrationFactor = await getAgentCalibrationFactor(parentAgent.id)
  return formatResult(systemPrompt, buildToolDefs(allTools, taskSourceMap), messagesPreviews, taskMessages.length, getModelContextWindow(modelId), null, [], null, cronRunPreviews, cronLearningPreviews, calibrationFactor)
}

// ---------------------------------------------------------------------------
// Quick session context preview
// Mirrors processQuickMessage() in agent-engine.ts
// ---------------------------------------------------------------------------

const QUICK_SESSION_EXCLUDED_TOOLS = new Set([
  'spawn_self', 'spawn_agent', 'respond_to_task', 'cancel_task', 'list_tasks',
  'report_to_parent', 'update_task_status', 'request_input',
  'send_message', 'reply', 'list_kins',
  'create_cron', 'update_cron', 'delete_cron', 'list_crons', 'get_cron_journal',
  'add_mcp_server', 'update_mcp_server', 'remove_mcp_server', 'list_mcp_servers',
  'create_custom_tool', 'write_custom_tool_file', 'run_custom_tool_setup', 'test_custom_tool',
  'update_custom_tool', 'delete_custom_tool', 'list_custom_tools',
  'create_tool_domain', 'update_tool_domain', 'delete_tool_domain',
  'create_agent', 'update_agent', 'delete_agent', 'get_agent_details',
  'create_webhook', 'update_webhook', 'delete_webhook', 'list_webhooks',
  'send_channel_message', 'list_channel_conversations',
  'get_platform_logs',
  'memorize', 'update_memory', 'forget',
])

export async function buildQuickSessionContextPreview(agentId: string, sessionId: string): Promise<ContextPreviewResult> {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) throw new Error('Agent not found')

  // User language
  let userLanguage: 'fr' | 'en' = 'fr'
  const firstProfile = db.select({ language: userProfiles.language }).from(userProfiles).limit(1).get()
  if (firstProfile) userLanguage = firstProfile.language as 'fr' | 'en'

  // Memories (use last session message as query)
  let relevantMemories: Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; updatedAt: Date | null; score: number }> = []
  try {
    const lastMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    if (lastMsg?.content) relevantMemories = await getRelevantMemories(agentId, lastMsg.content)
  } catch {
    // Non-fatal
  }

  // Knowledge
  let relevantKnowledge: Array<{ content: string; sourceId: string; score: number }> = []
  try {
    const { searchKnowledge } = await import('@/server/services/knowledge')
    const lastMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    if (lastMsg?.content) relevantKnowledge = await searchKnowledge(agentId, lastMsg.content, 5)
  } catch {
    // Non-fatal
  }

  const globalPrompt = await getGlobalPrompt()

  // Mirror agent-engine's quick-session path: include the active project block
  // (with pinned knowledge) so the preview matches the real prompt.
  let quickSessionActiveProject: import('@/server/services/prompt-builder').ActiveProjectPromptInfo | null = null
  if (agent.activeProjectId) {
    const { buildActiveProjectInfo } = await import('@/server/services/projects')
    quickSessionActiveProject = await buildActiveProjectInfo(agent.activeProjectId)
  }

  const systemPrompt = joinSystemPrompt(buildSystemPrompt({
    agent: { name: agent.name, slug: agent.slug, role: agent.role, character: agent.character, expertise: agent.expertise, kind: agent.kind },
    contacts: [],
    relevantMemories,
    relevantKnowledge,
    agentDirectory: [],
    isSubAgent: false,
    isQuickSession: true,
    globalPrompt,
    userLanguage,
    workspacePath: agent.workspacePath,
    activeProject: quickSessionActiveProject ?? undefined,
  }))

  // Messages: only this session
  const sessionMessages = db
    .select({ id: messages.id, role: messages.role, content: messages.content, toolCalls: messages.toolCalls, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
    .all()

  const sessionMsgIds = sessionMessages.map((m) => m.id ?? null).filter((id): id is string => !!id)
  const sessionFilesByMessageId = sessionMsgIds.length > 0 ? await getFilesForMessages(sessionMsgIds) : new Map()

  const messagesPreviews: MessagePreview[] = sessionMessages.map((m) => {
    const toolCallsRaw = (m.toolCalls as string | null) ?? ''
    const toolCallsTokens = estimateTokens(toolCallsRaw)
    let toolCallCount = 0
    if (toolCallsRaw) {
      try {
        const parsed = JSON.parse(toolCallsRaw)
        if (Array.isArray(parsed)) toolCallCount = parsed.length
      } catch { /* keep 0 */ }
    }
    return {
      role: m.role,
      content: m.content,
      hasToolCalls: m.toolCalls !== null,
      toolCallCount,
      toolCallsTokens,
      tokenEstimate:
        estimateTokens(m.content ?? '')
        + toolCallsTokens
        + estimateMessageFilesTokens(sessionFilesByMessageId.get(m.id ?? '')),
      createdAt: m.createdAt ? (m.createdAt as unknown as number) : null,
    }
  })

  // Tools: same resolution as processQuickMessage. Unified resolver then the
  // quick-session exclusion list applied on top.
  const { resolveToolset } = await import('@/server/services/toolset-resolver')
  const allTools = await resolveToolset({
    agentId,
    toolboxIds: agent.toolboxIds,
    isSubAgent: false,
    quick: true,
  })
  for (const name of QUICK_SESSION_EXCLUDED_TOOLS) {
    delete allTools[name]
  }
  const qsSourceMap = buildSourceMap(allTools)

  // Quick session shares the Agent's calibration factor — same model, same tools.
  const calibrationFactor = await getAgentCalibrationFactor(agentId)
  return formatResult(systemPrompt, buildToolDefs(allTools, qsSourceMap), messagesPreviews, sessionMessages.length, getModelContextWindow(agent.model), null, [], null, [], [], calibrationFactor)
}
