import { serveStatic } from 'hono/bun'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { app } from '@/server/app'
import { db, sqlite, initVirtualTables } from '@/server/db/index'
import { quickSessions, channels, userProfiles } from '@/server/db/schema'
import { eq } from 'drizzle-orm'
import { runMigrations } from '@/server/db/run-migrations'
import { startQueueWorker, stopQueueWorker, getActiveQueueTurnCount, abortActiveQueueTurns } from '@/server/services/agent-engine'
import { registerAllTools } from '@/server/tools/register'
import { seedBuiltinToolboxes } from '@/server/services/toolboxes'
import { seedBuiltinToolDomains } from '@/server/services/tool-domains'
import { registerBuiltinLLMProviders } from '@/server/llm/llm/register'
import { registerBuiltinEmbeddingProviders } from '@/server/llm/embedding/register'
import { registerBuiltinImageProviders } from '@/server/llm/image/register'
import { registerBuiltinSearchProviders } from '@/server/llm/search/register'
import { registerBuiltinTTSProviders } from '@/server/llm/tts/register'
import { registerBuiltinSTTProviders } from '@/server/llm/stt/register'
import { registerBuiltinEmailProviders } from '@/server/email/register'
import { registerBuiltinContactsProviders } from '@/server/contacts/register'
import { registerBuiltinCalendarProviders } from '@/server/calendar/register'
import { initCronScheduler, stopAllCrons } from '@/server/services/crons'
import { recoverPendingWakeups, stopWakeupTimers } from '@/server/services/wakeup-scheduler'
import { startEmailTriggerPoller, stopEmailTriggerPoller } from '@/server/services/email-trigger-poller'
import { Cron } from 'croner'
import { createShutdown, isShuttingDown } from '@/server/services/shutdown'
import { getActiveTaskExecutionCount, abortActiveTaskExecutions } from '@/server/services/tasks'
import { cleanExpiredFiles } from '@/server/services/file-storage'
import { startQuickSessionCleanup, stopQuickSessionCleanup } from '@/server/services/quick-session-cleanup'
import { playwrightManager } from '@/server/services/playwright-manager'
import { channelAdapters } from '@/server/channels/index'
import { TelegramAdapter } from '@/server/channels/telegram'
import { DiscordAdapter } from '@/server/channels/discord'
import { SlackAdapter } from '@/server/channels/slack'
import { WhatsAppAdapter } from '@/server/channels/whatsapp'
import { whatsAppWebAdapter } from '@/server/channels/whatsapp-web'
import { SignalAdapter } from '@/server/channels/signal'
import { MatrixAdapter } from '@/server/channels/matrix'
import { restoreActiveChannels } from '@/server/services/channels'
import { ensureUserContactsExist } from '@/server/services/contacts'
import { pluginManager } from '@/server/services/plugins'
import { logStore } from '@/server/services/log-store'
import { sseManager } from '@/server/sse/index'
import { preloadTokenizer } from '@/shared/token-estimator'

const log = createLogger('server')

// Eagerly load the BPE tokenizer (~1 MB) so the very first context-size
// estimation uses the accurate path instead of falling back to chars/4.
preloadTokenizer().catch((err) => log.warn({ err }, 'Tokenizer preload failed; estimator will fall back to chars/4 until first async call'))

// Run Drizzle migrations (creates tables if DB is fresh)
log.info('Running database migrations...')
runMigrations(sqlite, db, './src/server/db/migrations')
log.info('Database migrations complete')

// Initialize FTS5 and sqlite-vec virtual tables
log.info('Initializing virtual tables (FTS5, sqlite-vec)...')
initVirtualTables()
log.info('Virtual tables initialized')

// Remove orphaned vector rows (deletion paths that missed the vec tables
// leave orphans that occupy KNN slots and blind memory dedup).
import { reconcileVectorTables } from '@/server/services/vector-maintenance'
reconcileVectorTables()

// One-time migration: backfill missing providerIds on agents/tasks/crons
import { migrateModelProviders } from '@/server/services/migrate-model-providers'
await migrateModelProviders()

// Backfill placeholder provider slugs left by migration 0071 (idempotent)
import { backfillProviderSlugs } from '@/server/services/provider-slug'
await backfillProviderSlugs()

// Move any inline provider secrets into the vault, rewriting config to
// $vault: references (idempotent — already-migrated rows are skipped).
import { migrateProviderConfigsToVault } from '@/server/services/provider-config'
await migrateProviderConfigsToVault()

// A failed recovery sweep must prevent every inference producer from starting.
// In particular, do not start plugins, queue workers or scheduled triggers while
// a revealed secret from an interrupted turn is still present in history.
const { sweepRevealedSecrets } = await import('@/server/services/secret-redaction')
const redactedCarriers = await sweepRevealedSecrets()
if (redactedCarriers > 0) {
  log.warn({ count: redactedCarriers }, 'Boot sweep: redacted stale revealed-secret carriers')
}

// Install runtime guards only AFTER critical startup recovery. Otherwise a
// rejected boot import is swallowed and leaves a process alive without HTTP.
// ---------------------------------------------------------------------------
// Last-resort process guards. Hivekeep is a single process: an uncaught error
// anywhere — a stray setInterval/setTimeout callback, a WebSocket/event
// listener, or a floating promise without a .catch() — would otherwise
// terminate the whole server and drop every connected client's SSE stream.
// (That is exactly how a Discord-gateway heartbeat bug used to crash us.)
// Plugins run in-process via dynamic import and share this event loop, so the
// host cannot wrap the async work a plugin schedules on its own. We log with
// full context and stay alive: a localized fault must never take the server
// down for everyone. A surviving process can be inconsistent in rare cases,
// but for a single-process self-hosted app that trade-off beats a total
// outage. True per-plugin isolation would require a worker/child-process
// boundary — a larger change tracked separately.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Unhandled promise rejection — kept alive')
})
process.on('uncaughtException', (err) => {
  log.error({ err }, 'Uncaught exception — kept alive')
})

// Private-session events are delivered only to their owner, including streams
// restored after reconnect. Resolve ownership server-side before workers start.
sseManager.setSessionOwnerResolver((sessionId) => db
  .select({ createdBy: quickSessions.createdBy }).from(quickSessions)
  .where(eq(quickSessions.id, sessionId)).get()?.createdBy ?? null)

// Register native tools
log.info('Registering native tools...')
registerAllTools()

// Seed built-in toolboxes (idempotent). Runs after tool registration so the
// 'all' wildcard can later expand against the full registry, and after
// migrations so the toolboxes table exists.
log.info('Seeding built-in toolboxes...')
seedBuiltinToolboxes()

// One-time: make existing null-toolbox Agents explicit ['all'] now that the
// resolver default changed to "no toolbox → CORE floor only" (runs after the
// built-in toolboxes are seeded so the 'all' box exists).
import { migrateNullAgentToolboxesToAll } from '@/server/services/migrate-agent-toolboxes'
await migrateNullAgentToolboxesToAll()

// Seed built-in tool domains (idempotent). Runs after migrations so the
// tool_domains table exists; custom_tools.domain_slug FKs into it.
log.info('Seeding built-in tool domains...')
seedBuiltinToolDomains()

// Register built-in LLM / embedding / image providers
log.info('Registering built-in LLM providers...')
registerBuiltinLLMProviders()
registerBuiltinEmbeddingProviders()
registerBuiltinImageProviders()
registerBuiltinSearchProviders()
registerBuiltinTTSProviders()
registerBuiltinSTTProviders()
registerBuiltinEmailProviders()
registerBuiltinContactsProviders()
registerBuiltinCalendarProviders()

// Scan and load plugins
log.info('Scanning for plugins...')
await pluginManager.scan()
pluginManager.startWatching()

// Start the queue worker
log.info('Starting queue worker...')
startQueueWorker()

// Initialize cron scheduler (restore active crons from DB)
log.info('Initializing cron scheduler...')
initCronScheduler()

// Recover pending wake-ups (reschedule timers after restart)
log.info('Recovering pending wake-ups...')
recoverPendingWakeups().catch((err) => log.error({ err }, 'Failed to recover pending wake-ups'))

// Start mini-app backends that declare "background": true in app.json
log.info('Starting background mini-app backends...')
import { initMiniAppBackends, stopAllBackends } from '@/server/services/mini-app-backend'
initMiniAppBackends().catch((err) => log.error({ err }, 'Failed to init mini-app backends'))

// Start the email account trigger poller (condition-matched email → Agent)
log.info('Starting email trigger poller...')
startEmailTriggerPoller()

// Start quick session cleanup
startQuickSessionCleanup()

// Restore persisted terminal sessions (dormant) so the Terminal sidebar +
// scrollback survive a restart; tmux-backed ones reconnect to live shells.
import { setTerminalPersistence, restorePersistedSessions, flushTerminalSessionsForShutdown } from '@/server/services/terminal-sessions'
import { createDbTerminalPersistence } from '@/server/services/terminal-store'
if (config.terminal.enabled) {
  setTerminalPersistence(createDbTerminalPersistence())
  try {
    log.info('Restoring persisted terminal sessions...')
    restorePersistedSessions()
  } catch (err) {
    log.error({ err }, 'Failed to restore terminal sessions')
  }
}

// Ensure all users have a linked contact
ensureUserContactsExist().catch((err) => log.error({ err }, 'Failed to backfill user contacts'))

// Register channel adapters and restore active channels
channelAdapters.register(new TelegramAdapter())
channelAdapters.register(new DiscordAdapter())
channelAdapters.register(new SlackAdapter())
channelAdapters.register(new WhatsAppAdapter())
channelAdapters.register(whatsAppWebAdapter)
channelAdapters.register(new SignalAdapter())
channelAdapters.register(new MatrixAdapter())
restoreActiveChannels().catch((err) => log.error({ err }, 'Failed to restore active channels'))

// File storage cleanup cron
const fileCleanupCron = new Cron(`*/${config.fileStorage.cleanupIntervalMin} * * * *`, async () => {
  const count = await cleanExpiredFiles()
  if (count > 0) log.info({ count }, 'File storage cleanup completed')
})

// Tool output spill cleanup (delete old temp files from workspaces)
import { cleanupSpilledOutputs } from '@/server/services/tool-output-spill'
const spillCleanupCron = new Cron('0 * * * *', async () => {
  const count = cleanupSpilledOutputs(config.workspace.baseDir)
  if (count > 0) log.info({ count }, 'Tool output spill cleanup completed')
})

// Channel file cleanup (old downloads from platforms)
import { startChannelFileCleanup, stopChannelFileCleanup } from '@/server/services/files'
startChannelFileCleanup()

// Stuck-Agent watch (warn, then requeue an Agent wedged in 'processing')
import { startStuckAgentWatch, stopStuckAgentWatch } from '@/server/services/stuck-agent-watch'
startStuckAgentWatch()

// Channel origin cleanup (prune origins past the delivery freshness window)
import { startChannelOriginCleanup, stopChannelOriginCleanup } from '@/server/services/channels'
startChannelOriginCleanup()

// Webhook log cleanup (prune old/excess logs)
import { startWebhookLogCleanup, stopWebhookLogCleanup } from '@/server/services/webhooks'
startWebhookLogCleanup()

// Trigger cleanup (prune old evaluation logs + dead one-shot reply watches)
import { startTriggerCleanup, stopTriggerCleanup } from '@/server/services/account-triggers'
startTriggerCleanup()

// External API request GC (prune resolved api_requests past retention)
import { startExternalApiCleanup, stopExternalApiCleanup } from '@/server/services/external-api'
startExternalApiCleanup()

// Version check cron (checks GitHub for new releases)
import { startVersionCheckCron, stopVersionCheckCron } from '@/server/services/version-check'
startVersionCheckCron()

// Notification cleanup cron (daily)
import { cleanupOldNotifications } from '@/server/services/notifications'
import { purgeDoneQueueItems } from '@/server/services/queue'
const notificationCleanupCron = new Cron('0 3 * * *', async () => {
  const count = await cleanupOldNotifications()
  if (count > 0) log.info({ count }, 'Notification cleanup completed')
  const purged = purgeDoneQueueItems(7 * 24 * 60 * 60 * 1000)
  if (purged > 0) log.info({ purged }, 'Processed queue items purged')
})
// One-shot at boot too: installed instances carry months of done rows.
purgeDoneQueueItems(7 * 24 * 60 * 60 * 1000)

// Install a previously-refreshed models.dev snapshot (data-dir override) over
// the bundled one, before any reconcile reads it.
import { loadPersistedSnapshot } from '@/server/services/models-dev-snapshot'
loadPersistedSnapshot()

// Model-info cache: pre-warm at startup, then refresh on a schedule. Catches
// provider-side spec changes (e.g. Anthropic raising a model's context window)
// and new models without needing a server restart.
import { startModelInfoRefreshCron, stopModelInfoRefreshCron } from '@/server/services/model-info-cache'
startModelInfoRefreshCron()

// Wire usage-cost pricing (DI — keeps token-usage decoupled from the model
// registry's import graph), then run a one-time, deferred, idempotent backfill
// of historical LLM-usage costs (current-price estimate for pre-feature rows).
import { backfillUsageCosts, setUsageCostHooks } from '@/server/services/token-usage'
import { getModelPricing, listModelsWithPricing } from '@/server/services/model-registry'
setUsageCostHooks({ getPricing: getModelPricing, listPricedModels: listModelsWithPricing })
const usageBackfillTimer = setTimeout(() => backfillUsageCosts(), 5000)

// One-shot, idempotent migration to memory v2: compile each Agent's existing
// memory archive into an initial profile document. Deferred and fire-and-forget
// — it makes LLM calls per Agent and must never hold up boot.
import { bootstrapProfiles } from '@/server/services/agent-profile-bootstrap'
const memoryBootstrapTimer = setTimeout(() => {
  bootstrapProfiles().catch((err) => log.error({ err }, 'Memory profile bootstrap failed'))
}, 10_000)

// Serve uploaded files
import { requireMessageFileAccess } from '@/server/middleware/message-file-access'
app.use('/api/uploads/*', requireMessageFileAccess)
app.use('/api/uploads/*', serveStatic({ root: config.upload.dir, rewriteRequestPath: (path) => path.replace('/api/uploads', '') }))

// In production, serve static files from Vite build
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist/client' }))
  app.get('*', serveStatic({ path: './dist/client/index.html' }))
}

// WebSocket handler for the admin terminal (hono/bun upgrade glue)
import { terminalWebSocket } from '@/server/routes/terminal'

// Edge guard: strip in-process-only trust headers from every INBOUND request so
// they can never be spoofed from the network. Server-side re-dispatch (the
// mini-app platform gateway calling app.fetch) sets them AFTER this boundary.
const STRIPPED_INBOUND_HEADERS = ['x-hivekeep-internal-actor']
let activeHttpRequests = 0
const fetchWithEdgeGuard = async (req: Request, server: unknown) => {
  if (isShuttingDown()) return new Response('Server restarting', { status: 503, headers: { 'Retry-After': '5' } })
  let stripped = false
  for (const h of STRIPPED_INBOUND_HEADERS) {
    if (req.headers.has(h)) stripped = true
  }
  if (stripped) {
    const headers = new Headers(req.headers)
    for (const h of STRIPPED_INBOUND_HEADERS) headers.delete(h)
    req = new Request(req, { headers })
  }
  activeHttpRequests++
  try { return await (app.fetch as (r: Request, s?: unknown) => Response | Promise<Response>)(req, server) }
  finally { activeHttpRequests-- }
}

const httpServer = Bun.serve({
  port: config.port,
  hostname: process.env.HOST ?? '127.0.0.1',
  fetch: fetchWithEdgeGuard,
  websocket: terminalWebSocket,
  idleTimeout: 255, // seconds — keep SSE connections alive (Bun default is 10s)
  // Explicit finite cap, including multipart overhead (MAX_REQUEST_BODY_MB).
  maxRequestBodySize: config.maxRequestBodyBytes,
})

// Keep queued inputs durable and let active turns finish before releasing their
// tools. A hard deadline also covers a plugin/browser which never settles.
const stop = createShutdown({
  ...config.shutdown,
  stopAdmission() {
    void httpServer.stop(false)
    sseManager.closeAll()
  },
  stopProducers() {
    stopQueueWorker()
    stopAllCrons()
    stopWakeupTimers()
    stopEmailTriggerPoller()
    stopQuickSessionCleanup()
    stopExternalApiCleanup()
    stopChannelFileCleanup()
    stopStuckAgentWatch()
    stopChannelOriginCleanup()
    stopWebhookLogCleanup()
    stopTriggerCleanup()
    stopVersionCheckCron()
    stopModelInfoRefreshCron()
    pluginManager.stopWatching()
    fileCleanupCron.stop()
    spillCleanupCron.stop()
    notificationCleanupCron.stop()
    clearTimeout(usageBackfillTimer)
    clearTimeout(memoryBootstrapTimer)
  },
  activeWork: () => activeHttpRequests + getActiveQueueTurnCount() + getActiveTaskExecutionCount(),
  abortRemaining() {
    abortActiveQueueTurns()
    abortActiveTaskExecutions()
  },
  async closeResources() {
    // Disconnect transports without disabling their persisted configuration.
    const transports = db.select({ id: channels.id, platform: channels.platform }).from(channels).all()
    const results = await Promise.allSettled([
      ...transports.map((channel) => channelAdapters.get(channel.platform)?.stop(channel.id)),
      playwrightManager.shutdown(), stopAllBackends(), pluginManager.shutdown(),
    ])
    for (const result of results) {
      if (result.status === 'rejected') log.warn({ err: result.reason }, 'Shutdown cleanup failed')
    }
    flushTerminalSessionsForShutdown()
    await httpServer.stop(true)
    sqlite.close()
  },
  onError: (err) => log.error({ err }, 'Shutdown stage failed'),
})
const shutdown = () => {
  log.info('Stopping admissions and draining active work...')
  void stop().then(({ drained, cleaned }) => {
    log.info({ drained, cleaned }, 'Shutdown finished')
    process.exit(cleaned ? 0 : 1)
  }).catch((err) => {
    log.error({ err }, 'Shutdown failed')
    process.exit(1)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Stream log entries to connected clients via SSE
logStore.setOnEntry((entry) => {
  // Match /api/logs permissions: members must not receive operational logs
  // simply because their browser has a global SSE connection open.
  const admins = db.select({ id: userProfiles.userId }).from(userProfiles)
    .where(eq(userProfiles.role, 'admin')).all()
  for (const admin of admins) sseManager.sendToUser(admin.id, {
    type: 'log:entry', data: entry as unknown as Record<string, unknown>,
  })
})

// Finalize a pending self-update now that the server is actually listening:
// marks the update journal as succeeded (we are the new version) or surfaces
// the automatic rollback the boot guard performed (we are the restored one).
import { finalizeUpdateOnBoot } from '@/server/services/self-update'
finalizeUpdateOnBoot()

log.info({ port: config.port, env: process.env.NODE_ENV ?? 'development', dataDir: config.dataDir }, 'Hivekeep server started')
