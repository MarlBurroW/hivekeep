/**
 * Lightweight markdown-to-plaintext stripper for inline previews (task
 * headers, list rows, tooltips). We deliberately do NOT render markdown in those
 * spots, but raw formatting characters (`#`, `**`, backticks, link syntax) look
 * ugly. This collapses a markdown string into a single readable line of plain
 * text without pulling in a full markdown parser.
 *
 * Scope is intentionally pragmatic, not a spec-complete parser:
 * - headings, blockquotes and list markers are dropped (line-leading)
 * - emphasis/strong/strikethrough/inline-code markers are unwrapped
 * - links `[text](url)` and images `![alt](url)` keep their visible text
 * - fenced/indented code fences are removed (content kept, sans backticks)
 * - all whitespace (including newlines) collapses to single spaces
 */
export function stripMarkdown(input: string | null | undefined): string {
  if (!input) return ''
  let text = input

  // Remove fenced code block delimiters (```lang ... ```) but keep inner text.
  text = text.replace(/```[^\n]*\n?/g, ' ').replace(/```/g, ' ')

  // Images: ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Links: [text](url) -> text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Reference-style links: [text][ref] -> text
  text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')

  // Inline code: `code` -> code
  text = text.replace(/`([^`]*)`/g, '$1')

  // Strong/emphasis: **x**, __x__, *x*, _x_ -> x
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')
  // Strikethrough: ~~x~~ -> x
  text = text.replace(/~~(.*?)~~/g, '$1')

  // Line-leading markers: headings (#), blockquotes (>), list bullets, ordered
  // list numbers. Applied per logical line.
  text = text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '') // headings
        .replace(/^\s{0,3}>\s?/, '') // blockquote
        .replace(/^\s{0,3}[-*+]\s+/, '') // unordered list
        .replace(/^\s{0,3}\d+\.\s+/, '') // ordered list
        .replace(/^\s{0,3}([-*_]\s?){3,}\s*$/, ''), // horizontal rule
    )
    .join('\n')

  // Collapse all whitespace to single spaces and trim.
  text = text.replace(/\s+/g, ' ').trim()

  return text
}
