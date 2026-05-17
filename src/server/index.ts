import { serveStatic } from 'hono/bun'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { app } from '@/server/app'
import { db, initVirtualTables } from '@/server/db/index'
import { startQueueWorker } from '@/server/services/kin-engine'
import { registerAllTools } from '@/server/tools/register'
import { registerBuiltinLLMProviders } from '@/server/llm/llm/register'
import { registerBuiltinEmbeddingProviders } from '@/server/llm/embedding/register'
import { registerBuiltinImageProviders } from '@/server/llm/image/register'
import { initCronScheduler } from '@/server/services/crons'
import { recoverPendingWakeups } from '@/server/services/wakeup-scheduler'
import { Cron } from 'croner'
import { cleanExpiredFiles } from '@/server/services/file-storage'
import { startQuickSessionCleanup } from '@/server/services/quick-session-cleanup'
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

// One-time migration: backfill missing providerIds on kins/tasks/crons
import { migrateModelProviders } from '@/server/services/migrate-model-providers'
await migrateModelProviders()

// One-time split: any provider row carrying multiple capabilities is broken
// out into one row per family (LLM / Embedding / Image). Idempotent.
import { splitMultiCapabilityProviders } from '@/server/services/split-multi-capability-providers'
await splitMultiCapabilityProviders()

// Backfill placeholder provider slugs left by migration 0071 (idempotent)
import { backfillProviderSlugs } from '@/server/services/provider-slug'
await backfillProviderSlugs()

// Register native tools
log.info('Registering native tools...')
registerAllTools()

// Register built-in LLM / embedding / image providers
log.info('Registering built-in LLM providers...')
registerBuiltinLLMProviders()
registerBuiltinEmbeddingProviders()
registerBuiltinImageProviders()

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

// Start quick session cleanup
startQuickSessionCleanup()

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

// Version check cron (checks GitHub for new releases)
import { startVersionCheckCron } from '@/server/services/version-check'
startVersionCheckCron()

// Notification cleanup cron (daily)
import { cleanupOldNotifications } from '@/server/services/notifications'
new Cron('0 3 * * *', async () => {
  const count = await cleanupOldNotifications()
  if (count > 0) log.info({ count }, 'Notification cleanup completed')
})

// Model-info cache: pre-warm at startup, then refresh on a schedule. Catches
// provider-side spec changes (e.g. Anthropic raising a model's context window)
// and new models without needing a server restart.
import { startModelInfoRefreshCron } from '@/server/services/model-info-cache'
startModelInfoRefreshCron()

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

log.info({ port: config.port, env: process.env.NODE_ENV ?? 'development', dataDir: config.dataDir }, 'KinBot server started')
