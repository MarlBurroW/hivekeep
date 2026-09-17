/** Real browser + disposable server + local LLM. Run after building the client. */
import { chromium, type Page } from 'playwright'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { startWorkspaceFixture, demoAdmin, demoMember } from './workspace-fixture'

const out = process.env.HIVEKEEP_E2E_OUTPUT ?? '/tmp/hivekeep-workspace-e2e'
mkdirSync(out, { recursive: true })
const fixture = await startWorkspaceFixture()
const sharedBrowser = join(homedir(), '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome')
const browser = await chromium
  .launch({ chromiumSandbox: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : existsSync(sharedBrowser)
        ? { executablePath: sharedBrowser }
        : {}),
  })
  .catch(async (error) => {
    await fixture.stop()
    throw error
  })
const errors: string[] = []
const results: string[] = []
const metrics: Record<string, unknown> = {}
type Resource = { name: string; encoded: number; decoded: number }
const resources = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => entry.name.split('?')[0]?.endsWith('.js'))
      .map((entry) => ({
        name: entry.name.split('/').at(-1)!,
        encoded: (entry as PerformanceResourceTiming).encodedBodySize,
        decoded: (entry as PerformanceResourceTiming).decodedBodySize,
      })),
  )
async function usedSourceBytes(page: Page) {
  let total = 0
  for (const script of await page.coverage.stopJSCoverage()) {
    if (!script.source || !new URL(script.url || 'about:blank').pathname.endsWith('.js')) continue
    const ranges = script.functions.flatMap((fn) => fn.ranges)
    const events = ranges
      .flatMap((range, id) => [
        { at: range.startOffset, id, start: true },
        { at: range.endOffset, id, start: false },
      ])
      .sort((a, b) => a.at - b.at)
    const active = new Set<number>()
    let previous = 0
    for (let index = 0; index < events.length; ) {
      const at = events[index]!.at
      // The narrowest V8 block overrides its enclosing function's count.
      const inner = [...active]
        .map((id) => ranges[id]!)
        .sort((a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset))[0]
      if (inner && inner.count > 0) total += Buffer.byteLength(script.source.slice(previous, at))
      while (index < events.length && events[index]!.at === at) {
        const event = events[index++]!
        if (event.start) active.add(event.id)
        else active.delete(event.id)
      }
      previous = at
    }
  }
  return total
}
const check = (name: string) => {
  results.push(name)
  console.log(`PASS ${name}`)
}
const overflow = async (page: Page) =>
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    `Overflow at ${page.url()}`,
  )
const settle = async (page: Page) => {
  await page.waitForTimeout(900)
  await overflow(page)
}
const login = async (page: Page, account: typeof demoAdmin) => {
  await page.goto(fixture.base)
  await page.locator('input[type=email]').fill(account.email)
  await page.locator('input[type=password]').fill(account.password)
  await page.getByRole('button', { name: /se connecter|sign in|log in/i }).click()
  await page.getByRole('heading', { name: /Bonjour/ }).waitFor()
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'fr-FR',
    colorScheme: 'light',
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.coverage.startJSCoverage()
  await page.goto(fixture.base)
  await page.locator('input[type=email]').waitFor()
  metrics.login = await resources(page)
  metrics.loginUsedSourceBytes = await usedSourceBytes(page)
  await login(page, demoAdmin)
  await settle(page)
  assert.equal(await page.locator('html').getAttribute('lang'), 'fr')
  await page.screenshot({ path: join(out, 'home-desktop.png') })
  check('login, accueil et langue française')

  // A cold, authenticated context avoids measuring only cached navigation assets.
  const cold = await browser.newContext({
    storageState: await context.storageState(),
    locale: 'fr-FR',
    serviceWorkers: 'block',
  })
  const coldPage = await cold.newPage()
  coldPage.on('pageerror', (error) => errors.push(error.message))
  await coldPage.coverage.startJSCoverage()
  await coldPage.goto(fixture.base + '/agent/atlas')
  await coldPage.locator('textarea').first().waitFor()
  await coldPage.waitForTimeout(1200)
  metrics.chat = await resources(coldPage)
  metrics.chatUsedSourceBytes = await usedSourceBytes(coldPage)
  await cold.close()

  await page.route(/\/api\/tasks\?status=pending&/, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Demo unavailable"}' }),
  )
  await page.reload()
  const activityError = page.getByRole('alert').filter({ hasText: 'Une partie de l’activité' })
  await activityError.waitFor()
  await page.unroute(/\/api\/tasks\?status=pending&/)
  await activityError.getByRole('button', { name: 'Réessayer' }).click()
  await activityError.waitFor({ state: 'hidden' })
  check('accueil : erreur de chargement visible et reprise')

  await page.getByRole('link', { name: /Quelle priorité choisir/ }).click()
  await page.waitForURL('**/agent/atlas')
  const answer = page.getByRole('button', { name: 'Prioriser la clarté' })
  await answer.waitFor()
  await page.route(/\/api\/prompts\/.+\/respond$/, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":{"message":"Demo unavailable"}}',
    }),
  )
  const failedAnswer = page.waitForResponse(response => /\/prompts\/.+\/respond$/.test(response.url()) && response.status() === 503)
  await answer.click()
  await failedAnswer
  await answer.waitFor()
  await page.unroute(/\/api\/prompts\/.+\/respond$/)
  await answer.click()
  await answer.waitFor({ state: 'hidden' })
  await page.locator('a[href="/"]').first().click()
  await page.waitForURL(fixture.base + '/')
  await page.getByRole('link', { name: /Quelle priorité choisir/ }).waitFor({ state: 'hidden' })
  check('demande humaine depuis l’accueil, réponse et reprise après erreur')

  for (const route of [
    '/agent/atlas',
    '/tasks',
    '/automations/plans',
    '/productions/apps',
    '/files',
    '/settings/general',
    '/settings/channels',
  ]) {
    await page.goto(fixture.base + route)
    await settle(page)
    assert.equal(await page.getByText(/Page indisponible|Something went wrong/).count(), 0, route)
    await page.screenshot({ path: join(out, route.replaceAll('/', '-').slice(1) + '.png') })
  }
  check('routes directes, productions, automatisations et réglages')
  await page.goto(fixture.base + '/crons')
  await page.waitForURL('**/automations/plans')
  await page.goto(fixture.base + '/mini-apps')
  await page.waitForURL('**/productions/apps')
  await page.goto(fixture.base + '/unknown-route')
  await page.getByRole('heading', { name: 'Page indisponible' }).waitFor()
  check('anciennes URLs et page introuvable')

  await page.goto(fixture.base + '/agent/atlas')
  const composer = page.locator('textarea').first()
  await composer.waitFor()
  await composer.fill('Brouillon sauvegardé immédiatement')
  await page.evaluate(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('a')].find(
      (element) => element.getAttribute('href') === '/settings/general',
    )
    link?.click()
  })
  await page.waitForURL('**/settings/general')
  await page.goBack()
  await composer.waitFor()
  assert.equal(await composer.inputValue(), 'Brouillon sauvegardé immédiatement')
  check('brouillon conservé lors du démontage du chat')
  await composer.fill('[demo:slow] Bonjour Atlas')
  await composer.press('Enter')
  await page.getByText('[demo:slow] Bonjour Atlas', { exact: true }).first().waitFor()
  await page.locator('a[href="/settings/general"]').first().click()
  await page.waitForTimeout(5000)
  await page.goBack()
  await page
    .getByText(/Voici une réponse de démonstration/)
    .first()
    .waitFor({ timeout: 20000 })
  assert.equal(await page.getByText('[demo:slow] Bonjour Atlas', { exact: true }).count(), 1)
  check('réponse en cours pendant navigation, reprise sans doublon')
  await page.keyboard.press('Control+f')
  const search = page.getByRole('textbox', { name: 'Rechercher dans tout l’historique' })
  await search.fill('orchidée')
  const hit = page.getByRole('button', { name: /Repère historique/ })
  await hit.waitFor()
  await hit.click()
  await page.getByRole('heading', { name: 'Contexte du message' }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Fermer la recherche/ }).click()
  check('recherche au-delà des messages chargés et contexte ancien')

  const member = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'fr-FR',
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  })
  const memberPage = await member.newPage()
  memberPage.on('pageerror', (error) => errors.push(error.message))
  await login(memberPage, demoMember)
  await memberPage.goto(fixture.base + '/settings/general')
  await memberPage.locator('#settings-section').waitFor()
  assert.equal(await memberPage.locator('#settings-section option').count(), 4)
  await memberPage.goto(fixture.base + '/settings/vault')
  await memberPage.getByRole('heading', { name: 'Page indisponible' }).last().waitFor()
  const refused = await member.request.get(fixture.base + '/api/vault/entries')
  assert.equal(refused.status(), 403)
  await memberPage.goto(fixture.base + '/automations/plans')
  await settle(memberPage)
  assert.equal(await memberPage.getByRole('link', { name: 'Déclencheurs de comptes' }).count(), 0)
  await memberPage.goto(fixture.base + '/agent/atlas')
  await memberPage.locator('textarea').first().waitFor()
  assert.equal(await memberPage.locator('textarea').first().inputValue(), '')
  check('droits membre et séparation des brouillons')

  // A second browser listens to the raw stream, not just the rendered chat.
  await memberPage.evaluate(async () => {
    const state = window as unknown as { demoEvents: string[]; demoSource: EventSource }
    state.demoEvents = []
    state.demoSource = new EventSource('/api/sse')
    state.demoSource.addEventListener('message', (event) =>
      state.demoEvents.push((event as MessageEvent).data),
    )
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE connection timed out')), 10000)
      state.demoSource.addEventListener(
        'open',
        () => {
          clearTimeout(timeout)
          resolve()
        },
        { once: true },
      )
    })
  })
  await fixture.admin('POST', `/agents/${fixture.agent.id}/messages`, { content: 'Public stream control' })
  await memberPage.waitForFunction(() =>
    (window as unknown as { demoEvents: string[] }).demoEvents.some((event) =>
      event.includes('Public stream control'),
    ),
  )
  const sessionResponse = await context.request.post(
    `${fixture.base}/api/agents/${fixture.agent.id}/quick-sessions`,
    { data: {} },
  )
  assert.equal(sessionResponse.status(), 201)
  const privateSession = await sessionResponse.json()
  const upload = await context.request.post(fixture.base + '/api/files/upload', {
    multipart: {
      agentId: fixture.agent.id,
      sessionId: privateSession.id,
      file: { name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('Private demo document') },
    },
  })
  assert.equal(upload.status(), 201)
  const { file } = await upload.json()
  assert.equal((await context.request.get(fixture.base + file.url)).status(), 200)
  assert.equal((await member.request.get(fixture.base + file.url)).status(), 404)
  assert.ok(
    [403, 404].includes(
      (await member.request.get(`${fixture.base}/api/quick-sessions/${privateSession.id}`)).status(),
    ),
  )
  assert.ok(
    [403, 404].includes(
      (
        await member.request.get(
          `${fixture.base}/api/agents/${fixture.agent.id}/context-preview?sessionId=${privateSession.id}`,
        )
      ).status(),
    ),
  )
  const relink = await context.request.post(`${fixture.base}/api/agents/${fixture.agent.id}/messages`, {
    data: { content: 'Must not publish a private attachment', fileIds: [file.id] },
  })
  assert.ok(relink.status() >= 400)
  const sentPrivate = await context.request.post(
    `${fixture.base}/api/quick-sessions/${privateSession.id}/messages`,
    { data: { content: 'Private-only demonstration', fileIds: [file.id] } },
  )
  assert.equal(sentPrivate.status(), 202)
  await page.waitForTimeout(2200)
  const events = await memberPage.evaluate(() => {
    const state = window as unknown as { demoEvents: string[]; demoSource: EventSource }
    state.demoSource.close()
    return state.demoEvents.join('\n')
  })
  writeFileSync(join(out, 'private-events.json'), events)
  assert.ok(events.includes('Public stream control'))
  assert.ok(!events.includes(privateSession.id) && !events.includes('Private-only demonstration'))
  assert.ok(!events.includes('log:entry'))
  check('session privée, pièces jointes, contexte et SSE protégés côté serveur')

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 950 })
    for (const route of [
      '/',
      '/agent/atlas',
      '/settings/general',
      '/automations/plans',
      '/productions/apps',
    ]) {
      await page.goto(fixture.base + route)
      await settle(page)
    }
  }
  check('aucun débordement global à 320, 390, 768 et 1440 px')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(fixture.base)
  await settle(page)
  await page.screenshot({ path: join(out, 'home-mobile.png') })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark')
  })
  await page.reload()
  await settle(page)
  await page.screenshot({ path: join(out, 'home-dark.png') })
  await page.route('**/api/sse', route => route.abort('internetdisconnected'))
  await page.goto(fixture.base + '/agent/atlas')
  await page.getByRole('alert').filter({ hasText: /Déconnecté du serveur|Reconnexion au serveur/ }).waitFor()
  await page.locator('textarea').first().fill('Brouillon pendant la reconnexion')
  await page.unroute('**/api/sse')
  await page.getByRole('alert').filter({ hasText: 'Connecté au serveur' }).waitFor({ timeout: 20000 })
  assert.equal(await page.locator('textarea').first().inputValue(), 'Brouillon pendant la reconnexion')
  check('interruption du flux, bannière, reconnexion et brouillon conservé')
  await fixture.admin('PATCH', '/me', { language: 'en' })
  await page.goto(fixture.base)
  await page.waitForFunction(() => document.documentElement.lang === 'en')
  await settle(page)
  await page.screenshot({ path: join(out, 'home-english-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(fixture.base + '/settings/general')
  await settle(page)
  await page.screenshot({ path: join(out, 'settings-english-desktop.png') })
  check('variantes anglaises desktop et mobile')
  assert.deepEqual(errors, [])
  check('captures clair/sombre, aucune exception navigateur')
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify({ results, metrics, errors, inferenceCount: fixture.inferenceCount() }, null, 2),
  )
  for (const [route, budget] of [
    ['login', 450_000],
    ['chat', 950_000],
  ] as const) {
    const rows = metrics[route] as Resource[]
    const bytes = rows.reduce((sum, entry) => sum + entry.encoded, 0)
    assert.ok(bytes > 0 && bytes <= budget, `${route}: ${bytes} gzip bytes exceeds ${budget} budget`)
    assert.ok(
      !rows.some((entry) => /MiniAppViewer|codemirror|CodeEditor/.test(entry.name)),
      `${route}: editor loaded before opening it`,
    )
    console.log(`PASS ${route} JavaScript gzip: ${bytes} / ${budget} bytes`)
  }
} finally {
  try {
    await browser.close()
  } finally {
    await fixture.stop()
  }
}
