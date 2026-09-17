/** Disposable Docker smoke test; mount a fresh volume at /data and run twice. */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginPaths, preparePluginStorage } from '../src/server/services/plugin-files'

if (process.getuid?.() !== 1001) throw new Error('Run this smoke test as the production UID 1001')
const paths = pluginPaths('/data', '/data/old-application')
const { preparePluginSdk } = await import(join(process.cwd(), 'src/server/services/plugin-sdk.ts'))
if (process.argv[2] === 'install') {
  const legacy = join(paths.legacyDir, 'local-fixture')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'plugin.json'), JSON.stringify({ name: 'local-fixture', version: '1.0.0', description: 'Smoke test', main: 'index.ts' }))
  await writeFile(join(legacy, 'index.ts'), 'import { z } from "@hivekeep/sdk"; export default () => ({ name: z.string().parse("persistent-fixture") })')
  await preparePluginStorage(paths)
  await rm('/data/old-application', { recursive: true })
} else if (process.argv[2] !== 'verify') throw new Error('Expected install or verify')
await preparePluginStorage(paths)
await preparePluginSdk(paths.pluginsDir, paths.installWorkspace)
const directory = join(paths.pluginsDir, 'local-fixture')
const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'))
const plugin = await import(join(directory, manifest.main))
if (plugin.default().name !== 'persistent-fixture') throw new Error('Plugin did not load after container recreation')
console.log(`Plugin storage ${process.argv[2]} passed as UID ${process.getuid?.()}`)
