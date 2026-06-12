import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Folder, FolderTree, RefreshCw, Loader2, FilePlus2 } from 'lucide-react'
import { toastError } from '@/client/lib/api'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { EmptyState } from '@/client/components/common/EmptyState'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import { UnsavedChangesDialog } from '@/client/components/common/UnsavedChangesDialog'
import { Button } from '@/client/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/client/components/ui/sheet'
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
import { useAgentList } from '@/client/hooks/useAgentList'
import {
  useWorkspaceFiles,
  parentDirOf,
  setWorkspaceClipboard,
  getWorkspaceClipboard,
} from '@/client/hooks/useWorkspaceFiles'
import { useWorkspaceTabs } from '@/client/hooks/useWorkspaceTabs'
import { WorkspaceTree, type WorkspaceTreeActions } from '@/client/components/files/WorkspaceTree'
import { FileStorageFormDialog } from '@/client/components/file-storage/FileStorageFormDialog'
import { WorkspaceEditor, workspaceRawUrl } from '@/client/components/files/WorkspaceEditor'
import { FileTabs } from '@/client/components/files/FileTabs'
import type { WorkspaceEntry } from '@/shared/types'

const LAST_AGENT_KEY = 'files.lastAgentId'

/**
 * Files section (files.md § 3-4): VSCode-like browser/editor over agent
 * workspaces. Deep-linkable as /files/:agentId?path=relative/path.
 */
export function FilesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { agentId: routeAgentId } = useParams<{ agentId?: string }>()
  const [searchParams] = useSearchParams()
  const requestedPath = searchParams.get('path')

  const { agents, isLoading: agentsLoading } = useAgentList()

  // Active workspace: route param > localStorage > first agent.
  const storedAgentId = localStorage.getItem(LAST_AGENT_KEY)
  const activeAgentId =
    (routeAgentId ? (agents.find((a) => a.id === routeAgentId || a.slug === routeAgentId)?.id ?? null) : null) ??
    (storedAgentId && agents.some((a) => a.id === storedAgentId) ? storedAgentId : null) ??
    agents[0]?.id ??
    null

  useEffect(() => {
    if (activeAgentId) localStorage.setItem(LAST_AGENT_KEY, activeAgentId)
  }, [activeAgentId])

  const workspace = useWorkspaceFiles(activeAgentId)
  const tabsApi = useWorkspaceTabs(activeAgentId)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeSheetOpen, setTreeSheetOpen] = useState(false)
  const [closingTab, setClosingTab] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)
  const [shareTarget, setShareTarget] = useState<WorkspaceEntry | null>(null)

  const openPath = useCallback(
    (path: string) => {
      setSelectedPath(path)
      workspace.expandTo(path)
      tabsApi.openTab(path)
    },
    [workspace, tabsApi],
  )

  // Deep link: open ?path= once the agent list resolved the workspace.
  useEffect(() => {
    if (!activeAgentId || !requestedPath) return
    openPath(requestedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, requestedPath])

  // Dead deep-link feedback (file vanished): the tab state flags deletedOnDisk.
  useEffect(() => {
    if (!requestedPath) return
    const state = tabsApi.states[requestedPath]
    if (state?.deletedOnDisk && !state.dirty) {
      toast.error(t('files.notFound', { path: requestedPath }))
      tabsApi.forceCloseTab(requestedPath)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabsApi.states[requestedPath ?? '']?.deletedOnDisk])

  /** Close (or retarget after rename) the tabs touched by a tree mutation. */
  const closeTabsUnder = useCallback(
    (path: string, isDir: boolean) => {
      for (const tab of tabsApi.tabs) {
        if (tab === path || (isDir && tab.startsWith(path + '/'))) tabsApi.forceCloseTab(tab)
      }
    },
    [tabsApi],
  )

  const treeActions: WorkspaceTreeActions = {
    createFile: async (dirPath, name) => {
      try {
        const path = await workspace.createFile(dirPath, name)
        openPath(path)
      } catch (err) {
        toastError(err)
      }
    },
    createDir: async (dirPath, name) => {
      try {
        await workspace.createDir(dirPath, name)
      } catch (err) {
        toastError(err)
      }
    },
    rename: async (entry, newName) => {
      const parent = parentDirOf(entry.path)
      const to = parent ? `${parent}/${newName}` : newName
      try {
        const finalPath = await workspace.movePath(entry.path, to)
        const wasOpen = tabsApi.tabs.includes(entry.path)
        closeTabsUnder(entry.path, entry.type === 'dir')
        if (wasOpen && entry.type === 'file') tabsApi.openTab(finalPath)
        if (selectedPath === entry.path) setSelectedPath(finalPath)
      } catch (err) {
        toastError(err)
      }
    },
    moveInto: async (entry, destDir) => {
      const to = destDir ? `${destDir}/${entry.name}` : entry.name
      try {
        const finalPath = await workspace.movePath(entry.path, to)
        const wasOpen = tabsApi.tabs.includes(entry.path)
        closeTabsUnder(entry.path, entry.type === 'dir')
        if (wasOpen && entry.type === 'file') tabsApi.openTab(finalPath)
      } catch (err) {
        toastError(err)
      }
    },
    requestDelete: (entry) => setDeleteTarget(entry),
    download: (entry) => {
      if (!activeAgentId) return
      const anchor = document.createElement('a')
      anchor.href = workspaceRawUrl(activeAgentId, entry.path)
      anchor.download = entry.name
      anchor.click()
    },
    copyRelativePath: (entry) => {
      void navigator.clipboard.writeText(entry.path)
      toast.success(t('files.tree.pathCopied'))
    },
    clipboardSet: (entry, op) => {
      if (!activeAgentId) return
      setWorkspaceClipboard({ agentId: activeAgentId, path: entry.path, isDirectory: entry.type === 'dir', op })
    },
    clipboardPaste: async (destDir) => {
      const clip = getWorkspaceClipboard()
      if (!clip || !activeAgentId) return
      const name = clip.path.split('/').pop() ?? clip.path
      const to = destDir ? `${destDir}/${name}` : name
      const fromAgentId = clip.agentId !== activeAgentId ? clip.agentId : undefined
      try {
        if (clip.op === 'copy') {
          await workspace.copyPath(clip.path, to, fromAgentId)
        } else {
          await workspace.movePath(clip.path, to, fromAgentId)
          setWorkspaceClipboard(null)
        }
      } catch (err) {
        toastError(err)
      }
    },
    share: (entry) => setShareTarget(entry),
    uploadTo: async (dirPath, files) => {
      try {
        const result = await workspace.uploadFiles(dirPath, files)
        if (result.errors.length > 0) {
          toast.error(t('files.tree.uploadErrors', { count: result.errors.length, name: result.errors[0]!.name }))
        } else {
          toast.success(t('files.tree.uploaded', { count: result.files.length }))
        }
        workspace.expandTo(`${dirPath}/x`)
      } catch (err) {
        toastError(err)
      }
    },
  }

  const confirmDelete = async () => {
    const entry = deleteTarget
    setDeleteTarget(null)
    if (!entry) return
    try {
      await workspace.removePath(entry.path)
      closeTabsUnder(entry.path, entry.type === 'dir')
      if (selectedPath === entry.path) setSelectedPath(null)
    } catch (err) {
      toastError(err)
    }
  }

  const handleSelectFile = (entry: WorkspaceEntry) => {
    setTreeSheetOpen(false)
    openPath(entry.path)
  }

  const handleAgentChange = (id: string) => navigate(`/files/${id}`)

  const requestCloseTab = (path: string) => {
    if (tabsApi.states[path]?.dirty) {
      setClosingTab(path)
    } else {
      tabsApi.forceCloseTab(path)
    }
  }

  const rootState = workspace.dirs['']
  const workspaceIsEmpty = rootState?.entries != null && rootState.entries.length === 0

  const treePanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <AgentSelector
          value={activeAgentId ?? ''}
          onValueChange={handleAgentChange}
          agents={agents.map((a) => ({ id: a.id, name: a.name, role: a.role, avatarUrl: a.avatarUrl }))}
          placeholder={t('files.selectWorkspace')}
        />
      </div>
      <WorkspaceTree
        dirs={workspace.dirs}
        expanded={workspace.expanded}
        selectedPath={selectedPath}
        onToggleDir={workspace.toggleDir}
        onSelectFile={handleSelectFile}
        onSelectDir={(entry) => setSelectedPath(entry.path)}
        onRetryDir={(path) => void workspace.loadDir(path)}
        onRefresh={workspace.refresh}
        actions={treeActions}
      />
      {workspaceIsEmpty && (
        <div className="px-4 pb-4 text-center text-xs text-muted-foreground">{t('files.empty.description')}</div>
      )}
    </div>
  )

  const activeTab = tabsApi.active
  const activeState = activeTab ? tabsApi.states[activeTab] : undefined

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={Folder}
        title={t('activityBar.files')}
        leading={
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            onClick={() => setTreeSheetOpen(true)}
            aria-label={t('files.openTree')}
          >
            <FolderTree className="size-4" />
          </Button>
        }
        actions={
          <Button variant="ghost" size="icon-sm" onClick={workspace.refresh} aria-label={t('files.refresh')} title={t('files.refresh')}>
            <RefreshCw className="size-4" />
          </Button>
        }
      />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 border-r border-border md:flex md:flex-col lg:w-72">{treePanel}</aside>
        <Sheet open={treeSheetOpen} onOpenChange={setTreeSheetOpen}>
          <SheetContent side="left" className="w-80 p-0 md:hidden">
            <SheetTitle className="sr-only">{t('activityBar.files')}</SheetTitle>
            {treePanel}
          </SheetContent>
        </Sheet>

        <main className="flex min-w-0 flex-1 flex-col">
          {agentsLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : !activeAgentId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState icon={Folder} title={t('files.noAgents.title')} description={t('files.noAgents.description')} />
            </div>
          ) : (
            <>
              <FileTabs
                tabs={tabsApi.tabs}
                active={activeTab}
                dirtyPaths={new Set(Object.entries(tabsApi.states).filter(([, s]) => s.dirty).map(([p]) => p))}
                onSelect={(path) => {
                  setSelectedPath(path)
                  tabsApi.focusTab(path)
                }}
                onClose={requestCloseTab}
              />
              {activeTab && activeState ? (
                <WorkspaceEditor
                  agentId={activeAgentId}
                  path={activeTab}
                  state={activeState}
                  onChangeDraft={(value) => tabsApi.updateDraft(activeTab, value)}
                  onSave={(opts) => void tabsApi.save(activeTab, opts)}
                  onReload={() => void tabsApi.reload(activeTab)}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center p-6">
                  <EmptyState
                    icon={FilePlus2}
                    title={t('files.noFileOpen.title')}
                    description={t('files.noFileOpen.description')}
                  />
                </div>
              )}
            </>
          )}
        </main>
      </div>

      <UnsavedChangesDialog
        open={closingTab !== null}
        onConfirm={() => {
          if (closingTab) tabsApi.forceCloseTab(closingTab)
          setClosingTab(null)
        }}
        onCancel={() => setClosingTab(null)}
      />

      {activeAgentId && (
        <FileStorageFormDialog
          open={shareTarget !== null}
          onOpenChange={(open) => !open && setShareTarget(null)}
          workspaceSource={shareTarget ? { agentId: activeAgentId, path: shareTarget.path } : null}
          agents={[]}
          onSaved={(file) => {
            if (file?.url) {
              void navigator.clipboard.writeText(file.url)
              toast.success(t('files.share.urlCopied'))
            }
          }}
        />
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('files.tree.deleteConfirm.title', { name: deleteTarget?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === 'dir'
                ? t('files.tree.deleteConfirm.folderDescription')
                : t('files.tree.deleteConfirm.fileDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDelete()}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
