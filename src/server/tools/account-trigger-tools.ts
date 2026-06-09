/**
 * Native tools letting an Agent manage email account triggers on the user's
 * behalf. Thin wrappers over the account-triggers service (single source of
 * truth) — same validation as the HTTP routes.
 *
 * The condition tree is passed as a JSON *string* (`conditions`) and validated
 * server-side, NOT as a recursive tool schema (recursive schemas break across
 * providers). Call `describe_trigger_conditions` first to learn the shape.
 *
 * No allow-list: an Agent may create a trigger on any connected email account,
 * targeting itself (default) or any other Agent (ids come from the agent
 * directory in the system prompt).
 */
import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import type { ToolRegistration } from '@/server/tools/types'
import { listEmailAccounts, resolveEmailProviderByAccountId } from '@/server/services/email-accounts'
import {
  createAccountTrigger,
  updateAccountTrigger,
  deleteAccountTrigger,
  listAccountTriggers,
} from '@/server/services/account-triggers'
import {
  parseAndValidateConditions,
  FIELD_OPS,
  BODY_FIELDS,
  opValueKind,
} from '@/shared/account-triggers'
import type { AccountTriggerSummary, ConditionField, TriggerDispatchMode } from '@/shared/types'

function toErr(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) }
}

async function resolveAccountRef(ref: string): Promise<{ id: string; slug: string; emailAddress: string }> {
  const accounts = await listEmailAccounts()
  const a = accounts.find((x) => x.slug === ref || x.id === ref)
  if (!a) throw new Error(`Email account not found: "${ref}". Use list_email_accounts to see connected accounts.`)
  return { id: a.id, slug: a.slug, emailAddress: a.emailAddress }
}

/** Compact, LLM-friendly view of a trigger. */
function compact(t: AccountTriggerSummary) {
  return {
    id: t.id,
    name: t.name,
    account: t.accountLabel,
    folder: t.folder,
    targetAgent: t.targetAgentName,
    dispatchMode: t.dispatchMode,
    isActive: t.isActive,
    requiresApproval: t.requiresApproval,
    conditions: t.conditionsSummary,
    triggerCount: t.triggerCount,
  }
}

const accountField = z
  .string()
  .describe('Slug or id of the connected email account. Discover via list_email_accounts.')

// ─── describe_trigger_conditions ──────────────────────────────────────────────

export const describeTriggerConditionsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Describe how to build the `conditions` tree for create_account_trigger / update_account_trigger: ' +
        'the available fields, the operators each field accepts, the value kind per operator, and a full ' +
        'example. Call this before creating a trigger.',
      inputSchema: z.object({}),
      execute: async () => {
        const fields = (Object.keys(FIELD_OPS) as ConditionField[]).map((field) => ({
          field,
          operators: FIELD_OPS[field],
          needsFullBody: BODY_FIELDS.includes(field),
        }))
        const allOps = [...new Set(Object.values(FIELD_OPS).flat())]
        const operatorValueKind: Record<string, string> = {}
        for (const op of allOps) {
          operatorValueKind[op] =
            op === 'matches' ? 'string (regular expression)'
            : opValueKind(op) === 'list' ? 'array of strings'
            : opValueKind(op) === 'none' ? 'no value (the operator carries the boolean)'
            : 'string'
        }
        return {
          fields,
          operatorValueKind,
          treeShape:
            'A node is a group { "type":"group", "op":"and"|"or", "children":[...] } or a leaf ' +
            '{ "type":"leaf", "field":..., "op":..., "value":..., "negate"?:true }. The root must be a group. Max depth 4, max 30 leaves.',
          example: {
            type: 'group',
            op: 'and',
            children: [
              { type: 'leaf', field: 'sender_domain', op: 'equals', value: 'stripe.com' },
              {
                type: 'group',
                op: 'or',
                children: [
                  { type: 'leaf', field: 'subject', op: 'contains', value: 'invoice' },
                  { type: 'leaf', field: 'has_attachment', op: 'is_true', value: true },
                ],
              },
            ],
          },
          note: 'Pass the tree to create_account_trigger as a JSON STRING in the `conditions` argument.',
        }
      },
    }),
}

// ─── list_email_folders ───────────────────────────────────────────────────────

export const listEmailFoldersTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'List the folders/labels of a connected email account, to choose the `folder` a trigger watches (default INBOX).',
      inputSchema: z.object({ account: accountField }),
      execute: async (args) => {
        try {
          const acct = await resolveAccountRef(args.account)
          const { provider, config } = await resolveEmailProviderByAccountId(acct.id)
          if (!provider.listFolders) return { account: acct.slug, folders: [{ id: 'INBOX', name: 'INBOX' }] }
          const folders = await provider.listFolders(config)
          return { account: acct.slug, folders: folders.length > 0 ? folders : [{ id: 'INBOX', name: 'INBOX' }] }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── create_account_trigger ───────────────────────────────────────────────────

export const createAccountTriggerTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: (ctx) =>
    tool({
      description:
        'Create an email trigger on a connected account: when a new email matches the conditions, the target ' +
        'Agent is prompted (in its conversation, or via a task). Call describe_trigger_conditions first to build ' +
        '`conditions`. Targets yourself by default.',
      inputSchema: z.object({
        account: accountField,
        name: z.string().describe('Short human label for the trigger.'),
        conditions: z.string().describe('The condition tree as a JSON string. See describe_trigger_conditions.'),
        prompt: z.string().describe('Instruction given to the target Agent when the trigger fires.'),
        target_agent_id: z.string().optional().describe('Agent to notify. Omit to target yourself.'),
        folder: z.string().optional().describe('Folder/label to watch. Default INBOX. See list_email_folders.'),
        dispatch_mode: z.enum(['conversation', 'task']).optional().describe('Inject into the conversation (default) or spawn a task.'),
        max_concurrent_tasks: z.number().int().min(0).optional().describe('Task mode only: cap concurrent tasks (0 = unlimited).'),
      }),
      execute: async (args) => {
        const parsed = parseAndValidateConditions(args.conditions)
        if (!parsed.ok) return { error: `Invalid conditions: ${parsed.error}` }
        try {
          const acct = await resolveAccountRef(args.account)
          const trigger = await createAccountTrigger({
            accountId: acct.id,
            name: args.name,
            conditions: parsed.tree,
            prompt: args.prompt,
            targetAgentId: args.target_agent_id ?? ctx.agentId,
            folder: args.folder,
            dispatchMode: args.dispatch_mode as TriggerDispatchMode | undefined,
            maxConcurrentTasks: args.max_concurrent_tasks,
            createdBy: 'agent',
          })
          return { trigger: compact(trigger) }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── list_account_triggers ────────────────────────────────────────────────────

export const listAccountTriggersTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description: 'List email triggers, optionally filtered to one connected account.',
      inputSchema: z.object({ account: z.string().optional().describe('Slug or id to filter by. Omit for all accounts.') }),
      execute: async (args) => {
        try {
          const accountId = args.account ? (await resolveAccountRef(args.account)).id : undefined
          const triggers = await listAccountTriggers(accountId)
          return { triggers: triggers.map(compact) }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── update_account_trigger ───────────────────────────────────────────────────

export const updateAccountTriggerTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  create: () =>
    tool({
      description: 'Update an existing email trigger. Only provided fields change. Pass `conditions` as a JSON string to replace the tree.',
      inputSchema: z.object({
        trigger_id: z.string().describe('Id of the trigger (from list_account_triggers).'),
        name: z.string().optional(),
        conditions: z.string().optional().describe('New condition tree as a JSON string.'),
        prompt: z.string().optional(),
        target_agent_id: z.string().optional(),
        folder: z.string().optional(),
        dispatch_mode: z.enum(['conversation', 'task']).optional(),
        max_concurrent_tasks: z.number().int().min(0).optional(),
        is_active: z.boolean().optional().describe('Enable/disable the trigger.'),
      }),
      execute: async (args) => {
        try {
          const patch: Parameters<typeof updateAccountTrigger>[1] = {}
          if (args.name !== undefined) patch.name = args.name
          if (args.prompt !== undefined) patch.prompt = args.prompt
          if (args.target_agent_id !== undefined) patch.targetAgentId = args.target_agent_id
          if (args.folder !== undefined) patch.folder = args.folder
          if (args.dispatch_mode !== undefined) patch.dispatchMode = args.dispatch_mode as TriggerDispatchMode
          if (args.max_concurrent_tasks !== undefined) patch.maxConcurrentTasks = args.max_concurrent_tasks
          if (args.is_active !== undefined) patch.isActive = args.is_active
          if (args.conditions !== undefined) {
            const parsed = parseAndValidateConditions(args.conditions)
            if (!parsed.ok) return { error: `Invalid conditions: ${parsed.error}` }
            patch.conditions = parsed.tree
          }
          const trigger = await updateAccountTrigger(args.trigger_id, patch)
          if (!trigger) return { error: `Trigger not found: ${args.trigger_id}` }
          return { trigger: compact(trigger) }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── delete_account_trigger ───────────────────────────────────────────────────

export const deleteAccountTriggerTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  destructive: true,
  create: () =>
    tool({
      description: 'Delete an email trigger by id.',
      inputSchema: z.object({ trigger_id: z.string().describe('Id of the trigger to delete.') }),
      execute: async (args) => {
        try {
          await deleteAccountTrigger(args.trigger_id)
          return { deleted: true, trigger_id: args.trigger_id }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}
