import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockRedaction = {
  redactSecretLeak: mock(() => Promise.resolve({ ok: false, error: 'x', messagesCleaned: 0, summariesCleaned: 0 } as any)),
  sweepRevealedSecrets: mock(() => Promise.resolve(0)),
}

const mockSecretPrompts = {
  createSecretPrompt: mock(() => Promise.resolve({ promptId: 'prompt-1' })),
  respondToSecretPrompt: mock(() => Promise.resolve({ success: true, summary: '' } as any)),
  cancelSecretPrompt: mock(() => Promise.resolve({ success: true } as any)),
  getPendingSecretPrompts: mock(() => Promise.resolve([] as any[])),
}

const mockVault = {
  getSecretValue: mock(() => Promise.resolve(null as string | null)),
  getSecretForUse: mock(() => Promise.resolve(null as any)),
  markSecretUsed: mock(() => Promise.resolve()),
  redactMessage: mock(() => Promise.resolve(false)),
  createSecret: mock(() => Promise.resolve({ id: 'sec-1', key: 'TEST_KEY' })),
  getSecretByKey: mock(() => Promise.resolve(null as any)),
  updateSecretValueByKey: mock(() => Promise.resolve(null as any)),
  deleteSecret: mock(() => Promise.resolve(false)),
  searchSecrets: mock(() => Promise.resolve([] as any[])),
  findMessageByContent: mock(() => Promise.resolve(null as string | null)),
  getEntryValue: mock(() => Promise.resolve(null as any)),
  createEntry: mock(() => Promise.resolve({ id: 'ent-1', key: 'TEST', entryType: 'text' })),
  getAttachment: mock(() => Promise.resolve(null as any)),
  // Required by plugins.ts vault adapter — Bun's mock.module is global so
  // every vault mock must expose every named export the production code uses.
  listKeysByPrefix: mock(() => Promise.resolve([] as string[])),
}

const mockVaultTypes = {
  createType: mock(() => Promise.resolve({ id: 'type-1', slug: 'wifi', name: 'WiFi' })),
}

mock.module('@/server/services/vault', () => mockVault)
mock.module('@/server/services/secret-redaction', () => mockRedaction)
mock.module('@/server/services/secret-prompts', () => mockSecretPrompts)
mock.module('@/server/services/vault-types', () => mockVaultTypes)
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

// Import after mocks
const {
  getSecretTool,
  redactSecretLeakTool,
  revealSecretTool,
  createSecretTool,
  updateSecretTool,
  deleteSecretTool,
  searchSecretsTool,
  getVaultEntryTool,
  createVaultEntryTool,
  createVaultTypeTool,
  getVaultAttachmentTool,
} = await import('@/server/tools/vault-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = { agentId: 'agent-abc', isSubAgent: false }

function execute(registration: any, args: any) {
  const t = registration.create(ctx)
  return t.execute(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

function resetMocks() {
  Object.values(mockVault).forEach((m) => m.mockReset())
  Object.values(mockRedaction).forEach((m) => m.mockReset())
  Object.values(mockSecretPrompts).forEach((m) => m.mockReset())
  Object.values(mockVaultTypes).forEach((m) => m.mockReset())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('vault-tools', () => {
  beforeEach(resetMocks)

  // ── Availability ──────────────────────────────────────────────────────────

  describe('availability', () => {
    it('all vault tools are main-only', () => {
      const tools = [
        getSecretTool, redactSecretLeakTool, revealSecretTool, createSecretTool, updateSecretTool,
        deleteSecretTool, searchSecretsTool, getVaultEntryTool, createVaultEntryTool,
        createVaultTypeTool, getVaultAttachmentTool,
      ]
      for (const t of tools) {
        expect(t.availability).toEqual(['main'])
      }
    })
  })

  // ── get_secret ────────────────────────────────────────────────────────────

  describe('get_secret', () => {
    it('returns the placeholder (never the value) when the secret exists', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1', key: 'MY_KEY', description: 'My key' })
      const result = await execute(getSecretTool, { key: 'MY_KEY' })
      expect(result.placeholder).toBe('{{secret:MY_KEY}}')
      expect(result.key).toBe('MY_KEY')
      expect(result.description).toBe('My key')
      expect(result.usage).toContain('verbatim')
      expect(result.value).toBeUndefined()
      // The decrypted value is never even read.
      expect(mockVault.getSecretValue).not.toHaveBeenCalled()
    })

    it('returns an actionable error when secret not found', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce(null)
      const result = await execute(getSecretTool, { key: 'NOPE' })
      expect(result.error).toContain('"NOPE" not found')
      expect(result.error).toContain('search_secrets')
    })
  })

  // ── redact_secret_leak ────────────────────────────────────────────────────

  describe('redact_secret_leak', () => {
    it('returns counters and the placeholder on success', async () => {
      mockRedaction.redactSecretLeak.mockResolvedValueOnce({ ok: true, messagesCleaned: 3, summariesCleaned: 1 })
      const result = await execute(redactSecretLeakTool, { key: 'GH_TOKEN' })
      expect(result.success).toBe(true)
      expect(result.placeholder).toBe('{{secret:GH_TOKEN}}')
      expect(result.messages_cleaned).toBe(3)
      expect(result.summaries_cleaned).toBe(1)
      expect(mockRedaction.redactSecretLeak).toHaveBeenCalledWith('GH_TOKEN')
    })

    it('propagates failures (unknown key, value too short)', async () => {
      mockRedaction.redactSecretLeak.mockResolvedValueOnce({ ok: false, error: 'Secret with key "NOPE" not found', messagesCleaned: 0, summariesCleaned: 0 })
      const result = await execute(redactSecretLeakTool, { key: 'NOPE' })
      expect(result).toEqual({ error: 'Secret with key "NOPE" not found' })
    })
  })

  // ── reveal_secret ─────────────────────────────────────────────────────────

  describe('reveal_secret', () => {
    it('creates a reveal prompt (approval card) and suspends the turn', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1', key: 'GH_TOKEN' })
      mockSecretPrompts.createSecretPrompt.mockResolvedValueOnce({ promptId: 'prompt-42' })
      const result = await execute(revealSecretTool, { key: 'GH_TOKEN', reason: 'debug the API signature' })
      expect(result.promptId).toBe('prompt-42')
      expect(result.status).toBe('awaiting_user_approval')
      expect(mockSecretPrompts.createSecretPrompt).toHaveBeenCalledWith({
        agentId: 'agent-abc',
        purpose: 'reveal',
        title: 'Reveal secret "GH_TOKEN" to the model?',
        description: 'debug the API signature',
        fields: [],
        spec: { key: 'GH_TOKEN', reason: 'debug the API signature' },
      })
    })

    it('errors without creating a prompt when the key does not exist', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce(null)
      const result = await execute(revealSecretTool, { key: 'NOPE', reason: 'x' })
      expect(result.error).toContain('"NOPE" not found')
      expect(mockSecretPrompts.createSecretPrompt).not.toHaveBeenCalled()
    })
  })

  // ── create_secret ─────────────────────────────────────────────────────────

  describe('create_secret', () => {
    it('creates secret when key does not exist', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce(null)
      mockVault.createSecret.mockResolvedValueOnce({ id: 'sec-new', key: 'NEW_KEY' })
      const result = await execute(createSecretTool, { key: 'NEW_KEY', value: 'val', description: 'desc' })
      expect(result.id).toBe('sec-new')
      expect(result.key).toBe('NEW_KEY')
      expect(result.placeholder).toBe('{{secret:NEW_KEY}}')
      expect(mockVault.createSecret).toHaveBeenCalledWith('NEW_KEY', 'val', 'agent-abc', 'desc')
    })

    it('returns error when key already exists', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-old', key: 'DUP' })
      const result = await execute(createSecretTool, { key: 'DUP', value: 'val' })
      expect(result).toEqual({ error: 'Secret with key "DUP" already exists. Use update_secret to change its value.' })
      expect(mockVault.createSecret).not.toHaveBeenCalled()
    })
  })

  // ── update_secret ─────────────────────────────────────────────────────────

  describe('update_secret', () => {
    it('updates secret when key exists', async () => {
      mockVault.updateSecretValueByKey.mockResolvedValueOnce({ id: 'sec-1' })
      const result = await execute(updateSecretTool, { key: 'KEY', value: 'new-val' })
      expect(result).toEqual({ id: 'sec-1', key: 'KEY', placeholder: '{{secret:KEY}}' })
    })

    it('returns error when key not found', async () => {
      mockVault.updateSecretValueByKey.mockResolvedValueOnce(null)
      const result = await execute(updateSecretTool, { key: 'MISSING', value: 'v' })
      expect(result).toEqual({ error: 'Secret with key "MISSING" not found' })
    })
  })

  // ── delete_secret ─────────────────────────────────────────────────────────

  describe('delete_secret', () => {
    it('deletes secret owned by this agent', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1', createdByAgentId: 'agent-abc' })
      mockVault.deleteSecret.mockResolvedValueOnce(true)
      const result = await execute(deleteSecretTool, { key: 'MY_SECRET' })
      expect(result).toEqual({ success: true, key: 'MY_SECRET' })
      expect(mockVault.deleteSecret).toHaveBeenCalledWith('sec-1')
    })

    it('returns error when secret not found', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce(null)
      const result = await execute(deleteSecretTool, { key: 'NOPE' })
      expect(result).toEqual({ error: 'Secret with key "NOPE" not found' })
    })

    it('refuses to delete secret owned by another agent', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-2', createdByAgentId: 'agent-other' })
      const result = await execute(deleteSecretTool, { key: 'THEIR_SECRET' })
      expect(result).toEqual({ error: 'Cannot delete this secret — it was not created by this Agent' })
      expect(mockVault.deleteSecret).not.toHaveBeenCalled()
    })

    it('returns error when deleteSecret fails', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1', createdByAgentId: 'agent-abc' })
      mockVault.deleteSecret.mockResolvedValueOnce(false)
      const result = await execute(deleteSecretTool, { key: 'FAIL' })
      expect(result).toEqual({ error: 'Failed to delete secret' })
    })
  })

  // ── search_secrets ────────────────────────────────────────────────────────

  describe('search_secrets', () => {
    it('returns matching secrets', async () => {
      mockVault.searchSecrets.mockResolvedValueOnce([{ key: 'GH_TOKEN', description: 'GitHub' }])
      const result = await execute(searchSecretsTool, { query: 'github' })
      expect(result).toEqual({ secrets: [{ key: 'GH_TOKEN', description: 'GitHub', placeholder: '{{secret:GH_TOKEN}}' }] })
    })

    it('returns empty array when no matches', async () => {
      mockVault.searchSecrets.mockResolvedValueOnce([])
      const result = await execute(searchSecretsTool, { query: 'zzz' })
      expect(result).toEqual({ secrets: [] })
    })
  })

  // ── get_vault_entry ───────────────────────────────────────────────────────

  describe('get_vault_entry', () => {
    it('returns the entry shape but never the decrypted values', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1' })
      mockVault.getEntryValue.mockResolvedValueOnce({ entryType: 'credential', value: { user: 'a', password: 'hunter2' } })
      const result = await execute(getVaultEntryTool, { key: 'CRED' })
      expect(result).toEqual({
        entryType: 'credential',
        fields: ['user', 'password'],
        placeholder: '{{secret:CRED}}',
      })
      expect(JSON.stringify(result)).not.toContain('hunter2')
    })

    it('returns fields: null for a plain string entry', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1' })
      mockVault.getEntryValue.mockResolvedValueOnce({ entryType: 'text', value: 'top-secret' })
      const result = await execute(getVaultEntryTool, { key: 'TXT' })
      expect(result).toEqual({ entryType: 'text', fields: null, placeholder: '{{secret:TXT}}' })
    })

    it('returns error when key not found', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce(null)
      const result = await execute(getVaultEntryTool, { key: 'NOPE' })
      expect(result).toEqual({ error: 'Entry not found' })
    })

    it('returns error when entry value not found', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-1' })
      mockVault.getEntryValue.mockResolvedValueOnce(null)
      const result = await execute(getVaultEntryTool, { key: 'ORPHAN' })
      expect(result).toEqual({ error: 'Entry not found' })
    })
  })

  // ── create_vault_entry ────────────────────────────────────────────────────

  describe('create_vault_entry', () => {
    it('creates entry when key is new', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce(null)
      mockVault.createEntry.mockResolvedValueOnce({ id: 'ent-1', key: 'WIFI_HOME', entryType: 'wifi' })
      const result = await execute(createVaultEntryTool, {
        key: 'WIFI_HOME', entry_type: 'wifi', value: { ssid: 'Home' },
      })
      expect(result).toEqual({ id: 'ent-1', key: 'WIFI_HOME', entryType: 'wifi' })
    })

    it('returns error when key already exists', async () => {
      mockVault.getSecretByKey.mockResolvedValueOnce({ id: 'sec-old' })
      const result = await execute(createVaultEntryTool, {
        key: 'DUP', entry_type: 'text', value: 'v',
      })
      expect(result).toEqual({ error: 'Entry with key "DUP" already exists' })
    })
  })

  // ── create_vault_type ─────────────────────────────────────────────────────

  describe('create_vault_type', () => {
    it('creates a custom type', async () => {
      mockVaultTypes.createType.mockResolvedValueOnce({ id: 'type-1', slug: 'wifi', name: 'WiFi' })
      const result = await execute(createVaultTypeTool, {
        name: 'WiFi', slug: 'wifi', icon: 'Wifi',
        fields: [{ name: 'ssid', label: 'SSID', type: 'text', required: true }],
      })
      expect(result).toEqual({ id: 'type-1', slug: 'wifi', name: 'WiFi' })
    })

    it('returns error on failure', async () => {
      mockVaultTypes.createType.mockRejectedValueOnce(new Error('Slug taken'))
      const result = await execute(createVaultTypeTool, {
        name: 'WiFi', slug: 'wifi', fields: [],
      })
      expect(result).toEqual({ error: 'Slug taken' })
    })

    it('handles non-Error throws', async () => {
      mockVaultTypes.createType.mockRejectedValueOnce('boom')
      const result = await execute(createVaultTypeTool, {
        name: 'X', slug: 'x', fields: [],
      })
      expect(result).toEqual({ error: 'Failed to create type' })
    })
  })

  // ── get_vault_attachment ──────────────────────────────────────────────────

  describe('get_vault_attachment', () => {
    it('returns metadata only, never the attachment bytes', async () => {
      const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
      mockVault.getAttachment.mockResolvedValueOnce({ name: 'file.txt', mimeType: 'text/plain', data })
      const result = await execute(getVaultAttachmentTool, { attachment_id: 'att-1' })
      expect(result).toEqual({ name: 'file.txt', mimeType: 'text/plain', size: 5 })
    })

    it('returns error when attachment not found', async () => {
      mockVault.getAttachment.mockResolvedValueOnce(null)
      const result = await execute(getVaultAttachmentTool, { attachment_id: 'att-x' })
      expect(result).toEqual({ error: 'Attachment not found' })
    })
  })
})
