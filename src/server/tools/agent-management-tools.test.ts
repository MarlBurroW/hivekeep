import { describe, it, expect, mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'

// ─── Mocks ──────────────────────────────────────────────────────────────────

// delete_agent protects Queenie by reading its kind directly.
mock.module('@/server/db/index', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ get: () => ({ kind: 'default' }) }) }) }),
} }))

mock.module('@/server/config', () => ({ config: { ...fullMockConfig } }))

const mockCreateAgent = mock(() => Promise.resolve({
  id: 'new-agent-id',
  slug: 'test-agent',
  name: 'Test Agent',
  role: 'Assistant',
  model: 'gpt-4o',
}))

const mockUpdateAgent = mock(() => Promise.resolve({
  agent: {
    id: 'target-agent-id',
    slug: 'updated-agent',
    name: 'Updated Agent',
    role: 'Updated Role',
    model: 'gpt-4o',
    avatarUrl: null,
  },
} as any))

const mockDeleteAgent = mock(() => Promise.resolve(true))

const mockGetAgentDetails = mock(() => Promise.resolve({
  id: 'target-agent-id',
  slug: 'target-agent',
  name: 'Target Agent',
  role: 'Helper',
  character: 'Friendly',
  expertise: 'Everything',
  model: 'gpt-4o',
  mcpServers: [] as any[],
  toolboxIds: null as string | null,
  createdAt: new Date(),
}))

// Toolbox lookups used by update_agent (name → id) and get_agent_details (id → name).
// A small in-memory registry covering the built-ins the tests reference.
const TOOLBOX_REGISTRY: Record<string, { id: string; name: string }> = {
  code: { id: 'tb-code', name: 'code' },
  research: { id: 'tb-research', name: 'research' },
  all: { id: 'tb-all', name: 'all' },
}
const TOOLBOX_BY_ID: Record<string, { id: string; name: string }> = Object.fromEntries(
  Object.values(TOOLBOX_REGISTRY).map((b) => [b.id, b]),
)
const mockGetToolboxByName = mock((name: string) => TOOLBOX_REGISTRY[name] ?? null)
const mockGetToolbox = mock((id: string) => TOOLBOX_BY_ID[id] ?? null)

const mockGenerateAndSaveAvatar = mock(() => Promise.resolve('/api/uploads/agents/new-agent-id/avatar.png'))

const mockResolveAgentId = mock((idOrSlug: string) => {
  if (idOrSlug === 'not-found') return null
  if (idOrSlug === 'self-agent') return 'self-agent-id'
  return 'target-agent-id'
})

mock.module('@/server/services/agents', () => ({
  createAgent: mockCreateAgent,
  updateAgent: mockUpdateAgent,
  deleteAgent: mockDeleteAgent,
  getAgentDetails: mockGetAgentDetails,
  generateAndSaveAvatar: mockGenerateAndSaveAvatar,
}))

mock.module('@/server/services/agent-resolver', () => ({
  resolveAgentId: mockResolveAgentId,
}))

mock.module('@/server/services/toolboxes', () => ({
  getToolboxByName: mockGetToolboxByName,
  getToolbox: mockGetToolbox,
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// Import after mocks. Missing exports fail the suite instead of hiding coverage.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createAgentTool: any, updateAgentTool: any, deleteAgentTool: any, getAgentDetailsTool: any
let _mocksWorking = false
try {
  const mod = await import('./agent-management-tools')
  createAgentTool = mod.createAgentTool
  updateAgentTool = mod.updateAgentTool
  deleteAgentTool = mod.deleteAgentTool
  getAgentDetailsTool = mod.getAgentDetailsTool
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

if (!_mocksWorking) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const itMocked = it

// ─── Helpers ────────────────────────────────────────────────────────────────

function createCtx(overrides?: Partial<{ agentId: string; userId: string; taskId: string }>) {
  return {
    agentId: overrides?.agentId ?? 'self-agent-id',
    userId: overrides?.userId ?? 'user-1',
    taskId: overrides?.taskId,
  }
}

function makeTool(registration: any, ctx?: any) {
  return registration.create(ctx ?? createCtx())
}

// ─── createAgentTool ──────────────────────────────────────────────────────────

describe('createAgentTool', () => {
  itMocked('has correct availability', () => {
    expect(createAgentTool.availability).toEqual(['main'])
    expect(createAgentTool.defaultDisabled).toBe(true)
  })

  itMocked('creates an agent and returns its details', async () => {
    mockCreateAgent.mockResolvedValueOnce({
      id: 'new-agent-id',
      slug: 'my-helper',
      name: 'My Helper',
      role: 'Research Assistant',
      model: 'claude-sonnet-4-20250514',
    })

    const t = makeTool(createAgentTool)
    const result = await t.execute({
      name: 'My Helper',
      role: 'Research Assistant',
      character: 'Thoughtful and thorough',
      expertise: 'Web research and summarization',
      model: 'claude-sonnet-4-20250514',
      generate_avatar: false,
    }, { toolCallId: 'tc1', messages: [] })

    expect(result).toEqual({
      id: 'new-agent-id',
      slug: 'my-helper',
      name: 'My Helper',
      role: 'Research Assistant',
      model: 'claude-sonnet-4-20250514',
      avatarUrl: null,
    })
    expect(mockCreateAgent).toHaveBeenCalledWith({
      name: 'My Helper',
      role: 'Research Assistant',
      character: 'Thoughtful and thorough',
      expertise: 'Web research and summarization',
      model: 'claude-sonnet-4-20250514',
      // create_agent now defaults the toolbox selection to the built-in "all" so
      // the Agent isn't tool-less; providerId stays null when a model is given.
      providerId: null,
      toolboxIds: ['tb-all'],
      createdBy: 'user-1',
    })
  })

  itMocked('generates avatar when requested', async () => {
    mockCreateAgent.mockResolvedValueOnce({
      id: 'avatar-agent',
      slug: 'avatar-agent',
      name: 'Avatar Agent',
      role: 'Tester',
      model: 'gpt-4o',
    })
    mockGenerateAndSaveAvatar.mockResolvedValueOnce('/avatar.png')

    const t = makeTool(createAgentTool)
    const result = await t.execute({
      name: 'Avatar Agent',
      role: 'Tester',
      character: 'Friendly',
      expertise: 'Testing',
      model: 'gpt-4o',
      generate_avatar: true,
    }, { toolCallId: 'tc2', messages: [] })

    expect(result.avatarUrl).toBe('/avatar.png')
    expect(mockGenerateAndSaveAvatar).toHaveBeenCalledWith('avatar-agent')
  })

  itMocked('returns result even if avatar generation fails', async () => {
    mockCreateAgent.mockResolvedValueOnce({
      id: 'fail-avatar',
      slug: 'fail-avatar',
      name: 'Fail Avatar',
      role: 'Tester',
      model: 'gpt-4o',
    })
    mockGenerateAndSaveAvatar.mockRejectedValueOnce(new Error('No image provider'))

    const t = makeTool(createAgentTool)
    const result = await t.execute({
      name: 'Fail Avatar',
      role: 'Tester',
      character: 'Test',
      expertise: 'Test',
      model: 'gpt-4o',
      generate_avatar: true,
    }, { toolCallId: 'tc3', messages: [] })

    expect(result.id).toBe('fail-avatar')
    expect(result.avatarUrl).toBeNull()
  })

  itMocked('returns error when creation fails', async () => {
    mockCreateAgent.mockRejectedValueOnce(new Error('Duplicate name'))

    const t = makeTool(createAgentTool)
    const result = await t.execute({
      name: 'Duplicate',
      role: 'Test',
      character: 'Test',
      expertise: 'Test',
      model: 'gpt-4o',
      generate_avatar: false,
    }, { toolCallId: 'tc4', messages: [] })

    expect(result).toEqual({ error: 'Duplicate name' })
  })

  itMocked('uses null as createdBy when no userId in context', async () => {
    mockCreateAgent.mockResolvedValueOnce({
      id: 'sys-agent',
      slug: 'sys-agent',
      name: 'System Agent',
      role: 'Test',
      model: 'gpt-4o',
    })

    const t = makeTool(createAgentTool, { agentId: 'some-agent', userId: undefined })
    await t.execute({
      name: 'System Agent',
      role: 'Test',
      character: 'Test',
      expertise: 'Test',
      model: 'gpt-4o',
      generate_avatar: false,
    }, { toolCallId: 'tc5', messages: [] })

    expect(mockCreateAgent).toHaveBeenLastCalledWith(expect.objectContaining({
      createdBy: null,
    }))
  })
})

// ─── updateAgentTool ──────────────────────────────────────────────────────────

describe('updateAgentTool', () => {
  itMocked('has correct availability', () => {
    expect(updateAgentTool.availability).toEqual(['main'])
    expect(updateAgentTool.defaultDisabled).toBe(true)
  })

  itMocked('returns error when agent not found', async () => {
    mockResolveAgentId.mockReturnValueOnce(null)

    const t = makeTool(updateAgentTool)
    const result = await t.execute({
      agent_id: 'not-found',
      name: 'New Name',
      generate_avatar: false,
    }, { toolCallId: 'tc7', messages: [] })

    expect(result).toEqual({ error: 'Agent "not-found" not found' })
  })

  itMocked('allows regenerating your OWN avatar (avatar-only self update)', async () => {
    mockResolveAgentId.mockReturnValueOnce('self-agent-id')
    mockUpdateAgent.mockResolvedValueOnce({
      agent: { id: 'self-agent-id', slug: 'queenie', name: 'Queenie', role: 'Guide', model: 'x', avatarUrl: null },
    })
    mockGenerateAndSaveAvatar.mockResolvedValueOnce('/api/uploads/agents/self-agent-id/avatar.png')

    const t = makeTool(updateAgentTool, createCtx({ agentId: 'self-agent-id' }))
    const result = await t.execute({
      agent_id: 'queenie',
      generate_avatar: true,
    }, { toolCallId: 'tc6b', messages: [] })

    expect(result).not.toHaveProperty('error')
    expect(mockGenerateAndSaveAvatar).toHaveBeenCalledWith('self-agent-id')
    expect(result.avatarUrl).toBe('/api/uploads/agents/self-agent-id/avatar.png')
  })

  itMocked('allows self-update of safe persona fields (name/role/character/expertise)', async () => {
    mockResolveAgentId.mockReturnValueOnce('self-agent-id')
    mockUpdateAgent.mockResolvedValueOnce({
      agent: { id: 'self-agent-id', slug: 'queenie', name: 'Queenie the Bold', role: 'Guide', model: 'x', avatarUrl: null },
    })

    const t = makeTool(updateAgentTool, createCtx({ agentId: 'self-agent-id' }))
    const result = await t.execute({
      agent_id: 'queenie',
      name: 'Queenie the Bold',
      role: 'Guide',
      character: 'Warmer, more concise',
      expertise: 'Onboarding',
    }, { toolCallId: 'tc6c', messages: [] })

    expect(result).not.toHaveProperty('error')
    expect(mockUpdateAgent).toHaveBeenCalledWith(
      'self-agent-id',
      expect.objectContaining({ name: 'Queenie the Bold', character: 'Warmer, more concise' }),
    )
  })

  itMocked('blocks self-update that touches protected fields (model/toolboxes/slug)', async () => {
    const protectedPatches = [{ model: 'gpt-5' }, { toolboxes: ['all'] }, { slug: 'new-slug' }]
    for (const patch of protectedPatches) {
      mockResolveAgentId.mockReturnValueOnce('self-agent-id')
      const t = makeTool(updateAgentTool, createCtx({ agentId: 'self-agent-id' }))
      const result = await t.execute(
        { agent_id: 'queenie', ...patch },
        { toolCallId: 'tc6d', messages: [] },
      )
      expect(result).toEqual({
        error:
          'You can update your own persona (name, role, character, expertise) and avatar, but not your toolboxes, model, or slug. Ask a user or another Agent to change those.',
      })
    }
  })

  itMocked('updates an agent successfully', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockUpdateAgent.mockResolvedValueOnce({
      agent: {
        id: 'target-agent-id',
        slug: 'updated',
        name: 'Updated Name',
        role: 'New Role',
        model: 'gpt-4o',
        avatarUrl: null,
      },
    })

    const t = makeTool(updateAgentTool)
    const result = await t.execute({
      agent_id: 'target-agent',
      name: 'Updated Name',
      role: 'New Role',
      generate_avatar: false,
    }, { toolCallId: 'tc8', messages: [] })

    expect(result.name).toBe('Updated Name')
    expect(result.role).toBe('New Role')
  })

  itMocked('returns error when updateAgent returns error object', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockUpdateAgent.mockResolvedValueOnce({
      error: { message: 'Invalid slug format' },
    } as any)

    const t = makeTool(updateAgentTool)
    const result = await t.execute({
      agent_id: 'target-agent',
      slug: 'BAD SLUG',
      generate_avatar: false,
    }, { toolCallId: 'tc9', messages: [] })

    expect(result).toEqual({ error: 'Invalid slug format' })
  })

  itMocked('rejects an unknown toolbox name', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')

    const t = makeTool(updateAgentTool)
    const result = await t.execute({
      agent_id: 'target-agent',
      toolboxes: ['does-not-exist'],
      generate_avatar: false,
    }, { toolCallId: 'tc10', messages: [] })

    expect(result).toEqual({
      error: 'Unknown toolbox "does-not-exist". Use list_toolboxes to see available toolboxes.',
    })
  })

  itMocked('resolves toolbox names to ids and passes toolboxIds to updateAgent', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockUpdateAgent.mockResolvedValueOnce({
      agent: {
        id: 'target-agent-id',
        slug: 'target',
        name: 'Target',
        role: 'Role',
        model: 'gpt-4o',
        avatarUrl: null,
      },
    })

    const t = makeTool(updateAgentTool)
    await t.execute({
      agent_id: 'target-agent',
      toolboxes: ['code', 'research'],
      generate_avatar: false,
    }, { toolCallId: 'tc11', messages: [] })

    expect(mockUpdateAgent).toHaveBeenLastCalledWith('target-agent-id', expect.objectContaining({
      toolboxIds: ['tb-code', 'tb-research'],
    }))
  })

  itMocked('resets toolbox selection to the all default on empty array', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockUpdateAgent.mockResolvedValueOnce({
      agent: {
        id: 'target-agent-id',
        slug: 'target',
        name: 'Target',
        role: 'Role',
        model: 'gpt-4o',
        avatarUrl: null,
      },
    })

    const t = makeTool(updateAgentTool)
    await t.execute({
      agent_id: 'target-agent',
      toolboxes: [],
      generate_avatar: false,
    }, { toolCallId: 'tc11b', messages: [] })

    expect(mockUpdateAgent).toHaveBeenLastCalledWith('target-agent-id', expect.objectContaining({
      toolboxIds: null,
    }))
  })
})

// ─── deleteAgentTool ──────────────────────────────────────────────────────────

describe('deleteAgentTool', () => {
  itMocked('has correct availability', () => {
    expect(deleteAgentTool.availability).toEqual(['main'])
    expect(deleteAgentTool.defaultDisabled).toBe(true)
  })

  itMocked('prevents self-deletion', async () => {
    mockResolveAgentId.mockReturnValueOnce('self-agent-id')

    const t = makeTool(deleteAgentTool, createCtx({ agentId: 'self-agent-id' }))
    const result = await t.execute({
      agent_id: 'self-agent',
      confirm: true,
    }, { toolCallId: 'tc12', messages: [] })

    expect(result).toEqual({
      error: 'You cannot delete yourself. Ask a user or another Agent to do this.',
    })
  })

  itMocked('returns error when agent not found', async () => {
    mockResolveAgentId.mockReturnValueOnce(null)

    const t = makeTool(deleteAgentTool)
    const result = await t.execute({
      agent_id: 'not-found',
      confirm: true,
    }, { toolCallId: 'tc13', messages: [] })

    expect(result).toEqual({ error: 'Agent "not-found" not found' })
  })

  itMocked('deletes an agent successfully', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockDeleteAgent.mockResolvedValueOnce(true)

    const t = makeTool(deleteAgentTool)
    const result = await t.execute({
      agent_id: 'target-agent',
      confirm: true,
    }, { toolCallId: 'tc14', messages: [] })

    expect(result).toEqual({ success: true, deletedAgent: 'target-agent' })
  })

  itMocked('returns error when deleteAgent returns false', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockDeleteAgent.mockResolvedValueOnce(false)

    const t = makeTool(deleteAgentTool)
    const result = await t.execute({
      agent_id: 'gone-agent',
      confirm: true,
    }, { toolCallId: 'tc15', messages: [] })

    expect(result).toEqual({ error: 'Agent not found' })
  })

  itMocked('returns error when deleteAgent throws', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockDeleteAgent.mockRejectedValueOnce(new Error('DB constraint'))

    const t = makeTool(deleteAgentTool)
    const result = await t.execute({
      agent_id: 'target-agent',
      confirm: true,
    }, { toolCallId: 'tc16', messages: [] })

    expect(result).toEqual({ error: 'DB constraint' })
  })
})

// ─── getAgentDetailsTool ──────────────────────────────────────────────────────

describe('getAgentDetailsTool', () => {
  itMocked('has correct availability', () => {
    expect(getAgentDetailsTool.availability).toEqual(['main'])
    expect(getAgentDetailsTool.defaultDisabled).toBe(true)
  })

  itMocked('returns error when agent not found by resolver', async () => {
    mockResolveAgentId.mockReturnValueOnce(null)

    const t = makeTool(getAgentDetailsTool)
    const result = await t.execute({
      agent_id: 'not-found',
    }, { toolCallId: 'tc17', messages: [] })

    expect(result).toEqual({ error: 'Agent "not-found" not found' })
  })

  itMocked('returns error when getAgentDetails returns null', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockGetAgentDetails.mockResolvedValueOnce(null as any)

    const t = makeTool(getAgentDetailsTool)
    const result = await t.execute({
      agent_id: 'target-agent',
    }, { toolCallId: 'tc18', messages: [] })

    expect(result).toEqual({ error: 'Agent not found' })
  })

  itMocked('returns agent details with resolved toolbox names', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockGetAgentDetails.mockResolvedValueOnce({
      id: 'target-agent-id',
      slug: 'target',
      name: 'Target Agent',
      role: 'Helper',
      character: 'Friendly',
      expertise: 'Everything',
      model: 'gpt-4o',
      mcpServers: [{ id: 'mcp-1', name: 'My MCP' }] as any[],
      toolboxIds: JSON.stringify(['tb-code', 'tb-research']) as string | null,
      createdAt: new Date('2024-01-01'),
    })

    const t = makeTool(getAgentDetailsTool)
    const result = await t.execute({
      agent_id: 'target',
    }, { toolCallId: 'tc19', messages: [] })

    expect(result.id).toBe('target-agent-id')
    expect(result.slug).toBe('target')
    expect(result.name).toBe('Target Agent')
    expect(result.mcpServers).toEqual([{ id: 'mcp-1', name: 'My MCP' }])
    expect(result.toolboxes).toEqual(['code', 'research'])
  })

  itMocked('reports the all default when no toolboxes are set', async () => {
    mockResolveAgentId.mockReturnValueOnce('target-agent-id')
    mockGetAgentDetails.mockResolvedValueOnce({
      id: 'target-agent-id',
      slug: 'target',
      name: 'Target Agent',
      role: 'Helper',
      character: 'Friendly',
      expertise: 'Everything',
      model: 'gpt-4o',
      mcpServers: [],
      toolboxIds: null,
      createdAt: new Date('2024-01-01'),
    })

    const t = makeTool(getAgentDetailsTool)
    const result = await t.execute({
      agent_id: 'target',
    }, { toolCallId: 'tc20', messages: [] })

    expect(result.toolboxes).toEqual(['all'])
  })
})
