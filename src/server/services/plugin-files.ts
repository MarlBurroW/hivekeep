import { cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join, resolve } from 'node:path'

export function pluginPaths(dataDir: string, legacyRoot = process.cwd()) {
  return {
    pluginsDir: resolve(dataDir, 'plugins'),
    installWorkspace: resolve(dataDir, '.plugin-install'),
    migrationDir: resolve(dataDir, '.plugin-migrations'),
    legacyDir: resolve(legacyRoot, 'plugins'),
  }
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Compare the complete copy before publishing it, including link destinations. */
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256')
  async function visit(relative: string) {
    const absolute = join(directory, relative)
    const stat = await lstat(absolute)
    hash.update(`${relative}\0${stat.mode & 0o777}\0`)
    if (stat.isSymbolicLink()) hash.update(`link:${await readlink(absolute)}\0`)
    else if (stat.isDirectory()) {
      hash.update('directory\0')
      for (const entry of (await readdir(absolute)).sort()) await visit(join(relative, entry))
    } else if (stat.isFile()) {
      hash.update(`file:${stat.size}\0`)
      for await (const chunk of createReadStream(absolute)) hash.update(chunk)
    } else throw new Error(`Unsupported plugin file: ${relative}`)
  }
  await visit('')
  return hash.digest('hex')
}

/** Copy legacy installs once; keep originals for rollback and never overwrite. */
export async function preparePluginStorage(paths: ReturnType<typeof pluginPaths>): Promise<{ migrated: string[]; collisions: string[] }> {
  await mkdir(paths.pluginsDir, { recursive: true })
  await mkdir(paths.installWorkspace, { recursive: true })
  await mkdir(paths.migrationDir, { recursive: true })
  const result = { migrated: [] as string[], collisions: [] as string[] }
  // An interrupted update leaves its last working install here. Restore that
  // version before discovery, whether the replacement rename happened or not.
  for (const entry of await readdir(paths.installWorkspace, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^rollback-[a-z0-9-]+$/.test(entry.name)) continue
    const backup = join(paths.installWorkspace, entry.name)
    const target = join(paths.pluginsDir, entry.name.slice('rollback-'.length))
    await rm(target, { recursive: true, force: true })
    await rename(backup, target)
  }
  if (paths.legacyDir === paths.pluginsDir || !await exists(paths.legacyDir)) return result
  for (const entry of (await readdir(paths.legacyDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-z0-9-]+$/.test(entry.name)) continue
    const source = join(paths.legacyDir, entry.name)
    if (!await exists(join(source, 'plugin.json'))) continue
    const marker = join(paths.migrationDir, `${entry.name}.json`)
    if (await exists(marker)) continue // Includes uninstalled migrated plugins.
    const target = join(paths.pluginsDir, entry.name)
    if (await exists(target)) {
      // A crash after rename and before marker creation is recoverable. A real
      // collision keeps the persistent copy authoritative and both copies intact.
      if (await fingerprint(source) !== await fingerprint(target)) result.collisions.push(entry.name)
      await writeFile(marker, JSON.stringify({ source, status: 'kept-existing' }))
      continue
    }
    const staging = join(paths.installWorkspace, `migration-${entry.name}`)
    await rm(staging, { recursive: true, force: true })
    try {
      await cp(source, staging, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true })
      if (await fingerprint(source) !== await fingerprint(staging)) throw new Error(`Plugin copy verification failed: ${entry.name}`)
      await rename(staging, target)
      await writeFile(marker, JSON.stringify({ source, status: 'copied' }))
      result.migrated.push(entry.name)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  return result
}

/** npm hoists dependencies beside the package; move them with the install. */
export async function stageNpmPlugin(workspace: string, packageName: string): Promise<string> {
  const staged = join(workspace, 'plugin')
  await rename(join(workspace, 'node_modules', packageName), staged)
  // Dependencies nested in the package itself remain valid; hoisted ones are
  // copied beside them before the temporary installation workspace is removed.
  await cp(join(workspace, 'node_modules'), join(staged, 'node_modules'), { recursive: true, force: false, errorOnExist: false })
  return staged
}

export async function publishPlugin(staged: string, target: string): Promise<void> {
  if (await exists(target)) throw new Error(`Plugin directory already exists: ${target}`)
  await rename(staged, target)
}

export async function readPluginPackageVersion(directory: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version?: string }).version
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
