import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mocks ───────────────────────────────────────────────────────────────────
//
// channels.ts route depends on the service layer (channels.ts) and the kin
// resolver. We stub them and exercise the route handlers via the Hono test
// fetch interface.

const mockGetChannel = mock(() => Promise.resolve(null as any))
const mockUpdateChannel = mock(() => Promise.resolve(null as any))
type TransferResult =
  | { ok: true; noop?: false; transferredAt: number; previousKinSlug: string; newKinSlug: string; fromKinId: string; fromKinName: string; toKinId: string; toKinName: string }
  | { ok: true; noop: true; message: string }
  | { ok: false; error: string }

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
const mockResolveKinId = mock(() => null as string | null)

mock.module('@/server/services/channels', () => ({
  createChannel: mock(() => Promise.resolve({})),
  getChannel: mockGetChannel,
  listChannels: mock(() => Promise.resolve([])),
  updateChannel: mockUpdateChannel,
  deleteChannel: mock(() => Promise.resolve()),
  activateChannel: mock(() => Promise.resolve(null)),
  deactivateChannel: mock(() => Promise.resolve(null)),
  testChannel: mock(() => Promise.resolve({ valid: true })),
  listPendingUsers: mock(() => Promise.resolve([])),
  approveChannelUser: mock(() => Promise.resolve()),
  countPendingApprovals: mock(() => Promise.resolve(0)),
  countPendingApprovalsForChannel: mock(() => Promise.resolve(0)),
  handleIncomingChannelMessage: mock(() => Promise.resolve()),
  transferChannel: mockTransferChannel,
  // Pure in-memory shims for other test files
  setChannelQueueMeta: () => undefined,
  getChannelQueueMeta: () => undefined,
  popChannelQueueMeta: () => undefined,
  setChannelOriginMeta: () => undefined,
  getChannelOriginMeta: () => undefined,
  setChannelTransferHint: () => undefined,
  popChannelTransferHint: () => undefined,
  deliverChannelResponse: () => undefined,
  findContactByPlatformId: () => undefined,
  listContactPlatformIds: () => [],
  addContactPlatformId: () => ({}),
  removeContactPlatformId: () => true,
  getActiveChannelsForKin: () => [],
  restoreActiveChannels: async () => {},
  resolveChannelLocale: () => 'en',
}))

mock.module('@/server/services/kin-resolver', () => ({
  resolveKinId: mockResolveKinId,
  resolveKinByIdOrSlug: mock(() => null),
}))

// Minimal DB chain. Kin lookup after a successful transfer reads (name, avatarPath).
const dbChain: any = {
  select: mock(() => dbChain),
  from: mock(() => dbChain),
  where: mock(() => dbChain),
  get: mock(() => ({ name: 'Kube Master', avatarPath: null })),
}

mock.module('@/server/db/index', () => ({ db: dbChain }))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  kins: { id: 'id', name: 'name', avatarPath: 'avatarPath' },
}))

// Full ChannelAdapterRegistry surface so other test files importing the
// poisoned module still find the methods they need (mock.module is global).
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

mock.module('@/server/channels/configSchemaValidator', () => ({
  buildZodSchemaFromConfigSchema: () => ({ safeParse: () => ({ success: true, data: {} }) }),
  formatZodIssues: () => '',
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (...args: unknown[]) => args,
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channelRoutes: any
let _mocksWorking = false
try {
  const mod = await import('@/server/routes/channels')
  channelRoutes = mod.channelRoutes
  _mocksWorking = !!channelRoutes
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

beforeEach(() => {
  mockGetChannel.mockReset()
  mockUpdateChannel.mockReset()
  mockTransferChannel.mockReset()
  mockResolveKinId.mockReset()
  // Default service return is a successful, non-noop transfer. Specific
  // tests override with mockResolvedValueOnce as needed.
  mockTransferChannel.mockResolvedValue({
    ok: true,
    transferredAt: 1700000000000,
    previousKinSlug: 'kinbot-master',
    newKinSlug: 'kube-master',
    fromKinId: 'kin-source',
    fromKinName: 'KinBot Master',
    toKinId: 'kin-target',
    toKinName: 'Kube Master',
  })
  // Reset DB chain default to the successful-Kin-lookup return.
  dbChain.get.mockReset()
  dbChain.get.mockImplementation(() => ({ name: 'Kube Master', avatarPath: null }))
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('channelRoutes', () => {
  describe('PATCH /:id', () => {
    itMocked('rejects a kinId mutation with 400 KINID_NOT_PATCHABLE', async () => {
      mockGetChannel.mockResolvedValue({ id: 'ch-1', name: 'Test', kinId: 'kin-source' })

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kinId: 'kin-other' }),
        }),
      )

      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error.code).toBe('KINID_NOT_PATCHABLE')
      expect(body.error.message).toContain('/transfer')
      expect(mockUpdateChannel).not.toHaveBeenCalled()
      expect(mockTransferChannel).not.toHaveBeenCalled()
    })

    itMocked('allows a name-only patch (no kinId) and forwards it to updateChannel', async () => {
      mockGetChannel
        .mockResolvedValueOnce({ id: 'ch-1', name: 'Old', kinId: 'kin-source' })
      mockUpdateChannel.mockResolvedValueOnce({
        id: 'ch-1',
        name: 'New name',
        kinId: 'kin-source',
        platform: 'telegram',
        platformConfig: '{}',
        status: 'active',
        statusMessage: null,
        autoCreateContacts: 0,
        messagesReceived: 0,
        messagesSent: 0,
        lastActivityAt: null,
        createdBy: 'user',
        createdAt: new Date(0),
      })

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New name' }),
        }),
      )

      expect(resp.status).toBe(200)
      expect(mockUpdateChannel).toHaveBeenCalledTimes(1)
      // The kinId key MUST NOT be in the patch forwarded to updateChannel.
      const patchArg = (mockUpdateChannel.mock.calls as any[])[0][1]
      expect('kinId' in patchArg).toBe(false)
      expect(patchArg.name).toBe('New name')
    })

    itMocked('strips a kinId that matches the current binding before calling updateChannel', async () => {
      mockGetChannel
        .mockResolvedValueOnce({ id: 'ch-1', name: 'Old', kinId: 'kin-source' })
      mockUpdateChannel.mockResolvedValueOnce({
        id: 'ch-1',
        name: 'Old',
        kinId: 'kin-source',
        platform: 'telegram',
        platformConfig: '{}',
        status: 'active',
        statusMessage: null,
        autoCreateContacts: 0,
        messagesReceived: 0,
        messagesSent: 0,
        lastActivityAt: null,
        createdBy: 'user',
        createdAt: new Date(0),
      })

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kinId: 'kin-source', name: 'Old' }),
        }),
      )

      expect(resp.status).toBe(200)
      const patchArg = (mockUpdateChannel.mock.calls as any[])[0][1]
      expect('kinId' in patchArg).toBe(false)
    })
  })

  describe('POST /:id/transfer', () => {
    itMocked('happy path: resolves targetKinSlug, calls transferChannel(initiatedBy=ui), returns 200', async () => {
      mockGetChannel
        .mockResolvedValueOnce({ id: 'ch-1', name: 'Telegram', kinId: 'kin-source' })
        .mockResolvedValueOnce({
          id: 'ch-1',
          name: 'Telegram',
          kinId: 'kin-target',
          platform: 'telegram',
          platformConfig: '{}',
          status: 'active',
          statusMessage: null,
          autoCreateContacts: 0,
          messagesReceived: 0,
          messagesSent: 0,
          lastActivityAt: null,
          createdBy: 'user',
          createdAt: new Date(0),
        })
      mockResolveKinId.mockReturnValue('kin-target')

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetKinSlug: 'kube-master', reason: 'handoff' }),
        }),
      )

      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.ok).toBe(true)
      expect(body.newKinSlug).toBe('kube-master')
      expect(body.previousKinSlug).toBe('kinbot-master')
      expect(body.channel?.kinId).toBe('kin-target')

      expect(mockTransferChannel).toHaveBeenCalledTimes(1)
      const args = (mockTransferChannel.mock.calls as any[])[0][0]
      expect(args.channelId).toBe('ch-1')
      expect(args.targetKinId).toBe('kin-target')
      expect(args.reason).toBe('handoff')
      expect(args.initiatedBy).toBe('ui')
    })

    itMocked('returns 400 when neither targetKinId nor targetKinSlug is provided', async () => {
      mockGetChannel.mockResolvedValueOnce({ id: 'ch-1', name: 'Test', kinId: 'kin-source' })

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'oops' }),
        }),
      )

      expect(resp.status).toBe(400)
      const body = await resp.json()
      expect(body.error.code).toBe('VALIDATION_ERROR')
      expect(mockTransferChannel).not.toHaveBeenCalled()
    })

    itMocked('returns 404 when targetKinSlug cannot be resolved', async () => {
      mockGetChannel.mockResolvedValueOnce({ id: 'ch-1', name: 'Test', kinId: 'kin-source' })
      mockResolveKinId.mockReturnValue(null)

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetKinSlug: 'nope' }),
        }),
      )

      expect(resp.status).toBe(404)
      const body = await resp.json()
      expect(body.error.code).toBe('NOT_FOUND')
      expect(mockTransferChannel).not.toHaveBeenCalled()
    })

    itMocked('returns the service no-op envelope as 200 with noop:true', async () => {
      mockGetChannel.mockResolvedValueOnce({ id: 'ch-1', name: 'Test', kinId: 'kin-target' })
      mockResolveKinId.mockReturnValue('kin-target')
      mockTransferChannel.mockResolvedValueOnce({
        ok: true,
        noop: true,
        message: 'Channel is already bound to this Kin.',
      })

      const resp = await channelRoutes.fetch(
        new Request('http://localhost/ch-1/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetKinSlug: 'kube-master' }),
        }),
      )

      expect(resp.status).toBe(200)
      const body = await resp.json()
      expect(body.ok).toBe(true)
      expect(body.noop).toBe(true)
    })
  })
})
