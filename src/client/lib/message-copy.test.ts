import { describe, expect, it } from 'bun:test'
import {
  getSelectedTextInNode,
  readSelectionText,
  resolveMessageCopyText,
  selectionIntersectsNode,
  writeSelectedTextToClipboard,
  type SelectionLike,
} from './message-copy'

function mockSelection(opts: {
  text: string
  collapsed?: boolean
  rangeCount?: number
  intersects?: boolean
}): SelectionLike {
  const collapsed = opts.collapsed ?? opts.text.length === 0
  return {
    isCollapsed: collapsed,
    rangeCount: opts.rangeCount ?? (collapsed ? 0 : 1),
    toString: () => opts.text,
    getRangeAt: () => ({
      collapsed,
      intersectsNode: () => opts.intersects ?? true,
    }),
  }
}

const node = {} as Node

describe('readSelectionText', () => {
  it('returns empty for a missing or collapsed selection', () => {
    expect(readSelectionText(null)).toBe('')
    expect(readSelectionText(undefined)).toBe('')
    expect(readSelectionText(mockSelection({ text: 'hello', collapsed: true }))).toBe('')
  })

  it('returns the highlighted text', () => {
    expect(readSelectionText(mockSelection({ text: 'just this' }))).toBe('just this')
  })
})

describe('resolveMessageCopyText', () => {
  const full = 'The entire message body, including more than the user selected.'

  it('copies only the selection when the user highlighted a portion', () => {
    expect(resolveMessageCopyText(full, 'a portion')).toBe('a portion')
  })

  it('falls back to the full message when nothing is selected', () => {
    expect(resolveMessageCopyText(full, '')).toBe(full)
  })
})

describe('selectionIntersectsNode', () => {
  it('is false when there is no selection, no node, or a collapsed range', () => {
    expect(selectionIntersectsNode(null, node)).toBe(false)
    expect(selectionIntersectsNode(mockSelection({ text: 'x' }), null)).toBe(false)
    expect(selectionIntersectsNode(mockSelection({ text: 'x', collapsed: true }), node)).toBe(false)
  })

  it('is true only when the range overlaps this message', () => {
    expect(selectionIntersectsNode(mockSelection({ text: 'x', intersects: true }), node)).toBe(true)
    expect(selectionIntersectsNode(mockSelection({ text: 'x', intersects: false }), node)).toBe(false)
  })
})

describe('getSelectedTextInNode', () => {
  it('returns the highlight when it intersects this message', () => {
    expect(getSelectedTextInNode(node, mockSelection({ text: 'portion', intersects: true }))).toBe('portion')
  })

  it('returns empty when the highlight is in another message', () => {
    expect(getSelectedTextInNode(node, mockSelection({ text: 'elsewhere', intersects: false }))).toBe('')
  })
})

describe('writeSelectedTextToClipboard', () => {
  it('writes text/plain and reports that default copy should be cancelled', () => {
    const writes: Array<[string, string]> = []
    const ok = writeSelectedTextToClipboard(
      { setData: (format, data) => writes.push([format, data]) },
      'only this',
    )
    expect(ok).toBe(true)
    expect(writes).toEqual([['text/plain', 'only this']])
  })

  it('does not touch the clipboard when there is no selection', () => {
    const writes: Array<[string, string]> = []
    expect(writeSelectedTextToClipboard({ setData: (format, data) => writes.push([format, data]) }, '')).toBe(false)
    expect(writeSelectedTextToClipboard(null, 'x')).toBe(false)
    expect(writes).toEqual([])
  })
})
