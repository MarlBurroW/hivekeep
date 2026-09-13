/**
 * Chat message copy helpers.
 *
 * The context-menu "Copy" action used to always write the full message
 * `content` to the clipboard. Native Ctrl/Cmd+C can also pick up extra
 * bubble chrome (sender, timestamp, action labels) because the Radix
 * ContextMenu trigger wraps the whole row. These helpers resolve "what
 * the user actually highlighted" vs "the whole message".
 */

/** Minimal selection shape so unit tests do not need a real DOM Selection. */
export interface SelectionLike {
  isCollapsed: boolean
  rangeCount: number
  toString(): string
  getRangeAt(index: number): {
    collapsed: boolean
    intersectsNode(node: Node): boolean
  }
}

/** ClipboardData subset used when intercepting the native `copy` event. */
export interface ClipboardDataLike {
  setData(format: string, data: string): void
}

/**
 * Read highlighted text from a Selection. Collapsed / empty selections
 * return '' so callers can fall back to the full message.
 */
export function readSelectionText(selection: SelectionLike | null | undefined): string {
  if (!selection || selection.isCollapsed) return ''
  return selection.toString()
}

/** True when the current selection overlaps `node` (this message's DOM). */
export function selectionIntersectsNode(
  selection: SelectionLike | null | undefined,
  node: Node | null | undefined,
): boolean {
  if (!selection || !node || selection.isCollapsed || selection.rangeCount === 0) return false
  try {
    const range = selection.getRangeAt(0)
    if (range.collapsed) return false
    return range.intersectsNode(node)
  } catch {
    return false
  }
}

/**
 * Selected text that belongs to `node`. Empty when there is no highlight
 * or the highlight is entirely outside this message.
 */
export function getSelectedTextInNode(
  node: Node | null | undefined,
  selection: SelectionLike | null | undefined = globalThis.window?.getSelection?.() ?? null,
): string {
  if (!selectionIntersectsNode(selection, node)) return ''
  return readSelectionText(selection)
}

/** Prefer the live selection; otherwise copy the full message markdown. */
export function resolveMessageCopyText(fullContent: string, selectedText: string): string {
  return selectedText.length > 0 ? selectedText : fullContent
}

/**
 * Write only the highlighted text onto a `copy` event. Returns true when
 * the caller should `preventDefault()` so the browser does not also
 * serialize the whole bubble as HTML/plain text.
 */
export function writeSelectedTextToClipboard(
  clipboardData: ClipboardDataLike | null | undefined,
  selectedText: string,
): boolean {
  if (!clipboardData || selectedText.length === 0) return false
  clipboardData.setData('text/plain', selectedText)
  return true
}
