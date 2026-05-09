import { Hono } from 'hono'
import { eq, and, desc, isNull, ne, inArray, sql } from 'drizzle-orm'
import { mkdirSync, existsSync } from 'fs'
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { db } from '@/server/db/index'
import { kins, kinMcpServers, mcpServers, queueItems, compactingSummaries, memories, messages, providers } from '@/server/db/schema'
import { config } from '@/server/config'
import {
  generateAvatarImage,
  buildAvatarPrompt,
  ImageGenerationError,
  findLLMProvider,
} from '@/server/services/image-generation'
import { decrypt } from '@/server/services/encryption'
import { deleteMemory, createMemory, updateMemory } from '@/server/services/memory'
import { getMCPToolsForConfig } from '@/server/services/mcp'
import { toolRegistry } from '@/server/tools/index'
import { TOOL_DOMAIN_MAP, TOOL_DOMAIN_META } from '@/shared/constants'
import type { KinToolConfig, KinThinkingConfig, ToolDomain, MemoryCategory, MemoryScope } from '@/shared/types'
import { sseManager } from '@/server/sse/index'
import { resolveKinByIdOrSlug } from '@/server/services/kin-resolver'
import {
  createKin,
  updateKin,
  deleteKin,
  getKinDetails,
} from '@/server/services/kins'
import { kinAvatarUrl, validateKinFields } from '@/server/services/field-validator'
import { getHubKinId, getDefaultLlmModel, getDefaultLlmProviderId } from '@/server/services/app-settings'
import { listModelsForProvider } from '@/server/providers/index'
import type { AppVariables } from '@/server/app'

/** Provider types that use the OpenAI-compatible SDK (createOpenAI) */
const OPENAI_COMPATIBLE_PROVIDERS = new Set([
  'openrouter', 'deepseek', 'fireworks', 'together', 'groq',
  'mistral', 'perplexity', 'xai', 'ollama', 'cohere', 'openai-compatible',
])
import { createLogger } from '@/server/logger'
import { recordUsage } from '@/server/services/token-usage'
import { getLastContextUsage, compactingKins } from '@/server/services/kin-engine'
import { getModelContextWindow } from '@/shared/model-context-windows'

const log = createLogger('routes:kins')
const kinRoutes = new Hono<{ Variables: AppVariables }>()

// GET /api/kins — list all kins
kinRoutes.get('/', async (c) => {
  const [allKins, hubKinId, allQueueItems] = await Promise.all([
    db.select().from(kins).all(),
    getHubKinId(),
    db.select({ kinId: queueItems.kinId, status: queueItems.status, createdAt: queueItems.createdAt }).from(queueItems).all(),
  ])

  // Build per-kin queue state from all queue items
  const queueStateMap = new Map<string, { isProcessing: boolean; queueSize: number; processingStartedAt?: number }>()
  for (const item of allQueueItems) {
    const state = queueStateMap.get(item.kinId) ?? { isProcessing: false, queueSize: 0 }
    if (item.status === 'processing') {
      state.isProcessing = true
      // Use the queue item's createdAt as a proxy for when processing started
      state.processingStartedAt = item.createdAt instanceof Date ? item.createdAt.getTime() : Number(item.createdAt)
    }
    if (item.status === 'pending') state.queueSize++
    queueStateMap.set(item.kinId, state)
  }

  return c.json({
    kins: allKins.map((k) => {
      const qs = queueStateMap.get(k.id)
      return {
        id: k.id,
        slug: k.slug,
        name: k.name,
        role: k.role,
        avatarUrl: kinAvatarUrl(k.id, k.avatarPath, k.updatedAt),
        model: k.model,
        providerId: k.providerId ?? null,
        createdAt: k.createdAt,
        isHub: k.id === hubKinId,
        thinkingEnabled: k.thinkingConfig ? (JSON.parse(k.thinkingConfig) as { enabled?: boolean }).enabled === true : false,
        isProcessing: qs?.isProcessing ?? false,
        queueSize: qs?.queueSize ?? 0,
        processingStartedAt: qs?.processingStartedAt ?? undefined,
      }
    }),
  })
})

// ─── Wizard: AI-assisted Kin configuration ─────────────────────────────────
// These routes MUST be registered before /:id to avoid being caught by the wildcard

// POST /api/kins/generate-config — generate Kin configuration from natural language
kinRoutes.post('/generate-config', async (c) => {
  const body = await c.req.json()
  const { description, refinement, currentConfig, language } = body as {
    description?: string
    refinement?: string
    currentConfig?: Record<string, unknown>
    language?: string
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

  const providerConfig = JSON.parse(await decrypt(llmProvider.configEncrypted)) as {
    apiKey: string
    baseUrl?: string
  }

  // Helper: pick the first available LLM model ID for a provider, with a fallback default
  async function pickFirstLlmModelId(fallback: string): Promise<string> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const providerModels = await listModelsForProvider(llmProvider!.type, providerConfig)
      const first = providerModels.find((m) => m.capability === 'llm')
      return first?.id ?? fallback
    } catch {
      return fallback
    }
  }

  let model
  if (llmProvider.type === 'anthropic') {
    const anthropic = createAnthropic({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
    const modelId = await pickFirstLlmModelId('claude-haiku-4-5-20251001')
    model = anthropic(modelId)
  } else if (llmProvider.type === 'anthropic-oauth') {
    const { getOAuthAccessToken, OAUTH_HEADERS, REQUIRED_SYSTEM_BLOCK } = await import('@/server/providers/anthropic-oauth')
    const accessToken = await getOAuthAccessToken(providerConfig.apiKey || undefined)
    const anthropic = createAnthropic({
      apiKey: 'oauth',
      headers: OAUTH_HEADERS,
      fetch: (async (url: URL | RequestInfo, init: RequestInit | undefined) => {
        const headers = new Headers(init?.headers)
        headers.delete('x-api-key')
        headers.set('authorization', `Bearer ${accessToken}`)
        if (init?.body && typeof init.body === 'string') {
          try {
            const body = JSON.parse(init.body)
            if (body.system !== undefined) {
              if (typeof body.system === 'string') {
                body.system = [REQUIRED_SYSTEM_BLOCK, { type: 'text', text: body.system }]
              } else if (Array.isArray(body.system)) {
                body.system = [REQUIRED_SYSTEM_BLOCK, ...body.system]
              }
              init = { ...init, body: JSON.stringify(body) }
            }
          } catch { /* pass through */ }
        }
        return globalThis.fetch(url, { ...init, headers })
      }) as unknown as typeof fetch,
    })
    model = anthropic('claude-haiku-4-5-20251001')
  } else if (llmProvider.type === 'openai') {
    const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
    const modelId = await pickFirstLlmModelId('gpt-4o-mini')
    model = openai.chat(modelId)
  } else if (OPENAI_COMPATIBLE_PROVIDERS.has(llmProvider.type)) {
    const openai = createOpenAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
    const modelId = await pickFirstLlmModelId('gpt-4o-mini')
    model = openai.chat(modelId)
  } else if (llmProvider.type === 'gemini') {
    const google = createGoogleGenerativeAI({ apiKey: providerConfig.apiKey, baseURL: providerConfig.baseUrl })
    model = google('gemini-2.0-flash')
  } else {
    return c.json(
      { error: { code: 'UNSUPPORTED_PROVIDER', message: 'No supported LLM provider found' } },
      422,
    )
  }

  // Collect available LLM model IDs for the suggestion
  const allProviders = await db.select().from(providers).all()
  const availableModels: string[] = []
  for (const p of allProviders) {
    if (!p.isValid) continue
    try {
      const pConfig = JSON.parse(await decrypt(p.configEncrypted))
      const pModels = await listModelsForProvider(p.type, pConfig)
      for (const m of pModels) {
        if (m.capability === 'llm' && !availableModels.includes(m.id)) {
          availableModels.push(m.id)
        }
      }
    } catch {
      // Skip provider on error
    }
  }

  // Build tool domain descriptions for the LLM
  const toolDomains = Object.keys(TOOL_DOMAIN_META).map((d) => d).join(', ')

  const lang = language === 'fr' ? 'French' : 'English'

  const systemPrompt = `You are a configuration generator for an AI assistant platform called KinBot. A "Kin" is a specialized AI assistant with a unique identity, personality, and expertise.

Given a user's description of the assistant they want, generate a complete Kin configuration as JSON.

## Fields to generate

- **name**: A short, memorable name for the Kin (1-3 words). Creative but professional.
- **role**: A concise role description (5-15 words) that summarizes the Kin's purpose.
- **character**: A detailed personality description (markdown, 3-5 paragraphs). Defines the tone, communication style, behavior, and values. Use "Tu" (informal) if French, "You" if English. Should feel like a real personality, not generic.
- **expertise**: A detailed knowledge description (markdown, 3-5 paragraphs with bullet lists). Defines specific knowledge domains, methodologies, and objectives. Be concrete and specific to the domain.
- **suggestedModel**: One of the available model IDs. Pick the most capable model for the task (prefer Claude or GPT-4 class for complex domains, lighter models for simple assistants).
- **disableToolDomains**: Array of tool domain names to DISABLE (the Kin won't need these). Most Kins don't need all tools. Be selective — only disable tools clearly irrelevant to the domain.
- **enableOptInToolDomains**: Array of opt-in tool domains to ENABLE. Currently only "kin-management" and "system" are opt-in. Only enable these for admin/platform-management Kins.

## Available tool domains
${toolDomains}

Domain descriptions:
- search: Web search capabilities
- browse: Browse URLs, extract content, take screenshots
- contacts: Manage contact records
- memory: Store and recall long-term memories
- vault: Secure secret storage
- tasks: Spawn sub-tasks and manage delegated work
- inter-kin: Communicate with other Kins on the platform
- crons: Schedule recurring jobs
- custom: Create and run custom scripts
- images: Generate images
- shell: Execute shell commands
- file-storage: Store and manage files
- mcp: Manage MCP (Model Context Protocol) servers
- kin-management: Create/update/delete other Kins (opt-in, admin only)
- webhooks: Manage incoming/outgoing webhooks
- channels: Manage external messaging channels (Telegram, Discord)
- system: Access platform logs (opt-in, admin only)
- users: Manage platform users

## Available LLM models
${availableModels.join(', ')}

## Rules
- Generate ALL content in ${lang}
- Output ONLY valid JSON, nothing else — no markdown fences, no comments
- The character and expertise fields should be rich, specific, and tailored to the domain
- Do not include generic filler — every sentence should be relevant to the specific domain
- For disableToolDomains, think about what tools are NOT useful for this type of assistant. For example, a legal advisor doesn't need "images" or "shell", while a code expert would want "shell" enabled.
- Always keep "memory", "tasks", "inter-kin" enabled (don't add them to disableToolDomains) as these are useful for all Kins.

## Output JSON schema
{
  "name": "string",
  "role": "string",
  "character": "string (markdown)",
  "expertise": "string (markdown)",
  "suggestedModel": "string (model ID)",
  "disableToolDomains": ["string"],
  "enableOptInToolDomains": ["string"]
}`

  let userPrompt: string
  if (refinement && currentConfig) {
    userPrompt = `Current configuration:
${JSON.stringify(currentConfig, null, 2)}

Refinement request: ${refinement}

Update the configuration based on the refinement request. Keep fields that don't need changing. Output the full updated configuration as JSON.`
  } else {
    userPrompt = `User description: ${description}

Generate the complete Kin configuration as JSON.`
  }

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      prompt: userPrompt,
    })

    const genModelId = llmProvider.type === 'anthropic' || llmProvider.type === 'anthropic-oauth'
      ? 'claude-haiku-4-5-20251001'
      : llmProvider.type === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'
    recordUsage({
      callSite: 'kin-generate',
      callType: 'generate-text',
      providerType: llmProvider.type,
      providerId: llmProvider.id,
      modelId: genModelId,
      usage: result.usage,
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
    log.error({ err }, 'Failed to generate Kin configuration')
    const message = err instanceof Error ? err.message : 'Configuration generation failed'
    return c.json(
      { error: { code: 'GENERATION_FAILED', message } },
      502,
    )
  }
})

// POST /api/kins/avatar/preview — generate avatar preview without a kinId (for wizard)
kinRoutes.post('/avatar/preview', async (c) => {
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
    const prompt = await buildAvatarPrompt({
      name,
      role,
      character: character ?? '',
      expertise: expertise ?? '',
    })

    const result = await generateAvatarImage(prompt, {
      providerId: imageProviderId,
      modelId: imageModel,
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

// GET /api/kins/:id/context-usage — context token estimation
// Returns cached values from the last LLM call when available (accurate),
// falls back to a rough estimation for kins that haven't processed a message yet.
kinRoutes.get('/:id/context-usage', async (c) => {
  const kin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!kin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  // Compute compacting proximity (always fresh)
  const { getCompactingProximity } = await import('@/server/services/compacting')
  const compacting = await getCompactingProximity(kin.id)

  // Use cached context usage from the last LLM call if available
  const cached = await getLastContextUsage(kin.id)
  if (cached) {
    return c.json({
      contextTokens: cached.contextTokens,
      apiContextTokens: cached.apiContextTokens ?? null,
      contextWindow: cached.contextWindow,
      contextBreakdown: cached.breakdown ?? null,
      pipelineStatus: cached.pipelineStatus ?? null,
      compactingPercent: compacting.currentPercent,
      compactingThresholdPercent: compacting.thresholdPercent,
      summaryCount: compacting.summaryCount,
      maxSummaries: compacting.maxSummaries,
      summaryTokens: compacting.summaryTokens,
      summaryBudgetTokens: compacting.summaryBudgetTokens,
      keepPercent: compacting.keepPercent,
    })
  }

  // Fallback: rough estimation for kins that haven't processed a message yet
  const contextWindow = getModelContextWindow(kin.model)
  const estimateTokens = (text: string) => Math.ceil(text.length / 4)

  let systemPromptTokens = 0
  systemPromptTokens += estimateTokens([kin.name, kin.role, kin.character, kin.expertise].join(' '))
  systemPromptTokens += 1500

  // Sum active summaries tokens
  const activeSummaries = await db
    .select({ summary: compactingSummaries.summary, lastMessageAt: compactingSummaries.lastMessageAt })
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.kinId, kin.id), eq(compactingSummaries.isInContext, true)))
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
        eq(messages.kinId, kin.id),
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

// GET /api/kins/:id/context-preview — build and return the full system prompt
// Useful for debugging / transparency: shows the actual prompt the LLM would receive.
kinRoutes.get('/:id/context-preview', async (c) => {
  const kin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!kin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const taskId = c.req.query('taskId')
  const sessionId = c.req.query('sessionId')

  if (taskId) {
    const { buildTaskContextPreview } = await import('@/server/services/context-preview')
    const preview = await buildTaskContextPreview(taskId)
    return c.json(preview)
  }

  if (sessionId) {
    const { buildQuickSessionContextPreview } = await import('@/server/services/context-preview')
    const preview = await buildQuickSessionContextPreview(kin.id, sessionId)
    return c.json(preview)
  }

  const { buildContextPreview } = await import('@/server/services/context-preview')
  const preview = await buildContextPreview(kin.id)

  // Augment with the cached API-reported context size (if any) so the
  // visualizer can show ground truth alongside the estimate breakdown.
  const cached = await getLastContextUsage(kin.id)
  if (cached?.apiContextTokens != null) {
    return c.json({
      ...preview,
      apiContextTokens: cached.apiContextTokens,
    })
  }
  return c.json(preview)
})

// ─── Kin CRUD (parameterized routes) ───────────────────────────────────────

// GET /api/kins/:id — get a single kin (accepts UUID or slug)
kinRoutes.get('/:id', async (c) => {
  const kin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!kin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const details = await getKinDetails(kin.id)
  if (!details) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  // Get queue info
  const pendingItems = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.kinId, kin.id))
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
    workspacePath: details.workspacePath,
    toolConfig: details.toolConfig ? JSON.parse(details.toolConfig) : null,
    compactingConfig: details.compactingConfig ? JSON.parse(details.compactingConfig) : null,
    thinkingConfig: details.thinkingConfig ? JSON.parse(details.thinkingConfig) : null,
    mcpServers: details.mcpServers,
    queueSize,
    isProcessing,
    processingStartedAt: processingItem
      ? (processingItem.createdAt instanceof Date ? processingItem.createdAt.getTime() : Number(processingItem.createdAt))
      : undefined,
    isCompacting: compactingKins.has(kin.id),
    createdAt: details.createdAt,
  })
})

// POST /api/kins — create a new kin
kinRoutes.post('/', async (c) => {
  const user = c.get('user') as { id: string }
  const body = await c.req.json()
  let { name, slug, role, character, expertise, model, providerId, mcpServerIds } = body as {
    name: string
    slug?: string
    role: string
    character: string
    expertise: string
    model: string
    providerId?: string | null
    mcpServerIds?: string[]
  }

  // Fall back to default LLM if no model specified
  if (!model || !model.trim()) {
    const defaultModel = await getDefaultLlmModel()
    const defaultProviderId = await getDefaultLlmProviderId()
    if (defaultModel) {
      model = defaultModel
      providerId = providerId ?? defaultProviderId
    }
  }

  const validationError = validateKinFields({ name, role, character, expertise, model, providerId }, 'create')
  if (validationError) {
    return c.json({ error: { code: validationError.code, message: validationError.message } }, 400)
  }

  const newKin = await createKin({
    name,
    slug,
    role,
    character,
    expertise,
    model,
    providerId,
    createdBy: user.id,
    mcpServerIds,
  })

  return c.json(
    {
      kin: {
        id: newKin.id,
        slug: newKin.slug,
        name: newKin.name,
        role: newKin.role,
        avatarUrl: null,
        character: newKin.character,
        expertise: newKin.expertise,
        model: newKin.model,
        providerId: newKin.providerId ?? null,
        workspacePath: newKin.workspacePath,
        mcpServers: [],
        queueSize: 0,
        isProcessing: false,
        createdAt: newKin.createdAt,
      },
    },
    201,
  )
})

// PATCH /api/kins/:id — update a kin (accepts UUID or slug)
kinRoutes.patch('/:id', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const body = await c.req.json()

  const validationError = validateKinFields({
    name: body.name,
    role: body.role,
    character: body.character,
    expertise: body.expertise,
    model: body.model,
    providerId: body.providerId,
  }, 'update')
  if (validationError) {
    return c.json({ error: { code: validationError.code, message: validationError.message } }, 400)
  }

  const result = await updateKin(existing.id, {
    name: body.name,
    role: body.role,
    character: body.character,
    expertise: body.expertise,
    model: body.model,
    providerId: body.providerId,
    slug: body.slug,
    toolConfig: body.toolConfig,
    compactingConfig: body.compactingConfig,
    thinkingConfig: body.thinkingConfig,
    mcpServerIds: body.mcpServerIds,
  })

  if ('error' in result) {
    const statusCode = result.error.code === 'INVALID_SLUG' ? 400 : 409
    return c.json({ error: result.error }, statusCode)
  }

  const { kin: details } = result
  return c.json({
    kin: {
      id: details.id,
      slug: details.slug,
      name: details.name,
      role: details.role,
      avatarUrl: details.avatarUrl,
      character: details.character,
      expertise: details.expertise,
      model: details.model,
      providerId: details.providerId ?? null,
      workspacePath: details.workspacePath,
      toolConfig: details.toolConfig ? JSON.parse(details.toolConfig) : null,
      compactingConfig: details.compactingConfig ? JSON.parse(details.compactingConfig) : null,
      thinkingConfig: details.thinkingConfig ? JSON.parse(details.thinkingConfig) : null,
      mcpServers: details.mcpServers,
      queueSize: 0,
      isProcessing: false,
      createdAt: details.createdAt,
    },
  })
})

// DELETE /api/kins/:id — delete a kin (accepts UUID or slug)
kinRoutes.delete('/:id', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const deleted = await deleteKin(existing.id)
  if (!deleted) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  return c.json({ success: true })
})

// POST /api/kins/:id/avatar — upload avatar (accepts UUID or slug)
kinRoutes.post('/:id/avatar', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
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

  const avatarDir = `${config.upload.dir}/kins/${id}`
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true })
  }

  const ext = file.name.split('.').pop() ?? 'png'
  const filename = `avatar.${ext}`
  const filePath = `${avatarDir}/${filename}`
  const buffer = await file.arrayBuffer()
  await Bun.write(filePath, buffer)

  await db
    .update(kins)
    .set({ avatarPath: filePath, updatedAt: new Date() })
    .where(eq(kins.id, id))

  const avatarUrl = `/api/uploads/kins/${id}/avatar.${ext}?v=${Date.now()}`

  // Notify all clients
  sseManager.broadcast({
    type: 'kin:updated',
    kinId: id,
    data: { kinId: id, avatarUrl },
  })

  return c.json({ avatarUrl })
})

// POST /api/kins/:id/avatar/generate — generate avatar preview (accepts UUID or slug)
kinRoutes.post('/:id/avatar/generate', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const id = existing.id

  const body = await c.req.json()
  const mode = body.mode as string

  const prompt =
    mode === 'auto'
      ? await buildAvatarPrompt({
          name: existing.name,
          role: existing.role,
          character: existing.character ?? '',
          expertise: existing.expertise ?? '',
        })
      : body.prompt

  if (mode === 'prompt' && (!prompt || typeof prompt !== 'string')) {
    return c.json(
      { error: { code: 'INVALID_PROMPT', message: 'A prompt is required for prompt mode' } },
      400,
    )
  }

  try {
    const result = await generateAvatarImage(prompt, {
      providerId: body.imageProviderId,
      modelId: body.imageModel,
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

// ─── Tool authorization routes ────────────────────────────────────────────────

// GET /api/kins/:id/tools — list all available tools with enabled/disabled state
kinRoutes.get('/:id/tools', async (c) => {
  const kin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!kin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const toolConfig: KinToolConfig | null = kin.toolConfig
    ? JSON.parse(kin.toolConfig)
    : null

  // Native tools grouped by domain
  const allNative = toolRegistry.list()
  const domainGroupsMap = new Map<ToolDomain, Array<{ name: string; enabled: boolean; defaultDisabled: boolean }>>()

  for (const t of allNative) {
    const domain = TOOL_DOMAIN_MAP[t.name]
    if (!domain) continue
    if (!domainGroupsMap.has(domain)) domainGroupsMap.set(domain, [])

    // Compute enabled state based on opt-in vs deny-list model
    let enabled: boolean
    if (t.defaultDisabled) {
      // Opt-in tool: enabled only if explicitly listed in enabledOptInTools
      enabled = toolConfig?.enabledOptInTools?.includes(t.name) ?? false
    } else {
      // Standard tool: enabled unless in disabledNativeTools
      enabled = !toolConfig?.disabledNativeTools?.includes(t.name)
    }

    domainGroupsMap.get(domain)!.push({ name: t.name, enabled, defaultDisabled: t.defaultDisabled })
  }

  const nativeTools = Array.from(domainGroupsMap.entries()).map(([domain, tools]) => ({
    domain,
    tools,
  }))

  // MCP tools with enabled state
  const mcpTools = await getMCPToolsForConfig(kin.id, toolConfig)

  log.debug({ kinId: kin.id, nativeCount: nativeTools.length, mcpCount: mcpTools.length }, 'GET /tools response')

  return c.json({ nativeTools, mcpTools })
})

// ─── Compacting routes ───────────────────────────────────────────────────────

// POST /api/kins/:id/compacting/run — force compaction immediately
kinRoutes.post('/:id/compacting/run', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const { runCompacting } = await import('@/server/services/compacting')

  sseManager.sendToKin(existing.id, {
    type: 'compacting:start',
    kinId: existing.id,
    data: { kinId: existing.id, cycle: 1, estimatedTotal: 1 },
  })

  let result: Awaited<ReturnType<typeof runCompacting>>
  try {
    result = await runCompacting(existing.id)
  } catch (err) {
    // runCompacting already emits compacting:error via SSE and persists the error message
    return c.json({ error: { code: 'COMPACTING_FAILED', message: err instanceof Error ? err.message : 'Compacting failed' } }, 500)
  }

  if (!result) {
    // Persist error in conversation history
    await db.insert(messages).values({
      id: crypto.randomUUID(),
      kinId: existing.id,
      role: 'system',
      content: '',
      sourceType: 'compacting',
      isRedacted: false,
      redactPending: false,
      metadata: JSON.stringify({ error: 'NOTHING_TO_COMPACT' }),
      createdAt: new Date(),
    })
    sseManager.sendToKin(existing.id, {
      type: 'compacting:error',
      kinId: existing.id,
      data: { kinId: existing.id, error: 'NOTHING_TO_COMPACT' },
    })
    return c.json({ error: { code: 'NOTHING_TO_COMPACT', message: 'Not enough messages to compact' } }, 422)
  }

  return c.json({ success: true, summary: result.summary, memoriesExtracted: result.memoriesExtracted })
})

// POST /api/kins/:id/compacting/purge — deactivate all active summaries
kinRoutes.post('/:id/compacting/purge', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = existing.id

  await db
    .update(compactingSummaries)
    .set({ isInContext: false })
    .where(and(eq(compactingSummaries.kinId, kinId), eq(compactingSummaries.isInContext, true)))

  return c.json({ success: true })
})

// GET /api/kins/:id/compacting/summaries — list summaries
kinRoutes.get('/:id/compacting/summaries', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = existing.id

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
    .where(eq(compactingSummaries.kinId, kinId))
    .orderBy(desc(compactingSummaries.createdAt))
    .all()

  return c.json({ summaries })
})

// Keep the old route as an alias for backwards compatibility
kinRoutes.get('/:id/compacting/snapshots', async (c) => {
  // Redirect internally to the new summaries route
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = existing.id

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
    .where(eq(compactingSummaries.kinId, kinId))
    .orderBy(desc(compactingSummaries.createdAt))
    .all()

  // Map to old format for backwards compat
  return c.json({ snapshots: summaries.map((s) => ({ id: s.id, messagesUpToId: s.lastMessageId, isActive: s.isInContext, createdAt: s.createdAt })) })
})

// POST /api/kins/:id/compacting/rollback — archive summaries after a chosen one
kinRoutes.post('/:id/compacting/rollback', async (c) => {
  const resolvedKin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!resolvedKin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = resolvedKin.id
  const body = (await c.req.json()) as { summaryId?: string; snapshotId?: string }
  const summaryId = body.summaryId ?? body.snapshotId // support both old and new param name

  if (!summaryId) {
    return c.json({ error: { code: 'MISSING_PARAM', message: 'summaryId is required' } }, 400)
  }

  const summary = await db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.id, summaryId), eq(compactingSummaries.kinId, kinId)))
    .get()

  if (!summary) {
    return c.json({ error: { code: 'SUMMARY_NOT_FOUND', message: 'Summary not found' } }, 404)
  }

  // Archive all summaries created after the chosen one
  const allSummaries = await db
    .select({ id: compactingSummaries.id, createdAt: compactingSummaries.createdAt })
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.kinId, kinId), eq(compactingSummaries.isInContext, true)))
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

// GET /api/kins/:id/memories — list memories
kinRoutes.get('/:id/memories', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = existing.id
  const category = c.req.query('category')
  const subject = c.req.query('subject')
  const scope = c.req.query('scope')
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 200)
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0)

  const conditions = [eq(memories.kinId, kinId)]
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
        kinId: memories.kinId,
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

// DELETE /api/kins/:id/memories/:memoryId — delete a memory
kinRoutes.delete('/:id/memories/:memoryId', async (c) => {
  const resolvedKin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!resolvedKin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = resolvedKin.id
  const memoryId = c.req.param('memoryId')

  const deleted = await deleteMemory(memoryId, kinId)
  if (!deleted) {
    return c.json({ error: { code: 'MEMORY_NOT_FOUND', message: 'Memory not found' } }, 404)
  }

  return c.json({ success: true })
})

// POST /api/kins/:id/memories — create a memory
kinRoutes.post('/:id/memories', async (c) => {
  const existing = resolveKinByIdOrSlug(c.req.param('id'))
  if (!existing) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = existing.id
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

  const memory = await createMemory(kinId, {
    content,
    category: category as MemoryCategory,
    subject: subject ?? null,
    sourceChannel: 'explicit',
    scope: (scope === 'shared' ? 'shared' : 'private') as MemoryScope,
  })

  return c.json({
    memory: {
      id: memory!.id,
      kinId: memory!.kinId,
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

// PATCH /api/kins/:id/memories/:memoryId — update a memory
kinRoutes.patch('/:id/memories/:memoryId', async (c) => {
  const resolvedKin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!resolvedKin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }
  const kinId = resolvedKin.id
  const memoryId = c.req.param('memoryId')
  const body = (await c.req.json()) as {
    content?: string
    category?: string
    subject?: string | null
    scope?: string
  }

  const updated = await updateMemory(memoryId, kinId, {
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
      kinId: updated.kinId,
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

// GET /api/kins/:id/export — export a Kin's configuration as JSON
kinRoutes.get('/:id/export', async (c) => {
  const kin = resolveKinByIdOrSlug(c.req.param('id'))
  if (!kin) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  const details = await getKinDetails(kin.id)
  if (!details) {
    return c.json({ error: { code: 'KIN_NOT_FOUND', message: 'Kin not found' } }, 404)
  }

  // Get MCP server details for this kin
  const kinMcpRows = await db
    .select({ serverId: kinMcpServers.mcpServerId })
    .from(kinMcpServers)
    .where(eq(kinMcpServers.kinId, kin.id))
    .all()

  const mcpServerDetails = kinMcpRows.length > 0
    ? await Promise.all(
        kinMcpRows.map(async (row) => {
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
    _kinbot: {
      version: 1,
      exportedAt: new Date().toISOString(),
    },
    name: details.name,
    role: details.role,
    character: details.character,
    expertise: details.expertise,
    model: details.model,
    toolConfig: details.toolConfig ? JSON.parse(details.toolConfig) : null,
    compactingConfig: details.compactingConfig ? JSON.parse(details.compactingConfig) : null,
    thinkingConfig: details.thinkingConfig ? JSON.parse(details.thinkingConfig) : null,
    mcpServers: mcpServerDetails,
  }

  const filename = `${details.slug || details.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.kinbot.json`

  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  c.header('Content-Type', 'application/json')
  return c.json(exportData)
})

// POST /api/kins/import — create a new Kin from an exported JSON config
kinRoutes.post('/import', async (c) => {
  const user = c.get('user') as { id: string }
  const body = await c.req.json()

  // Validate required fields
  const { name, role, character, expertise, model, toolConfig, thinkingConfig } = body as {
    name?: string
    role?: string
    character?: string
    expertise?: string
    model?: string
    toolConfig?: KinToolConfig | null
    thinkingConfig?: KinThinkingConfig | null
    _kinbot?: { version?: number }
  }

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
      const pConfig = JSON.parse(await decrypt(p.configEncrypted))
      const pModels = await listModelsForProvider(p.type, pConfig)
      if (pModels.some((m) => m.id === model)) {
        modelFound = true
        break
      }
    } catch {
      // Skip provider on error
    }
  }
  if (!modelFound) {
    warnings.push(`Model '${model}' is not available in your configured providers. You may need to update the Kin's model after import.`)
  }

  const newKin = await createKin({
    name,
    role,
    character,
    expertise,
    model,
    createdBy: user.id,
  })

  // Apply toolConfig and thinkingConfig if present
  if (toolConfig || thinkingConfig) {
    await updateKin(newKin.id, {
      ...(toolConfig ? { toolConfig } : {}),
      ...(thinkingConfig ? { thinkingConfig } : {}),
    })
  }

  return c.json(
    {
      kin: {
        id: newKin.id,
        slug: newKin.slug,
        name: newKin.name,
        role: newKin.role,
        avatarUrl: null,
        character: newKin.character,
        expertise: newKin.expertise,
        model: newKin.model,
        providerId: newKin.providerId ?? null,
        workspacePath: newKin.workspacePath,
        mcpServers: [],
        queueSize: 0,
        isProcessing: false,
        createdAt: newKin.createdAt,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    201,
  )
})

export { kinRoutes }
