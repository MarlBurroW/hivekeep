import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderInput, Plus, ChevronsUpDown, AppWindow } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/client/components/ui/command'
import { ToggleGroup, ToggleGroupItem } from '@/client/components/ui/toggle-group'
import { AgentSelectItem, type AgentOption } from '@/client/components/common/AgentSelectItem'
import { cn } from '@/client/lib/utils'
import type { WorkspaceSourceRef } from '@/shared/types'

/** A mini-app offered as a browse source (its source directory). */
export interface WorkspaceMiniAppOption {
  id: string
  title: string
  sub?: string
}

interface WorkspaceSourceSelectorProps {
  value: WorkspaceSourceRef | null
  onChange: (source: WorkspaceSourceRef) => void
  agents: AgentOption[]
  folders: Array<{ id: string; label: string; path: string }>
  miniapps?: WorkspaceMiniAppOption[]
  onAddFolder: () => void
  placeholder?: string
}

type Category = 'all' | 'agent' | 'folder' | 'miniapp'

/**
 * Files-section source picker: agents, mini-apps and user-added folders in one
 * searchable popover with category segments, so a workspace stays one or two
 * keystrokes away even with many sources (no long scroll). Reuses cmdk
 * (Command) + AgentSelectItem so an agent row looks identical to every other
 * agent picker. The git badge lives in FilesPage, next to this.
 */
export function WorkspaceSourceSelector({
  value,
  onChange,
  agents,
  folders,
  miniapps = [],
  onAddFolder,
  placeholder,
}: WorkspaceSourceSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<Category>('all')
  const [search, setSearch] = useState('')

  const select = (source: WorkspaceSourceRef) => {
    onChange(source)
    setOpen(false)
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setCategory('all')
      setSearch('')
    }
  }

  const showAgents = (category === 'all' || category === 'agent') && agents.length > 0
  const showMiniApps = (category === 'all' || category === 'miniapp') && miniapps.length > 0
  const showFolders = category === 'all' || category === 'folder'

  const triggerLabel = (() => {
    if (!value) return null
    if (value.type === 'agent') {
      const agent = agents.find((a) => a.id === value.id)
      return agent ? <AgentSelectItem agent={agent} /> : null
    }
    if (value.type === 'miniapp') {
      const app = miniapps.find((a) => a.id === value.id)
      return <SourceRow icon={AppWindow} label={app?.title ?? value.id} sub={app?.sub} />
    }
    const folder = folders.find((f) => f.id === value.id)
    return <SourceRow icon={FolderInput} label={folder?.label ?? value.id} sub={folder?.path} />
  })()

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="min-w-0 flex-1 text-left">
            {triggerLabel ?? <span className="text-muted-foreground">{placeholder}</span>}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-60 p-0">
        <Command>
          <div className="border-b border-border p-1.5">
            <ToggleGroup
              type="single"
              value={category}
              onValueChange={(v) => v && setCategory(v as Category)}
              size="sm"
              spacing={2}
              className="w-full"
            >
              <CategoryTab value="all" label={t('files.sources.all')} />
              {agents.length > 0 && <CategoryTab value="agent" label={t('files.sources.agents')} />}
              {miniapps.length > 0 && <CategoryTab value="miniapp" label={t('files.sources.miniapps')} />}
              <CategoryTab value="folder" label={t('files.sources.folders')} />
            </ToggleGroup>
          </div>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t('files.sources.searchPlaceholder')}
          />
          <CommandList>
            <CommandEmpty>{t('files.sources.empty')}</CommandEmpty>
            {showAgents && (
              <CommandGroup heading={t('files.sources.agents')}>
                {agents.map((agent) => (
                  <CommandItem
                    key={`agent:${agent.id}`}
                    value={`${agent.name} ${agent.id}`}
                    onSelect={() => select({ type: 'agent', id: agent.id })}
                    className="py-2"
                  >
                    <AgentSelectItem agent={agent} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showMiniApps && (
              <CommandGroup heading={t('files.sources.miniapps')}>
                {miniapps.map((app) => (
                  <CommandItem
                    key={`miniapp:${app.id}`}
                    value={`${app.title} ${app.sub ?? ''} ${app.id}`}
                    onSelect={() => select({ type: 'miniapp', id: app.id })}
                    className="py-2"
                  >
                    <SourceRow icon={AppWindow} label={app.title} sub={app.sub} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {showFolders && (
              <CommandGroup heading={t('files.sources.folders')}>
                {folders.map((folder) => (
                  <CommandItem
                    key={`folder:${folder.id}`}
                    value={`${folder.label} ${folder.path} ${folder.id}`}
                    onSelect={() => select({ type: 'folder', id: folder.id })}
                    className="py-2"
                  >
                    <SourceRow icon={FolderInput} label={folder.label} sub={folder.path} />
                  </CommandItem>
                ))}
                {!search && (
                  <CommandItem
                    value="__add_folder__"
                    onSelect={() => {
                      setOpen(false)
                      onAddFolder()
                    }}
                    className="py-2 text-muted-foreground"
                  >
                    <SourceRow icon={Plus} label={t('files.sources.addFolder')} />
                  </CommandItem>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function CategoryTab({ value, label }: { value: string; label: string }) {
  return (
    <ToggleGroupItem
      value={value}
      className="h-7 flex-1 px-2 text-xs data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
    >
      {label}
    </ToggleGroupItem>
  )
}

function SourceRow({ icon: Icon, label, sub }: { icon: typeof FolderInput; label: string; sub?: string }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-2.5 text-left')}>
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {sub && <span className="block truncate text-[10px] leading-tight text-muted-foreground">{sub}</span>}
      </div>
    </div>
  )
}
