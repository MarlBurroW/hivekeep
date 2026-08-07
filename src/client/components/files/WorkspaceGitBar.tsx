import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover'
import { ScrollArea } from '@/client/components/ui/scroll-area'
import { api, getErrorMessage } from '@/client/lib/api'
import { sourceApiBase, sourceQuery, sourceKey } from '@/client/lib/workspace-source'
import { getFileIcon } from '@/client/lib/file-icons'
import { cn } from '@/client/lib/utils'
import type { WorkspaceSourceRef, WorkspaceGitStatusDTO } from '@/shared/types'

interface GitChange {
  path: string
  status: string
}

interface WorkspaceGitBarProps {
  source: WorkspaceSourceRef
  gitStatus: WorkspaceGitStatusDTO | null
  /** Open a changed file from the git panel. */
  onOpenFile?: (path: string) => void
}

/** Color the two-letter porcelain status (added/modified/deleted/untracked). */
function statusClass(status: string): string {
  if (status === '??' || status.includes('A')) return 'text-success'
  if (status.includes('D')) return 'text-destructive'
  if (status.includes('R') || status.includes('C')) return 'text-info'
  return 'text-warning-foreground'
}

/**
 * Secondary bar under the source selector when the browsed source is a git
 * repo: current branch + uncommitted-change count. The dirty badge opens a
 * popover listing the changed files; clicking one opens it. Renders nothing
 * when the source is not a repo.
 */
export function WorkspaceGitBar({ source, gitStatus, onOpenFile }: WorkspaceGitBarProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [changes, setChanges] = useState<GitChange[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch the change list when the popover opens; refetch when the source or the
  // dirty count changes (live updates flow through gitStatus).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setChanges(null)
    setError(null)
    api
      .get<{ changes: GitChange[] }>(`${sourceApiBase(source)}/git-changes${sourceQuery(source)}`)
      .then((res) => {
        if (!cancelled) setChanges(res.changes)
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceKey(source), gitStatus?.dirtyCount])

  if (!gitStatus) return null

  return (
    <div className="px-2 pb-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={gitStatus.branch}>
        <GitBranch className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono">{gitStatus.branch}</span>
        {gitStatus.dirtyCount > 0 && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ml-auto shrink-0 rounded-full bg-warning/15 px-1.5 py-px font-medium text-warning-foreground transition-colors hover:bg-warning/25"
                title={t('files.git.dirty', { count: gitStatus.dirtyCount })}
              >
                {gitStatus.dirtyCount}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <div className="border-b border-border px-3 py-2 text-xs font-medium">
                {t('files.git.changedTitle')}
              </div>
              <ScrollArea className="max-h-72">
                <div className="p-1">
                  {error ? (
                    <div className="px-2 py-3 text-xs text-destructive">{error}</div>
                  ) : changes === null ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground">…</div>
                  ) : changes.length === 0 ? (
                    <div className="px-2 py-3 text-xs text-muted-foreground">{t('files.git.clean')}</div>
                  ) : (
                    changes.map((ch) => {
                      const name = ch.path.split('/').pop() ?? ch.path
                      const Icon = getFileIcon(name)
                      return (
                        <button
                          key={ch.path}
                          type="button"
                          onClick={() => {
                            setOpen(false)
                            onOpenFile?.(ch.path)
                          }}
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-muted"
                          title={ch.path}
                        >
                          <span className={cn('w-5 shrink-0 text-center font-mono text-[10px] font-bold', statusClass(ch.status))}>
                            {ch.status || '•'}
                          </span>
                          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <span className="min-w-0 max-w-[45%] truncate text-[10px] text-muted-foreground">{ch.path}</span>
                        </button>
                      )
                    })
                  )}
                </div>
              </ScrollArea>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  )
}
