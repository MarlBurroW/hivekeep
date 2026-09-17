import { eq, and, not, inArray, or } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { db, sqlite } from '@/server/db/index'
import {
  agents,
  agentMcpServers,
  mcpServers,
  queueItems,
  compactingSnapshots,
  compactingSummaries,
  memories,
  messages,
  contactNotes,
  tasks,
  crons,
  files,
  webhooks,
  humanPrompts,
  channels,
  fileStorage,
  vaultSecrets,
  scheduledWakeups,
  miniApps,
  quickSessions,
  providers,
  secretPrompts,
  pendingEmailSends,
  accountTriggers,
} from '@/server/db/schema'
import { config } from '@/server/config'
import { deleteVectorRows } from '@/server/services/vector-maintenance'
import { generateSlug, ensureUniqueSlug, isValidSlug } from '@/server/utils/slug'
import { sseManager } from '@/server/sse/index'
import {
  generateAvatarImage,
  buildAvatarPrompt,
  isImg2imgEnabled,
  resolveImageTarget,
  getMaxImageInputs,
  getBaseAvatarBytes,
  ImageGenerationError,
} from '@/server/services/image-generation'
import { createLogger } from '@/server/logger'
import { deleteChannel } from '@/server/services/channels'
import { stopJob } from '@/server/services/crons'
import { resolveThinkingConfig } from '@/server/services/agent-engine'
import type { AgentCompactingConfig, AgentKind, AgentThinkingConfig } from '@/shared/types'

const log = createLogger('services:agents')

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateAgentInput {
  name: string
  slug?: string
  role: string
  character: string
  expertise: string
  model: string
  providerId?: string | null
  /** Optional cheap scout model for the `scout` tool. Coupled with
   *  `scoutProviderId` — the service stores both or neither (a partial pair is
   *  treated as "no scout override"). */
  scoutModel?: string | null
  scoutProviderId?: string | null
  /** Optional reasoning config for this Agent's scouts (one tier of
   *  resolveScoutThinking()'s chain). Null/undefined = unset. */
  scoutThinkingConfig?: AgentThinkingConfig | null
  createdBy: string | null
  mcpServerIds?: string[]
  /** Optional toolbox selection. Null/empty → 'all' built-in at resolution. */
  toolboxIds?: string[] | null
  /** Agent kind. Defaults to 'regular'. Set to 'configurator' only when seeding
   *  the onboarding guide (Queenie). See queenie.md. */
  kind?: AgentKind
}

export interface UpdateAgentInput {
  name?: string
  role?: string
  character?: string
  expertise?: string
  model?: string
  providerId?: string | null
  /** Cheap scout model for the `scout` tool. Coupled with `scoutProviderId`:
   *  pass both (set the override) or pass null/null (clear it). A partial pair
   *  is normalized to "cleared". */
  scoutModel?: string | null
  scoutProviderId?: string | null
  /** Reasoning config for this Agent's scouts. Null clears (unset tier). */
  scoutThinkingConfig?: AgentThinkingConfig | null
  slug?: string
  /** JSON-serialized array of toolbox ids. Null/empty → 'all' built-in at
   *  resolution. The toolbox is the sole tool-grant primitive. */
  toolboxIds?: string[] | null
  extraToolNames?: string[] | null
  compactingConfig?: AgentCompactingConfig | null
  thinkingConfig?: AgentThinkingConfig | null
  mcpServerIds?: string[]
}

export interface AgentRecord {
  id: string
  slug: string | null
  name: string
  role: string
  avatarPath: string | null
  character: string
  expertise: string
  kind: AgentKind
  model: string
  providerId: string | null
  scoutModel: string | null
  scoutProviderId: string | null
  scoutThinkingConfig: string | null
  workspacePath: string
  toolboxIds: string | null
  extraToolNames: string | null
  compactingConfig: string | null
  thinkingConfig: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface AgentDetails extends AgentRecord {
  avatarUrl: string | null
  mcpServers: Array<{ id: string; name: string }>
}

// ─── Validation & Helpers ───────────────────────────────────────────────────
// validateAgentFields, agentAvatarUrl → @/server/services/field-validator

// ─── Create ─────────────────────────────────────────────────────────────────

export async function createAgent(input: CreateAgentInput): Promise<AgentRecord> {
  const id = uuid()
  const workspacePath = `${config.workspace.baseDir}/${id}`

  // Generate unique slug from name (or use provided slug)
  const existingSlugs = new Set(
    (await db.select({ slug: agents.slug }).from(agents).all())
      .map((k) => k.slug)
      .filter((s): s is string => s != null),
  )
  const baseSlug = input.slug?.trim() ? generateSlug(input.slug) || generateSlug(input.name) || 'agent' : generateSlug(input.name) || 'agent'
  const slug = ensureUniqueSlug(baseSlug, existingSlugs)

  // Create workspace directory
  mkdirSync(workspacePath, { recursive: true })
  mkdirSync(`${workspacePath}/tools`, { recursive: true })

  // Scout model/provider are coupled: store both or neither. A partial pair
  // collapses to "no scout override" (the resolver then falls through to the
  // project / global / main-model tiers).
  const scoutModelSet =
    input.scoutModel !== undefined && input.scoutModel !== null && input.scoutModel.trim() !== ''
  const scoutProviderSet =
    input.scoutProviderId !== undefined && input.scoutProviderId !== null && input.scoutProviderId.trim() !== ''
  const scoutPaired = scoutModelSet && scoutProviderSet

  const now = new Date()
  try {
    await db.insert(agents).values({
      id,
      slug,
      name: input.name,
      role: input.role,
      character: input.character,
      expertise: input.expertise,
      kind: input.kind ?? 'regular',
      model: input.model,
      providerId: input.providerId ?? null,
      scoutModel: scoutPaired ? input.scoutModel!.trim() : null,
      scoutProviderId: scoutPaired ? input.scoutProviderId! : null,
      scoutThinkingConfig: input.scoutThinkingConfig ? JSON.stringify(input.scoutThinkingConfig) : null,
      workspacePath,
      toolboxIds: input.toolboxIds && input.toolboxIds.length > 0 ? JSON.stringify(input.toolboxIds) : null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    log.error({ agentId: id, name: input.name, createdBy: input.createdBy, providerId: input.providerId ?? null, err }, 'Failed to insert agent')
    throw err
  }

  log.info({ agentId: id, name: input.name, slug }, 'Agent created')

  // Link MCP servers if provided
  if (input.mcpServerIds && input.mcpServerIds.length > 0) {
    for (const mcpServerId of input.mcpServerIds) {
      await db.insert(agentMcpServers).values({ agentId: id, mcpServerId })
    }
  }

  // Broadcast creation — agent:created so clients add the new entry to their list
  sseManager.broadcast({
    type: 'agent:created',
    agentId: id,
    data: {
      agentId: id,
      slug,
      name: input.name,
      role: input.role,
      kind: input.kind ?? 'regular',
      model: input.model,
      providerId: input.providerId ?? null,
      avatarUrl: null,
      createdAt: now.toISOString(),
    },
  })

  return db.select().from(agents).where(eq(agents.id, id)).get()!
}

// ─── Update ─────────────────────────────────────────────────────────────────

export type UpdateAgentError = { code: 'INVALID_SLUG' | 'SLUG_TAKEN'; message: string }

export async function updateAgent(
  agentId: string,
  input: UpdateAgentInput,
): Promise<{ agent: AgentDetails } | { error: UpdateAgentError }> {
  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (input.name !== undefined) updates.name = input.name
  if (input.role !== undefined) updates.role = input.role
  if (input.character !== undefined) updates.character = input.character
  if (input.expertise !== undefined) updates.expertise = input.expertise
  if (input.model !== undefined) updates.model = input.model
  if (input.providerId !== undefined) updates.providerId = input.providerId
  // Scout model/provider are coupled: setting requires both non-empty strings;
  // an explicit null on either side (or a partial pair) clears both. Only
  // touched when at least one of the two keys is present in the input.
  if (input.scoutModel !== undefined || input.scoutProviderId !== undefined) {
    const m = typeof input.scoutModel === 'string' ? input.scoutModel.trim() : null
    const p = typeof input.scoutProviderId === 'string' ? input.scoutProviderId.trim() : null
    if (m && p) {
      updates.scoutModel = m
      updates.scoutProviderId = p
    } else {
      updates.scoutModel = null
      updates.scoutProviderId = null
    }
  }
  if (input.extraToolNames !== undefined) {
    updates.extraToolNames =
      input.extraToolNames && input.extraToolNames.length > 0 ? JSON.stringify(input.extraToolNames) : null
  }
  if (input.toolboxIds !== undefined) {
    // Null/empty → store null so resolution falls back to the 'all' built-in.
    updates.toolboxIds = input.toolboxIds && input.toolboxIds.length > 0 ? JSON.stringify(input.toolboxIds) : null
  }
  if (input.scoutThinkingConfig !== undefined) updates.scoutThinkingConfig = input.scoutThinkingConfig ? JSON.stringify(input.scoutThinkingConfig) : null
  if (input.compactingConfig !== undefined) updates.compactingConfig = input.compactingConfig ? JSON.stringify(input.compactingConfig) : null
  if (input.thinkingConfig !== undefined) updates.thinkingConfig = input.thinkingConfig ? JSON.stringify(input.thinkingConfig) : null

  // Handle slug update
  if (input.slug !== undefined) {
    const newSlug = input.slug
    if (!isValidSlug(newSlug)) {
      return { error: { code: 'INVALID_SLUG', message: 'Slug must be 2-50 chars, lowercase alphanumeric and hyphens' } }
    }
    const conflict = db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.slug, newSlug), not(eq(agents.id, agentId))))
      .get()
    if (conflict) {
      return { error: { code: 'SLUG_TAKEN', message: 'This slug is already in use' } }
    }
    updates.slug = newSlug
  }

  await db.update(agents).set(updates).where(eq(agents.id, agentId))

  // Update MCP server links if provided explicitly
  if (input.mcpServerIds !== undefined) {
    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId))
    for (const mcpServerId of input.mcpServerIds) {
      await db.insert(agentMcpServers).values({ agentId, mcpServerId })
    }
  }

  const details = await getAgentDetails(agentId)
  if (!details) {
    // Should not happen since we just updated it
    throw new Error('Agent not found after update')
  }

  log.debug({ agentId, updatedFields: Object.keys(updates).filter((k) => k !== 'updatedAt') }, 'Agent updated')

  // Notify all clients
  const resolvedThinking = resolveThinkingConfig(details.thinkingConfig)
  sseManager.broadcast({
    type: 'agent:updated',
    agentId,
    data: {
      agentId,
      slug: details.slug,
      name: details.name,
      role: details.role,
      avatarUrl: details.avatarUrl,
      providerId: details.providerId,
      thinkingEnabled: resolvedThinking.enabled === true,
      thinkingEffort: resolvedThinking.effort ?? null,
    },
  })

  return { agent: details }
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteAgent(agentId: string): Promise<boolean> {
  const existing = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!existing) return false

  // Gather IDs of tasks and crons belonging to this agent to handle cross-agent FK references
  const agentTaskIds = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentAgentId, agentId)).all().map((t) => t.id)
  const agentCronIds = db.select({ id: crons.id }).from(crons).where(eq(crons.agentId, agentId)).all().map((c) => c.id)
  const agentWebhookIds = db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.agentId, agentId)).all().map((w) => w.id)
  const agentChannelIds = db.select({ id: channels.id }).from(channels).where(eq(channels.agentId, agentId)).all().map((ch) => ch.id)
  const agentMemoryIds = db.select({ id: memories.id }).from(memories).where(eq(memories.agentId, agentId)).all().map((m) => m.id)
  const agentMiniAppIds = db.select({ id: miniApps.id }).from(miniApps).where(eq(miniApps.agentId, agentId)).all().map((a) => a.id)

  // Gather cross-agent entities whose FK references will be nullified (for SSE notifications)
  const affectedCronIds = db.select({ id: crons.id, cronAgentId: crons.agentId }).from(crons).where(eq(crons.targetAgentId, agentId)).all()
  const affectedMcpServerIds = db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.createdByAgentId, agentId)).all().map((m) => m.id)

  const agentQuickSessionIds = db.select({ id: quickSessions.id }).from(quickSessions).where(eq(quickSessions.agentId, agentId)).all().map((s) => s.id)

  // In-memory / external cleanup that must precede row deletion.
  // Stop in-memory cron scheduler jobs before deleting from DB (fixes #168)
  for (const cronId of agentCronIds) {
    stopJob(cronId)
  }
  // Delete channels with full cleanup (stop adapters, delete vault secrets).
  // Runs before the transaction because it is async with external side
  // effects; any row it fails to remove is swept by the fallback delete below.
  for (const channelId of agentChannelIds) {
    try {
      await deleteChannel(channelId)
    } catch (err) {
      log.warn({ channelId, agentId, err }, 'Failed to delete channel during agent cascade delete')
    }
  }

  // Every row mutation in ONE transaction: the cascade spans ~30 statements
  // and a crash (or an FK failure) mid-way used to leave a permanently
  // half-deleted agent whose retry could never succeed.
  const txn = sqlite.transaction(() => {
    // Leaves first. Prompt cards reference both the agent and its tasks.
    db.delete(humanPrompts).where(eq(humanPrompts.agentId, agentId)).run()
    db.delete(secretPrompts).where(eq(secretPrompts.agentId, agentId)).run()
    if (agentTaskIds.length > 0) {
      db.delete(humanPrompts).where(inArray(humanPrompts.taskId, agentTaskIds)).run()
      db.delete(secretPrompts).where(inArray(secretPrompts.taskId, agentTaskIds)).run()
    }
    db.delete(pendingEmailSends).where(eq(pendingEmailSends.agentId, agentId)).run()
    db.delete(accountTriggers).where(eq(accountTriggers.targetAgentId, agentId)).run()
    db.delete(files).where(eq(files.agentId, agentId)).run()
    db.delete(compactingSnapshots).where(eq(compactingSnapshots.agentId, agentId)).run()
    db.delete(compactingSummaries).where(eq(compactingSummaries.agentId, agentId)).run()
    db.delete(memories).where(eq(memories.agentId, agentId)).run()

    // Null out cross-agent references before deleting tasks and crons
    if (agentTaskIds.length > 0) {
      db.update(queueItems).set({ taskId: null }).where(inArray(queueItems.taskId, agentTaskIds)).run()
      db.update(messages).set({ taskId: null }).where(inArray(messages.taskId, agentTaskIds)).run()
      db.update(tasks).set({ parentTaskId: null }).where(inArray(tasks.parentTaskId, agentTaskIds)).run()
    }
    if (agentCronIds.length > 0) {
      db.update(tasks).set({ cronId: null }).where(inArray(tasks.cronId, agentCronIds)).run()
    }

    db.delete(queueItems).where(eq(queueItems.agentId, agentId)).run()

    if (agentQuickSessionIds.length > 0) {
      // Null out session references in messages (including other agents' messages)
      db.update(messages).set({ sessionId: null }).where(inArray(messages.sessionId, agentQuickSessionIds)).run()
    }

    db.delete(messages).where(eq(messages.agentId, agentId)).run()
    db.delete(quickSessions).where(eq(quickSessions.agentId, agentId)).run()
    db.update(tasks).set({ parentTaskId: null }).where(eq(tasks.parentAgentId, agentId)).run()
    db.delete(tasks).where(eq(tasks.parentAgentId, agentId)).run()
    db.update(tasks).set({ sourceAgentId: null }).where(eq(tasks.sourceAgentId, agentId)).run()
    db.update(crons).set({ targetAgentId: null }).where(eq(crons.targetAgentId, agentId)).run()
    db.delete(crons).where(eq(crons.agentId, agentId)).run()
    db.delete(contactNotes).where(eq(contactNotes.agentId, agentId)).run()
    // Custom tools are GLOBAL now (not per-Agent) — nothing to cascade-delete here.
    db.delete(webhooks).where(eq(webhooks.agentId, agentId)).run()
    // Fallback for any channel row deleteChannel() above failed to remove.
    db.delete(channels).where(eq(channels.agentId, agentId)).run()
    db.delete(fileStorage).where(eq(fileStorage.agentId, agentId)).run()
    db.update(fileStorage).set({ createdByAgentId: null }).where(eq(fileStorage.createdByAgentId, agentId)).run()
    db.update(vaultSecrets).set({ createdByAgentId: null }).where(eq(vaultSecrets.createdByAgentId, agentId)).run()
    db.update(mcpServers).set({ createdByAgentId: null }).where(eq(mcpServers.createdByAgentId, agentId)).run()
    db.delete(agentMcpServers).where(eq(agentMcpServers.agentId, agentId)).run()
    db.delete(miniApps).where(eq(miniApps.agentId, agentId)).run()
    db.delete(scheduledWakeups).where(
      or(eq(scheduledWakeups.callerAgentId, agentId), eq(scheduledWakeups.targetAgentId, agentId)),
    ).run()

    // The vec virtual tables have no FK/trigger sync (unlike FTS): rows must
    // be removed explicitly or they poison KNN search and dedup forever.
    deleteVectorRows('memories_vec', 'memory_id', agentMemoryIds)

    // Delete the agent (remaining child tables cascade or SET NULL via FKs)
    db.delete(agents).where(eq(agents.id, agentId)).run()
  })
  txn()

  // Remove workspace directory
  if (existing.workspacePath && existsSync(existing.workspacePath)) {
    rmSync(existing.workspacePath, { recursive: true, force: true })
  }

  // Close any browser sessions owned by this Agent AND remove its saved states
  // (best-effort, non-blocking)
  import('@/server/services/playwright-manager')
    .then(async ({ playwrightManager }) => {
      await playwrightManager.closeSessionsForAgent(agentId, 'agent_deleted')
      await playwrightManager.deleteAllSavedStatesForAgent(agentId)
    })
    .catch((err) => log.warn({ agentId, err }, 'Failed to clean up browser resources for deleted agent'))

  // Drop in-memory + persisted context usage cache for this Agent so it doesn't
  // leak across deployments with high Agent churn (lastContextUsage map keeps
  // growing, plus the orphan app_settings row context_usage:<agentId> stays
  // forever otherwise).
  import('@/server/services/agent-engine')
    .then(({ clearAgentContextUsage }) => clearAgentContextUsage(agentId))
    .catch((err) => log.warn({ agentId, err }, 'Failed to clear context usage cache for deleted agent'))

  log.info({ agentId, name: existing.name, slug: existing.slug }, 'Agent deleted')

  // Notify all clients about cascade-deleted children first, then the agent itself
  for (const taskId of agentTaskIds) {
    sseManager.broadcast({ type: 'task:deleted', agentId, data: { taskId, agentId } })
  }
  for (const cronId of agentCronIds) {
    sseManager.broadcast({ type: 'cron:deleted', agentId, data: { cronId, agentId } })
  }
  for (const webhookId of agentWebhookIds) {
    sseManager.broadcast({ type: 'webhook:deleted', agentId, data: { webhookId, agentId } })
  }
  // Note: channel:deleted SSE events are already emitted by deleteChannel() above
  for (const memoryId of agentMemoryIds) {
    sseManager.broadcast({ type: 'memory:deleted', agentId, data: { memoryId, agentId } })
  }
  for (const appId of agentMiniAppIds) {
    sseManager.broadcast({ type: 'miniapp:deleted', agentId, data: { appId, agentId } })
  }

  // Notify about cross-agent entities whose FK references were nullified
  for (const cron of affectedCronIds) {
    sseManager.broadcast({ type: 'cron:updated', agentId: cron.cronAgentId, data: { cronId: cron.id, agentId: cron.cronAgentId, targetAgentId: null } })
  }
  for (const mcpServerId of affectedMcpServerIds) {
    sseManager.broadcast({ type: 'mcp-server:updated', data: { mcpServerId, createdByAgentId: null } })
  }

  sseManager.broadcast({
    type: 'agent:deleted',
    agentId,
    data: { agentId },
  })

  return true
}

// ─── Get Details ────────────────────────────────────────────────────────────

export async function getAgentDetails(agentId: string): Promise<AgentDetails | null> {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  const mcpLinks = await db
    .select({ id: mcpServers.id, name: mcpServers.name })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
    .where(eq(agentMcpServers.agentId, agentId))
    .all()

  return {
    ...agent,
    avatarUrl: agent.avatarPath
      ? `/api/uploads/agents/${agentId}/avatar.${agent.avatarPath.split('.').pop() ?? 'png'}?v=${agent.updatedAt ? agent.updatedAt.getTime() : Date.now()}`
      : null,
    mcpServers: mcpLinks,
  }
}

// ─── Avatar Generation ──────────────────────────────────────────────────────

export async function generateAndSaveAvatar(agentId: string): Promise<string | null> {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get()
  if (!agent) return null

  // Resolve the default image target up front so we know whether the model
  // supports image-to-image — this dictates both the prompt style and whether
  // we attach the base robot reference image.
  let target
  try {
    target = await resolveImageTarget()
  } catch (err) {
    if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
      log.warn({ agentId }, 'No image provider configured — skipping avatar generation')
      return null
    }
    throw err
  }

  // img2img edit transforms the neutral base image; gated by the global
  // avatar_base_enabled setting (off → always text-to-image).
  const maxImageInputs = await getMaxImageInputs(target.providerId, target.modelId)
  const supportsEdit = maxImageInputs > 0 && (await isImg2imgEnabled())

  const prompt = await buildAvatarPrompt(
    {
      name: agent.name,
      role: agent.role,
      character: agent.character ?? '',
      expertise: agent.expertise ?? '',
    },
    supportsEdit ? 'edit' : 'generate',
    { targetModelId: target.modelId, maxImageInputs },
  )

  const result = await generateAvatarImage(prompt, {
    providerId: target.providerId,
    modelId: target.modelId,
    ...(supportsEdit ? { imageDatas: [await getBaseAvatarBytes()] } : {}),
  })

  // Determine file extension from media type
  const ext = result.mediaType.includes('png') ? 'png' : 'webp'

  // Save to filesystem
  const avatarDir = `${config.upload.dir}/agents/${agentId}`
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true })
  }
  const filePath = `${avatarDir}/avatar.${ext}`
  const buffer = Buffer.from(result.base64, 'base64')
  await Bun.write(filePath, buffer)

  // Update DB
  await db
    .update(agents)
    .set({ avatarPath: filePath, updatedAt: new Date() })
    .where(eq(agents.id, agentId))

  const avatarUrl = `/api/uploads/agents/${agentId}/avatar.${ext}?v=${Date.now()}`

  // Notify clients
  sseManager.broadcast({
    type: 'agent:updated',
    agentId,
    data: { agentId, avatarUrl },
  })

  log.info({ agentId, avatarUrl }, 'Avatar generated and saved')

  return avatarUrl
}
