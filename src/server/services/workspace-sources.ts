import { realpathSync } from 'node:fs'
import { resolveAgentByIdOrSlug } from '@/server/services/agent-resolver'
import { agentTarget, WorkspaceFilesError, type WorkspaceTarget } from '@/server/services/workspace-files'
import { getWorkspaceFolder } from '@/server/services/workspace-folders'
import { getMiniApp, getAppDir } from '@/server/services/mini-apps'
import type { WorkspaceSourceType } from '@/shared/types'

/**
 * Resolves a Files-section browse source (agent / folder / mini-app) to a
 * concrete {@link WorkspaceTarget}. The containment + mutation logic lives in
 * workspace-files.ts and is identical for every source — only the root and the
 * SSE scope differ.
 */

export class WorkspaceSourceError extends Error {
  constructor(
    public readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_NOT_READY' | 'SOURCE_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'WorkspaceSourceError'
  }
}

export async function resolveWorkspaceSource(type: string, id: string): Promise<WorkspaceTarget> {
  switch (type as WorkspaceSourceType) {
    case 'agent': {
      const agent = resolveAgentByIdOrSlug(id)
      if (!agent) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Agent not found')
      // Use the canonical id so the SSE scope matches sendToAgent.
      return agentTarget(agent.id)
    }
    case 'folder': {
      const folder = getWorkspaceFolder(id)
      if (!folder) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Folder not found')
      // Re-canonicalize on every browse: a folder removed from disk must fail
      // cleanly, not silently resolve to an empty/escaped root.
      let root: string
      try {
        root = realpathSync(folder.path)
      } catch {
        throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Folder no longer exists on disk')
      }
      return { root, source: { type: 'folder', id } }
    }
    case 'miniapp': {
      // id = the mini-app id; its on-disk dir is keyed by the (reassignable)
      // maintainer agent, so resolve the maintainer from the row each time.
      const app = await getMiniApp(id)
      if (!app) throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Mini-app not found')
      let root: string
      try {
        root = realpathSync(getAppDir(app.maintainerAgentId, app.id))
      } catch {
        throw new WorkspaceSourceError('SOURCE_NOT_FOUND', 'Mini-app directory no longer exists on disk')
      }
      return { root, source: { type: 'miniapp', id } }
    }
    default:
      throw new WorkspaceSourceError('SOURCE_INVALID', `Unknown source type: ${type}`)
  }
}

/** Re-export so route handlers can narrow both error families in one catch. */
export { WorkspaceFilesError }
