import { useState, useEffect, useRef } from 'react'
import { api } from '@/client/lib/api'
import { sourceApiBase } from '@/client/lib/workspace-source'
import type { WorkspaceSourceRef } from '@/shared/types'

export interface WorkspaceFileHit {
  path: string
  name: string
  size: number
  modifiedAt: number
}

/** Pure URL builder (tested separately — repo convention: hooks stay thin). */
export function buildWorkspaceSearchUrl(params: { source: WorkspaceSourceRef | null; query: string; limit: number }): string | null {
  if (!params.source) return null
  const qs = new URLSearchParams()
  if (params.query) qs.set('q', params.query)
  qs.set('limit', String(Math.max(1, Math.min(params.limit, 50))))
  return `${sourceApiBase(params.source)}/search?${qs.toString()}`
}

interface UseWorkspaceFileSearchOptions {
  query: string
  source: WorkspaceSourceRef | null
  enabled: boolean
  debounceMs?: number
  limit?: number
}

/**
 * Server-side workspace filename search for the `@` palette and the quick-open
 * dialog (files.md § 5.1) — same debounce + request-sequencing pattern as
 * the request sequence so slow responses never land out of order.
 */
export function useWorkspaceFileSearch({
  query,
  source,
  enabled,
  debounceMs = 150,
  limit = 8,
}: UseWorkspaceFileSearchOptions) {
  const [hits, setHits] = useState<WorkspaceFileHit[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !source) {
      // Reset to empty WITHOUT allocating a fresh array when already empty: a
      // brand-new `[]` is a new reference each time, so an unstable `source`
      // prop (e.g. an inline `{ type, id }` recreated every render) would make
      // this effect re-run each render and setState a new array every time,
      // spinning into an infinite render loop (React #185). The functional
      // updater bails out when there's nothing to clear.
      setHits((prev) => (prev.length === 0 ? prev : []))
      setIsLoading(false)
      return
    }
    const url = buildWorkspaceSearchUrl({ source, query, limit })
    if (!url) return
    const seq = ++requestSeqRef.current
    setIsLoading(true)
    const handle = setTimeout(async () => {
      try {
        const data = await api.get<{ hits: WorkspaceFileHit[] }>(url)
        if (seq !== requestSeqRef.current) return // superseded — drop silently
        setHits(data.hits)
        setIsLoading(false)
      } catch {
        if (seq !== requestSeqRef.current) return
        setHits([])
        setIsLoading(false)
      }
    }, debounceMs)
    return () => clearTimeout(handle)
  }, [query, source, enabled, debounceMs, limit])

  return { hits, isLoading }
}
