import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { count } from 'drizzle-orm'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { db } from '@/server/db/index'
import { agents, providers, channels, crons, memories, mcpServers, contacts, user } from '@/server/db/schema'
import { authMiddleware } from '@/server/auth/middleware'
import { miniAppOriginGuard } from '@/server/auth/mini-app-origin-guard'
import { authRoutes } from '@/server/routes/auth'
import { meRoutes } from '@/server/routes/me'
import { onboardingRoutes } from '@/server/routes/onboarding'
import { providerRoutes } from '@/server/routes/providers'
import { modelRoutes } from '@/server/routes/models'
import { emailAccountRoutes } from '@/server/routes/email-accounts'
import { contactsAccountRoutes } from '@/server/routes/contacts-accounts'
import { connectedAccountRoutes } from '@/server/routes/connected-accounts'
import { pendingEmailSendRoutes } from '@/server/routes/pending-email-sends'
import { sseRoutes } from '@/server/routes/sse'
import { agentRoutes } from '@/server/routes/agents'
import { toolsRoutes } from '@/server/routes/tools'
import { toolboxRoutes } from '@/server/routes/toolboxes'
import { toolDomainRoutes } from '@/server/routes/tool-domains'
import { customToolRoutes } from '@/server/routes/custom-tools'
import { messageRoutes } from '@/server/routes/messages'
import { reactionRoutes } from '@/server/routes/reactions'
import { vaultRoutes } from '@/server/routes/vault'
import { contactRoutes } from '@/server/routes/contacts'
import { taskRoutes } from '@/server/routes/tasks'
import { cronRoutes } from '@/server/routes/crons'
import { projectRoutes } from '@/server/routes/projects'
import { tagRoutes } from '@/server/routes/tags'
import { ticketRoutes } from '@/server/routes/tickets'
import { mcpServerRoutes } from '@/server/routes/mcp-servers'
import { fileRoutes } from '@/server/routes/files'
import { fileStorageRoutes } from '@/server/routes/file-storage'
import { promptRoutes } from '@/server/routes/prompts'
import { secretPromptRoutes } from '@/server/routes/secret-prompts'
import { memoryRoutes } from '@/server/routes/memories'
import { sharedRoutes } from '@/server/routes/shared'
import { webhookRoutes } from '@/server/routes/webhooks'
import { webhookIncomingRoutes } from '@/server/routes/webhooks-incoming'
import { accountTriggerRoutes } from '@/server/routes/account-triggers'
import { channelRoutes } from '@/server/routes/channels'
import { channelTelegramRoutes } from '@/server/routes/channel-telegram'
import { channelSlackRoutes } from '@/server/routes/channel-slack'
import { channelWhatsAppRoutes } from '@/server/routes/channel-whatsapp'
import { channelSignalRoutes } from '@/server/routes/channel-signal'
import { quickSessionAgentRoutes, quickSessionDetailRoutes } from '@/server/routes/quick-sessions'
import { userRoutes } from '@/server/routes/users'
import { invitationRoutes } from '@/server/routes/invitations'
import { notificationRoutes } from '@/server/routes/notifications'
import { settingsRoutes } from '@/server/routes/settings'
import { miniAppRoutes, miniAppSdkRoutes } from '@/server/routes/mini-apps'
import { pluginRoutes } from '@/server/routes/plugins'
import { pluginCardRoutes } from '@/server/routes/plugin-cards'
import { knowledgeRoutes } from '@/server/routes/knowledge'
import { workspaceFilesRoutes } from '@/server/routes/workspace-files'
import { logRoutes } from '@/server/routes/logs'
import { terminalRoutes } from '@/server/routes/terminal'
import { usageRoutes } from '@/server/routes/usage'
import { versionCheckRoutes } from '@/server/routes/version-check'

export type AppVariables = {
  session: { id: string; userId: string; token: string }
  user: { id: string; name: string; email: string }
}

const app = new Hono<{ Variables: AppVariables }>()
const log = createLogger('http')

// Global middleware
app.use('*', cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    ...(process.env.TRUSTED_ORIGINS ? process.env.TRUSTED_ORIGINS.split(',').map(o => o.trim()) : []),
    ...(config.publicUrl ? [config.publicUrl] : []),
  ],
  credentials: true,
}))
// HTTP request logging
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  const path = c.req.path
  // Skip noisy endpoints
  if (path === '/api/sse' || path === '/api/health') return
  const status = c.res.status
  const data = { method: c.req.method, path, status, durationMs: Date.now() - start }
  if (status >= 500) log.error(data, 'Request failed')
  else if (status >= 400) log.warn(data, 'Client error')
  else log.debug(data, 'Request completed')
})

// Global error handler — ensures all unhandled exceptions return JSON, not plain text
app.onError((err, c) => {
  log.error({ err }, 'Unhandled error')
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, 500)
})

// Sandbox mini-app iframes to their own namespace (defense-in-depth) before auth.
app.use('/api/*', miniAppOriginGuard)

app.use('/api/*', authMiddleware)

// Health check (no auth required — used by Docker HEALTHCHECK and orchestrators)
const serverStartedAt = Date.now()
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: config.version,
    uptime: Math.floor((Date.now() - serverStartedAt) / 1000),
    timestamp: Date.now(),
  })
})

// Changelog (authenticated — returns CHANGELOG.md content)
app.get('/api/changelog', async (c) => {
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const changelogPath = path.resolve(import.meta.dirname ?? '.', '..', 'CHANGELOG.md')
    const content = await fs.readFile(changelogPath, 'utf-8')
    return c.json({ content })
  } catch {
    return c.json({ content: '' })
  }
})

// System info (authenticated — stats about the instance)
const startedAt = Date.now()
app.get('/api/info', async (c) => {
  const [
    [agentCount],
    [providerCount],
    [channelCount],
    [cronCount],
    [memoryCount],
    [mcpCount],
    [contactCount],
    [userCount],
  ] = await Promise.all([
    db.select({ value: count() }).from(agents),
    db.select({ value: count() }).from(providers),
    db.select({ value: count() }).from(channels),
    db.select({ value: count() }).from(crons),
    db.select({ value: count() }).from(memories),
    db.select({ value: count() }).from(mcpServers),
    db.select({ value: count() }).from(contacts),
    db.select({ value: count() }).from(user),
  ])
  return c.json({
    version: config.version,
    isDocker: config.isDocker,
    // Surfaced so the client can warn when the browser's origin doesn't match
    // the configured public URL (invites/webhooks/OAuth callbacks build on it).
    publicUrl: config.publicUrl,
    startedAt,
    uptimeMs: Date.now() - startedAt,
    stats: {
      agents: agentCount!.value,
      providers: providerCount!.value,
      channels: channelCount!.value,
      crons: cronCount!.value,
      memories: memoryCount!.value,
      mcpServers: mcpCount!.value,
      contacts: contactCount!.value,
      users: userCount!.value,
    },
  })
})

// Mount routes
app.route('/api/auth', authRoutes)
app.route('/api/me', meRoutes)
app.route('/api/onboarding', onboardingRoutes)
app.route('/api/providers', providerRoutes)
app.route('/api/models', modelRoutes)
app.route('/api/email-accounts', emailAccountRoutes)
app.route('/api/contacts-accounts', contactsAccountRoutes)
app.route('/api/connected-accounts', connectedAccountRoutes)
app.route('/api/pending-email-sends', pendingEmailSendRoutes)
app.route('/api/sse', sseRoutes)
app.route('/api/agents', agentRoutes)
app.route('/api/tools', toolsRoutes)
app.route('/api/toolboxes', toolboxRoutes)
app.route('/api/tool-domains', toolDomainRoutes)
app.route('/api/custom-tools', customToolRoutes)
app.route('/api/agents/:agentId/messages', messageRoutes)
app.route('/api/agents/:agentId/messages/:messageId/reactions', reactionRoutes)
app.route('/api/vault', vaultRoutes)
app.route('/api/users', userRoutes)
app.route('/api/invitations', invitationRoutes)
app.route('/api/notifications', notificationRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/contacts', contactRoutes)
app.route('/api/tasks', taskRoutes)
app.route('/api/crons', cronRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/tags', tagRoutes)
app.route('/api/tickets', ticketRoutes)
app.route('/api/mcp-servers', mcpServerRoutes)
app.route('/api/files', fileRoutes)
app.route('/api/file-storage', fileStorageRoutes)
app.route('/api/prompts', promptRoutes)
app.route('/api/secret-prompts', secretPromptRoutes)
app.route('/api/memories', memoryRoutes)
app.route('/api/webhooks/incoming', webhookIncomingRoutes)
app.route('/api/webhooks', webhookRoutes)
app.route('/api/account-triggers', accountTriggerRoutes)
app.route('/api/channels/telegram', channelTelegramRoutes)
app.route('/api/channels/slack/webhook', channelSlackRoutes)
app.route('/api/channels/whatsapp/webhook', channelWhatsAppRoutes)
app.route('/api/channels/signal/webhook', channelSignalRoutes)
app.route('/api/channels', channelRoutes)
app.route('/api/agents/:agentId/knowledge', knowledgeRoutes)
app.route('/api/agents/:agentId/workspace', workspaceFilesRoutes)
app.route('/api/agents/:agentId/quick-sessions', quickSessionAgentRoutes)
app.route('/api/quick-sessions', quickSessionDetailRoutes)
app.route('/api/mini-apps/sdk', miniAppSdkRoutes)
app.route('/api/mini-apps', miniAppRoutes)
app.route('/api/plugins', pluginRoutes)
app.route('/api/plugin-cards', pluginCardRoutes)
app.route('/api/logs', logRoutes)
app.route('/api/terminal', terminalRoutes)
app.route('/api/usage', usageRoutes)
app.route('/api/version-check', versionCheckRoutes)
app.route('/s', sharedRoutes)

export { app }
