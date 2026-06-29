import { useCallback, useMemo, useState, memo } from 'react'
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
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
} from '@/client/components/ui/sidebar'
import { Plus, Bot, Download } from 'lucide-react'
import { EmptyState } from '@/client/components/common/EmptyState'

interface AgentSummary {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
  model: string
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
}

const KIN_SEARCH_THRESHOLD = 5

export const AgentList = memo(function AgentList({ agents, llmModels, selectedAgentSlug, unavailableAgentIds, agentQueueState, unreadCounts, onSelectAgent, onCreateAgent, onEditAgent, onDeleteAgent, onViewUsage, onReorderAgents }: AgentListProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const navigate = useNavigate()
  // Bound channels per Agent: live grouped projection of /api/channels,
  // refreshed on channel:created/updated/deleted/transferred SSE events
  // so badges migrate to the new Agent row immediately after a transfer.
  const { byAgentId: channelsByAgentId } = useAgentChannels()
  const openChannelSettings = useCallback((_channelId: string) => {
    // For now the channel-settings page is the editing surface; a future
    // refinement could focus the matching row via a query param.
    navigate('/settings/channels')
  }, [navigate])

  // Hub Agent distinction retired — all agents live in one sortable list.
  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents
    const q = searchQuery.toLowerCase()
    return agents.filter(
      (k) => k.name.toLowerCase().includes(q) || k.role.toLowerCase().includes(q),
    )
  }, [agents, searchQuery])

  const showSearch = agents.length >= KIN_SEARCH_THRESHOLD

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

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
      a.download = `${data.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'agent'}.gezy.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      // silent fail
    }
  }, [])

  const sortableAgentIds = agents.map((k) => k.id)

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
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={sortableAgentIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-0.5 px-1">
                {filteredAgents.map((agent, index) => {
                  const queueState = agentQueueState.get(agent.id)
                  const modelName = llmModels.find((m) => m.id === agent.model)?.name
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
                      shortcutIndex={index + 1}
                      channels={channelsByAgentId.get(agent.id)}
                      onOpenChannel={openChannelSettings}
                      onClick={() => onSelectAgent(agent.slug)}
                      onEdit={() => onEditAgent(agent.id)}
                      onDelete={onDeleteAgent ? () => onDeleteAgent(agent.id) : undefined}
                      onExport={() => handleExportAgent(agent.id)}
                      onViewUsage={onViewUsage ? () => onViewUsage(agent.id) : undefined}
                    />
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>
          </div>
            )}
          </>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
  )
})
