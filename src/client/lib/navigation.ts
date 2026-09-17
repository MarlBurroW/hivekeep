import {
  Home,
  Bot,
  FolderOpen,
  Workflow,
  Settings2,
  BrainCircuit,
  Layers,
  Table2,
  Image,
  Plug,
  ShoppingBag,
  Puzzle,
  Wrench,
  Code2,
  Shapes,
  Lock,
  Brain,
  Radio,
  Mail,
  Webhook,
  Network,
  Users,
  UserPlus,
  Bell,
  ScrollText,
  Coins,
  ArrowUpCircle,
} from 'lucide-react'

// Shared by the rail, mobile navigation, command palette and settings pages.
export const primaryNavigation = [
  { id: 'home', to: '/', icon: Home, labelKey: 'workspace.home', matches: ['/', '/tasks'] },
  { id: 'agents', to: '/agents', icon: Bot, labelKey: 'workspace.agents', matches: ['/agents', '/agent'] },
  {
    id: 'productions',
    to: '/productions',
    icon: FolderOpen,
    labelKey: 'workspace.productions',
    matches: ['/productions', '/files', '/mini-apps'],
  },
  {
    id: 'automations',
    to: '/automations',
    icon: Workflow,
    labelKey: 'workspace.automations',
    matches: ['/automations', '/crons'],
  },
] as const

export function matchesDestination(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)),
  )
}

export const settingsGroups = [
  {
    labelKey: 'workspace.preferences',
    items: [
      { id: 'general', icon: Settings2, labelKey: 'settings.general.title', member: true },
      { id: 'notifications', icon: Bell, labelKey: 'settings.notifications.title', member: true },
      { id: 'contacts', icon: Users, labelKey: 'settings.contacts.title', member: true },
    ],
  },
  {
    labelKey: 'workspace.ai',
    items: [
      { id: 'providers', icon: BrainCircuit, labelKey: 'settings.providers.title' },
      { id: 'models', icon: Layers, labelKey: 'settings.models.title' },
      { id: 'modelRegistry', icon: Table2, labelKey: 'settings.modelRegistry.title' },
      { id: 'avatars', icon: Image, labelKey: 'settings.avatars.title' },
    ],
  },
  {
    labelKey: 'workspace.connections',
    items: [
      { id: 'channels', icon: Radio, labelKey: 'settings.channels.title' },
      { id: 'emailAccounts', icon: Mail, labelKey: 'settings.emailAccounts.title' },
      { id: 'webhooks', icon: Webhook, labelKey: 'settings.webhooks.title' },
    ],
  },
  {
    labelKey: 'workspace.extensions',
    items: [
      { id: 'plugins', icon: Plug, labelKey: 'settings.plugins.title' },
      { id: 'marketplace', icon: ShoppingBag, labelKey: 'settings.marketplace.title' },
      { id: 'mcp', icon: Puzzle, labelKey: 'settings.mcp.title' },
      { id: 'toolboxes', icon: Wrench, labelKey: 'toolboxes.title' },
      { id: 'customTools', icon: Code2, labelKey: 'customTools.title' },
      { id: 'customDomains', icon: Shapes, labelKey: 'toolDomains.title' },
    ],
  },
  {
    labelKey: 'workspace.data',
    items: [
      { id: 'vault', icon: Lock, labelKey: 'settings.vault.title' },
      { id: 'memories', icon: Brain, labelKey: 'settings.memories.title' },
      { id: 'files', icon: FolderOpen, labelKey: 'settings.files.title', member: true },
      { id: 'externalApi', icon: Network, labelKey: 'settings.externalApi.title' },
    ],
  },
  {
    labelKey: 'workspace.system',
    items: [
      { id: 'users', icon: UserPlus, labelKey: 'settings.users.title' },
      { id: 'logs', icon: ScrollText, labelKey: 'settings.logs.title' },
      { id: 'tokenUsage', icon: Coins, labelKey: 'settings.tokenUsage.title' },
      { id: 'updates', icon: ArrowUpCircle, labelKey: 'settings.updates.title' },
    ],
  },
] satisfies Array<{
  labelKey: string
  items: Array<{ id: string; icon: typeof Home; labelKey: string; member?: boolean }>
}>

export const settingsSections = settingsGroups.flatMap((group) => group.items)
export function visibleSettingsGroups(isAdmin: boolean) {
  return settingsGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isAdmin || ('member' in item && item.member)),
    }))
    .filter((group) => group.items.length > 0)
}
export function settingsUrl(section = 'general', filters?: { agentId?: string }) {
  const known = settingsSections.some((item) => item.id === section) ? section : 'general'
  return `/settings/${known}${filters?.agentId ? `?agentId=${encodeURIComponent(filters.agentId)}` : ''}`
}
