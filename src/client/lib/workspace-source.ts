import type { WorkspaceSourceRef } from '@/shared/types'

/**
 * Client helpers for the generalized Files API (agent / folder / mini-app
 * sources). Every workspace hook builds its URLs and SSE filters through these
 * so the source is threaded consistently.
 */

/** REST base for a source: `/workspace/<type>/<id>` (no query). */
export function sourceApiBase(source: WorkspaceSourceRef): string {
  return `/workspace/${source.type}/${encodeURIComponent(source.id)}`
}

/** Query string for a source request. */
export function sourceQuery(_source: WorkspaceSourceRef, params: Record<string, string> = {}): string {
  const s = new URLSearchParams(params).toString()
  return s ? `?${s}` : ''
}

/** Stable string key (storage, dedupe, dependency arrays). */
export function sourceKey(source: WorkspaceSourceRef): string {
  return `${source.type}:${source.id}`
}

export function sameSource(a: WorkspaceSourceRef | null | undefined, b: WorkspaceSourceRef | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.type === b.type && a.id === b.id
}

/** Does a workspace:changed event apply to the source currently in view? */
export function changeMatchesSource(
  data: { agentId?: string; source?: WorkspaceSourceRef },
  active: WorkspaceSourceRef,
): boolean {
  if (data.source) return sameSource(data.source, active)
  // Legacy agent event without a source field.
  return active.type === 'agent' && data.agentId === active.id
}

/** Raw bytes URL (download / inline image|pdf view). */
export function workspaceRawUrl(source: WorkspaceSourceRef, path: string, inline = false): string {
  const params: Record<string, string> = { path }
  if (inline) params.inline = '1'
  return `/api${sourceApiBase(source)}/raw${sourceQuery(source, params)}`
}

/** Server-rendered PDF of an HTML file (Files section export). */
export function workspaceExportPdfUrl(source: WorkspaceSourceRef, path: string): string {
  return `/api${sourceApiBase(source)}/export-pdf${sourceQuery(source, { path })}`
}
