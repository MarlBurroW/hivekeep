import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import type { AgentGroup } from '@/shared/types'

interface AgentGroupsResponse {
  groups: AgentGroup[]
}

interface AgentGroupResponse {
  group: AgentGroup
}

export interface CreateAgentGroupInput {
  name: string
  sortOrder?: number
}

export type UpdateAgentGroupInput = Partial<CreateAgentGroupInput>

/**
 * CRUD over the sidebar's Agent groups (GET/POST/PATCH/DELETE
 * /api/agent-groups). Same shape as useToolboxes: local list, API mutations,
 * SSE to stay in sync with other sessions.
 *
 * Groups are global, so every signed-in user sees the same folders; only admins
 * can mutate them (the server enforces this, and `canManage` mirrors it so the
 * UI can hide affordances a member cannot use).
 *
 * Deleting a group ungroups its Agents rather than deleting them — the
 * 'agent-group:deleted' event carries `ungroupedAgentIds` so the Agent list can
 * move those cards without a refetch.
 */
export function useAgentGroups() {
  const [groups, setGroups] = useState<AgentGroup[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const data = await api.get<AgentGroupsResponse>('/agent-groups')
      setGroups(data.groups)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useSSE({
    'agent-group:created': (data) => {
      setGroups((prev) => upsertGroup(prev, data as unknown as AgentGroup))
    },
    'agent-group:updated': (data) => {
      setGroups((prev) => upsertGroup(prev, data as unknown as AgentGroup))
    },
    'agent-group:deleted': (data) => {
      const id = data.groupId as string
      setGroups((prev) => prev.filter((g) => g.id !== id))
    },
  })

  useSSEResync(refetch)

  const createGroup = useCallback(async (input: CreateAgentGroupInput) => {
    const { group } = await api.post<AgentGroupResponse>('/agent-groups', input)
    setGroups((prev) => upsertGroup(prev, group))
    return group
  }, [])

  const updateGroup = useCallback(async (id: string, input: UpdateAgentGroupInput) => {
    const { group } = await api.patch<AgentGroupResponse>(`/agent-groups/${id}`, input)
    setGroups((prev) => upsertGroup(prev, group))
    return group
  }, [])

  const deleteGroup = useCallback(async (id: string) => {
    await api.delete(`/agent-groups/${id}`)
    setGroups((prev) => prev.filter((g) => g.id !== id))
  }, [])

  return { groups, isLoading, refetch, createGroup, updateGroup, deleteGroup }
}

/**
 * Insert or replace a group by id, keeping display order.
 *
 * Every write path goes through this because the SSE broadcast and the HTTP
 * response are two deliveries of the SAME change, racing each other: the server
 * broadcasts before the POST response reaches the browser, so the event often
 * lands FIRST. A plain append in `createGroup` then added a second copy, and
 * the group appeared twice until the next refetch quietly fixed it.
 *
 * Matching on id (not name) also means a rename arriving out of order can't
 * split one group into two rows.
 */
export function upsertGroup(groups: AgentGroup[], group: AgentGroup): AgentGroup[] {
  const exists = groups.some((g) => g.id === group.id)
  const next = exists ? groups.map((g) => (g.id === group.id ? group : g)) : [...groups, group]
  return sortGroups(next)
}

/** Display order, mirroring the server's: sortOrder then name. Applied on every
 *  local mutation so an optimistic insert lands where a refetch would put it. */
function sortGroups(groups: AgentGroup[]): AgentGroup[] {
  return [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}
