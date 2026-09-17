import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '@/client/hooks/useAuth'
import { draftKey, loadDraft, saveDraft } from '@/client/lib/draft-storage'

/** External actions write into the signed-in user's draft before navigation. */
export function appendToDraft(agentId: string, text: string, userId: string | undefined) {
  const key = draftKey(userId, agentId)
  if (!key) return
  const current = loadDraft(key)
  saveDraft(key, `${current}${current && !current.endsWith(' ') ? ' ' : ''}${text} `)
  window.dispatchEvent(new CustomEvent('hivekeep:draft-appended', { detail: key }))
}

/** Drafts are private to an account and conversation, including private sessions. */
export function useDraftMessage(conversationId: string | null) {
  const { user } = useAuth()
  const key = draftKey(user?.id, conversationId)
  const [draft, setDraft] = useState(() => ({ key, content: key ? loadDraft(key) : '' }))
  const pending = useRef<{ key: string; content: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (pending.current) saveDraft(pending.current.key, pending.current.content)
    pending.current = null
  }, [])

  useEffect(() => {
    flush()
    setDraft({ key, content: key ? loadDraft(key) : '' })
    // Route changes and unmount flush even a keystroke entered <300 ms ago.
    return flush
  }, [key, flush])

  useEffect(() => {
    const onAppend = (event: Event) => {
      if ((event as CustomEvent).detail === key && key) setDraft({ key, content: loadDraft(key) })
    }
    window.addEventListener('hivekeep:draft-appended', onAppend)
    return () => window.removeEventListener('hivekeep:draft-appended', onAppend)
  }, [key])

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [flush])

  const setContent = useCallback((content: string) => {
    setDraft({ key, content })
    if (!key) return
    if (pending.current?.key !== key) flush()
    if (timer.current) clearTimeout(timer.current)
    pending.current = { key, content }
    timer.current = setTimeout(flush, 300)
  }, [key, flush])

  const clearDraft = useCallback(() => {
    flush()
    if (key) saveDraft(key, '')
    setDraft({ key, content: '' })
  }, [key, flush])

  // Never render the previous account/conversation while the effect is pending.
  return { content: draft.key === key ? draft.content : (key ? loadDraft(key) : ''), setContent, clearDraft }
}
