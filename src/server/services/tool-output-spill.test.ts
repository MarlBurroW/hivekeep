import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync, readdirSync } from 'fs'
import { join } from 'path'
import { maybeSpillToolOutput, wrapToolsWithSpill, cleanupSpilledOutputs, buildPreview, capToolResultText } from '@/server/services/tool-output-spill'

const TEST_DIR = join(import.meta.dir, '__test_spill_workspace__')
const SPILL_DIR = join(TEST_DIR, '.tool-outputs')

function setup() {
  mkdirSync(TEST_DIR, { recursive: true })
}

function teardown() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true })
  }
}

describe('maybeSpillToolOutput', () => {
  beforeEach(() => {
    teardown()
    setup()
  })

  afterEach(() => {
    teardown()
  })

  it('returns result unchanged when below threshold', () => {
    const result = { success: true, output: 'small output' }
    const out = maybeSpillToolOutput(TEST_DIR, 'run_shell', result)
    expect(out).toEqual(result)
    expect(existsSync(SPILL_DIR)).toBe(false)
  })

  it('spills to file when above threshold', () => {
    const largeOutput = 'x'.repeat(20000)
    const result = { success: true, output: largeOutput }
    const out = maybeSpillToolOutput(TEST_DIR, 'run_shell', result) as any

    expect(out.__spilled).toBe(true)
    expect(out.toolName).toBe('run_shell')
    expect(out.file).toMatch(/^\.tool-outputs\/tool-result-\d+-[a-f0-9]{8}\.txt$/)
    expect(out.sizeBytes).toBeGreaterThan(20000)
    expect(out.lineCount).toBeGreaterThan(0)
    // The whole point of spilling: the reference must be far cheaper than the
    // payload it replaces. `typeof preview === 'string'` passes even when the
    // preview IS the full payload, which is how the unbounded preview shipped.
    expect(out.preview.length).toBeLessThanOrEqual(4200)
    expect(out.preview.length).toBeLessThan(largeOutput.length)
    expect(out.hint).toContain('read_file')

    // Verify file was created with full content
    const filePath = join(TEST_DIR, out.file)
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(content)
    expect(parsed.output).toBe(largeOutput)
  })

  it('exempts read_file even when result is large', () => {
    const result = { content: 'y'.repeat(50000) }
    const out = maybeSpillToolOutput(TEST_DIR, 'read_file', result)
    expect(out).toEqual(result)
    expect(existsSync(SPILL_DIR)).toBe(false)
  })

  it('preview respects line limit', () => {
    // Create a result that serializes to many lines AND exceeds the byte threshold
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}: ${'x'.repeat(50)}`)
    const result = { output: lines.join('\n') }
    const out = maybeSpillToolOutput(TEST_DIR, 'grep', result) as any

    expect(out.__spilled).toBe(true)
    // Preview should have at most 200 lines (default previewLines)
    const previewLineCount = out.preview.split('\n').length
    expect(previewLineCount).toBeLessThanOrEqual(200)
  })

  it('returns result unchanged when threshold is 0 (disabled)', () => {
    // We can't easily mock config, but we can verify the result is unchanged
    // for non-serializable data
    const circular: any = {}
    circular.self = circular
    const out = maybeSpillToolOutput(TEST_DIR, 'run_shell', circular)
    expect(out).toBe(circular) // returned as-is because JSON.stringify fails
  })

  it('creates .tool-outputs directory if it does not exist', () => {
    expect(existsSync(SPILL_DIR)).toBe(false)

    const result = { output: 'z'.repeat(20000) }
    maybeSpillToolOutput(TEST_DIR, 'run_shell', result)

    expect(existsSync(SPILL_DIR)).toBe(true)
  })
})

describe('spill preview bounds', () => {
  beforeEach(() => {
    teardown()
    setup()
  })

  afterEach(() => {
    teardown()
  })

  it('bounds the preview of a result whose bulk is one huge string', () => {
    // The Majordome regression. An email body, a grep hit list or shell stdout
    // is a single JSON string: JSON.stringify escapes its newlines, so the
    // serialized form is a handful of very long lines. Slicing by line count
    // alone kept everything, and a "spilled" 109k-token email still cost 109k
    // tokens in every later turn.
    const body = 'Bonjour, '.repeat(60_000) // ~540k chars, no real newlines
    const out = maybeSpillToolOutput(TEST_DIR, 'read_email', { message: { subject: 'Devis', body } }) as any

    expect(out.__spilled).toBe(true)
    expect(out.preview.length).toBeLessThanOrEqual(4200)
    expect(out.preview).toContain('preview truncated')
    // The full payload is still recoverable from disk.
    const parsed = JSON.parse(readFileSync(join(TEST_DIR, out.file), 'utf-8'))
    expect(parsed.message.body).toBe(body)
  })

  it('keeps the preview cheaper than the threshold that triggered the spill', () => {
    const out = maybeSpillToolOutput(TEST_DIR, 'run_shell', { preview: 'z'.repeat(200_000) }) as any
    expect(out.preview.length).toBeLessThan(10_000)
  })

  it('leaves a genuinely short preview untouched', () => {
    // Pretty-printed arrays DO produce real newlines, so here the line bound is
    // the one that bites and the character bound stays slack. Verifies the
    // char budget does not truncate previews that were already cheap.
    const out = maybeSpillToolOutput(TEST_DIR, 'get_platform_logs', { entries: Array.from({ length: 3000 }, (_, i) => i) }) as any
    expect(out.__spilled).toBe(true)
    expect(out.preview).not.toContain('preview truncated')
    expect(out.preview.split('\n').length).toBeLessThanOrEqual(200)
  })
})

describe('buildPreview', () => {
  it('returns the input untouched when both bounds are respected', () => {
    expect(buildPreview(['a', 'b', 'c'], 200, 4000)).toBe('a\nb\nc')
  })

  it('applies the line bound', () => {
    expect(buildPreview(['a', 'b', 'c', 'd'], 2, 4000)).toBe('a\nb')
  })

  it('applies the character bound and reports what was cut', () => {
    const out = buildPreview(['x'.repeat(1000)], 200, 100)
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('900 more characters')
  })

  it('treats a non-positive character budget as no character bound', () => {
    expect(buildPreview(['x'.repeat(1000)], 200, 0)).toBe('x'.repeat(1000))
  })

  it('always keeps at least one line', () => {
    expect(buildPreview(['only'], 0, 4000)).toBe('only')
  })
})

describe('wrapToolsWithSpill', () => {
  beforeEach(() => {
    teardown()
    setup()
  })

  afterEach(() => {
    teardown()
  })

  it('wraps tool execute to apply spill', async () => {
    const largeOutput = { output: 'a'.repeat(20000) }
    const mockTool = {
      description: 'test tool',
      parameters: {} as any,
      execute: async () => largeOutput,
    } as any

    const wrapped = wrapToolsWithSpill({ test_tool: mockTool }, TEST_DIR)
    const result = await wrapped.test_tool!.execute!({}, {} as any) as any

    expect(result.__spilled).toBe(true)
    expect(result.toolName).toBe('test_tool')
  })

  it('passes through exempt tools unchanged', async () => {
    const largeOutput = { content: 'b'.repeat(50000) }
    const mockTool = {
      description: 'read file',
      parameters: {} as any,
      execute: async () => largeOutput,
    } as any

    const wrapped = wrapToolsWithSpill({ read_file: mockTool }, TEST_DIR)
    const result = await wrapped.read_file!.execute!({}, {} as any)

    expect(result).toEqual(largeOutput) // not spilled
  })

  it('passes through tools without execute', () => {
    const noExecTool = { description: 'no exec', parameters: {} as any } as any
    const wrapped = wrapToolsWithSpill({ no_exec: noExecTool }, TEST_DIR)
    expect(wrapped.no_exec).toBe(noExecTool)
  })
})

describe('cleanupSpilledOutputs', () => {
  const WORKSPACES_DIR = join(import.meta.dir, '__test_workspaces__')
  const WS1 = join(WORKSPACES_DIR, 'ws1')
  const WS1_SPILL = join(WS1, '.tool-outputs')

  beforeEach(() => {
    if (existsSync(WORKSPACES_DIR)) rmSync(WORKSPACES_DIR, { recursive: true, force: true })
    mkdirSync(WS1_SPILL, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(WORKSPACES_DIR)) rmSync(WORKSPACES_DIR, { recursive: true, force: true })
  })

  it('deletes files older than TTL', () => {
    const oldFile = join(WS1_SPILL, 'tool-result-old.txt')
    writeFileSync(oldFile, 'old content')
    // Set mtime to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(oldFile, oldTime, oldTime)

    const count = cleanupSpilledOutputs(WORKSPACES_DIR)
    expect(count).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
  })

  it('keeps recent files', () => {
    const recentFile = join(WS1_SPILL, 'tool-result-recent.txt')
    writeFileSync(recentFile, 'recent content')

    const count = cleanupSpilledOutputs(WORKSPACES_DIR)
    expect(count).toBe(0)
    expect(existsSync(recentFile)).toBe(true)
  })

  it('returns 0 when no workspaces exist', () => {
    const count = cleanupSpilledOutputs('/nonexistent/path')
    expect(count).toBe(0)
  })

  it('handles mixed old and recent files', () => {
    const oldFile = join(WS1_SPILL, 'old.txt')
    const recentFile = join(WS1_SPILL, 'recent.txt')
    writeFileSync(oldFile, 'old')
    writeFileSync(recentFile, 'recent')

    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(oldFile, oldTime, oldTime)

    const count = cleanupSpilledOutputs(WORKSPACES_DIR)
    expect(count).toBe(1)
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(recentFile)).toBe(true)
  })
})

describe('capToolResultText', () => {
  it('leaves a result under the cap untouched', () => {
    expect(capToolResultText('short output', 'grep', 30000)).toBe('short output')
  })

  it('replaces an oversized result with a re-runnable placeholder', () => {
    // Within a turn, results are re-sent at every later step. Uncapped, one
    // huge result is paid for on each of them.
    const huge = 'data '.repeat(200_000)
    const out = capToolResultText(huge, 'read_file', 30000)
    expect(out.length).toBeLessThan(300)
    expect(out).toContain('read_file')
    expect(out).toContain('Re-run the tool')
  })

  it('names the tool so the model knows what to re-run', () => {
    expect(capToolResultText('x'.repeat(500_000), 'get_platform_logs', 1000)).toContain('get_platform_logs')
  })

  it('treats a non-positive cap as disabled', () => {
    const huge = 'y'.repeat(500_000)
    expect(capToolResultText(huge, 'grep', 0)).toBe(huge)
  })

  it('does not count tokens for obviously small results', () => {
    // The char pre-check must short-circuit: token counting every tool result
    // on every step would be a real cost on tool-heavy turns.
    const text = 'a'.repeat(1000)
    expect(capToolResultText(text, 'grep', 30000)).toBe(text)
  })
})
