/**
 * Workspace resolution for native tools.
 *
 * Each Agent has a static workspace at `<config.workspace.baseDir>/<agentId>/`.
 * Filesystem + shell tools route through this helper rather than building the
 * path themselves, so there is a single place to change if the layout moves.
 */

import { resolve } from 'node:path'
import { config } from '@/server/config'
import type { ToolExecutionContext } from '@/server/tools/types'

/** Absolute path tools should treat as the cwd / workspace root. */
export function resolveToolWorkspace(ctx: ToolExecutionContext): string {
  return resolve(config.workspace.baseDir, ctx.agentId)
}
