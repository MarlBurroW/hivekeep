/** Conversation continuity and privacy against a disposable server/local LLM. */
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startWorkspaceFixture, demoAdmin, demoMember } from './workspace-fixture'

const fixture = await startWorkspaceFixture()
const sharedBrowser = join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ chromiumSandbox: true, ...(existsSync(sharedBrowser) ? { executablePath: sharedBrowser } : {}) })
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR' })
  const member = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'fr-FR' })
  for (const [context, account] of [[admin, demoAdmin], [member, demoMember]] as const) {
    const response = await context.request.post(fixture.base + '/api/auth/sign-in/email', { data: account, headers: { Origin: fixture.base } })
    assert.equal(response.status(), 200)
  }
  const page = await admin.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(fixture.base + '/agent/atlas')
  const composer = page.locator('textarea').first()
  await composer.waitFor()
  const navigateSettings = () => page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('a[href="/settings/general"]')
    assertLink(link)
    function assertLink(value: HTMLAnchorElement | null) { if (!value) throw new Error('Settings link missing'); value.click() }
  })

  await page.locator('input[type=file]').first().setInputFiles({ name: 'continuity.txt', mimeType: 'text/plain', buffer: Buffer.from('demo only') })
  await page.getByText('continuity.txt', { exact: true }).waitFor()
  await page.waitForFunction(() => !document.querySelector('[data-testid="uploading"]'))
  await composer.fill('Saisie avant navigation')
  await navigateSettings()
  await page.waitForURL('**/settings/general')
  await page.goBack()
  await composer.waitFor()
  assert.equal(await composer.inputValue(), 'Saisie avant navigation')
  await page.getByText('continuity.txt', { exact: true }).waitFor()
  console.log('PASS draft + attachment after immediate route change')

  // Restore a reading anchor, including history outside the latest 50 messages.
  const viewport = page.locator('[data-slot="scroll-area-viewport"]').filter({ has: page.locator('[data-message-id]') }).first()
  await viewport.evaluate((element) => { element.scrollTop = 0 })
  await page.getByText('Repère historique : orchidée violette.', { exact: true }).first().waitFor()
  await viewport.evaluate((element) => { element.scrollTop = 350 })
  await page.waitForTimeout(200)
  const readAnchor = await viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top
    const message = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((node) => node.getBoundingClientRect().bottom > top)!
    return { id: message.dataset.messageId!, offset: message.getBoundingClientRect().top - top }
  })
  await navigateSettings()
  await page.waitForURL('**/settings/general')
  await page.goBack()
  const anchor = page.locator(`[data-message-id="${readAnchor.id}"]`)
  await anchor.waitFor()
  await page.waitForTimeout(300)
  const restored = await anchor.evaluate((element) => element.getBoundingClientRect().top - element.closest('[data-slot="scroll-area-viewport"]')!.getBoundingClientRect().top)
  assert.ok(Math.abs(restored - readAnchor.offset) < 12, `Reading offset ${restored} vs ${readAnchor.offset}`)
  console.log('PASS reading anchor restored after navigation, including older pages')

  await page.getByRole('button', { name: 'Session privée', exact: true }).click()
  const panel = page.getByRole('dialog')
  const privateComposer = panel.locator('textarea')
  await privateComposer.waitFor()
  await privateComposer.fill('Brouillon confidentiel')
  await panel.locator('input[type=file]').setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('private demo') })
  await panel.getByText('private.txt', { exact: true }).waitFor()
  await navigateSettings()
  await page.waitForURL('**/settings/general')
  await page.goBack()
  await privateComposer.waitFor()
  assert.equal(await privateComposer.inputValue(), 'Brouillon confidentiel')
  await panel.getByText('private.txt', { exact: true }).waitFor()
  console.log('PASS selected private session, open panel, draft and files restored')

  const sessions = await fixture.admin('GET', `/agents/${fixture.agent.id}/quick-sessions`)
  const sessionId = sessions.sessions[0].id
  const memberPage = await member.newPage()
  await memberPage.goto(fixture.base + '/agent/atlas')
  await memberPage.locator('textarea').first().waitFor()
  await memberPage.evaluate(() => {
    const source = new EventSource('/api/sse')
    ;(window as any).__privateEvents = []
    source.onmessage = (event) => { try { const value = JSON.parse(event.data); (window as any).__privateEvents.push(value) } catch {} }
  })
  await privateComposer.fill('[demo:slow] Cette conversation est privée')
  await privateComposer.press('Enter')
  await panel.getByText('[demo:slow] Cette conversation est privée', { exact: true }).first().waitFor()
  await page.waitForTimeout(600)
  await navigateSettings()
  await page.waitForURL('**/settings/general')
  await page.goBack()
  await privateComposer.waitFor()
  await panel.getByText(/Voici une réponse de démonstration/).first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(4500)
  assert.equal(await panel.getByText('[demo:slow] Cette conversation est privée', { exact: true }).count(), 1)
  assert.equal(await panel.getByText(/Voici une réponse de démonstration/).count(), 1)
  const denied = await member.request.get(fixture.base + `/api/quick-sessions/${sessionId}`)
  assert.equal(denied.status(), 403)
  const memberEvents = JSON.stringify(await memberPage.evaluate(() => (window as any).__privateEvents))
  assert.equal(memberEvents.includes(sessionId), false)
  assert.equal(memberEvents.includes('Cette conversation est privée'), false)
  const detail = await fixture.admin('GET', `/quick-sessions/${sessionId}`)
  const privateFile = detail.messages.flatMap((message: any) => message.files ?? []).find((file: any) => file.name === 'private.txt')
  assert.ok(privateFile, 'private upload persisted with sent message')
  assert.equal((await admin.request.get(fixture.base + privateFile.url)).status(), 200)
  assert.equal((await member.request.get(fixture.base + privateFile.url)).status(), 404)
  assert.equal((await member.request.get(fixture.base + privateFile.url.replace('/messages/', '/%6dessages/'))).status(), 404)
  console.log('PASS private stream resumed once; other member cannot read session, SSE or attachment')
  assert.deepEqual(errors, [])
} finally {
  try { await browser?.close() } finally { await fixture.stop() }
}
