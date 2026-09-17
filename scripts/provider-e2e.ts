/** Real server/tool execution with a disposable DB and the fixture's local provider. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { chromium } from 'playwright'
import { startWorkspaceFixture, demoAdmin } from './workspace-fixture'

const fixture = await startWorkspaceFixture()
let db: Database | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

type MessageRow = { id: string; role: string; source_type: string; content: string; tool_calls: string | null }
async function waitFor<T>(label: string, read: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await Bun.sleep(150)
  }
  throw new Error(`Timed out: ${label}`)
}

try {
  db = new Database(join(fixture.dataDir, 'hivekeep.db'), { readonly: true })
  db.run('PRAGMA busy_timeout = 5000')
  const messages = (agentId: string) => db!.query<MessageRow, [string]>(
    'SELECT id, role, source_type, content, tool_calls FROM messages WHERE agent_id = ? AND task_id IS NULL AND session_id IS NULL ORDER BY created_at, id',
  ).all(agentId)
  const queueDone = (id: string) => db!.query<{ status: string }, [string]>(
    'SELECT status FROM queue_items WHERE id = ?',
  ).get(id)?.status === 'done'
  const assertIdle = async (agentId: string) => {
    const state = await fixture.admin('GET', '/agents')
    const agent = state.agents.find((item: any) => item.id === agentId)
    assert.equal(agent?.isProcessing, false)
    assert.equal(agent?.queueSize, 0)
    assert.deepEqual((await fixture.admin('GET', `/agents/${agentId}/messages/queue`)).items, [])
  }

  await fixture.admin('PATCH', `/agents/${fixture.agent.id}`, { extraToolNames: ['read_file'] })
  const tools = await fixture.admin('GET', `/agents/${fixture.agent.id}/tools`)
  assert.ok(tools.tools.some((tool: any) => tool.name === 'read_file'), 'Atlas must be granted read_file')
  const beforeTool = new Set(messages(fixture.agent.id).map(message => message.id))
  const toolQueue = await fixture.admin('POST', `/agents/${fixture.agent.id}/messages`, {
    content: '[demo:tool] Lis synthese.md et réponds après la lecture.',
  })
  const toolMessage = await waitFor('persisted tool result and final answer', () => {
    if (!queueDone(toolQueue.messageId)) return false
    return messages(fixture.agent.id).find(message => !beforeTool.has(message.id)
      && message.role === 'assistant' && message.tool_calls
      && message.content.includes('Voici une réponse de démonstration'))
  })
  const toolCalls = JSON.parse(toolMessage.tool_calls!) as { name: string; args: any; result?: unknown }[]
  const reads = toolCalls.filter(call => call.name === 'read_file')
  assert.equal(reads.length, 1, 'The provider must stop requesting the tool once its result is supplied')
  assert.equal(reads[0]!.args.path, 'synthese.md')
  assert.match(JSON.stringify(reads[0]!.result), /Un document de démonstration, sans données réelles/)
  const toolHistory = await fixture.admin('GET', `/agents/${fixture.agent.id}/messages`)
  const visibleTool = toolHistory.messages.find((message: any) => message.id === toolMessage.id)
  assert.deepEqual(visibleTool?.toolCalls, toolCalls)
  await assertIdle(fixture.agent.id)
  console.log('PASS simulated tool call executes read_file, persists its real result and finishes with a response')

  const beforeError = new Set(messages(fixture.secondAgent.id).map(message => message.id))
  const failedQueue = await fixture.admin('POST', `/agents/${fixture.secondAgent.id}/messages`, {
    content: '[demo:error] Déclenche une erreur contrôlée du fournisseur.',
  })
  const errorMessage = await waitFor('provider error persisted and queue released', () => {
    if (!queueDone(failedQueue.messageId)) return false
    return messages(fixture.secondAgent.id).find(message => !beforeError.has(message.id)
      && message.source_type === 'system' && message.content.startsWith('⚠️'))
  })
  assert.match(errorMessage.content, /Simulated provider failure|503|service unavailable/i)
  const errorHistory = await fixture.admin('GET', `/agents/${fixture.secondAgent.id}/messages`)
  assert.equal(errorHistory.messages.find((message: any) => message.id === errorMessage.id)?.content, errorMessage.content)
  await assertIdle(fixture.secondAgent.id)

  // Check the persisted API error is also displayed after a fresh page load.
  const sharedBrowser = join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
  browser = await chromium.launch({ chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : existsSync(sharedBrowser) ? { executablePath: sharedBrowser } : {}),
  })
  const context = await browser.newContext({ locale: 'fr-FR' })
  const login = await context.request.post(`${fixture.base}/api/auth/sign-in/email`, {
    data: demoAdmin, headers: { Origin: fixture.base },
  })
  assert.equal(login.status(), 200)
  const page = await context.newPage()
  await page.goto(`${fixture.base}/agent/${fixture.secondAgent.slug}`)
  await page.locator(`[data-message-id="${errorMessage.id}"]`).getByText(errorMessage.content, { exact: true }).waitFor()
  console.log('PASS simulated provider error is persisted, visible in the conversation and releases the queue')

  const beforeRecovery = new Set(messages(fixture.secondAgent.id).map(message => message.id))
  const recoveryQueue = await fixture.admin('POST', `/agents/${fixture.secondAgent.id}/messages`, {
    content: 'Reprends normalement après cette erreur contrôlée.',
  })
  const recoveredMessage = await waitFor('normal response after provider failure', () => {
    if (!queueDone(recoveryQueue.messageId)) return false
    return messages(fixture.secondAgent.id).find(message => !beforeRecovery.has(message.id)
      && message.role === 'assistant' && message.source_type !== 'system'
      && message.content.includes('Voici une réponse de démonstration'))
  })
  await assertIdle(fixture.secondAgent.id)
  await page.locator(`[data-message-id="${recoveredMessage.id}"]`).getByText(/Voici une réponse de démonstration/).waitFor()
  assert.equal(messages(fixture.secondAgent.id).filter(message => !beforeRecovery.has(message.id) && message.source_type === 'system').length, 0)
  console.log('PASS a subsequent normal message completes and appears after the provider error')
  console.log(`Provider scenarios: 3 passed; ${fixture.inferenceCount()} local inference requests; no paid provider`)
} catch (error) {
  // Synthetic fixture logs only; capture diagnostics before the temporary data is removed.
  console.error(readFileSync(join(fixture.dataDir, 'server.log'), 'utf8').slice(-8000))
  throw error
} finally {
  try {
    await browser?.close()
  } finally {
    try { db?.close() } finally { await fixture.stop() }
  }
}
