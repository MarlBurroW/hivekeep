import { useCallback, useEffect, useMemo, useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { Search } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useNavigate } from 'react-router-dom'
import { SortableAgentCard } from '@/client/components/agent/SortableAgentCard'
import { AgentCard } from '@/client/components/agent/AgentCard'
import { useAgentChannels } from '@/client/hooks/useAgentChannels'
import { useAgentGroups } from '@/client/hooks/useAgentGroups'
import { useAuth } from '@/client/hooks/useAuth'
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
} from '@/client/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/client/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { Button } from '@/client/components/ui/button'
import { toastError } from '@/client/lib/api'
import { Plus, Bot, Download, ChevronRight, MoreHorizontal, Pencil, Trash2, FolderPlus } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'
import type { AgentGroup } from '@/shared/types'

interface AgentSummary {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
  model: string
  /** Sidebar group this Agent belongs to; null = ungrouped. */
  groupId?: string | null
}

interface AgentListProps {
  agents: AgentSummary[]
  llmModels: { id: string; name: string }[]
  selectedAgentSlug: string | null
  unavailableAgentIds: Set<string>
  agentQueueState: Map<string, { isProcessing: boolean; queueSize: number }>
  unreadCounts: Map<string, number>
  onSelectAgent: (slug: string) => void
  onCreateAgent: () => void
  onEditAgent: (id: string) => void
  onDeleteAgent?: (id: string) => void
  onViewUsage?: (agentId: string) => void
  onReorderAgents: (newOrder: string[]) => void
  /** File an Agent into a group (null ungroups it). Omitted → the "Move to"
   *  submenu is not offered at all. */
  onMoveAgentToGroup?: (agentId: string, groupId: string | null) => void
}

const KIN_SEARCH_THRESHOLD = 5

/** Per-viewer, per-browser collapse state. A convenience, not shared state —
 *  deliberately localStorage and not the DB, and every access is guarded
 *  because private windows and blocked site-data make it throw. */
const COLLAPSED_STORAGE_KEY = 'hivekeep:agent-groups:collapsed'

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function persistCollapsedGroups(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // Non-essential preference; losing it is fine.
  }
}

export const AgentList = memo(function AgentList({ agents, llmModels, selectedAgentSlug, unavailableAgentIds, agentQueueState, unreadCounts, onSelectAgent, onCreateAgent, onEditAgent, onDeleteAgent, onViewUsage, onReorderAgents, onMoveAgentToGroup }: AgentListProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const navigate = useNavigate()
  // Bound channels per Agent: live grouped projection of /api/channels,
  // refreshed on channel:created/updated/deleted/transferred SSE events
  // so badges migrate to the new Agent row immediately after a transfer.
  const { byAgentId: channelsByAgentId } = useAgentChannels()
  const { groups, createGroup, updateGroup, deleteGroup } = useAgentGroups()
  const { user } = useAuth()
  // Groups are global and the API rejects writes from members, so members get
  // the folders read-only: they see the sections, not the edit affordances.
  const canManageGroups = user?.role === 'admin'

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(loadCollapsedGroups)
  // One dialog serves both "new group" and "rename": `groupId` null means
  // create. `moveAgentId` carries the Agent that asked for the new group, so
  // creating from a card's menu also files that card in one step.
  const [groupDialog, setGroupDialog] = useState<{ groupId: string | null; name: string; moveAgentId?: string } | null>(null)
  const [groupPendingDelete, setGroupPendingDelete] = useState<AgentGroup | null>(null)
  const [isSavingGroup, setIsSavingGroup] = useState(false)

  const openChannelSettings = useCallback((_channelId: string) => {
    // For now the channel-settings page is the editing surface; a future
    // refinement could focus the matching row via a query param.
    navigate('/settings/channels')
  }, [navigate])

  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  // Persisted in an effect rather than inside the updater above: React may
  // invoke a state updater twice (StrictMode), and a writer belongs outside it.
  useEffect(() => {
    persistCollapsedGroups(collapsedGroups)
  }, [collapsedGroups])

  // Hub Agent distinction retired — all agents live in one sortable list,
  // optionally split into named groups (agents.groupId).
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents
    const q = searchQuery.toLowerCase()
    return agents.filter(
      (k) => k.name.toLowerCase().includes(q) || k.role.toLowerCase().includes(q),
    )
  }, [agents, searchQuery])

  // Partition the (already user-ordered) list into the ungrouped bucket plus
  // one bucket per group. Order within each bucket is inherited from the input,
  // so `user_profiles.agent_order` keeps working untouched.
  const { ungroupedAgents, agentsByGroup } = useMemo(() => {
    const knownGroupIds = new Set(groups.map((g) => g.id))
    const ungrouped: AgentSummary[] = []
    const byGroup = new Map<string, AgentSummary[]>()
    for (const agent of filteredAgents) {
      // An id we don't know about (group deleted in another session before its
      // SSE event landed) falls back to ungrouped rather than vanishing.
      const groupId = agent.groupId && knownGroupIds.has(agent.groupId) ? agent.groupId : null
      if (!groupId) {
        ungrouped.push(agent)
        continue
      }
      const bucket = byGroup.get(groupId)
      if (bucket) bucket.push(agent)
      else byGroup.set(groupId, [agent])
    }
    return { ungroupedAgents: ungrouped, agentsByGroup: byGroup }
  }, [filteredAgents, groups])

  const showSearch = agents.length >= KIN_SEARCH_THRESHOLD

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Reordering stays global: each section has its own DndContext, so `active`
  // and `over` are always in the same bucket, and moving one within the global
  // array preserves every other agent's relative position.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = agents.findIndex((k) => k.id === active.id)
    const newIndex = agents.findIndex((k) => k.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const newAgents = [...agents]
    const [moved] = newAgents.splice(oldIndex, 1)
    newAgents.splice(newIndex, 0, moved!)
    onReorderAgents(newAgents.map((k) => k.id))
  }, [agents, onReorderAgents])

  const handleExportAgent = useCallback(async (agentId: string) => {
    try {
      const token = localStorage.getItem('auth_token') || ''
      const res = await fetch(`/api/agents/${agentId}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const data = await res.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${data.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'agent'}.hivekeep.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // silent fail
    }
  }, [])

  const handleSubmitGroupDialog = useCallback(async () => {
    if (!groupDialog) return
    const name = groupDialog.name.trim()
    if (!name) return
    setIsSavingGroup(true)
    try {
      if (groupDialog.groupId) {
        await updateGroup(groupDialog.groupId, { name })
      } else {
        const created = await createGroup({ name })
        if (groupDialog.moveAgentId) onMoveAgentToGroup?.(groupDialog.moveAgentId, created.id)
      }
      setGroupDialog(null)
    } catch (err) {
      // A duplicate name is the common one (409). Without this the dialog just
      // sat there doing nothing, which reads as a broken button.
      toastError(err)
    } finally {
      setIsSavingGroup(false)
    }
  }, [groupDialog, updateGroup, createGroup, onMoveAgentToGroup])

  const handleConfirmDeleteGroup = useCallback(async () => {
    if (!groupPendingDelete) return
    try {
      await deleteGroup(groupPendingDelete.id)
    } catch (err) {
      toastError(err)
    }
    setGroupPendingDelete(null)
  }, [groupPendingDelete, deleteGroup])

  const renderAgentCards = (list: AgentSummary[]) => (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={list.map((k) => k.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5 px-1">
          {list.map((agent) => {
            const queueState = agentQueueState.get(agent.id)
            const modelName = llmModels.find((m) => m.id === agent.model)?.name
            // Keyboard shortcuts are 1-9 over the whole roster, so the index
            // comes from the flat list, not from the position within a group.
            const globalIndex = agents.findIndex((k) => k.id === agent.id)
            return (
              <SortableAgentCard
                key={agent.id}
                id={agent.id}
                name={agent.name}
                role={agent.role}
                avatarUrl={agent.avatarUrl}
                modelDisplayName={modelName}
                isSelected={selectedAgentSlug === agent.slug}
                isProcessing={queueState?.isProcessing}
                queueSize={queueState?.queueSize}
                modelUnavailable={unavailableAgentIds.has(agent.id)}
                unreadCount={unreadCounts.get(agent.id) ?? 0}
                shortcutIndex={globalIndex >= 0 ? globalIndex + 1 : undefined}
                channels={channelsByAgentId.get(agent.id)}
                onOpenChannel={openChannelSettings}
                onClick={() => onSelectAgent(agent.slug)}
                onEdit={() => onEditAgent(agent.id)}
                onDelete={onDeleteAgent ? () => onDeleteAgent(agent.id) : undefined}
                onExport={() => handleExportAgent(agent.id)}
                onViewUsage={onViewUsage ? () => onViewUsage(agent.id) : undefined}
                groups={canManageGroups ? groups : undefined}
                groupId={agent.groupId ?? null}
                onMoveToGroup={
                  onMoveAgentToGroup && canManageGroups
                    ? (groupId) => onMoveAgentToGroup(agent.id, groupId)
                    : undefined
                }
                onCreateGroup={
                  canManageGroups
                    ? () => setGroupDialog({ groupId: null, name: '', moveAgentId: agent.id })
                    : undefined
                }
              />
            )
          })}
        </div>
      </SortableContext>
    </DndContext>
  )

  return (
    <SidebarGroup className="flex-1 min-h-0">
      <SidebarGroupLabel>{t('sidebar.agents.title')}</SidebarGroupLabel>
      <SidebarGroupAction onClick={onCreateAgent} title={t('sidebar.agents.create')}>
        <Plus className="size-4" />
      </SidebarGroupAction>
      <SidebarGroupContent className="flex-1 flex flex-col min-h-0">
        {agents.length === 0 ? (
          <EmptyState
            compact
            icon={Bot}
            title={t('sidebar.agents.empty')}
            description={t('sidebar.agents.emptyDescription')}
            actionLabel={t('sidebar.agents.create')}
            onAction={onCreateAgent}
          />
        ) : (
          <>
            {showSearch && (
              <div className="px-1 pb-2 pt-1">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('sidebar.agents.search')}
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>
            )}
            {searchQuery && filteredAgents.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t('sidebar.agents.noResults')}
              </p>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto">
                {/* Ungrouped Agents sit at the top with no header, so an
                    instance with no groups looks exactly like it did before
                    groups existed. */}
                {ungroupedAgents.length > 0 && renderAgentCards(ungroupedAgents)}

                {groups.map((group) => {
                  const members = agentsByGroup.get(group.id) ?? []
                  // While searching, a group with no match is noise.
                  if (searchQuery && members.length === 0) return null
                  const isCollapsed = collapsedGroups.has(group.id)
                  return (
                    <div key={group.id} className="mt-2 first:mt-0">
                      <div className="group/header flex items-center gap-1 px-2 py-1">
                        <button
                          type="button"
                          onClick={() => toggleGroupCollapsed(group.id)}
                          className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground"
                          aria-expanded={!isCollapsed}
                        >
                          <ChevronRight
                            className={`size-3.5 shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                          />
                          <span className="truncate">{group.name}</span>
                          <span className="ml-1 shrink-0 text-[10px] text-muted-foreground/70">
                            {members.length}
                          </span>
                        </button>
                        {canManageGroups && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                title={t('sidebar.agents.groups.manage')}
                                className="rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover/header:opacity-100 focus:opacity-100"
                              >
                                <MoreHorizontal className="size-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem
                                onClick={() => setGroupDialog({ groupId: group.id, name: group.name })}
                              >
                                <Pencil className="size-4" />
                                {t('sidebar.agents.groups.rename')}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setGroupPendingDelete(group)}
                                className="text-destructive focus:text-destructive"
                              >
                                <Trash2 className="size-4" />
                                {t('sidebar.agents.groups.delete')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                      {!isCollapsed && (
                        members.length > 0 ? (
                          renderAgentCards(members)
                        ) : (
                          <p className="px-3 py-2 text-xs text-muted-foreground/70">
                            {t('sidebar.agents.groups.empty')}
                          </p>
                        )
                      )}
                    </div>
                  )
                })}

                {/* Always available to an admin, not just when the list is
                    empty: creating the SECOND group would otherwise be possible
                    only through an Agent's context menu, and an empty group
                    could not be created at all. Hidden while searching, where
                    it is only noise. */}
                {canManageGroups && !searchQuery && (
                  <button
                    type="button"
                    onClick={() => setGroupDialog({ groupId: null, name: '' })}
                    className="mt-2 flex w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <FolderPlus className="size-3.5" />
                    {t('sidebar.agents.groups.create')}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </SidebarGroupContent>

      {/* Create / rename a group */}
      <Dialog open={groupDialog !== null} onOpenChange={(open) => { if (!open) setGroupDialog(null) }}>
        {/* The base DialogContent is a `grid ... p-6` with no gap, so without
            this the description, the field and the buttons all touch. */}
        <DialogContent className="gap-5">
          <DialogHeader>
            <DialogTitle>
              {groupDialog?.groupId
                ? t('sidebar.agents.groups.renameTitle')
                : t('sidebar.agents.groups.createTitle')}
            </DialogTitle>
            <DialogDescription>{t('sidebar.agents.groups.dialogDescription')}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={groupDialog?.name ?? ''}
            maxLength={60}
            placeholder={t('sidebar.agents.groups.namePlaceholder')}
            onChange={(e) => setGroupDialog((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitGroupDialog() }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGroupDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleSubmitGroupDialog}
              disabled={isSavingGroup || !groupDialog?.name.trim()}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete a group — its Agents are ungrouped, never deleted. */}
      <AlertDialog
        open={groupPendingDelete !== null}
        onOpenChange={(open) => { if (!open) setGroupPendingDelete(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('sidebar.agents.groups.deleteTitle', { name: groupPendingDelete?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('sidebar.agents.groups.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDeleteGroup}>
              {t('sidebar.agents.groups.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarGroup>
  )
})
