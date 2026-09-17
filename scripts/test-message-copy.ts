/** Browser regression for the real chat bubble, including Radix focus changes.
 * Run: node scripts/test-message-copy.ts (Node 22.18+).
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE may select an existing sandbox-enabled browser.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { chromium } from 'playwright'

const project = fileURLToPath(new URL('..', import.meta.url))
const server = await createServer({
  configFile: false,
  root: resolve(project, 'tests/browser'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    '@/client': resolve(project, 'src/client'),
    '@/shared': resolve(project, 'src/shared'),
    '@/server': resolve(project, 'src/server'),
  } },
  server: { host: '127.0.0.1', port: Number(process.env.MESSAGE_COPY_TEST_PORT ?? 5194), strictPort: true, fs: { allow: [project] } },
})
await server.listen()
const address = server.httpServer!.address()
if (!address || typeof address === 'string') throw new Error('Missing test server port')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({ chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE })
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], locale: 'en-US' })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/message-copy.html`)
  const selection = page.locator('[data-testid="message"] strong')
  await selection.waitFor()
  const fullContent = await page.evaluate(() => (window as any).copyTestContent as string)
  async function selectWords() {
    await selection.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const current = window.getSelection()!
      current.removeAllRanges()
      current.addRange(range)
    })
  }
  async function readClipboard() { return page.evaluate(() => navigator.clipboard.readText()) }
  await selectWords()
  await page.keyboard.press('Control+c')
  assert.equal(await readClipboard(), 'selected words', 'native Ctrl+C copies only the selection')

  await selectWords()
  await selection.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click()
  assert.equal(await readClipboard(), 'selected words', 'context Copy preserves selection through menu focus')

  await selectWords()
  await selection.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /quote/i }).click()
  assert.equal(await page.evaluate(() => (window as any).copyTestQuotes.at(-1)), '> selected words\n\n', 'quote uses selected text')

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await selection.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy message', exact: true }).click()
  assert.equal(await readClipboard(), fullContent, 'context Copy without selection keeps full markdown')

  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await selection.click({ button: 'right' })
  await page.getByRole('menuitem', { name: /quote/i }).click()
  assert.equal(await page.evaluate(() => (window as any).copyTestQuotes.at(-1)), '> Alpha **selected words** omega.\n> Second paragraph.\n> Third paragraph.\n> ...\n\n', 'quote without selection keeps the three-line preview')
  assert.deepEqual(errors, [], 'browser has no runtime errors')
  console.log('PASS: native copy, context copy, selected quote, full copy and full quote on MessageBubble')
} finally {
  await browser.close()
  await server.close()
}
