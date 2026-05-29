import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { TaskSummary, TaskStatus, TaskTokenUsage } from '@/shared/types'

const PAGE_SIZE = 20
const SEARCH_DEBOUNCE_MS = 300

interface TasksResponse {
  tasks: TaskSummary[]
  total: number
  hasMore: boolean
}

export function useTasks() {
  const { t } = useTranslation()
  const [activeTasks, setActiveTasks] = useState<TaskSummary[]>([])
  const [queuedTasks, setQueuedTasks] = useState<TaskSummary[]>([])
  const [historyTasks, setHistoryTasks] = useState<TaskSummary[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const offsetRef = useRef(0)
  // Track task IDs we've seen to only toast for tasks we knew about
  const knownTaskIdsRef = useRef(new Set<string>())

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Fetch active tasks (no pagination — bounded by maxConcurrent)
  const fetchActiveTasks = useCallback(async () => {
    try {
      const [pending, inProgress, paused, awaitingHuman, awaitingKin, queued] = await Promise.all([
        api.get<TasksResponse>('/tasks?status=pending&limit=100&offset=0'),
        api.get<TasksResponse>('/tasks?status=in_progress&limit=100&offset=0'),
        api.get<TasksResponse>('/tasks?status=paused&limit=100&offset=0'),
        api.get<TasksResponse>('/tasks?status=awaiting_human_input&limit=100&offset=0'),
        api.get<TasksResponse>('/tasks?status=awaiting_kin_response&limit=100&offset=0'),
        api.get<TasksResponse>('/tasks?status=queued&limit=100&offset=0'),
      ])
      const all = [...awaitingHuman.tasks, ...awaitingKin.tasks, ...inProgress.tasks, ...paused.tasks, ...pending.tasks]
      for (const task of all) knownTaskIdsRef.current.add(task.id)
      for (const task of queued.tasks) knownTaskIdsRef.current.add(task.id)
      setActiveTasks(all)
      // Reverse to oldest-first (API returns createdAt DESC, queue position is FIFO)
      setQueuedTasks([...queued.tasks].reverse())
    } catch {
      // Silently fail — tasks are non-critical
    }
  }, [])

  // Fetch paginated history
  const fetchHistory = useCallback(async (offset: number, append: boolean) => {
    if (offset === 0) setIsLoading(true)
    else setIsLoadingMore(true)

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      if (debouncedSearch) params.set('search', debouncedSearch)

      const data = await api.get<TasksResponse>(`/tasks?${params}`)
      if (append) {
        setHistoryTasks((prev) => [...prev, ...data.tasks])
      } else {
        setHistoryTasks(data.tasks)
      }
      setHasMore(data.hasMore)
      offsetRef.current = offset + data.tasks.length
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
    }
  }, [debouncedSearch])

  // Reset and refetch when search changes
  useEffect(() => {
    offsetRef.current = 0
    fetchHistory(0, false)
  }, [debouncedSearch, fetchHistory])

  // Initial load of active tasks
  useEffect(() => {
    fetchActiveTasks()
  }, [fetchActiveTasks])

  const loadMore = useCallback(() => {
    if (!isLoadingMore && hasMore) {
      fetchHistory(offsetRef.current, true)
    }
  }, [isLoadingMore, hasMore, fetchHistory])

  // SSE real-time updates
  useSSE({
    'task:status': (data) => {
      const taskId = data.taskId as string
      const status = data.status as TaskStatus
      const now = new Date().toISOString()
      const startedAt = typeof data.startedAt === 'number' ? new Date(data.startedAt).toISOString() : undefined
      const endedAt = typeof data.endedAt === 'number' ? new Date(data.endedAt).toISOString() : undefined
      const patchTimes = (t: TaskSummary): TaskSummary => ({
        ...t,
        status,
        updatedAt: now,
        ...(startedAt !== undefined && { startedAt }),
        ...(endedAt !== undefined && { endedAt }),
      })

      const isActiveStatus = status === 'pending' || status === 'in_progress' || status === 'paused' || status === 'awaiting_human_input' || status === 'awaiting_kin_response'
      const isQueued = status === 'queued'

      let movedTask: TaskSummary | null = null

      // Handle queued tasks list
      setQueuedTasks((prev) => {
        if (isQueued) {
          // New queued task or update existing
          const existing = prev.find((t) => t.id === taskId)
          if (existing) {
            return prev.map((t) => (t.id === taskId ? { ...t, status, updatedAt: now } : t))
          }
          // New queued task — refetch to get full data
          knownTaskIdsRef.current.add(taskId)
          fetchActiveTasks()
          return prev
        }
        // No longer queued — remove from queued list (promoted or cancelled)
        return prev.filter((t) => t.id !== taskId)
      })

      setActiveTasks((prev) => {
        const existing = prev.find((t) => t.id === taskId)
        if (existing) {
          if (isActiveStatus) {
            return prev.map((t) => (t.id === taskId ? patchTimes(t) : t))
          }
          // Moved to terminal state — remove from active, save for history move
          movedTask = patchTimes(existing)
          return prev.filter((t) => t.id !== taskId)
        }
        if (isActiveStatus) {
          // New active task (or promoted from queued) — track and refetch to get full data
          knownTaskIdsRef.current.add(taskId)
          fetchActiveTasks()
        }
        return prev
      })

      // Move to history or update in-place
      if (!isQueued) {
        setHistoryTasks((prev) => {
          const exists = prev.some((t) => t.id === taskId)
          if (exists) {
            return prev.map((t) => (t.id === taskId ? patchTimes(t) : t))
          }
          // Task was in activeTasks but not in history — prepend it
          if (movedTask) {
            return [movedTask, ...prev]
          }
          return prev
        })
      }
    },
    'task:deleted': (data) => {
      const taskId = data.taskId as string
      setActiveTasks((prev) => prev.filter((t) => t.id !== taskId))
      setQueuedTasks((prev) => prev.filter((t) => t.id !== taskId))
      setHistoryTasks((prev) => prev.filter((t) => t.id !== taskId))
    },
    'task:token-usage': (data) => {
      const taskId = data.taskId as string
      const tokenUsage = data.tokenUsage as TaskTokenUsage | null | undefined
      if (!tokenUsage) return
      // Patch whichever list currently holds the task. The task can only be in
      // one of the three at a time, so updating all three is safe and cheap.
      const patch = (prev: TaskSummary[]) =>
        prev.some((t) => t.id === taskId)
          ? prev.map((t) => (t.id === taskId ? { ...t, tokenUsage } : t))
          : prev
      setActiveTasks(patch)
      setQueuedTasks(patch)
      setHistoryTasks(patch)
    },
    'task:done': (data) => {
      const taskId = data.taskId as string
      const status = data.status as TaskStatus
      const title = (data.title as string) ?? null
      const now = new Date().toISOString()
      const startedAt = typeof data.startedAt === 'number' ? new Date(data.startedAt).toISOString() : undefined
      const endedAt = typeof data.endedAt === 'number' ? new Date(data.endedAt).toISOString() : now
      const patchDone = (t: TaskSummary): TaskSummary => ({
        ...t,
        status,
        updatedAt: now,
        endedAt,
        ...(startedAt !== undefined && { startedAt }),
      })

      let finishedTask: TaskSummary | null = null

      setActiveTasks((prev) => {
        finishedTask = prev.find((t) => t.id === taskId) ?? null
        return prev.filter((t) => t.id !== taskId)
      })

      // Also remove from queued if it was there
      setQueuedTasks((prev) => {
        if (!finishedTask) {
          finishedTask = prev.find((t) => t.id === taskId) ?? null
        }
        return prev.filter((t) => t.id !== taskId)
      })

      // Show toast notification for completed/failed tasks we were tracking
      if (knownTaskIdsRef.current.has(taskId)) {
        const label = title
          ? title.length > 60 ? `${title.slice(0, 57)}...` : title
          : t('sidebar.tasks.title')
        if (status === 'completed') {
          toast.success(t('sidebar.tasks.toast.completed', { title: label }))
        } else if (status === 'failed') {
          toast.error(t('sidebar.tasks.toast.failed', { title: label }))
        } else if (status === 'cancelled') {
          toast(t('sidebar.tasks.toast.cancelled', { title: label }))
        }
        knownTaskIdsRef.current.delete(taskId)
      }

      setHistoryTasks((prev) => {
        const exists = prev.some((t) => t.id === taskId)
        if (exists) {
          return prev.map((t) => (t.id === taskId ? patchDone(t) : t))
        }
        // Task was in activeTasks but not yet in history — prepend it
        if (finishedTask) {
          return [patchDone(finishedTask), ...prev]
        }
        return prev
      })

      // Task was never in any list — refetch history
      if (!finishedTask) {
        offsetRef.current = 0
        fetchHistory(0, false)
      }
    },
  })

  // Derive set of cron IDs that have active tasks
  const activeCronIds = useMemo(() => {
    const ids = new Set<string>()
    for (const task of activeTasks) {
      if (task.cronId) ids.add(task.cronId)
    }
    return ids
  }, [activeTasks])

  return {
    activeTasks,
    queuedTasks,
    historyTasks,
    hasMore,
    isLoading,
    isLoadingMore,
    searchQuery,
    setSearchQuery,
    loadMore,
    activeCronIds,
  }
}
