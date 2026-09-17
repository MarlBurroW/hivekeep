import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'
import type { ToolRegistration } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockListChannels = mock(() => Promise.resolve([] as any[]))
const mockListChannelsWithOwners = mock(() => Promise.resolve([] as any[]))
const mockGetChannel = mock(() => Promise.resolve(null as any))
const mockListChannelConversations = mock(() => Promise.resolve({ users: [], chatIds: [] }))
const mockSendToChannelAs = mock(() =>
  Promise.resolve({ ok: true, result: { platformMessageId: 'msg-123', prefixed: false } } as any),
)

// Re-implement the pure in-memory queue meta functions so that other test files
// (channels.test.ts, channels/index.test.ts) that import from @/server/services/channels
// still work correctly (Bun mock.module is process-global).
const _queueMeta = new Map<string, any>()

mock.module('@/server/services/channels', () => ({
  listChannels: mockListChannels,
  listChannelsWithOwners: mockListChannelsWithOwners,
  getChannel: mockGetChannel,
  listChannelConversations: mockListChannelConversations,
  sendToChannelAs: mockSendToChannelAs,
  // Pure in-memory functions needed by other test files
  setChannelQueueMeta: (id: string, meta: any) => { _queueMeta.set(id, meta) },
  getChannelQueueMeta: (id: string) => _queueMeta.get(id),
  popChannelQueueMeta: (id: string) => {
    const meta = _queueMeta.get(id)
    if (meta) _queueMeta.delete(id)
    return meta
  },
  // Stubs for any other exports that might be imported
  reportUndeliveredChannelReply: async () => {},
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
  setChannelOriginMeta: () => {},
  getChannelOriginMeta: () => undefined,
  getActiveChannelsForAgent: () => [],
  restoreActiveChannels: async () => {},
  transferChannel: mock(() => Promise.resolve({ ok: true, transferred: true })),
}))

const mockSendMessage = mock(() => Promise.resolve({ platformMessageId: 'msg-123' }))

// Provide a full ChannelAdapterRegistry-compatible mock
const _adapters = new Map<string, any>()
const _pluginAdapters = new Set<string>()

mock.module('@/server/channels/index', () => ({
  channelAdapters: {
    get: (platform: string) => {
      if (platform === 'telegram') return { sendMessage: mockSendMessage, platform: 'telegram' }
      return _adapters.get(platform)
    },
    has: (platform: string) => platform === 'telegram' || _adapters.has(platform),
    list: () => ['telegram', ...Array.from(_adapters.keys())],
    register: (adapter: any) => { _adapters.set(adapter.platform, adapter) },
    registerPlugin: (adapter: any) => {
      _adapters.set(adapter.platform, adapter)
      _pluginAdapters.add(adapter.platform)
    },
    unregisterPlugin: (platform: string) => {
      if (_pluginAdapters.has(platform)) {
        _adapters.delete(platform)
        _pluginAdapters.delete(platform)
      }
    },
    isPluginAdapter: (platform: string) => _pluginAdapters.has(platform),
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
  },
}))

// ─── Import after mocks ─────────────────────────────────────────────────────

const { listChannelsTool, listChannelConversationsTool, sendChannelMessageTool } = await import(
  '@/server/tools/channel-tools'
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTool(registration: ToolRegistration) {
  return registration.create({
    agentId: 'agent-1',
    userId: 'user-1',
    isSubAgent: false,
  })
}

function executeTool(registration: ToolRegistration, input: Record<string, unknown> = {}) {
  const t = createTool(registration)
  return (t as any).execute(input, { toolCallId: 'tc-1', messages: [] })
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockListChannels.mockReset()
  mockListChannelsWithOwners.mockReset()
  mockGetChannel.mockReset()
  mockListChannelConversations.mockReset()
  mockSendMessage.mockReset()
  mockSendMessage.mockResolvedValue({ platformMessageId: 'msg-123' })
  mockSendToChannelAs.mockReset()
  mockSendToChannelAs.mockResolvedValue({ ok: true, result: { platformMessageId: 'msg-123', prefixed: false } } as any)
})

// ─── listChannelsTool ────────────────────────────────────────────────────────

describe('listChannelsTool', () => {
  it('has correct availability', () => {
    expect(listChannelsTool.availability).toEqual(['main'])
  })

  it('returns empty array when no channels exist', async () => {
    mockListChannels.mockResolvedValue([])
    const result = await executeTool(listChannelsTool)
    expect(result.channels).toEqual([])
    expect(mockListChannels).toHaveBeenCalledWith('agent-1')
  })

  it('returns formatted channel list', async () => {
    mockListChannels.mockResolvedValue([
      {
        id: 'ch-1',
        name: 'My Telegram',
        platform: 'telegram',
        status: 'active',
        messagesReceived: 42,
        messagesSent: 10,
        lastActivityAt: 1709683200000,
      },
      {
        id: 'ch-2',
        name: 'My Discord',
        platform: 'discord',
        status: 'inactive',
        messagesReceived: 0,
        messagesSent: 0,
        lastActivityAt: null,
      },
    ])

    const result = await executeTool(listChannelsTool)
    expect(result.channels).toHaveLength(2)

    expect(result.channels[0].id).toBe('ch-1')
    expect(result.channels[0].platform).toBe('telegram')
    expect(result.channels[0].status).toBe('active')
    expect(result.channels[0].messagesReceived).toBe(42)
    expect(result.channels[0].messagesSent).toBe(10)
    expect(result.channels[0].lastActivityAt).toBeTruthy()

    expect(result.channels[1].lastActivityAt).toBeNull()
  })

  it('scope "all" returns every channel with owner info', async () => {
    mockListChannelsWithOwners.mockResolvedValue([
      {
        id: 'ch-1',
        agentId: 'agent-1',
        name: 'Mine',
        platform: 'telegram',
        status: 'active',
        ownerAgentSlug: 'me',
        ownerAgentName: 'Me',
        messagesReceived: 1,
        messagesSent: 2,
        lastActivityAt: null,
      },
      {
        id: 'ch-2',
        agentId: 'other-agent',
        name: 'Dispatcher Discord',
        platform: 'discord',
        status: 'active',
        ownerAgentSlug: 'dispatcher-central',
        ownerAgentName: 'Dispatcher Central',
        messagesReceived: 0,
        messagesSent: 0,
        lastActivityAt: null,
      },
    ])

    const result = await executeTool(listChannelsTool, { scope: 'all' })
    expect(mockListChannelsWithOwners).toHaveBeenCalledTimes(1)
    expect(mockListChannels).not.toHaveBeenCalled()
    expect(result.channels).toHaveLength(2)
    expect(result.channels[0].owned).toBe(true)
    expect(result.channels[0].ownerAgentSlug).toBe('me')
    expect(result.channels[1].owned).toBe(false)
    expect(result.channels[1].ownerAgentName).toBe('Dispatcher Central')
  })
})

// ─── listChannelConversationsTool ────────────────────────────────────────────

describe('listChannelConversationsTool', () => {
  it('has correct availability', () => {
    expect(listChannelConversationsTool.availability).toEqual(['main'])
  })

  it('returns error when channel not found', async () => {
    mockGetChannel.mockResolvedValue(null)
    const result = await executeTool(listChannelConversationsTool, { channel_id: 'ch-missing' })
    expect(result.error).toBe('Channel not found')
  })

  it('returns conversations cross-Agent when channel belongs to another agent', async () => {
    mockGetChannel.mockResolvedValue({ id: 'ch-1', agentId: 'other-agent' })
    mockListChannelConversations.mockResolvedValue({
      users: [{ id: 'u1', name: 'Alice' }],
      chatIds: ['chat-1'],
    } as any)
    const result = await executeTool(listChannelConversationsTool, { channel_id: 'ch-1' })
    expect(result.users).toHaveLength(1)
    expect(mockListChannelConversations).toHaveBeenCalledWith('ch-1')
  })

  it('returns conversations when channel exists and belongs to agent', async () => {
    mockGetChannel.mockResolvedValue({ id: 'ch-1', agentId: 'agent-1' })
    mockListChannelConversations.mockResolvedValue({
      users: [{ id: 'u1', name: 'Alice' }],
      chatIds: ['chat-1', 'chat-2'],
    } as any)

    const result = await executeTool(listChannelConversationsTool, { channel_id: 'ch-1' })
    expect(result.users).toHaveLength(1)
    expect(result.chatIds).toHaveLength(2)
    expect(mockListChannelConversations).toHaveBeenCalledWith('ch-1')
  })
})

// ─── sendChannelMessageTool ──────────────────────────────────────────────────

describe('sendChannelMessageTool', () => {
  it('has correct availability', () => {
    expect(sendChannelMessageTool.availability).toEqual(['main'])
  })

  it('returns error when sendToChannelAs reports channel not found', async () => {
    mockSendToChannelAs.mockResolvedValue({ ok: false, error: 'Channel not found' } as any)
    const result = await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-missing',
      chat_id: 'chat-1',
      message: 'Hello',
    })
    expect(result.error).toBe('Channel not found')
  })

  it('sends cross-Agent: delegates to sendToChannelAs with the calling agent as sender', async () => {
    mockSendToChannelAs.mockResolvedValue({ ok: true, result: { platformMessageId: 'msg-x', prefixed: true } } as any)
    const result = await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-other',
      chat_id: 'chat-1',
      message: 'Daily AI brief',
    })
    expect(result.success).toBe(true)
    expect(result.prefixed).toBe(true)
    expect(mockSendToChannelAs).toHaveBeenCalledWith({
      channelId: 'ch-other',
      senderAgentId: 'agent-1',
      chatId: 'chat-1',
      content: 'Daily AI brief',
      attachments: undefined,
    })
  })

  it('returns error when sendToChannelAs reports channel is not active', async () => {
    mockSendToChannelAs.mockResolvedValue({ ok: false, error: 'Channel is not active' } as any)
    const result = await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-1',
      chat_id: 'chat-1',
      message: 'Hello',
    })
    expect(result.error).toBe('Channel is not active')
  })

  it('returns error when sendToChannelAs reports no adapter', async () => {
    mockSendToChannelAs.mockResolvedValue({ ok: false, error: 'No adapter for platform whatsapp' } as any)
    const result = await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-1',
      chat_id: 'chat-1',
      message: 'Hello',
    })
    expect(result.error).toBe('No adapter for platform whatsapp')
  })

  it('sends message successfully', async () => {
    const result = await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-1',
      chat_id: 'chat-42',
      message: 'Hello world',
    })

    expect(result.success).toBe(true)
    expect(result.platformMessageId).toBe('msg-123')
    expect(mockSendToChannelAs).toHaveBeenCalledWith({
      channelId: 'ch-1',
      senderAgentId: 'agent-1',
      chatId: 'chat-42',
      content: 'Hello world',
      attachments: undefined,
    })
  })

  it('forwards attachments to sendToChannelAs', async () => {
    await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-1',
      chat_id: 'chat-1',
      message: 'Here is a file',
      attachments: [
        { source: '/tmp/photo.png', mimeType: 'image/png', fileName: 'photo.png' },
      ],
    })

    const callArgs = (mockSendToChannelAs.mock.calls[0] as any[])!
    expect(callArgs[0].attachments).toHaveLength(1)
    expect(callArgs[0].attachments[0].source).toBe('/tmp/photo.png')
  })

  it('returns error when sendToChannelAs reports adapter failure', async () => {
    mockSendToChannelAs.mockResolvedValue({ ok: false, error: 'Telegram API rate limited' } as any)

    const result = await executeTool(sendChannelMessageTool, {
      channel_id: 'ch-1',
      chat_id: 'chat-1',
      message: 'Hello',
    })

    expect(result.error).toBe('Telegram API rate limited')
  })
})
