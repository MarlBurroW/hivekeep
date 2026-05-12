import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'
import type { ToolRegistration } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// The tool is now a thin wrapper around the transferChannel() service: it
// resolves channelId (from the explicit arg or from ctx.channelOriginId),
// resolves the target Kin slug to a UUID, and forwards everything to the
// service. The service owns the DB mutation, audit rows, sideband hint,
// SSE broadcast, and adapter.onIdentityChange. Those side effects belong to
// the service test surface (services/channels.ts), not this file.

const mockGetChannelOriginMeta = mock(() => undefined as any)
const mockResolveKinId = mock(() => null as string | null)

type TransferResult =
  | { ok: true; noop?: false; transferredAt: number; previousKinSlug: string; newKinSlug: string; fromKinId: string; fromKinName: string; toKinId: string; toKinName: string }
  | { ok: true; noop: true; message: string }
  | { ok: false; error: string }

// transferChannel spy — the heart of the wrapper test. Configure per case.
const mockTransferChannel = mock<(...args: any[]) => Promise<TransferResult>>(() =>
  Promise.resolve({
    ok: true,
    transferredAt: 1700000000000,
    previousKinSlug: 'kinbot-master',
    newKinSlug: 'kube-master',
    fromKinId: 'kin-source',
    fromKinName: 'KinBot Master',
    toKinId: 'kin-target',
    toKinName: 'Kube Master',
  } as TransferResult),
)

// Pure in-memory queue meta stubs so other test files that load
// @/server/services/channels through the poisoned module cache still find
// the sideband helpers they expect (mock.module is process-global in Bun).
const _queueMeta = new Map<string, any>()
const _originMeta = new Map<string, any>()
const _transferHints = new Map<string, any>()

mock.module('@/server/services/channels', () => ({
  // Used by transfer_channel under test
  transferChannel: mockTransferChannel,
  getChannelOriginMeta: mockGetChannelOriginMeta,
  getChannel: mock(() => Promise.resolve(null)),
  // Pure in-memory sideband helpers (mirror the real implementation) so
  // other test files importing from channels.ts via the poisoned cache
  // still get something usable.
  setChannelQueueMeta: (id: string, meta: any) => { _queueMeta.set(id, meta) },
  getChannelQueueMeta: (id: string) => _queueMeta.get(id),
  popChannelQueueMeta: (id: string) => {
    const meta = _queueMeta.get(id)
    if (meta) _queueMeta.delete(id)
    return meta
  },
  setChannelOriginMeta: (id: string, meta: any) => { _originMeta.set(id, meta) },
  setChannelTransferHint: () => undefined,
  popChannelTransferHint: (id: string) => {
    const h = _transferHints.get(id)
    if (h) _transferHints.delete(id)
    return h
  },
  // Re-exports referenced by channel-tools.ts but not under test here
  listChannels: mock(() => Promise.resolve([])),
  listChannelConversations: mock(() => Promise.resolve({ users: [], chatIds: [] })),
  createChannel: mock(() => Promise.resolve({})),
  updateChannel: mock(() => Promise.resolve({})),
  deleteChannel: mock(() => Promise.resolve()),
  activateChannel: mock(() => Promise.resolve({})),
  deactivateChannel: mock(() => Promise.resolve({})),
  testChannel: mock(() => Promise.resolve({ valid: true })),
  handleIncomingChannelMessage: mock(() => Promise.resolve()),
  deliverChannelResponse: mock(() => Promise.resolve()),
  findContactByPlatformId: mock(() => undefined),
  listPendingUsers: mock(() => Promise.resolve([])),
  approveChannelUser: mock(() => Promise.resolve()),
  countPendingApprovals: mock(() => Promise.resolve(0)),
  countPendingApprovalsForChannel: mock(() => Promise.resolve(0)),
  listContactPlatformIds: mock(() => []),
  addContactPlatformId: mock(() => ({})),
  removeContactPlatformId: mock(() => true),
  getActiveChannelsForKin: () => [],
  restoreActiveChannels: async () => {},
  resolveChannelLocale: () => 'en',
}))

mock.module('@/server/services/kin-resolver', () => ({
  resolveKinId: mockResolveKinId,
  resolveKinByIdOrSlug: mock(() => null),
}))

mock.module('@/server/db/index', () => ({ db: {} }))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  kins: { id: 'id', slug: 'slug', name: 'name' },
  messages: { id: 'id' },
  channels: { id: 'id' },
}))

// Full ChannelAdapterRegistry surface so other test files that import the
// poisoned module still find the methods they need.
const _adapters = new Map<string, any>()
const _pluginAdapters = new Set<string>()
mock.module('@/server/channels/index', () => ({
  channelAdapters: {
    get: (p: string) => _adapters.get(p),
    has: (p: string) => _adapters.has(p),
    list: () => Array.from(_adapters.keys()),
    listWithMeta: () => [],
    register: (a: any) => { _adapters.set(a.platform, a) },
    registerPlugin: (a: any) => { _adapters.set(a.platform, a); _pluginAdapters.add(a.platform) },
    unregisterPlugin: (p: string) => {
      if (_pluginAdapters.has(p)) { _adapters.delete(p); _pluginAdapters.delete(p) }
    },
    isPluginAdapter: (p: string) => _pluginAdapters.has(p),
  },
}))

mock.module('@/server/sse/index', () => ({
  sseManager: { broadcast: () => undefined, sendToKin: () => undefined },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (...args: unknown[]) => args,
}))

// Import after mocks (Bun mock.module() is process-global and other test files
// may have poisoned exports; fall back to it.skip if so, mirroring the pattern
// used by task-tools.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let transferChannelTool: any
let _mocksWorking = false
try {
  const mod = await import('@/server/tools/channel-tools')
  transferChannelTool = mod.transferChannelTool
  _mocksWorking = !!transferChannelTool
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

// ─── Helpers ─────────────────────────────────────────────────────────────────

function executeTool(registration: ToolRegistration, input: Record<string, unknown> = {}, ctxOverrides: Record<string, unknown> = {}) {
  const t = registration.create({
    kinId: 'caller-kin',
    isSubKin: false,
    ...ctxOverrides,
  })
  return (t as any).execute(input, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

beforeEach(() => {
  mockGetChannelOriginMeta.mockReset()
  mockResolveKinId.mockReset()
  mockTransferChannel.mockReset()
  // Default: happy path, returns a successful transfer payload.
  mockTransferChannel.mockResolvedValue({
    ok: true,
    transferredAt: 1700000000000,
    previousKinSlug: 'kinbot-master',
    newKinSlug: 'kube-master',
    fromKinId: 'kin-source',
    fromKinName: 'KinBot Master',
    toKinId: 'kin-target',
    toKinName: 'Kube Master',
  } as TransferResult)
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('transferChannelTool (wrapper around transferChannel service)', () => {
  itMocked('forwards explicit channelId + resolved Kin UUID + reason + initiatedBy="tool" to the service', async () => {
    mockResolveKinId.mockReturnValue('kin-target')

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-1',
      targetKinSlug: 'kube-master',
      reason: 'Nicolas wants to talk to Kube Master about the cluster',
    })

    expect(result.ok).toBe(true)
    expect(result.previousKinSlug).toBe('kinbot-master')
    expect(result.newKinSlug).toBe('kube-master')

    expect(mockTransferChannel).toHaveBeenCalledTimes(1)
    const args = (mockTransferChannel.mock.calls as any[])[0][0]
    expect(args.channelId).toBe('ch-1')
    expect(args.targetKinId).toBe('kin-target')
    expect(args.reason).toBe('Nicolas wants to talk to Kube Master about the cluster')
    expect(args.initiatedBy).toBe('tool')
    expect(args.calledByKinId).toBe('caller-kin')
  })

  itMocked('propagates the service no-op result to the caller', async () => {
    mockResolveKinId.mockReturnValue('kin-target')
    mockTransferChannel.mockResolvedValue({
      ok: true,
      noop: true,
      message: 'Channel is already bound to this Kin.',
    })

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-1',
      targetKinSlug: 'kube-master',
    })

    expect(result.ok).toBe(true)
    expect(result.noop).toBe(true)
    expect(result.message).toContain('already bound')
  })

  itMocked('returns the service error verbatim when transferChannel fails', async () => {
    mockResolveKinId.mockReturnValue('kin-target')
    mockTransferChannel.mockResolvedValue({
      ok: false,
      error: 'Channel "ch-missing" not found.',
    })

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-missing',
      targetKinSlug: 'kube-master',
    })

    expect(result.error).toContain('Channel "ch-missing" not found')
  })

  itMocked('returns an error and does NOT call the service when the target Kin slug is unknown', async () => {
    mockResolveKinId.mockReturnValue(null)

    const result = await executeTool(transferChannelTool, {
      channelId: 'ch-1',
      targetKinSlug: 'no-such-kin',
    })

    expect(result.error).toContain('Kin "no-such-kin" not found')
    expect(mockTransferChannel).not.toHaveBeenCalled()
  })

  itMocked('errors out when channelId is missing and cannot be inferred from context', async () => {
    const result = await executeTool(transferChannelTool, {
      targetKinSlug: 'kube-master',
    })

    expect(result.error).toContain('channelId could not be inferred')
    expect(mockTransferChannel).not.toHaveBeenCalled()
  })

  itMocked('infers channelId from ctx.channelOriginId when not passed explicitly', async () => {
    mockGetChannelOriginMeta.mockReturnValue({
      channelId: 'ch-from-context',
      platformChatId: 'chat-1',
      platformMessageId: 'msg-1',
      platformUserId: 'usr-1',
      createdAt: Date.now(),
      ttlMs: 60000,
    })
    mockResolveKinId.mockReturnValue('kin-target')

    const result = await executeTool(
      transferChannelTool,
      { targetKinSlug: 'kube-master' },
      { channelOriginId: 'queue-item-42' },
    )

    expect(result.ok).toBe(true)
    expect(mockTransferChannel).toHaveBeenCalledTimes(1)
    expect((mockTransferChannel.mock.calls as any[])[0][0].channelId).toBe('ch-from-context')
  })

  itMocked('rejects a reason longer than 200 characters via the Zod schema (before reaching the service)', async () => {
    const tooLong = 'x'.repeat(201)
    const t = transferChannelTool.create({ kinId: 'caller-kin', isSubKin: false })
    const parsed = t.inputSchema.safeParse({ channelId: 'ch-1', targetKinSlug: 's', reason: tooLong })
    expect(parsed.success).toBe(false)
  })
})
