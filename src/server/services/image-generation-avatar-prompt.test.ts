import { beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the fake prompt writer and provider registry out of other test files.
// No credentials, database or network calls are needed for this regression.
const fixture = `
  import { mock } from 'bun:test'
  const noop = () => {}
  let text = ''
  let available = true
  let usageCalls = 0
  globalThis.fetch = async () => { throw new Error('Unexpected network request') }
  mock.module('@/server/db/index', () => ({ db: {} }))
  mock.module('@/server/db/schema', () => ({ providers: {} }))
  mock.module('@/server/logger', () => ({ createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }) }))
  mock.module('@/server/config', () => ({ config: { upload: { dir: process.env.HIVEKEEP_DATA_DIR } } }))
  mock.module('@/server/services/provider-config', () => ({ loadProviderConfig: noop }))
  mock.module('@/server/providers/index', () => ({ listModelsForProvider: noop, lookupImageModel: noop }))
  mock.module('@/server/llm/image/registry', () => ({ getImageProvider: noop }))
  mock.module('@/server/services/app-settings', () => ({
    getDefaultImageModel: noop, getDefaultImageProviderId: noop,
    getAvatarStylePrompt: async () => 'watercolor', getAvatarSubject: async () => 'a fox',
  }))
  mock.module('@/server/services/token-usage', () => ({ recordUsage: () => { usageCalls++ } }))
  mock.module('@/server/llm/core/resolve', () => ({
    pickAnyLLMModel: async () => available ? { providerRow: { id: 'test', type: 'test' }, model: { id: 'test' } } : null,
  }))
  mock.module('@/server/llm/core/run-oneshot', () => ({ runOneShot: async () => ({ text, usage: {} }) }))
  const { buildAvatarPrompt } = await import('./src/server/services/image-generation')
  const agent = { name: 'Ada', role: 'Teacher', character: 'Kind', expertise: 'astronomy' }
  const empty = await buildAvatarPrompt(agent)
  text = '   \\n\\t'
  const whitespace = await buildAvatarPrompt(agent)
  text = ''
  const edit = await buildAvatarPrompt(agent, 'edit', { style: 'ink drawing' })
  text = '  A carefully composed portrait.  '
  const normal = await buildAvatarPrompt(agent)
  available = false
  const noModel = await buildAvatarPrompt(agent)
  console.log(JSON.stringify({ empty, whitespace, edit, normal, noModel, usageCalls }))
`

describe('buildAvatarPrompt', () => {
  let result: { empty: string; whitespace: string; edit: string; normal: string; noModel: string; usageCalls: number }

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'hivekeep-avatar-prompt-'))
    try {
      const proc = Bun.spawn([process.execPath, '--no-env-file', '-e', fixture], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? '', HOME: dataDir, DB_PATH: ':memory:', HIVEKEEP_DATA_DIR: dataDir },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ])
      if (code !== 0) throw new Error(`Avatar prompt fixture failed (${code}): ${stderr}`)
      result = JSON.parse(stdout.trim())
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('uses the metadata fallback for empty and whitespace-only writer responses', () => {
    expect(result.empty).toBe(result.noModel)
    expect(result.whitespace).toBe(result.noModel)
    expect(result.empty).toContain('astronomy')
    expect(result.empty).toContain('a fox')
    expect(result.empty).toContain('watercolor')
  })

  it('keeps edit instructions and the requested style in the fallback', () => {
    expect(result.edit).toContain('Reframe this base robot')
    expect(result.edit).toContain('astronomy')
    expect(result.edit).toContain('ink drawing')
  })

  it('preserves successful prompts and records usage even when the writer returns no text', () => {
    expect(result.normal).toBe('A carefully composed portrait.')
    expect(result.usageCalls).toBe(4)
  })
})
