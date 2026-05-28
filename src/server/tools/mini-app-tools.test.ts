import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { fullMockConfig } from '../../test-helpers'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockApp = {
  id: 'app-1',
  name: 'Test App',
  slug: 'test-app',
  description: 'A test app',
  icon: '🧪',
  kinId: 'kin-1',
  isActive: true,
  hasBackend: false,
  version: 1,
  iconUrl: null,
  entryFile: 'index.html',
}

const mockMiniApps = {
  createMiniApp: mock(() => Promise.resolve({ ...mockApp })),
  getMiniApp: mock(() => Promise.resolve({ ...mockApp })),
  listMiniApps: mock(() => Promise.resolve([{ ...mockApp }])),
  updateMiniApp: mock(() => Promise.resolve({ ...mockApp })),
  deleteMiniApp: mock(() => Promise.resolve()),
  writeAppFile: mock(() => Promise.resolve({ path: 'index.html', size: 100 })),
  readAppFile: mock(() => Promise.resolve(Buffer.from('<h1>Hello</h1>'))),
  deleteAppFile: mock(() => Promise.resolve(true)),
  listAppFiles: mock(() => Promise.resolve([{ path: 'index.html', size: 100, mimeType: 'text/html' }])),
  getMiniAppRow: mock(() => Promise.resolve({ ...mockApp })),
  storageGet: mock(() => Promise.resolve(null as string | null)),
  storageSet: mock(() => Promise.resolve()),
  storageDelete: mock(() => Promise.resolve(true)),
  storageList: mock(() => Promise.resolve([] as any[])),
  storageClear: mock(() => Promise.resolve(3)),
  createSnapshot: mock(() => Promise.resolve({ version: 2, label: 'backup', files: [{ path: 'index.html' }] })),
  listSnapshots: mock(() => Promise.resolve([])),
  rollbackToSnapshot: mock(() => Promise.resolve({ success: true, message: 'Rolled back to version 1' })),
  generateMiniAppIcon: mock(() => Promise.resolve({ ...mockApp, iconUrl: 'https://example.com/icon.png' })),
}

// We use real mini-app-console (pure in-memory, no DB). Import for direct manipulation in tests.
let realConsole: typeof import('@/server/services/mini-app-console')
try { realConsole = await import('@/server/services/mini-app-console') } catch {}

const mockSSE = {
  sseManager: { broadcast: mock(() => {}) },
}

mock.module('@/server/services/mini-apps', () => mockMiniApps)
// Do NOT mock mini-app-console — it's a pure in-memory module and the real
// implementation works fine. Mocking it leaks to mini-app-console.test.ts.
// NOTE: We do NOT mock @/server/tools/mini-app-templates either.
mock.module('@/server/sse/index', () => mockSSE)
// Do NOT mock @/server/services/image-generation — Bun's mock.module leaks
// globally and breaks other test files. The real ImageGenerationError class works fine.
mock.module('@/server/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))
mock.module('@/server/config', () => ({
  config: { ...fullMockConfig },
}))

// Import after mocks
let mod: any
let _mocksWorking = false
try {
  mod = await import('@/server/tools/mini-app-tools')
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

/** Find the content written to a given path via the writeAppFile mock (typed loosely for tests). */
function writtenFile(path: string): string | undefined {
  const call = (mockMiniApps.writeAppFile.mock.calls as unknown as unknown[][]).find((c) => c[1] === path)
  return call ? (call[2] as string) : undefined
}
/** All paths passed to the writeAppFile mock. */
function writtenPaths(): string[] {
  return (mockMiniApps.writeAppFile.mock.calls as unknown as unknown[][]).map((c) => c[1] as string)
}

const ctx: ToolExecutionContext = { kinId: 'kin-1', isSubKin: false }
const otherCtx: ToolExecutionContext = { kinId: 'kin-other', isSubKin: false }
const execOpts = { toolCallId: 'tc', messages: [] as any[], abortSignal: new AbortController().signal }

function resetMocks() {
  Object.values(mockMiniApps).forEach((m) => m.mockClear())
  mockSSE.sseManager.broadcast.mockClear()
  // Clear console entries for our test app
  try { realConsole?.clearConsoleEntries('app-1') } catch {}

  // Reset default return values
  mockMiniApps.getMiniApp.mockImplementation(() => Promise.resolve({ ...mockApp }))
  mockMiniApps.createMiniApp.mockImplementation(() => Promise.resolve({ ...mockApp }))
  mockMiniApps.getMiniAppRow.mockImplementation(() => Promise.resolve({ ...mockApp }))
  mockMiniApps.readAppFile.mockImplementation(() => Promise.resolve(Buffer.from('<h1>Hello</h1>')))
  mockMiniApps.deleteAppFile.mockImplementation(() => Promise.resolve(true))
  mockMiniApps.storageGet.mockImplementation(() => Promise.resolve(null))
  mockMiniApps.storageDelete.mockImplementation(() => Promise.resolve(true))
  mockMiniApps.storageClear.mockImplementation(() => Promise.resolve(3))
  mockMiniApps.createSnapshot.mockImplementation(() =>
    Promise.resolve({ version: 2, label: 'backup', files: [{ path: 'index.html' }] })
  )
  mockMiniApps.rollbackToSnapshot.mockImplementation(() =>
    Promise.resolve({ success: true, message: 'Rolled back to version 1' })
  )
  mockMiniApps.generateMiniAppIcon.mockImplementation(() =>
    Promise.resolve({ ...mockApp, iconUrl: 'https://example.com/icon.png' })
  )
  // Console uses real implementation; entries cleared above
  // templates use real implementation (no mock)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('mini-app-tools', () => {
  beforeEach(resetMocks)

  it('mocks are working', () => {
    expect(_mocksWorking).toBe(true)
  })

  // ─── Tool Registration ──────────────────────────────────────────────────

  describe('tool registrations', () => {
    it('all tools have main availability', () => {
      const tools = [
        mod.createMiniAppTool,
        mod.updateMiniAppTool,
        mod.deleteMiniAppTool,
        mod.listMiniAppsTool,
        mod.writeMiniAppFileTool,
        mod.readMiniAppFileTool,
        mod.deleteMiniAppFileTool,
        mod.listMiniAppFilesTool,
        mod.getMiniAppStorageTool,
        mod.setMiniAppStorageTool,
        mod.deleteMiniAppStorageTool,
        mod.listMiniAppStorageTool,
        mod.clearMiniAppStorageTool,
        mod.createMiniAppSnapshotTool,
        mod.listMiniAppSnapshotsTool,
        mod.rollbackMiniAppTool,
        mod.generateMiniAppIconTool,
        mod.getMiniAppConsoleTool,
        mod.reloadMiniAppTool,
        mod.editMiniAppFileTool,
        mod.multiEditMiniAppFileTool,
      ]
      for (const t of tools) {
        expect(t.availability).toContain('main')
        expect(typeof t.create).toBe('function')
      }
    })
  })

  // ─── create_mini_app ────────────────────────────────────────────────────

  describe('createMiniAppTool', () => {
    it('creates app with HTML', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Test', slug: 'test', html: '<h1>Hi</h1>' },
        execOpts
      )
      expect(result.appId).toBe('app-1')
      expect(result.message).toContain('created successfully')
      expect(mockMiniApps.writeAppFile).toHaveBeenCalledWith('app-1', 'index.html', '<h1>Hi</h1>')
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalled()
    })

    it('creates app from real template', async () => {
      // Use real "dashboard" template (exists in mini-app-templates.ts)
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Tmpl App', slug: 'tmpl', template: 'dashboard' },
        execOpts
      )
      expect(result.appId).toBe('app-1')
      expect(result.message).toContain('from template "dashboard"')
      // Dashboard template has multiple files
      expect(mockMiniApps.writeAppFile.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    it('returns error for unknown template', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Bad', slug: 'bad', template: 'nonexistent-template-xyz' },
        execOpts
      )
      expect(result.error).toContain('not found')
    })

    it('returns error when neither html, files, nor template provided', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Empty', slug: 'empty' },
        execOpts
      )
      expect(result.error).toContain('One of html, files, or template is required')
    })

    it('handles creation error gracefully', async () => {
      mockMiniApps.createMiniApp.mockImplementation(() => Promise.reject(new Error('DB error')))
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Fail', slug: 'fail', html: '<p>x</p>' },
        execOpts
      )
      expect(result.error).toBe('DB error')
    })

    it('writes app.json from the dependencies shorthand', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Deps', slug: 'deps', html: '<div id="root"></div>', dependencies: { react: 'https://esm.sh/react@19' } },
        execOpts
      )
      expect(result.appId).toBe('app-1')
      const appJson = writtenFile('app.json')
      expect(appJson).toBeDefined()
      expect(JSON.parse(appJson!).dependencies.react).toBe('https://esm.sh/react@19')
      // No auto-default warning when deps were explicitly provided
      expect(result.warning).toBeUndefined()
    })

    it('writes every file from a files map', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        {
          name: 'Files', slug: 'files',
          files: { 'index.html': '<div id="root"></div>', 'app.json': '{"dependencies":{}}', '_server.js': 'export default () => {}' },
        },
        execOpts
      )
      expect(result.appId).toBe('app-1')
      const written = writtenPaths()
      expect(written).toContain('index.html')
      expect(written).toContain('app.json')
      expect(written).toContain('_server.js')
    })

    it('auto-creates a default app.json and warns when HTML has bare imports but no deps', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const html = '<div id="root"></div><script type="text/jsx">import { createRoot } from "react-dom/client";</script>'
      const result = await tool.execute(
        { name: 'Bare', slug: 'bare', html },
        execOpts
      )
      expect(result.warning).toContain('default app.json')
      const appJson = writtenFile('app.json')
      expect(appJson).toBeDefined()
      expect(JSON.parse(appJson!).dependencies['react-dom/client']).toBeDefined()
    })

    it('does not auto-default when an app.json is already provided', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const html = '<script type="text/jsx">import React from "react";</script>'
      const result = await tool.execute(
        { name: 'HasJson', slug: 'has-json', files: { 'index.html': html, 'app.json': '{"dependencies":{"react":"x"}}' } },
        execOpts
      )
      expect(result.warning).toBeUndefined()
      const appJson = writtenFile('app.json')
      expect(JSON.parse(appJson!).dependencies.react).toBe('x')
    })

    it('does not auto-default for plain HTML without module imports', async () => {
      const tool = mod.createMiniAppTool.create(ctx)
      const result = await tool.execute(
        { name: 'Plain', slug: 'plain', html: '<h1>Hi</h1>' },
        execOpts
      )
      expect(result.warning).toBeUndefined()
      expect(writtenFile('app.json')).toBeUndefined()
    })
  })

  // ─── reload_mini_app ──────────────────────────────────────────────────────

  describe('reloadMiniAppTool', () => {
    it('broadcasts a miniapp:reload event', async () => {
      const tool = mod.reloadMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.message).toContain('Reload requested')
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'miniapp:reload', kinId: 'kin-1', data: { appId: 'app-1' } })
      )
    })

    it('blocks reload of other kin apps', async () => {
      const tool = mod.reloadMiniAppTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('your own apps')
      expect(mockSSE.sseManager.broadcast).not.toHaveBeenCalled()
    })
  })

  // ─── update_mini_app ────────────────────────────────────────────────────

  describe('updateMiniAppTool', () => {
    it('updates app metadata', async () => {
      const tool = mod.updateMiniAppTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', name: 'New Name' },
        execOpts
      )
      expect(result.message).toContain('updated')
      expect(mockMiniApps.updateMiniApp).toHaveBeenCalledWith('app-1', expect.objectContaining({ name: 'New Name' }))
    })

    it('returns error for non-existent app', async () => {
      mockMiniApps.getMiniApp.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.updateMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'nope', name: 'x' }, execOpts)
      expect(result.error).toBe('App not found')
    })

    it('blocks update of other kin apps', async () => {
      const tool = mod.updateMiniAppTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1', name: 'x' }, execOpts)
      expect(result.error).toContain('only update your own')
    })

    it('handles update error', async () => {
      mockMiniApps.updateMiniApp.mockImplementation(() => Promise.reject(new Error('update failed')))
      const tool = mod.updateMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', name: 'x' }, execOpts)
      expect(result.error).toBe('update failed')
    })
  })

  // ─── delete_mini_app ────────────────────────────────────────────────────

  describe('deleteMiniAppTool', () => {
    it('deletes app and broadcasts', async () => {
      const tool = mod.deleteMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.message).toContain('deleted successfully')
      expect(mockMiniApps.deleteMiniApp).toHaveBeenCalledWith('app-1')
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalled()
    })

    it('returns error for non-existent app', async () => {
      mockMiniApps.getMiniApp.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.deleteMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'nope' }, execOpts)
      expect(result.error).toBe('App not found')
    })

    it('blocks deletion of other kin apps', async () => {
      const tool = mod.deleteMiniAppTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('only delete your own')
    })
  })

  // ─── list_mini_apps ─────────────────────────────────────────────────────

  describe('listMiniAppsTool', () => {
    it('lists apps for the kin', async () => {
      const tool = mod.listMiniAppsTool.create(ctx)
      const result = await tool.execute({}, execOpts)
      expect(result.apps).toHaveLength(1)
      expect(result.apps[0].id).toBe('app-1')
      expect(result.apps[0].name).toBe('Test App')
      expect(mockMiniApps.listMiniApps).toHaveBeenCalledWith('kin-1')
    })
  })

  // ─── write_mini_app_file ────────────────────────────────────────────────

  describe('writeMiniAppFileTool', () => {
    it('writes text file', async () => {
      const tool = mod.writeMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'styles.css', content: 'body{}' },
        execOpts
      )
      expect(result.success).toBe(true)
      expect(result.path).toBe('index.html')
      expect(mockMiniApps.writeAppFile).toHaveBeenCalledWith('app-1', 'styles.css', 'body{}')
    })

    it('writes base64 file', async () => {
      const tool = mod.writeMiniAppFileTool.create(ctx)
      const b64 = Buffer.from('binary data').toString('base64')
      const result = await tool.execute(
        { app_id: 'app-1', path: 'img.png', content: b64, is_base64: true },
        execOpts
      )
      expect(result.success).toBe(true)
      // Verify Buffer was passed
      const callArgs = mockMiniApps.writeAppFile.mock.calls[0] as any
      expect(callArgs[2]).toBeInstanceOf(Buffer)
    })

    it('blocks write to other kin apps', async () => {
      const tool = mod.writeMiniAppFileTool.create(otherCtx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'x.html', content: 'x' },
        execOpts
      )
      expect(result.error).toContain('only write to your own')
    })

    it('returns error for missing app', async () => {
      mockMiniApps.getMiniApp.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.writeMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'nope', path: 'x.html', content: 'x' },
        execOpts
      )
      expect(result.error).toBe('App not found')
    })

    it('broadcasts file-updated event', async () => {
      const tool = mod.writeMiniAppFileTool.create(ctx)
      await tool.execute(
        { app_id: 'app-1', path: 'index.html', content: '<p>new</p>' },
        execOpts
      )
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'miniapp:file-updated' })
      )
    })
  })

  // ─── read_mini_app_file ─────────────────────────────────────────────────

  describe('readMiniAppFileTool', () => {
    it('reads text file as utf-8', async () => {
      const tool = mod.readMiniAppFileTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', path: 'index.html' }, execOpts)
      expect(result.content).toBe('<h1>Hello</h1>')
      expect(result.isBase64).toBeUndefined()
    })

    it('reads binary file as base64', async () => {
      const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      mockMiniApps.readAppFile.mockImplementation(() => Promise.resolve(binaryData))
      const tool = mod.readMiniAppFileTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', path: 'icon.png' }, execOpts)
      expect(result.isBase64).toBe(true)
      expect(result.content).toBe(binaryData.toString('base64'))
    })

    it('blocks read of other kin apps', async () => {
      const tool = mod.readMiniAppFileTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1', path: 'index.html' }, execOpts)
      expect(result.error).toContain('only read your own')
    })

    it('handles various text extensions', async () => {
      const tool = mod.readMiniAppFileTool.create(ctx)
      for (const ext of ['html', 'css', 'js', 'ts', 'json', 'svg', 'txt', 'md', 'xml']) {
        const result = await tool.execute({ app_id: 'app-1', path: `file.${ext}` }, execOpts)
        expect(result.isBase64).toBeUndefined()
      }
    })
  })

  // ─── delete_mini_app_file ───────────────────────────────────────────────

  describe('deleteMiniAppFileTool', () => {
    it('deletes file successfully', async () => {
      const tool = mod.deleteMiniAppFileTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', path: 'old.css' }, execOpts)
      expect(result.message).toContain('deleted')
    })

    it('returns error when file not found', async () => {
      mockMiniApps.deleteAppFile.mockImplementation(() => Promise.resolve(false))
      const tool = mod.deleteMiniAppFileTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', path: 'nope.css' }, execOpts)
      expect(result.error).toBe('File not found')
    })

    it('blocks deletion on other kin apps', async () => {
      const tool = mod.deleteMiniAppFileTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1', path: 'x.css' }, execOpts)
      expect(result.error).toContain('only modify your own')
    })
  })

  // ─── list_mini_app_files ────────────────────────────────────────────────

  describe('listMiniAppFilesTool', () => {
    it('lists files', async () => {
      const tool = mod.listMiniAppFilesTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.files).toHaveLength(1)
      expect(result.files[0].path).toBe('index.html')
    })

    it('blocks listing other kin apps', async () => {
      const tool = mod.listMiniAppFilesTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('only list your own')
    })
  })

  // ─── Storage tools ─────────────────────────────────────────────────────

  describe('getMiniAppStorageTool', () => {
    it('returns null for missing key', async () => {
      const tool = mod.getMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', key: 'missing' }, execOpts)
      expect(result.found).toBe(false)
      expect(result.value).toBeNull()
    })

    it('returns parsed JSON value', async () => {
      mockMiniApps.storageGet.mockImplementation(() => Promise.resolve('{"count":42}'))
      const tool = mod.getMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', key: 'data' }, execOpts)
      expect(result.found).toBe(true)
      expect(result.value).toEqual({ count: 42 })
    })

    it('returns raw string for non-JSON value', async () => {
      mockMiniApps.storageGet.mockImplementation(() => Promise.resolve('plain text'))
      const tool = mod.getMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', key: 'data' }, execOpts)
      expect(result.found).toBe(true)
      expect(result.value).toBe('plain text')
    })

    it('blocks access to other kin apps', async () => {
      const tool = mod.getMiniAppStorageTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1', key: 'x' }, execOpts)
      expect(result.error).toContain('only access your own')
    })
  })

  describe('setMiniAppStorageTool', () => {
    it('sets value successfully', async () => {
      const tool = mod.setMiniAppStorageTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', key: 'prefs', value: { theme: 'dark' } },
        execOpts
      )
      expect(result.message).toContain('set successfully')
      expect(mockMiniApps.storageSet).toHaveBeenCalledWith('app-1', 'prefs', '{"theme":"dark"}')
    })

    it('handles storage error', async () => {
      mockMiniApps.storageSet.mockImplementation(() => Promise.reject(new Error('quota exceeded')))
      const tool = mod.setMiniAppStorageTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', key: 'big', value: 'x' },
        execOpts
      )
      expect(result.error).toBe('quota exceeded')
    })
  })

  describe('deleteMiniAppStorageTool', () => {
    it('deletes existing key', async () => {
      const tool = mod.deleteMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', key: 'old' }, execOpts)
      expect(result.deleted).toBe(true)
    })

    it('reports missing key', async () => {
      mockMiniApps.storageDelete.mockImplementation(() => Promise.resolve(false))
      const tool = mod.deleteMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', key: 'nope' }, execOpts)
      expect(result.deleted).toBe(false)
      expect(result.message).toContain('not found')
    })
  })

  describe('listMiniAppStorageTool', () => {
    it('lists storage keys', async () => {
      mockMiniApps.storageList.mockImplementation(() =>
        Promise.resolve([{ key: 'a', size: 10 }, { key: 'b', size: 20 }])
      )
      const tool = mod.listMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.count).toBe(2)
      expect(result.keys).toHaveLength(2)
    })
  })

  describe('clearMiniAppStorageTool', () => {
    it('clears all storage', async () => {
      const tool = mod.clearMiniAppStorageTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.cleared).toBe(3)
      expect(result.message).toContain('3 storage key(s)')
    })
  })

  // ─── Snapshot tools ─────────────────────────────────────────────────────

  describe('createMiniAppSnapshotTool', () => {
    it('creates snapshot with label', async () => {
      const tool = mod.createMiniAppSnapshotTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', label: 'before-refactor' },
        execOpts
      )
      expect(result.version).toBe(2)
      expect(result.fileCount).toBe(1)
      expect(result.message).toContain('before-refactor')
    })

    it('returns error when no files to snapshot', async () => {
      mockMiniApps.createSnapshot.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.createMiniAppSnapshotTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('No files')
    })

    it('blocks snapshot of other kin apps', async () => {
      const tool = mod.createMiniAppSnapshotTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('only snapshot your own')
    })
  })

  describe('listMiniAppSnapshotsTool', () => {
    it('lists snapshots with current version', async () => {
      mockMiniApps.listSnapshots.mockImplementation((() =>
        Promise.resolve([{
          version: 1,
          label: 'initial',
          files: [{ path: 'index.html' }],
          createdAt: Date.now(),
        }])) as any
      )
      const tool = mod.listMiniAppSnapshotsTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.currentVersion).toBe(1)
      expect(result.snapshots).toHaveLength(1)
      expect(result.snapshots[0].label).toBe('initial')
    })
  })

  describe('rollbackMiniAppTool', () => {
    it('rolls back successfully', async () => {
      const tool = mod.rollbackMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', version: 1 }, execOpts)
      expect(result.message).toContain('Rolled back')
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalled()
    })

    it('returns error on failed rollback', async () => {
      mockMiniApps.rollbackToSnapshot.mockImplementation(() =>
        Promise.resolve({ success: false, message: 'Snapshot not found' })
      )
      const tool = mod.rollbackMiniAppTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', version: 99 }, execOpts)
      expect(result.error).toBe('Snapshot not found')
    })

    it('blocks rollback of other kin apps', async () => {
      const tool = mod.rollbackMiniAppTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1', version: 1 }, execOpts)
      expect(result.error).toContain('only rollback your own')
    })
  })

  // ─── generate_mini_app_icon ─────────────────────────────────────────────

  describe('generateMiniAppIconTool', () => {
    it('generates icon successfully', async () => {
      const tool = mod.generateMiniAppIconTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.iconUrl).toBe('https://example.com/icon.png')
      expect(result.message).toContain('Icon generated')
    })

    it('returns error for missing app', async () => {
      mockMiniApps.getMiniAppRow.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.generateMiniAppIconTool.create(ctx)
      const result = await tool.execute({ app_id: 'nope' }, execOpts)
      expect(result.error).toContain('not found')
    })

    it('blocks icon generation for other kin apps', async () => {
      const tool = mod.generateMiniAppIconTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('does not belong')
    })

    it('handles NO_IMAGE_PROVIDER error', async () => {
      // Import the real ImageGenerationError class for instanceof check
      const { ImageGenerationError } = await import('@/server/services/image-generation')
      mockMiniApps.generateMiniAppIcon.mockImplementation(() => {
        return Promise.reject(new ImageGenerationError('NO_IMAGE_PROVIDER', 'no provider'))
      })
      const tool = mod.generateMiniAppIconTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('No image generation provider')
    })
  })

  // ─── get_mini_app_console ───────────────────────────────────────────────

  describe('getMiniAppConsoleTool', () => {
    it('returns empty entries with note', async () => {
      const tool = mod.getMiniAppConsoleTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.entries).toHaveLength(0)
      expect(result.summary.total).toBe(0)
      expect(result.note).toBeDefined()
    })

    it('returns entries with summary counts', async () => {
      // Push real console entries
      realConsole!.pushConsoleEntry('app-1', { level: 'log', args: ['hello'], stack: null, timestamp: Date.now() })
      realConsole!.pushConsoleEntry('app-1', { level: 'error', args: ['oops'], stack: 'Error at line 1', timestamp: Date.now() })
      realConsole!.pushConsoleEntry('app-1', { level: 'warn', args: ['careful'], stack: null, timestamp: Date.now() })

      const tool = mod.getMiniAppConsoleTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.summary.total).toBe(3)
      expect(result.summary.errors).toBe(1)
      expect(result.summary.warnings).toBe(1)
      expect(result.summary.logs).toBe(1)
      expect(result.note).toBeUndefined()
    })

    it('clears buffer when requested', async () => {
      realConsole!.pushConsoleEntry('app-1', { level: 'log', args: ['data'], stack: null, timestamp: Date.now() })
      const tool = mod.getMiniAppConsoleTool.create(ctx)
      await tool.execute({ app_id: 'app-1', clear: true }, execOpts)
      // After clearing, entries should be empty
      const result2 = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result2.entries).toHaveLength(0)
    })

    it('filters by level', async () => {
      realConsole!.pushConsoleEntry('app-1', { level: 'log', args: ['info'], stack: null, timestamp: Date.now() })
      realConsole!.pushConsoleEntry('app-1', { level: 'error', args: ['bad'], stack: null, timestamp: Date.now() })

      const tool = mod.getMiniAppConsoleTool.create(ctx)
      const result = await tool.execute({ app_id: 'app-1', level: 'error' }, execOpts)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].message).toBe('bad')
    })

    it('blocks access to other kin apps', async () => {
      const tool = mod.getMiniAppConsoleTool.create(otherCtx)
      const result = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(result.error).toContain('only access your own')
    })

    it('reports lastServedAt once the app has been served', async () => {
      const tool = mod.getMiniAppConsoleTool.create(ctx)
      const before = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(before.lastServedAt).toBeNull()

      realConsole!.markServed('app-1')
      const after = await tool.execute({ app_id: 'app-1' }, execOpts)
      expect(after.lastServedAt).not.toBeNull()
      expect(() => new Date(after.lastServedAt).toISOString()).not.toThrow()
    })
  })

  // ─── edit_mini_app_file ─────────────────────────────────────────────────

  describe('editMiniAppFileTool', () => {
    it('replaces single occurrence', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('const interval = 120000;'))
      )
      const tool = mod.editMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: '120000', newText: '600000' },
        execOpts
      )
      expect(result.success).toBe(true)
      expect(result.replacementCount).toBe(1)
      expect(result.path).toBe('app.jsx')
      // Verify writeAppFile was called with correct content
      const callArgs = mockMiniApps.writeAppFile.mock.calls[0] as any
      expect(callArgs[0]).toBe('app-1')
      expect(callArgs[1]).toBe('app.jsx')
      expect(callArgs[2]).toBe('const interval = 600000;')
    })

    it('returns error when oldText not found', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('const x = 1;'))
      )
      const tool = mod.editMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: 'notfound', newText: 'x' },
        execOpts
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('oldText not found')
    })

    it('returns error when multiple occurrences without replaceAll', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('a = 1; b = 1;'))
      )
      const tool = mod.editMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: '1', newText: '2' },
        execOpts
      )
      expect(result.success).toBe(false)
      expect(result.error).toContain('matches 2 locations')
    })

    it('replaces all occurrences with replaceAll=true', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('a = 1; b = 1; c = 1;'))
      )
      const tool = mod.editMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: '1', newText: '2', replaceAll: true },
        execOpts
      )
      expect(result.success).toBe(true)
      expect(result.replacementCount).toBe(3)
      const callArgs = mockMiniApps.writeAppFile.mock.calls[0] as any
      expect(callArgs[2]).toBe('a = 2; b = 2; c = 2;')
    })

    it('blocks edit of other kin apps', async () => {
      const tool = mod.editMiniAppFileTool.create(otherCtx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: 'x', newText: 'y' },
        execOpts
      )
      expect(result.error).toContain('only edit your own')
    })

    it('returns error for missing app', async () => {
      mockMiniApps.getMiniApp.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.editMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'nope', path: 'app.jsx', oldText: 'x', newText: 'y' },
        execOpts
      )
      expect(result.error).toBe('App not found')
    })

    it('broadcasts file-updated event', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('hello world'))
      )
      const tool = mod.editMiniAppFileTool.create(ctx)
      await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: 'hello', newText: 'hi' },
        execOpts
      )
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'miniapp:file-updated' })
      )
    })

    it('handles readAppFile error', async () => {
      mockMiniApps.readAppFile.mockImplementation(() => Promise.reject(new Error('File not found: app.jsx')))
      const tool = mod.editMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        { app_id: 'app-1', path: 'app.jsx', oldText: 'x', newText: 'y' },
        execOpts
      )
      expect(result.error).toBe('File not found: app.jsx')
    })
  })

  // ─── multi_edit_mini_app_file ───────────────────────────────────────────

  describe('multiEditMiniAppFileTool', () => {
    it('applies multiple edits atomically', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('const a = 1;\nconst b = 2;'))
      )
      const tool = mod.multiEditMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        {
          app_id: 'app-1',
          path: 'app.jsx',
          edits: [
            { oldText: 'const a = 1;', newText: 'const a = 10;' },
            { oldText: 'const b = 2;', newText: 'const b = 20;' },
          ],
        },
        execOpts
      )
      expect(result.success).toBe(true)
      expect(result.editsApplied).toBe(2)
      const callArgs = mockMiniApps.writeAppFile.mock.calls[0] as any
      expect(callArgs[2]).toBe('const a = 10;\nconst b = 20;')
    })

    it('returns error when first edit fails', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('const x = 1;'))
      )
      const tool = mod.multiEditMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        {
          app_id: 'app-1',
          path: 'app.jsx',
          edits: [
            { oldText: 'notfound', newText: 'x' },
            { oldText: 'const x', newText: 'let x' },
          ],
        },
        execOpts
      )
      expect(result.success).toBe(false)
      expect(result.failedEditIndex).toBe(0)
      expect(result.editsAppliedBeforeFailure).toBe(0)
      // Should not have written anything
      expect(mockMiniApps.writeAppFile).not.toHaveBeenCalled()
    })

    it('returns error when second edit has multiple matches', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('a = 1; b = 1; c = 1;'))
      )
      const tool = mod.multiEditMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        {
          app_id: 'app-1',
          path: 'app.jsx',
          edits: [
            { oldText: 'a = 1', newText: 'a = 10' },
            { oldText: '1', newText: '2' }, // matches 3 times after first edit (10 contains 1)
          ],
        },
        execOpts
      )
      expect(result.success).toBe(false)
      expect(result.failedEditIndex).toBe(1)
      expect(result.error).toContain('matches 3 locations')
      expect(mockMiniApps.writeAppFile).not.toHaveBeenCalled()
    })

    it('blocks edit of other kin apps', async () => {
      const tool = mod.multiEditMiniAppFileTool.create(otherCtx)
      const result = await tool.execute(
        {
          app_id: 'app-1',
          path: 'app.jsx',
          edits: [{ oldText: 'x', newText: 'y' }],
        },
        execOpts
      )
      expect(result.error).toContain('only edit your own')
    })

    it('returns error for missing app', async () => {
      mockMiniApps.getMiniApp.mockImplementation(() => Promise.resolve(null as any))
      const tool = mod.multiEditMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        {
          app_id: 'nope',
          path: 'app.jsx',
          edits: [{ oldText: 'x', newText: 'y' }],
        },
        execOpts
      )
      expect(result.error).toBe('App not found')
    })

    it('broadcasts file-updated event', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('hello world'))
      )
      const tool = mod.multiEditMiniAppFileTool.create(ctx)
      await tool.execute(
        {
          app_id: 'app-1',
          path: 'app.jsx',
          edits: [{ oldText: 'hello', newText: 'hi' }],
        },
        execOpts
      )
      expect(mockSSE.sseManager.broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'miniapp:file-updated' })
      )
    })

    it('edits are applied sequentially (second sees result of first)', async () => {
      mockMiniApps.readAppFile.mockImplementation(() =>
        Promise.resolve(Buffer.from('foo bar'))
      )
      const tool = mod.multiEditMiniAppFileTool.create(ctx)
      const result = await tool.execute(
        {
          app_id: 'app-1',
          path: 'app.jsx',
          edits: [
            { oldText: 'foo', newText: 'baz' },
            { oldText: 'baz bar', newText: 'done' },
          ],
        },
        execOpts
      )
      expect(result.success).toBe(true)
      expect(result.editsApplied).toBe(2)
      const callArgs = mockMiniApps.writeAppFile.mock.calls[0] as any
      expect(callArgs[2]).toBe('done')
    })
  })
})
