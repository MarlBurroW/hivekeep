/**
 * Workspace path resolution cache (files.md § 5.2) — sibling of
 * mention contexts, scoped by agent.
 *
 * Chat renderers call `useWorkspacePath(path)` to learn whether a candidate
 * path (emitted by remark-workspace-paths) actually exists in the current
 * conversation agent's workspace. The provider:
 *
 *   1. Batches candidates (≤50, 50ms debounce) into one
 *      POST /agents/:id/workspace/resolve-paths call.
 *   2. Invalidates on `workspace:changed` (prefix semantics for folders).
 *   3. Purges on SSE resync — missed events while a phone was locked must not
 *      leave dead chips around (CATCHUP_GAP).
 *
 * Unverified / non-existing candidates render as plain text (no dead
 * affordance), so the whole pipeline is allowed to be optimistic.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { WorkspaceChange } from '@/client/hooks/useWorkspaceFiles'

export type WorkspacePathState = 'pending' | 'exists' | 'missing'

const BATCH_DEBOUNCE_MS = 50
const BATCH_MAX = 50

interface PathStore {
  agentId: string
  get(path: string): WorkspacePathState | undefined
  subscribe(path: string, listener: () => void): () => void
  request(path: string): void
}

const WorkspacePathReactContext = createContext<PathStore | null>(null)

interface ProviderProps {
  /** Agent owning the conversation (chips link to /files/<agentId>?path=…). */
  agentId: string
  children: ReactNode
}

export function WorkspacePathProvider({ agentId, children }: ProviderProps) {
  const cacheRef = useRef<Map<string, WorkspacePathState>>(new Map())
  const listenersRef = useRef<Map<string, Set<() => void>>>(new Map())
  const pendingRef = useRef<Set<string>>(new Set())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((path: string) => {
    const subs = listenersRef.current.get(path)
    if (subs) for (const cb of subs) cb()
  }, [])

  const setEntry = useCallback(
    (path: string, state: WorkspacePathState) => {
      cacheRef.current.set(path, state)
      notify(path)
    },
    [notify],
  )

  const flush = useCallback(async () => {
    timerRef.current = null
    const pending = [...pendingRef.current]
    pendingRef.current.clear()
    if (pending.length === 0) return
    for (let i = 0; i < pending.length; i += BATCH_MAX) {
      const chunk = pending.slice(i, i + BATCH_MAX)
      try {
        const data = await api.post<{ existing: string[] }>(
          `/agents/${encodeURIComponent(agentId)}/workspace/resolve-paths`,
          { paths: chunk },
        )
        const existing = new Set(data.existing)
        for (const path of chunk) setEntry(path, existing.has(path) ? 'exists' : 'missing')
      } catch {
        // Drop so a later mount can retry.
        for (const path of chunk) {
          cacheRef.current.delete(path)
          notify(path)
        }
      }
    }
  }, [agentId, setEntry, notify])

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) return
    timerRef.current = setTimeout(flush, BATCH_DEBOUNCE_MS)
  }, [flush])

  const invalidate = useCallback(
    (predicate: (path: string) => boolean) => {
      for (const path of [...cacheRef.current.keys()]) {
        if (!predicate(path)) continue
        cacheRef.current.delete(path)
        // Re-resolve immediately if someone is still rendering this path.
        if (listenersRef.current.get(path)?.size) {
          cacheRef.current.set(path, 'pending')
          pendingRef.current.add(path)
          scheduleFlush()
          notify(path)
        }
      }
    },
    [scheduleFlush, notify],
  )

  useSSE({
    'workspace:changed': (data) => {
      if ((data.agentId as string) !== agentId) return
      for (const change of (data.changes as WorkspaceChange[]) ?? []) {
        const prefix = change.path + '/'
        invalidate((p) => p === change.path || (change.isDirectory && p.startsWith(prefix)))
        if (change.type === 'renamed' && change.newPath) {
          const newPrefix = change.newPath + '/'
          invalidate((p) => p === change.newPath || (change.isDirectory && p.startsWith(newPrefix)))
        }
      }
    },
  })

  // Missed events (locked phone, reconnect): purge everything still rendered.
  useSSEResync(() => invalidate(() => true))

  const store = useMemo<PathStore>(
    () => ({
      agentId,
      get(path) {
        return cacheRef.current.get(path)
      },
      subscribe(path, listener) {
        const set = listenersRef.current.get(path) ?? new Set<() => void>()
        set.add(listener)
        listenersRef.current.set(path, set)
        return () => {
          set.delete(listener)
          if (set.size === 0) listenersRef.current.delete(path)
        }
      },
      request(path) {
        if (cacheRef.current.has(path)) return
        cacheRef.current.set(path, 'pending')
        pendingRef.current.add(path)
        scheduleFlush()
      },
    }),
    [agentId, scheduleFlush],
  )

  return <WorkspacePathReactContext.Provider value={store}>{children}</WorkspacePathReactContext.Provider>
}

/** State of one candidate path. Without a provider (markdown rendered outside
 *  a conversation), stays 'missing' so candidates render as plain text. */
export function useWorkspacePath(path: string): { state: WorkspacePathState; agentId: string | null } {
  const store = useContext(WorkspacePathReactContext)
  const [, force] = useState(0)

  useEffect(() => {
    if (!store) return
    store.request(path)
    return store.subscribe(path, () => force((n) => n + 1))
  }, [store, path])

  if (!store) return { state: 'missing', agentId: null }
  return { state: store.get(path) ?? 'pending', agentId: store.agentId }
}
