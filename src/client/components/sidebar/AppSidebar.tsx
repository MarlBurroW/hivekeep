import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarSeparator,
} from '@/client/components/ui/sidebar'
import { AgentList } from '@/client/components/sidebar/AgentList'
import { SidebarFooterContent } from '@/client/components/sidebar/SidebarFooterContent'
import { SystemHealthBar } from '@/client/components/sidebar/SystemHealthBar'

interface AgentSummary {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
  model: string
  providerId: string | null
  /** Sidebar group this Agent belongs to; null = ungrouped. */
  groupId?: string | null
  createdAt: string
}

interface AppSidebarProps {
  agents: AgentSummary[]
  llmModels: { id: string; name: string; providerId: string; providerName: string; providerType: string; capability: string }[]
  selectedAgentSlug: string | null
  selectedAgentId: string | null
  unavailableAgentIds: Set<string>
  agentQueueState: Map<string, { isProcessing: boolean; queueSize: number }>
  unreadCounts: Map<string, number>
  onSelectAgent: (slug: string) => void
  onCreateAgent: () => void
  onEditAgent: (id: string) => void
  onDeleteAgent?: (id: string) => void
  onReorderAgents: (newOrder: string[]) => void
  /** File an Agent into a sidebar group (null ungroups it). */
  onMoveAgentToGroup?: (agentId: string, groupId: string | null) => void
  onOpenSettings?: (section?: string, filters?: { agentId?: string }) => void
}

/**
 * Agents page sidebar.
 *
 * Now dedicated to the Agents list. Tasks, Scheduled Tasks and Mini-Apps used to
 * live in a tabbed bottom section here; they each have their own full-width
 * page (reached via the ActivityBar) so the sidebar can give the Agents list its
 * full height.
 */
export function AppSidebar({
  agents,
  llmModels,
  selectedAgentSlug,
  unavailableAgentIds,
  agentQueueState,
  unreadCounts,
  onSelectAgent,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
  onReorderAgents,
  onMoveAgentToGroup,
  onOpenSettings,
}: AppSidebarProps) {
  return (
    <Sidebar className="surface-sidebar">
      {/* Brand/logo lives in <AppTopBar /> now. SystemHealthBar takes the top slot. */}
      <SystemHealthBar onOpenSettings={onOpenSettings} />

      <SidebarSeparator />

      <SidebarContent className="!overflow-hidden flex flex-col">
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          <AgentList
            agents={agents}
            llmModels={llmModels}
            selectedAgentSlug={selectedAgentSlug}
            unavailableAgentIds={unavailableAgentIds}
            agentQueueState={agentQueueState}
            unreadCounts={unreadCounts}
            onSelectAgent={onSelectAgent}
            onCreateAgent={onCreateAgent}
            onEditAgent={onEditAgent}
            onDeleteAgent={onDeleteAgent}
            onViewUsage={onOpenSettings ? (agentId: string) => onOpenSettings('tokenUsage', { agentId }) : undefined}
            onReorderAgents={onReorderAgents}
            onMoveAgentToGroup={onMoveAgentToGroup}
          />
        </div>
      </SidebarContent>

      <SidebarFooter>
        <SidebarFooterContent onOpenSettings={onOpenSettings} />
      </SidebarFooter>
    </Sidebar>
  )
}
