import { serveStatic } from 'hono/bun'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { app } from '@/server/app'
import { db, initVirtualTables } from '@/server/db/index'
import { startQueueWorker } from '@/server/services/agent-engine'
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
import { initCronScheduler } from '@/server/services/crons'
import { recoverPendingWakeups } from '@/server/services/wakeup-scheduler'
import { startEmailTriggerPoller } from '@/server/services/email-trigger-poller'
import { Cron } from 'croner'
import { cleanExpiredFiles } from '@/server/services/file-storage'
import { startQuickSessionCleanup } from '@/server/services/quick-session-cleanup'
import { startStaleWorktreeCleanup } from '@/server/services/worktree-cleanup'
import { playwrightManager } from '@/server/services/playwright-manager'
import { channelAdapters } from '@/server/channels/index'
import { TelegramAdapter } from '@/server/channels/telegram'
import { DiscordAdapter } from '@/server/channels/discord'
import { SlackAdapter } from '@/server/channels/slack'
import { WhatsAppAdapter } from '@/server/channels/whatsapp'
import { SignalAdapter } from '@/server/channels/signal'
import { MatrixAdapter } from '@/server/channels/matrix'
import { restoreActiveChannels } from '@/server/services/channels'
import { ensureUserContactsExist } from '@/server/services/contacts'
import { pluginManager } from '@/server/services/plugins'
import { logStore } from '@/server/services/log-store'
import { sseManager } from '@/server/sse/index'
import { preloadTokenizer } from '@/shared/token-estimator'

const log = createLogger('server')

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

// Eagerly load the BPE tokenizer (~1 MB) so the very first context-size
// estimation uses the accurate path instead of falling back to chars/4.
preloadTokenizer().catch((err) => log.warn({ err }, 'Tokenizer preload failed; estimator will fall back to chars/4 until first async call'))

// Wire log entries to SSE broadcast for real-time frontend viewer
logStore.setOnEntry((entry) => {
  sseManager.broadcast({ type: 'log:entry', data: entry as unknown as Record<string, unknown> })
})

// Run Drizzle migrations (creates tables if DB is fresh)
log.info('Running database migrations...')
migrate(db, { migrationsFolder: './src/server/db/migrations' })
log.info('Database migrations complete')

// Initialize FTS5 and sqlite-vec virtual tables
log.info('Initializing virtual tables (FTS5, sqlite-vec)...')
initVirtualTables()
log.info('Virtual tables initialized')

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

// Start the email account trigger poller (condition-matched email → Agent)
log.info('Starting email trigger poller...')
startEmailTriggerPoller()

// Start quick session cleanup
startQuickSessionCleanup()

// Start the stale-worktree sweeper (reclaims sub-task worktrees that
// outlived their TTL — see config.repos.worktreeKeepFailedSec).
startStaleWorktreeCleanup()

// Ensure all users have a linked contact
ensureUserContactsExist().catch((err) => log.error({ err }, 'Failed to backfill user contacts'))

// Register channel adapters and restore active channels
channelAdapters.register(new TelegramAdapter())
channelAdapters.register(new DiscordAdapter())
channelAdapters.register(new SlackAdapter())
channelAdapters.register(new WhatsAppAdapter())
channelAdapters.register(new SignalAdapter())
channelAdapters.register(new MatrixAdapter())
restoreActiveChannels().catch((err) => log.error({ err }, 'Failed to restore active channels'))

// File storage cleanup cron
new Cron(`*/${config.fileStorage.cleanupIntervalMin} * * * *`, async () => {
  const count = await cleanExpiredFiles()
  if (count > 0) log.info({ count }, 'File storage cleanup completed')
})

// Tool output spill cleanup (delete old temp files from workspaces)
import { cleanupSpilledOutputs } from '@/server/services/tool-output-spill'
new Cron('0 * * * *', async () => {
  const count = cleanupSpilledOutputs(config.workspace.baseDir)
  if (count > 0) log.info({ count }, 'Tool output spill cleanup completed')
})

// Channel file cleanup (old downloads from platforms)
import { startChannelFileCleanup } from '@/server/services/files'
startChannelFileCleanup()

// Webhook log cleanup (prune old/excess logs)
import { startWebhookLogCleanup } from '@/server/services/webhooks'
startWebhookLogCleanup()

// Trigger log cleanup (prune old trigger evaluation logs)
import { startTriggerLogCleanup } from '@/server/services/account-triggers'
startTriggerLogCleanup()

// Version check cron (checks GitHub for new releases)
import { startVersionCheckCron } from '@/server/services/version-check'
startVersionCheckCron()

// Notification cleanup cron (daily)
import { cleanupOldNotifications } from '@/server/services/notifications'
new Cron('0 3 * * *', async () => {
  const count = await cleanupOldNotifications()
  if (count > 0) log.info({ count }, 'Notification cleanup completed')
})

// Install a previously-refreshed models.dev snapshot (data-dir override) over
// the bundled one, before any reconcile reads it.
import { loadPersistedSnapshot } from '@/server/services/models-dev-snapshot'
loadPersistedSnapshot()

// Model-info cache: pre-warm at startup, then refresh on a schedule. Catches
// provider-side spec changes (e.g. Anthropic raising a model's context window)
// and new models without needing a server restart.
import { startModelInfoRefreshCron } from '@/server/services/model-info-cache'
startModelInfoRefreshCron()

// Wire usage-cost pricing (DI — keeps token-usage decoupled from the model
// registry's import graph), then run a one-time, deferred, idempotent backfill
// of historical LLM-usage costs (current-price estimate for pre-feature rows).
import { backfillUsageCosts, setUsageCostHooks } from '@/server/services/token-usage'
import { getModelPricing, listModelsWithPricing } from '@/server/services/model-registry'
setUsageCostHooks({ getPricing: getModelPricing, listPricedModels: listModelsWithPricing })
setTimeout(() => backfillUsageCosts(), 5000)

// Serve uploaded files
app.use('/api/uploads/*', serveStatic({ root: config.upload.dir, rewriteRequestPath: (path) => path.replace('/api/uploads', '') }))

// In production, serve static files from Vite build
if (process.env.NODE_ENV === 'production') {
  app.use('/*', serveStatic({ root: './dist/client' }))
  app.get('*', serveStatic({ path: './dist/client/index.html' }))
}

Bun.serve({
  port: config.port,
  hostname: process.env.HOST ?? '127.0.0.1',
  fetch: app.fetch,
  idleTimeout: 255, // seconds — keep SSE connections alive (Bun default is 10s)
  // Lift Bun's ~128 MB default body cap so large file-storage uploads succeed.
  // Configurable via MAX_REQUEST_BODY_MB; defaults to effectively unlimited.
  maxRequestBodySize: config.maxRequestBodyBytes,
})

// Graceful shutdown — cleanup browser pool
const shutdown = async () => {
  log.info('Shutting down...')
  await playwrightManager.shutdown()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Stream log entries to connected clients via SSE
logStore.setOnEntry((entry) => {
  sseManager.broadcast({
    type: 'log:entry',
    data: entry as unknown as Record<string, unknown>,
  })
})

log.info({ port: config.port, env: process.env.NODE_ENV ?? 'development', dataDir: config.dataDir }, 'Hivekeep server started')
