import { resolve } from 'node:path'
import { createFullBackup, restoreFullBackup, verifyFullBackup } from '../src/server/services/backup-files'
import { recordVerifiedBackup } from '../src/server/services/backup-status'

const [command, ...args] = process.argv.slice(2)
const usage = 'Usage: bun run backup create --stopped --to <new-directory> [--data-dir <data>] [--include-folders] | verify --from <backup> [--data-dir <data>] | restore --from <backup> --to <new-directory>'
if (command === '--help' || command === '-h' || command === 'help') {
  console.log(usage)
  process.exit(0)
}
function option(name: string) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const destination = option('--to')
const source = option('--from')
const storageVariables = ['VAULT_ATTACHMENT_DIR', 'WORKSPACE_BASE_DIR', 'UPLOAD_DIR', 'FILE_STORAGE_DIR', 'WHATSAPP_WEB_DIR', 'BROWSER_STATES_DIR', 'MINI_APPS_DIR', 'HIVEKEEP_CUSTOM_TOOLS_DIR']

try {
  if (command === 'create' && destination) {
    const dataDir = resolve(option('--data-dir') ?? process.env.HIVEKEEP_DATA_DIR ?? './data')
    const externalDirectories = Object.fromEntries(storageVariables.flatMap((name) => process.env[name] ? [[name, process.env[name]!]] : []))
    const manifest = await createFullBackup({
      dataDir, dbPath: resolve(process.env.DB_PATH ?? `${dataDir}/hivekeep.db`),
      destination, appVersion: (await Bun.file(new URL('../package.json', import.meta.url)).json()).version,
      instanceStopped: args.includes('--stopped'), encryptionKey: process.env.ENCRYPTION_KEY, externalDirectories,
      includeFolders: args.includes('--include-folders'),
    })
    await recordVerifiedBackup(dataDir, manifest.roots.data!, manifest.createdAt)
    console.log(`Backup created and verified: ${resolve(destination)} (${manifest.entries.length} entries)`)
  } else if (command === 'verify' && source) {
    const manifest = await verifyFullBackup(source)
    const dataDir = resolve(option('--data-dir') ?? process.env.HIVEKEEP_DATA_DIR ?? './data')
    await recordVerifiedBackup(dataDir, manifest.roots.data!, manifest.createdAt)
    console.log(`Backup verified: ${resolve(source)} (Hivekeep ${manifest.appVersion}, ${manifest.createdAt})`)
  } else if (command === 'restore' && source && destination) {
    await restoreFullBackup(source, destination)
    console.log(`Restored into a new directory: ${resolve(destination)}`)
    console.log('Storage paths are in restore-env.json. No service has been started or reconfigured.')
  } else {
    throw new Error(usage)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
