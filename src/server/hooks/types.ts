/**
 * Hook types — the SDK is the source of truth.
 *
 * Internal modules import from this file rather than `@gezy/sdk`
 * directly so the existing import paths keep working. The SDK is the
 * single source of truth — see `packages/sdk/src/index.ts` for the
 * authoritative definitions.
 */
export type { HookName, HookHandler, HookPayloadMap } from '@gezy/sdk'
