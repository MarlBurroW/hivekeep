import { describe, it, expect } from 'bun:test'
import { orderTriggersForDispatch } from '@/server/services/email-trigger-poller'

// Pure dispatch-ordering logic: which trigger gets the single wake-up slot when
// several match the same email. No DB / provider mocks needed.
const t = (id: string, disableAfterFire = false) => ({ id, disableAfterFire })

describe('orderTriggersForDispatch', () => {
  it('puts the one-shot reply-watch ahead of a standing trigger', () => {
    const ordered = orderTriggersForDispatch([t('standing'), t('watch', true)])
    expect(ordered.map((x) => x.id)).toEqual(['watch', 'standing'])
  })

  it('keeps the one-shot first when it already came first', () => {
    const ordered = orderTriggersForDispatch([t('watch', true), t('standing')])
    expect(ordered.map((x) => x.id)).toEqual(['watch', 'standing'])
  })

  it('preserves relative order among triggers of the same kind', () => {
    const ordered = orderTriggersForDispatch([t('a'), t('b'), t('watch', true), t('c')])
    expect(ordered.map((x) => x.id)).toEqual(['watch', 'a', 'b', 'c'])
  })

  it('does not mutate the caller array', () => {
    const input = [t('standing'), t('watch', true)]
    orderTriggersForDispatch(input)
    expect(input.map((x) => x.id)).toEqual(['standing', 'watch'])
  })
})
