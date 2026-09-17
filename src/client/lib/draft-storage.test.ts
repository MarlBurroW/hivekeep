import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { draftKey, loadDraft, saveDraft } from './draft-storage'

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
beforeEach(() => {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  } })
})
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('account-scoped drafts', () => {
  it('does not disclose another account or private session draft', () => {
    const key = draftKey('alice', 'agent')!
    saveDraft(key, 'private input')
    expect(loadDraft(draftKey('bob', 'agent')!)).toBe('')
    expect(loadDraft(draftKey('alice', 'quick-session')!)).toBe('')
    expect(loadDraft(key)).toBe('private input')
    expect(draftKey(undefined, 'agent')).toBeNull()
  })
  it('cannot assign unscoped legacy drafts to an arbitrary signed-in account', () => {
    localStorage.setItem('hivekeep:draft:agent', JSON.stringify({ text: 'old secret', ts: Date.now() }))
    expect(loadDraft(draftKey('bob', 'agent')!)).toBe('')
  })
  it('drops expired or malformed drafts and removes sent drafts', () => {
    const key = draftKey('alice', 'agent')!
    localStorage.setItem(key, JSON.stringify({ text: 'expired', ts: Date.now() - 8 * 86400000 }))
    expect(loadDraft(key)).toBe('')
    expect(localStorage.getItem(key)).toBeNull()
    localStorage.setItem(key, JSON.stringify({ text: 12, ts: Date.now() }))
    expect(loadDraft(key)).toBe('')
    saveDraft(key, 'ready')
    saveDraft(key, '')
    expect(loadDraft(key)).toBe('')
  })
})
