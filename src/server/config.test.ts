import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

/**
 * Tests for src/server/config.ts
 *
 * Because `config` is evaluated at module-load time (top-level `export const config = …`),
 * we need to clear the module cache and re-import for each test that manipulates env vars.
 * Bun supports this via `import()` after deleting from `require.cache` / using the Loader API,
 * but the simplest reliable approach is to isolate via `Bun.spawn` for env-dependent tests
 * and do structural assertions on a single import for the rest.
 */

// Helper: import config fresh in a subprocess with custom env
async function loadConfigWithEnv(env: Record<string, string | undefined>): Promise<Record<string, any>> {
  const script = `
    // Silence any console.log from the module (e.g. encryption key generation)
    const origLog = console.log;
    console.log = () => {};
    const overrides = JSON.parse(process.argv[1]);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    const m = await import('./src/server/config.ts');
    console.log = origLog;
    // Serialize (strip functions/symbols; NaN → "NaN" sentinel)
    console.log(JSON.stringify(m.config, (_, v) => {
      if (typeof v === 'bigint') return Number(v);
      if (typeof v === 'number' && Number.isNaN(v)) return '__NaN__';
      return v;
    }));
  `
  // Serialize env for the in-process override (undefined → null for JSON)
  const serialized = JSON.stringify(env, (_, v) => v === undefined ? null : v)
  const proc = Bun.spawn([process.execPath, '-e', script, serialized], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>) },
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`Subprocess failed (${code}): ${stderr}`)
  return JSON.parse(stdout.trim())
}

describe('config', () => {
  // For non-env-dependent tests, just import once
  let config: any
  beforeEach(async () => {
    // Dynamic import — uses current process env (won't change between tests without subprocess)
    const mod = await import('./config.ts')
    config = mod.config
  })

  describe('structure', () => {
    it('has all expected top-level keys', () => {
      const expectedKeys = [
        'port', 'dataDir', 'encryptionKey', 'logLevel', 'db',
        'compacting', 'memory', 'queue', 'tasks', 'crons', 'tools',
        'humanPrompts', 'interKin', 'mcp', 'vault', 'workspace',
        'upload', 'fileStorage', 'webhooks', 'channels', 'quickSessions',
        'webBrowsing', 'invitations', 'notifications', 'wakeups', 'publicUrl',
      ]
      for (const key of expectedKeys) {
        expect(config).toHaveProperty(key)
      }
    })

    it('port is a number', () => {
      expect(typeof config.port).toBe('number')
      expect(config.port).toBeGreaterThan(0)
    })

    it('encryptionKey is a non-empty string', () => {
      expect(typeof config.encryptionKey).toBe('string')
      expect(config.encryptionKey.length).toBeGreaterThan(0)
    })

    it('logLevel is one of the valid values', () => {
      expect(['debug', 'info', 'warn', 'error']).toContain(config.logLevel)
    })
  })

  describe('default values', () => {
    it('compacting defaults are sensible', () => {
      expect(config.compacting.thresholdPercent).toBe(75)
      expect(config.compacting.keepPercent).toBe(25)
      expect(config.compacting.maxSummaries).toBe(10)
      expect(config.compacting.maxSummariesPerKin).toBe(50)
    })

    it('memory defaults', () => {
      expect(config.memory.maxRelevantMemories).toBe(10)
      expect(config.memory.similarityThreshold).toBe(0.5)
      expect(config.memory.embeddingModel).toBe('text-embedding-3-small')
      expect(config.memory.embeddingDimension).toBe(1536)
    })

    it('queue defaults', () => {
      expect(config.queue.userPriority).toBe(100)
      expect(config.queue.kinPriority).toBe(50)
      expect(config.queue.taskPriority).toBe(50)
      expect(config.queue.pollIntervalMs).toBe(500)
    })

    it('tasks defaults', () => {
      expect(config.tasks.maxDepth).toBe(3)
      expect(config.tasks.maxRequestInput).toBe(3)
      expect(config.tasks.maxConcurrent).toBe(10)
    })

    it('crons defaults', () => {
      expect(config.crons.maxActive).toBe(50)
      expect(config.crons.maxConcurrentExecutions).toBe(5)
    })

    it('tools defaults', () => {
      expect(config.tools.maxSteps).toBe(0)
    })

    it('humanPrompts defaults', () => {
      expect(config.humanPrompts.maxPendingPerKin).toBe(5)
    })

    it('interKin defaults', () => {
      expect(config.interKin.maxChainDepth).toBe(5)
      expect(config.interKin.rateLimitPerMinute).toBe(20)
    })

    it('mcp defaults to requiring approval', () => {
      // Default (no env var) should be true
      expect(config.mcp.requireApproval).toBe(true)
    })

    it('vault defaults', () => {
      expect(config.vault.algorithm).toBe('aes-256-gcm')
      expect(config.vault.maxAttachmentSizeMb).toBe(50)
      expect(config.vault.maxAttachmentsPerEntry).toBe(10)
    })

    it('upload defaults', () => {
      expect(config.upload.maxFileSizeMb).toBe(50)
    })

    it('fileStorage defaults', () => {
      // 0 = unlimited file size by default
      expect(config.fileStorage.maxFileSizeMb).toBe(0)
      expect(config.fileStorage.cleanupIntervalMin).toBe(60)
    })

    it('maxRequestBodyBytes defaults to effectively unlimited', () => {
      expect(config.maxRequestBodyBytes).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('webhooks defaults', () => {
      expect(config.webhooks.maxPerKin).toBe(20)
      expect(config.webhooks.maxPayloadBytes).toBe(1_048_576)
      expect(config.webhooks.rateLimitPerMinute).toBe(60)
    })

    it('channels defaults', () => {
      expect(config.channels.maxPerKin).toBe(5)
      expect(config.channels.telegramWebhookPath).toBe('/api/channels/telegram')
    })

    it('quickSessions defaults', () => {
      expect(config.quickSessions.defaultExpirationHours).toBe(24)
      expect(config.quickSessions.maxActivePerUserPerKin).toBe(1)
      expect(config.quickSessions.retentionDays).toBe(7)
      expect(config.quickSessions.cleanupIntervalMinutes).toBe(60)
    })

    it('webBrowsing defaults', () => {
      expect(config.webBrowsing.pageTimeout).toBe(30000)
      expect(config.webBrowsing.maxContentLength).toBe(100000)
      expect(config.webBrowsing.maxConcurrentFetches).toBe(5)
      expect(config.webBrowsing.userAgent).toContain('Mozilla')
      // Default-on; users opt out via WEB_BROWSING_HEADLESS_ENABLED=false.
      expect(config.webBrowsing.headless.enabled).toBe(true)
      expect(config.webBrowsing.headless.maxBrowsers).toBe(2)
    })

    it('browserSessions defaults', () => {
      // Default-on; per-Kin opt-in via tool_config.enabledOptInTools still required.
      expect(config.browserSessions.enabled).toBe(true)
      expect(config.browserSessions.maxPerKin).toBe(1)
      expect(config.browserSessions.maxTotal).toBe(5)
    })

    it('invitations defaults', () => {
      expect(config.invitations.defaultExpiryDays).toBe(7)
      expect(config.invitations.maxActive).toBe(50)
    })

    it('notifications defaults', () => {
      expect(config.notifications.retentionDays).toBe(30)
      expect(config.notifications.maxPerUser).toBe(500)
      expect(config.notifications.externalDelivery.maxPerUser).toBe(5)
      expect(config.notifications.externalDelivery.rateLimitPerMinute).toBe(5)
    })

    it('wakeups defaults', () => {
      expect(config.wakeups.maxPendingPerKin).toBe(20)
      expect(config.wakeups.minDelaySeconds).toBe(10)
      expect(config.wakeups.maxDelaySeconds).toBe(2_592_000)
    })
  })

  describe('env var overrides (subprocess)', () => {
    it('PORT overrides port', async () => {
      const c = await loadConfigWithEnv({ PORT: '9999' })
      expect(c.port).toBe(9999)
    })

    it('KINBOT_DATA_DIR overrides dataDir and dependent paths', async () => {
      const c = await loadConfigWithEnv({ KINBOT_DATA_DIR: '/tmp/kinbot-test-data' })
      expect(c.dataDir).toBe('/tmp/kinbot-test-data')
      expect(c.db.path).toBe('/tmp/kinbot-test-data/kinbot.db')
      expect(c.vault.attachmentDir).toBe('/tmp/kinbot-test-data/vault')
      expect(c.workspace.baseDir).toBe('/tmp/kinbot-test-data/workspaces')
      expect(c.upload.dir).toBe('/tmp/kinbot-test-data/uploads')
      expect(c.fileStorage.dir).toBe('/tmp/kinbot-test-data/storage')
    })

    it('LOG_LEVEL override', async () => {
      const c = await loadConfigWithEnv({ LOG_LEVEL: 'debug' })
      expect(c.logLevel).toBe('debug')
    })

    it('ENCRYPTION_KEY from env takes priority', async () => {
      const c = await loadConfigWithEnv({ ENCRYPTION_KEY: 'my-secret-key-123' })
      expect(c.encryptionKey).toBe('my-secret-key-123')
    })

    it('numeric env vars are parsed as numbers', async () => {
      const c = await loadConfigWithEnv({
        COMPACTING_THRESHOLD_PERCENT: '80',
        COMPACTING_KEEP_PERCENT: '50',
        MEMORY_MAX_RELEVANT: '20',
        TOOLS_MAX_STEPS: '25',
      })
      expect(c.compacting.thresholdPercent).toBe(80)
      expect(c.compacting.keepPercent).toBe(50)
      expect(c.memory.maxRelevantMemories).toBe(20)
      expect(c.tools.maxSteps).toBe(25)
    })

    it('MCP_REQUIRE_APPROVAL=false disables approval', async () => {
      const c = await loadConfigWithEnv({ MCP_REQUIRE_APPROVAL: 'false' })
      expect(c.mcp.requireApproval).toBe(false)
    })

    it('WEB_BROWSING_HEADLESS_ENABLED=true enables headless', async () => {
      const c = await loadConfigWithEnv({ WEB_BROWSING_HEADLESS_ENABLED: 'true' })
      expect(c.webBrowsing.headless.enabled).toBe(true)
    })

    it('WEB_BROWSING_BLOCKED_DOMAINS parses comma-separated list', async () => {
      const c = await loadConfigWithEnv({ WEB_BROWSING_BLOCKED_DOMAINS: 'evil.com,bad.org,spam.net' })
      expect(c.webBrowsing.blockedDomains).toEqual(['evil.com', 'bad.org', 'spam.net'])
    })

    it('PUBLIC_URL override', async () => {
      const c = await loadConfigWithEnv({ PUBLIC_URL: 'https://kinbot.example.com' })
      expect(c.publicUrl).toBe('https://kinbot.example.com')
    })
  })

  describe('edge cases', () => {
    it('empty WEB_BROWSING_BLOCKED_DOMAINS yields empty array', async () => {
      const c = await loadConfigWithEnv({ WEB_BROWSING_BLOCKED_DOMAINS: '' })
      expect(c.webBrowsing.blockedDomains).toEqual([])
    })

    it('non-numeric PORT becomes NaN (no validation in config)', async () => {
      const c = await loadConfigWithEnv({ PORT: 'not-a-number' })
      expect(c.port).toBe('__NaN__')
    })

    it('publicUrl defaults to localhost with custom PORT', async () => {
      const c = await loadConfigWithEnv({ PORT: '4444', PUBLIC_URL: undefined })
      expect(c.publicUrl).toBe('http://localhost:4444')
    })
  })

  describe('missing default coverage', () => {
    it('version is a string', () => {
      expect(typeof config.version).toBe('string')
      expect(config.version.length).toBeGreaterThan(0)
    })

    it('isDocker is a boolean', () => {
      expect(typeof config.isDocker).toBe('boolean')
    })

    it('historyTokenBudget defaults to 0', () => {
      expect(config.historyTokenBudget).toBe(0)
    })

    it('toolResultMaskKeepLast defaults to 2', () => {
      expect(config.toolResultMaskKeepLast).toBe(2)
    })

    it('observationCompactionWindow defaults to 10', () => {
      expect(config.observationCompactionWindow).toBe(10)
    })

    it('observationMaxChars defaults to 200', () => {
      expect(config.observationMaxChars).toBe(200)
    })

    it('toolOutputs defaults', () => {
      expect(config.toolOutputs.spillThreshold).toBe(10000)
      expect(config.toolOutputs.previewLines).toBe(200)
      expect(config.toolOutputs.ttlHours).toBe(24)
    })

    it('miniApps defaults', () => {
      expect(config.miniApps.maxAppsPerKin).toBe(20)
      expect(config.miniApps.maxFileSizeMb).toBe(5)
      expect(config.miniApps.maxTotalSizeMbPerApp).toBe(50)
      expect(config.miniApps.backendEnabled).toBe(true)
    })

    it('versionCheck defaults', () => {
      expect(config.versionCheck.repo).toBe('MarlBurroW/kinbot')
      expect(config.versionCheck.intervalHours).toBe(1)
    })

    it('environment has expected shape', () => {
      expect(['docker', 'systemd-user', 'systemd-system', 'manual']).toContain(config.environment.installationType)
      expect(typeof config.environment.workingDir).toBe('string')
      expect(typeof config.environment.user).toBe('string')
    })
  })

  describe('env var overrides for new fields (subprocess)', () => {
    it('HISTORY_TOKEN_BUDGET override', async () => {
      const c = await loadConfigWithEnv({ HISTORY_TOKEN_BUDGET: '50000' })
      expect(c.historyTokenBudget).toBe(50000)
    })

    it('TOOL_RESULT_MASK_KEEP_LAST override', async () => {
      const c = await loadConfigWithEnv({ TOOL_RESULT_MASK_KEEP_LAST: '5' })
      expect(c.toolResultMaskKeepLast).toBe(5)
    })

    it('OBSERVATION_COMPACTION_WINDOW override', async () => {
      const c = await loadConfigWithEnv({ OBSERVATION_COMPACTION_WINDOW: '20' })
      expect(c.observationCompactionWindow).toBe(20)
    })

    it('OBSERVATION_MAX_CHARS override', async () => {
      const c = await loadConfigWithEnv({ OBSERVATION_MAX_CHARS: '500' })
      expect(c.observationMaxChars).toBe(500)
    })

    it('TOOL_OUTPUT_SPILL_THRESHOLD override', async () => {
      const c = await loadConfigWithEnv({ TOOL_OUTPUT_SPILL_THRESHOLD: '5000' })
      expect(c.toolOutputs.spillThreshold).toBe(5000)
    })

    it('TOOL_OUTPUT_PREVIEW_LINES override', async () => {
      const c = await loadConfigWithEnv({ TOOL_OUTPUT_PREVIEW_LINES: '100' })
      expect(c.toolOutputs.previewLines).toBe(100)
    })

    it('TOOL_OUTPUT_TTL_HOURS override', async () => {
      const c = await loadConfigWithEnv({ TOOL_OUTPUT_TTL_HOURS: '48' })
      expect(c.toolOutputs.ttlHours).toBe(48)
    })

    it('MINI_APPS_MAX_PER_KIN override', async () => {
      const c = await loadConfigWithEnv({ MINI_APPS_MAX_PER_KIN: '50' })
      expect(c.miniApps.maxAppsPerKin).toBe(50)
    })

    it('MINI_APPS_BACKEND_ENABLED=false disables backend', async () => {
      const c = await loadConfigWithEnv({ MINI_APPS_BACKEND_ENABLED: 'false' })
      expect(c.miniApps.backendEnabled).toBe(false)
    })

    it('VERSION_CHECK_ENABLED=false disables version check', async () => {
      const c = await loadConfigWithEnv({ VERSION_CHECK_ENABLED: 'false' })
      expect(c.versionCheck.enabled).toBe(false)
    })

    it('VERSION_CHECK_INTERVAL_HOURS override', async () => {
      const c = await loadConfigWithEnv({ VERSION_CHECK_INTERVAL_HOURS: '24' })
      expect(c.versionCheck.intervalHours).toBe(24)
    })

    it('COMPACTING_MAX_SUMMARIES_PER_KIN override', async () => {
      const c = await loadConfigWithEnv({ COMPACTING_MAX_SUMMARIES_PER_KIN: '25' })
      expect(c.compacting.maxSummariesPerKin).toBe(25)
    })

    it('TASKS_MAX_INTER_KIN_REQUESTS override', async () => {
      const c = await loadConfigWithEnv({ TASKS_MAX_INTER_KIN_REQUESTS: '10' })
      expect(c.tasks.maxInterKinRequests).toBe(10)
    })

    it('TASKS_MAX_CONCURRENT override', async () => {
      const c = await loadConfigWithEnv({ TASKS_MAX_CONCURRENT: '20' })
      expect(c.tasks.maxConcurrent).toBe(20)
    })

    it('CRONS_MAX_ACTIVE override', async () => {
      const c = await loadConfigWithEnv({ CRONS_MAX_ACTIVE: '100' })
      expect(c.crons.maxActive).toBe(100)
    })

    it('NOTIFICATIONS_RETENTION_DAYS override', async () => {
      const c = await loadConfigWithEnv({ NOTIFICATIONS_RETENTION_DAYS: '60' })
      expect(c.notifications.retentionDays).toBe(60)
    })

    it('WEBHOOKS_MAX_PAYLOAD_BYTES override', async () => {
      const c = await loadConfigWithEnv({ WEBHOOKS_MAX_PAYLOAD_BYTES: '2097152' })
      expect(c.webhooks.maxPayloadBytes).toBe(2097152)
    })

    it('FILE_STORAGE_MAX_SIZE override', async () => {
      const c = await loadConfigWithEnv({ FILE_STORAGE_MAX_SIZE: '200' })
      expect(c.fileStorage.maxFileSizeMb).toBe(200)
    })

    it('MAX_REQUEST_BODY_MB override sets a byte cap', async () => {
      const c = await loadConfigWithEnv({ MAX_REQUEST_BODY_MB: '256' })
      expect(c.maxRequestBodyBytes).toBe(256 * 1024 * 1024)
    })

    it('MAX_REQUEST_BODY_MB=0 means unlimited', async () => {
      const c = await loadConfigWithEnv({ MAX_REQUEST_BODY_MB: '0' })
      expect(c.maxRequestBodyBytes).toBe(Number.MAX_SAFE_INTEGER)
    })

    it('UPLOAD_CHANNEL_RETENTION_DAYS override', async () => {
      const c = await loadConfigWithEnv({ UPLOAD_CHANNEL_RETENTION_DAYS: '0' })
      expect(c.upload.channelFileRetentionDays).toBe(0)
    })

    it('WAKEUPS_MAX_PENDING_PER_KIN override', async () => {
      const c = await loadConfigWithEnv({ WAKEUPS_MAX_PENDING_PER_KIN: '50' })
      expect(c.wakeups.maxPendingPerKin).toBe(50)
    })

    it('INTER_KIN_MAX_CHAIN_DEPTH override', async () => {
      const c = await loadConfigWithEnv({ INTER_KIN_MAX_CHAIN_DEPTH: '10' })
      expect(c.interKin.maxChainDepth).toBe(10)
    })

    it('CHANNEL_PENDING_ORIGIN_TTL override', async () => {
      const c = await loadConfigWithEnv({ CHANNEL_PENDING_ORIGIN_TTL: '600000' })
      expect(c.channels.pendingOriginTtlMs).toBe(600000)
    })
  })
})
