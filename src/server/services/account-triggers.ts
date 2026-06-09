/**
 * Account triggers — per connected-account automation. A trigger matches new
 * email against a condition tree and either injects into the target Agent's
 * conversation or spawns a task. Mirrors the webhooks service; the dispatch
 * helpers are the email-source analog of webhook conversation/task dispatch.
 *
 * This module is the single source of truth for creating/validating triggers:
 * both the HTTP routes and the Agent tools call through here.
 */
import { eq, and, desc, lt, count, inArray } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { db } from '@/server/db/index'
import { createLogger } from '@/server/logger'
import { accountTriggers, triggerLogs, accountSyncState, agents } from '@/server/db/schema'
import { enqueueMessage } from '@/server/services/queue'
import { spawnTask } from '@/server/services/tasks'
import { sseManager } from '@/server/sse/index'
import { config } from '@/server/config'
import { listEmailAccounts } from '@/server/services/email-accounts'
import { getAgentTriggersRequireApproval } from '@/server/services/app-settings'
import { agentAvatarUrl } from '@/server/services/field-validator'
import { validateConditionTree, treeNeedsBody, summarizeConditions } from '@/shared/account-triggers'
import type {
  AccountTriggerSummary,
  ConditionNode,
  TriggerDispatchMode,
  TriggerLogEntry,
} from '@/shared/types'

const log = createLogger('account-triggers')

type TriggerRow = typeof accountTriggers.$inferSelect

// ─── Cold-start cursor ────────────────────────────────────────────────────────

/** Ensure a polling watermark exists for (account, folder). Initialized to NOW
 *  so a freshly-created trigger never replays the historical inbox. */
export async function ensureSyncCursor(accountId: string, folder: string, nowMs: number): Promise<void> {
  const existing = db
    .select({ accountId: accountSyncState.accountId })
    .from(accountSyncState)
    .where(and(eq(accountSyncState.accountId, accountId), eq(accountSyncState.folder, folder)))
    .get()
  if (existing) return
  await db.insert(accountSyncState).values({
    accountId,
    folder,
    lastSeenDate: nowMs,
    seenIds: '[]',
    lastPolledAt: null,
    lastError: null,
  })
}

// ─── Serialization ────────────────────────────────────────────────────────────

interface AccountInfo { label: string; slug: string }
interface AgentInfo { name: string; avatarPath: string | null; updatedAt: Date | null }

function parseConditions(raw: string): ConditionNode {
  return JSON.parse(raw) as ConditionNode
}

function serializeTrigger(row: TriggerRow, account: AccountInfo | undefined, agent: AgentInfo | undefined): AccountTriggerSummary {
  const conditions = parseConditions(row.conditions)
  return {
    id: row.id,
    accountId: row.accountId,
    accountLabel: account?.label ?? row.accountId,
    name: row.name,
    isActive: row.isActive,
    folder: row.folder,
    conditions,
    conditionsSummary: summarizeConditions(conditions),
    prompt: row.prompt,
    targetAgentId: row.targetAgentId,
    targetAgentName: agent?.name ?? 'Unknown',
    targetAgentAvatarUrl: agent ? agentAvatarUrl(row.targetAgentId, agent.avatarPath, agent.updatedAt) : null,
    dispatchMode: row.dispatchMode as TriggerDispatchMode,
    maxConcurrentTasks: row.maxConcurrentTasks,
    triggerCount: row.triggerCount,
    lastTriggeredAt: row.lastTriggeredAt ? row.lastTriggeredAt.getTime() : null,
    createdBy: (row.createdBy as 'user' | 'agent') ?? 'user',
    requiresApproval: row.requiresApproval,
    createdAt: row.createdAt.getTime(),
  }
}

/** Build id→account and id→agent lookup maps for a set of trigger rows. */
async function buildLookups(rows: TriggerRow[]): Promise<{
  accounts: Map<string, AccountInfo>
  agentsById: Map<string, AgentInfo>
}> {
  const accounts = new Map<string, AccountInfo>()
  for (const a of await listEmailAccounts()) accounts.set(a.id, { label: a.emailAddress, slug: a.slug })

  const agentsById = new Map<string, AgentInfo>()
  const agentIds = [...new Set(rows.map((r) => r.targetAgentId))]
  if (agentIds.length > 0) {
    const agentRows = db
      .select({ id: agents.id, name: agents.name, avatarPath: agents.avatarPath, updatedAt: agents.updatedAt })
      .from(agents)
      .where(inArray(agents.id, agentIds))
      .all()
    for (const a of agentRows) agentsById.set(a.id, { name: a.name, avatarPath: a.avatarPath, updatedAt: a.updatedAt })
  }
  return { accounts, agentsById }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export interface CreateTriggerParams {
  accountId: string
  name: string
  folder?: string
  conditions: ConditionNode
  prompt: string
  targetAgentId: string
  dispatchMode?: TriggerDispatchMode
  maxConcurrentTasks?: number
  createdBy: 'user' | 'agent'
}

export async function createAccountTrigger(params: CreateTriggerParams): Promise<AccountTriggerSummary> {
  // Validate the account is a connected email account.
  const accounts = await listEmailAccounts()
  const account = accounts.find((a) => a.id === params.accountId)
  if (!account) throw new Error(`Email account not found: ${params.accountId}`)

  // Validate the target Agent exists.
  const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.id, params.targetAgentId)).get()
  if (!agent) throw new Error(`Agent not found: ${params.targetAgentId}`)

  // Validate the condition tree (single source of truth — defensive even though
  // routes/tools also validate).
  const validation = validateConditionTree(params.conditions)
  if (!validation.ok) throw new Error(`Invalid conditions: ${validation.error}`)

  const existing = db.select({ c: count() }).from(accountTriggers).where(eq(accountTriggers.accountId, params.accountId)).get()
  if ((existing?.c ?? 0) >= config.emailTriggers.maxPerAccount) {
    throw new Error(`Max triggers per account (${config.emailTriggers.maxPerAccount}) reached`)
  }

  const folder = params.folder?.trim() || 'INBOX'
  const requiresApproval = params.createdBy === 'agent' && (await getAgentTriggersRequireApproval())

  const id = uuid()
  const now = new Date()
  await db.insert(accountTriggers).values({
    id,
    accountId: params.accountId,
    name: params.name,
    isActive: !requiresApproval,
    folder,
    conditions: JSON.stringify(params.conditions),
    prompt: params.prompt,
    targetAgentId: params.targetAgentId,
    dispatchMode: params.dispatchMode ?? 'conversation',
    maxConcurrentTasks: params.maxConcurrentTasks ?? 1,
    needsBody: treeNeedsBody(params.conditions),
    triggerCount: 0,
    createdBy: params.createdBy,
    requiresApproval,
    createdAt: now,
    updatedAt: now,
  })

  // Cold-start: watermark the (account, folder) stream at NOW so we never replay
  // the historical inbox.
  await ensureSyncCursor(params.accountId, folder, now.getTime())

  const row = db.select().from(accountTriggers).where(eq(accountTriggers.id, id)).get()!
  sseManager.broadcast({ type: 'trigger:created', agentId: row.targetAgentId, data: { triggerId: id, accountId: params.accountId } })
  log.info({ triggerId: id, accountId: params.accountId, createdBy: params.createdBy, requiresApproval }, 'Account trigger created')

  const { accounts: accLookup, agentsById } = await buildLookups([row])
  return serializeTrigger(row, accLookup.get(row.accountId), agentsById.get(row.targetAgentId))
}

export interface UpdateTriggerPatch {
  name?: string
  folder?: string
  conditions?: ConditionNode
  prompt?: string
  targetAgentId?: string
  dispatchMode?: TriggerDispatchMode
  maxConcurrentTasks?: number
  isActive?: boolean
}

export async function updateAccountTrigger(id: string, patch: UpdateTriggerPatch): Promise<AccountTriggerSummary | null> {
  const current = db.select().from(accountTriggers).where(eq(accountTriggers.id, id)).get()
  if (!current) return null

  const set: Partial<TriggerRow> = { updatedAt: new Date() }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.prompt !== undefined) set.prompt = patch.prompt
  if (patch.targetAgentId !== undefined) {
    const agent = db.select({ id: agents.id }).from(agents).where(eq(agents.id, patch.targetAgentId)).get()
    if (!agent) throw new Error(`Agent not found: ${patch.targetAgentId}`)
    set.targetAgentId = patch.targetAgentId
  }
  if (patch.dispatchMode !== undefined) set.dispatchMode = patch.dispatchMode
  if (patch.maxConcurrentTasks !== undefined) set.maxConcurrentTasks = patch.maxConcurrentTasks
  if (patch.isActive !== undefined) {
    set.isActive = patch.isActive
    // Approving an Agent-created trigger clears the pending flag.
    if (patch.isActive) set.requiresApproval = false
  }
  if (patch.conditions !== undefined) {
    const validation = validateConditionTree(patch.conditions)
    if (!validation.ok) throw new Error(`Invalid conditions: ${validation.error}`)
    set.conditions = JSON.stringify(patch.conditions)
    set.needsBody = treeNeedsBody(patch.conditions)
  }
  let folderChanged = false
  if (patch.folder !== undefined) {
    const folder = patch.folder.trim() || 'INBOX'
    set.folder = folder
    folderChanged = folder !== current.folder
  }

  await db.update(accountTriggers).set(set).where(eq(accountTriggers.id, id))
  const row = db.select().from(accountTriggers).where(eq(accountTriggers.id, id)).get()!

  if (folderChanged) await ensureSyncCursor(row.accountId, row.folder, Date.now())

  sseManager.broadcast({ type: 'trigger:updated', agentId: row.targetAgentId, data: { triggerId: id, accountId: row.accountId } })

  const { accounts, agentsById } = await buildLookups([row])
  return serializeTrigger(row, accounts.get(row.accountId), agentsById.get(row.targetAgentId))
}

export async function deleteAccountTrigger(id: string): Promise<void> {
  const existing = db.select().from(accountTriggers).where(eq(accountTriggers.id, id)).get()
  await db.delete(accountTriggers).where(eq(accountTriggers.id, id))
  if (existing) {
    sseManager.broadcast({ type: 'trigger:deleted', agentId: existing.targetAgentId, data: { triggerId: id, accountId: existing.accountId } })
    log.info({ triggerId: id, accountId: existing.accountId }, 'Account trigger deleted')
  }
}

export function getAccountTriggerRow(id: string): TriggerRow | undefined {
  return db.select().from(accountTriggers).where(eq(accountTriggers.id, id)).get()
}

export async function listAccountTriggers(accountId?: string): Promise<AccountTriggerSummary[]> {
  const rows = accountId
    ? db.select().from(accountTriggers).where(eq(accountTriggers.accountId, accountId)).orderBy(desc(accountTriggers.createdAt)).all()
    : db.select().from(accountTriggers).orderBy(desc(accountTriggers.createdAt)).all()
  const { accounts, agentsById } = await buildLookups(rows)
  return rows.map((r) => serializeTrigger(r, accounts.get(r.accountId), agentsById.get(r.targetAgentId)))
}

/** Active triggers targeting an Agent — for the system-prompt awareness block. */
export async function listActiveTriggerSummariesForAgent(
  agentId: string,
): Promise<Array<{ name: string; accountLabel: string; conditionsSummary: string; dispatchMode: TriggerDispatchMode; folder: string }>> {
  const rows = db
    .select()
    .from(accountTriggers)
    .where(and(eq(accountTriggers.targetAgentId, agentId), eq(accountTriggers.isActive, true)))
    .all()
  if (rows.length === 0) return []
  const { accounts } = await buildLookups(rows)
  return rows.map((r) => ({
    name: r.name,
    accountLabel: accounts.get(r.accountId)?.label ?? r.accountId,
    conditionsSummary: summarizeConditions(parseConditions(r.conditions)),
    dispatchMode: r.dispatchMode as TriggerDispatchMode,
    folder: r.folder,
  }))
}

export async function getTriggerLogs(triggerId: string, limit = 50): Promise<TriggerLogEntry[]> {
  const rows = db
    .select()
    .from(triggerLogs)
    .where(eq(triggerLogs.triggerId, triggerId))
    .orderBy(desc(triggerLogs.createdAt))
    .limit(limit)
    .all()
  return rows.map((r) => ({
    id: r.id,
    triggerId: r.triggerId,
    summary: r.summary,
    matched: r.matched,
    action: r.action as TriggerDispatchMode | null,
    createdAt: r.createdAt.getTime(),
  }))
}

// ─── Dispatch (the email-source analog of webhook conversation/task dispatch) ──

/** Minimal reference to the email that fired a trigger, used to render context. */
export interface TriggerEmailRef {
  accountSlug: string
  accountLabel: string
  providerMessageId: string
  from: string
  subject: string
  /** Receive time, Unix ms. */
  date: number
  snippet: string
}

function renderEmailContent(trigger: TriggerRow, ref: TriggerEmailRef): string {
  const date = new Date(ref.date).toISOString()
  return (
    `[Trigger "${trigger.name}" · ${ref.accountLabel}]\n` +
    `From: ${ref.from}\n` +
    `Subject: ${ref.subject}\n` +
    `Date: ${date}\n` +
    `Preview: ${ref.snippet}\n\n` +
    `${trigger.prompt}\n\n` +
    `— Read the full email with read_email (account: "${ref.accountSlug}", id: "${ref.providerMessageId}").`
  )
}

async function insertTriggerLog(triggerId: string, summary: string, matched: boolean, action: TriggerDispatchMode | null): Promise<void> {
  await db.insert(triggerLogs).values({ id: uuid(), triggerId, summary: summary.slice(0, 500), matched, action, createdAt: new Date() })
}

/** Dispatch a matched email to the trigger's target Agent. */
export async function fireTrigger(trigger: TriggerRow, ref: TriggerEmailRef): Promise<void> {
  const content = renderEmailContent(trigger, ref)
  const mode = trigger.dispatchMode as TriggerDispatchMode

  if (mode === 'task') {
    await spawnTask({
      parentAgentId: trigger.targetAgentId,
      title: trigger.name,
      description: content,
      mode: 'async',
      spawnType: 'self',
      concurrencyGroup: `trigger:${trigger.id}`,
      concurrencyMax: trigger.maxConcurrentTasks,
    })
  } else {
    await enqueueMessage({
      agentId: trigger.targetAgentId,
      messageType: 'trigger',
      content,
      sourceType: 'trigger',
      sourceId: trigger.id,
      priority: config.queue.agentPriority,
    })
  }

  await db
    .update(accountTriggers)
    .set({ triggerCount: trigger.triggerCount + 1, lastTriggeredAt: new Date() })
    .where(eq(accountTriggers.id, trigger.id))
  await insertTriggerLog(trigger.id, `${ref.from} · ${ref.subject}`, true, mode)
  sseManager.broadcast({ type: 'trigger:fired', agentId: trigger.targetAgentId, data: { triggerId: trigger.id, accountId: trigger.accountId } })
  log.info({ triggerId: trigger.id, agentId: trigger.targetAgentId, mode }, 'Trigger fired')
}

// ─── Log cleanup (mirrors startWebhookLogCleanup) ─────────────────────────────

export function startTriggerLogCleanup(): void {
  const { logRetentionDays } = config.emailTriggers
  const run = async () => {
    try {
      const cutoff = new Date(Date.now() - logRetentionDays * 24 * 60 * 60 * 1000)
      await db.delete(triggerLogs).where(lt(triggerLogs.createdAt, cutoff))
    } catch (err) {
      log.error({ err }, 'Trigger log cleanup failed')
    }
  }
  void run()
  setInterval(run, 24 * 60 * 60 * 1000)
}
