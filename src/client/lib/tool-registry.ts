/**
 * Tool renderer registry storage.
 * Isolated module with zero imports to prevent circular dependency issues.
 */
import type { ComponentType } from 'react'

export interface ToolResultRendererProps {
  toolName: string
  args: Record<string, unknown>
  result: unknown
  status: 'success' | 'error' | 'pending'
}

export interface ToolPreviewRendererProps {
  toolName: string
  args: Record<string, unknown>
  status: 'success' | 'error' | 'pending'
}

/** Returns a short string (or null to fall back to default) */
export type ToolPreviewFn = (props: ToolPreviewRendererProps) => string | null

// --- Result renderer registry (expanded view) ---

const registry = new Map<string, ComponentType<ToolResultRendererProps>>()

export function registerRenderer(toolName: string, component: ComponentType<ToolResultRendererProps>) {
  registry.set(toolName, component)
}

export function getRenderer(toolName: string): ComponentType<ToolResultRendererProps> | undefined {
  return registry.get(toolName)
}

// --- Preview renderer registry (collapsed inline view) ---

const previewRegistry = new Map<string, ToolPreviewFn>()

export function registerPreviewRenderer(toolName: string, fn: ToolPreviewFn) {
  // chat:tool-call-start can render a preview before streamed tool args have
  // arrived. Normalize here so every current/future preview renderer can read
  // fields like args.title / args.todos / args.command without crashing while
  // the call is still pending.
  previewRegistry.set(toolName, (props) => fn({ ...props, args: props.args ?? {} }))
}

export function getPreviewRenderer(toolName: string): ToolPreviewFn | undefined {
  return previewRegistry.get(toolName)
}
