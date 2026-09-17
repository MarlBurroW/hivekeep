import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/client/components/ui/command'
import {
  Bot,
  MessageSquarePlus,
  Settings2,
  BrainCircuit,
  Search,
  Puzzle,
  Lock,
  Brain,
  Users,
  UserPlus,
  FolderOpen,
  Webhook,
  Radio,
  Bell,
  Sun,
  Moon,
  Palette,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/client/hooks/useAuth'
import { primaryNavigation, visibleSettingsGroups } from '@/client/lib/navigation'
import { api } from '@/client/lib/api'
import { useTheme } from '@/client/components/theme-provider'

interface AgentSummary {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
}

interface CommandPaletteProps {
  agents: AgentSummary[]
  onSelectAgent: (slug: string) => void
  onCreateAgent: () => void
  onOpenSettings: (section?: string) => void
}


export function CommandPalette({
  agents,
  onSelectAgent,
  onCreateAgent,
  onOpenSettings,
}: CommandPaletteProps) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const sections = visibleSettingsGroups(user?.role === 'admin').flatMap(group => group.items)
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const [loadedAgents, setLoadedAgents] = useState<AgentSummary[]>([])
  useEffect(() => {
    if (!open || agents.length > 0) return
    let active = true
    api.get<{ agents: AgentSummary[] }>('/agents').then(data => { if (active) setLoadedAgents(data.agents) }).catch(() => {})
    return () => { active = false }
  }, [open, agents.length])
  const availableAgents = agents.length ? agents : loadedAgents
  const { theme, setTheme } = useTheme()

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const runAndClose = (fn: () => void) => {
    fn()
    setOpen(false)
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title={t('commandPalette.title')} description={t('commandPalette.description')}>
      <CommandInput placeholder={t('commandPalette.placeholder')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.empty')}</CommandEmpty>

        <CommandGroup heading={t('workspace.navigation')}>{primaryNavigation.map(item => <CommandItem key={item.id} value={t(item.labelKey)} onSelect={() => runAndClose(() => navigate(item.to))}><item.icon className="size-4" />{t(item.labelKey)}</CommandItem>)}</CommandGroup>
        {/* Agents */}
        {availableAgents.length > 0 && (
          <CommandGroup heading={t('commandPalette.agents')}>
            {availableAgents.map((agent) => (
              <CommandItem
                key={agent.id}
                value={`agent ${agent.name} ${agent.role}`}
                onSelect={() => runAndClose(() => onSelectAgent(agent.slug))}
              >
                {agent.avatarUrl ? (
                  <img
                    src={agent.avatarUrl}
                    alt=""
                    className="size-4 rounded-full object-cover"
                  />
                ) : (
                  <Bot className="size-4" />
                )}
                <span>{agent.name}</span>
                <span className="text-muted-foreground text-xs ml-1">{agent.role}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        {/* Actions */}
        <CommandGroup heading={t('commandPalette.actions')}>
          {user?.role === 'admin' && <CommandItem
            value="create new agent"
            onSelect={() => runAndClose(onCreateAgent)}
          >
            <MessageSquarePlus className="size-4" />
            <span>{t('commandPalette.createAgent')}</span>
          </CommandItem>}
          <CommandItem
            value="toggle theme dark light"
            onSelect={() => runAndClose(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            <span>{t('commandPalette.toggleTheme')}</span>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Settings */}
        <CommandGroup heading={t('commandPalette.settings')}>
          {sections.map(({ id, icon: Icon, labelKey }) => (
            <CommandItem
              key={id}
              value={`settings ${t(labelKey)}`}
              onSelect={() => runAndClose(() => onOpenSettings(id))}
            >
              <Icon className="size-4" />
              <span>{t(labelKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
