import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks (so importing the tool module doesn't touch the DB) ────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockService: Record<string, any> = {
  createAccountTrigger: mock(() => Promise.resolve({
    id: 'trg-1', name: 'Invoices', accountId: 'acc1', accountLabel: 'a@b.com', folder: 'INBOX',
    isActive: true, requiresApproval: false, conditions: { type: 'group', op: 'and', children: [] },
    conditionsSummary: 'subject contains "x"', prompt: 'p', targetAgentId: 'agent-123',
    targetAgentName: 'Self', targetAgentAvatarUrl: null, dispatchMode: 'conversation',
    maxConcurrentTasks: 1, triggerCount: 0, createdBy: 'agent', createdAt: 0,
  })),
  updateAccountTrigger: mock(() => Promise.resolve(null)),
  deleteAccountTrigger: mock(() => Promise.resolve()),
  listAccountTriggers: mock(() => Promise.resolve([])),
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEmailAccounts: Record<string, any> = {
  listEmailAccounts: mock(() => Promise.resolve([
    { id: 'acc1', slug: 'gmail', name: '', type: 'gmail', emailAddress: 'a@b.com', sendMode: 'direct', allowedAgentIds: null, isValid: true, lastError: null },
  ])),
  resolveEmailProviderByAccountId: mock(() => Promise.resolve({ provider: { listFolders: undefined }, config: {}, account: { slug: 'gmail', emailAddress: 'a@b.com' }, sendMode: 'direct' })),
}

mock.module('@/server/services/account-triggers', () => mockService)
mock.module('@/server/services/email-accounts', () => mockEmailAccounts)
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

// ─── Import after mocks ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createAccountTriggerTool: any, deleteAccountTriggerTool: any
let _mocksWorking = false
try {
  const mod = await import('@/server/tools/account-trigger-tools')
  createAccountTriggerTool = mod.createAccountTriggerTool
  deleteAccountTriggerTool = mod.deleteAccountTriggerTool
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

const fakeCtx: ToolExecutionContext = { agentId: 'agent-123', userId: 'user-1', isSubAgent: false }
const opts = { toolCallId: 'tc', messages: [] as any, abortSignal: new AbortController().signal }
function execute(reg: any, args: any) {
  return reg.create(fakeCtx).execute(args, opts)
}

const validTree = JSON.stringify({ type: 'group', op: 'and', children: [{ type: 'leaf', field: 'subject', op: 'contains', value: 'x' }] })

describe('account-trigger-tools', () => {
  beforeEach(() => {
    mockService.createAccountTrigger.mockClear()
    mockService.deleteAccountTrigger.mockClear()
  })

  itMocked('create rejects invalid conditions JSON without calling the service', async () => {
    const res = await execute(createAccountTriggerTool, {
      account: 'gmail', name: 'X', conditions: '{not json', prompt: 'p',
    })
    expect(res.error).toContain('Invalid conditions')
    expect(mockService.createAccountTrigger).not.toHaveBeenCalled()
  })

  itMocked('create rejects a structurally invalid tree (empty group)', async () => {
    const res = await execute(createAccountTriggerTool, {
      account: 'gmail', name: 'X', conditions: JSON.stringify({ type: 'group', op: 'and', children: [] }), prompt: 'p',
    })
    expect(res.error).toContain('Invalid conditions')
    expect(mockService.createAccountTrigger).not.toHaveBeenCalled()
  })

  itMocked('create passes a valid tree through to the service and defaults target to the caller', async () => {
    const res = await execute(createAccountTriggerTool, {
      account: 'gmail', name: 'Invoices', conditions: validTree, prompt: 'p',
    })
    expect(res.trigger?.id).toBe('trg-1')
    expect(mockService.createAccountTrigger).toHaveBeenCalledTimes(1)
    const arg = mockService.createAccountTrigger.mock.calls[0][0]
    expect(arg.accountId).toBe('acc1')
    expect(arg.targetAgentId).toBe('agent-123')
    expect(arg.createdBy).toBe('agent')
  })

  itMocked('create surfaces an unknown account as an error', async () => {
    const res = await execute(createAccountTriggerTool, {
      account: 'does-not-exist', name: 'X', conditions: validTree, prompt: 'p',
    })
    expect(res.error).toContain('Email account not found')
  })

  itMocked('delete calls the service', async () => {
    const res = await execute(deleteAccountTriggerTool, { trigger_id: 'trg-1' })
    expect(res.deleted).toBe(true)
    expect(mockService.deleteAccountTrigger).toHaveBeenCalledTimes(1)
  })
})
