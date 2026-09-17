import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import { X, ChevronUp, ChevronDown, Search } from 'lucide-react'
import { api, getErrorMessage } from '@/client/lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/client/components/ui/dialog'
import { cn } from '@/client/lib/utils'

interface ConversationSearchProps {
  onClose: () => void
  onSearchChange: (query: string, matchIndex: number, matchCount: number) => void
  messages: Array<{ id: string; content: string }>
  hasMore?: boolean
  agentId?: string
}

const LocalConversationSearch = React.memo(function LocalConversationSearch({ onClose, onSearchChange, messages, hasMore }: ConversationSearchProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [currentIndex, setCurrentIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Compute matches. Some messages legitimately have null content (e.g.
  // channel-transfer audit-trail system rows). Treat them as empty so the
  // search filter just skips them instead of crashing.
  const matches = query.trim().length >= 2
    ? messages
        .map((msg, i) => ({ msgIndex: i, msgId: msg.id }))
        .filter(({ msgIndex }) =>
          (messages[msgIndex]!.content ?? '').toLowerCase().includes(query.toLowerCase()),
        )
    : []

  const matchCount = matches.length

  // Notify parent of search state changes
  useEffect(() => {
    onSearchChange(query, currentIndex, matchCount)
  }, [query, currentIndex, matchCount, onSearchChange])

  // Reset index when query or matches change
  useEffect(() => {
    setCurrentIndex(0)
  }, [query])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keyboard navigation (handled via onKeyDown on the input element)
  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onClose()
    } else if (e.key === 'Enter' && matchCount > 0) {
      e.preventDefault()
      if (e.shiftKey) {
        setCurrentIndex((prev) => (prev - 1 + matchCount) % matchCount)
      } else {
        setCurrentIndex((prev) => (prev + 1) % matchCount)
      }
    }
  }, [matchCount, onClose])

  // Scroll to current match
  useEffect(() => {
    if (matchCount === 0 || !matches[currentIndex]) return
    const msgId = matches[currentIndex].msgId
    // Find the message element in the DOM and scroll to it
    const el = document.querySelector(`[data-message-id="${msgId}"]`)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [currentIndex, matchCount, matches])

  const goUp = useCallback(() => {
    if (matchCount > 0) setCurrentIndex((prev) => (prev - 1 + matchCount) % matchCount)
  }, [matchCount])

  const goDown = useCallback(() => {
    if (matchCount > 0) setCurrentIndex((prev) => (prev + 1) % matchCount)
  }, [matchCount])

  return (
    <div className="flex items-center gap-2 border-b bg-background px-4 py-2 animate-fade-in">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleInputKeyDown}
        placeholder={t('chat.search.placeholder')}
        className="h-7 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
      />
      {query.trim().length >= 2 && (
        <span className={cn(
          'shrink-0 text-xs tabular-nums',
          matchCount === 0 ? 'text-destructive' : 'text-muted-foreground',
        )}>
          {matchCount === 0
            ? t('chat.search.noResults')
            : t('chat.search.results', { current: currentIndex + 1, total: matchCount })}
        </span>
      )}
      {hasMore && query.trim().length >= 2 && (
        <span className="shrink-0 text-xs text-muted-foreground/70 italic">
          {t('chat.search.partialScope', { count: messages.length })}
        </span>
      )}
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={goUp}
          disabled={matchCount === 0}
          className="size-6"
          title={t('chat.search.previous')}
        >
          <ChevronUp className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={goDown}
          disabled={matchCount === 0}
          className="size-6"
          title={t('chat.search.next')}
        >
          <ChevronDown className="size-3.5" />
        </Button>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        className="size-6"
        title={t('chat.search.close')}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
})


interface HistoryResult { id: string; role: string; content: string; createdAt: number }
export function ConversationSearch(props: ConversationSearchProps) {
  return props.agentId ? <HistorySearch {...props} agentId={props.agentId} /> : <LocalConversationSearch {...props} />
}

function HistorySearch({ agentId, onClose, onSearchChange }: ConversationSearchProps & { agentId: string }) {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; messages: HistoryResult[]; total: number; hasMore: boolean }>({ query: '', messages: [], total: 0, hasMore: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ id: string; messages: HistoryResult[] } | null>(null)
  const requestId = useRef(0)
  const contextRequestId = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const term = query.trim()
  const fetchResults = useCallback(async (q: string, offset: number, request: number) => {
    setBusy(true)
    setError(null)
    try {
      const data = await api.get<{ messages: HistoryResult[]; total: number; hasMore: boolean }>(`/agents/${agentId}/messages/search?q=${encodeURIComponent(q)}&offset=${offset}`)
      if (request !== requestId.current) return
      setResult(previous => ({ ...data, query: q, messages: offset ? [...previous.messages, ...data.messages] : data.messages }))
    } catch (err) { if (request === requestId.current) setError(getErrorMessage(err)) }
    finally { if (request === requestId.current) setBusy(false) }
  }, [agentId])
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const request = ++requestId.current
    setResult({ query: term, messages: [], total: 0, hasMore: false })
    setError(null)
    setBusy(term.length >= 2)
    if (term.length < 2) return
    const timeout = setTimeout(() => { void fetchResults(term, 0, request) }, 250)
    return () => { clearTimeout(timeout); requestId.current++ }
  }, [term, fetchResults])
  useEffect(() => { onSearchChange(term, 0, result.query === term ? result.total : 0) }, [term, result.query, result.total, onSearchChange])
  const openResult = async (row: HistoryResult) => {
    const element = document.querySelector(`[data-message-id="${CSS.escape(row.id)}"]`)
    if (element) { element.scrollIntoView({ behavior: 'smooth', block: 'center' }); return }
    const request = ++contextRequestId.current
    setSelection({ id: row.id, messages: [row] })
    try {
      const data = await api.get<{ messages: HistoryResult[] }>(`/agents/${agentId}/messages/context/${encodeURIComponent(row.id)}`)
      if (request === contextRequestId.current) setSelection({ id: row.id, messages: data.messages })
    } catch (err) { if (request === contextRequestId.current) setError(getErrorMessage(err)) }
  }
  return <section className="shrink-0 border-b bg-background" aria-label={t('chat.search.history')}>
    <div className="flex items-center gap-2 px-3 py-2"><Search className="size-4 shrink-0 text-muted-foreground" /><Input ref={inputRef} aria-label={t('chat.search.history')} value={query} maxLength={200} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') onClose() }} placeholder={t('chat.search.history')} className="min-w-0 flex-1" /><Button variant="ghost" size="icon" onClick={onClose} aria-label={t('chat.search.close')}><X className="size-4" /></Button></div>
    {term.length >= 2 && <div className="max-h-60 overflow-y-auto border-t px-3 py-2">
      {error && <p role="alert" className="py-2 text-sm text-destructive">{error}</p>}
      <p role="status" className="py-1 text-xs text-muted-foreground">{busy ? t('common.loading') : t('chat.search.total', { count: result.total })}</p>
      {result.messages.map(row => <button key={row.id} onClick={() => void openResult(row)} className="block min-h-12 w-full rounded-lg p-2 text-left hover:bg-muted"><span className="block text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString(i18n.language)}</span><span className="line-clamp-2 text-sm">{row.content}</span></button>)}
      {result.hasMore && <Button variant="outline" disabled={busy} onClick={() => void fetchResults(term, result.messages.length, ++requestId.current)}>{t('chat.search.more')}</Button>}
    </div>}
    <Dialog open={selection !== null} onOpenChange={open => { if (!open) { contextRequestId.current++; setSelection(null) } }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t('chat.search.context')}</DialogTitle><DialogDescription>{t('chat.search.contextDescription')}</DialogDescription></DialogHeader><div className="space-y-3">{selection?.messages.map(row => <article key={row.id} className={cn('rounded-xl border p-3', row.id === selection.id && 'border-primary bg-primary/5')}><p className="mb-2 text-xs text-muted-foreground">{new Date(row.createdAt).toLocaleString(i18n.language)} · {row.role}</p><p className="whitespace-pre-wrap break-words text-sm">{row.content}</p></article>)}</div></DialogContent></Dialog>
  </section>
}
