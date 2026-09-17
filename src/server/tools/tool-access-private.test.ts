import { expect, it, mock } from 'bun:test'
import { fullMockDbIndex, fullMockSchema, fullMockDrizzleOrm } from '../../test-helpers'

const createPrompt = mock(() => Promise.resolve({ promptId: 'must-not-exist' }))
const listTools = mock(() => [])
const select = mock(() => { throw new Error('Private request must not access shared Agent state') })
const resolveSession = mock((): any => { throw new Error('Private intervention must not access a browser') })
const createFile = mock(() => { throw new Error('Private intervention must not create a public screenshot') })
const uploadFile = mock(async (_params: any) => ({ id: 'private-file', url: '/api/uploads/messages/agent/private-file.png' }))
mock.module('@/server/services/human-prompts', () => ({ createHumanPrompt: createPrompt }))
mock.module('@/server/tools/index', () => ({ toolRegistry: { list: listTools } }))
mock.module('@/server/services/toolset-resolver', () => ({ getAgentExtraToolNames: () => [], resolveAgentToolboxIds: () => [] }))
mock.module('@/server/services/custom-tools', () => ({ resolveCustomTools: () => ({}) }))
mock.module('@/server/services/toolboxes', () => ({ getToolboxByName() {}, resolveToolboxNames: () => [], CORE_TOOLS: [] }))
mock.module('@/server/db/index', () => ({ ...fullMockDbIndex, db: { select } }))
mock.module('@/server/db/schema', () => fullMockSchema)
mock.module('drizzle-orm', () => fullMockDrizzleOrm)
mock.module('@/server/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
mock.module('@/server/services/playwright-manager', () => ({ playwrightManager: { resolveSession, refreshSessionMeta() {} }, parseCookieInput() {} }))
mock.module('@/server/services/browser-snapshot', () => ({ getPageState() {}, locatorForRef() {} }))
mock.module('@/server/services/web-browse', () => ({ isBlockedUrl: () => false }))
mock.module('@/server/services/file-storage', () => ({ createFileFromContent: createFile }))
mock.module('@/server/services/files', () => ({ uploadFile }))
mock.module('@/server/config', () => ({ config: {} }))
const { requestToolAccessTool } = await import('./tool-access-tools')
const { browserRequestHumanTool, browserScreenshotTool } = await import('./browser-session-tools')

it('refuses private capability requests before exposing their reason through shared prompts', async () => {
  const tool = requestToolAccessTool.create({ agentId: 'agent', isSubAgent: false, sessionId: 'private-session' })
  const result = await tool.execute!({ tool_names: ['send_message'], reason: 'A confidential reason' }, {
    abortSignal: new AbortController().signal,
  })
  expect(result).toEqual({ error: expect.stringContaining('private sessions') })
  expect(createPrompt).not.toHaveBeenCalled()
  expect(listTools).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

it('refuses private browser intervention before creating a shared screenshot or prompt', async () => {
  const tool = browserRequestHumanTool.create({ agentId: 'agent', isSubAgent: false, sessionId: 'private-session' })
  const result = await tool.execute!({ session_id: 'browser-session', reason: 'Confidential page question' }, {
    abortSignal: new AbortController().signal,
  })
  expect(result).toEqual({ error: expect.stringContaining('private sessions') })
  expect(resolveSession).not.toHaveBeenCalled()
  expect(createFile).not.toHaveBeenCalled()
  expect(createPrompt).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

it('stores a private browser screenshot as an owned attachment without a public share', async () => {
  resolveSession.mockImplementationOnce(() => ({ page: { url: () => 'https://example.test/private', screenshot: async () => Buffer.from('png') } }))
  const tool = browserScreenshotTool.create({ agentId: 'agent', userId: 'owner', isSubAgent: false, sessionId: 'private-session' })
  const result = await tool.execute!({ session_id: 'browser-session' }, {})
  expect(result).toMatchObject({ fileId: 'private-file', fileUrl: '/api/uploads/messages/agent/private-file.png' })
  expect(uploadFile).toHaveBeenCalledTimes(1)
  const params = uploadFile.mock.calls[0]![0]
  expect(params).toMatchObject({ agentId: 'agent', uploadedBy: 'owner', sessionId: 'private-session' })
  expect(params.file.type).toBe('image/png')
  expect(await params.file.text()).toBe('png')
  expect(createFile).not.toHaveBeenCalled()
  expect(createPrompt).not.toHaveBeenCalled()
})
