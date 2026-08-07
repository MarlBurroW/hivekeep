import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  createSecret,
  getSecretByKey,
  updateSecretValueByKey,
  deleteSecret,
  searchSecrets,
  getEntryValue,
  createEntry,
  getAttachment,
} from '@/server/services/vault'
import { placeholderFor } from '@/server/services/secret-substitution'
import { redactSecretLeak } from '@/server/services/secret-redaction'
import { createSecretPrompt } from '@/server/services/secret-prompts'
import { createType } from '@/server/services/vault-types'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:vault')

/** Per-call usage teaching returned with every placeholder — the in-band
 *  surface that re-teaches the pattern even to an agent ignoring the system
 *  prompt. Key-specific so the shell example is copy-pasteable. */
function placeholderUsage(key: string): string {
  return (
    `Insert this placeholder verbatim in any tool argument; the real value replaces it at execution time — you never see, and never need, the raw value. ` +
    `For shell commands and scripts, pass it as an environment variable (e.g. \`${key}={{secret:${key}}} bun run script.ts\`, then read process.env.${key}) and never hardcode secrets into files. ` +
    `Transforms: {{secret:${key}|base64}} (e.g. Basic auth) and {{secret:${key}|urlencode}} (query strings). ` +
    `Placeholders from earlier in the conversation stay valid — reuse them directly.`
  )
}

/**
 * get_secret — return the placeholder for a Vault secret. The raw value is
 * NEVER returned to the model; it is substituted at tool-execution time.
 * Available to main agents only.
 */
export const getSecretTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Get the placeholder for a Vault secret. Returns {{secret:KEY}} — insert it verbatim in tool arguments (HTTP headers, shell commands, file contents) and the real value is substituted at execution time. You never see the raw value. For shell/scripts, pass it as an environment variable: `KEY={{secret:KEY}} <command>`.',
      inputSchema: z.object({
        key: z.string(),
      }),
      execute: async ({ key }) => {
        log.debug({ key }, 'get_secret invoked')
        const secret = await getSecretByKey(key)
        if (!secret) {
          return { error: `Secret "${key}" not found. Use search_secrets to find the right key, or prompt_secret to ask the user for it.` }
        }
        return {
          placeholder: placeholderFor(key),
          key,
          ...(secret.description ? { description: secret.description } : {}),
          ...(secret.allowedTools ? { restricted_to_tools: secret.allowedTools } : {}),
          ...(secret.allowedHosts ? { restricted_to_hosts: secret.allowedHosts } : {}),
          usage: placeholderUsage(key),
        }
      },
    }),
}

/**
 * redact_secret_leak — retroactively scrub a leaked secret value from the
 * whole history (content + tool_calls + compacting summaries), replacing
 * each occurrence with the placeholder. Available to main agents only.
 */
export const redactSecretLeakTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Scrub a leaked secret from the conversation history. Provide the VAULT KEY (never the value): every occurrence of that secret\'s value — in message contents, tool calls/results, and compacting summaries, across all conversations — is replaced with the {{secret:KEY}} placeholder. If the leaked secret is not in the vault yet (e.g. the user pasted it in chat), store it first with create_secret, then call this.',
      inputSchema: z.object({
        key: z.string().describe('Vault key of the leaked secret'),
      }),
      execute: async ({ key }) => {
        log.info({ key, agentId: ctx.agentId }, 'redact_secret_leak invoked')
        const result = await redactSecretLeak(key)
        if (!result.ok) {
          return { error: result.error }
        }
        return {
          success: true,
          key,
          placeholder: placeholderFor(key),
          messages_cleaned: result.messagesCleaned,
          summaries_cleaned: result.summariesCleaned,
          note: 'Already-sent context for the current turn may still contain the value; from the next turn on, the history only carries the placeholder.',
        }
      },
    }),
}

/**
 * reveal_secret — ask the USER for permission to see a secret's raw value.
 * The approval card is mandatory and can never be bypassed: on approval the
 * value is injected for ONE turn and auto-redacted when the turn ends.
 * Available to main agents only.
 */
export const revealSecretTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Ask the user for permission to see a secret\'s RAW value. Use only when the placeholder genuinely cannot work (rare — placeholders cover tool args, shell env, file contents, and base64/urlencode transforms). The user sees your reason and approves or denies; your turn ends and resumes with their decision. If approved, the value is visible for that turn ONLY and is automatically redacted from the history afterwards. If denied, do not ask again — work with the placeholder.',
      inputSchema: z.object({
        key: z.string().describe('Vault key of the secret'),
        reason: z.string().describe('Shown verbatim to the user: why the raw value is needed'),
      }),
      execute: async ({ key, reason }) => {
        log.info({ key, agentId: ctx.agentId }, 'reveal_secret invoked')
        const secret = await getSecretByKey(key)
        if (!secret) {
          return { error: `Secret "${key}" not found. Use search_secrets to find the right key.` }
        }
        const { promptId } = await createSecretPrompt({
          agentId: ctx.agentId,
          purpose: 'reveal',
          title: `Reveal secret "${key}" to the model?`,
          description: reason,
          fields: [],
          spec: { key, reason },
        })
        return {
          promptId,
          status: 'awaiting_user_approval',
          note: 'The user has been asked. Your turn ends here and resumes with their decision.',
        }
      },
    }),
}

/**
 * create_secret — create a new secret in the Vault.
 * Available to main agents only.
 */
export const createSecretTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Create a new encrypted secret. Errors if key already exists — use update_secret instead.',
      inputSchema: z.object({
        key: z.string().describe('SCREAMING_SNAKE_CASE key'),
        value: z.string(),
        description: z.string().optional(),
      }),
      execute: async ({ key, value, description }) => {
        log.debug({ key, agentId: ctx.agentId }, 'create_secret invoked')
        const existing = await getSecretByKey(key)
        if (existing) {
          return { error: `Secret with key "${key}" already exists. Use update_secret to change its value.` }
        }
        const secret = await createSecret(key, value, ctx.agentId, description)
        return { id: secret.id, key: secret.key, placeholder: placeholderFor(secret.key), usage: placeholderUsage(secret.key) }
      },
    }),
}

/**
 * update_secret — update the value of an existing secret in the Vault.
 * Available to main agents only.
 */
export const updateSecretTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Update an existing secret value. Errors if key does not exist.',
      inputSchema: z.object({
        key: z.string(),
        value: z.string(),
      }),
      execute: async ({ key, value }) => {
        log.debug({ key, agentId: ctx.agentId }, 'update_secret invoked')
        const updated = await updateSecretValueByKey(key, value)
        if (!updated) {
          return { error: `Secret with key "${key}" not found` }
        }
        return { id: updated.id, key, placeholder: placeholderFor(key) }
      },
    }),
}

/**
 * delete_secret — delete a secret from the Vault.
 * An Agent can only delete secrets it created itself.
 * Available to main agents only.
 */
export const deleteSecretTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Delete a secret you created. Cannot delete admin-created secrets.',
      inputSchema: z.object({
        key: z.string(),
      }),
      execute: async ({ key }) => {
        log.debug({ key, agentId: ctx.agentId }, 'delete_secret invoked')
        const existing = await getSecretByKey(key)
        if (!existing) {
          return { error: `Secret with key "${key}" not found` }
        }
        if (existing.createdByAgentId !== ctx.agentId) {
          return { error: 'Cannot delete this secret — it was not created by this Agent' }
        }
        const deleted = await deleteSecret(existing.id)
        if (!deleted) {
          return { error: 'Failed to delete secret' }
        }
        return { success: true, key }
      },
    }),
}

/**
 * search_secrets — search for secrets by key or description.
 * Returns metadata only, never values.
 * Available to main agents only.
 */
export const searchSecretsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'Search secrets by key or description. Returns metadata and the {{secret:KEY}} placeholders, never values — insert a placeholder verbatim in tool arguments to use the secret.',
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }) => {
        log.debug({ query, agentId: ctx.agentId }, 'search_secrets invoked')
        const results = await searchSecrets(query)
        return { secrets: results.map((s) => ({ ...s, placeholder: placeholderFor(s.key) })) }
      },
    }),
}

// ─── Typed Entry Tools ────────────────────────────────────────────────────────

/**
 * get_vault_entry — retrieve a typed vault entry by key.
 * Returns structured data based on entry type (credential, card, note, etc.).
 */
export const getVaultEntryTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'Retrieve a typed vault entry by key: entry type, field names, and the {{secret:KEY}} placeholder. Values are never returned — insert the placeholder verbatim in tool arguments to use the secret, or use reveal_secret (user approval) to show it to the user.',
      inputSchema: z.object({
        key: z.string(),
      }),
      execute: async ({ key }) => {
        log.debug({ key, agentId: ctx.agentId }, 'get_vault_entry invoked')
        const secret = await getSecretByKey(key)
        if (!secret) {
          return { error: 'Entry not found' }
        }
        const result = await getEntryValue(secret.id)
        if (!result) {
          return { error: 'Entry not found' }
        }
        // Decrypted values never reach the model: only the shape is exposed.
        // Anything else would bypass the reveal_secret approval flow.
        const fields =
          result.value !== null && typeof result.value === 'object'
            ? Object.keys(result.value)
            : null
        return {
          entryType: result.entryType,
          fields,
          placeholder: placeholderFor(key),
        }
      },
    }),
}

/**
 * create_vault_entry — create a typed vault entry.
 */
export const createVaultEntryTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Create a typed vault entry (text, credential, card, note, identity, or custom type). Encrypted at rest.',
      inputSchema: z.object({
        key: z.string().describe('SCREAMING_SNAKE_CASE key'),
        entry_type: z.string().describe('text, credential, card, note, identity, or custom slug'),
        value: z.union([z.string(), z.record(z.string(), z.unknown())]).describe(
          'String for text type, object with fields for others',
        ),
        description: z.string().optional(),
      }),
      execute: async ({ key, entry_type, value, description }) => {
        log.debug({ key, entry_type, agentId: ctx.agentId }, 'create_vault_entry invoked')
        const existing = await getSecretByKey(key)
        if (existing) {
          return { error: `Entry with key "${key}" already exists` }
        }
        const entry = await createEntry({
          key,
          entryType: entry_type,
          value,
          description,
          createdByAgentId: ctx.agentId,
        })
        return { id: entry.id, key: entry.key, entryType: entry.entryType }
      },
    }),
}

/**
 * create_vault_type — create a custom vault entry type.
 */
export const createVaultTypeTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Create a custom vault entry type with a defined field schema.',
      inputSchema: z.object({
        name: z.string().describe('Display name'),
        slug: z.string().describe('Machine name, lowercase'),
        icon: z.string().optional().describe('Lucide icon name'),
        fields: z.array(z.object({
          name: z.string(),
          label: z.string(),
          type: z.enum(['text', 'password', 'textarea', 'url', 'email', 'phone', 'date', 'number']),
          required: z.boolean().optional(),
        })),
      }),
      execute: async ({ name, slug, icon, fields }) => {
        log.debug({ slug, agentId: ctx.agentId }, 'create_vault_type invoked')
        try {
          const type = await createType({
            name,
            slug,
            icon,
            fields,
            createdByAgentId: ctx.agentId,
          })
          return { id: type.id, slug: type.slug, name: type.name }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to create type' }
        }
      },
    }),
}

/**
 * get_vault_attachment — download a vault attachment as base64.
 */
export const getVaultAttachmentTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'Look up a vault attachment (name, type, size). Attachment content is never returned — it stays in the vault, like secret values; point the user to Settings > Vault to view or download it.',
      inputSchema: z.object({
        attachment_id: z.string(),
      }),
      execute: async ({ attachment_id }) => {
        log.debug({ attachment_id, agentId: ctx.agentId }, 'get_vault_attachment invoked')
        const result = await getAttachment(attachment_id)
        if (!result) {
          return { error: 'Attachment not found' }
        }
        // Attachment bytes (private keys, ID scans) never reach the model:
        // they would be persisted in tool_calls outside any redaction.
        return {
          name: result.name,
          mimeType: result.mimeType,
          size: result.data.byteLength,
        }
      },
    }),
}
