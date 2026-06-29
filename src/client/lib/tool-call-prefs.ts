/**
 * Client-side UI preference: whether tool-call blocks start expanded.
 *
 * Persisted in localStorage (like the palette / contrast preferences) and read
 * at mount by the tool-call renderers across every chat surface (main chat,
 * quick session, task panel). It only controls the *initial* open state — once
 * a user expands or collapses an individual call, that interaction wins.
 */

const STORAGE_KEY = 'gezy-tools-default-open'

/** Returns true when tool calls should be expanded by default. Defaults to false. */
export function getToolCallsDefaultOpen(): boolean {
  if (typeof window === 'undefined') return false
  return localStorage.getItem(STORAGE_KEY) === 'true'
}

/** Persists the "tool calls expanded by default" preference. */
export function setToolCallsDefaultOpen(value: boolean): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false')
}
