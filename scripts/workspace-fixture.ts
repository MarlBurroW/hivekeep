/** Isolated demo: temporary SQLite, local simulated LLM, no host credentials. */
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, extname } from 'node:path'
import { Database } from 'bun:sqlite'
import { demoModels, startDemoProvider } from './demo-provider'

export const demoAdmin = { email: 'admin@demo.test', password: 'DemoOnly123!', name: 'Camille Demo' }
export const demoMember = { email: 'member@demo.test', password: 'DemoOnly123!', name: 'Alex Demo' }

export async function startWorkspaceFixture(
  options: { port?: number; buildDir?: string; language?: string; keepData?: boolean; publicUrl?: string } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'hivekeep-workspace-'))
  const model = demoModels[0].id
  const demoProvider = startDemoProvider()
  const mock = demoProvider.server
  const reserved = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const backendPort = reserved.port!
  reserved.stop(true)
  const buildDir = resolve(options.buildDir ?? process.env.HIVEKEEP_DEMO_BUILD_DIR ?? 'dist/client')
  const frontend = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/api/')) {
        const upstream = new URL(url.pathname + url.search, `http://127.0.0.1:${backendPort}`)
        try {
          return await fetch(new Request(upstream, request), { redirect: 'manual' })
        } catch {
          return new Response('Starting', { status: 503 })
        }
      }
      const filename = resolve(buildDir, '.' + decodeURIComponent(url.pathname))
      if (filename !== buildDir && !filename.startsWith(buildDir + '/'))
        return new Response('Not found', { status: 404 })
      if (filename === buildDir) return new Response(Bun.file(join(buildDir, 'index.html')))
      const file = Bun.file(filename)
      if (await file.exists()) {
        if (filename.endsWith('.js') && request.headers.get('accept-encoding')?.includes('gzip'))
          return new Response(Bun.gzipSync(await file.arrayBuffer()), {
            headers: {
              'content-type': 'application/javascript',
              'content-encoding': 'gzip',
              vary: 'accept-encoding',
            },
          })
        return new Response(file)
      }
      if (extname(url.pathname)) return new Response('Not found', { status: 404 })
      return new Response(Bun.file(join(buildDir, 'index.html')))
    },
  })
  const base = `http://127.0.0.1:${frontend.port}`
  const publicUrl = options.publicUrl ?? base
  const logFile = join(dataDir, 'server.log')
  // Deliberate allowlist: no inherited API keys, .env, DB, provider or directory overrides.
  const environment = {
    PATH: process.env.PATH!,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(backendPort),
    HIVEKEEP_DATA_DIR: dataDir,
    DB_PATH: join(dataDir, 'hivekeep.db'),
    PUBLIC_URL: publicUrl,
    BETTER_AUTH_BASE_URL: publicUrl,
    TRUSTED_ORIGINS: [...new Set([base, publicUrl])].join(','),
    VERSION_CHECK_ENABLED: 'false',
    HIVEKEEP_FEEDBACK_ENDPOINT: '',
    HIVEKEEP_TERMINAL_ENABLED: 'false',
    HIVEKEEP_ENV_FILE: join(dataDir, 'absent.env'),
    LOG_LEVEL: 'warn',
    BUN_INSTALL_CACHE_DIR: join(dataDir, 'cache', 'bun'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(dataDir, 'cache', 'bun-runtime'),
    XDG_STATE_HOME: join(dataDir, 'state'),
    XDG_CACHE_HOME: join(dataDir, 'cache'),
    XDG_CONFIG_HOME: join(dataDir, 'config'),
  }
  const logFd = openSync(logFile, 'w', 0o600)
  const server = Bun.spawn([process.execPath, '--no-env-file', 'src/server/index.ts'], {
    env: environment,
    stdout: logFd,
    stderr: logFd,
  })
  let stopping: Promise<void> | undefined
  const stop = () =>
    (stopping ??= (async () => {
      server.kill('SIGTERM')
      const deadline = setTimeout(() => server.kill('SIGKILL'), 5000)
      try {
        await server.exited
      } finally {
        clearTimeout(deadline)
      }
      frontend.stop(true)
      mock.stop(true)
      closeSync(logFd)
      if (!options.keepData) rmSync(dataDir, { recursive: true, force: true })
    })())

  try {
    let ready = false
    for (let count = 0; count < 100; count++) {
      try {
        if ((await fetch(`${base}/api/onboarding/status`)).ok) {
          ready = true
          break
        }
      } catch {
        /* booting */
      }
      if (server.exitCode !== null) throw new Error(`Demo backend exited. See ${logFile}`)
      await Bun.sleep(200)
    }
    if (!ready) throw new Error(`Demo backend timed out. See ${logFile}`)
    const client = () => {
      let cookie = ''
      return async (method: string, route: string, body?: unknown) => {
        const response = await fetch(base + '/api' + route, {
          method,
          headers: { 'content-type': 'application/json', cookie, origin: base },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const cookies = response.headers.getSetCookie()
        if (cookies.length) cookie = cookies.map((value) => value.split(';')[0]).join('; ')
        if (!response.ok)
          throw new Error(`${method} ${route}: ${response.status} ${(await response.text()).slice(0, 300)}`)
        return response.json() as Promise<any>
      }
    }
    const admin = client()
    await admin('POST', '/auth/sign-up/email', demoAdmin)
    await admin('POST', '/onboarding/profile', {
      firstName: 'Camille',
      pseudonym: 'camille',
      language: options.language ?? 'fr',
    })
    const { provider } = await admin('POST', '/providers', {
      name: 'Démonstration — modèles simulés',
      type: 'openai-compatible',
      config: { apiKey: 'demo-local-only', baseUrl: `http://127.0.0.1:${mock.port}/v1` },
      families: ['llm'],
    })
    const registry = await admin('GET', '/models')
    for (const row of registry.models ?? []) {
      const demoModel = demoModels.find(({ id }) => id === row.modelId)
      if (row.providerId === provider.id && demoModel)
        await admin('PATCH', `/models/${row.id}`, { enabled: true, displayName: demoModel.name })
    }
    await admin('PUT', '/settings/default-llm', { model, providerId: provider.id })
    const { agent } = await admin('POST', '/agents', {
      name: 'Atlas',
      role: 'Recherche, synthèse et préparation de vos projets',
      character: 'Précis, curieux et concis.',
      expertise: 'Rédaction et organisation.',
      model,
      providerId: provider.id,
      toolboxIds: [],
    })
    const { agent: secondAgent } = await admin('POST', '/agents', {
      name: 'Nova',
      role: 'Conception et réalisation de vos idées',
      character: 'Créative et méthodique.',
      expertise: 'Conception de produits.',
      model,
      providerId: provider.id,
      toolboxIds: [],
    })
    const { invitation } = await admin('POST', '/invitations', { label: 'Demo member' })
    const member = client()
    await member('POST', '/auth/sign-up/email', demoMember)
    await member('POST', '/onboarding/profile', {
      firstName: 'Alex',
      pseudonym: 'alex',
      language: options.language ?? 'fr',
      invitationToken: invitation.token,
    })
    const db = new Database(join(dataDir, 'hivekeep.db'))
    db.run('PRAGMA busy_timeout = 5000')
    db.loadExtension(require('sqlite-vec').getLoadablePath())
    const now = Date.now()
    db.run("DELETE FROM app_settings WHERE key = 'onboarding_bootstrap_pending_user'")
    db.run('UPDATE user_profiles SET onboarding_modal_dismissed = 1')
    for (let index = 0; index < 65; index++)
      db.run(
        'INSERT INTO messages (id, agent_id, role, content, source_type, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          agent.id,
          index % 2 ? 'assistant' : 'user',
          index === 0
            ? 'Repère historique : orchidée violette.'
            : index % 2
              ? 'La synthèse est prête. Les documents et prochaines étapes sont rassemblés.'
              : 'Préparons ensemble les prochaines étapes du projet.',
          index % 2 ? 'agent' : 'user',
          now - (66 - index) * 60000,
        ],
      )
    db.run(
      'INSERT INTO human_prompts (id, agent_id, prompt_type, question, options, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        crypto.randomUUID(),
        agent.id,
        'select',
        'Quelle priorité choisir pour la prochaine étape ?',
        JSON.stringify([
          { label: 'Prioriser la clarté', value: 'clarity' },
          { label: 'Prioriser la rapidité', value: 'speed' },
        ]),
        'pending',
        now,
      ],
    )
    for (const [index, status] of ['completed', 'failed'].entries())
      db.run(
        'INSERT INTO tasks (id, parent_agent_id, spawn_type, title, description, status, result, error, depth, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          agent.id,
          'self',
          index ? 'Analyse à reprendre' : 'Synthèse du projet',
          'Préparer les éléments pour la prochaine réunion.',
          status,
          index ? null : 'Synthèse disponible dans la conversation.',
          index ? 'Le fournisseur simulé a refusé cette requête.' : null,
          1,
          now - 600000,
          now - 300000,
        ],
      )
    db.run(
      'INSERT INTO crons (id, agent_id, name, schedule, task_description, is_active, requires_approval, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)',
      [
        crypto.randomUUID(),
        agent.id,
        'Point hebdomadaire',
        '0 9 * * 1',
        'Résumer les progrès et proposer les prochaines étapes.',
        'user',
        now,
        now,
      ],
    )
    const appId = crypto.randomUUID()
    db.run(
      'INSERT INTO mini_apps (id, agent_id, name, slug, description, entry_file, is_active, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)',
      [
        appId,
        secondAgent.id,
        'Carnet de projet',
        'carnet',
        'Les prochaines étapes, au même endroit.',
        'index.html',
        now,
        now,
      ],
    )
    const appDir = join(dataDir, 'mini-apps', secondAgent.id, appId)
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'index.html'),
      '<!doctype html><html lang="fr"><meta charset="utf-8"><title>Carnet</title><body style="font-family:system-ui;padding:2rem"><h1>Carnet de projet</h1><p>Définir le besoin · Concevoir · Vérifier</p></body></html>',
    )
    const workspace = join(dataDir, 'workspaces', agent.id)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(workspace, 'synthese.md'),
      '# Synthèse du projet\n\nUn document de démonstration, sans données réelles.\n',
    )
    db.close()
    return { base, dataDir, agent, secondAgent, stop, admin, member, inferenceCount: demoProvider.inferenceCount }
  } catch (error) {
    await stop()
    throw error
  }
}

if (import.meta.main) {
  const fixture = await startWorkspaceFixture({
    port: Number(process.env.HIVEKEEP_DEMO_PORT ?? 4195),
    publicUrl: process.env.HIVEKEEP_DEMO_PUBLIC_URL,
    keepData: true,
  })
  console.log(`Demo ready on port ${new URL(fixture.base).port}. Temporary data: ${fixture.dataDir}`)
  console.log('Demo accounts: admin@demo.test / member@demo.test — password DemoOnly123!')
  process.on('SIGTERM', async () => {
    await fixture.stop()
    process.exit(0)
  })
  process.on('SIGINT', async () => {
    await fixture.stop()
    process.exit(0)
  })
}
