import { Hono } from 'hono'
import { eq, and, desc, isNull, ne, inArray, sql } from 'drizzle-orm'
import { mkdirSync, existsSync } from 'fs'
import { db } from '@/server/db/index'
import { agents, agentMcpServers, mcpServers, queueItems, compactingSummaries, memories, messages, providers, tasks } from '@/server/db/schema'
import { config } from '@/server/config'
import {
  generateAvatarImage,
  buildAvatarPrompt,
  isImg2imgEnabled,
  ImageGenerationError,
  findLLMProvider,
  resolveImageTarget,
  getMaxImageInputs,
  getBaseAvatarBytes,
  hasCustomBaseAvatar,
} from '@/server/services/image-generation'
import { DEFAULT_AVATAR_STYLE, DEFAULT_AVATAR_SUBJECT, AGENT_LANGUAGE_NAMES, THINKING_EFFORTS } from '@/shared/constants'
import { loadProviderConfig } from '@/server/services/provider-config'
import { deleteMemory, createMemory, updateMemory } from '@/server/services/memory'
import type { AgentThinkingConfig, AgentThinkingEffort, MemoryCategory, MemoryScope } from '@/shared/types'
import { sseManager } from '@/server/sse/index'
import { resolveAgentByIdOrSlug } from '@/server/services/agent-resolver'
import {
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentDetails,
} from '@/server/services/agents'
import { markAgentAsRead } from '@/server/services/agent-read-state'
import { agentAvatarUrl, validateAgentFields } from '@/server/services/field-validator'
import {
  getDefaultLlmModel,
  getDefaultLlmProviderId,
  getAvatarStylePrompt,
  getAvatarSubject,
  isAvatarBaseEnabled,
} from '@/server/services/app-settings'
import { listModelsForProvider } from '@/server/providers/index'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'
import { recordUsage } from '@/server/services/token-usage'
import { getLastContextUsage, compactingAgents, resolveThinkingConfig } from '@/server/services/agent-engine'
import { getModelContextWindow } from '@/shared/model-context-windows'

const log = createLogger('routes:agents')
const agentRoutes = new Hono<{ Variables: AppVariables }>()

/**
 * Parse the stored `agents.toolbox_ids` JSON column into a clean array (or null
 * when unset). Returned to the client as `toolboxIds: string[] | null`; null
 * means the Agent defaults to the 'all' built-in at resolution time.
 */
function parseToolboxIds(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const ids = parsed.filter((x): x is string => typeof x === 'string')
      return ids.length > 0 ? ids : null
    }
  } catch {
    // Malformed — treat as unset.
  }
  return null
}

/**
 * Normalize an incoming `toolboxIds` body field into the service's
 * `string[] | null | undefined` contract. `undefined` (field absent) → no
 * change; anything else → an array of string ids (empty array allowed, which
 * the service stores as null → 'all' default).
 */
function normalizeToolboxIdsInput(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
  return undefined
}

// GET /api/agents — list all agents
agentRoutes.get('/', async (c) => {
  const [allAgents, allQueueItems] = await Promise.all([
    db.select().from(agents).all(),
    db.select({ agentId: queueItems.agentId, status: queueItems.status, createdAt: queueItems.createdAt }).from(queueItems).all(),
  ])

  // Build per-agent queue state from all queue items
  const queueStateMap = new Map<string, { isProcessing: boolean; queueSize: number; processingStartedAt?: number }>()
  for (const item of allQueueItems) {
    const state = queueStateMap.get(item.agentId) ?? { isProcessing: false, queueSize: 0 }
    if (item.status === 'processing') {
      state.isProcessing = true
      // Use the queue item's createdAt as a proxy for when processing started
      state.processingStartedAt = item.createdAt instanceof Date ? item.createdAt.getTime() : Number(item.createdAt)
    }
    if (item.status === 'pending') state.queueSize++
    queueStateMap.set(item.agentId, state)
  }

  return c.json({
    agents: allAgents.map((k) => {
      const qs = queueStateMap.get(k.id)
      return {
        id: k.id,
        slug: k.slug,
        name: k.name,
        role: k.role,
        kind: k.kind,
        avatarUrl: agentAvatarUrl(k.id, k.avatarPath, k.updatedAt),
        model: k.model,
        providerId: k.providerId ?? null,
        activeProjectId: k.activeProjectId ?? null,
        createdAt: k.createdAt,
        thinkingEnabled: resolveThinkingConfig(k.thinkingConfig).enabled === true,
        thinkingEffort: resolveThinkingConfig(k.thinkingConfig).effort ?? null,
        isProcessing: qs?.isProcessing ?? false,
        queueSize: qs?.queueSize ?? 0,
        processingStartedAt: qs?.processingStartedAt ?? undefined,
      }
    }),
  })
})

// ─── Wizard: AI-assisted Agent configuration ─────────────────────────────────
// These routes MUST be registered before /:id to avoid being caught by the wildcard

// POST /api/agents/generate-config — generate Agent configuration from natural language
agentRoutes.post('/generate-config', async (c) => {
  const body = await c.req.json()
  const { description, refinement, currentConfig, language, model, providerId } = body as {
    description?: string
    refinement?: string
    currentConfig?: Record<string, unknown>
    language?: string
    /** Model used to GENERATE the config (chosen in the wizard). Distinct from
     *  the model the generated Agent will run on. Omitted → platform default. */
    model?: string
    providerId?: string | null
  }

  if (!description && !refinement) {
    return c.json(
      { error: { code: 'INVALID_REQUEST', message: 'Either description or refinement is required' } },
      400,
    )
  }

  // Find a fast LLM provider (same pattern as buildAvatarPrompt)
  const llmProvider = await findLLMProvider()
  if (!llmProvider) {
    return c.json(
      { error: { code: 'NO_LLM_PROVIDER', message: 'No LLM provider configured' } },
      422,
    )
  }

  const { pickAnyLLMModel, resolveLLM } = await import('@/server/llm/core/resolve')
  const { runOneShot } = await import('@/server/llm/core/run-oneshot')

  // Honour the model explicitly picked in the wizard; otherwise fall back to
  // the platform default (pickAnyLLMModel prefers the configured default LLM).
  let resolved
  try {
    resolved = model
      ? await resolveLLM({ modelId: model, providerId: providerId ?? null })
      : await pickAnyLLMModel()
  } catch (err) {
    return c.json(
      { error: { code: 'NO_LLM_MODEL', message: err instanceof Error ? err.message : 'Requested model is not available' } },
      422,
    )
  }
  if (!resolved) {
    return c.json(
      { error: { code: 'NO_LLM_MODEL', message: 'No LLM model available for the configured provider' } },
      422,
    )
  }

  // Collect available LLM model IDs for the suggestion. Skip rows that
  // don't declare LLM in their capabilities array — saves an API call.
  const allProviders = await db.select().from(providers).all()
  const availableModels: string[] = []
  for (const p of allProviders) {
    if (!p.isValid) continue
    const caps = JSON.parse(p.capabilities) as string[]
    if (!caps.includes('llm')) continue
    try {
      const pConfig = await loadProviderConfig(p)
      const pModels = await listModelsForProvider(p.type, pConfig, 'llm')
      for (const m of pModels) {
        if (m.capability === 'llm' && !availableModels.includes(m.id)) {
          availableModels.push(m.id)
        }
      }
    } catch {
      // Skip provider on error
    }
  }

  const lang = AGENT_LANGUAGE_NAMES[language ?? ''] ?? 'English'

  const systemPrompt = `You are a configuration generator for an AI assistant platform called Hivekeep. A "Agent" is a specialized AI assistant with a unique identity, personality, and expertise.

Given a user's description of the assistant they want, generate a complete Agent configuration as JSON.

## Fields to generate

- **name**: A short, memorable name for the Agent (1-3 words). Creative but professional.
- **role**: A concise role description (5-15 words) that summarizes the Agent's purpose.
- **character**: A detailed personality description (markdown, 3-5 paragraphs). Defines the tone, communication style, behavior, and values. Use "Tu" (informal) if French, "You" if English. Should feel like a real personality, not generic.
- **expertise**: A detailed knowledge description (markdown, 3-5 paragraphs with bullet lists). Defines specific knowledge domains, methodologies, and objectives. Be concrete and specific to the domain.
- **suggestedModel**: One of the available model IDs. Pick the most capable model for the task (prefer Claude or GPT-4 class for complex domains, lighter models for simple assistants).

## Available LLM models
${availableModels.join(', ')}

## Rules
- Generate ALL content in ${lang}
- Output ONLY valid JSON, nothing else — no markdown fences, no comments
- The character and expertise fields should be rich, specific, and tailored to the domain
- Do not include generic filler — every sentence should be relevant to the specific domain

## Output JSON schema
{
  "name": "string",
  "role": "string",
  "character": "string (markdown)",
  "expertise": "string (markdown)",
  "suggestedModel": "string (model ID)"
}`

  let userPrompt: string
  if (refinement && currentConfig) {
    userPrompt = `Current configuration:
${JSON.stringify(currentConfig, null, 2)}

Refinement request: ${refinement}

Update the configuration based on the refinement request. Keep fields that don't need changing. Output the full updated configuration as JSON.`
  } else {
    userPrompt = `User description: ${description}

Generate the complete Agent configuration as JSON.`
  }

  try {
    const result = await runOneShot(resolved, {
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    })

    recordUsage({
      callSite: 'agent-generate',
      callType: 'generate-text',
      providerType: resolved.providerRow.type,
      providerId: resolved.providerRow.id,
      modelId: resolved.model.id,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        inputTokenDetails: { cacheReadTokens: result.usage.cacheReadTokens, cacheWriteTokens: result.usage.cacheWriteTokens },
        outputTokenDetails: { reasoningTokens: result.usage.reasoningTokens },
      },
    })

    // Parse JSON from response (handle potential markdown fences)
    let jsonText = result.text.trim()
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenceMatch?.[1]) {
      jsonText = fenceMatch[1].trim()
    }

    const generatedConfig = JSON.parse(jsonText)

    return c.json({ config: generatedConfig })
  } catch (err) {
    log.error({ err }, 'Failed to generate Agent configuration')
    const message = err instanceof Error ? err.message : 'Configuration generation failed'
    return c.json(
      { error: { code: 'GENERATION_FAILED', message } },
      502,
    )
  }
})

// POST /api/agents/avatar/preview — generate avatar preview without a agentId (for wizard)
agentRoutes.post('/avatar/preview', async (c) => {
  const body = await c.req.json()
  const { name, role, character, expertise, imageProviderId, imageModel } = body as {
    name: string
    role: string
    character?: string
    expertise?: string
    imageProviderId?: string
    imageModel?: string
  }

  if (!name || !role) {
    return c.json(
      { error: { code: 'INVALID_REQUEST', message: 'Name and role are required' } },
      400,
    )
  }

  try {
    const target = await resolveImageTarget({ providerId: imageProviderId, modelId: imageModel })
    const maxImageInputs = await getMaxImageInputs(target.providerId, target.modelId)
    const supportsEdit = maxImageInputs > 0 && (await isImg2imgEnabled())

    const prompt = await buildAvatarPrompt(
      {
        name,
        role,
        character: character ?? '',
        expertise: expertise ?? '',
      },
      supportsEdit ? 'edit' : 'generate',
      { targetModelId: target.modelId, maxImageInputs },
    )

    const result = await generateAvatarImage(prompt, {
      providerId: target.providerId,
      modelId: target.modelId,
      ...(supportsEdit ? { imageDatas: [await getBaseAvatarBytes()] } : {}),
    })

    return c.json({
      base64: result.base64,
      mediaType: result.mediaType,
    })
  } catch (err) {
    if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
      return c.json(
        { error: { code: 'NO_IMAGE_PROVIDER', message: err.message } },
        422,
      )
    }
    const message = err instanceof Error ? err.message : 'Avatar generation failed'
    return c.json(
      { error: { code: 'AVATAR_GENERATION_FAILED', message } },
      502,
    )
  }
})

// GET /api/agents/avatar-config — read-only effective avatar axes (style A,
// subject B) + base reference state. Non-admin (any user creating an Agent needs
// the pre-fills in the avatar modal); writing the global config stays admin-only
// under /api/settings.
agentRoutes.get('/avatar-config', async (c) => {
  const [style, subject, baseEnabled, hasCustomBase] = await Promise.all([
    getAvatarStylePrompt(),
    getAvatarSubject(),
    isAvatarBaseEnabled(),
    hasCustomBaseAvatar(),
  ])
  return c.json({
    // Effective values (empty stored value → the built-in default), so the
    // modal/settings can pre-fill and highlight the matching preset directly.
    style: style?.trim() || DEFAULT_AVATAR_STYLE,
    subject: subject?.trim() || DEFAULT_AVATAR_SUBJECT,
    baseEnabled,
    hasCustomBase,
  })
})

// GET /api/agents/avatar-base/image — serve the current img2img base reference
// (custom upload/generation if present, else the bundled default). Non-admin so
// the avatar modal preview works for every user. Append ?v=… to bust the cache
// after a change.
agentRoutes.get('/avatar-base/image', async (c) => {
  try {
    const bytes = await getBaseAvatarBytes()
    // Sniff the container so the <img> gets a correct content-type.
    let mediaType = 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) mediaType = 'image/jpeg'
    else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) mediaType = 'image/webp'
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mediaType,
        'Cache-Control': 'no-cache',
      },
    })
  } catch {
    return c.json({ error: { code: 'BASE_AVATAR_MISSING', message: 'Base avatar not available' } }, 404)
  }
})

// GET /api/agents/:id/context-usage — context token estimation
// Returns cached values from the last LLM call when available (accurate),
// falls back to a rough estimation for agents that haven't processed a message yet.
agentRoutes.get('/:id/context-usage', async (c) => {
  const agent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!agent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  // Compute compacting proximity (always fresh)
  const { getCompactingProximity } = await import('@/server/services/compacting')
  const compacting = await getCompactingProximity(agent.id)

  // Use cached context usage from the last LLM call if available
  const cached = await getLastContextUsage(agent.id)
  if (cached) {
    return c.json({
      contextTokens: cached.contextTokens,
      apiContextTokens: cached.apiContextTokens ?? null,
      contextWindow: cached.contextWindow,
      contextBreakdown: cached.breakdown ?? null,
      pipelineStatus: cached.pipelineStatus ?? null,
      // Per-Agent EMA-smoothed factor (api / raw_BPE) applied to contextTokens
      // and breakdown sections. 1.0 = no calibration yet (first turn). UI
      // surfaces this as a small "×1.5" chip when significantly != 1.
      calibrationFactor: cached.calibrationFactor ?? null,
      compactingPercent: compacting.currentPercent,
      compactingThresholdPercent: compacting.thresholdPercent,
      summaryCount: compacting.summaryCount,
      maxSummaries: compacting.maxSummaries,
      summaryTokens: compacting.summaryTokens,
      summaryBudgetTokens: compacting.summaryBudgetTokens,
      keepPercent: compacting.keepPercent,
    })
  }

  // Fallback: rough estimation for agents that haven't processed a message yet
  const contextWindow = getModelContextWindow(agent.model)
  const estimateTokens = (text: string) => Math.ceil(text.length / 4)

  let systemPromptTokens = 0
  systemPromptTokens += estimateTokens([agent.name, agent.role, agent.character, agent.expertise].join(' '))
  systemPromptTokens += 1500

  // Sum active summaries tokens
  const activeSummaries = await db
    .select({ summary: compactingSummaries.summary, lastMessageAt: compactingSummaries.lastMessageAt })
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.agentId, agent.id), eq(compactingSummaries.isInContext, true)))
    .orderBy(desc(compactingSummaries.lastMessageAt))
    .all()

  for (const s of activeSummaries) {
    systemPromptTokens += estimateTokens(s.summary)
  }

  const latestSummary = activeSummaries.length > 0 ? activeSummaries[0]! : null

  const recentMsgs = await db
    .select({ content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.agentId, agent.id),
        isNull(messages.taskId),
        isNull(messages.sessionId),
        ne(messages.sourceType, 'compacting'),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(50)
    .all()

  const cutoffTs = latestSummary ? (latestSummary.lastMessageAt as unknown as number) : null
  const filtered = cutoffTs
    ? recentMsgs.filter((m) => m.createdAt && (m.createdAt as unknown as number) > cutoffTs)
    : recentMsgs

  let messagesTokens = 0
  for (const msg of filtered) {
    if (msg.content) messagesTokens += estimateTokens(msg.content)
  }

  const contextTokens = systemPromptTokens + messagesTokens

  return c.json({
    contextTokens,
    contextWindow,
    contextBreakdown: { systemPrompt: systemPromptTokens, messages: messagesTokens, tools: 0, summary: 0, total: contextTokens },
    pipelineStatus: null,
    compactingPercent: compacting.currentPercent,
    compactingThresholdPercent: compacting.thresholdPercent,
    summaryCount: compacting.summaryCount,
    maxSummaries: compacting.maxSummaries,
    summaryTokens: compacting.summaryTokens,
    summaryBudgetTokens: compacting.summaryBudgetTokens,
    keepPercent: compacting.keepPercent,
  })
})

// GET /api/agents/:id/context-preview — build and return the full system prompt
// Useful for debugging / transparency: shows the actual prompt the LLM would receive.
agentRoutes.get('/:id/context-preview', async (c) => {
  const agent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!agent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const taskId = c.req.query('taskId')
  const sessionId = c.req.query('sessionId')

  if (taskId) {
    const { buildTaskContextPreview } = await import('@/server/services/context-preview')
    const preview = await buildTaskContextPreview(taskId)
    // Attach the provider-reported peak input from the most recent turn so
    // the task panel can render the green "✓ real" bar alongside the local
    // BPE estimate. Mirrors what we do for the main-Agent path below.
    const taskRow = db.select({ lastApiContextTokens: tasks.lastApiContextTokens })
      .from(tasks).where(eq(tasks.id, taskId)).get()
    return c.json({
      ...preview,
      apiContextTokens: taskRow?.lastApiContextTokens ?? null,
    })
  }

  if (sessionId) {
    const { buildQuickSessionContextPreview } = await import('@/server/services/context-preview')
    const preview = await buildQuickSessionContextPreview(agent.id, sessionId)
    return c.json(preview)
  }

  const { buildContextPreview } = await import('@/server/services/context-preview')
  const preview = await buildContextPreview(agent.id)

  // Augment with the cached API-reported context size (ground truth) and the
  // per-Agent EMA calibration factor that was applied to the section + per-message
  // estimates inside `preview`. Both let the visualizer explain the numbers.
  const cached = await getLastContextUsage(agent.id)
  return c.json({
    ...preview,
    apiContextTokens: cached?.apiContextTokens ?? null,
    calibrationFactor: cached?.calibrationFactor ?? null,
  })
})

// GET /api/agents/:id/tools — the agent's RESOLVED toolset: the exact tool set
// a main turn (or quick-session turn with ?quick=1) would receive, across
// native + plugin + MCP + custom tools, after toolbox gating. Names + LLM
// descriptions only; the client groups by domain via /api/tools/domains.
agentRoutes.get('/:id/tools', async (c) => {
  const agent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!agent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const user = c.get('user') as { id: string }
  const quick = c.req.query('quick') === '1' || c.req.query('quick') === 'true'

  const { resolveToolset } = await import('@/server/services/toolset-resolver')
  const toolset = await resolveToolset({
    agentId: agent.id,
    toolboxIds: agent.toolboxIds,
    isSubAgent: false,
    userId: user.id,
    quick,
  })
  if (quick) {
    const { QUICK_SESSION_EXCLUDED_TOOLS } = await import('@/server/services/agent-engine')
    for (const name of QUICK_SESSION_EXCLUDED_TOOLS) delete toolset[name]
  }

  const tools = Object.entries(toolset)
    .map(([name, tool]) => ({ name, description: tool.description ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return c.json({ tools })
})

// ─── Agent CRUD (parameterized routes) ───────────────────────────────────────

// GET /api/agents/:id — get a single agent (accepts UUID or slug)
agentRoutes.get('/:id', async (c) => {
  const agent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!agent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const details = await getAgentDetails(agent.id)
  if (!details) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  // Get queue info
  const pendingItems = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.agentId, agent.id))
    .all()

  const queueSize = pendingItems.filter((q) => q.status === 'pending').length
  const processingItem = pendingItems.find((q) => q.status === 'processing')
  const isProcessing = !!processingItem

  return c.json({
    id: details.id,
    slug: details.slug,
    name: details.name,
    role: details.role,
    avatarUrl: details.avatarUrl,
    character: details.character,
    expertise: details.expertise,
    model: details.model,
    providerId: details.providerId ?? null,
    scoutModel: details.scoutModel ?? null,
    scoutProviderId: details.scoutProviderId ?? null,
    workspacePath: details.workspacePath,
    toolboxIds: parseToolboxIds(details.toolboxIds),
    extraToolNames: (() => {
      try {
        const parsed = JSON.parse(details.extraToolNames ?? 'null')
        return Array.isArray(parsed) ? parsed : null
      } catch { return null }
    })(),
    compactingConfig: details.compactingConfig ? JSON.parse(details.compactingConfig) : null,
    thinkingConfig: details.thinkingConfig ? JSON.parse(details.thinkingConfig) : null,
    scoutThinkingConfig: details.scoutThinkingConfig ? JSON.parse(details.scoutThinkingConfig) : null,
    mcpServers: details.mcpServers,
    queueSize,
    isProcessing,
    processingStartedAt: processingItem
      ? (processingItem.createdAt instanceof Date ? processingItem.createdAt.getTime() : Number(processingItem.createdAt))
      : undefined,
    isCompacting: compactingAgents.has(agent.id),
    createdAt: details.createdAt,
  })
})

// POST /api/agents — create a new agent
agentRoutes.post('/', async (c) => {
  const user = c.get('user') as { id: string }
  const body = await c.req.json()
  let { name, slug, role, character, expertise, model, providerId, scoutModel, scoutProviderId, mcpServerIds } = body as {
    name: string
    slug?: string
    role: string
    character: string
    expertise: string
    model: string
    providerId?: string | null
    scoutModel?: string | null
    scoutProviderId?: string | null
    mcpServerIds?: string[]
  }
  const toolboxIds = normalizeToolboxIdsInput(body.toolboxIds)

  // Fall back to default LLM if no model specified
  if (!model || !model.trim()) {
    const defaultModel = await getDefaultLlmModel()
    const defaultProviderId = await getDefaultLlmProviderId()
    if (defaultModel) {
      model = defaultModel
      providerId = providerId ?? defaultProviderId
    }
  }

  const validationError = validateAgentFields({ name, role, character, expertise, model, providerId, scoutModel, scoutProviderId }, 'create')
  if (validationError) {
    return c.json({ error: { code: validationError.code, message: validationError.message } }, 400)
  }

  const newAgent = await createAgent({
    name,
    slug,
    role,
    character,
    expertise,
    model,
    providerId,
    scoutModel,
    scoutProviderId,
    createdBy: user.id,
    mcpServerIds,
    toolboxIds: toolboxIds ?? undefined,
  })

  return c.json(
    {
      agent: {
        id: newAgent.id,
        slug: newAgent.slug,
        name: newAgent.name,
        role: newAgent.role,
        avatarUrl: null,
        character: newAgent.character,
        expertise: newAgent.expertise,
        model: newAgent.model,
        providerId: newAgent.providerId ?? null,
        scoutModel: newAgent.scoutModel ?? null,
        scoutProviderId: newAgent.scoutProviderId ?? null,
        workspacePath: newAgent.workspacePath,
        toolboxIds: parseToolboxIds(newAgent.toolboxIds),
        mcpServers: [],
        queueSize: 0,
        isProcessing: false,
        createdAt: newAgent.createdAt,
      },
    },
    201,
  )
})

// PATCH /api/agents/:id — update an agent (accepts UUID or slug)
agentRoutes.patch('/:id', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const body = await c.req.json()

  const validationError = validateAgentFields({
    name: body.name,
    role: body.role,
    character: body.character,
    expertise: body.expertise,
    model: body.model,
    providerId: body.providerId,
    scoutModel: body.scoutModel,
    scoutProviderId: body.scoutProviderId,
  }, 'update')
  if (validationError) {
    return c.json({ error: { code: validationError.code, message: validationError.message } }, 400)
  }

  const result = await updateAgent(existing.id, {
    name: body.name,
    role: body.role,
    character: body.character,
    expertise: body.expertise,
    model: body.model,
    providerId: body.providerId,
    scoutModel: body.scoutModel,
    scoutProviderId: body.scoutProviderId,
    slug: body.slug,
    toolboxIds: normalizeToolboxIdsInput(body.toolboxIds),
    extraToolNames: Array.isArray(body.extraToolNames)
      ? body.extraToolNames.filter((x: unknown): x is string => typeof x === 'string')
      : body.extraToolNames === null ? null : undefined,
    compactingConfig: body.compactingConfig,
    thinkingConfig: body.thinkingConfig,
    scoutThinkingConfig: body.scoutThinkingConfig,
    mcpServerIds: body.mcpServerIds,
  })

  if ('error' in result) {
    const statusCode = result.error.code === 'INVALID_SLUG' ? 400 : 409
    return c.json({ error: result.error }, statusCode)
  }

  const { agent: details } = result
  return c.json({
    agent: {
      id: details.id,
      slug: details.slug,
      name: details.name,
      role: details.role,
      avatarUrl: details.avatarUrl,
      character: details.character,
      expertise: details.expertise,
      model: details.model,
      providerId: details.providerId ?? null,
      scoutModel: details.scoutModel ?? null,
      scoutProviderId: details.scoutProviderId ?? null,
      workspacePath: details.workspacePath,
      toolboxIds: parseToolboxIds(details.toolboxIds),
      compactingConfig: details.compactingConfig ? JSON.parse(details.compactingConfig) : null,
      thinkingConfig: details.thinkingConfig ? JSON.parse(details.thinkingConfig) : null,
      scoutThinkingConfig: details.scoutThinkingConfig ? JSON.parse(details.scoutThinkingConfig) : null,
      mcpServers: details.mcpServers,
      queueSize: 0,
      isProcessing: false,
      createdAt: details.createdAt,
    },
  })
})

// DELETE /api/agents/:id — delete an agent (accepts UUID or slug)
agentRoutes.delete('/:id', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const deleted = await deleteAgent(existing.id)
  if (!deleted) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  return c.json({ success: true })
})

// PATCH /api/agents/:id/active-project — set or clear the active project for an Agent
agentRoutes.patch('/:id/active-project', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const body = await c.req.json().catch(() => ({}))
  // null is an explicit "deactivate" — distinguish from undefined (missing field)
  if (!('projectId' in body) || (body.projectId !== null && typeof body.projectId !== 'string')) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'projectId must be a string or null' } }, 400)
  }
  const { setActiveProject } = await import('@/server/services/projects')
  try {
    const result = await setActiveProject(existing.id, body.projectId)
    return c.json({ activeProjectId: result.activeProjectId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'PROJECT_NOT_FOUND') {
      return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404)
    }
    if (msg === 'KIN_NOT_FOUND') {
      return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

const ORPHAN_TASK_VALID_EFFORTS: readonly AgentThinkingEffort[] = THINKING_EFFORTS

// POST /api/agents/:id/tasks — start a standalone (orphan) task on this Agent with
// NO project/ticket binding. Body: { prompt, title?, model?, providerId?,
// thinkingConfig?, toolboxIds? }. model + providerId are coupled (both or
// neither). Result is deposited back into the Agent's main session (async mode).
agentRoutes.post('/:id/tasks', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const body = await c.req.json().catch(() => ({}))

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'prompt is required' } }, 400)
  }
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null

  // model + providerId coupled — apply only when both are non-empty strings.
  let model: string | null | undefined
  let providerId: string | null | undefined
  if (typeof body.model === 'string' && body.model.trim() && typeof body.providerId === 'string' && body.providerId.trim()) {
    model = body.model.trim()
    providerId = body.providerId.trim()
  }

  // Optional thinking/effort override. Absent → inherit from Agent.
  let thinkingConfig: AgentThinkingConfig | undefined
  if (body.thinkingConfig && typeof body.thinkingConfig === 'object') {
    const cfg = body.thinkingConfig as Record<string, unknown>
    const enabled = cfg.enabled === true
    const effort = typeof cfg.effort === 'string' && (ORPHAN_TASK_VALID_EFFORTS as readonly string[]).includes(cfg.effort)
      ? (cfg.effort as AgentThinkingEffort)
      : null
    thinkingConfig = { enabled, ...(effort !== null ? { effort } : {}) }
  }

  // Optional toolbox selection. Absent → runtime default ('all' for non-ticket).
  let toolboxIds: string[] | undefined
  if (body.toolboxIds !== undefined) {
    if (!Array.isArray(body.toolboxIds) || body.toolboxIds.some((id: unknown) => typeof id !== 'string')) {
      return c.json({ error: { code: 'INVALID_TOOLBOX_IDS', message: 'toolboxIds must be an array of strings' } }, 400)
    }
    toolboxIds = (body.toolboxIds as string[]).map((id) => id.trim()).filter((id) => id.length > 0)
  }

  const { startOrphanTask } = await import('@/server/services/tasks')
  try {
    const task = await startOrphanTask(existing.id, { prompt, title, model, providerId, thinkingConfig, toolboxIds })
    return c.json({ task }, 201)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg === 'KIN_NOT_FOUND') {
      return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
    }
    if (msg === 'EMPTY_PROMPT') {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'prompt is required' } }, 400)
    }
    if (msg === 'MODEL_AND_PROVIDER_MUST_BOTH_BE_SET') {
      return c.json({ error: { code: 'MODEL_AND_PROVIDER_MUST_BOTH_BE_SET', message: 'model and providerId must be set together' } }, 400)
    }
    log.warn({ agentId: existing.id, err }, 'startOrphanTask failed')
    return c.json({ error: { code: 'INTERNAL', message: msg } }, 500)
  }
})

// POST /api/agents/:id/mark-read — bump the lastReadAt marker for the current user
agentRoutes.post('/:id/mark-read', async (c) => {
  const sessionUser = c.get('user') as { id: string }
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  await markAgentAsRead(sessionUser.id, existing.id)
  return c.json({ success: true })
})

// POST /api/agents/:id/avatar — upload avatar (accepts UUID or slug)
agentRoutes.post('/:id/avatar', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const id = existing.id

  const formData = await c.req.formData()
  const file = formData.get('file')

  if (!file || !(file instanceof File)) {
    return c.json({ error: { code: 'INVALID_FILE', message: 'No file provided' } }, 400)
  }

  // Safety-net file size limit (client already crops to 512x512 JPEG ~50-150KB)
  const MAX_AVATAR_SIZE = 10 * 1024 * 1024
  if (file.size > MAX_AVATAR_SIZE) {
    return c.json(
      { error: { code: 'FILE_TOO_LARGE', message: 'Avatar must be under 10MB' } },
      400,
    )
  }

  const avatarDir = `${config.upload.dir}/agents/${id}`
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true })
  }

  const ext = file.name.split('.').pop() ?? 'png'
  const filename = `avatar.${ext}`
  const filePath = `${avatarDir}/${filename}`
  const buffer = await file.arrayBuffer()
  await Bun.write(filePath, buffer)

  await db
    .update(agents)
    .set({ avatarPath: filePath, updatedAt: new Date() })
    .where(eq(agents.id, id))

  const avatarUrl = `/api/uploads/agents/${id}/avatar.${ext}?v=${Date.now()}`

  // Notify all clients
  sseManager.broadcast({
    type: 'agent:updated',
    agentId: id,
    data: { agentId: id, avatarUrl },
  })

  return c.json({ avatarUrl })
})

// POST /api/agents/:id/avatar/generate — generate avatar preview (accepts UUID or slug)
agentRoutes.post('/:id/avatar/generate', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const id = existing.id

  const body = await c.req.json()
  const mode = body.mode as string

  if (mode === 'prompt' && (!body.prompt || typeof body.prompt !== 'string')) {
    return c.json(
      { error: { code: 'INVALID_PROMPT', message: 'A prompt is required for prompt mode' } },
      400,
    )
  }

  try {
    // Resolve the chosen image target so we know whether image-to-image is on the table.
    // - "auto":   the prompt-writer derives everything from the Agent identity, guided by
    //             the GLOBAL style/subject; the base reference is attached when supported.
    // - "manual": same writer, but the user supplies the axes for this one shot — style (A),
    //             subject (B), extra art direction (C) — and decides whether to attach the
    //             base image (useBase). Nothing is persisted to the global settings.
    // - "prompt": legacy fully-manual mode — the user's prompt is sent verbatim, no base.
    const target = await resolveImageTarget({
      providerId: body.imageProviderId,
      modelId: body.imageModel,
    })
    const targetMaxImageInputs = await getMaxImageInputs(target.providerId, target.modelId)

    // Whether to attach the img2img base reference for this generation.
    //   auto   → global img2img setting + model support
    //   manual → user's useBase toggle + model support (the global setting only
    //            seeds the toggle's default on the client)
    const supportsEdit =
      (mode === 'auto' && targetMaxImageInputs > 0 && (await isImg2imgEnabled())) ||
      (mode === 'manual' && body.useBase === true && targetMaxImageInputs > 0)

    let prompt: string
    if (mode === 'auto') {
      prompt = await buildAvatarPrompt(
        {
          name: existing.name,
          role: existing.role,
          character: existing.character ?? '',
          expertise: existing.expertise ?? '',
        },
        supportsEdit ? 'edit' : 'generate',
        { targetModelId: target.modelId, maxImageInputs: targetMaxImageInputs },
      )
    } else if (mode === 'manual') {
      prompt = await buildAvatarPrompt(
        {
          name: existing.name,
          role: existing.role,
          character: existing.character ?? '',
          expertise: existing.expertise ?? '',
        },
        supportsEdit ? 'edit' : 'generate',
        {
          ...(typeof body.style === 'string' ? { style: body.style } : {}),
          ...(typeof body.subject === 'string' ? { subject: body.subject } : {}),
          ...(typeof body.character === 'string' ? { extraGuidance: body.character } : {}),
          targetModelId: target.modelId,
          maxImageInputs: targetMaxImageInputs,
        },
      )
    } else {
      prompt = body.prompt
    }

    const result = await generateAvatarImage(prompt, {
      providerId: target.providerId,
      modelId: target.modelId,
      ...(supportsEdit ? { imageDatas: [await getBaseAvatarBytes()] } : {}),
    })
    return c.json({
      base64: result.base64,
      mediaType: result.mediaType,
    })
  } catch (err) {
    if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
      return c.json(
        { error: { code: 'NO_IMAGE_PROVIDER', message: err.message } },
        422,
      )
    }
    const message = err instanceof Error ? err.message : 'Image generation failed'
    return c.json(
      { error: { code: 'IMAGE_GENERATION_FAILED', message } },
      502,
    )
  }
})

// ─── Compacting routes ───────────────────────────────────────────────────────

// POST /api/agents/:id/compacting/run — force compaction immediately
agentRoutes.post('/:id/compacting/run', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  // Refuse if compacting is already running for this Agent. Without this guard,
  // a force-compact while a post-turn compacting is in flight would race:
  // both LLM calls read the same message range and could create overlapping
  // summaries. Also serializes against the recovery path triggered by the
  // catch in processNextMessage (see add68ae6).
  if (compactingAgents.has(existing.id)) {
    return c.json({ error: { code: 'COMPACTING_IN_PROGRESS', message: 'Compacting is already running for this Agent — try again in a few seconds.' } }, 409)
  }

  const { runCompacting } = await import('@/server/services/compacting')

  sseManager.sendToAgent(existing.id, {
    type: 'compacting:start',
    agentId: existing.id,
    data: { agentId: existing.id, cycle: 1, estimatedTotal: 1 },
  })

  // Take the lock so processNextMessage skips during the force-compaction,
  // matching the behavior of the post-turn auto path. Released in the
  // finally below regardless of success / failure.
  compactingAgents.add(existing.id)
  let result: Awaited<ReturnType<typeof runCompacting>>
  try {
    result = await runCompacting(existing.id, undefined, { aggressive: true })
  } catch (err) {
    // runCompacting already emits compacting:error via SSE and persists the error message
    return c.json({ error: { code: 'COMPACTING_FAILED', message: err instanceof Error ? err.message : 'Compacting failed' } }, 500)
  } finally {
    compactingAgents.delete(existing.id)
  }

  if (!result) {
    // Persist error in conversation history
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      agentId: existing.id,
      role: 'system',
      content: '',
      sourceType: 'compacting',
      isRedacted: false,
      redactPending: false,
      metadata: JSON.stringify({ error: 'NOTHING_TO_COMPACT' }),
      createdAt: new Date(),
    })
    sseManager.sendToAgent(existing.id, {
      type: 'compacting:error',
      agentId: existing.id,
      data: { agentId: existing.id, error: 'NOTHING_TO_COMPACT' },
    })
    return c.json({ error: { code: 'NOTHING_TO_COMPACT', message: 'Not enough messages to compact' } }, 422)
  }

  // Trigger a brief follow-up turn so:
  //  1. The Agent acknowledges the compaction in the chat (instead of the
  //     conversation just sitting silent after the user clicked the button).
  //  2. The next setLastContextUsage / recordApiContextSize cycle refreshes
  //     the navbar with the post-compaction context size — without this,
  //     the cached numbers stay stale until the user happens to send a real
  //     message, which is jarring ("I just compacted but the bar didn't move").
  // Enqueued as 'system' source so it's clearly an internal trigger, not a
  // user message. The Agent processes it normally and replies briefly.
  const { enqueueMessage } = await import('@/server/services/queue')
  await enqueueMessage({
    agentId: existing.id,
    messageType: 'compacting_followup',
    // Dedicated sourceType (rather than reusing 'system') so the chat UI
    // can filter the trigger prompt out of view — the user shouldn't see
    // an internal instruction appearing as if they typed it.
    sourceType: 'compacting_followup',
    content: `[Internal] La compaction de l'historique vient de se terminer (déclenchée manuellement par l'utilisateur). Confirme brièvement que c'est fait — une seule phrase courte — et invite l'utilisateur à reprendre la conversation. N'élabore pas sur les détails techniques.`,
  })

  return c.json({ success: true, summary: result.summary, memoriesExtracted: result.memoriesExtracted })
})

// POST /api/agents/:id/compacting/purge — deactivate all active summaries
agentRoutes.post('/:id/compacting/purge', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = existing.id

  await db
    .update(compactingSummaries)
    .set({ isInContext: false })
    .where(and(eq(compactingSummaries.agentId, agentId), eq(compactingSummaries.isInContext, true)))

  return c.json({ success: true })
})

// GET /api/agents/:id/compacting/summaries — list summaries
agentRoutes.get('/:id/compacting/summaries', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = existing.id

  const summaries = await db
    .select({
      id: compactingSummaries.id,
      firstMessageAt: compactingSummaries.firstMessageAt,
      lastMessageAt: compactingSummaries.lastMessageAt,
      lastMessageId: compactingSummaries.lastMessageId,
      messageCount: compactingSummaries.messageCount,
      tokenEstimate: compactingSummaries.tokenEstimate,
      isInContext: compactingSummaries.isInContext,
      depth: compactingSummaries.depth,
      createdAt: compactingSummaries.createdAt,
    })
    .from(compactingSummaries)
    .where(eq(compactingSummaries.agentId, agentId))
    .orderBy(desc(compactingSummaries.createdAt))
    .all()

  return c.json({ summaries })
})

// Keep the old route as an alias for backwards compatibility
agentRoutes.get('/:id/compacting/snapshots', async (c) => {
  // Redirect internally to the new summaries route
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = existing.id

  const summaries = await db
    .select({
      id: compactingSummaries.id,
      firstMessageAt: compactingSummaries.firstMessageAt,
      lastMessageAt: compactingSummaries.lastMessageAt,
      lastMessageId: compactingSummaries.lastMessageId,
      isInContext: compactingSummaries.isInContext,
      createdAt: compactingSummaries.createdAt,
    })
    .from(compactingSummaries)
    .where(eq(compactingSummaries.agentId, agentId))
    .orderBy(desc(compactingSummaries.createdAt))
    .all()

  // Map to old format for backwards compat
  return c.json({ snapshots: summaries.map((s) => ({ id: s.id, messagesUpToId: s.lastMessageId, isActive: s.isInContext, createdAt: s.createdAt })) })
})

// POST /api/agents/:id/compacting/rollback — archive summaries after a chosen one
agentRoutes.post('/:id/compacting/rollback', async (c) => {
  const resolvedAgent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!resolvedAgent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = resolvedAgent.id
  const body = (await c.req.json()) as { summaryId?: string; snapshotId?: string }
  const summaryId = body.summaryId ?? body.snapshotId // support both old and new param name

  if (!summaryId) {
    return c.json({ error: { code: 'MISSING_PARAM', message: 'summaryId is required' } }, 400)
  }

  const summary = await db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.id, summaryId), eq(compactingSummaries.agentId, agentId)))
    .get()

  if (!summary) {
    return c.json({ error: { code: 'SUMMARY_NOT_FOUND', message: 'Summary not found' } }, 404)
  }

  // Archive all summaries created after the chosen one
  const allSummaries = await db
    .select({ id: compactingSummaries.id, createdAt: compactingSummaries.createdAt })
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.agentId, agentId), eq(compactingSummaries.isInContext, true)))
    .all()

  const summaryCreatedAt = summary.createdAt as unknown as number
  const toArchive = allSummaries
    .filter((s) => (s.createdAt as unknown as number) > summaryCreatedAt)
    .map((s) => s.id)

  if (toArchive.length > 0) {
    await db
      .update(compactingSummaries)
      .set({ isInContext: false })
      .where(inArray(compactingSummaries.id, toArchive))
  }

  // Ensure the target summary is in context
  if (!summary.isInContext) {
    await db
      .update(compactingSummaries)
      .set({ isInContext: true })
      .where(eq(compactingSummaries.id, summaryId))
  }

  return c.json({ success: true, archivedCount: toArchive.length })
})

// ─── Memory routes ───────────────────────────────────────────────────────────

// GET /api/agents/:id/memories — list memories
agentRoutes.get('/:id/memories', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = existing.id
  const category = c.req.query('category')
  const subject = c.req.query('subject')
  const scope = c.req.query('scope')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)

  const conditions = [eq(memories.agentId, agentId)]
  if (category) conditions.push(eq(memories.category, category))
  if (subject) conditions.push(eq(memories.subject, subject))
  if (scope) conditions.push(eq(memories.scope, scope))

  const whereClause = and(...conditions)

  const [countResult, result] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(whereClause)
      .all(),
    db
      .select({
        id: memories.id,
        agentId: memories.agentId,
        content: memories.content,
        category: memories.category,
        subject: memories.subject,
        scope: memories.scope,
        importance: memories.importance,
        retrievalCount: memories.retrievalCount,
        lastRetrievedAt: memories.lastRetrievedAt,
        consolidationGeneration: memories.consolidationGeneration,
        sourceChannel: memories.sourceChannel,
        sourceContext: memories.sourceContext,
        createdAt: memories.createdAt,
        updatedAt: memories.updatedAt,
      })
      .from(memories)
      .where(whereClause)
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .offset(offset)
      .all(),
  ])

  const total = countResult[0]?.count ?? 0
  return c.json({ memories: result, total, hasMore: offset + result.length < total })
})

// DELETE /api/agents/:id/memories/:memoryId — delete a memory
agentRoutes.delete('/:id/memories/:memoryId', async (c) => {
  const resolvedAgent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!resolvedAgent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = resolvedAgent.id
  const memoryId = c.req.param('memoryId')

  const deleted = await deleteMemory(memoryId, agentId)
  if (!deleted) {
    return c.json({ error: { code: 'MEMORY_NOT_FOUND', message: 'Memory not found' } }, 404)
  }

  return c.json({ success: true })
})

// POST /api/agents/:id/memories — create a memory
agentRoutes.post('/:id/memories', async (c) => {
  const existing = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = existing.id
  const { content, category, subject, scope } = (await c.req.json()) as {
    content: string
    category: string
    subject?: string
    scope?: string
  }

  if (!content || !category) {
    return c.json(
      { error: { code: 'INVALID_INPUT', message: 'Content and category are required' } },
      400,
    )
  }

  const memory = await createMemory(agentId, {
    content,
    category: category as MemoryCategory,
    subject: subject ?? null,
    sourceChannel: 'explicit',
    scope: (scope === 'shared' ? 'shared' : 'private') as MemoryScope,
  })

  return c.json({
    memory: {
      id: memory!.id,
      agentId: memory!.agentId,
      content: memory!.content,
      category: memory!.category,
      subject: memory!.subject,
      scope: memory!.scope,
      sourceChannel: memory!.sourceChannel,
      sourceContext: memory!.sourceContext,
      createdAt: memory!.createdAt,
      updatedAt: memory!.updatedAt,
    },
  }, 201)
})

// PATCH /api/agents/:id/memories/:memoryId — update a memory
agentRoutes.patch('/:id/memories/:memoryId', async (c) => {
  const resolvedAgent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!resolvedAgent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }
  const agentId = resolvedAgent.id
  const memoryId = c.req.param('memoryId')
  const body = (await c.req.json()) as {
    content?: string
    category?: string
    subject?: string | null
    scope?: string
  }

  const updated = await updateMemory(memoryId, agentId, {
    content: body.content,
    category: body.category as MemoryCategory | undefined,
    subject: body.subject,
    scope: body.scope as MemoryScope | undefined,
  })

  if (!updated) {
    return c.json({ error: { code: 'MEMORY_NOT_FOUND', message: 'Memory not found' } }, 404)
  }

  return c.json({
    memory: {
      id: updated.id,
      agentId: updated.agentId,
      content: updated.content,
      category: updated.category,
      subject: updated.subject,
      scope: updated.scope,
      sourceChannel: updated.sourceChannel,
      sourceContext: updated.sourceContext,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  })
})

// GET /api/agents/:id/export — export an Agent's configuration as JSON
agentRoutes.get('/:id/export', async (c) => {
  const agent = resolveAgentByIdOrSlug(c.req.param('id'))
  if (!agent) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  const details = await getAgentDetails(agent.id)
  if (!details) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Agent not found' } }, 404)
  }

  // Get MCP server details for this agent
  const agentMcpRows = await db
    .select({ serverId: agentMcpServers.mcpServerId })
    .from(agentMcpServers)
    .where(eq(agentMcpServers.agentId, agent.id))
    .all()

  const mcpServerDetails = agentMcpRows.length > 0
    ? await Promise.all(
        agentMcpRows.map(async (row) => {
          const [server] = await db
            .select()
            .from(mcpServers)
            .where(eq(mcpServers.id, row.serverId))
            .limit(1)
          return server
            ? { name: server.name, command: server.command, args: server.args }
            : null
        }),
      ).then((results) => results.filter(Boolean))
    : []

  const exportData = {
    _hivekeep: {
      version: 1,
      exportedAt: new Date().toISOString(),
    },
    name: details.name,
    role: details.role,
    character: details.character,
    expertise: details.expertise,
    model: details.model,
    toolboxIds: parseToolboxIds(details.toolboxIds),
    extraToolNames: (() => {
      try {
        const parsed = JSON.parse(details.extraToolNames ?? 'null')
        return Array.isArray(parsed) ? parsed : null
      } catch { return null }
    })(),
    compactingConfig: details.compactingConfig ? JSON.parse(details.compactingConfig) : null,
    thinkingConfig: details.thinkingConfig ? JSON.parse(details.thinkingConfig) : null,
    mcpServers: mcpServerDetails,
  }

  const filename = `${details.slug || details.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.gezy.json`

  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', 'application/json')
  return c.json(exportData)
})

// POST /api/agents/import — create a new Agent from an exported JSON config
agentRoutes.post('/import', async (c) => {
  const user = c.get('user') as { id: string }
  const body = await c.req.json()

  // Validate required fields
  const { name, role, character, expertise, model, thinkingConfig } = body as {
    name?: string
    role?: string
    character?: string
    expertise?: string
    model?: string
    thinkingConfig?: AgentThinkingConfig | null
    _hivekeep?: { version?: number }
  }
  const toolboxIds = normalizeToolboxIdsInput(body.toolboxIds)

  if (!name || !role || !character || !expertise || !model) {
    return c.json(
      {
        error: {
          code: 'INVALID_IMPORT',
          message: 'Missing required fields: name, role, character, expertise, model',
        },
      },
      400,
    )
  }

  // Check if model is available in configured providers
  const warnings: string[] = []
  const allProviders = await db.select().from(providers).all()
  let modelFound = false
  for (const p of allProviders) {
    if (!p.isValid) continue
    try {
      const pConfig = await loadProviderConfig(p)
      const caps = JSON.parse(p.capabilities) as string[]
      // Search the model across every family this row serves — the
      // requested model could be LLM, embedding, or image.
      for (const family of caps) {
        if (family !== 'llm' && family !== 'embedding' && family !== 'image') continue
        const pModels = await listModelsForProvider(p.type, pConfig, family)
        if (pModels.some((m) => m.id === model)) {
          modelFound = true
          break
        }
      }
      if (modelFound) break
    } catch {
      // Skip provider on error
    }
  }
  if (!modelFound) {
    warnings.push(`Model '${model}' is not available in your configured providers. You may need to update the Agent's model after import.`)
  }

  const newAgent = await createAgent({
    name,
    role,
    character,
    expertise,
    model,
    createdBy: user.id,
    toolboxIds: toolboxIds ?? undefined,
  })

  // Apply thinkingConfig if present
  if (thinkingConfig) {
    await updateAgent(newAgent.id, { thinkingConfig })
  }

  return c.json(
    {
      agent: {
        id: newAgent.id,
        slug: newAgent.slug,
        name: newAgent.name,
        role: newAgent.role,
        avatarUrl: null,
        character: newAgent.character,
        expertise: newAgent.expertise,
        model: newAgent.model,
        providerId: newAgent.providerId ?? null,
        workspacePath: newAgent.workspacePath,
        mcpServers: [],
        queueSize: 0,
        isProcessing: false,
        createdAt: newAgent.createdAt,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    201,
  )
})

export { agentRoutes }
