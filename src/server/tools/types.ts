/**
 * Tool types for server-internal tools.
 *
 * Native tools import their context / factory / registration types from here
 * rather than from `@hivekeep/sdk` directly, so the host keeps one seam where
 * it can widen the execution context for host-only fields without touching
 * every tool file. Right now nothing is widened: the host and plugin contracts
 * are identical.
 */

export type {
  ToolAvailability,
  ToolExecutionContext,
  ToolFactory,
  ToolRegistration,
} from '@hivekeep/sdk'
