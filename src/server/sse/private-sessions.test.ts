import { describe, expect, it } from 'bun:test'
import { SSEManager } from './index'

function clients(manager: SSEManager) {
  const alice: string[] = []
  const bob: string[] = []
  manager.addConnection('a', { userId: 'alice', write: (data) => { alice.push(data) }, close() {} })
  manager.addConnection('b', { userId: 'bob', write: (data) => { bob.push(data) }, close() {} })
  return { alice, bob }
}

describe('private session SSE isolation', () => {
  it('sends tokens and tool results only to the owning user and never to shared taps', () => {
    const manager = new SSEManager()
    manager.setSessionOwnerResolver((id) => id === 'private' ? 'alice' : null)
    const { alice, bob } = clients(manager)
    const tapped: unknown[] = []
    manager.addTap((event) => { tapped.push(event) })
    manager.sendToAgent('agent', { type: 'chat:token', data: { sessionId: 'private', token: 'secret' } })
    manager.broadcast({ type: 'chat:tool-result', data: { sessionId: 'private', result: 'secret result' } })
    expect(alice).toHaveLength(2)
    expect(bob).toHaveLength(0)
    expect(tapped).toHaveLength(0)
  })

  it('fails closed before resolver installation, for missing sessions, and when resolver fails', () => {
    const manager = new SSEManager()
    const { alice, bob } = clients(manager)
    const event = { type: 'chat:token' as const, data: { sessionId: 'unknown', token: 'secret' } }
    manager.sendToAgent('agent', event)
    manager.setSessionOwnerResolver(() => null)
    manager.broadcast(event)
    manager.setSessionOwnerResolver(() => { throw new Error('database unavailable') })
    manager.sendToAgent('agent', event)
    expect([...alice, ...bob]).toHaveLength(0)
  })

  it('rejects an explicitly mismatched recipient while retaining shared conversation broadcasts', () => {
    const manager = new SSEManager()
    manager.setSessionOwnerResolver(() => 'alice')
    const { alice, bob } = clients(manager)
    manager.sendToUser('bob', { type: 'chat:message', data: { sessionId: 'private', content: 'secret' } })
    expect(bob).toHaveLength(0)
    manager.sendToAgent('agent', { type: 'chat:message', data: { content: 'shared' } })
    expect(alice).toHaveLength(1)
    expect(bob).toHaveLength(1)
  })
})
