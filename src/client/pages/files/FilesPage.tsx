import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Folder, FolderTree, RefreshCw, Loader2, FilePlus2, Search } from 'lucide-react'
import { toastError } from '@/client/lib/api'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { EmptyState } from '@/client/components/common/EmptyState'
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
import { useWorkspaceFolders } from '@/client/hooks/useWorkspaceFolders'
import { useMiniApps } from '@/client/hooks/useMiniApps'
import { useWorkspaceGit } from '@/client/hooks/useWorkspaceGit'
import { appendToDraft } from '@/client/hooks/useDraftMessage'
import {
  useWorkspaceFiles,
  parentDirOf,
  setWorkspaceClipboard,
  getWorkspaceClipboard,
} from '@/client/hooks/useWorkspaceFiles'
import { useWorkspaceTabs } from '@/client/hooks/useWorkspaceTabs'
import { WorkspaceTree, type WorkspaceTreeActions } from '@/client/components/files/WorkspaceTree'
import { WorkspaceSourceSelector } from '@/client/components/files/WorkspaceSourceSelector'
import { WorkspaceGitBar } from '@/client/components/files/WorkspaceGitBar'
import { AddFolderDialog } from '@/client/components/files/AddFolderDialog'
import { FileStorageFormDialog } from '@/client/components/file-storage/FileStorageFormDialog'
import { WorkspaceEditor, workspaceRawUrl } from '@/client/components/files/WorkspaceEditor'
import { FileTabs, type FileTabActions } from '@/client/components/files/FileTabs'
import { ResizableSidebar } from '@/client/components/files/ResizableSidebar'
import { WorkspaceQuickOpen } from '@/client/components/files/WorkspaceQuickOpen'
import { sameSource } from '@/client/lib/workspace-source'
import type { WorkspaceEntry, WorkspaceSourceRef } from '@/shared/types'

const LAST_SOURCE_KEY = 'files.lastSource'

function readLastSource(): WorkspaceSourceRef | null {
  try {
    const raw = localStorage.getItem(LAST_SOURCE_KEY)
    return raw ? (JSON.parse(raw) as WorkspaceSourceRef) : null
  } catch {
    return null
  }
}

/**
 * Files section (files.md § 3-4): VSCode-like browser/editor over a workspace
 * SOURCE — an agent workspace, a mini-app source dir or a user-added FS folder.
 * Deep-linkable as /files/:agentId, /files/folder/:id or /files/miniapp/:id
 * (with ?path=).
 */
export function FilesPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const params = useParams<{ agentId?: string; sourceType?: string; sourceId?: string }>()
  const [searchParams] = useSearchParams()
  const requestedPath = searchParams.get('path')

  const { agents, isLoading: agentsLoading } = useAgentList()
  const foldersApi = useWorkspaceFolders()
  const { apps: miniApps } = useMiniApps(null, 'all')
  const [addFolderOpen, setAddFolderOpen] = useState(false)

  const miniAppOptions = useMemo(
    () => miniApps.map((a) => ({ id: a.id, title: a.name, sub: a.maintainerAgentName })),
    [miniApps],
  )

  // Source from the route: explicit folder/mini-app, or legacy agent id/slug.
  const routeSource = useMemo<WorkspaceSourceRef | null>(() => {
    if (
      params.sourceType &&
      params.sourceId &&
      (params.sourceType === 'folder' || params.sourceType === 'miniapp')
    ) {
      return { type: params.sourceType, id: params.sourceId }
    }
    if (params.agentId) {
      const agent = agents.find((a) => a.id === params.agentId || a.slug === params.agentId)
      if (agent) return { type: 'agent', id: agent.id }
    }
    return null
  }, [params.sourceType, params.sourceId, params.agentId, agents])

  // Fallback when no route source: last-used (if still valid) else first agent.
  const fallbackSource = useMemo<WorkspaceSourceRef | null>(() => {
    const last = readLastSource()
    if (last) {
      if (last.type === 'agent' && agents.some((a) => a.id === last.id)) return last
      if (last.type === 'folder' && foldersApi.folders.some((f) => f.id === last.id)) return last
      if (last.type === 'miniapp') return last // validity re-checked server-side
    }
    return agents[0] ? { type: 'agent', id: agents[0].id } : null
  }, [agents, foldersApi.folders])

  const source = routeSource ?? fallbackSource
  const activeAgentId = source?.type === 'agent' ? source.id : null

  useEffect(() => {
    if (source) localStorage.setItem(LAST_SOURCE_KEY, JSON.stringify(source))
  }, [source])

  const handleSourceChange = (next: WorkspaceSourceRef) => {
    navigate(next.type === 'agent' ? `/files/${next.id}` : `/files/${next.type}/${next.id}`)
  }

  const { gitStatus } = useWorkspaceGit(source)

  const workspace = useWorkspaceFiles(source)
  const tabsApi = useWorkspaceTabs(source)
  const tabsApiRef = useRef(tabsApi)
  tabsApiRef.current = tabsApi

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [treeSheetOpen, setTreeSheetOpen] = useState(false)
  const [closingTab, setClosingTab] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceEntry | null>(null)
  const [shareTarget, setShareTarget] = useState<WorkspaceEntry | null>(null)
  const [quickOpenOpen, setQuickOpenOpen] = useState(false)

  const openPath = useCallback(
    (path: string) => {
      setSelectedPath(path)
      workspace.expandTo(path)
      tabsApi.openTab(path)
    },
    [workspace, tabsApi],
  )

  // Deep link: open ?path= once the source resolved.
  useEffect(() => {
    if (!source || !requestedPath) return
    openPath(requestedPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, requestedPath])

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
      if (!source) return
      const anchor = document.createElement('a')
      anchor.href = workspaceRawUrl(source, entry.path)
      anchor.download = entry.name
      anchor.click()
    },
    copyRelativePath: (entry) => {
      void navigator.clipboard.writeText(entry.path)
      toast.success(t('files.tree.pathCopied'))
    },
    clipboardSet: (entry, op) => {
      if (!source) return
      setWorkspaceClipboard({ source, path: entry.path, isDirectory: entry.type === 'dir', op })
    },
    clipboardPaste: async (destDir) => {
      const clip = getWorkspaceClipboard()
      if (!clip || !source) return
      const name = clip.path.split('/').pop() ?? clip.path
      const to = destDir ? `${destDir}/${name}` : name
      // Cross-source paste passes the origin source so the server validates each side.
      const fromSource = sameSource(clip.source, source) ? undefined : clip.source
      try {
        if (clip.op === 'copy') {
          await workspace.copyPath(clip.path, to, fromSource)
        } else {
          await workspace.movePath(clip.path, to, fromSource)
          setWorkspaceClipboard(null)
        }
      } catch (err) {
        toastError(err)
      }
    },
    // Share + insert-in-chat are agent-only: a folder or mini-app dir has no
    // associated conversation. Omitting the handler hides the menu item (no
    // dead affordance). Share is generalized to every source in P6.
    share: activeAgentId ? (entry) => setShareTarget(entry) : undefined,
    insertInChat: activeAgentId
      ? (entry) => {
          // Write the draft BEFORE navigating (no composer mount race) — the
          // path goes in backticks, same convention as the @ palette (§ 5.3).
          appendToDraft(activeAgentId, `\`${entry.path}\``)
          const agent = agents.find((a) => a.id === activeAgentId)
          navigate(`/agent/${agent?.slug ?? activeAgentId}`)
        }
      : undefined,
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

  // Page-scoped shortcuts (files.md § 3.7): Mod+P / Mod+S preventDefault the
  // browser dialogs; Alt+W replaces the browser-reserved Ctrl+W. Mod+S inside
  // CodeMirror is handled by the editor's own keymap.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        tabsApiRef.current.reopenLastClosed()
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setQuickOpenOpen(true)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        const active = tabsApiRef.current.active
        if (active && tabsApiRef.current.states[active]?.dirty) void tabsApiRef.current.save(active)
      } else if (e.altKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        const active = tabsApiRef.current.active
        if (active) requestCloseTabRef.current(active)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleSelectFile = (entry: WorkspaceEntry) => {
    setTreeSheetOpen(false)
    openPath(entry.path)
  }

  const requestCloseTab = (path: string) => {
    if (tabsApi.states[path]?.dirty) {
      setClosingTab(path)
    } else {
      tabsApi.forceCloseTab(path)
    }
  }
  const requestCloseTabRef = useRef(requestCloseTab)
  requestCloseTabRef.current = requestCloseTab

  // Bulk close keeps dirty tabs open (no silent data loss); clean tabs close now.
  const closeCleanTabs = (paths: string[]) => {
    for (const p of paths) {
      if (!tabsApi.states[p]?.dirty) tabsApi.forceCloseTab(p)
    }
  }
  const tabActions: FileTabActions = {
    closeOthers: (path) => closeCleanTabs(tabsApi.tabs.filter((p) => p !== path)),
    closeToRight: (path) => closeCleanTabs(tabsApi.tabs.slice(tabsApi.tabs.indexOf(path) + 1)),
    closeAll: () => closeCleanTabs([...tabsApi.tabs]),
    copyPath: (path) => {
      void navigator.clipboard.writeText(path)
      toast.success(t('files.tree.pathCopied'))
    },
    reveal: (path) => {
      setSelectedPath(path)
      workspace.expandTo(path)
      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
        setTreeSheetOpen(true)
      }
    },
  }

  const rootState = workspace.dirs['']
  const workspaceIsEmpty = rootState?.entries != null && rootState.entries.length === 0

  const treePanel = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border p-2">
        <WorkspaceSourceSelector
          value={source}
          onChange={handleSourceChange}
          agents={agents.map((a) => ({ id: a.id, name: a.name, role: a.role, avatarUrl: a.avatarUrl }))}
          folders={foldersApi.folders}
          miniapps={miniAppOptions}
          onAddFolder={() => setAddFolderOpen(true)}
          placeholder={t('files.selectWorkspace')}
        />
      </div>
      {source && (
        <WorkspaceGitBar source={source} gitStatus={gitStatus} onOpenFile={openPath} />
      )}
      <WorkspaceTree
        dirs={workspace.dirs}
        expanded={workspace.expanded}
        selectedPath={selectedPath}
        onToggleDir={workspace.toggleDir}
        onSelectFile={handleSelectFile}
        onSelectDir={(entry) => setSelectedPath(entry.path)}
        onRetryDir={(path) => void workspace.loadDir(path)}
        onRefresh={workspace.refresh}
        onCollapseAll={workspace.collapseAll}
        onExpandAll={workspace.expandAllLoaded}
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
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setQuickOpenOpen(true)}
              aria-label={t('files.search.open')}
              title={t('files.search.open')}
            >
              <Search className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={workspace.refresh} aria-label={t('files.refresh')} title={t('files.refresh')}>
              <RefreshCw className="size-4" />
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <ResizableSidebar storageKey="files.treeWidth">{treePanel}</ResizableSidebar>
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
          ) : !source ? (
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
                onReorder={tabsApi.reorderTabs}
                actions={tabActions}
              />
              {activeTab && activeState && source ? (
                <WorkspaceEditor
                  source={source}
                  path={activeTab}
                  state={activeState}
                  onChangeDraft={(value) => tabsApi.updateDraft(activeTab, value)}
                  onSave={(opts) => tabsApi.save(activeTab, opts)}
                  onReload={() => void tabsApi.reload(activeTab)}
                  gitRepo={!!gitStatus}
                  onRevealDir={(dir) => {
                    setSelectedPath(dir)
                    workspace.expandTo(`${dir}/x`)
                    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
                      setTreeSheetOpen(true)
                    }
                  }}
                  onRevealFile={(p) => {
                    setSelectedPath(p)
                    workspace.expandTo(p)
                    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) {
                      setTreeSheetOpen(true)
                    }
                  }}
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

      <WorkspaceQuickOpen
        open={quickOpenOpen}
        onOpenChange={setQuickOpenOpen}
        source={source}
        onPick={(path) => openPath(path)}
      />

      <AddFolderDialog
        open={addFolderOpen}
        onOpenChange={setAddFolderOpen}
        folders={foldersApi.folders}
        onCreate={foldersApi.create}
        onRemove={foldersApi.remove}
        onAdded={(folder) => navigate(`/files/folder/${folder.id}`)}
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
