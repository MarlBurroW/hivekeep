/** Product workflows against a disposable database/server and a local simulated LLM. */
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startWorkspaceFixture, demoAdmin, demoMember } from './workspace-fixture'
import { settingsSections, settingsUrl } from '../src/client/lib/navigation'
import en from '../src/client/locales/en.json'

const out = process.env.HIVEKEEP_PRODUCT_E2E_OUTPUT ?? '/tmp/hivekeep-product-e2e'
mkdirSync(out, { recursive: true })
const t = (key: string): string => { const value = key.split('.').reduce((value: any, part) => value?.[part], en); assert.equal(typeof value, 'string', key); return value }
const fixture = await startWorkspaceFixture({ language: 'en' })
let browser: Browser | undefined
const errors: string[] = []
const results: string[] = []
const unnamedButtons: Array<{ route: string; html: string }> = []
const check = (name: string) => { results.push(name); console.log(`PASS ${name}`) }
const press = async (target: Locator, key = 'Enter') => { await target.focus(); await target.press(key) }
const inspectButtons = async (page: Page, scope: Locator = page.locator('body')) => {
  for (const button of await scope.getByRole('button', { name: '', exact: true }).all()) {
    if (!(await button.isVisible())) continue
    unnamedButtons.push({ route: new URL(page.url()).pathname, html: await button.evaluate(element => element.outerHTML.slice(0, 2000)) })
  }
}
try {
  const sharedBrowser = join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
  browser = await chromium.launch({ chromiumSandbox: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : existsSync(sharedBrowser) ? { executablePath: sharedBrowser } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', serviceWorkers: 'block' })
  assert.equal((await context.request.post(fixture.base + '/api/auth/sign-in/email', { data: demoAdmin, headers: { Origin: fixture.base } })).status(), 200)
  // Discovery alone contacts npm. Keep this route check deterministic and offline;
  // provider and plugin installation are outside this suite's scope.
  await context.route('**/api/plugins/registry/npm-search**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"plugins":[]}' }))
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)

  await page.goto(fixture.base + '/agents?create=1')
  const dialog = page.getByRole('dialog')
  await press(dialog.getByRole('button', { name: t('agent.wizard.skipManual'), exact: true }))
  await dialog.locator('#agentFormName').fill('Product Demo')
  await dialog.locator('#agentFormRole').fill('Prepare clear product briefs')
  assert.equal(await dialog.getByRole('button', { name: t('agent.tabs.compaction'), exact: true }).count(), 0)
  const createdResponse = page.waitForResponse(response => response.url().endsWith('/api/agents') && response.request().method() === 'POST')
  await press(dialog.getByRole('button', { name: t('agent.create.submit'), exact: true }))
  const response = await createdResponse
  assert.equal(response.status(), 201)
  const { agent: created } = await response.json()
  await page.waitForURL(`**/agent/${created.slug}`)
  const composer = page.locator('textarea').first()
  await composer.fill('Please prepare a short product brief.')
  await composer.press('Enter')
  await page.getByText(/Voici une réponse de démonstration/).first().waitFor({ timeout: 20000 })
  let conversation = await fixture.admin('GET', `/agents/${created.id}/messages`)
  for (let retry = 0; retry < 50 && !conversation.messages.some((message: any) => message.role === 'assistant'); retry++) {
    await page.waitForTimeout(200)
    conversation = await fixture.admin('GET', `/agents/${created.id}/messages`)
  }
  assert.ok(conversation.messages.some((message: any) => message.role === 'user' && message.content === 'Please prepare a short product brief.'))
  assert.ok(conversation.messages.some((message: any) => message.role === 'assistant' && message.content.includes('Voici une réponse')))
  check('manual Agent creation by keyboard, redirect and first persisted exchange')

  const initial = await fixture.admin('GET', `/agents/${created.id}`)
  await fixture.admin('PATCH', `/agents/${created.id}`, {
    character: 'Precise and patient. Preserve this character.',
    expertise: 'Product research and acceptance criteria. Preserve this expertise.',
    toolboxIds: [], extraToolNames: ['read_file'],
    scoutModel: initial.model, scoutProviderId: initial.providerId,
    scoutThinkingConfig: { enabled: false },
    compactingConfig: { thresholdPercent: 70, keepPercent: 30, maxSummaries: 3 },
    thinkingConfig: { enabled: true, effort: 'high' },
  })
  const before = await fixture.admin('GET', `/agents/${created.id}`)
  await page.reload()
  await composer.waitFor()
  await press(page.getByRole('button', { name: t('accessibility.agentSettings'), exact: true }))
  await press(page.getByRole('menuitem', { name: t('sidebar.agents.contextMenu.edit'), exact: true }))
  await dialog.locator('#agentFormRole').fill('Prepare useful product briefs and acceptance criteria')
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/agents/${created.id}`) && response.request().method() === 'PATCH')
  await press(dialog.getByRole('button', { name: t('common.save'), exact: true }))
  assert.equal((await saved).status(), 200)
  const after = await fixture.admin('GET', `/agents/${created.id}`)
  assert.equal(after.role, 'Prepare useful product briefs and acceptance criteria')
  for (const field of ['character', 'expertise', 'model', 'providerId', 'scoutModel', 'scoutProviderId', 'scoutThinkingConfig', 'toolboxIds', 'extraToolNames', 'compactingConfig', 'thinkingConfig']) assert.deepEqual(after[field], before[field], `Identity edit must preserve ${field}`)
  await press(dialog.getByRole('button', { name: t('experience.agent.advanced'), exact: true }))
  await press(dialog.getByRole('button', { name: t('agent.tabs.compaction'), exact: true }))
  await press(dialog.getByRole('button', { name: t('experience.agent.advanced'), exact: true }))
  assert.equal(await dialog.getByRole('button', { name: t('agent.tabs.compaction'), exact: true }).count(), 0)
  await dialog.locator('#agentFormName').waitFor()
  await inspectButtons(page, dialog)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  check('identity editing preserves advanced configuration; advanced controls remain keyboard reachable')

  // Closed tool-call panels must leave neither their controls nor focus targets mounted.
  const toolsTitle = t('tools.viewer.title')
  assert.equal(await page.getByRole('heading', { name: toolsTitle, exact: true }).count(), 0)
  await press(page.getByRole('button', { name: toolsTitle, exact: true }))
  const toolHeading = page.getByRole('heading', { name: toolsTitle, exact: true })
  await toolHeading.waitFor()
  const toolsPanel = toolHeading.locator('xpath=../../..')
  await inspectButtons(page, toolsPanel)
  await press(toolsPanel.getByRole('button', { name: t('common.close'), exact: true }))
  assert.equal(await toolHeading.count(), 0)
  assert.equal(await page.getByRole('button', { name: 'View available tools', exact: true }).count(), 0)
  check('tool-call panel opens/closes by keyboard; closed controls leave the accessibility tree')

  const { cron: newCron } = await fixture.admin('POST', '/crons', { agentId: created.id, name: 'Annual product review', schedule: '0 9 1 1 *', taskDescription: 'Review product priorities.', thinkingEffort: 'low', triggerParentTurn: true })
  assert.equal(newCron.isActive, true)
  assert.equal(newCron.requiresApproval, false)
  const { cron: updatedCron } = await fixture.admin('PATCH', `/crons/${newCron.id}`, { name: 'Annual product priorities', schedule: '0 10 1 1 *', taskDescription: 'Review priorities and acceptance criteria.', thinkingEffort: 'high' })
  assert.equal(updatedCron.schedule, '0 10 1 1 *')
  assert.equal(updatedCron.taskDescription, 'Review priorities and acceptance criteria.')
  assert.equal(updatedCron.thinkingEffort, 'high')
  assert.equal(updatedCron.triggerParentTurn, true)
  const member = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true })
  assert.equal((await member.request.post(fixture.base + '/api/auth/sign-in/email', { data: demoMember, headers: { Origin: fixture.base } })).status(), 200)
  const memberPage = await member.newPage()
  memberPage.on('pageerror', error => errors.push(error.message))
  await memberPage.goto(fixture.base + '/automations/plans')
  await memberPage.getByText(updatedCron.name, { exact: true }).waitFor()
  assert.equal(await memberPage.getByRole('button', { name: t('sidebar.crons.create'), exact: true }).count(), 0)
  assert.equal(await memberPage.getByRole('button', { name: t('sidebar.crons.approve'), exact: true }).count(), 0)
  assert.equal(await memberPage.getByRole('switch').count(), 0)
  const memberPending = (await fixture.admin('GET', '/crons')).crons.find((cron: any) => cron.requiresApproval)
  assert.ok(memberPending)
  for (const cron of [updatedCron, memberPending]) {
    await press(memberPage.getByRole('button', { name: new RegExp(cron.name) }).first())
    const detail = memberPage.getByRole('dialog')
    await detail.waitFor()
    for (const key of ['common.edit', 'cron.detail.duplicate', 'cron.detail.runNow', 'sidebar.crons.approve']) assert.equal(await detail.getByRole('button', { name: t(key), exact: true }).count(), 0, key)
    assert.equal(await detail.getByRole('switch').count(), 0)
    await press(detail.getByRole('button', { name: t('common.close'), exact: true }).last())
  }
  for (const [method, route, body] of [
    ['POST', '/crons', { agentId: created.id, name: 'Forbidden', schedule: '0 9 1 1 *', taskDescription: 'Forbidden' }],
    ['PATCH', `/crons/${newCron.id}`, { isActive: false }],
    ['DELETE', `/crons/${newCron.id}`, undefined],
    ['POST', `/crons/${memberPending.id}/approve`, undefined],
    ['POST', `/crons/${newCron.id}/trigger`, undefined],
  ] as const) assert.equal((await member.request.fetch(fixture.base + '/api' + route, { method, data: body })).status(), 403, `${method} ${route}`)
  await member.close()
  check('member sees schedules and details without mutation controls; all five mutation APIs return 403')
  await page.goto(fixture.base + '/automations/plans')
  await page.getByText(updatedCron.name, { exact: true }).waitFor()
  await inspectButtons(page)
  await press(page.getByRole('button', { name: new RegExp(updatedCron.name) }).first())
  await dialog.waitFor()
  await press(dialog.getByRole('button', { name: t('common.edit'), exact: true }))
  await dialog.locator('#cronFormName').waitFor()
  assert.equal(await dialog.locator('#cronFormName').inputValue(), updatedCron.name)
  await inspectButtons(page, dialog)
  await press(dialog.getByRole('button', { name: t('common.cancel'), exact: true }))
  await dialog.waitFor({ state: 'hidden' })
  await press(page.getByRole('button', { name: t('sidebar.crons.create'), exact: true }))
  await dialog.locator('#cronFormName').waitFor()
  assert.equal(await dialog.locator('#cronFormName').inputValue(), '')
  await press(dialog.getByRole('button', { name: t('common.cancel'), exact: true }))
  const { cron: pausedCron } = await fixture.admin('PATCH', `/crons/${newCron.id}`, { isActive: false })
  assert.equal(pausedCron.isActive, false)
  const { crons } = await fixture.admin('GET', '/crons')
  const pending = crons.find((cron: any) => cron.requiresApproval)
  assert.ok(pending, 'fixture provides a schedule awaiting approval')
  const { cron: approved } = await fixture.admin('POST', `/crons/${pending.id}/approve`)
  assert.equal(approved.requiresApproval, false)
  assert.equal(approved.isActive, true)
  assert.equal((await context.request.post(fixture.base + `/api/crons/${pending.id}/approve`)).status(), 409)
  assert.equal((await fixture.admin('PATCH', `/crons/${pending.id}`, { isActive: false })).cron.isActive, false)
  assert.equal((await fixture.admin('DELETE', `/crons/${newCron.id}`)).success, true)
  assert.equal((await fixture.admin('GET', '/crons')).crons.some((cron: any) => cron.id === newCron.id), false)
  check('schedule API create/update/approve/disable/delete; create/edit forms reachable by keyboard')

  // Changing only the Agent filter must recompute the list, without a search
  // keystroke, navigation, or a refreshed API response.
  await page.goto(fixture.base + '/productions/apps')
  const demoApp = page.getByRole('button', { name: `${t('miniApps.openPanel')} : Carnet de projet`, exact: true })
  await demoApp.waitFor()
  const appAgentFilter = page.getByRole('combobox', { name: t('sidebar.miniApps.allAgents'), exact: true })
  await appAgentFilter.click()
  await page.getByRole('option', { name: fixture.agent.name, exact: true }).click()
  await demoApp.waitFor({ state: 'hidden' })
  await page.getByText(t('sidebar.miniApps.noResults'), { exact: true }).waitFor()
  await appAgentFilter.click()
  await page.getByRole('option', { name: fixture.secondAgent.name, exact: true }).click()
  await demoApp.waitFor()
  await appAgentFilter.click()
  await page.getByRole('option', { name: t('sidebar.miniApps.allAgents'), exact: true }).click()
  await demoApp.waitFor()
  check('changing the Agent filter immediately updates apps with an unchanged query and catalogue')

  assert.equal(settingsSections.length, 24)
  for (const section of settingsSections) {
    await page.goto(fixture.base + settingsUrl(section.id))
    await page.getByRole('heading', { name: t(section.labelKey), level: 1, exact: true }).waitFor()
    const nav = page.getByRole('navigation', { name: t('settings.title'), exact: true })
    const current = nav.getByRole('link', { name: t(section.labelKey), exact: true })
    assert.equal(await current.getAttribute('aria-current'), 'page', section.id)
    await press(current)
    await page.getByRole('status').filter({ hasText: t('common.loading') }).waitFor({ state: 'hidden' })
    await page.waitForTimeout(500)
    assert.equal(await page.getByText(/Something went wrong|Page unavailable|Please reload the page/).count(), 0, section.id)
    await inspectButtons(page)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, section.id)
  }
  check('all 24 registry settings routes load directly and their navigation works by keyboard')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog')
  await palette.getByRole('combobox').fill('settings Providers')
  await page.keyboard.press('Enter')
  await page.waitForURL('**/settings/providers')
  await palette.waitFor({ state: 'hidden' })
  await page.keyboard.press('Control+k')
  await palette.waitFor()
  await page.keyboard.press('Escape')
  await palette.waitFor({ state: 'hidden' })
  await page.goto(fixture.base + '/settings/general')
  await press(page.getByRole('button', { name: t('accessibility.paletteToggle'), exact: true }))
  await press(page.getByRole('menuitem', { name: 'Ocean', exact: true }))
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'ocean')
  check('command palette navigation and dismissal, plus color palette selection, work by keyboard')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(fixture.base + '/settings/general')
  const settingsSelect = page.getByRole('combobox', { name: t('settings.title'), exact: true })
  await settingsSelect.waitFor()
  assert.equal(await settingsSelect.locator('option').count(), 24)
  await settingsSelect.selectOption('notifications')
  await page.waitForURL('**/settings/notifications')
  await press(page.getByRole('button', { name: t('workspace.back'), exact: true }))
  await page.waitForURL('**/agents')
  check('mobile settings select exposes 24 sections and Back is keyboard reachable')

  assert.deepEqual(errors, [])
  assert.deepEqual(unnamedButtons, [], 'Visible buttons must have accessible names; see results.json')
  check('no browser errors or unnamed visible buttons in the inspected routes and forms')
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, errors, unnamedButtons }, null, 2))
} catch (error) {
  writeFileSync(join(out, 'results.json'), JSON.stringify({ results, errors, unnamedButtons, failure: String(error) }, null, 2))
  throw error
} finally {
  try { await browser?.close() } finally { await fixture.stop() }
}
