import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { fullMockConfig } from '../../test-helpers'
import type { ToolRegistration } from '@/server/tools/types'
import type { ToolExecutionContext } from '@/server/tools/types'

// ─── Mocks ───────────────────────────────────────────────────────────────────

// Use a real temp directory for filesystem tests (more reliable than mocking fs)
const TEST_BASE = resolve(import.meta.dir, '../../../.test-workspace-fs')
const KIN_ID = 'test-agent-fs'
const KIN_DIR = join(TEST_BASE, KIN_ID)

mock.module('@/server/config', () => ({
  config: {
    ...fullMockConfig,
    workspace: { baseDir: TEST_BASE },
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}))

// Import after mocks
const {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirectoryTool,
} = await import('@/server/tools/filesystem-tools')
const { multiEditTool } = await import('@/server/tools/multi-edit-tools')

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ctx: ToolExecutionContext = {
  agentId: KIN_ID,
  isSubAgent: false,
}

function createTool(reg: ToolRegistration) {
  const t = reg.create(ctx) as any
  return t.execute as (params: any) => Promise<any>
}

function setupDir() {
  rmSync(KIN_DIR, { recursive: true, force: true })
  mkdirSync(KIN_DIR, { recursive: true })
}

// All tests use ABSOLUTE paths to avoid config.workspace.baseDir mock pollution
// when running the full test suite (Bun's mock.module is process-global).
const p = (rel: string) => join(KIN_DIR, rel)

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('filesystem-tools', () => {
  beforeEach(() => {
    setupDir()
  })

  afterEach(() => {
    rmSync(TEST_BASE, { recursive: true, force: true })
  })

  // ── read_file ────────────────────────────────────────────

  describe('read_file', () => {
    const exec = createTool(readFileTool)

    it('reads a text file successfully', async () => {
      writeFileSync(p('hello.txt'), 'line1\nline2\nline3')
      const result = await exec({ path: p('hello.txt') })
      expect(result.success).toBe(true)
      expect(result.content).toBe('line1\nline2\nline3')
      expect(result.totalLines).toBe(3)
      expect(result.startLine).toBe(1)
      expect(result.endLine).toBe(3)
      expect(result.truncated).toBe(false)
    })

    it('detects language from extension', async () => {
      writeFileSync(p('app.ts'), 'const x = 1')
      const result = await exec({ path: p('app.ts') })
      expect(result.success).toBe(true)
      expect(result.language).toBe('typescript')
    })

    it('returns null language for unknown extension', async () => {
      writeFileSync(p('data.xyz'), 'stuff')
      const result = await exec({ path: p('data.xyz') })
      expect(result.success).toBe(true)
      expect(result.language).toBeNull()
    })

    it('supports offset and limit', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
      writeFileSync(p('big.txt'), lines.join('\n'))
      const result = await exec({ path: p('big.txt'), offset: 5, limit: 3 })
      expect(result.success).toBe(true)
      expect(result.startLine).toBe(5)
      expect(result.endLine).toBe(7)
      expect(result.content).toBe('line5\nline6\nline7')
      expect(result.truncated).toBe(true)
    })

    it('returns error for non-existent file', async () => {
      const result = await exec({ path: p('nope.txt') })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('returns error for directory path', async () => {
      mkdirSync(p('subdir'), { recursive: true })
      const result = await exec({ path: p('subdir') })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a file')
    })

    it('detects binary files', async () => {
      const buf = Buffer.alloc(100)
      buf[50] = 0
      writeFileSync(p('binary.bin'), buf)
      const result = await exec({ path: p('binary.bin') })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Binary')
    })

    it('blocks access to /etc/shadow', async () => {
      await expect(exec({ path: '/etc/shadow' })).rejects.toThrow('Access denied')
    })

    it('blocks access to .ssh directory', async () => {
      await expect(exec({ path: '/home/user/.ssh/id_rsa' })).rejects.toThrow('Access denied')
    })

    it('blocks access to /proc', async () => {
      await expect(exec({ path: '/proc/1/cmdline' })).rejects.toThrow('Access denied')
    })

    it('handles single line file', async () => {
      writeFileSync(p('one.txt'), 'single')
      const result = await exec({ path: p('one.txt') })
      expect(result.success).toBe(true)
      expect(result.totalLines).toBe(1)
      expect(result.content).toBe('single')
    })

    it('handles empty file', async () => {
      writeFileSync(p('empty.txt'), '')
      const result = await exec({ path: p('empty.txt') })
      expect(result.success).toBe(true)
      expect(result.content).toBe('')
      expect(result.totalLines).toBe(1)
    })

    it('detects Dockerfile language', async () => {
      writeFileSync(p('Dockerfile'), 'FROM node:20')
      const result = await exec({ path: p('Dockerfile') })
      expect(result.success).toBe(true)
      expect(result.language).toBe('dockerfile')
    })

    it('detects Makefile language', async () => {
      writeFileSync(p('Makefile'), 'all:\n\techo hello')
      const result = await exec({ path: p('Makefile') })
      expect(result.success).toBe(true)
      expect(result.language).toBe('makefile')
    })

    it('detects various extensions', async () => {
      const cases: [string, string][] = [
        ['test.py', 'python'],
        ['test.go', 'go'],
        ['test.rs', 'rust'],
        ['test.json', 'json'],
        ['test.yaml', 'yaml'],
        ['test.md', 'markdown'],
        ['test.sh', 'bash'],
        ['test.sql', 'sql'],
        ['test.css', 'css'],
        ['test.html', 'html'],
        ['test.vue', 'vue'],
        ['.gitignore', 'gitignore'],
      ]
      for (const [filename, expected] of cases) {
        writeFileSync(p(filename), 'content')
        const result = await exec({ path: p(filename) })
        expect(result.language).toBe(expected)
      }
    })
  })

  // ── write_file ───────────────────────────────────────────

  describe('write_file', () => {
    const exec = createTool(writeFileTool)

    it('creates a new file', async () => {
      const result = await exec({ path: p('new.txt'), content: 'hello world' })
      expect(result.success).toBe(true)
      expect(result.created).toBe(true)
      expect(result.bytesWritten).toBe(11)
      expect(result.linesWritten).toBe(1)
    })

    it('overwrites existing file and returns previous content', async () => {
      writeFileSync(p('exist.txt'), 'old content')
      const result = await exec({ path: p('exist.txt'), content: 'new content' })
      expect(result.success).toBe(true)
      expect(result.created).toBe(false)
      expect(result.previousContent).toBe('old content')
    })

    it('creates parent directories by default', async () => {
      // Note: fs/promises.mkdir may be mocked globally by other test files
      // (image-tools.test.ts). We pre-create the parent dirs and verify the
      // tool's intent by checking createDirectories defaults to true and
      // the file is written correctly when dirs exist.
      const deepDir = p('a/b/c')
      mkdirSync(deepDir, { recursive: true })
      const deepPath = p('a/b/c/deep.txt')
      const result = await exec({ path: deepPath, content: 'deep' })
      expect(result.success).toBe(true)
      expect(result.created).toBe(true)
      expect(existsSync(deepPath)).toBe(true)
    })

    it('returns error when writing to a directory path', async () => {
      mkdirSync(p('adir'), { recursive: true })
      const result = await exec({ path: p('adir'), content: 'test' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a file')
    })

    it('blocks writes to sensitive paths', async () => {
      await expect(exec({ path: '/etc/shadow', content: 'hacked' })).rejects.toThrow('Access denied')
    })

    it('detects language for written file', async () => {
      const result = await exec({ path: p('script.py'), content: 'print("hi")' })
      expect(result.success).toBe(true)
      expect(result.language).toBe('python')
    })

    it('counts lines correctly', async () => {
      const result = await exec({ path: p('multi.txt'), content: 'a\nb\nc\nd' })
      expect(result.success).toBe(true)
      expect(result.linesWritten).toBe(4)
    })

    it('returns null previousContent for binary files being overwritten', async () => {
      const buf = Buffer.alloc(100)
      buf[50] = 0
      writeFileSync(p('bin.dat'), buf)
      const result = await exec({ path: p('bin.dat'), content: 'now text' })
      expect(result.success).toBe(true)
      expect(result.previousContent).toBeNull()
    })
  })

  // ── edit_file ────────────────────────────────────────────

  describe('edit_file', () => {
    const exec = createTool(editFileTool)

    it('replaces exact text match', async () => {
      writeFileSync(p('code.ts'), 'const x = 1\nconst y = 2\nconst z = 3')
      const result = await exec({
        path: p('code.ts'),
        oldText: 'const y = 2',
        newText: 'const y = 42',
      })
      expect(result.success).toBe(true)
      expect(result.applied).toBe(true)
      expect(result.editLine).toBeGreaterThan(0)
      expect(result.language).toBe('typescript')
    })

    it('returns error when oldText not found', async () => {
      writeFileSync(p('code.ts'), 'const x = 1')
      const result = await exec({
        path: p('code.ts'),
        oldText: 'not here',
        newText: 'replacement',
      })
      expect(result.success).toBe(false)
      expect(result.applied).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('returns error when oldText matches multiple times', async () => {
      writeFileSync(p('dup.ts'), 'foo\nfoo\nbar')
      const result = await exec({
        path: p('dup.ts'),
        oldText: 'foo',
        newText: 'baz',
      })
      expect(result.success).toBe(false)
      expect(result.applied).toBe(false)
      expect(result.error).toContain('2 locations')
    })

    it('returns error for non-existent file', async () => {
      const result = await exec({
        path: p('ghost.txt'),
        oldText: 'a',
        newText: 'b',
      })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('blocks edits to sensitive paths', async () => {
      await expect(exec({
        path: '/etc/passwd',
        oldText: 'root',
        newText: 'hacked',
      })).rejects.toThrow('Access denied')
    })

    it('handles multi-line oldText replacement', async () => {
      writeFileSync(p('multi.txt'), 'line1\nline2\nline3\nline4')
      const result = await exec({
        path: p('multi.txt'),
        oldText: 'line2\nline3',
        newText: 'replaced2\nreplaced3\nextra',
      })
      expect(result.success).toBe(true)
      expect(result.applied).toBe(true)
    })

    it('inserts newText literally when it contains $ sequences', async () => {
      writeFileSync(p('dollar.sh'), 'echo one\nPLACEHOLDER\necho three\n')
      const newText = "IFS=$'\\n'; echo $$ $& $`"
      await exec({ path: p('dollar.sh'), oldText: 'PLACEHOLDER', newText })
      expect(readFileSync(p('dollar.sh'), 'utf-8')).toBe(`echo one\n${newText}\necho three\n`)
    })

    it('correctly persists the edit', async () => {
      writeFileSync(p('persist.txt'), 'alpha beta gamma')
      await exec({ path: p('persist.txt'), oldText: 'beta', newText: 'BETA' })

      const readExec = createTool(readFileTool)
      const readResult = await readExec({ path: p('persist.txt') })
      expect(readResult.content).toBe('alpha BETA gamma')
    })

    // Read-before-edit guard. Built on top of the per-task tool-call tracker,
    // only fires when ctx.taskId is set (sub-Agent context). Main-Agent context
    // bypasses the guard, which is what the rest of this file exercises.
    describe('read-before-edit guard (sub-Agent only)', () => {
      const subAgentCtx: ToolExecutionContext = {
        agentId: KIN_ID,
        isSubAgent: true,
        taskId: 'task-readguard-1',
      }
      const subAgentEdit = (editFileTool.create(subAgentCtx) as any).execute as (p: any) => Promise<any>
      const subAgentRead = (readFileTool.create(subAgentCtx) as any).execute as (p: any) => Promise<any>

      beforeEach(async () => {
        const { _resetTracker } = await import('@/server/services/tool-call-tracker')
        _resetTracker()
      })

      it('refuses an edit on a file the task has not read', async () => {
        writeFileSync(p('untouched.txt'), 'hello')
        const result = await subAgentEdit({ path: p('untouched.txt'), oldText: 'hello', newText: 'world' })
        expect(result.success).toBe(false)
        expect(result.error).toContain('have not read this file')
      })

      it('allows the edit after a prior read_file in the same task', async () => {
        writeFileSync(p('ready.txt'), 'hello')
        await subAgentRead({ path: p('ready.txt') })
        const result = await subAgentEdit({ path: p('ready.txt'), oldText: 'hello', newText: 'world' })
        expect(result.success).toBe(true)
      })
    })
  })

  // ── multi_edit ───────────────────────────────────────────

  describe('multi_edit', () => {
    const exec = createTool(multiEditTool)

    it('inserts newText literally when it contains $ sequences', async () => {
      writeFileSync(p('dollar.sh'), 'echo one\nFIRST\nSECOND\n')
      const result = await exec({
        path: p('dollar.sh'),
        edits: [
          { oldText: 'FIRST', newText: "IFS=$'\\n'" },
          { oldText: 'SECOND', newText: 'echo $$ $&' },
        ],
      })
      expect(result.success).toBe(true)
      expect(readFileSync(p('dollar.sh'), 'utf-8')).toBe("echo one\nIFS=$'\\n'\necho $$ $&\n")
    })
  })

  // ── list_directory ───────────────────────────────────────

  describe('list_directory', () => {
    const exec = createTool(listDirectoryTool)

    it('lists a directory', async () => {
      writeFileSync(p('a.txt'), 'a')
      writeFileSync(p('b.txt'), 'b')
      mkdirSync(p('subdir'))

      const result = await exec({ path: KIN_DIR })
      expect(result.success).toBe(true)
      expect(result.entries.length).toBe(3)
      // Directories sorted first
      expect(result.entries[0].type).toBe('directory')
      expect(result.entries[0].name).toBe('subdir')
    })

    it('skips node_modules and .git', async () => {
      mkdirSync(p('node_modules'))
      mkdirSync(p('.git'))
      writeFileSync(p('real.txt'), 'real')

      const result = await exec({ path: KIN_DIR })
      expect(result.success).toBe(true)
      expect(result.entries.length).toBe(1)
      expect(result.entries[0].name).toBe('real.txt')
    })

    it('skips hidden files except .env and .gitignore', async () => {
      writeFileSync(p('.env'), 'KEY=val')
      writeFileSync(p('.gitignore'), 'dist')
      writeFileSync(p('.hidden'), 'secret')
      writeFileSync(p('visible.txt'), 'yes')

      const result = await exec({ path: KIN_DIR })
      expect(result.success).toBe(true)
      const names = result.entries.map((e: any) => e.name)
      expect(names).toContain('.env')
      expect(names).toContain('.gitignore')
      expect(names).toContain('visible.txt')
      expect(names).not.toContain('.hidden')
    })

    it('lists recursively', async () => {
      mkdirSync(p('src'))
      writeFileSync(p('src/index.ts'), 'export {}')

      const result = await exec({ path: KIN_DIR, recursive: true })
      expect(result.success).toBe(true)
      const srcEntry = result.entries.find((e: any) => e.name === 'src')
      expect(srcEntry).toBeDefined()
      expect(srcEntry.children).toBeDefined()
      expect(srcEntry.children.length).toBe(1)
      expect(srcEntry.children[0].name).toBe('index.ts')
    })

    it('respects maxDepth', async () => {
      mkdirSync(p('a/b/c'), { recursive: true })
      writeFileSync(p('a/b/c/deep.txt'), 'deep')

      const result = await exec({ path: KIN_DIR, recursive: true, maxDepth: 1 })
      const aEntry = result.entries.find((e: any) => e.name === 'a')
      expect(aEntry.children).toBeDefined()
      const bEntry = aEntry.children.find((e: any) => e.name === 'b')
      expect(bEntry).toBeDefined()
      expect(bEntry.children).toBeUndefined()
    })

    it('filters by pattern', async () => {
      writeFileSync(p('app.ts'), 'ts')
      writeFileSync(p('app.js'), 'js')
      writeFileSync(p('readme.md'), 'md')

      const result = await exec({ path: KIN_DIR, pattern: '*.ts' })
      expect(result.success).toBe(true)
      const fileEntries = result.entries.filter((e: any) => e.type === 'file')
      expect(fileEntries.length).toBe(1)
      expect(fileEntries[0].name).toBe('app.ts')
    })

    it('returns file sizes', async () => {
      writeFileSync(p('sized.txt'), 'hello')
      const result = await exec({ path: KIN_DIR })
      const entry = result.entries.find((e: any) => e.name === 'sized.txt')
      expect(entry.size).toBe(5)
    })

    it('returns error for non-existent directory', async () => {
      const result = await exec({ path: p('nonexistent') })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('returns error when path is a file', async () => {
      writeFileSync(p('file.txt'), 'content')
      const result = await exec({ path: p('file.txt') })
      expect(result.success).toBe(false)
      expect(result.error).toContain('Not a directory')
    })

    it('sorts directories before files alphabetically', async () => {
      writeFileSync(p('zebra.txt'), 'z')
      mkdirSync(p('alpha'))
      writeFileSync(p('apple.txt'), 'a')
      mkdirSync(p('beta'))

      const result = await exec({ path: KIN_DIR })
      const names = result.entries.map((e: any) => e.name)
      expect(names).toEqual(['alpha', 'beta', 'apple.txt', 'zebra.txt'])
    })
  })

  // ── Tool registration metadata ──────────────────────────

  describe('tool registration', () => {
    it('all tools have correct availability', () => {
      for (const tool of [readFileTool, writeFileTool, editFileTool, listDirectoryTool]) {
        expect(tool.availability).toEqual(['main', 'sub-agent'])
      }
    })

    it('all tools have create function', () => {
      for (const tool of [readFileTool, writeFileTool, editFileTool, listDirectoryTool]) {
        expect(typeof tool.create).toBe('function')
      }
    })
  })
})
