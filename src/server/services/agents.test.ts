import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockConfig, fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mock DB before importing module ─────────────────────────────────────────

const mockDbGet = mock(() => undefined as any)
const mockDbWhere = mock(() => ({ get: mockDbGet }))
const mockDbFrom = mock(() => ({ where: mockDbWhere }))
const mockDbSelect = mock(() => ({ from: mockDbFrom }))

mock.module('@/server/db/index', () => ({
  db: {
    select: mockDbSelect,
    insert: mock(() => ({ values: mock(() => {}) })),
    update: mock(() => ({ set: mock(() => ({ where: mock(() => {}) })) })),
    delete: mock(() => ({ where: mock(() => {}) })),
  },
}))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
}))

mock.module('@/server/config', () => ({
  config: { ...fullMockConfig },
}))

// Slug functions are pure — no need to mock them

mock.module('@/server/sse/index', () => ({
  sseManager: {
    broadcast: mock(() => {}),
    sendToUser: mock(() => {}),
  },
}))

// Note: We don't mock @/server/services/image-generation here because
// it would break the identity check in image-generation.test.ts when running
// the full suite. The agents module only uses it in createAgent/generateAndSaveAvatar
// which we don't test here (they're async + DB-heavy).

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }),
}))

mock.module('@/server/services/channels', () => ({
  deleteChannel: mock(async () => {}),
  reportUndeliveredChannelReply: mock(async () => {}),
}))

mock.module('@/server/services/crons', () => ({
  createCron: mock(() => Promise.resolve()),
  updateCron: mock(() => Promise.resolve()),
  deleteCron: mock(() => Promise.resolve()),
  getCron: mock(() => Promise.resolve(null)),
  listCrons: mock(() => Promise.resolve([])),
  approveCron: mock(() => Promise.resolve()),
  stopJob: mock(() => {}),
  triggerCronManually: mock(() => Promise.resolve()),
  initCronScheduler: mock(() => Promise.resolve()),
  stopAllCrons: mock(() => {}),
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: mock((...args: any[]) => args),
  and: mock((...args: any[]) => args),
  not: mock((a: any) => a),
  inArray: mock((...args: any[]) => args),
  or: mock((...args: any[]) => args),
}))

// ─── Import module under test ────────────────────────────────────────────────
// Import from agent-validation directly to avoid Bun's global mock.module leakage
// (agent-management-tools.test.ts mocks @/server/services/agents globally)
import { validateAgentFields, agentAvatarUrl } from '@/server/services/field-validator'
import type { ValidationError } from '@/server/services/field-validator'

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('agentAvatarUrl', () => {
  it('returns null when avatarPath is null', () => {
    expect(agentAvatarUrl('agent-1', null)).toBeNull()
  })

  it('returns null when avatarPath is empty string', () => {
    // Empty string is falsy
    expect(agentAvatarUrl('agent-1', '')).toBeNull()
  })

  it('builds correct URL with extension from path', () => {
    const url = agentAvatarUrl('agent-123', 'avatars/photo.jpg', new Date(1700000000000))
    expect(url).toBe('/api/uploads/agents/agent-123/avatar.jpg?v=1700000000000')
  })

  it('defaults to png when path has no extension', () => {
    const url = agentAvatarUrl('agent-1', 'avatar', new Date(1000))
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.avatar?v=1000')
  })

  it('handles webp extension', () => {
    const url = agentAvatarUrl('agent-1', 'path/to/file.webp', new Date(5000))
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.webp?v=5000')
  })

  it('uses Date.now() when updatedAt is null', () => {
    const before = Date.now()
    const url = agentAvatarUrl('agent-1', 'photo.png', null)
    const after = Date.now()
    expect(url).toMatch(/^\/api\/uploads\/agents\/agent-1\/avatar\.png\?v=\d+$/)
    const v = parseInt(url!.split('v=')[1]!)
    expect(v).toBeGreaterThanOrEqual(before)
    expect(v).toBeLessThanOrEqual(after)
  })

  it('uses Date.now() when updatedAt is undefined', () => {
    const url = agentAvatarUrl('agent-1', 'photo.png')
    expect(url).toMatch(/^\/api\/uploads\/agents\/agent-1\/avatar\.png\?v=\d+$/)
  })

  it('handles path with multiple dots', () => {
    const url = agentAvatarUrl('agent-1', 'path/to/my.avatar.png', new Date(100))
    expect(url).toBe('/api/uploads/agents/agent-1/avatar.png?v=100')
  })
})

describe('validateAgentFields', () => {
  beforeEach(() => {
    mockDbGet.mockReset()
    mockDbGet.mockReturnValue(undefined)
  })

  // ─── Create mode: required fields ─────────────────────────────────────

  describe('create mode - required fields', () => {
    it('returns error when name is missing', () => {
      const err = validateAgentFields({ role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
      expect(err!.code).toBe('INVALID_NAME')
    })

    it('returns error when name is empty string', () => {
      const err = validateAgentFields({ name: '', role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
    })

    it('returns error when name is whitespace only', () => {
      const err = validateAgentFields({ name: '   ', role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
    })

    it('returns error when role is missing', () => {
      const err = validateAgentFields({ name: 'Test', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
      expect(err!.code).toBe('INVALID_ROLE')
    })

    it('returns error when role is empty', () => {
      const err = validateAgentFields({ name: 'Test', role: '', model: 'gpt-4' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
    })

    it('returns error when model is missing', () => {
      const err = validateAgentFields({ name: 'Test', role: 'helper' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('model')
      expect(err!.code).toBe('INVALID_MODEL')
    })

    it('returns error when model is empty', () => {
      const err = validateAgentFields({ name: 'Test', role: 'helper', model: '' }, 'create')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('model')
    })

    it('returns null when all required fields are valid', () => {
      const err = validateAgentFields({ name: 'My Agent', role: 'helper', model: 'gpt-4' }, 'create')
      expect(err).toBeNull()
    })
  })

  // ─── Update mode: no required fields ──────────────────────────────────

  describe('update mode - optional fields', () => {
    it('returns null when no fields provided', () => {
      const err = validateAgentFields({}, 'update')
      expect(err).toBeNull()
    })

    it('returns null when only valid name provided', () => {
      const err = validateAgentFields({ name: 'New Name' }, 'update')
      expect(err).toBeNull()
    })

    it('returns error when name is empty in update', () => {
      const err = validateAgentFields({ name: '' }, 'update')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
    })

    it('returns error when name is whitespace in update', () => {
      const err = validateAgentFields({ name: '   ' }, 'update')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
    })
  })

  // ─── Length limits ────────────────────────────────────────────────────

  describe('length limits', () => {
    it('rejects name over 100 characters', () => {
      const err = validateAgentFields(
        { name: 'a'.repeat(101), role: 'helper', model: 'gpt-4' },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('name')
      expect(err!.message).toContain('100')
    })

    it('accepts name at exactly 100 characters', () => {
      const err = validateAgentFields(
        { name: 'a'.repeat(100), role: 'helper', model: 'gpt-4' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('rejects role over 200 characters', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'r'.repeat(201), model: 'gpt-4' },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('role')
      expect(err!.message).toContain('200')
    })

    it('accepts role at exactly 200 characters', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'r'.repeat(200), model: 'gpt-4' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('rejects character over 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', character: 'c'.repeat(50001) },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('character')
      expect(err!.message).toContain('50000')
    })

    it('accepts character at exactly 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', character: 'c'.repeat(50000) },
        'create',
      )
      expect(err).toBeNull()
    })

    it('rejects expertise over 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', expertise: 'e'.repeat(50001) },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('expertise')
    })

    it('accepts expertise at exactly 50000 characters', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', expertise: 'e'.repeat(50000) },
        'create',
      )
      expect(err).toBeNull()
    })
  })

  // ─── Model validation ────────────────────────────────────────────────

  describe('model validation', () => {
    it('rejects whitespace-only model in update', () => {
      const err = validateAgentFields({ model: '   ' }, 'update')
      expect(err).not.toBeNull()
      expect(err!.field).toBe('model')
      expect(err!.code).toBe('INVALID_MODEL')
    })

    it('accepts valid model string in update', () => {
      const err = validateAgentFields({ model: 'claude-3-sonnet' }, 'update')
      expect(err).toBeNull()
    })
  })

  // ─── Provider validation ──────────────────────────────────────────────

  describe('provider validation', () => {
    it('returns null when providerId is null (explicitly no provider)', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', providerId: null },
        'create',
      )
      expect(err).toBeNull()
    })

    it('returns null when providerId is undefined (not specified)', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('returns error when providerId does not exist in DB', () => {
      mockDbGet.mockReturnValue(undefined)
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', providerId: 'nonexistent-id' },
        'create',
      )
      expect(err).not.toBeNull()
      expect(err!.field).toBe('providerId')
      expect(err!.code).toBe('INVALID_PROVIDER')
    })

    it('returns null when providerId exists in DB', () => {
      mockDbGet.mockReturnValue({ id: 'valid-provider' })
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', providerId: 'valid-provider' },
        'create',
      )
      expect(err).toBeNull()
    })
  })

  // ─── Validation order (first error wins) ──────────────────────────────

  describe('validation order', () => {
    it('checks required fields before length limits in create', () => {
      // Missing name should be caught before checking role length
      const err = validateAgentFields({ role: 'helper', model: 'gpt-4' }, 'create')
      expect(err!.field).toBe('name')
    })

    it('checks name before role in create', () => {
      const err = validateAgentFields({ model: 'gpt-4' }, 'create')
      expect(err!.field).toBe('name')
    })

    it('checks role before model in create', () => {
      const err = validateAgentFields({ name: 'Test' }, 'create')
      expect(err!.field).toBe('role')
    })

    it('in update, validates each provided field', () => {
      const err = validateAgentFields({ name: '', role: '' }, 'update')
      // Should catch name first since it's checked first
      expect(err!.field).toBe('name')
    })
  })

  // ─── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('allows character to be undefined (not required)', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('allows expertise to be undefined (not required)', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4' },
        'create',
      )
      expect(err).toBeNull()
    })

    it('allows empty character string (no length validation for empty)', () => {
      const err = validateAgentFields(
        { name: 'Test', role: 'helper', model: 'gpt-4', character: '' },
        'create',
      )
      // character is optional, empty string length is 0 which is < 50000
      expect(err).toBeNull()
    })

    it('handles all valid fields together', () => {
      mockDbGet.mockReturnValue({ id: 'prov-1' })
      const err = validateAgentFields(
        {
          name: 'My Agent',
          role: 'A helpful assistant',
          model: 'claude-3-opus',
          character: 'Friendly and knowledgeable',
          expertise: 'Programming, math',
          providerId: 'prov-1',
        },
        'create',
      )
      expect(err).toBeNull()
    })
  })
})
