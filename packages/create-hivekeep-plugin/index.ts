#!/usr/bin/env node
/**
 * create-hivekeep-plugin: scaffold a new Hivekeep plugin.
 *
 * Usage:
 *   bunx create-hivekeep-plugin
 *   bunx create-hivekeep-plugin --yes            # non-interactive with defaults
 *   bunx create-hivekeep-plugin --name my-plugin  # partial overrides
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { createInterface } from 'readline'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScaffoldOptions {
  name: string
  description: string
  author: string
  types: PluginType[]
}

export type PluginType = 'tools' | 'providers' | 'channels' | 'hooks'

const ALL_PLUGIN_TYPES: PluginType[] = ['tools', 'providers', 'channels', 'hooks']

const DEFAULTS: ScaffoldOptions = {
  name: 'my-plugin',
  description: 'A Hivekeep plugin',
  author: 'Your Name',
  types: ['tools'],
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): { yes: boolean; overrides: Partial<ScaffoldOptions> } {
  let yes = false
  const overrides: Partial<ScaffoldOptions> = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') {
      yes = true
    } else if ((arg === '--name' || arg === '-n') && argv[i + 1]) {
      overrides.name = argv[++i]
    } else if ((arg === '--description' || arg === '-d') && argv[i + 1]) {
      overrides.description = argv[++i]
    } else if ((arg === '--author' || arg === '-a') && argv[i + 1]) {
      overrides.author = argv[++i]
    } else if ((arg === '--types' || arg === '-t') && argv[i + 1]) {
      overrides.types = argv[++i].split(',').filter(t => ALL_PLUGIN_TYPES.includes(t as PluginType)) as PluginType[]
    }
  }

  return { yes, overrides }
}

// ─── Interactive prompt ──────────────────────────────────────────────────────

async function prompt(question: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} (${defaultValue}): `, (answer) => {
      rl.close()
      resolve(answer.trim() || defaultValue)
    })
  })
}

async function promptTypes(): Promise<PluginType[]> {
  const answer = await prompt(
    'Plugin types (comma-separated: tools,providers,channels,hooks)',
    'tools'
  )
  const types = answer.split(',').map(t => t.trim()).filter(t => ALL_PLUGIN_TYPES.includes(t as PluginType)) as PluginType[]
  return types.length > 0 ? types : ['tools']
}

async function gatherOptions(yes: boolean, overrides: Partial<ScaffoldOptions>): Promise<ScaffoldOptions> {
  if (yes) {
    return { ...DEFAULTS, ...overrides }
  }

  const name = overrides.name ?? await prompt('Plugin name', DEFAULTS.name)
  const description = overrides.description ?? await prompt('Description', DEFAULTS.description)
  const author = overrides.author ?? await prompt('Author', DEFAULTS.author)
  const types = overrides.types ?? await promptTypes()

  return { name, description, author, types }
}

// ─── File generators ─────────────────────────────────────────────────────────

export function generateManifest(opts: ScaffoldOptions): string {
  const manifest: Record<string, any> = {
    $schema: 'https://unpkg.com/@gezy/sdk/schemas/plugin-manifest.schema.json',
    name: opts.name,
    version: '0.1.0',
    description: opts.description,
    author: opts.author,
    hivekeep: '>=0.41.0',
    main: 'index.ts',
    permissions: [],
    config: {},
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

export function generateIndex(opts: ScaffoldOptions): string {
  // Each `--type` produces its own dedicated section. The shared header
  // imports only what is actually used downstream.
  const importParts: string[] = []
  if (opts.types.includes('tools')) importParts.push('tool', 'z')
  const typeImports: string[] = ['PluginContext', 'PluginExports']
  if (opts.types.includes('channels')) {
    typeImports.push(
      'ChannelAdapter',
      'IncomingMessageHandler',
      'OutboundMessageParams',
      'OutboundMessageResult',
    )
  }
  if (opts.types.includes('providers')) {
    typeImports.push('LLMProvider', 'ProviderConfig', 'LLMModel', 'ChatRequest', 'ChatChunk')
  }

  const lines: string[] = []
  if (importParts.length > 0) {
    lines.push(`import { ${importParts.join(', ')} } from '@gezy/sdk'`)
  }
  lines.push(`import type { ${typeImports.join(', ')} } from '@gezy/sdk'`)
  lines.push('')

  // ─── Channel adapter skeleton ────────────────────────────────────────────
  if (opts.types.includes('channels')) {
    lines.push(`// A starter channel adapter. Fill in the transport-specific bits.`)
    lines.push(`const ${camelCase(opts.name)}Adapter: ChannelAdapter = {`)
    lines.push(`  platform: '${opts.name}',`)
    lines.push(`  meta: { displayName: '${opts.name}' },`)
    lines.push(`  identitySwitchMode: 'prefix',`)
    lines.push(``)
    lines.push(`  async start(channelId, _config, _onMessage: IncomingMessageHandler) {`)
    lines.push(`    // Open a connection / start polling. Call onMessage(...) when messages arrive.`)
    lines.push(`  },`)
    lines.push(``)
    lines.push(`  async stop(channelId) {`)
    lines.push(`    // Close the connection / cancel timers.`)
    lines.push(`  },`)
    lines.push(``)
    lines.push(`  async sendMessage(`)
    lines.push(`    _channelId,`)
    lines.push(`    _config,`)
    lines.push(`    _params: OutboundMessageParams,`)
    lines.push(`  ): Promise<OutboundMessageResult> {`)
    lines.push(`    return { platformMessageId: 'replace-me' }`)
    lines.push(`  },`)
    lines.push(``)
    lines.push(`  async validateConfig(_config) {`)
    lines.push(`    return { valid: true }`)
    lines.push(`  },`)
    lines.push(``)
    lines.push(`  async getBotInfo(_config) {`)
    lines.push(`    return { name: '${opts.name}' }`)
    lines.push(`  },`)
    lines.push(`}`)
    lines.push('')
  }

  // ─── Native LLMProvider skeleton ─────────────────────────────────────────
  if (opts.types.includes('providers')) {
    lines.push(`// A starter native LLMProvider. Same interface as the built-in providers.`)
    lines.push(`class ${pascalCase(opts.name)}LLMProvider implements LLMProvider {`)
    lines.push(`  readonly type = '${opts.name}'`)
    lines.push(`  readonly displayName = '${opts.name}'`)
    lines.push(`  readonly configSchema = [`)
    lines.push(`    { key: 'apiKey', type: 'secret', label: 'API Key', required: true },`)
    lines.push(`  ] as const`)
    lines.push(``)
    lines.push(`  async authenticate(_config: ProviderConfig) {`)
    lines.push(`    return { valid: true }`)
    lines.push(`  }`)
    lines.push(``)
    lines.push(`  async listModels(_config: ProviderConfig) {`)
    lines.push(`    return [{ id: 'default', name: 'Default model', contextWindow: 4096 }]`)
    lines.push(`  }`)
    lines.push(``)
    lines.push(`  async *chat(_model: LLMModel, _request: ChatRequest, _config: ProviderConfig): AsyncIterable<ChatChunk> {`)
    lines.push(`    yield { type: 'text-delta', text: 'Hello from ${opts.name}!' }`)
    lines.push(`    yield {`)
    lines.push(`      type: 'finish',`)
    lines.push(`      reason: 'stop',`)
    lines.push(`      usage: { inputTokens: 0, outputTokens: 0 },`)
    lines.push(`    }`)
    lines.push(`  }`)
    lines.push(`}`)
    lines.push('')
  }

  lines.push(`export default function (ctx: PluginContext): PluginExports {`)
  lines.push(`  ctx.log.info('${opts.name} loaded')`)
  lines.push(``)
  lines.push(`  return {`)

  if (opts.types.includes('tools')) {
    lines.push(`    tools: {`)
    lines.push(`      hello: {`)
    lines.push(`        availability: ['main', 'sub-agent'],`)
    lines.push(`        readOnly: true,`)
    lines.push(`        concurrencySafe: true,`)
    lines.push(`        create: () =>`)
    lines.push(`          tool({`)
    lines.push(`            description: 'Say hello.',`)
    lines.push(`            inputSchema: z.object({`)
    lines.push(`              name: z.string().describe('Who to greet'),`)
    lines.push(`            }),`)
    lines.push(`            execute: async ({ name }) => ({`)
    lines.push(`              message: \`Hello, \${name}! From ${opts.name}\`,`)
    lines.push(`            }),`)
    lines.push(`          }),`)
    lines.push(`      },`)
    lines.push(`    },`)
  }

  if (opts.types.includes('channels')) {
    lines.push(`    channels: {`)
    lines.push(`      '${opts.name}': ${camelCase(opts.name)}Adapter,`)
    lines.push(`    },`)
  }

  if (opts.types.includes('providers')) {
    lines.push(`    providers: [new ${pascalCase(opts.name)}LLMProvider()],`)
  }

  if (opts.types.includes('hooks')) {
    lines.push(`    hooks: {`)
    lines.push(`      // Each hook handler receives the typed payload for its hook name.`)
    lines.push(`      // See HookPayloadMap in @gezy/sdk.`)
    lines.push(`      afterChat: (h) => {`)
    lines.push(`        ctx.log.info({ agentId: h.agentId, responseLen: h.response.length }, 'afterChat')`)
    lines.push(`      },`)
    lines.push(`    },`)
  }

  lines.push(``)
  lines.push(`    async activate() {`)
  lines.push(`      ctx.log.info('${opts.name} activated')`)
  lines.push(`    },`)
  lines.push(`    async deactivate() {`)
  lines.push(`      ctx.log.info('${opts.name} deactivated')`)
  lines.push(`    },`)
  lines.push(`  }`)
  lines.push(`}`)
  lines.push('')

  return lines.join('\n')
}

function camelCase(s: string): string {
  return s.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function pascalCase(s: string): string {
  const camel = camelCase(s)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

export function generateReadme(opts: ScaffoldOptions): string {
  return `# ${opts.name}

${opts.description}

## Installation

Copy this folder into your Hivekeep \`plugins/\` directory:

\`\`\`bash
git clone <your-repo-url> plugins/${opts.name}
\`\`\`

Then go to **Settings → Plugins** and enable it.

## Configuration

Edit the plugin settings in the Hivekeep UI under **Settings → Plugins → ${opts.name}**.

## Plugin Types

This plugin provides: ${opts.types.join(', ')}

## Development

See the [Hivekeep Plugin Development Guide](https://marlburrow.github.io/hivekeep/docs/plugins/developing/) for details.

## License

MIT
`
}

export function generateGitignore(): string {
  return `node_modules/
*.log
.DS_Store
`
}

/**
 * Generate a `package.json` so the plugin is publishable on npm with
 * the `hivekeep-plugin` keyword. Hivekeep's Browse tab (Settings →
 * Plugins → npm) discovers packages via the npm search API filtered
 * on that exact keyword. Without it, the plugin stays invisible.
 *
 * Key choices:
 * - **peerDependencies on @gezy/sdk**: the SDK MUST come
 *   from the host. If a plugin declares it as a regular `dependencies`,
 *   npm/bun installs a SECOND copy and `instanceof` checks across
 *   plugin/host break (the two SDK modules export DIFFERENT class
 *   identities even when the file content is identical).
 * - **files**: only the bits that should ship in the published
 *   tarball. Bundled output is preferred; the scaffold defaults to
 *   shipping `index.ts` + `plugin.json` so Hivekeep can dynamic-import
 *   the TS directly under Bun.
 * - **keywords ["hivekeep-plugin", "hivekeep"]**: `hivekeep-plugin` is the
 *   discovery keyword; `hivekeep` is a convention.
 */
export function generatePackageJson(opts: ScaffoldOptions): string {
  const pkg = {
    name: opts.name,
    version: '0.1.0',
    description: opts.description,
    author: opts.author,
    license: 'MIT',
    main: 'index.ts',
    files: ['index.ts', 'plugin.json', 'README.md'],
    keywords: ['hivekeep-plugin', 'hivekeep'],
    peerDependencies: {
      '@gezy/sdk': '^0.10.0',
    },
    // Empty by default. Add real dependencies (axios, ws, …) as needed.
    // Bun runs `bun install --production` after a git-clone install so
    // these resolve at activation time.
    dependencies: {},
    devDependencies: {
      '@gezy/sdk': '^0.10.0',
    },
  }
  return JSON.stringify(pkg, null, 2) + '\n'
}

// ─── Scaffold function ───────────────────────────────────────────────────────

export function scaffold(targetDir: string, opts: ScaffoldOptions): void {
  if (existsSync(targetDir)) {
    throw new Error(`Directory "${targetDir}" already exists.`)
  }

  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'plugin.json'), generateManifest(opts))
  writeFileSync(join(targetDir, 'package.json'), generatePackageJson(opts))
  writeFileSync(join(targetDir, 'index.ts'), generateIndex(opts))
  writeFileSync(join(targetDir, 'README.md'), generateReadme(opts))
  writeFileSync(join(targetDir, '.gitignore'), generateGitignore())
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔌 Create Hivekeep Plugin\n')

  const { yes, overrides } = parseArgs(process.argv.slice(2))
  const opts = await gatherOptions(yes, overrides)

  const targetDir = resolve(process.cwd(), opts.name)
  scaffold(targetDir, opts)

  console.log(`\n✅ Plugin scaffolded at: ${targetDir}`)
  console.log(`\nNext steps:`)
  console.log(`  1. cd ${opts.name}`)
  console.log(`  2. Edit plugin.json (permissions, config schema)`)
  console.log(`  3. Implement your plugin in index.ts`)
  console.log(``)
  console.log(`Distribute it:`)
  console.log(`  • Publish on npm:`)
  console.log(`      npm publish              # makes it discoverable in Hivekeep's Browse → npm tab`)
  console.log(`  • Or push to a public git repo:`)
  console.log(`      git init && git add . && git commit -m "init"`)
  console.log(`      git push <your-remote>   # admin installs via Settings → Plugins → Install from git`)
  console.log(``)
  console.log(`Test locally:`)
  console.log(`  • Drop the directory into Hivekeep's plugins/ folder and reload`)
  console.log(`  • Or run: bunx hivekeep install ${opts.name} (when published)\n`)
}

// Run main() only when executed as the CLI entry (not when imported by tests).
// import.meta.main is true for the entry module under Bun and Node >= 24.
if (import.meta.main) {
  main().catch((err) => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
