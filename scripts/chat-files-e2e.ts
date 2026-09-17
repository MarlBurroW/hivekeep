/** Chat → workspace → message, against real file APIs and a disposable database. */
import { chromium, type Browser, type Page } from 'playwright'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startWorkspaceFixture, demoAdmin, demoMember } from './workspace-fixture'
import en from '../src/client/locales/en.json'
import fr from '../src/client/locales/fr.json'

const out = process.env.HIVEKEEP_CHAT_FILES_E2E_OUTPUT ?? '/tmp/hivekeep-chat-files-e2e'
mkdirSync(out, { recursive: true })
const fixture = await startWorkspaceFixture({ language: 'en' })
const base = `/workspace/agent/${fixture.agent.id}`
const results: string[] = []
const errors: string[] = []
const check = (name: string) => { results.push(name); console.log(`PASS ${name}`) }
let browser: Browser | undefined
let page: Page | undefined

try {
  await fixture.admin('POST', base + '/mkdir', { path: 'Documents clients' })
  await fixture.admin('POST', base + '/mkdir', { path: 'Vide' })
  await fixture.admin('PUT', base + '/file', { path: 'Documents clients/brief été.md', content: 'Brief à relire.' })
  await fixture.admin('PUT', base + '/file', { path: 'Documents clients/bilan.txt', content: 'Original, à conserver.' })
  await fixture.admin('PUT', base + '/file', { path: 'Documents clients/notes `v2`.md', content: 'Punctuation in filenames.' })
  await fixture.admin('PUT', `/workspace/agent/${fixture.secondAgent.id}/file`, { path: 'nova-only.md', content: 'Other agent workspace.' })

  const executable = join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
  browser = await chromium.launch({ chromiumSandbox: true, ...(existsSync(executable) ? { executablePath: executable } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
  assert.equal((await context.request.post(fixture.base + '/api/auth/sign-in/email', { data: demoAdmin, headers: { Origin: fixture.base } })).status(), 200)
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  let messageRequests = 0
  let attachmentRequests = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/messages')) messageRequests++
    if (request.method() === 'POST' && request.url().endsWith('/files/upload')) attachmentRequests++
  })
  await page.goto(fixture.base + '/agent/atlas')
  const composer = page.locator('textarea').first()
  await composer.fill('Peux-tu analyser ces documents ?')
  const trigger = page.getByRole('button', { name: en.chat.workspaceFiles.open, exact: true })
  const panel = page.getByRole('dialog', { name: 'Files · Atlas', exact: true })
  const open = async () => { await trigger.click(); await panel.getByRole('heading', { name: 'Files · Atlas', exact: true }).waitFor() }
  const choose = (path: string) => panel.getByRole('button', { name: path, exact: true })
  const search = panel.getByRole('textbox', { name: en.chat.workspaceFiles.search, exact: true })
  const add = panel.getByRole('button', { name: en.chat.workspaceFiles.insert, exact: true })

  await trigger.focus()
  await trigger.press('Enter')
  await choose('Vide').click()
  await panel.getByText(en.chat.workspaceFiles.empty, { exact: true }).waitFor()
  assert.equal(await add.isDisabled(), true)
  await panel.getByRole('button', { name: en.chat.workspaceFiles.up, exact: true }).click()
  await choose('Documents clients').click()
  await choose('Documents clients/brief été.md').click()
  await search.fill('notes')
  await choose('Documents clients/notes `v2`.md').click()
  assert.equal(await choose('Documents clients/notes `v2`.md').getAttribute('aria-pressed'), 'true')
  await add.click()
  await panel.waitFor({ state: 'hidden' })
  const references = 'Peux-tu analyser ces documents ?\n`Documents clients/brief été.md`\n``Documents clients/notes `v2`.md``\n'
  assert.equal(await composer.inputValue(), references)
  assert.equal(await composer.evaluate((element) => element === document.activeElement), true)
  assert.equal(messageRequests, 0, 'Selecting files must not send a message')
  assert.equal(new URL(page.url()).pathname, '/agent/atlas')
  await page.reload()
  await composer.waitFor()
  assert.equal(await composer.inputValue(), references, 'References survive reload with the draft')
  check('keyboard browsing, empty folder, multi-selection across search, exact accented/backtick paths, persistent draft')

  await open()
  await choose('Documents clients').click()
  const uploaded = page.waitForResponse((response) => response.url().endsWith(base + '/upload') && response.request().method() === 'POST')
  await panel.locator('input[type=file]').setInputFiles([
    { name: 'bilan.txt', mimeType: 'text/plain', buffer: Buffer.from('Nouveau bilan pour l’agent.') },
    { name: 'x'.repeat(260) + '.txt', mimeType: 'text/plain', buffer: Buffer.from('Invalid name, no disk file.') },
  ])
  const uploadBody = await (await uploaded).json()
  assert.equal(uploadBody.files.length, 1)
  assert.equal(uploadBody.errors.length, 1)
  const uploadedPath = uploadBody.files[0].path
  assert.notEqual(uploadedPath, 'Documents clients/bilan.txt', 'An existing file must not be overwritten')
  await panel.getByRole('alert').waitFor()
  await choose(uploadedPath).waitFor()
  assert.equal(await choose(uploadedPath).getAttribute('aria-pressed'), 'true')
  assert.equal((await fixture.admin('GET', base + '/file?' + new URLSearchParams({ path: 'Documents clients/bilan.txt' }))).content, 'Original, à conserver.')

  // Retrying with another file keeps the successful selection.
  const retryUpload = page.waitForResponse((response) => response.url().endsWith(base + '/upload') && response.request().method() === 'POST')
  await panel.locator('input[type=file]').setInputFiles({ name: 'annexe.txt', mimeType: 'text/plain', buffer: Buffer.from('Annexe importée.') })
  assert.equal((await retryUpload).status(), 201)
  await choose('Documents clients/annexe.txt').waitFor()
  assert.equal(await choose(uploadedPath).getAttribute('aria-pressed'), 'true')
  assert.equal(await panel.getByRole('alert').count(), 0)

  const dropped = page.waitForResponse((response) => response.url().endsWith(base + '/upload') && response.request().method() === 'POST')
  await panel.getByRole('textbox', { name: en.chat.workspaceFiles.search }).evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Dropped from the device.'], 'déposé.csv', { type: 'text/csv' }))
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
  })
  assert.equal((await dropped).status(), 201)
  await choose('Documents clients/déposé.csv').waitFor()
  assert.equal(attachmentRequests, 0, 'Workspace drops must not also become chat attachments')
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('link', { name: 'Download déposé.csv', exact: true }).click()
  assert.equal((await downloadPromise).suggestedFilename(), 'déposé.csv')
  await page.screenshot({ path: join(out, 'workspace-files-desktop.png') })
  await add.click()
  await panel.waitFor({ state: 'hidden' })
  const draft = await composer.inputValue()
  for (const path of [uploadedPath, 'Documents clients/annexe.txt', 'Documents clients/déposé.csv']) assert.ok(draft.includes('`' + path + '`'), path)
  assert.ok(draft.startsWith(references))
  assert.equal(messageRequests, 0)
  const sent = page.waitForResponse((response) => response.url().endsWith(`/agents/${fixture.agent.id}/messages`) && response.request().method() === 'POST')
  await composer.press('Enter')
  assert.equal((await sent).status(), 202)
  await page.waitForFunction(async ({ route, content }) => {
    const response = await fetch(route)
    const data = await response.json()
    return data.messages.some((message: { role: string; content: string }) => message.role === 'user' && message.content === content)
  }, { route: `/api/agents/${fixture.agent.id}/messages`, content: draft.trim() }, { polling: 200 })
  check('nested upload, collision preservation, partial failure/retry, drag/drop, download and exact references in the sent message')

  // A failed search is actionable, not an empty workspace. A stale result must
  // also stay out of the directory after the query is cleared.
  await composer.fill('Brouillon à conserver')
  await open()
  let failSearch = true
  const searchRoute = '**/api' + base + '/search?*'
  await page.route(searchRoute, (route) => failSearch
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Temporary test error"}}' })
    : route.continue())
  await search.fill('brief')
  await panel.getByRole('alert').waitFor()
  failSearch = false
  await panel.getByRole('button', { name: en.common.retry, exact: true }).click()
  await choose('Documents clients/brief été.md').waitFor()
  await page.unroute(searchRoute)

  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const arrived = new Promise<void>((resolve) => { started = resolve })
  await page.route(searchRoute, async (route) => {
    started()
    await gate
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ hits: [{ path: 'stale.txt', name: 'stale.txt', size: 1, modifiedAt: 0 }] }) })
  })
  await search.fill('slow-query')
  await arrived
  await panel.getByRole('button', { name: en.chat.workspaceFiles.clearSearch, exact: true }).click()
  release()
  await page.unrouteAll({ behavior: 'wait' })
  await choose('Documents clients').waitFor()
  assert.equal(await choose('stale.txt').count(), 0)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  assert.equal(await composer.inputValue(), 'Brouillon à conserver')
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
  check('search failure/retry, discarded stale response and closing without changing the draft')

  // Agent switching must change both the workspace and the destination draft.
  await page.goto(fixture.base + '/agent/nova')
  await page.getByRole('button', { name: en.chat.workspaceFiles.open, exact: true }).click()
  const novaPanel = page.getByRole('dialog', { name: 'Files · Nova', exact: true })
  await novaPanel.getByRole('button', { name: 'nova-only.md', exact: true }).waitFor()
  assert.equal(await novaPanel.getByRole('button', { name: 'Documents clients', exact: true }).count(), 0)
  await page.keyboard.press('Escape')
  await page.goto(fixture.base + '/agent/atlas')
  await composer.waitFor()
  assert.equal(await composer.inputValue(), 'Brouillon à conserver')
  check('workspace and draft follow the active agent')

  await page.getByRole('button', { name: en.experience.chat.private, exact: true }).click()
  const privatePanel = page.getByRole('dialog').filter({ has: page.locator('textarea') })
  const privateComposer = privatePanel.locator('textarea')
  await privateComposer.fill('Analyse privée')
  await privatePanel.getByRole('button', { name: en.chat.workspaceFiles.open, exact: true }).click()
  await panel.getByText(en.chat.workspaceFiles.privateHint, { exact: true }).waitFor()
  assert.equal(await panel.locator('input[type=file]').count(), 0)
  const beforePrivateDrop = attachmentRequests
  await panel.getByRole('heading').evaluate((element) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['Not a workspace upload target.'], 'header-drop.txt'))
    element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
  })
  await choose('synthese.md').click()
  await add.click()
  await panel.waitFor({ state: 'hidden' })
  assert.equal(await privateComposer.inputValue(), 'Analyse privée\n`synthese.md`\n')
  assert.equal(await composer.inputValue(), 'Brouillon à conserver')
  assert.equal(attachmentRequests, beforePrivateDrop, 'Portalled sheet drops must not reach a composer behind it')
  assert.equal(await privatePanel.getByText(en.chat.dropFiles, { exact: true }).count(), 0)
  await privatePanel.getByRole('button', { name: en.chat.workspaceFiles.open, exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await panel.getByRole('button', { name: en.chat.workspaceFiles.attachPrivate, exact: true }).click()
  const privateUpload = page.waitForResponse((response) => response.url().endsWith('/api/files/upload') && response.request().method() === 'POST')
  await (await chooser).setFiles({ name: 'confidentiel.txt', mimeType: 'text/plain', buffer: Buffer.from('Private, never in shared workspace.') })
  const privateFile = (await (await privateUpload).json()).file
  await privatePanel.getByText('confidentiel.txt', { exact: true }).waitFor()
  assert.equal((await fixture.admin('GET', base + '/search?q=confidentiel')).hits.length, 0)
  const member = await browser.newContext()
  assert.equal((await member.request.post(fixture.base + '/api/auth/sign-in/email', { data: demoMember, headers: { Origin: fixture.base } })).status(), 200)
  assert.equal((await member.request.get(fixture.base + privateFile.url)).status(), 404)
  assert.equal((await context.request.get(fixture.base + privateFile.url)).status(), 200)
  await page.screenshot({ path: join(out, 'workspace-files-private.png') })
  await page.keyboard.press('Escape')
  await privatePanel.waitFor({ state: 'hidden' })
  check('private references stay in the private draft; private upload is absent from workspace and unreadable by another member')

  // Real touch viewports, in both languages/themes. The add action must remain
  // reachable at a narrow width and short height, with long names selected.
  for (const language of ['fr', 'en'] as const) for (const theme of ['dark', 'light']) {
    await fixture.admin('PATCH', '/me', { language, theme })
    const locale = language === 'fr' ? fr : en
    const mobile = await browser.newContext({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, storageState: await context.storageState() })
    const mobilePage = await mobile.newPage()
    mobilePage.on('pageerror', (error) => errors.push(error.message))
    await mobilePage.goto(fixture.base + '/agent/atlas')
    await mobilePage.getByRole('button', { name: locale.chat.workspaceFiles.open, exact: true }).click()
    const mobilePanel = mobilePage.getByRole('dialog', { name: `${language === 'fr' ? 'Fichiers' : 'Files'} · Atlas`, exact: true })
    await mobilePanel.getByRole('button', { name: 'Documents clients', exact: true }).click()
    await mobilePanel.getByRole('button', { name: 'Documents clients/brief été.md', exact: true }).click()
    const overflow = await mobilePanel.evaluate((element) => ({ scroll: element.scrollWidth, width: element.clientWidth, height: element.scrollHeight, clientHeight: element.clientHeight }))
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify({ language, theme, overflow }))
    const bounds = await mobilePanel.getByRole('button', { name: locale.chat.workspaceFiles.insert, exact: true }).boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.y + bounds.height <= 641, JSON.stringify({ language, theme, bounds }))
    await mobilePage.screenshot({ path: join(out, `workspace-files-mobile-${language}-${theme}.png`) })
    await mobilePanel.getByRole('button', { name: locale.chat.workspaceFiles.insert, exact: true }).click()
    assert.ok((await mobilePage.locator('textarea').first().inputValue()).includes('`Documents clients/brief été.md`'))
    await mobilePanel.waitFor({ state: 'hidden' })
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await mobilePage.screenshot({ path: join(out, `composer-mobile-${language}-${theme}.png`) })
    await mobile.close()
  }
  check('320×640 touch layouts in French/English and light/dark, with the add action visible')
  assert.deepEqual(errors, [])
  writeFileSync(join(out, 'report.json'), JSON.stringify({ results, errors }, null, 2) + '\n')
} catch (err) {
  await page?.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {})
  throw err
} finally {
  try { await browser?.close() } finally { await fixture.stop() }
}
