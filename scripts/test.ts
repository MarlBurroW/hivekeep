/** One Bun process per file: module mocks cannot leak into another suite. */
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir, availableParallelism } from 'node:os'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dir, '..')
const expectedVersion = (await readFile(join(root, '.bun-version'), 'utf8')).trim()
if (Bun.version !== expectedVersion) {
  console.error(`Tests require Bun ${expectedVersion}; found ${Bun.version}. Run bun upgrade --version ${expectedVersion}.`)
  process.exit(1)
}
const requested = process.argv.slice(2)
const files: string[] = []
for (const directory of ['src', 'packages/sdk/src', 'packages/create-hivekeep-plugin', 'plugins']) {
  for await (const file of new Bun.Glob('**/*.test.ts').scan({ cwd: join(root, directory), onlyFiles: true })) {
    if (file.includes('node_modules/')) continue
    const name = `${directory}/${file}`
    if (requested.length === 0 || requested.some((filter) => name.includes(filter.replace(/^\.\//, '')))) files.push(name)
  }
}
files.sort()
if (!files.length) throw new Error('No test files match the requested filters')
const concurrency = Number(process.env.TEST_CONCURRENCY ?? Math.min(4, availableParallelism()))
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('TEST_CONCURRENCY must be an integer from 1 to 16')
const runDir = await mkdtemp(join(tmpdir(), 'hivekeep-tests-'))
const active = new Set<ReturnType<typeof Bun.spawn>>()
let next = 0
let passed = 0
let failed = 0
let skipped = 0
const failures: string[] = []
console.log(`Running ${files.length} test files in isolated processes (${concurrency} workers, Bun ${Bun.version}).`)

function terminateTree(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals) {
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch { /* The process group already exited. */ }
}

async function stop(signal: NodeJS.Signals) {
  for (const child of active) terminateTree(child, signal)
  const deadline = setTimeout(() => { for (const child of active) terminateTree(child, 'SIGKILL') }, 1000)
  await Promise.allSettled([...active].map((child) => child.exited))
  clearTimeout(deadline)
  await rm(runDir, { recursive: true, force: true })
  process.exit(signal === 'SIGINT' ? 130 : 143)
}
process.once('SIGINT', () => void stop('SIGINT'))
process.once('SIGTERM', () => void stop('SIGTERM'))

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (next < files.length) {
      const index = next++
      const file = files[index]!
      const dataDir = join(runDir, String(index))
      await mkdir(dataDir)
      // Allowlist the environment: no inherited provider keys or .env, and each
      // suite gets its own database. OAuth access is mocked in its unit tests.
      const child = Bun.spawn([process.execPath, '--no-env-file', 'test', `./${file}`], {
        cwd: root,
        detached: process.platform !== 'win32',
        env: {
          PATH: process.env.PATH ?? '',
          TMPDIR: dataDir,
          BUN_INSTALL_CACHE_DIR: join(dataDir, 'bun-cache'),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dataDir, 'bun-runtime-cache'),
          XDG_STATE_HOME: join(dataDir, 'state'),
          XDG_CACHE_HOME: join(dataDir, 'cache'),
          XDG_CONFIG_HOME: join(dataDir, 'config'),
          NODE_ENV: 'test',
          HIVEKEEP_DATA_DIR: dataDir,
          HIVEKEEP_TEST_DATA_DIR: dataDir,
          DB_PATH: join(dataDir, 'hivekeep.db'),
          ENCRYPTION_KEY: '00'.repeat(32),
          BETTER_AUTH_SECRET: 'hivekeep-tests-only-never-a-production-secret',
          LOG_LEVEL: 'error',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      })
      active.add(child)
      let timedOut = false
      const deadline = setTimeout(() => { timedOut = true; terminateTree(child, 'SIGKILL') }, 120_000)
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      clearTimeout(deadline)
      active.delete(child)
      const output = `${stdout}\n${stderr}`
      const count = (kind: string) => Number(output.match(new RegExp(`^\\s*(\\d+) ${kind}\\b`, 'm'))?.[1] ?? 0)
      const suitePassed = count('pass')
      const suiteSkipped = count('skip')
      const suiteFailed = count('fail')
      passed += suitePassed
      skipped += suiteSkipped
      failed += suiteFailed
      // No silent skip is accepted. Deliberately unsupported scenarios should
      // be documented outside an executable suite until they can run reliably.
      if (exitCode !== 0 || suiteSkipped > 0 || timedOut || suitePassed === 0) {
        failures.push(file)
        console.error(`FAIL ${file}${timedOut ? ' (120s process timeout)' : ''}${suiteSkipped ? ' (unexpected skipped tests)' : ''}\n${output}`)
      } else {
        console.log(`PASS ${file} (${suitePassed} tests)`)
      }
      await rm(dataDir, { recursive: true, force: true })
    }
  }))
} finally {
  await rm(runDir, { recursive: true, force: true })
}
console.log(`\n${passed} passed · ${failed} failed · ${skipped} skipped · ${files.length} files · ${failures.length} unsuccessful suites`)
if (failures.length) {
  console.error(`Failing suites:\n${failures.map((file) => `  ${file}`).join('\n')}`)
  process.exitCode = 1
}
