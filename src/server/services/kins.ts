import { eq, and, not, inArray, or } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { db } from '@/server/db/index'
import {
  kins,
  kinMcpServers,
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
} from '@/server/db/schema'
import { config } from '@/server/config'
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
import { resolveThinkingConfig } from '@/server/services/kin-engine'
import type { KinCompactingConfig, KinKind, KinThinkingConfig } from '@/shared/types'

const log = createLogger('services:kins')

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CreateKinInput {
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
  createdBy: string | null
  mcpServerIds?: string[]
  /** Optional toolbox selection. Null/empty → 'all' built-in at resolution. */
  toolboxIds?: string[] | null
  /** Kin kind. Defaults to 'regular'. Set to 'configurator' only when seeding
   *  the onboarding guide (Sherpa). See sherpa.md. */
  kind?: KinKind
}

export interface UpdateKinInput {
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
  slug?: string
  /** JSON-serialized array of toolbox ids. Null/empty → 'all' built-in at
   *  resolution. The toolbox is the sole tool-grant primitive. */
  toolboxIds?: string[] | null
  compactingConfig?: KinCompactingConfig | null
  thinkingConfig?: KinThinkingConfig | null
  mcpServerIds?: string[]
}

export interface KinRecord {
  id: string
  slug: string | null
  name: string
  role: string
  avatarPath: string | null
  character: string
  expertise: string
  kind: KinKind
  model: string
  providerId: string | null
  scoutModel: string | null
  scoutProviderId: string | null
  workspacePath: string
  toolboxIds: string | null
  compactingConfig: string | null
  thinkingConfig: string | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

export interface KinDetails extends KinRecord {
  avatarUrl: string | null
  mcpServers: Array<{ id: string; name: string }>
}

// ─── Validation & Helpers ───────────────────────────────────────────────────
// validateKinFields, kinAvatarUrl → @/server/services/field-validator

// ─── Create ─────────────────────────────────────────────────────────────────

export async function createKin(input: CreateKinInput): Promise<KinRecord> {
  const id = uuid()
  const workspacePath = `${config.workspace.baseDir}/${id}`

  // Generate unique slug from name (or use provided slug)
  const existingSlugs = new Set(
    (await db.select({ slug: kins.slug }).from(kins).all())
      .map((k) => k.slug)
      .filter((s): s is string => s != null),
  )
  const baseSlug = input.slug?.trim() ? generateSlug(input.slug) || generateSlug(input.name) || 'kin' : generateSlug(input.name) || 'kin'
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
    await db.insert(kins).values({
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
      workspacePath,
      toolboxIds: input.toolboxIds && input.toolboxIds.length > 0 ? JSON.stringify(input.toolboxIds) : null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
  } catch (err) {
    log.error({ kinId: id, name: input.name, createdBy: input.createdBy, providerId: input.providerId ?? null, err }, 'Failed to insert kin')
    throw err
  }

  log.info({ kinId: id, name: input.name, slug }, 'Kin created')

  // Link MCP servers if provided
  if (input.mcpServerIds && input.mcpServerIds.length > 0) {
    for (const mcpServerId of input.mcpServerIds) {
      await db.insert(kinMcpServers).values({ kinId: id, mcpServerId })
    }
  }

  // Broadcast creation — kin:created so clients add the new entry to their list
  sseManager.broadcast({
    type: 'kin:created',
    kinId: id,
    data: {
      kinId: id,
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

  return db.select().from(kins).where(eq(kins.id, id)).get()!
}

// ─── Update ─────────────────────────────────────────────────────────────────

export type UpdateKinError = { code: 'INVALID_SLUG' | 'SLUG_TAKEN'; message: string }

export async function updateKin(
  kinId: string,
  input: UpdateKinInput,
): Promise<{ kin: KinDetails } | { error: UpdateKinError }> {
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
  if (input.toolboxIds !== undefined) {
    // Null/empty → store null so resolution falls back to the 'all' built-in.
    updates.toolboxIds = input.toolboxIds && input.toolboxIds.length > 0 ? JSON.stringify(input.toolboxIds) : null
  }
  if (input.compactingConfig !== undefined) updates.compactingConfig = input.compactingConfig ? JSON.stringify(input.compactingConfig) : null
  if (input.thinkingConfig !== undefined) updates.thinkingConfig = input.thinkingConfig ? JSON.stringify(input.thinkingConfig) : null

  // Handle slug update
  if (input.slug !== undefined) {
    const newSlug = input.slug
    if (!isValidSlug(newSlug)) {
      return { error: { code: 'INVALID_SLUG', message: 'Slug must be 2-50 chars, lowercase alphanumeric and hyphens' } }
    }
    const conflict = db
      .select({ id: kins.id })
      .from(kins)
      .where(and(eq(kins.slug, newSlug), not(eq(kins.id, kinId))))
      .get()
    if (conflict) {
      return { error: { code: 'SLUG_TAKEN', message: 'This slug is already in use' } }
    }
    updates.slug = newSlug
  }

  await db.update(kins).set(updates).where(eq(kins.id, kinId))

  // Update MCP server links if provided explicitly
  if (input.mcpServerIds !== undefined) {
    await db.delete(kinMcpServers).where(eq(kinMcpServers.kinId, kinId))
    for (const mcpServerId of input.mcpServerIds) {
      await db.insert(kinMcpServers).values({ kinId, mcpServerId })
    }
  }

  const details = await getKinDetails(kinId)
  if (!details) {
    // Should not happen since we just updated it
    throw new Error('Kin not found after update')
  }

  log.debug({ kinId, updatedFields: Object.keys(updates).filter((k) => k !== 'updatedAt') }, 'Kin updated')

  // Notify all clients
  const resolvedThinking = resolveThinkingConfig(details.thinkingConfig)
  sseManager.broadcast({
    type: 'kin:updated',
    kinId,
    data: {
      kinId,
      slug: details.slug,
      name: details.name,
      role: details.role,
      avatarUrl: details.avatarUrl,
      providerId: details.providerId,
      thinkingEnabled: resolvedThinking.enabled === true,
      thinkingEffort: resolvedThinking.effort ?? null,
    },
  })

  return { kin: details }
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteKin(kinId: string): Promise<boolean> {
  const existing = db.select().from(kins).where(eq(kins.id, kinId)).get()
  if (!existing) return false

  // Gather IDs of tasks and crons belonging to this kin to handle cross-kin FK references
  const kinTaskIds = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentKinId, kinId)).all().map((t) => t.id)
  const kinCronIds = db.select({ id: crons.id }).from(crons).where(eq(crons.kinId, kinId)).all().map((c) => c.id)
  const kinWebhookIds = db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.kinId, kinId)).all().map((w) => w.id)
  const kinChannelIds = db.select({ id: channels.id }).from(channels).where(eq(channels.kinId, kinId)).all().map((ch) => ch.id)
  const kinMemoryIds = db.select({ id: memories.id }).from(memories).where(eq(memories.kinId, kinId)).all().map((m) => m.id)
  const kinMiniAppIds = db.select({ id: miniApps.id }).from(miniApps).where(eq(miniApps.kinId, kinId)).all().map((a) => a.id)

  // Gather cross-kin entities whose FK references will be nullified (for SSE notifications)
  const affectedCronIds = db.select({ id: crons.id, cronKinId: crons.kinId }).from(crons).where(eq(crons.targetKinId, kinId)).all()
  const affectedMcpServerIds = db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.createdByKinId, kinId)).all().map((m) => m.id)

  // Clean up all related records — topological order (leaves first)
  // humanPrompts must come before messages and tasks (references both)
  await db.delete(humanPrompts).where(eq(humanPrompts.kinId, kinId))
  await db.delete(files).where(eq(files.kinId, kinId))
  await db.delete(compactingSnapshots).where(eq(compactingSnapshots.kinId, kinId))
  await db.delete(compactingSummaries).where(eq(compactingSummaries.kinId, kinId))
  await db.delete(memories).where(eq(memories.kinId, kinId))

  // Null out cross-kin references before deleting tasks and crons
  if (kinTaskIds.length > 0) {
    // Other kins' queue items referencing this kin's tasks
    await db.update(queueItems).set({ taskId: null }).where(inArray(queueItems.taskId, kinTaskIds))
    // Other kins' messages referencing this kin's tasks
    await db.update(messages).set({ taskId: null }).where(inArray(messages.taskId, kinTaskIds))
    // Other kins' tasks referencing this kin's tasks as parent
    await db.update(tasks).set({ parentTaskId: null }).where(inArray(tasks.parentTaskId, kinTaskIds))
  }
  if (kinCronIds.length > 0) {
    // Other kins' tasks referencing this kin's crons
    await db.update(tasks).set({ cronId: null }).where(inArray(tasks.cronId, kinCronIds))
  }

  await db.delete(queueItems).where(eq(queueItems.kinId, kinId))

  // Clean up quick sessions referencing this kin
  const kinQuickSessionIds = db.select({ id: quickSessions.id }).from(quickSessions).where(eq(quickSessions.kinId, kinId)).all().map((s) => s.id)
  if (kinQuickSessionIds.length > 0) {
    // Null out session references in messages (including other kins' messages)
    await db.update(messages).set({ sessionId: null }).where(inArray(messages.sessionId, kinQuickSessionIds))
  }

  await db.delete(messages).where(eq(messages.kinId, kinId))
  await db.delete(quickSessions).where(eq(quickSessions.kinId, kinId))
  await db.update(tasks).set({ parentTaskId: null }).where(eq(tasks.parentKinId, kinId))
  await db.delete(tasks).where(eq(tasks.parentKinId, kinId))
  await db.update(tasks).set({ sourceKinId: null }).where(eq(tasks.sourceKinId, kinId))
  await db.update(crons).set({ targetKinId: null }).where(eq(crons.targetKinId, kinId))
  // Stop in-memory cron scheduler jobs before deleting from DB (fixes #168)
  for (const cronId of kinCronIds) {
    stopJob(cronId)
  }
  await db.delete(crons).where(eq(crons.kinId, kinId))
  await db.delete(contactNotes).where(eq(contactNotes.kinId, kinId))
  // Custom tools are GLOBAL now (not per-Kin) — nothing to cascade-delete here.
  await db.delete(webhooks).where(eq(webhooks.kinId, kinId))
  // Delete channels with full cleanup (stop adapters, delete vault secrets)
  for (const channelId of kinChannelIds) {
    try {
      await deleteChannel(channelId)
    } catch (err) {
      log.warn({ channelId, kinId, err }, 'Failed to delete channel during kin cascade delete')
      // Fallback: raw delete if deleteChannel fails
      await db.delete(channels).where(eq(channels.id, channelId))
    }
  }
  await db.delete(fileStorage).where(eq(fileStorage.kinId, kinId))
  await db.update(fileStorage).set({ createdByKinId: null }).where(eq(fileStorage.createdByKinId, kinId))
  await db.update(vaultSecrets).set({ createdByKinId: null }).where(eq(vaultSecrets.createdByKinId, kinId))
  await db.update(mcpServers).set({ createdByKinId: null }).where(eq(mcpServers.createdByKinId, kinId))
  await db.delete(kinMcpServers).where(eq(kinMcpServers.kinId, kinId))
  await db.delete(miniApps).where(eq(miniApps.kinId, kinId))
  await db.delete(scheduledWakeups).where(
    or(eq(scheduledWakeups.callerKinId, kinId), eq(scheduledWakeups.targetKinId, kinId)),
  )

  // Delete the kin
  await db.delete(kins).where(eq(kins.id, kinId))

  // Remove workspace directory
  if (existing.workspacePath && existsSync(existing.workspacePath)) {
    rmSync(existing.workspacePath, { recursive: true, force: true })
  }

  // Close any browser sessions owned by this Kin AND remove its saved states
  // (best-effort, non-blocking)
  import('@/server/services/playwright-manager')
    .then(async ({ playwrightManager }) => {
      await playwrightManager.closeSessionsForKin(kinId, 'kin_deleted')
      await playwrightManager.deleteAllSavedStatesForKin(kinId)
    })
    .catch((err) => log.warn({ kinId, err }, 'Failed to clean up browser resources for deleted kin'))

  // Drop in-memory + persisted context usage cache for this Kin so it doesn't
  // leak across deployments with high Kin churn (lastContextUsage map keeps
  // growing, plus the orphan app_settings row context_usage:<kinId> stays
  // forever otherwise).
  import('@/server/services/kin-engine')
    .then(({ clearKinContextUsage }) => clearKinContextUsage(kinId))
    .catch((err) => log.warn({ kinId, err }, 'Failed to clear context usage cache for deleted kin'))

  log.info({ kinId, name: existing.name, slug: existing.slug }, 'Kin deleted')

  // Notify all clients about cascade-deleted children first, then the kin itself
  for (const taskId of kinTaskIds) {
    sseManager.broadcast({ type: 'task:deleted', kinId, data: { taskId, kinId } })
  }
  for (const cronId of kinCronIds) {
    sseManager.broadcast({ type: 'cron:deleted', kinId, data: { cronId, kinId } })
  }
  for (const webhookId of kinWebhookIds) {
    sseManager.broadcast({ type: 'webhook:deleted', kinId, data: { webhookId, kinId } })
  }
  // Note: channel:deleted SSE events are already emitted by deleteChannel() above
  for (const memoryId of kinMemoryIds) {
    sseManager.broadcast({ type: 'memory:deleted', kinId, data: { memoryId, kinId } })
  }
  for (const appId of kinMiniAppIds) {
    sseManager.broadcast({ type: 'miniapp:deleted', kinId, data: { appId, kinId } })
  }

  // Notify about cross-kin entities whose FK references were nullified
  for (const cron of affectedCronIds) {
    sseManager.broadcast({ type: 'cron:updated', kinId: cron.cronKinId, data: { cronId: cron.id, kinId: cron.cronKinId, targetKinId: null } })
  }
  for (const mcpServerId of affectedMcpServerIds) {
    sseManager.broadcast({ type: 'mcp-server:updated', data: { mcpServerId, createdByKinId: null } })
  }

  sseManager.broadcast({
    type: 'kin:deleted',
    kinId,
    data: { kinId },
  })

  return true
}

// ─── Get Details ────────────────────────────────────────────────────────────

export async function getKinDetails(kinId: string): Promise<KinDetails | null> {
  const kin = db.select().from(kins).where(eq(kins.id, kinId)).get()
  if (!kin) return null

  const mcpLinks = await db
    .select({ id: mcpServers.id, name: mcpServers.name })
    .from(kinMcpServers)
    .innerJoin(mcpServers, eq(kinMcpServers.mcpServerId, mcpServers.id))
    .where(eq(kinMcpServers.kinId, kinId))
    .all()

  return {
    ...kin,
    avatarUrl: kin.avatarPath
      ? `/api/uploads/kins/${kinId}/avatar.${kin.avatarPath.split('.').pop() ?? 'png'}?v=${kin.updatedAt ? kin.updatedAt.getTime() : Date.now()}`
      : null,
    mcpServers: mcpLinks,
  }
}

// ─── Avatar Generation ──────────────────────────────────────────────────────

export async function generateAndSaveAvatar(kinId: string): Promise<string | null> {
  const kin = db.select().from(kins).where(eq(kins.id, kinId)).get()
  if (!kin) return null

  // Resolve the default image target up front so we know whether the model
  // supports image-to-image — this dictates both the prompt style and whether
  // we attach the base robot reference image.
  let target
  try {
    target = await resolveImageTarget()
  } catch (err) {
    if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
      log.warn({ kinId }, 'No image provider configured — skipping avatar generation')
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
      name: kin.name,
      role: kin.role,
      character: kin.character ?? '',
      expertise: kin.expertise ?? '',
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
  const avatarDir = `${config.upload.dir}/kins/${kinId}`
  if (!existsSync(avatarDir)) {
    mkdirSync(avatarDir, { recursive: true })
  }
  const filePath = `${avatarDir}/avatar.${ext}`
  const buffer = Buffer.from(result.base64, 'base64')
  await Bun.write(filePath, buffer)

  // Update DB
  await db
    .update(kins)
    .set({ avatarPath: filePath, updatedAt: new Date() })
    .where(eq(kins.id, kinId))

  const avatarUrl = `/api/uploads/kins/${kinId}/avatar.${ext}?v=${Date.now()}`

  // Notify clients
  sseManager.broadcast({
    type: 'kin:updated',
    kinId,
    data: { kinId, avatarUrl },
  })

  log.info({ kinId, avatarUrl }, 'Avatar generated and saved')

  return avatarUrl
}
