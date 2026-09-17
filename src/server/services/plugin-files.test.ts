import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPaths, preparePluginStorage, stageNpmPlugin, publishPlugin } from './plugin-files'
import { preparePluginSdk } from './plugin-sdk'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-storage-'))
  temporary.push(root)
  const paths = pluginPaths(join(root, 'persistent-data'), join(root, 'application'))
  const source = join(paths.legacyDir, 'fixture')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', main: 'index.ts' }))
  await writeFile(join(source, 'index.ts'), 'export default () => ({})')
  return { root, paths, source }
}

describe('persistent plugin storage', () => {
  it('resolves the host SDK for plugins stored outside the application directory', async () => {
    const { paths } = await fixture()
    await preparePluginStorage(paths)
    await preparePluginSdk(paths.pluginsDir, paths.installWorkspace)
    const entry = join(paths.pluginsDir, 'fixture', 'sdk.ts')
    await writeFile(entry, 'import { z } from "@hivekeep/sdk"; export default z.string().parse("host-sdk")')
    expect((await import(entry)).default).toBe('host-sdk')
  })

  it('copies and verifies a legacy plugin without deleting the original', async () => {
    const { paths, source } = await fixture()
    expect((await preparePluginStorage(paths)).migrated).toEqual(['fixture'])
    expect(await readFile(join(paths.pluginsDir, 'fixture', 'index.ts'), 'utf8')).toBe(await readFile(join(source, 'index.ts'), 'utf8'))
    expect((await preparePluginStorage(paths)).migrated).toEqual([])
    // Recreating the application directory leaves installs in the data volume.
    await rm(paths.legacyDir, { recursive: true })
    await preparePluginStorage(paths)
    expect(await Bun.file(join(paths.pluginsDir, 'fixture', 'plugin.json')).exists()).toBe(true)
  })

  it('resumes an interrupted staging copy and never restores an uninstalled plugin', async () => {
    const { paths } = await fixture()
    await mkdir(join(paths.installWorkspace, 'migration-fixture'), { recursive: true })
    await writeFile(join(paths.installWorkspace, 'migration-fixture', 'incomplete'), 'partial')
    await preparePluginStorage(paths)
    expect(await Bun.file(join(paths.pluginsDir, 'fixture', 'incomplete')).exists()).toBe(false)
    await rm(join(paths.pluginsDir, 'fixture'), { recursive: true })
    await preparePluginStorage(paths)
    expect(await Bun.file(join(paths.pluginsDir, 'fixture', 'plugin.json')).exists()).toBe(false)
  })

  it('keeps both sides of a collision and reports it once', async () => {
    const { paths, source } = await fixture()
    const target = join(paths.pluginsDir, 'fixture')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'plugin.json'), '{"version":"2.0.0"}')
    expect((await preparePluginStorage(paths)).collisions).toEqual(['fixture'])
    expect(await readFile(join(target, 'plugin.json'), 'utf8')).toBe('{"version":"2.0.0"}')
    expect(await Bun.file(join(source, 'index.ts')).exists()).toBe(true)
    expect((await preparePluginStorage(paths)).collisions).toEqual([])
  })

  it('keeps hoisted npm dependencies after removing the install workspace', async () => {
    const { paths } = await fixture()
    await preparePluginStorage(paths)
    const workspace = join(paths.installWorkspace, 'npm-fixture')
    const pkg = join(workspace, 'node_modules', '@example', 'plugin')
    const dependency = join(workspace, 'node_modules', 'fixture-dependency')
    await mkdir(pkg, { recursive: true })
    await mkdir(dependency, { recursive: true })
    await writeFile(join(pkg, 'plugin.json'), '{}')
    await writeFile(join(dependency, 'package.json'), '{"name":"fixture-dependency","main":"index.js"}')
    await writeFile(join(dependency, 'index.js'), 'module.exports = "dependency-survived"')
    await writeFile(join(pkg, 'index.js'), 'module.exports = require("fixture-dependency")')
    const staged = await stageNpmPlugin(workspace, '@example/plugin')
    const target = join(paths.pluginsDir, 'npm-fixture')
    await publishPlugin(staged, target)
    await rm(workspace, { recursive: true })
    expect(require(join(target, 'index.js'))).toBe('dependency-survived')
    await expect(publishPlugin('/unused', target)).rejects.toThrow('already exists')
  })
})
