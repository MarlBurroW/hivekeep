import { describe, it, expect, beforeEach, mock } from 'bun:test'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockSendInterAgentMessage = mock(() =>
  Promise.resolve({ requestId: 'req-123' }),
)
const mockReplyToInterAgentMessage = mock(() => Promise.resolve())
const mockListAvailableAgents = mock(() =>
  Promise.resolve([
    { slug: 'helper-ai', name: 'Helper AI', role: 'assistant' },
    { slug: 'coder-ai', name: 'Coder AI', role: 'developer' },
  ]),
)
const mockResolveAgentId = mock(() => 'agent-target-id' as string | null)

mock.module('@/server/services/inter-agent', () => ({
  sendInterAgentMessage: mockSendInterAgentMessage,
  replyToInterAgentMessage: mockReplyToInterAgentMessage,
  listAvailableAgents: mockListAvailableAgents,
}))

mock.module('@/server/services/agent-resolver', () => ({
  resolveAgentId: mockResolveAgentId,
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

// Note: Bun's mock.module may not intercept cached modules in certain
// environments (coverage mode, CI runners). Detect this and fail explicitly.

// Import after mocks
const { sendMessageTool, replyTool, listAgentsTool } = await import(
  '@/server/tools/inter-agent-tools'
)

// Verify mocks are working by doing a real tool execution.
// If mock.module didn't intercept, the tool will hit the real DB and return an error.
const mocksWorking = await (async () => {
  try {
    const t = sendMessageTool.create({ agentId: 'test', userId: 'test', isSubAgent: false })
    const result = await t.execute!(
      { slug: 'test', message: 'probe', type: 'request' as const },
      { abortSignal: new AbortController().signal },
    )
    // If mocks work, we get { success: true, requestId: 'req-123' }
    return (result as any)?.success === true
  } catch {
    return false
  }
})()

// Reset mocks after the probe call
mockSendInterAgentMessage.mockClear()
mockResolveAgentId.mockClear()

if (!mocksWorking) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const itMocked = it

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = {
  agentId: 'agent-sender-id',
  userId: 'user-1',
  isSubAgent: false,
}

function execute(registration: any, args: any) {
  const t = registration.create(ctx)
  return t.execute!(args, { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal })
}

// ─── sendMessageTool ─────────────────────────────────────────────────────────

describe('sendMessageTool', () => {
  beforeEach(() => {
    mockSendInterAgentMessage.mockClear()
    mockResolveAgentId.mockClear()
    mockResolveAgentId.mockReturnValue('agent-target-id')
  })

  it('has correct availability', () => {
    expect(sendMessageTool.availability).toEqual(['main'])
  })

  itMocked('sends a request message successfully', async () => {
    const result = await execute(sendMessageTool, {
      slug: 'helper-ai',
      message: 'Hello!',
      type: 'request',
    })

    expect(result).toEqual({ success: true, requestId: 'req-123' })
    expect(mockResolveAgentId).toHaveBeenCalledWith('helper-ai')
    expect(mockSendInterAgentMessage).toHaveBeenCalledWith({
      senderAgentId: 'agent-sender-id',
      targetAgentId: 'agent-target-id',
      message: 'Hello!',
      type: 'request',
    })
  })

  itMocked('sends an inform message successfully', async () => {
    const result = await execute(sendMessageTool, {
      slug: 'helper-ai',
      message: 'FYI update',
      type: 'inform',
    })

    expect(result).toEqual({ success: true, requestId: 'req-123' })
    expect(mockSendInterAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inform' }),
    )
  })

  itMocked('returns error when target agent not found', async () => {
    mockResolveAgentId.mockReturnValue(null)

    const result = await execute(sendMessageTool, {
      slug: 'nonexistent',
      message: 'Hi',
      type: 'request',
    })

    expect(result).toEqual({ error: 'Agent "nonexistent" not found' })
    expect(mockSendInterAgentMessage).not.toHaveBeenCalled()
  })

  itMocked('returns error when service throws', async () => {
    mockSendInterAgentMessage.mockRejectedValueOnce(new Error('Connection refused'))

    const result = await execute(sendMessageTool, {
      slug: 'helper-ai',
      message: 'Hi',
      type: 'request',
    })

    expect(result).toEqual({ error: 'Connection refused' })
  })

  itMocked('handles non-Error throw gracefully', async () => {
    mockSendInterAgentMessage.mockRejectedValueOnce('string error')

    const result = await execute(sendMessageTool, {
      slug: 'helper-ai',
      message: 'Hi',
      type: 'request',
    })

    expect(result).toEqual({ error: 'Unknown error' })
  })
})

// ─── replyTool ───────────────────────────────────────────────────────────────

describe('replyTool', () => {
  beforeEach(() => {
    mockReplyToInterAgentMessage.mockClear()
    mockReplyToInterAgentMessage.mockResolvedValue(undefined)
  })

  it('has correct availability', () => {
    expect(replyTool.availability).toEqual(['main'])
  })

  itMocked('replies to a request successfully', async () => {
    const result = await execute(replyTool, {
      request_id: 'req-abc',
      message: 'Here is your answer',
    })

    expect(result).toEqual({ success: true })
    expect(mockReplyToInterAgentMessage).toHaveBeenCalledWith({
      senderAgentId: 'agent-sender-id',
      requestId: 'req-abc',
      message: 'Here is your answer',
    })
  })

  itMocked('returns error when service throws', async () => {
    mockReplyToInterAgentMessage.mockRejectedValueOnce(new Error('Request not found'))

    const result = await execute(replyTool, {
      request_id: 'req-invalid',
      message: 'Reply',
    })

    expect(result).toEqual({ error: 'Request not found' })
  })

  itMocked('handles non-Error throw gracefully', async () => {
    mockReplyToInterAgentMessage.mockRejectedValueOnce(42)

    const result = await execute(replyTool, {
      request_id: 'req-x',
      message: 'Reply',
    })

    expect(result).toEqual({ error: 'Unknown error' })
  })
})

// ─── listAgentsTool ────────────────────────────────────────────────────────────

describe('listAgentsTool', () => {
  beforeEach(() => {
    mockListAvailableAgents.mockClear()
    mockListAvailableAgents.mockResolvedValue([
      { slug: 'helper-ai', name: 'Helper AI', role: 'assistant' },
      { slug: 'coder-ai', name: 'Coder AI', role: 'developer' },
    ])
  })

  it('has correct availability', () => {
    expect(listAgentsTool.availability).toEqual(['main'])
  })

  itMocked('returns available agents with correct shape', async () => {
    const result = await execute(listAgentsTool, {})

    expect(result).toEqual({
      agents: [
        { slug: 'helper-ai', name: 'Helper AI', role: 'assistant' },
        { slug: 'coder-ai', name: 'Coder AI', role: 'developer' },
      ],
    })
    expect(mockListAvailableAgents).toHaveBeenCalledWith('agent-sender-id')
  })

  itMocked('returns empty list when no agents available', async () => {
    mockListAvailableAgents.mockResolvedValueOnce([])

    const result = await execute(listAgentsTool, {})

    expect(result).toEqual({ agents: [] })
  })

  itMocked('strips extra properties from agent objects', async () => {
    mockListAvailableAgents.mockResolvedValueOnce([
      {
        slug: 'helper-ai',
        name: 'Helper AI',
        role: 'assistant',
        secretKey: 'should-not-appear',
        internalId: 'xyz',
      } as any,
    ])

    const result = await execute(listAgentsTool, {})

    // Only slug, name, role should be in the output
    const agent = (result as any).agents[0]
    expect(Object.keys(agent)).toEqual(['slug', 'name', 'role'])
    expect(agent.slug).toBe('helper-ai')
  })
})
