import { describe, it, expect } from 'bun:test'
import { getCustomToolDocsTool } from './custom-tool-docs'
import type { ToolExecutionContext } from '@/server/tools/types'

const ctx: ToolExecutionContext = {
  agentId: 'test-agent-id',
  userId: 'test-user-id',
  isSubAgent: false,
}

const toolInstance = getCustomToolDocsTool.create(ctx)

async function execute(section: string) {
  return (toolInstance as any).execute({ section }, {} as any)
}

const KNOWN_SECTIONS = ['authoring', 'renderer']

describe('getCustomToolDocsTool registration', () => {
  it('is available to main agents only', () => {
    expect(getCustomToolDocsTool.availability).toEqual(['main'])
  })

  it('is read-only and concurrency-safe', () => {
    expect(getCustomToolDocsTool.readOnly).toBe(true)
    expect(getCustomToolDocsTool.concurrencySafe).toBe(true)
  })

  it('creates a tool with a description', () => {
    const t = getCustomToolDocsTool.create(ctx) as any
    expect(typeof t.description).toBe('string')
    expect(t.description.length).toBeGreaterThan(10)
  })
})

describe('getCustomToolDocsTool sections', () => {
  for (const section of KNOWN_SECTIONS) {
    it(`section "${section}" returns a markdown document`, async () => {
      const result = await execute(section)
      expect(result.error).toBeUndefined()
      expect(typeof result.title).toBe('string')
      expect(result.content.trimStart()).toMatch(/^#/)
      expect(result.content.length).toBeGreaterThan(100)
    })
  }

  it('"all" combines every section and lists them', async () => {
    const all = await execute('all')
    expect(all.sections.map((s: any) => s.id).sort()).toEqual([...KNOWN_SECTIONS].sort())
    for (const section of KNOWN_SECTIONS) {
      const single = await execute(section)
      expect(all.content).toContain(single.content)
    }
  })

  it('authoring section covers translations and tool domains', async () => {
    const result = await execute('authoring')
    expect(result.content).toContain('translations')
    expect(result.content).toContain('create_tool_domain')
  })

  it('renderer section covers the contract, ui primitives, and validation', async () => {
    const result = await execute('renderer')
    expect(result.content).toContain('export default function Renderer({ result, args, ui })')
    expect(result.content).toContain('KeyValues')
    expect(result.content).toContain('test_custom_tool')
    expect(result.content).toContain('--color-foreground')
  })
})
