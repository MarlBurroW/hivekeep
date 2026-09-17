import { createShutdown } from './shutdown'

const mode = process.argv[2]
const events: string[] = []
let active = 1
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') })
const stop = createShutdown({
  stopAdmission() { events.push('admission'); void server.stop(false) },
  stopProducers() {
    events.push('producers')
    if (mode === 'drain') setTimeout(() => { active = 0; events.push('committed') }, 60)
  },
  activeWork: () => active,
  abortRemaining() { events.push('abort'); active = 0 },
  async closeResources() {
    events.push('resources')
    if (mode === 'hung-cleanup') await new Promise(() => {})
    await server.stop(true)
  },
  drainTimeoutMs: mode === 'drain' ? 500 : 30,
  cleanupTimeoutMs: 80,
  onError(error) { events.push(`error:${String(error)}`) },
})
process.on('SIGTERM', () => {
  // Simulate repeated signals in the same turn, before drain has settled.
  const first = stop()
  const second = stop()
  void first.then((result) => {
    process.stdout.write(JSON.stringify({ ...result, events, samePromise: first === second }) + '\n')
    process.exit(result.cleaned ? 0 : 1)
  })
})
process.stdout.write('READY\n')
