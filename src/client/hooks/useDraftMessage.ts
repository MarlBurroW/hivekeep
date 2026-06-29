import { useState, useEffect, useCallback, useRef } from 'react'

const DRAFT_PREFIX = 'gezy:draft:'
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const SAVE_DEBOUNCE_MS = 300

/** Read a draft from localStorage */
function loadDraft(agentId: string): string {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + agentId)
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { text: string; ts: number }
    if (Date.now() - parsed.ts > DRAFT_MAX_AGE_MS) {
      localStorage.removeItem(DRAFT_PREFIX + agentId)
      return ''
    }
    return parsed.text
  } catch {
    return ''
  }
}

/** Save a draft to localStorage (with timestamp for expiry) */
function saveDraft(agentId: string, text: string) {
  try {
    if (!text) {
      localStorage.removeItem(DRAFT_PREFIX + agentId)
    } else {
      localStorage.setItem(DRAFT_PREFIX + agentId, JSON.stringify({ text, ts: Date.now() }))
    }
  } catch {
    // Storage full or unavailable
  }
}

/** Clean up drafts older than 7 days */
function cleanupOldDrafts() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(DRAFT_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw) as { ts: number }
        if (Date.now() - parsed.ts > DRAFT_MAX_AGE_MS) {
          localStorage.removeItem(key)
        }
      } catch {
        localStorage.removeItem(key)
      }
    }
  } catch {
    // Ignore
  }
}

// Run cleanup once on module load
cleanupOldDrafts()

/**
 * Append text to an agent's persisted draft from OUTSIDE the composer (e.g.
 * the Files tree "Insert in chat" action, files.md § 5.3). Writing the draft
 * BEFORE navigating avoids any mount race: MessageInput picks it up naturally
 * when the conversation opens.
 */
export function appendToDraft(agentId: string, text: string) {
  const current = loadDraft(agentId)
  const glue = current && !current.endsWith(' ') ? ' ' : ''
  saveDraft(agentId, `${current}${glue}${text} `)
}

/**
 * Persists draft message content per Agent across component unmounts
 * and page reloads via localStorage.
 */
export function useDraftMessage(agentId: string | null) {
  const [content, setContentState] = useState(() =>
    agentId ? loadDraft(agentId) : '',
  )
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync from storage when agentId changes
  useEffect(() => {
    setContentState(agentId ? loadDraft(agentId) : '')
  }, [agentId])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const setContent = useCallback(
    (value: string) => {
      setContentState(value)
      if (agentId) {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => saveDraft(agentId, value), SAVE_DEBOUNCE_MS)
      }
    },
    [agentId],
  )

  const clearDraft = useCallback(() => {
    if (agentId) {
      saveDraft(agentId, '')
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    setContentState('')
  }, [agentId])

  return { content, setContent, clearDraft }
}
