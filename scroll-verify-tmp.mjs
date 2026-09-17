import { chromium } from 'playwright'

const BASE = 'http://localhost:4178'
const AGENT_ID = 'bf045bad-91b1-435d-9b8f-1626c8b3e9a4'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await ctx.newPage()

await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
if (await page.locator('input[type="password"]').count()) {
  await page.fill('input[type="email"]', 'admin@local.test')
  await page.fill('input[type="password"]', 'Password123!')
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/auth/sign-in') && r.status() < 400, { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ])
  await page.waitForTimeout(3000)
}

// Open the Tester conversation
if ((await page.locator('[data-message-id]').count()) === 0) {
  await page.locator('text=Tester').first().click()
}
await page.waitForSelector('[data-message-id]', { timeout: 15000 })
await page.waitForTimeout(1500)

const vp = () => page.evaluate(() => {
  const viewports = document.querySelectorAll('[data-slot="scroll-area-viewport"]')
  for (const v of viewports) {
    if (v.querySelector('[data-message-id]')) {
      return { scrollTop: v.scrollTop, scrollHeight: v.scrollHeight, clientHeight: v.clientHeight }
    }
  }
  return null
})
const setScroll = (top) => page.evaluate((t) => {
  const viewports = document.querySelectorAll('[data-slot="scroll-area-viewport"]')
  for (const v of viewports) {
    if (v.querySelector('[data-message-id]')) { v.scrollTop = t; return }
  }
}, top)
const msgCount = () => page.locator('[data-message-id]').count()

// 1. Initial load lands at bottom
{
  const s = await vp()
  const dist = s.scrollHeight - s.scrollTop - s.clientHeight
  check('initial load at bottom', dist < 50, `dist=${dist}`)
}

// 2. Pagination: scroll to top until all 160 messages load; no jump-to-bottom
{
  let count = await msgCount()
  const initial = count
  let stalls = 0
  for (let i = 0; i < 15 && stalls < 3; i++) {
    await setScroll(0)
    await page.waitForTimeout(1000)
    const next = await msgCount()
    if (next === count) stalls++
    else stalls = 0
    count = next
    const s = await vp()
    const dist = s.scrollHeight - s.scrollTop - s.clientHeight
    if (dist < 100 && count < 160) {
      check('no jump-to-bottom during pagination', false, `iter=${i} dist=${dist}`)
      break
    }
  }
  check('pagination loads full history', count >= 160, `initial=${initial} final=${count}`)
}

// 3. Scroll up mid-history, send a message via the composer path (API + optimistic).
//    While streaming, the viewport must NOT be yanked back down after we scroll up.
{
  // Send from the UI input so the optimistic append + scrollToBottom path runs
  await page.fill('textarea', 'Écris un paragraphe de 150 mots sur les abeilles.')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
  // Sending must have brought us to the bottom
  const afterSend = await vp()
  const distSend = afterSend.scrollHeight - afterSend.scrollTop - afterSend.clientHeight
  check('send scrolls to bottom', distSend < 120, `dist=${distSend}`)

  // Now scroll up into history while the agent streams
  await setScroll(400)
  await page.waitForTimeout(300)
  let yanked = false
  let grew = false
  let prevHeight = (await vp()).scrollHeight
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(700)
    const s = await vp()
    if (s.scrollHeight > prevHeight) grew = true
    prevHeight = s.scrollHeight
    const dist = s.scrollHeight - s.scrollTop - s.clientHeight
    if (dist < 200) { yanked = true; break }
  }
  check('content streamed while scrolled up', grew, grew ? 'scrollHeight grew' : 'no growth observed')
  check('no yank to bottom during streaming', !yanked)

  // Wait for the turn to fully finish (chat:done triggers fetchMessages)
  await page.waitForTimeout(12000)
  const finalCount = await msgCount()
  check('paginated history preserved after chat:done refetch', finalCount >= 160, `count=${finalCount}`)
  const s = await vp()
  const dist = s.scrollHeight - s.scrollTop - s.clientHeight
  check('scroll position stable after refetch', dist > 200, `dist=${dist}`)
}

await page.screenshot({ path: '/tmp/hk-cronui/chat-scrolled-up.png' })
await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECKS FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
