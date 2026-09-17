import { useEffect, useMemo, useState } from 'react'

export interface UseListControlsOptions<T> {
  /**
   * Build the searchable text for an item. Return a string, or an array of
   * fields (nullish entries are dropped and the rest joined). Matching is
   * case-insensitive substring against the trimmed query.
   */
  searchText?: (item: T) => string | (string | null | undefined)[]
  /**
   * Extra predicate applied before search (the screen's select/status
   * filters). Keep it cheap — it runs over the whole list. When this depends
   * on screen state, recompute it inline; identity churn is fine (the list is
   * re-derived each render anyway) and never resets the page on its own.
   */
  filter?: (item: T) => boolean
  /** Optional comparator applied to the filtered list (non-mutating). */
  sort?: (a: T, b: T) => number
  /** Page size. Pass null (default) to disable pagination entirely. */
  pageSize?: number | null
}

export interface ListControls<T> {
  query: string
  setQuery: (value: string) => void
  /** Full result set after filter + search + sort. */
  filtered: T[]
  /** The slice for the current page (same as `filtered` when paging is off). */
  paged: T[]
  /** 1-based, already clamped to a valid page. */
  page: number
  setPage: (page: number) => void
  pageCount: number
  perPage: number
  setPerPage: (n: number) => void
  /** 1-based index of the first/last item shown (0 when empty). */
  rangeFrom: number
  rangeTo: number
  /** Size of the filtered set (not the page). */
  total: number
  /** True when a text query is active (handy for empty-state copy). */
  isSearching: boolean
}

/**
 * Client-side list controls: text search (multi-field), an optional extra
 * predicate for select filters, optional sort, and optional pagination. Extracted
 * from the model-registry table so every growing settings list filters and
 * paginates the same way. Server-driven lists (large datasets that filter/paginate
 * through the API) drive `ListToolbar` + `ListPagination` directly instead.
 */
export function useListControls<T>(
  items: T[],
  options: UseListControlsOptions<T> = {},
): ListControls<T> {
  const { searchText, filter, sort, pageSize = null } = options
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(pageSize ?? 0)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    let out = filter ? items.filter(filter) : items.slice()
    if (q && searchText) {
      out = out.filter((item) => {
        const raw = searchText(item)
        const text = Array.isArray(raw) ? raw.filter(Boolean).join(' ') : raw
        return text.toLowerCase().includes(q)
      })
    }
    if (sort) out = out.sort(sort)
    return out
    // These callbacks can capture a changed select value or sorting preference
    // even when items and query stay unchanged.
  }, [items, query, filter, sort, searchText])

  const paging = perPage > 0
  const pageCount = paging ? Math.max(1, Math.ceil(filtered.length / perPage)) : 1
  const safePage = Math.min(page, pageCount)

  // Jump back to the first page when the result shape changes under the cursor.
  useEffect(() => { setPage(1) }, [query, perPage])

  const paged = paging ? filtered.slice((safePage - 1) * perPage, safePage * perPage) : filtered
  const rangeFrom = filtered.length === 0 ? 0 : paging ? (safePage - 1) * perPage + 1 : 1
  const rangeTo = paging ? Math.min(safePage * perPage, filtered.length) : filtered.length

  return {
    query,
    setQuery,
    filtered,
    paged,
    page: safePage,
    setPage,
    pageCount,
    perPage,
    setPerPage,
    rangeFrom,
    rangeTo,
    total: filtered.length,
    isSearching: query.trim().length > 0,
  }
}
