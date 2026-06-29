import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  generateManifest,
  generateIndex,
  generateReadme,
  generateGitignore,
  generatePackageJson,
  scaffold,
  type ScaffoldOptions,
} from './index'

const defaultOpts: ScaffoldOptions = {
  name: 'test-plugin',
  description: 'A test plugin',
  author: 'Tester',
  types: ['tools'],
}

describe('generateManifest', () => {
  test('produces valid JSON with required fields', () => {
    const raw = generateManifest(defaultOpts)
    const manifest = JSON.parse(raw)
    expect(manifest.$schema).toContain('plugin-manifest.schema.json')
    expect(manifest.name).toBe('test-plugin')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.description).toBe('A test plugin')
    expect(manifest.author).toBe('Tester')
    expect(manifest.main).toBe('index.ts')
    expect(manifest.hivekeep).toBe('>=0.41.0')
  })
})

describe('generatePackageJson', () => {
  test('declares the hivekeep-plugin keyword so the Browse tab discovers it', () => {
    const pkg = JSON.parse(generatePackageJson(defaultOpts))
    expect(pkg.keywords).toContain('hivekeep-plugin')
    // `hivekeep` as a convenience second keyword.
    expect(pkg.keywords).toContain('hivekeep')
  })

  test('declares @gezy/sdk as a peerDependency, NOT a regular dependency', () => {
    // Critical: a regular dependency would let bun install a SECOND
    // copy of the SDK and break instanceof checks across the
    // plugin/host boundary.
    const pkg = JSON.parse(generatePackageJson(defaultOpts))
    expect(pkg.peerDependencies['@gezy/sdk']).toBeTruthy()
    expect(pkg.dependencies['@gezy/sdk']).toBeUndefined()
  })

  test('lists the SDK in devDependencies so the plugin can compile against types in dev', () => {
    const pkg = JSON.parse(generatePackageJson(defaultOpts))
    expect(pkg.devDependencies['@gezy/sdk']).toBeTruthy()
  })

  test('files array limits what ships in the published tarball', () => {
    const pkg = JSON.parse(generatePackageJson(defaultOpts))
    expect(pkg.files).toContain('plugin.json')
    expect(pkg.files).toContain('index.ts')
    // No node_modules, no test files, no .gitignore.
    expect(pkg.files).not.toContain('node_modules')
  })

  test('main field points at index.ts so the loader knows what to import', () => {
    const pkg = JSON.parse(generatePackageJson(defaultOpts))
    expect(pkg.main).toBe('index.ts')
  })

  test('propagates name / description / author from the scaffold options', () => {
    const pkg = JSON.parse(generatePackageJson({
      ...defaultOpts,
      name: 'custom-name',
      description: 'a custom one',
      author: 'A Tester',
    }))
    expect(pkg.name).toBe('custom-name')
    expect(pkg.description).toBe('a custom one')
    expect(pkg.author).toBe('A Tester')
  })
})

describe('generateIndex', () => {
  test('includes tool boilerplate for tools type', () => {
    const code = generateIndex({ ...defaultOpts, types: ['tools'] })
    expect(code).toContain("import { tool, z } from '@gezy/sdk'")
    expect(code).toContain('hello:')
    expect(code).toContain('inputSchema')
  })

  test('includes hooks boilerplate for hooks type, only importing types', () => {
    const code = generateIndex({ ...defaultOpts, types: ['hooks'] })
    expect(code).toContain('afterChat')
    // Hooks-only does not need any runtime import from the SDK (no tool() / no card.*)
    expect(code).not.toContain("import { tool")
    // But it DOES need the type imports for PluginContext / PluginExports.
    expect(code).toContain("import type { PluginContext, PluginExports } from '@gezy/sdk'")
  })

  test('includes a native LLMProvider skeleton for providers type', () => {
    const code = generateIndex({ ...defaultOpts, types: ['providers'] })
    expect(code).toContain('providers:')
    expect(code).toContain('implements LLMProvider')
    expect(code).toContain('chat(')
    expect(code).toContain('listModels')
    expect(code).toContain('AsyncIterable<ChatChunk>')
  })

  test('includes a real ChannelAdapter skeleton for channels type', () => {
    const code = generateIndex({ ...defaultOpts, types: ['channels'] })
    expect(code).toContain('channels:')
    expect(code).toContain('ChannelAdapter')
    expect(code).toContain('sendMessage')
    expect(code).toContain('validateConfig')
  })

  test('supports multiple types', () => {
    const code = generateIndex({ ...defaultOpts, types: ['tools', 'hooks', 'channels'] })
    expect(code).toContain('tools:')
    expect(code).toContain('hooks:')
    expect(code).toContain('channels:')
  })

  test('always includes activate/deactivate', () => {
    const code = generateIndex(defaultOpts)
    expect(code).toContain('activate')
    expect(code).toContain('deactivate')
  })
})

describe('generateReadme', () => {
  test('includes plugin name and description', () => {
    const readme = generateReadme(defaultOpts)
    expect(readme).toContain('# test-plugin')
    expect(readme).toContain('A test plugin')
    expect(readme).toContain('tools')
  })
})

describe('generateGitignore', () => {
  test('includes common patterns', () => {
    const gi = generateGitignore()
    expect(gi).toContain('node_modules/')
    expect(gi).toContain('.DS_Store')
  })
})

describe('scaffold', () => {
  const testDirs: string[] = []

  function makeTempDir(): string {
    const dir = join(tmpdir(), `hivekeep-scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of testDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    testDirs.length = 0
  })

  test('creates all required files', () => {
    const dir = makeTempDir()
    scaffold(dir, defaultOpts)

    expect(existsSync(join(dir, 'plugin.json'))).toBe(true)
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'index.ts'))).toBe(true)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
    expect(existsSync(join(dir, '.gitignore'))).toBe(true)
  })

  test('package.json is publishable on npm (has the discovery keyword)', () => {
    const dir = makeTempDir()
    scaffold(dir, defaultOpts)
    const raw = readFileSync(join(dir, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw)
    expect(pkg.keywords).toContain('hivekeep-plugin')
    expect(pkg.peerDependencies['@gezy/sdk']).toBeTruthy()
  })

  test('plugin.json is valid JSON', () => {
    const dir = makeTempDir()
    scaffold(dir, defaultOpts)
    const raw = readFileSync(join(dir, 'plugin.json'), 'utf-8')
    const manifest = JSON.parse(raw)
    expect(manifest.name).toBe('test-plugin')
  })

  test('throws if directory already exists', () => {
    const dir = makeTempDir()
    scaffold(dir, defaultOpts)
    expect(() => scaffold(dir, defaultOpts)).toThrow('already exists')
  })

  test('works with all plugin types', () => {
    const dir = makeTempDir()
    scaffold(dir, { ...defaultOpts, types: ['tools', 'providers', 'channels', 'hooks'] })
    const code = readFileSync(join(dir, 'index.ts'), 'utf-8')
    expect(code).toContain('tools:')
    expect(code).toContain('providers:')
    expect(code).toContain('channels:')
    expect(code).toContain('hooks:')
  })
})
