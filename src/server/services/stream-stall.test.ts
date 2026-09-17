import { describe, it, expect } from 'bun:test'
import { withStallTimeout, StreamStallError } from '@/server/services/stream-runner'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('withStallTimeout', () => {
  it('passes every chunk through when the source keeps emitting', async () => {
    async function* src() {
      yield 'a'
      await sleep(5)
      yield 'b'
      await sleep(5)
      yield 'c'
    }
    expect(await collect(withStallTimeout(src(), 100))).toEqual(['a', 'b', 'c'])
  })

  it('does not cut a slow but alive stream (the timer resets per chunk)', async () => {
    // Total duration (120ms) far exceeds the idle budget (50ms); no single gap
    // does. A total-duration timeout would wrongly kill this stream.
    async function* src() {
      for (let i = 0; i < 6; i++) {
        await sleep(20)
        yield i
      }
    }
    expect(await collect(withStallTimeout(src(), 50))).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('throws StreamStallError when the source goes quiet', async () => {
    async function* src() {
      yield 'first'
      await new Promise(() => {}) // never emits again
    }
    await expect(collect(withStallTimeout(src(), 25))).rejects.toThrow(StreamStallError)
  })

  it('yields what arrived before the stall', async () => {
    async function* src() {
      yield 'kept'
      await new Promise(() => {})
    }
    const seen: string[] = []
    try {
      for await (const v of withStallTimeout(src(), 25)) seen.push(v)
    } catch { /* expected */ }
    expect(seen).toEqual(['kept'])
  })

  it('fires onStall once so the caller can abort the provider connection', async () => {
    let stalls = 0
    async function* src() {
      yield 1
      await new Promise(() => {})
    }
    try {
      await collect(withStallTimeout(src(), 25, () => { stalls++ }))
    } catch { /* expected */ }
    await sleep(60)
    expect(stalls).toBe(1)
  })

  it('reports the idle budget in the error message', async () => {
    async function* src() {
      await new Promise(() => {})
      yield 'never'
    }
    await expect(collect(withStallTimeout(src(), 2000))).rejects.toThrow('stopped sending data for 2s')
  })

  it('is a passthrough when the budget is disabled', async () => {
    async function* src() {
      await sleep(30)
      yield 'slow'
    }
    expect(await collect(withStallTimeout(src(), 0))).toEqual(['slow'])
  })

  it('closes the source iterator when the consumer stops early', async () => {
    let closed = false
    const src: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          next: async () => ({ value: i++, done: false }),
          return: async () => { closed = true; return { value: undefined, done: true as const } },
        }
      },
    }
    for await (const v of withStallTimeout(src, 100)) {
      if (v >= 1) break
    }
    await sleep(10)
    expect(closed).toBe(true)
  })

  it('propagates a source error unchanged', async () => {
    async function* src(): AsyncGenerator<string> {
      yield 'a'
      throw new Error('provider 500')
    }
    await expect(collect(withStallTimeout(src(), 100))).rejects.toThrow('provider 500')
  })
})
