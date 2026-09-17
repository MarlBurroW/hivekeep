import { describe, expect, it } from 'bun:test'
import { join } from 'path'

async function terminateFixture(mode: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'shutdown.fixture.ts'), mode], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ''
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
  try {
    while (!output.includes('READY\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('Fixture exited before readiness')
      output += decoder.decode(chunk.value)
    }
    const started = Date.now()
    child.kill('SIGTERM')
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value)
    }
    const code = await child.exited
    const result = JSON.parse(output.split('\n').find((line) => line.startsWith('{')) ?? '{}')
    return { code, result, elapsed: Date.now() - started }
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
}

describe('bounded SIGTERM shutdown', () => {
  it('stops admission/producers, lets work commit, then closes resources once', async () => {
    const { code, result } = await terminateFixture('drain')
    expect(code).toBe(0)
    expect(result).toEqual({
      drained: true, cleaned: true, samePromise: true,
      events: ['admission', 'producers', 'committed', 'resources'],
    })
  })

  it('aborts unfinished work after the grace period', async () => {
    const { code, result, elapsed } = await terminateFixture('abort')
    expect(code).toBe(0)
    expect(result.drained).toBe(false)
    expect(result.events).toEqual(['admission', 'producers', 'abort', 'resources'])
    expect(elapsed).toBeLessThan(1500)
  })

  it('bounds cleanup even when a resource never settles', async () => {
    const { code, result, elapsed } = await terminateFixture('hung-cleanup')
    expect(code).toBe(1)
    expect(result.cleaned).toBe(false)
    expect(elapsed).toBeLessThan(1500)
  })
})
