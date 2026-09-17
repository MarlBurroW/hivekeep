import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

// ─── Mocks ──────────────────────────────────────────────────────────────────

let mockDbSelectResult: unknown
let mockDbSelectGet: ReturnType<typeof mock>

const mockGetGlobalPrompt = mock(() => Promise.resolve(null as string | null))
const mockSetGlobalPrompt = mock(() => Promise.resolve())
const mockDeleteSetting = mock(() => Promise.resolve())
const mockGetExtractionModel = mock(() => Promise.resolve(null as string | null))
const mockSetExtractionModel = mock(() => Promise.resolve())
const mockGetEmbeddingModel = mock(() => Promise.resolve(null as string | null))
const mockSetEmbeddingModel = mock(() => Promise.resolve())
const mockGetDismissedSetupItems = mock(() => Promise.resolve([] as string[]))
const mockDismissSetupItem = mock((_id: string) => Promise.resolve())
const mockRestoreSetupItem = mock((_id: string) => Promise.resolve())

const mockSseBroadcast = mock(() => {})

// Track what select().from().where().get() returns
mockDbSelectGet = mock(() => mockDbSelectResult)

mock.module('@/server/db/index', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          get: mockDbSelectGet,
        }),
      }),
    }),
  },
}))

mock.module('@/server/db/schema', () => ({
  ...fullMockSchema,
  userProfiles: { userId: 'userId', role: 'role' },
  agents: { id: 'id', name: 'name', slug: 'slug' },
}))

const _realAppSettings = await import('@/server/services/app-settings')
mock.module('@/server/services/app-settings', () => ({
  ..._realAppSettings,
  getSetting: mock(() => Promise.resolve(null)),
  setSetting: mock(() => Promise.resolve()),
  getGlobalPrompt: mockGetGlobalPrompt,
  setGlobalPrompt: mockSetGlobalPrompt,
  deleteSetting: mockDeleteSetting,
  getExtractionModel: mockGetExtractionModel,
  setExtractionModel: mockSetExtractionModel,
  getEmbeddingModel: mockGetEmbeddingModel,
  setEmbeddingModel: mockSetEmbeddingModel,
  getDismissedSetupItems: mockGetDismissedSetupItems,
  dismissSetupItem: mockDismissSetupItem,
  restoreSetupItem: mockRestoreSetupItem,
}))

mock.module('@/server/sse/index', () => ({
  sseManager: { broadcast: mockSseBroadcast },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

mock.module('drizzle-orm', () => ({
  ...fullMockDrizzleOrm,
  eq: (...args: unknown[]) => args,
}))

// ─── Import after mocks (may fail if Bun mock isolation is broken) ─────────

let settingsRoutes: any
let _mocksWorking = false
try {
  const mod = await import('@/server/routes/settings')
  settingsRoutes = mod.settingsRoutes
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

if (!_mocksWorking) throw new Error("Test isolation failed. Run this suite with bun run test; never hide missing mocks with skipped tests.")
const itMocked = it

// ─── Test app with auth middleware simulation ───────────────────────────────

function createApp(role: string = 'admin') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new Hono<{ Variables: any }>()

  // Simulate auth middleware — set user on context
  app.use('*', async (c, next) => {
    c.set('user', { id: 'user-1', name: 'Test', email: 'test@test.com' })
    return next()
  })

  // Mock the DB select to return the given role for the admin guard
  mockDbSelectGet.mockImplementation(() => ({ role }))

  if (settingsRoutes) app.route('/api/settings', settingsRoutes)
  return app
}

function json(body: unknown) {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('settings routes', () => {
  it('exposes only backup dates to administrators', async () => {
    const response = await createApp().request('/api/settings/backup-status')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ lastVerifiedAt: null, backupCreatedAt: null })
  })

  it('does not expose backup status to members', async () => {
    const response = await createApp('member').request('/api/settings/backup-status')
    expect(response.status).toBe(403)
  })

  beforeEach(() => {
    mockDbSelectResult = { role: 'admin' }
    mockGetGlobalPrompt.mockReset()
    mockSetGlobalPrompt.mockReset()
    mockDeleteSetting.mockReset()
    mockGetExtractionModel.mockReset()
    mockSetExtractionModel.mockReset()
    mockGetEmbeddingModel.mockReset()
    mockSetEmbeddingModel.mockReset()
    mockSseBroadcast.mockReset()

    mockGetGlobalPrompt.mockImplementation(() => Promise.resolve(null))
    mockSetGlobalPrompt.mockImplementation(() => Promise.resolve())
    mockDeleteSetting.mockImplementation(() => Promise.resolve())
    mockGetExtractionModel.mockImplementation(() => Promise.resolve(null))
    mockSetExtractionModel.mockImplementation(() => Promise.resolve())
    mockGetEmbeddingModel.mockImplementation(() => Promise.resolve(null))
    mockSetEmbeddingModel.mockImplementation(() => Promise.resolve())
    mockGetDismissedSetupItems.mockReset()
    mockDismissSetupItem.mockReset()
    mockRestoreSetupItem.mockReset()
    mockGetDismissedSetupItems.mockImplementation(() => Promise.resolve([]))
    mockDismissSetupItem.mockImplementation(() => Promise.resolve())
    mockRestoreSetupItem.mockImplementation(() => Promise.resolve())
  })

  // ─── Admin Guard ────────────────────────────────────────────────────────

  describe('admin guard', () => {
    itMocked('rejects non-admin users with 403', async () => {
      const app = createApp('user')
      const res = await app.request('/api/settings/global-prompt')
      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error.code).toBe('FORBIDDEN')
    })

    itMocked('rejects users with no profile (null) with 403', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const app = new Hono<{ Variables: any }>()
      app.use('*', async (c, next) => {
        c.set('user', { id: 'user-1', name: 'Test', email: 'test@test.com' })
        return next()
      })
      mockDbSelectGet.mockImplementation(() => null)
      app.route('/api/settings', settingsRoutes)

      const res = await app.request('/api/settings/global-prompt')
      expect(res.status).toBe(403)
    })

    itMocked('allows admin users', async () => {
      const app = createApp('admin')
      const res = await app.request('/api/settings/global-prompt')
      expect(res.status).toBe(200)
    })
  })

  // ─── Global Prompt ──────────────────────────────────────────────────────

  describe('GET /global-prompt', () => {
    itMocked('returns empty string when no prompt is set', async () => {
      const app = createApp()
      mockGetGlobalPrompt.mockImplementation(() => Promise.resolve(null))

      const res = await app.request('/api/settings/global-prompt')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.globalPrompt).toBe('')
    })

    itMocked('returns the current global prompt', async () => {
      const app = createApp()
      mockGetGlobalPrompt.mockImplementation(() => Promise.resolve('Be helpful'))

      const res = await app.request('/api/settings/global-prompt')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.globalPrompt).toBe('Be helpful')
    })
  })

  describe('PUT /global-prompt', () => {
    itMocked('sets a new global prompt', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/global-prompt', json({ globalPrompt: 'Be nice' }))
      expect(res.status).toBe(200)
      expect(mockSetGlobalPrompt).toHaveBeenCalledWith('Be nice')
      const body = await res.json()
      expect(body.globalPrompt).toBe('Be nice')
    })

    itMocked('trims whitespace from prompt', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/global-prompt', json({ globalPrompt: '  Hello world  ' }))
      expect(res.status).toBe(200)
      expect(mockSetGlobalPrompt).toHaveBeenCalledWith('Hello world')
    })

    itMocked('deletes prompt when set to empty string', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/global-prompt', json({ globalPrompt: '' }))
      expect(res.status).toBe(200)
      expect(mockDeleteSetting).toHaveBeenCalledWith('global_prompt')
      expect(mockSetGlobalPrompt).not.toHaveBeenCalled()
    })

    itMocked('deletes prompt when set to whitespace only', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/global-prompt', json({ globalPrompt: '   ' }))
      expect(res.status).toBe(200)
      expect(mockDeleteSetting).toHaveBeenCalledWith('global_prompt')
    })

    itMocked('returns 400 for non-string globalPrompt', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/global-prompt', json({ globalPrompt: 42 }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('INVALID_BODY')
    })
  })

  // ─── Models ─────────────────────────────────────────────────────────────

  describe('GET /models', () => {
    itMocked('returns both model settings', async () => {
      const app = createApp()
      mockGetExtractionModel.mockImplementation(() => Promise.resolve('gpt-4'))
      mockGetEmbeddingModel.mockImplementation(() => Promise.resolve('text-embedding-3-small'))

      const res = await app.request('/api/settings/models')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.extractionModel).toBe('gpt-4')
      expect(body.embeddingModel).toBe('text-embedding-3-small')
    })

    itMocked('returns null when models are not configured', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/models')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.extractionModel).toBeNull()
      expect(body.embeddingModel).toBeNull()
    })
  })

  describe('PUT /extraction-model', () => {
    itMocked('sets extraction model', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/extraction-model', json({ model: 'gpt-4o-mini' }))
      expect(res.status).toBe(200)
      expect(mockSetExtractionModel).toHaveBeenCalledWith('gpt-4o-mini')
      const body = await res.json()
      expect(body.extractionModel).toBe('gpt-4o-mini')
    })

    itMocked('trims model name', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/extraction-model', json({ model: '  gpt-4  ' }))
      expect(res.status).toBe(200)
      expect(mockSetExtractionModel).toHaveBeenCalledWith('gpt-4')
    })

    itMocked('clears extraction model when set to null', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/extraction-model', json({ model: null }))
      expect(res.status).toBe(200)
      expect(mockDeleteSetting).toHaveBeenCalledWith('extraction_model')
      const body = await res.json()
      expect(body.extractionModel).toBeNull()
    })

    itMocked('clears extraction model when set to empty string', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/extraction-model', json({ model: '' }))
      expect(res.status).toBe(200)
      expect(mockDeleteSetting).toHaveBeenCalledWith('extraction_model')
    })

    itMocked('returns 400 for non-string non-null model', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/extraction-model', json({ model: 123 }))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('INVALID_BODY')
    })
  })

  describe('PUT /embedding-model', () => {
    itMocked('sets embedding model', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/embedding-model', json({ model: 'text-embedding-ada-002' }))
      expect(res.status).toBe(200)
      expect(mockSetEmbeddingModel).toHaveBeenCalledWith('text-embedding-ada-002')
    })

    itMocked('returns 400 for null model', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/embedding-model', json({ model: null }))
      expect(res.status).toBe(400)
    })

    itMocked('returns 400 for empty string', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/embedding-model', json({ model: '' }))
      expect(res.status).toBe(400)
    })

    itMocked('returns 400 for whitespace-only string', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/embedding-model', json({ model: '   ' }))
      expect(res.status).toBe(400)
    })

    itMocked('returns 400 for non-string', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/embedding-model', json({ model: true }))
      expect(res.status).toBe(400)
    })
  })

  // ─── Dismissed setup checklist items (Phase 2 onboarding redesign) ──────
  //
  // The dashboard checklist (7 items: add LLM, set default LLM, etc.) lets
  // the user skip items they don't care about. Skip-state is persisted
  // *globally* under app_settings.dismissed_setup_items — Hivekeep is a
  // small-group product with shared configuration, not multi-tenant
  // per-user, so a dismissal applies to every admin.

  describe('GET /dismissed-setup-items', () => {
    itMocked('returns the current list', async () => {
      const app = createApp()
      mockGetDismissedSetupItems.mockImplementation(() =>
        Promise.resolve(['add_image_provider', 'set_default_search']),
      )

      const res = await app.request('/api/settings/dismissed-setup-items')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toEqual(['add_image_provider', 'set_default_search'])
    })

    itMocked('returns an empty array on a fresh install', async () => {
      const app = createApp()
      const res = await app.request('/api/settings/dismissed-setup-items')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.items).toEqual([])
    })
  })

  describe('POST /dismissed-setup-items/:itemId', () => {
    itMocked('dismisses an item and returns the updated list', async () => {
      const app = createApp()
      mockGetDismissedSetupItems.mockImplementation(() =>
        Promise.resolve(['add_image_provider']),
      )

      const res = await app.request('/api/settings/dismissed-setup-items/add_image_provider', {
        method: 'POST',
      })
      expect(res.status).toBe(200)
      expect(mockDismissSetupItem).toHaveBeenCalledWith('add_image_provider')
      const body = await res.json()
      expect(body.items).toEqual(['add_image_provider'])
    })

    itMocked('returns 400 when itemId exceeds 64 chars', async () => {
      const app = createApp()
      const longId = 'x'.repeat(65)
      const res = await app.request(`/api/settings/dismissed-setup-items/${longId}`, {
        method: 'POST',
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.code).toBe('INVALID_ITEM_ID')
      expect(mockDismissSetupItem).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /dismissed-setup-items/:itemId', () => {
    itMocked('restores a dismissed item and returns the updated list', async () => {
      const app = createApp()
      mockGetDismissedSetupItems.mockImplementation(() => Promise.resolve([]))

      const res = await app.request('/api/settings/dismissed-setup-items/add_image_provider', {
        method: 'DELETE',
      })
      expect(res.status).toBe(200)
      expect(mockRestoreSetupItem).toHaveBeenCalledWith('add_image_provider')
      const body = await res.json()
      expect(body.items).toEqual([])
    })
  })

})
