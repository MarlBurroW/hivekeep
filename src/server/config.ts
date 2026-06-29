import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import os from 'os'
import { parseModelEnv } from '@/shared/model-ref'

const dataDir = process.env.GEZY_DATA_DIR ?? './data'

/** Read version from package.json (works whether started via `bun run start` or `bun src/server/index.ts`). */
const appVersion: string = (() => {
  // Highest priority: explicit env var (set by Dockerfile or user)
  if (process.env.GEZY_VERSION && process.env.GEZY_VERSION !== '0.0.0') {
    return process.env.GEZY_VERSION.replace(/^v/, '')
  }

  // Try multiple resolution strategies for Docker + dev compatibility
  const candidates = [
    // Bun-specific: import.meta.dir (always available in Bun)
    typeof import.meta.dir === 'string' ? resolve(import.meta.dir, '..', '..', 'package.json') : null,
    // Node.js standard: import.meta.dirname
    import.meta.dirname ? resolve(import.meta.dirname, '..', '..', 'package.json') : null,
    // Relative to CWD (Docker: /app/package.json)
    resolve(process.cwd(), 'package.json'),
    // Absolute fallback for Docker
    '/app/package.json',
  ].filter(Boolean) as string[]

  for (const pkgPath of candidates) {
    try {
      if (existsSync(pkgPath)) {
        const ver = JSON.parse(readFileSync(pkgPath, 'utf-8')).version
        if (ver && ver !== '0.0.0') return ver
      }
    } catch {
      continue
    }
  }

  return process.env.npm_package_version ?? '0.0.0'
})()

/**
 * Resolve the encryption key: env var > persisted file > auto-generate and persist.
 */
function resolveEncryptionKey(): string {
  // 1. Prefer explicit env var
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY

  // 2. Check for persisted key in data directory
  const keyPath = join(dataDir, '.encryption-key')
  if (existsSync(keyPath)) {
    const saved = readFileSync(keyPath, 'utf-8').trim()
    if (saved) return saved
  }

  // 3. Auto-generate and persist
  const randomBytes = crypto.getRandomValues(new Uint8Array(32))
  const keyHex = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('')

  mkdirSync(dataDir, { recursive: true })
  writeFileSync(keyPath, keyHex, { mode: 0o600 })
  // Logger not available yet (circular dep) — use console for this one-time init message
  console.log('Generated and persisted ENCRYPTION_KEY in data directory.')

  return keyHex
}

/** Detect the installation type based on environment heuristics. */
import type { InstallationType } from '@/shared/types'

function detectInstallationType(): InstallationType {
  // Docker: /.dockerenv file or known Docker data dir
  if (existsSync('/.dockerenv') || process.env.GEZY_DATA_DIR === '/app/data') {
    return 'docker'
  }
  // launchd (macOS service): XPC_SERVICE_NAME is set for launchd-managed jobs
  if (process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME.includes('gezy')) {
    return 'launchd'
  }
  // systemd: INVOCATION_ID is set by systemd for all service processes
  if (process.env.INVOCATION_ID) {
    // User service: runs as regular user with XDG dirs, no root
    // System service: typically PID 1's child or has MANAGERPID pointing to system manager
    // Heuristic: if UID > 0 and DBUS_SESSION_BUS_ADDRESS or XDG_RUNTIME_DIR is set → user service
    const uid = process.getuid?.() ?? 0
    if (uid > 0) {
      return 'systemd-user'
    }
    return 'systemd-system'
  }
  return 'manual'
}

/** Try to find the env file path for the current installation. */
function findEnvFilePath(): string | null {
  // 1. Explicit env var
  if (process.env.GEZY_ENV_FILE && existsSync(process.env.GEZY_ENV_FILE)) {
    return resolve(process.env.GEZY_ENV_FILE)
  }

  // 2. .env in CWD
  const cwdEnv = resolve(process.cwd(), '.env')
  if (existsSync(cwdEnv)) return cwdEnv

  // 3. For systemd: check EnvironmentFile from the service unit
  if (process.env.INVOCATION_ID) {
    const servicePath = findServiceFilePath()
    if (servicePath) {
      try {
        const unit = readFileSync(servicePath, 'utf-8')
        const match = unit.match(/^EnvironmentFile\s*=\s*(.+)$/m)
        if (match) {
          const envPath = match[1]!.replace(/^-/, '').trim().replace(/^~/, os.homedir())
          if (existsSync(envPath)) return resolve(envPath)
        }
      } catch {
        // ignore
      }
    }
  }

  // 4. Common locations relative to data dir
  const dataDirEnv = resolve(dataDir, 'gezy.env')
  if (existsSync(dataDirEnv)) return dataDirEnv

  // 5. XDG data dir (common for systemd-user installs)
  const xdgEnv = resolve(os.homedir(), '.local', 'share', 'hivekeep', 'gezy.env')
  if (existsSync(xdgEnv)) return xdgEnv

  return null
}

/** Try to find the systemd service file path. */
function findServiceFilePath(): string | null {
  if (!process.env.INVOCATION_ID) return null

  const candidates = [
    // User service
    resolve(os.homedir(), '.config', 'systemd', 'user', 'gezy.service'),
    // System service
    '/etc/systemd/system/gezy.service',
    '/usr/lib/systemd/system/gezy.service',
  ]

  for (const path of candidates) {
    if (existsSync(path)) return path
  }
  return null
}

/** Resolve the server-wide IANA timezone for all schedule interpretation.
 *  Priority: GEZY_TIMEZONE > TZ > system-resolved IANA > 'UTC'.
 *  Used by croner (recurring crons) and for parsing bare wall-clock datetimes. */
function resolveServerTimezone(): string {
  const explicit = process.env.GEZY_TIMEZONE || process.env.TZ
  if (explicit) return explicit
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (resolved) return resolved
  } catch {
    // fall through
  }
  return 'UTC'
}

export const config = {
  version: appVersion,
  port: Number(process.env.PORT ?? 3000),
  /** Max HTTP request body size (bytes) accepted by Bun.serve. Bun's own
   *  default is ~128 MB, which silently caps large file-storage uploads.
   *  Set MAX_REQUEST_BODY_MB to a positive value to enforce a cap; 0 (default)
   *  = effectively unlimited (Number.MAX_SAFE_INTEGER). */
  maxRequestBodyBytes: (() => {
    const mb = Number(process.env.MAX_REQUEST_BODY_MB ?? 0)
    return mb > 0 ? mb * 1024 * 1024 : Number.MAX_SAFE_INTEGER
  })(),
  dataDir,
  encryptionKey: resolveEncryptionKey(),
  logLevel: (process.env.LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  isDocker: existsSync('/.dockerenv') || process.env.GEZY_DATA_DIR === '/app/data',
  /** Server-wide IANA timezone (e.g. "Europe/Paris"). Applied to recurring cron
   *  expressions and to bare wall-clock datetimes received from clients. */
  timezone: resolveServerTimezone(),

  db: {
    path: process.env.DB_PATH ?? `${dataDir}/gezy.db`,
  },

  /** Model registry (models.dev-backed metadata source of truth). ON by default;
   *  set GEZY_MODEL_REGISTRY=false to fall back to the legacy path where
   *  provider `listModels()` metadata is used as-is. The registry enriches model
   *  metadata (context, modalities, reasoning, pricing) from the bundled
   *  models.dev snapshot + admin overrides. See `model-metadata.md`. */
  modelRegistry: {
    enabled: process.env.GEZY_MODEL_REGISTRY !== 'false',
  },

  /** In-app feedback (star CTA + written feedback relayed to a central
   *  collector). The endpoint is a public Cloudflare Worker — no secret, since
   *  Hivekeep is open-source and every instance phones home to the same place;
   *  abuse is bounded by the Worker's per-IP rate limit + Cloudflare. Set
   *  `GEZY_FEEDBACK_ENDPOINT=` (empty) to disable the feature entirely. */
  feedback: {
    endpoint:
      process.env.GEZY_FEEDBACK_ENDPOINT ??
      'https://hivekeep-feedback.hivekeep.workers.dev/feedback',
    githubRepoUrl: process.env.GEZY_GITHUB_REPO_URL ?? 'https://github.com/pgun/gezy',
    /** Max characters accepted in a single feedback message. */
    maxMessageLength: Number(process.env.GEZY_FEEDBACK_MAX_LENGTH ?? 5000),
    /** Usage thresholds before the proactive banner may appear (either suffices). */
    promptAfterDays: Number(process.env.GEZY_FEEDBACK_PROMPT_AFTER_DAYS ?? 7),
    promptMinMessages: Number(process.env.GEZY_FEEDBACK_PROMPT_MIN_MESSAGES ?? 30),
    /** Days before the banner reappears after the user clicks "later". */
    snoozeDays: Number(process.env.GEZY_FEEDBACK_SNOOZE_DAYS ?? 14),
  },

  compacting: {
    ...parseModelEnv(process.env.COMPACTING_MODEL) as { model?: string; providerId?: string },
    /** Trigger compaction when total context tokens exceed this % of the model's context window. */
    thresholdPercent: Number(process.env.COMPACTING_THRESHOLD_PERCENT ?? 75),
    /** Keep the most recent messages fitting within this % of the context window as raw context. */
    // Lowered from 40 → 25: with 40% on a 1M context, the keep-window was
    // 400k tokens — and on tool-heavy Agents (kubectl/browser/file ops), that
    // budget was easily filled by 2-4 huge tool-result messages, leaving
    // compacting unable to reduce the post-summary total below ~600-900k
    // even after force-compacting. 25% gives a 250k keep-window which fits
    // ~1-2 large outputs + many small messages, more representative of
    // "recent context" than "everything that happened lately".
    keepPercent: Number(process.env.COMPACTING_KEEP_PERCENT ?? 25),
    /** Max % of context window that summaries may occupy before triggering telescopic merge. */
    summaryBudgetPercent: Number(process.env.COMPACTING_SUMMARY_BUDGET_PERCENT ?? 20),
    /** Max number of active summaries in context before forcing merge. */
    maxSummaries: Number(process.env.COMPACTING_MAX_SUMMARIES ?? 10),
    /** Max summaries to retain in DB (old archived summaries beyond this are deleted). */
    maxSummariesPerAgent: Number(process.env.COMPACTING_MAX_SUMMARIES_PER_KIN ?? 50),
    // ── Absolute token ceilings (model-agnostic) ──────────────────────────────
    // The percentage knobs above scale with the context window, so on a 1M-token
    // model even a "small" 25% keep-window is 250k tokens. These absolute caps
    // bound the real footprint regardless of window size — `effective = min(%×window, cap)`.
    // On a 200k model the % still dominates (50k < 100k), so they only bite on
    // large-window models. See compacting.md for the resulting envelope.
    /** Hard ceiling on the raw-message keep-window (real tokens). Caps `keepPercent`. */
    keepMaxTokens: Number(process.env.COMPACTING_KEEP_MAX_TOKENS ?? 100_000),
    /** Hard ceiling on context size before compaction triggers (real tokens). Caps `thresholdPercent`. */
    triggerMaxTokens: Number(process.env.COMPACTING_TRIGGER_MAX_TOKENS ?? 300_000),
    /** Hard ceiling on total active-summary tokens before telescopic merge (real tokens). Caps `summaryBudgetPercent`. */
    summaryMaxTokens: Number(process.env.COMPACTING_SUMMARY_MAX_TOKENS ?? 48_000),
  },

  /** Max estimated tokens for conversation history injected into the LLM context.
   *  Messages are trimmed from the oldest end when this budget is exceeded.
   *  Acts as an emergency safety net — compacting + tool masking are the primary mechanisms.
   *  Set to 0 to disable (default). */
  historyTokenBudget: Number(process.env.HISTORY_TOKEN_BUDGET ?? 0),

  /** Max number of recent messages fetched from the DB when assembling the
   *  conversation history. Acts as an upper bound on memory usage; the
   *  compacting service is what actually keeps the LLM context window healthy.
   *
   *  Bumped to 1000 (was 100) because the previous limit produced a sliding
   *  window — every new turn pushed 1-2 oldest messages out of the fetched
   *  set, shifting the prefix and invalidating Anthropic's prompt cache. With
   *  1000 the window only slides on conversations with 1000+ raw messages
   *  (which the compacting service should have summarised long before). */
  historyMaxMessages: Number(process.env.HISTORY_MAX_MESSAGES ?? 1000),

  // Cron schedule for refreshing the model-info cache (context windows,
  // max output tokens) by re-listing models from every configured provider.
  // Default: every 6 hours. Catches provider-side spec changes (e.g.
  // Anthropic raising a model's context window) and new models without
  // needing a server restart. Override via MODEL_INFO_REFRESH_CRON env.
  modelInfoRefreshCron: process.env.MODEL_INFO_REFRESH_CRON ?? '0 */6 * * *',

  /** Whether the progressive context compaction pipeline (tool result masking,
   *  observation compaction) is applied before sending the request to the LLM.
   *
   *  Default: **disabled**. The pipeline rewrites old tool results between turns
   *  (intact → truncated → collapsed as new tool calls accumulate), which
   *  invalidates Anthropic's prompt cache because the prefix changes byte-for-byte
   *  every turn. With this disabled, the proper compacting service (which
   *  generates summaries when the context window approaches its threshold) takes
   *  over for genuine token savings without breaking the cache.
   *
   *  Re-enable on providers without prompt caching by setting
   *  `PROGRESSIVE_COMPACTION=1`. */
  progressiveCompactionEnabled: process.env.PROGRESSIVE_COMPACTION === '1'
    || process.env.PROGRESSIVE_COMPACTION === 'true',

  /** Number of recent tool call groups to keep fully intact in context.
   *  Older tool results are collapsed to one-line summaries to save tokens.
   *  Only applied when `progressiveCompactionEnabled` is true. */
  toolResultMaskKeepLast: Number(process.env.TOOL_RESULT_MASK_KEEP_LAST ?? 2),

  /** Number of recent turns to keep at full resolution.
   *  Older turns have tool results truncated to observationMaxChars, and
   *  long assistant/user text is trimmed. 0 = disabled.
   *  Only applied when `progressiveCompactionEnabled` is true. */
  observationCompactionWindow: Number(process.env.OBSERVATION_COMPACTION_WINDOW ?? 10),

  /** Max characters for truncated tool results in the observation compaction zone.
   *  Only applied when `progressiveCompactionEnabled` is true. */
  observationMaxChars: Number(process.env.OBSERVATION_MAX_CHARS ?? 200),

  /** Per-message size cap for tool-result content sent to the LLM (tokens).
   *  When a tool-result exceeds this cap, it's replaced by a small placeholder
   *  in the LLM payload (DB content unchanged). Independent of progressive
   *  compaction — applied always, including with prompt caching enabled.
   *  Cache-safe because the criterion is stable per message: a 80k-token
   *  result always trims to the same placeholder; a 5k-token result is never
   *  trimmed. Default 30000 tokens. Set 0 to disable. */
  toolResultSizeCapTokens: Number(process.env.TOOL_RESULT_SIZE_CAP_TOKENS ?? 30000),

  /** Per-tool-call args size cap (per string field) when sending old assistant
   *  messages to the LLM. Symmetric to toolResultSizeCapTokens — write_file /
   *  edit / multi_edit calls carry file content inside their args, which can
   *  reach 20-80k tokens per call and dominate the keep-window. Each string
   *  field above this cap is replaced by a short placeholder mentioning the
   *  original size. Field names like path/name stay intact (they're tiny).
   *  toolCallId and toolName are preserved so subsequent tool-result blocks
   *  still match. DB content unchanged. Default 8000 tokens (~32k chars,
   *  ~600 lines of code). Set 0 to disable. */
  toolCallArgsSizeCapTokens: Number(process.env.TOOL_CALL_ARGS_SIZE_CAP_TOKENS ?? 8000),

  /** Per-assistant-message TEXT content size cap when sending old assistant
   *  messages to the LLM. Third companion to toolResultSizeCapTokens and
   *  toolCallArgsSizeCapTokens — covers the case where the assistant dumped
   *  a long-form answer (file content, exhaustive analysis, generated docs).
   *  Trimming preserves head + tail (~400 chars each), middle bulk replaced
   *  by a placeholder mentioning the original size. DB content unchanged.
   *  Default 12000 tokens (~48k chars, ~900 lines of prose). Set 0 to disable. */
  assistantContentSizeCapTokens: Number(process.env.ASSISTANT_CONTENT_SIZE_CAP_TOKENS ?? 12000),

  /** Per-user-message TEXT content size cap. 4th companion to the other
   *  three caps. User pastes (CSV dumps, file contents, log spam) can hit
   *  15-20k tokens per message. Same head + tail preservation as assistant
   *  content. Default 16000 tokens (~64k chars), slightly higher than
   *  assistant cap because user pastes often carry the actual data the
   *  request is about. Set 0 to disable. */
  userContentSizeCapTokens: Number(process.env.USER_CONTENT_SIZE_CAP_TOKENS ?? 16000),

  memory: (() => {
    const extraction = parseModelEnv(process.env.MEMORY_EXTRACTION_MODEL)
    const embedding = parseModelEnv(process.env.MEMORY_EMBEDDING_MODEL || 'text-embedding-3-small')
    const consolidation = parseModelEnv(process.env.MEMORY_CONSOLIDATION_MODEL)
    const multiQuery = parseModelEnv(process.env.MEMORY_MULTI_QUERY_MODEL)
    const hyde = parseModelEnv(process.env.MEMORY_HYDE_MODEL)
    const rerank = parseModelEnv(process.env.MEMORY_RERANK_MODEL)
    const contextualRewrite = parseModelEnv(process.env.MEMORY_CONTEXTUAL_REWRITE_MODEL)
    return {
      extractionModel: extraction.model,
      extractionProviderId: extraction.providerId,
      maxRelevantMemories: Number(process.env.MEMORY_MAX_RELEVANT ?? 10),
      // Cosine similarity floor for vector search candidates.
      // Lowered from 0.7 → 0.5: at 0.7, only memories near-identical to the
      // query made it past the filter, so the vector arm of hybrid search
      // returned almost nothing and the FTS5 arm (lexical) had to carry the
      // whole load. The downstream adaptive-K + reranker already prune
      // weak matches; the threshold only needs to be a spam filter, not a
      // relevance gate.
      similarityThreshold: Number(process.env.MEMORY_SIMILARITY_THRESHOLD ?? 0.5),
      embeddingModel: embedding.model ?? 'text-embedding-3-small',
      embeddingProviderId: embedding.providerId,
      embeddingDimension: Number(process.env.MEMORY_EMBEDDING_DIMENSION ?? 1536),
      temporalDecayLambda: Number(process.env.MEMORY_TEMPORAL_DECAY_LAMBDA ?? 0.01),
      temporalDecayFloor: Number(process.env.MEMORY_TEMPORAL_DECAY_FLOOR ?? 0.7),
      consolidationSimilarityThreshold: Number(process.env.MEMORY_CONSOLIDATION_SIMILARITY ?? 0.85),
      consolidationMaxGeneration: Number(process.env.MEMORY_CONSOLIDATION_MAX_GEN ?? 5),
      consolidationModel: consolidation.model,
      consolidationProviderId: consolidation.providerId,
      multiQueryModel: multiQuery.model,
      multiQueryProviderId: multiQuery.providerId,
      hydeModel: hyde.model,
      hydeProviderId: hyde.providerId,
      rerankModel: rerank.model,
      rerankProviderId: rerank.providerId,
      adaptiveK: process.env.MEMORY_ADAPTIVE_K !== 'false',
      // Lowered from 0.3 → 0.15: with the previous threshold, a single memory
      // boosted by importance × retrieval feedback could be 3x its peers,
      // putting them all under the cutoff and producing a winner-take-all
      // effect (one memory recalled forever, rest invisible).
      adaptiveKMinScoreRatio: Number(process.env.MEMORY_ADAPTIVE_K_MIN_SCORE_RATIO ?? 0.15),
      // Largest-gap heuristic: only truncate when a single drop accounts for
      // more than this fraction of the top-to-current range. Raised from the
      // hardcoded 0.4 to be less eager to truncate after the first result.
      adaptiveKLargestGapRatio: Number(process.env.MEMORY_ADAPTIVE_K_LARGEST_GAP_RATIO ?? 0.6),
      rrfK: Number(process.env.MEMORY_RRF_K ?? 60),
      ftsBoost: Number(process.env.MEMORY_FTS_BOOST ?? 0.5),
      subjectBoost: Number(process.env.MEMORY_SUBJECT_BOOST ?? 1.3),
      categoryBoost: Number(process.env.MEMORY_CATEGORY_BOOST ?? 1.25),
      contextualRewriteModel: contextualRewrite.model,
      contextualRewriteProviderId: contextualRewrite.providerId,
      contextualRewriteThreshold: Number(process.env.MEMORY_CONTEXTUAL_REWRITE_THRESHOLD ?? 80),
      tokenBudget: Number(process.env.MEMORY_TOKEN_BUDGET || 0), // 0 = unlimited (no budget enforcement)
      recencyBoostEnabled: process.env.MEMORY_RECENCY_BOOST !== 'false', // Boost very recent memories (default: true)
    }
  })(),

  contacts: {
    /** Bounds for the per-turn "Current speaker" profile block (contact notes
     *  injected into EVERY Agent's prompt). Without these, a long-lived contact —
     *  one global note per authoring Agent, plus each note growing as the model
     *  rewrites it — would inflate every prompt unbounded. We keep the most
     *  recently-updated notes per scope and truncate each one. */
    speakerMaxNotesPerScope: Number(process.env.CONTACTS_SPEAKER_MAX_NOTES_PER_SCOPE ?? 12), // 0 = unlimited
    speakerMaxNoteChars: Number(process.env.CONTACTS_SPEAKER_MAX_NOTE_CHARS ?? 500), // 0 = no truncation
  },

  projectKnowledge: {
    /** Max number of entries that can be pinned per project. Pinned entries
     *  have their full markdown content injected into the system prompt
     *  (inline, no tool call needed). The cap keeps prompt token cost
     *  bounded — unpinned entries are still reachable via the title index
     *  and get_project_knowledge(id). */
    pinCap: Number(process.env.PROJECT_KNOWLEDGE_PIN_CAP ?? 10),
    /** Max titles shipped in the prompt's project-knowledge index. Above
     *  this, the index renders an "... and N more" footer and the Agent must
     *  use search_project_knowledge to surface the rest. */
    maxIndexEntries: Number(process.env.PROJECT_KNOWLEDGE_MAX_INDEX_ENTRIES ?? 100),
    /** Max results returned by search_project_knowledge (used both for the
     *  Agent tool and the REST endpoint). */
    maxSearchResults: Number(process.env.PROJECT_KNOWLEDGE_MAX_SEARCH_RESULTS ?? 10),
  },

  queue: {
    userPriority: 100,
    agentPriority: 50,
    taskPriority: 50,
    pollIntervalMs: Number(process.env.QUEUE_POLL_INTERVAL ?? 500),
  },

  tasks: {
    maxDepth: Number(process.env.TASKS_MAX_DEPTH ?? 3),
    maxRequestInput: Number(process.env.TASKS_MAX_REQUEST_INPUT ?? 3),
    maxInterAgentRequests: Number(process.env.TASKS_MAX_INTER_KIN_REQUESTS ?? 3),
    interAgentResponseTimeoutMs: Number(process.env.TASKS_INTER_KIN_RESPONSE_TIMEOUT_MS ?? 300000), // 5min
    maxConcurrent: Number(process.env.TASKS_MAX_CONCURRENT ?? 10),
  },

  crons: {
    maxActive: Number(process.env.CRONS_MAX_ACTIVE ?? 50),
    maxConcurrentExecutions: Number(process.env.CRONS_MAX_CONCURRENT_EXEC ?? 5),
  },

  projects: {
    /** Hard cap on the active project's description injected into the [7.8] prompt block.
     *  Beyond this, the first half is kept and a truncation note replaces the rest. */
    maxDescriptionPromptTokens: Number(process.env.PROJECTS_MAX_DESCRIPTION_PROMPT_TOKENS ?? 8000),
    /** Max non-`done` tickets injected in the [7.8] prompt block, sorted by updated_at DESC. */
    maxTicketsInPrompt: Number(process.env.PROJECTS_MAX_TICKETS_IN_PROMPT ?? 50),
    /** Gap between consecutive ticket positions when inserting at top of a kanban column. */
    kanbanPositionStep: Number(process.env.PROJECTS_KANBAN_POSITION_STEP ?? 1024),
  },

  llm: {
    // Anthropic adaptive thinking: the modern effort API
    // (`thinking:{type:'adaptive'}` + `output_config.effort` + beta
    // `effort-2025-11-24`) instead of the legacy fixed `budget_tokens`. Adaptive
    // lets the model decide how much to think per step (≈0 on a trivial tool
    // call) — it matches Claude Code and removes the fat thinking block the
    // legacy API forced before EVERY step (the main task-latency cause; see
    // task-latency-analysis.md). The SDK itself deprecates `type:'enabled'` in
    // favor of `adaptive`. Default on; set GEZY_ADAPTIVE_THINKING=false to
    // revert to fixed budgets.
    adaptiveThinking: process.env.GEZY_ADAPTIVE_THINKING !== 'false',
  },

  tools: {
    maxSteps: Number(process.env.TOOLS_MAX_STEPS ?? 0), // 0 (default) = truly unlimited (no cap); > 0 = hard cap at this value
    // Temperature for tool-enabled turns. Local/self-hosted backends default to
    // ~0.7-0.8, which makes structured tool-call JSON unreliable on small models;
    // a low value steadies it. Reasoning models are exempted in code (they reject
    // a custom temperature). Set TOOLS_TEMPERATURE=off to defer to the backend.
    temperature:
      process.env.TOOLS_TEMPERATURE === 'off'
        ? null
        : Number(process.env.TOOLS_TEMPERATURE ?? 0),
    // Max parallel concurrency-safe tool calls within a single batch.
    // GEZY_MAX_TOOL_USE_CONCURRENCY is the canonical name (aligned with
    // Claude Code's CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY). TOOLS_CONCURRENCY_CAP
    // is kept as a fallback for existing deployments.
    concurrencyCap: Number(
      process.env.GEZY_MAX_TOOL_USE_CONCURRENCY
        ?? process.env.TOOLS_CONCURRENCY_CAP
        ?? 10,
    ),
  },

  // Native run_shell tool. The per-call `timeout` arg lets an Agent extend a slow
  // command (long test suites, builds, migrations) up to maxTimeoutMs; omitted
  // → defaultTimeoutMs. Raise maxTimeoutMs via env when tasks legitimately need
  // commands longer than the 10-minute default ceiling.
  shell: {
    defaultTimeoutMs: Number(process.env.GEZY_SHELL_TIMEOUT ?? 30_000),
    maxTimeoutMs: Number(process.env.GEZY_SHELL_MAX_TIMEOUT ?? 600_000),
  },

  toolOutputs: {
    spillThreshold: Number(process.env.TOOL_OUTPUT_SPILL_THRESHOLD ?? 10000), // bytes before spilling to file
    previewLines: Number(process.env.TOOL_OUTPUT_PREVIEW_LINES ?? 200),       // lines to include in preview
    ttlHours: Number(process.env.TOOL_OUTPUT_TTL_HOURS ?? 24),                // cleanup after N hours
  },

  humanPrompts: {
    maxPendingPerAgent: Number(process.env.HUMAN_PROMPTS_MAX_PENDING ?? 5),
  },

  interAgent: {
    maxChainDepth: Number(process.env.INTER_KIN_MAX_CHAIN_DEPTH ?? 5),
    rateLimitPerMinute: Number(process.env.INTER_KIN_RATE_LIMIT ?? 20),
  },

  mcp: {
    requireApproval: process.env.MCP_REQUIRE_APPROVAL !== 'false', // default: true
  },

  vault: {
    algorithm: 'aes-256-gcm' as const,
    attachmentDir: process.env.VAULT_ATTACHMENT_DIR ?? `${dataDir}/vault`,
    maxAttachmentSizeMb: Number(process.env.VAULT_MAX_ATTACHMENT_SIZE ?? 50),
    maxAttachmentsPerEntry: Number(process.env.VAULT_MAX_ATTACHMENTS_PER_ENTRY ?? 10),
  },

  workspace: {
    baseDir: process.env.WORKSPACE_BASE_DIR ?? `${dataDir}/workspaces`,
  },

  repos: {
    /** Local git clones used by sub-task worktrees, one subdir per project
     *  slug (`<baseDir>/<slug>/`) and a shared `<baseDir>/worktrees/` tree
     *  for ephemeral sub-task worktrees. */
    baseDir: process.env.GEZY_REPOS_DIR ?? `${dataDir}/repos`,
    /** Max time we let `git clone` run before aborting (seconds). Default
     *  10min covers most repos; large monorepos may need to bump this. */
    cloneTimeoutSec: Number(process.env.GEZY_CLONE_TIMEOUT_SEC ?? 600),
    /** How long worktrees from failed/conflicted sub-tasks are kept on
     *  disk before the cleanup sweep removes them (seconds). Default 1h.
     *  Sub-tasks that succeed and merge cleanly are removed immediately
     *  — this TTL only protects "needs human review" cases. */
    worktreeKeepFailedSec: Number(process.env.GEZY_WORKTREE_KEEP_FAILED_SEC ?? 3600),
    /** How often the stale-worktree sweeper runs (minutes). Default 5.
     *  Lower bound: 1min (anything faster is wasted IO). */
    worktreeSweepIntervalMin: Number(process.env.GEZY_WORKTREE_SWEEP_INTERVAL_MIN ?? 5),
  },

  upload: {
    dir: process.env.UPLOAD_DIR ?? `${dataDir}/uploads`,
    maxFileSizeMb: Number(process.env.UPLOAD_MAX_FILE_SIZE ?? 50),
    /** Retention period for channel-downloaded files (days). 0 = keep forever. */
    channelFileRetentionDays: Number(process.env.UPLOAD_CHANNEL_RETENTION_DAYS ?? 30),
    /** How often to run the channel file cleanup (minutes). */
    channelFileCleanupIntervalMin: Number(process.env.UPLOAD_CHANNEL_CLEANUP_INTERVAL ?? 60),
  },

  fileStorage: {
    dir: process.env.FILE_STORAGE_DIR ?? `${dataDir}/storage`,
    /** Max size (MB) of a single stored file. 0 (or negative) = unlimited. */
    maxFileSizeMb: Number(process.env.FILE_STORAGE_MAX_SIZE ?? 0),
    cleanupIntervalMin: Number(process.env.FILE_STORAGE_CLEANUP_INTERVAL ?? 60),
  },

  /** Files section — user-facing workspace browser/editor (see files.md). */
  workspaceFiles: {
    /** Above this size a text file is served as `too-large` (download only). */
    maxEditableSizeMb: Number(process.env.WORKSPACE_FILES_MAX_EDITABLE_SIZE ?? 5),
    /** Max size of a file uploaded to a workspace. 0 = unlimited (still capped by MAX_REQUEST_BODY_MB). */
    maxUploadSizeMb: Number(process.env.WORKSPACE_FILES_MAX_UPLOAD_SIZE ?? 100),
    /** Byte budget of a recursive folder copy (aborts mid-copy when exceeded). */
    maxCopySizeMb: Number(process.env.WORKSPACE_FILES_MAX_COPY_SIZE ?? 500),
    /** Entry-count budget of a recursive folder copy. */
    maxCopyEntries: Number(process.env.WORKSPACE_FILES_COPY_MAX_ENTRIES ?? 5000),
    /** Hard cap of the `limit` param of /workspace/search. */
    searchMaxResults: Number(process.env.WORKSPACE_FILES_SEARCH_MAX_RESULTS ?? 50),
    /** Budget of files walked per search request (giant workspaces). */
    searchMaxEntries: Number(process.env.WORKSPACE_FILES_SEARCH_MAX_ENTRIES ?? 20000),
  },

  /** Terminal section — admin-only web terminal on the host (see api.md). */
  terminal: {
    /** Kill-switch: set GEZY_TERMINAL_ENABLED=false to disable the feature entirely. */
    enabled: process.env.GEZY_TERMINAL_ENABLED !== 'false',
    /** Shell binary spawned for each session. Defaults to $SHELL, then /bin/bash. */
    shell: process.env.GEZY_TERMINAL_SHELL ?? process.env.SHELL ?? '/bin/bash',
    /** Scrollback kept server-side per session, replayed on reattach (KB). */
    scrollbackKb: Number(process.env.GEZY_TERMINAL_SCROLLBACK_KB ?? 256),
    /** How long a detached session (no client connected) survives before the
     *  shell is killed (seconds). 0 (default) = sessions persist until closed
     *  from the sidebar or the shell exits (tmux-like; they still die with the
     *  server process). Set > 0 to auto-reap idle detached sessions. */
    detachedTtlSec: Number(process.env.GEZY_TERMINAL_DETACHED_TTL_SEC ?? 0),
    /** Hard cap of concurrently running PTY sessions across all users. */
    maxSessions: Number(process.env.GEZY_TERMINAL_MAX_SESSIONS ?? 10),
  },

  webhooks: {
    maxPerAgent: Number(process.env.WEBHOOKS_MAX_PER_KIN ?? 20),
    maxPayloadBytes: Number(process.env.WEBHOOKS_MAX_PAYLOAD_BYTES ?? 1_048_576), // 1MB
    logRetentionDays: Number(process.env.WEBHOOKS_LOG_RETENTION_DAYS ?? 30),
    maxLogsPerWebhook: Number(process.env.WEBHOOKS_MAX_LOGS_PER_WEBHOOK ?? 500),
    rateLimitPerMinute: Number(process.env.WEBHOOKS_RATE_LIMIT_PER_MINUTE ?? 60),
  },

  // Email account triggers: condition-matched email → conversation/task dispatch.
  emailTriggers: {
    maxPerAccount: Number(process.env.EMAIL_TRIGGERS_MAX_PER_ACCOUNT ?? 20),
    pollIntervalMs: Number(process.env.EMAIL_TRIGGER_POLL_INTERVAL ?? 120_000),
    // Anti-flood: cap messages processed per (account, folder) per poll cycle.
    maxPerCycle: Number(process.env.EMAIL_TRIGGER_MAX_PER_CYCLE ?? 50),
    logRetentionDays: Number(process.env.EMAIL_TRIGGER_LOG_RETENTION_DAYS ?? 30),
    maxLogsPerTrigger: Number(process.env.EMAIL_TRIGGER_MAX_LOGS_PER_TRIGGER ?? 500),
    // Ring buffer of recently-seen message ids per (account, folder), to drop
    // boundary duplicates (provider `after` filters are second-granular/inclusive).
    seenIdsRing: Number(process.env.EMAIL_TRIGGER_SEEN_IDS_RING ?? 200),
  },

  channels: {
    maxPerAgent: Number(process.env.CHANNELS_MAX_PER_KIN ?? 5),
    telegramWebhookPath: '/api/channels/telegram',
    pendingOriginTtlMs: Number(process.env.CHANNEL_PENDING_ORIGIN_TTL ?? 300_000),
    // Max messages buffered per pending contact while they await approval. On
    // approval the buffer is replayed as a single Agent turn; only the most
    // recent N are kept (older ones are dropped).
    maxPendingBufferedMessages: Number(process.env.CHANNEL_MAX_PENDING_BUFFERED ?? 10),
    // Per-channel WhatsApp-Web (Baileys) multi-file auth state. One subfolder
    // per channel id; survives restarts so a paired session reconnects.
    whatsappWebDir: process.env.WHATSAPP_WEB_DIR ?? `${dataDir}/whatsapp-web`,
  },

  quickSessions: {
    defaultExpirationHours: Number(process.env.QUICK_SESSION_EXPIRATION_HOURS ?? 24),
    maxActivePerUserPerAgent: Number(process.env.QUICK_SESSION_MAX_PER_USER_KIN ?? 1),
    retentionDays: Number(process.env.QUICK_SESSION_RETENTION_DAYS ?? 7),
    cleanupIntervalMinutes: Number(process.env.QUICK_SESSION_CLEANUP_INTERVAL ?? 60),
  },

  webBrowsing: {
    // Tier 1 (lightweight fetch)
    pageTimeout: Number(process.env.WEB_BROWSING_PAGE_TIMEOUT ?? 30000),
    maxContentLength: Number(process.env.WEB_BROWSING_MAX_CONTENT_LENGTH ?? 100000),
    maxConcurrentFetches: Number(process.env.WEB_BROWSING_MAX_CONCURRENT ?? 5),
    userAgent:
      process.env.WEB_BROWSING_USER_AGENT ??
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    blockedDomains: (process.env.WEB_BROWSING_BLOCKED_DOMAINS ?? '').split(',').filter(Boolean),
    proxy: process.env.WEB_BROWSING_PROXY ?? undefined,
    // Tier 2 (headless browser, one-shot pages for browse_url / screenshot_url)
    // Default: enabled. Set WEB_BROWSING_HEADLESS_ENABLED=false to disable
    // (e.g. on systems without Chromium system libs installed).
    headless: {
      enabled: process.env.WEB_BROWSING_HEADLESS_ENABLED !== 'false',
      // PUPPETEER_EXECUTABLE_PATH kept for backwards-compat after Playwright migration.
      executablePath: process.env.BROWSER_EXECUTABLE_PATH ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? undefined,
      maxBrowsers: Number(process.env.WEB_BROWSING_MAX_BROWSERS ?? 2),
      idleTimeoutMs: Number(process.env.WEB_BROWSING_BROWSER_IDLE_TIMEOUT ?? 60000),
    },
  },

  // Tier 3: stateful, multi-turn browser sessions (browser_open_session etc.)
  // Default: enabled. The browser_* tools are defaultDisabled, so they only
  // reach an Agent when a granted toolbox lists them by name — sessions cannot be
  // used by accident. Set BROWSER_SESSIONS_ENABLED=false to disable globally.
  browserSessions: {
    enabled: process.env.BROWSER_SESSIONS_ENABLED !== 'false',
    /** Hard TTL for any session, regardless of activity. */
    ttlMs: Number(process.env.BROWSER_SESSION_TTL_MS ?? 3_600_000),
    /** Auto-close after N ms without any tool call on the session. */
    idleTimeoutMs: Number(process.env.BROWSER_SESSION_IDLE_TIMEOUT_MS ?? 600_000),
    /** Global cap on concurrent sessions across all Agents. */
    maxTotal: Number(process.env.BROWSER_MAX_TOTAL_SESSIONS ?? 5),
    /** Cap on concurrent sessions per Agent. */
    maxPerAgent: Number(process.env.BROWSER_MAX_SESSIONS_PER_KIN ?? 1),
    defaultViewport: {
      width: Number(process.env.BROWSER_DEFAULT_VIEWPORT_WIDTH ?? 1280),
      height: Number(process.env.BROWSER_DEFAULT_VIEWPORT_HEIGHT ?? 720),
    },
    /** Directory where saved browser states live (cookies + localStorage). One
     *  subdir per Agent, one JSON file per named state. Stored OUTSIDE the
     *  workspace so the Agent's filesystem tools can't accidentally read or leak
     *  auth tokens — access goes exclusively through browser_*_state tools. */
    statesDir: process.env.BROWSER_STATES_DIR ?? `${dataDir}/browser-states`,
    /** Cap on number of saved states per Agent. */
    maxStatesPerAgent: Number(process.env.BROWSER_MAX_STATES_PER_KIN ?? 20),
    /** Max size (bytes) of a single saved state file. localStorage from heavy
     *  SPAs can balloon — this prevents disk fills. */
    maxStateSizeBytes: Number(process.env.BROWSER_MAX_STATE_SIZE_BYTES ?? 5 * 1024 * 1024),
  },

  invitations: {
    defaultExpiryDays: Number(process.env.INVITATION_DEFAULT_EXPIRY_DAYS ?? 7),
    maxActive: Number(process.env.INVITATION_MAX_ACTIVE ?? 50),
  },

  notifications: {
    retentionDays: Number(process.env.NOTIFICATIONS_RETENTION_DAYS ?? 30),
    maxPerUser: Number(process.env.NOTIFICATIONS_MAX_PER_USER ?? 500),
    externalDelivery: {
      maxPerUser: Number(process.env.NOTIFICATIONS_EXT_MAX_PER_USER ?? 5),
      rateLimitPerMinute: Number(process.env.NOTIFICATIONS_EXT_RATE_LIMIT ?? 5),
      maxConsecutiveErrors: Number(process.env.NOTIFICATIONS_EXT_MAX_ERRORS ?? 5),
    },
  },

  wakeups: {
    maxPendingPerAgent: Number(process.env.WAKEUPS_MAX_PENDING_PER_KIN ?? 20),
    minDelaySeconds: 10,
    maxDelaySeconds: 2_592_000, // 30 days
  },

  miniApps: {
    dir: process.env.MINI_APPS_DIR ?? `${dataDir}/mini-apps`,
    maxAppsPerAgent: Number(process.env.MINI_APPS_MAX_PER_KIN ?? 20),
    maxFileSizeMb: Number(process.env.MINI_APPS_MAX_FILE_SIZE ?? 5),
    maxTotalSizeMbPerApp: Number(process.env.MINI_APPS_MAX_TOTAL_SIZE ?? 50),
    backendEnabled: process.env.MINI_APPS_BACKEND_ENABLED !== 'false', // default: true
  },

  // Global custom tools: user/Agent-authored scripts (any language + own deps)
  // executed by the host. Each tool is a managed directory under `baseDir/<slug>/`
  // holding its entrypoint + deps; the DB holds metadata only. The legacy
  // GEZY_CUSTOM_TOOL_TIMEOUT / _MAX_TIMEOUT env vars are kept for back-compat.
  customTools: {
    baseDir: process.env.GEZY_CUSTOM_TOOLS_DIR ?? `${dataDir}/custom-tools`,
    defaultTimeoutMs: Number(process.env.GEZY_CUSTOM_TOOL_TIMEOUT ?? 30_000),
    maxTimeoutMs: Number(process.env.GEZY_CUSTOM_TOOL_MAX_TIMEOUT ?? 300_000),
    // Cap captured stdout+stderr to protect the context window / server memory.
    maxOutputBytes: Number(process.env.GEZY_CUSTOM_TOOL_MAX_OUTPUT_BYTES ?? 256 * 1024),
    // Longer budget for dependency installs (pip/npm/bun install).
    setupTimeoutMs: Number(process.env.GEZY_CUSTOM_TOOL_SETUP_TIMEOUT ?? 600_000),
  },

  versionCheck: {
    enabled: process.env.VERSION_CHECK_ENABLED !== 'false',
    repo: process.env.VERSION_CHECK_REPO ?? 'pgun/gezy',
    /** Branch tracked by the edge update channel */
    branch: process.env.VERSION_CHECK_BRANCH ?? 'main',
    intervalHours: Number(process.env.VERSION_CHECK_INTERVAL_HOURS ?? 1),
  },

  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,

  environment: {
    installationType: detectInstallationType(),
    envFilePath: findEnvFilePath(),
    serviceFilePath: findServiceFilePath(),
    workingDir: process.cwd(),
    user: os.userInfo().username,
  },
} as const
