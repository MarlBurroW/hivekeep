import { cp, mkdir, readFile, rm, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Standalone data volumes need the host SDK without symlinks into application code. */
export async function preparePluginSdk(pluginsDir: string, workspace: string): Promise<void> {
  const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve('@hivekeep/sdk'))))
  const zodRoot = dirname(Bun.resolveSync('zod/package.json', import.meta.dir))
  for (const [name, source] of [['@hivekeep/sdk', sdkRoot], ['zod', zodRoot]] as const) {
    const target = join(pluginsDir, 'node_modules', name)
    const current = await readFile(join(target, 'package.json'), 'utf8').catch(() => null)
    const expected = await readFile(join(source, 'package.json'), 'utf8')
    if (current === expected) continue
    const staged = join(workspace, name.replaceAll('/', '-'))
    await rm(staged, { recursive: true, force: true })
    await cp(source, staged, { recursive: true, filter: (file) => !file.slice(source.length).split('/').includes('node_modules') })
    await mkdir(dirname(target), { recursive: true })
    await rm(target, { recursive: true, force: true })
    await rename(staged, target)
  }
}
