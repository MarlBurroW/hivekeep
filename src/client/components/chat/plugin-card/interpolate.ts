/**
 * Interpolate `{{key}}` and `{{key.subkey}}` placeholders inside a value
 * tree (the card layout) against a state object.
 *
 * Two replacement modes:
 *  - A string equal to exactly `{{key}}` is replaced by `state[key]` raw,
 *    preserving its type (number, array, object, etc.).
 *  - A string containing embedded `{{...}}` placeholders gets template
 *    expansion: each placeholder is rendered with `String(value)` and
 *    concatenated. Unresolved placeholders fall back to an empty string.
 *
 * Objects and arrays are walked recursively. Anything else is returned
 * as-is so the renderer downstream can narrow types.
 */

const FULL_PLACEHOLDER = /^\{\{\s*([\w.]+)\s*\}\}$/
const EMBEDDED_PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g

function readPath(state: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = state
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    if (typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

export function interpolate(value: unknown, state: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const fullMatch = value.match(FULL_PLACEHOLDER)
    if (fullMatch && fullMatch[1]) {
      const resolved = readPath(state, fullMatch[1])
      return resolved === undefined ? value : resolved
    }
    if (value.includes('{{')) {
      return value.replace(EMBEDDED_PLACEHOLDER, (_match: string, path: string) => {
        const resolved = readPath(state, path)
        return resolved === undefined || resolved === null ? '' : String(resolved)
      })
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, state))
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(v, state)
    }
    return out
  }

  return value
}
