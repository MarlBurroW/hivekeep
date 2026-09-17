const PREFIX = 'hivekeep:draft:v2:'
const MAX_AGE = 7 * 24 * 60 * 60 * 1000

export function draftKey(userId: string | undefined, conversationId: string | null): string | null {
  return userId && conversationId ? `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(conversationId)}` : null
}

export function loadDraft(key: string): string {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return ''
    const value = JSON.parse(raw)
    if (typeof value.text !== 'string' || !Number.isFinite(value.ts) || Date.now() - value.ts > MAX_AGE) {
      localStorage.removeItem(key)
      return ''
    }
    return value.text
  } catch { return '' }
}

export function saveDraft(key: string, text: string): void {
  try {
    if (text) localStorage.setItem(key, JSON.stringify({ text, ts: Date.now() }))
    else localStorage.removeItem(key)
  } catch { /* A blocked/full browser store must not prevent composing. */ }
}
