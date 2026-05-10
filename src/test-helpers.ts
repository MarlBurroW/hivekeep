/**
 * Shared test helpers — complete mock factories for commonly mocked modules.
 *
 * Bun's `mock.module()` is GLOBAL: a partial mock in file A leaks to file B.
 * Always spread these defaults so that downstream consumers see every property.
 *
 * Usage:
 *   import { fullMockConfig, fullMockDbIndex } from '@/test-helpers'
 *   mock.module('@/server/config', () => ({ config: { ...fullMockConfig, myOverride: 'x' } }))
 *   mock.module('@/server/db/index', () => ({ ...fullMockDbIndex }))
 */

/** Complete config object matching src/server/config.ts shape */
export const fullMockConfig = {
  version: '0.0.0-test',
  port: 3333,
  dataDir: '/tmp/kinbot-test',
  encryptionKey: 'test-key-0000000000000000000000000000000000000000000000000000000000000000',
  logLevel: 'error' as const,
  isDocker: false,
  publicUrl: 'http://localhost:3333',

  db: { path: '/tmp/kinbot-test/kinbot.db' },

  compacting: {
    model: undefined,
    thresholdPercent: 75,
    keepPercent: 40,
    summaryBudgetPercent: 20,
    maxSummaries: 10,
    maxSummariesPerKin: 50,
  },

  historyTokenBudget: 0,
  toolResultMaskKeepLast: 2,
  observationCompactionWindow: 10,
  observationMaxChars: 200,

  memory: {
    extractionModel: undefined,
    maxRelevantMemories: 10,
    similarityThreshold: 0.7,
    embeddingModel: 'text-embedding-3-small',
    embeddingDimension: 1536,
    temporalDecayLambda: 0.01,
    temporalDecayFloor: 0.7,
    consolidationSimilarityThreshold: 0.85,
    consolidationMaxGeneration: 5,
    consolidationModel: undefined,
    multiQueryModel: undefined,
    hydeModel: undefined,
    rerankModel: undefined,
    adaptiveK: true,
    adaptiveKMinScoreRatio: 0.3,
    rrfK: 60,
    ftsBoost: 0.5,
    subjectBoost: 1.3,
    categoryBoost: 1.25,
    contextualRewriteModel: undefined,
    contextualRewriteThreshold: 80,
    tokenBudget: 0,
    recencyBoostEnabled: true,
  },

  queue: {
    userPriority: 100,
    kinPriority: 50,
    taskPriority: 50,
    pollIntervalMs: 500,
  },

  tasks: { maxDepth: 3, maxRequestInput: 3, maxConcurrent: 10 },
  crons: { maxActive: 50, maxConcurrentExecutions: 5 },
  tools: { maxSteps: 0 },
  humanPrompts: { maxPendingPerKin: 5 },
  interKin: { maxChainDepth: 5, rateLimitPerMinute: 20 },
  mcp: { requireApproval: true },

  vault: {
    algorithm: 'aes-256-gcm' as const,
    attachmentDir: '/tmp/kinbot-test/vault',
    maxAttachmentSizeMb: 50,
    maxAttachmentsPerEntry: 10,
  },

  workspace: { baseDir: '/tmp/kinbot-test/workspaces' },

  upload: {
    dir: '/tmp/kinbot-test/uploads',
    maxFileSizeMb: 50,
    channelFileRetentionDays: 30,
    channelFileCleanupIntervalMin: 60,
  },

  fileStorage: {
    dir: '/tmp/kinbot-test/storage',
    maxFileSizeMb: 100,
    cleanupIntervalMin: 60,
  },

  webhooks: {
    maxPerKin: 20,
    maxPayloadBytes: 1_048_576,
    logRetentionDays: 30,
    maxLogsPerWebhook: 500,
    rateLimitPerMinute: 60,
  },

  channels: {
    maxPerKin: 5,
    telegramWebhookPath: '/api/channels/telegram',
  },

  quickSessions: {
    defaultExpirationHours: 24,
    maxActivePerUserPerKin: 1,
    retentionDays: 7,
    cleanupIntervalMinutes: 60,
  },

  webBrowsing: {
    pageTimeout: 30_000,
    maxContentLength: 100_000,
    maxConcurrentFetches: 5,
    userAgent: 'Mozilla/5.0 (compatible; KinBot/test)',
    blockedDomains: [] as string[],
    proxy: undefined,
    headless: {
      enabled: false,
      executablePath: undefined,
      maxBrowsers: 2,
      idleTimeoutMs: 60_000,
    },
  },

  invitations: { defaultExpiryDays: 7, maxActive: 50 },

  notifications: {
    retentionDays: 30,
    maxPerUser: 500,
    externalDelivery: {
      maxPerUser: 5,
      rateLimitPerMinute: 5,
      maxConsecutiveErrors: 5,
    },
  },

  wakeups: {
    maxPendingPerKin: 20,
    minDelaySeconds: 10,
    maxDelaySeconds: 2_592_000,
  },

  miniApps: {
    dir: '/tmp/kinbot-test/mini-apps',
    maxAppsPerKin: 20,
    maxFileSizeMb: 5,
    maxTotalSizeMbPerApp: 50,
    backendEnabled: true,
  },

  versionCheck: {
    enabled: false,
    repo: 'MarlBurroW/kinbot',
    intervalHours: 12,
  },

  environment: {
    installationType: 'manual' as const,
    envFilePath: null,
    serviceFilePath: null,
    workingDir: '/tmp/kinbot-test',
    user: 'test-user',
  },
} as const

/**
 * Noop stub for sqlite — enough to satisfy import resolution.
 * Override individual methods in your test as needed.
 */
const noopFn = () => ({})

export const fullMockDbIndex = {
  db: {
    select: noopFn,
    insert: noopFn,
    update: noopFn,
    delete: noopFn,
  },
  sqlite: {
    run: noopFn,
    query: () => ({ all: () => [], get: () => undefined }),
  },
  initVirtualTables: noopFn,
}

/**
 * Stub schema — every table name maps to an empty object.
 * Extend with column refs as needed in your test.
 */
export const fullMockSchema = {
  user: {},
  session: {},
  account: {},
  verification: {},
  userProfiles: {},
  providers: {},
  kins: {},
  mcpServers: {},
  kinMcpServers: {},
  messages: {},
  compactingSnapshots: {},
  compactingSummaries: {},
  memories: {},
  contacts: {},
  contactIdentifiers: {},
  contactPlatformIds: {},
  contactNotes: {},
  contactNicknames: {},
  customTools: {},
  quickSessions: {},
  tasks: {},
  crons: {},
  webhooks: {},
  webhookLogs: {},
  vaultSecrets: {},
  vaultTypes: {},
  vaultAttachments: {},
  queueItems: {},
  files: {},
  humanPrompts: {},
  channels: {},
  channelUserMappings: {},
  channelMessageLinks: {},
  invitations: {},
  notifications: {},
  notificationPreferences: {},
  notificationChannels: {},
  scheduledWakeups: {},
  messageReactions: {},
  appSettings: {},
  miniApps: {},
  miniAppStorage: {},
  miniAppSnapshots: {},
  fileStorage: {},
  knowledgeSources: {},
  knowledgeChunks: {},
  pluginStates: {},
  pluginStorage: {},
  cronLearnings: {},
  llmUsage: {},
}

/**
 * Complete drizzle-orm mock — includes every export used across the codebase.
 * Spread this in your `mock.module('drizzle-orm', ...)` call.
 */
const identity = (...args: unknown[]) => args
const unary = (a: unknown) => a

export const fullMockDrizzleOrm = {
  eq: identity,
  ne: identity,
  and: identity,
  or: identity,
  not: unary,
  like: identity,
  lt: identity,
  lte: identity,
  gt: identity,
  gte: identity,
  asc: unary,
  desc: unary,
  count: unary,
  inArray: identity,
  notInArray: identity,
  isNull: unary,
  isNotNull: unary,
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (s: string) => s },
  ),
}
