import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getPreviewRenderer } from './tool-registry'
import { FileEditRenderer } from '@/client/components/chat/renderers/FileEditRenderer'
import { FileReadRenderer } from '@/client/components/chat/renderers/FileReadRenderer'
import { FileWriteRenderer } from '@/client/components/chat/renderers/FileWriteRenderer'
import './tool-preview-renderers'

describe('tool preview renderers', () => {
  const fileToolNames = [
    'read_file',
    'write_file',
    'edit_file',
    'multi_edit',
    'list_directory',
    'write_mini_app_file',
    'read_mini_app_file',
    'delete_mini_app_file',
  ]

  it('does not throw while file tool args are still pending', () => {
    for (const toolName of fileToolNames) {
      const renderer = getPreviewRenderer(toolName)
      expect(renderer, toolName).toBeDefined()
      expect(() => renderer?.({ toolName, args: undefined as unknown as Record<string, unknown>, status: 'pending' })).not.toThrow()
    }
  })

  it('keeps pending built-in file renderers out of failure state', () => {
    const pendingProps = { args: { path: 'src/app.ts', content: 'hello', oldText: 'a', newText: 'b' }, result: undefined, status: 'pending' as const }

    for (const [toolName, Renderer] of [
      ['read_file', FileReadRenderer],
      ['write_file', FileWriteRenderer],
      ['edit_file', FileEditRenderer],
    ] as const) {
      const html = renderToStaticMarkup(createElement(Renderer, { toolName, ...pendingProps }))
      expect(html.toLowerCase()).not.toContain('failed')
      expect(html.toLowerCase()).not.toContain('error')
    }
  })

  it('does not throw while non-file tool args are still pending', () => {
    const pendingToolNames = [
      'spawn_self',
      'spawn_agent',
      'task_todos',
      'run_shell',
      'add_mcp_server',
    ]

    for (const toolName of pendingToolNames) {
      const renderer = getPreviewRenderer(toolName)
      expect(renderer, toolName).toBeDefined()
      expect(() => renderer?.({ toolName, args: undefined as unknown as Record<string, unknown>, status: 'pending' })).not.toThrow()
    }
  })

  it('keeps completed file previews when args exist', () => {
    expect(getPreviewRenderer('read_file')?.({ toolName: 'read_file', args: { path: 'src/app.ts' }, status: 'success' })).toBe('src/app.ts')
    expect(getPreviewRenderer('multi_edit')?.({
      toolName: 'multi_edit',
      args: { path: 'src/app.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
      status: 'success',
    })).toBe('src/app.ts (2 edits)')
    expect(getPreviewRenderer('list_directory')?.({ toolName: 'list_directory', args: {}, status: 'pending' })).toBe('.')
  })

  it('keeps completed previews for title, todo, and command args', () => {
    expect(getPreviewRenderer('spawn_self')?.({ toolName: 'spawn_self', args: { title: 'Investigate flaky renderer' }, status: 'success' })).toBe('Investigate flaky renderer')
    expect(getPreviewRenderer('task_todos')?.({
      toolName: 'task_todos',
      args: { todos: [{ id: 'a', subject: 'Inspect', status: 'completed' }, { id: 'b', subject: 'Fix', status: 'pending' }] },
      status: 'success',
    })).toBe('1/2')
    expect(getPreviewRenderer('run_shell')?.({ toolName: 'run_shell', args: { command: 'bun run typecheck' }, status: 'success' })).toBe('bun run typecheck')
    expect(getPreviewRenderer('add_mcp_server')?.({ toolName: 'add_mcp_server', args: { name: 'filesystem', command: 'npx -y @modelcontextprotocol/server-filesystem' }, status: 'success' })).toBe('filesystem (npx -y @modelco…)')
  })
})
