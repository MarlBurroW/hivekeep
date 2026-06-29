/**
 * Tool types — SDK re-exports plus a host-side extension to the
 * execution context so native tools (`http_request`, etc.) can read
 * per-Agent authorization fields without dropping into `unknown` casts.
 *
 * The SDK's `ToolExecutionContext` is the public plugin contract and
 * stays minimal on purpose — plugins receive the same context shape
 * at runtime but don't get typed access to host-internal fields they
 * shouldn't be reading. Server-internal tool files import from this
 * module instead of `@gezy/sdk` directly so they get the
 * widened context.
 */

import type {
  ToolExecutionContext as SdkToolExecutionContext,
  ToolFactory as SdkToolFactory,
  ToolRegistration as SdkToolRegistration,
  Tool,
} from '@gezy/sdk'

export type { ToolAvailability } from '@gezy/sdk'

/**
 * Server-side widened execution context. Same as the SDK's shape plus a
 * per-task `workspaceOverride`. Tool grants are resolved entirely through
 * toolboxes now (see services/toolset-resolver.ts) — there is no per-Agent tool
 * config threaded through the context anymore.
 */
export interface ToolExecutionContext extends SdkToolExecutionContext {
  /** Per-task workspace override. Set by the sub-task runner when the
   *  ticket's project has a ready clone — every filesystem + shell tool
   *  scopes its cwd to `path` instead of the Agent's static workspace, and
   *  `env` is merged into the env of any subprocess the tool spawns
   *  (used to inject `HIVEKEEP_GH_TOKEN` for git network ops without ever
   *  writing the PAT to disk). */
  workspaceOverride?: {
    path: string
    env?: Record<string, string>
  }
}

/** Factory bound to the server-widened execution context. */
export type ToolFactory = (ctx: ToolExecutionContext) => Tool<any, any>

/** Server-side ToolRegistration — same as the SDK shape but the
 *  `create` factory accepts the widened ToolExecutionContext (with
 *  `workspaceOverride`). Assignment-compatible with the SDK shape so plugin
 *  tools registered against the SDK type slot in seamlessly. */
export interface ToolRegistration extends Omit<SdkToolRegistration, 'create'> {
  create: ToolFactory
}

/** Sanity check — the server factory must remain assignment-compatible
 *  with the SDK one so callers that import from the SDK keep working. */
type _AssignableToSdkFactory = ToolFactory extends SdkToolFactory ? true : false
const _factoryAssignmentCheck: _AssignableToSdkFactory = true
void _factoryAssignmentCheck
