# Hivekeep — Centralized configuration

All configurable values of the platform, grouped by domain. These values are defined in `src/server/config.ts` and can be overridden via environment variables.

---

## General

| Key | Env var | Default | Description |
|---|---|---|---|
| `port` | `PORT` | `3000` | HTTP server port |
| `maxRequestBodyBytes` | `MAX_REQUEST_BODY_MB` | `0` (unlimited) | Max size of an HTTP request body (MB) accepted by `Bun.serve`. Otherwise Bun applies a default cap (~128 MB) that silently blocks large uploads. `0` = unlimited (`Number.MAX_SAFE_INTEGER`) |
| `dataDir` | `HIVEKEEP_DATA_DIR` | `./data` | Directory for persistent data (DB, uploads, workspaces) |
| `encryptionKey` | `ENCRYPTION_KEY` | auto-generated | Encryption key for Vault secrets and provider configs. Auto-generated and persisted in the data directory if absent |
| `logLevel` | `LOG_LEVEL` | `info` | Log level: 'debug', 'info', 'warn', 'error' |
| `appVersion` | `HIVEKEEP_VERSION` | *(auto-detected)* | Application version. Read from `package.json` by default. Can be set explicitly to override detection. In Docker, automatically extracted by the entrypoint |
| — | `TRUSTED_ORIGINS` | *(none)* | List of additional origins allowed for CORS, comma-separated (e.g. `https://app.example.com`). The `PUBLIC_URL` is always included automatically. Read directly in `app.ts` |

---

## Database

| Key | Env var | Default | Description |
|---|---|---|---|
| `dbPath` | `DB_PATH` | `{dataDir}/hivekeep.db` | Path of the SQLite file |

---

## Compacting

| Key | Env var | Default | Description |
|---|---|---|---|
| `compacting.model` | `COMPACTING_MODEL` | — | Model used for compacting (`providerId:modelId` format supported). If not set, uses the Agent's model |
| `compacting.thresholdPercent` | `COMPACTING_THRESHOLD_PERCENT` | `75` | % of context usage before compacting is triggered |
| `compacting.keepPercent` | `COMPACTING_KEEP_PERCENT` | `25` | % of the context window preserved as raw messages (keep-window) |
| `compacting.summaryBudgetPercent` | `COMPACTING_SUMMARY_BUDGET_PERCENT` | `20` | Max % of the context window for summaries before telescopic merge |
| `compacting.maxSummaries` | `COMPACTING_MAX_SUMMARIES` | `10` | Max number of active summaries before telescopic merge |
| `compacting.maxSummariesPerAgent` | `COMPACTING_MAX_SUMMARIES_PER_KIN` | `50` | Total summary retention per Agent (active + archived) |
| `compacting.keepMaxTokens` | `COMPACTING_KEEP_MAX_TOKENS` | `100000` | **Absolute** ceiling (real tokens) of the keep-window — bounds `keepPercent`. Only affects large windows (1M) |
| `compacting.triggerMaxTokens` | `COMPACTING_TRIGGER_MAX_TOKENS` | `300000` | **Absolute** ceiling (real tokens) before triggering — bounds `thresholdPercent` |
| `compacting.summaryMaxTokens` | `COMPACTING_SUMMARY_MAX_TOKENS` | `48000` | **Absolute** ceiling (real tokens) of summaries before merge — bounds `summaryBudgetPercent` |

> **Effective budgets**: each budget is `min(percentage × window, absolute ceiling)`. On a 200k model the percentage dominates (behavior unchanged); on 1M the absolute ceiling bounds the footprint. See `compacting.md` → "Absolute token ceilings".

> **Per-Agent override**: each Agent can override the compacting parameters via its `compactingConfig` (stored as JSON in `agents.compacting_config`). The configuration interface is in the Compaction tab of the Agent's settings. The available fields are: `thresholdPercent`, `keepPercent`, `summaryBudgetPercent`, `maxSummaries`, `keepMaxTokens`, `triggerMaxTokens`, `summaryMaxTokens`, `compactingModel`, and `compactingProviderId`.

---

## Progressive context compaction pipeline

| Key | Env var | Default | Description |
|---|---|---|---|
| `historyTokenBudget` | `HISTORY_TOKEN_BUDGET` | `0` (disabled) | Max estimated token budget for history. Emergency safety net — the progressive pipeline normally manages context size |
| `toolResultMaskKeepLast` | `TOOL_RESULT_MASK_KEEP_LAST` | `2` | Number of recent tool-call groups to keep intact. Older ones are compacted into one-line summaries |
| `observationCompactionWindow` | `OBSERVATION_COMPACTION_WINDOW` | `10` | Number of recent turns to keep at full resolution. Older turns have their tool results truncated. 0 = disabled |
| `observationMaxChars` | `OBSERVATION_MAX_CHARS` | `200` | Max number of characters for truncated tool results in the observation zone |

---

## Tool output spill (large tool results)

| Key | Env var | Default | Description |
|---|---|---|---|
| `toolOutputs.spillThreshold` | `TOOL_OUTPUT_SPILL_THRESHOLD` | `10000` | Threshold in bytes above which a tool result is saved to a temporary file instead of being included in full in the context |
| `toolOutputs.previewLines` | `TOOL_OUTPUT_PREVIEW_LINES` | `200` | Number of preview lines included in the compact reference when a result is "spilled" |
| `toolOutputs.ttlHours` | `TOOL_OUTPUT_TTL_HOURS` | `24` | Retention duration of temporary files (hours). Older files are deleted automatically |

---

## Tools

| Key | Env var | Default | Description |
|---|---|---|---|
| `tools.maxSteps` | `TOOLS_MAX_STEPS` | `0` | Max number of tool-calling steps per LLM turn. 0 = unlimited (capped at 100 internally) |
| `tools.concurrencyCap` | `TOOLS_CONCURRENCY_CAP` | `5` | Max number of parallel read-only tool executions. When all tool calls in a step are read-only, they run in parallel (limited to this value). Mixed batches with at least one mutating tool stay sequential |
| `shell.defaultTimeoutMs` | `HIVEKEEP_SHELL_TIMEOUT` | `30000` | Default timeout for a `run_shell` command (ms), used when the Agent does not provide a `timeout` |
| `shell.maxTimeoutMs` | `HIVEKEEP_SHELL_MAX_TIMEOUT` | `600000` | Maximum timeout an Agent can request per `run_shell` call (ms). The tool's `timeout` parameter is capped at this value (10 min by default, raise it for longer test suites/builds) |

---

## Custom tools

| Key | Env var | Default | Description |
|---|---|---|---|
| `customTools.baseDir` | `HIVEKEEP_CUSTOM_TOOLS_DIR` | `${dataDir}/custom-tools` | Root directory of global custom tools (`<baseDir>/<slug>/` = entrypoint + deps) |
| `customTools.defaultTimeoutMs` | `HIVEKEEP_CUSTOM_TOOL_TIMEOUT` | `30000` | Default timeout for executing a custom tool (ms) |
| `customTools.maxTimeoutMs` | `HIVEKEEP_CUSTOM_TOOL_MAX_TIMEOUT` | `300000` | Maximum timeout allowed for a custom tool (ms). Values are capped at this limit |
| `customTools.maxOutputBytes` | `HIVEKEEP_CUSTOM_TOOL_MAX_OUTPUT_BYTES` | `262144` | Ceiling for the captured output (stdout+stderr) of a custom tool, to protect the context window |
| `customTools.setupTimeoutMs` | `HIVEKEEP_CUSTOM_TOOL_SETUP_TIMEOUT` | `600000` | Timeout for installing dependencies (`pip`/`bun install`) (ms) |

---

## Long-term memory

| Key | Env var | Default | Description |
|---|---|---|---|
| `memory.extractionModel` | `MEMORY_EXTRACTION_MODEL` | — | Lightweight model for extracting memories (e.g. Haiku). If not set, uses the Agent's model |
| `memory.maxRelevantMemories` | `MEMORY_MAX_RELEVANT` | `10` | Max number of memories injected into the system prompt |
| `memory.similarityThreshold` | `MEMORY_SIMILARITY_THRESHOLD` | `0.7` | Minimum cosine similarity score for a memory to be considered relevant |
| `memory.embeddingModel` | `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Default embedding model |
| `memory.embeddingDimension` | `MEMORY_EMBEDDING_DIMENSION` | `1536` | Dimension of embedding vectors |

---

## Queue

| Key | Env var | Default | Description |
|---|---|---|---|
| `queue.userPriority` | — | `100` | Priority of user messages |
| `queue.agentPriority` | — | `50` | Priority of inter-Agent messages |
| `queue.taskPriority` | — | `50` | Priority of task messages |
| `queue.pollIntervalMs` | `QUEUE_POLL_INTERVAL` | `500` | Queue check interval (ms) |

---

## Tasks (sub-Agents)

| Key | Env var | Default | Description |
|---|---|---|---|
| `tasks.maxDepth` | `TASKS_MAX_DEPTH` | `3` | Maximum nesting depth of sub-Agents |
| `tasks.maxRequestInput` | `TASKS_MAX_REQUEST_INPUT` | `3` | Max number of request_input calls per sub-Agent |
| `tasks.maxConcurrent` | `TASKS_MAX_CONCURRENT` | `10` | Max number of concurrent tasks (across all Agents) |

---

## Crons

| Key | Env var | Default | Description |
|---|---|---|---|
| `crons.maxActive` | `CRONS_MAX_ACTIVE` | `50` | Max number of active crons |
| `crons.maxConcurrentExecutions` | `CRONS_MAX_CONCURRENT_EXEC` | `5` | Max number of concurrent cron executions |

---

## Inter-Agent communication

| Key | Env var | Default | Description |
|---|---|---|---|
| `interAgent.maxChainDepth` | `INTER_KIN_MAX_CHAIN_DEPTH` | `5` | Max depth of an inter-Agent message chain |
| `interAgent.rateLimitPerMinute` | `INTER_KIN_RATE_LIMIT` | `20` | Max number of messages an Agent can send to another per minute |

---

## Vault

| Key | Env var | Default | Description |
|---|---|---|---|
| `vault.algorithm` | — | `aes-256-gcm` | Encryption algorithm for secrets |

---

## Workspace

| Key | Env var | Default | Description |
|---|---|---|---|
| `workspace.baseDir` | `WORKSPACE_BASE_DIR` | `{dataDir}/workspaces` | Root directory of Agent workspaces |

---

## Workspace files (Files section)

Limits of the **Files** section (workspace browser/editor — see `files.md`).

| Key | Env var | Default | Description |
|---|---|---|---|
| `workspaceFiles.maxEditableSizeMb` | `WORKSPACE_FILES_MAX_EDITABLE_SIZE` | `5` | Above this size (MB), a text file is served as `too-large` (download only, no in-browser editing) |
| `workspaceFiles.maxUploadSizeMb` | `WORKSPACE_FILES_MAX_UPLOAD_SIZE` | `100` | Max size (MB) of a file uploaded to a workspace. `0` = unlimited (still capped by `MAX_REQUEST_BODY_MB`) |
| `workspaceFiles.maxCopySizeMb` | `WORKSPACE_FILES_MAX_COPY_SIZE` | `500` | Byte budget of a recursive folder copy (the copy aborts mid-stream when exceeded — `413 COPY_TOO_LARGE`) |
| `workspaceFiles.maxCopyEntries` | `WORKSPACE_FILES_COPY_MAX_ENTRIES` | `5000` | Entry-count budget of a recursive folder copy (millions of small files would bypass the byte cap) |
| `workspaceFiles.searchMaxResults` | `WORKSPACE_FILES_SEARCH_MAX_RESULTS` | `50` | Hard cap of the `limit` param of `/workspace/search` |
| `workspaceFiles.searchMaxEntries` | `WORKSPACE_FILES_SEARCH_MAX_ENTRIES` | `20000` | Budget of files walked per search request (giant workspaces) |

---

## Upload

| Key | Env var | Default | Description |
|---|---|---|---|
| `upload.dir` | `UPLOAD_DIR` | `{dataDir}/uploads` | Storage directory for files (chat, ticket attachments) |
| `upload.maxFileSizeMb` | `UPLOAD_MAX_FILE_SIZE` | `50` | Max size of an uploaded file (MB). Also serves as the default for ticket attachments |
| — | `TICKET_ATTACHMENT_MAX_SIZE` | `UPLOAD_MAX_FILE_SIZE` | Specific override for ticket attachments, in MB. Files are stored under `{upload.dir}/tickets/<projectId>/<ticketId>/<id>.<ext>` and cascade-deleted when the ticket is destroyed |

---

## Web browsing (one-shot)

Configuration shared by the `browse_url`, `extract_links`, `screenshot_url` tools. `browse_url` uses `fetch` + cheerio by default; the Playwright path is taken when `wait_for_js: true` or for `screenshot_url`.

| Key | Env var | Default | Description |
|---|---|---|---|
| `webBrowsing.pageTimeout` | `WEB_BROWSING_PAGE_TIMEOUT` | `30000` | Page load timeout (ms) |
| `webBrowsing.maxContentLength` | `WEB_BROWSING_MAX_CONTENT_LENGTH` | `100000` | Max size of extracted content (characters) |
| `webBrowsing.maxConcurrentFetches` | `WEB_BROWSING_MAX_CONCURRENT` | `5` | Number of simultaneous fetches |
| `webBrowsing.userAgent` | `WEB_BROWSING_USER_AGENT` | `Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36` | User-Agent sent for web requests |
| `webBrowsing.blockedDomains` | `WEB_BROWSING_BLOCKED_DOMAINS` | _(empty)_ | List of blocked domains (comma-separated) |
| `webBrowsing.proxy` | `WEB_BROWSING_PROXY` | _(empty)_ | URL of an HTTP proxy to use |
| `webBrowsing.headless.enabled` | `WEB_BROWSING_HEADLESS_ENABLED` | `true` | Enables the Playwright pool (Chromium). Set to `false` to disable — useful on systems without Chromium libs |
| `webBrowsing.headless.executablePath` | `BROWSER_EXECUTABLE_PATH` (fallback: `PUPPETEER_EXECUTABLE_PATH`) | _(auto)_ | Explicit path to the Chromium binary. If not set, Playwright uses its bundled binary |
| `webBrowsing.headless.maxBrowsers` | `WEB_BROWSING_MAX_BROWSERS` | `2` | Max concurrent Chromium instances in the one-shot pool |
| `webBrowsing.headless.idleTimeoutMs` | `WEB_BROWSING_BROWSER_IDLE_TIMEOUT` | `60000` | Idle delay (ms) before closing a one-shot browser |

> **System prerequisites**: Chromium requires shared libs (`libnspr4`, `libnss3`, `libasound2t64`, `libatk1.0-0t64`, `libcups2t64`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libpango-1.0-0`, `libcairo2`, `libatspi2.0-0t64`, `libwayland-client0` on Ubuntu 24.04; the `t64` names only exist since the `time_t64` transition). Without these libs, Chromium fails with `cannot open shared object file`. On WSL2, also verify that `bun` is NOT confined inside a snap (snaps sandbox access to `/usr/lib/`).

---

## Stateful browser sessions

Configuration of the **persistent per-Agent browser sessions**, used by the `browser_open_session`, `browser_navigate`, `browser_click`, etc. tools (14 `browser_*` tools). Each session preserves its state (cookies, scroll, forms) across multiple LLM turns.

| Key | Env var | Default | Description |
|---|---|---|---|
| `browserSessions.enabled` | `BROWSER_SESSIONS_ENABLED` | `true` | Enables the stateful tool family. Set to `false` to disable it globally (the tools stay registered but return an error). Individual tools remain opt-in per Agent via `tool_config.enabledOptInTools` regardless |
| `browserSessions.ttlMs` | `BROWSER_SESSION_TTL_MS` | `3_600_000` (1 h) | Absolute TTL of a session, from its creation, regardless of activity |
| `browserSessions.idleTimeoutMs` | `BROWSER_SESSION_IDLE_TIMEOUT_MS` | `600_000` (10 min) | Idle delay before automatic closing (GC) |
| `browserSessions.maxTotal` | `BROWSER_MAX_TOTAL_SESSIONS` | `5` | Global ceiling of active sessions, across all Agents |
| `browserSessions.maxPerAgent` | `BROWSER_MAX_SESSIONS_PER_KIN` | `1` | Ceiling per Agent |
| `browserSessions.defaultViewport.width` | `BROWSER_DEFAULT_VIEWPORT_WIDTH` | `1280` | Default viewport width |
| `browserSessions.defaultViewport.height` | `BROWSER_DEFAULT_VIEWPORT_HEIGHT` | `720` | Default viewport height |
| `browserSessions.statesDir` | `BROWSER_STATES_DIR` | `{dataDir}/browser-states` | Directory of saved states (cookies + localStorage). Stored OUTSIDE the workspace so that the Agent's filesystem tools cannot accidentally access them. Permission `0o600`. |
| `browserSessions.maxStatesPerAgent` | `BROWSER_MAX_STATES_PER_KIN` | `20` | Max number of saved states per Agent |
| `browserSessions.maxStateSizeBytes` | `BROWSER_MAX_STATE_SIZE_BYTES` | `5_242_880` (5 MB) | Max size of a state file (limits greedy localStorage) |

> **Auto-close hooks**: sessions are auto-closed at the end of a task (`resolveTask`), on deletion of an Agent (`deleteAgent` — which also deletes the saved states), on the server's SIGTERM/SIGINT, and by the idle GC every 15 s.

---

# Tuning knobs (advanced)

Internal tuning parameters — most deployments never touch them, the defaults are production-proven. This appendix lists them for operators who want to adjust memory, the context cache, resource limits, etc. **Only modify if you understand the impact** on latency, cost, or memory consumption of your deployment.

## Context Capping & Trimming

| Env Var | Default | Description |
|---------|---------|-------------|
| `TOOL_RESULT_SIZE_CAP_TOKENS` | `30000` | Max size of a tool result in the LLM payload; beyond that, the content is replaced by a placeholder (the DB stays intact). |
| `TOOL_CALL_ARGS_SIZE_CAP_TOKENS` | `8000` | Max size per string field in older tool-call args (covers write_file/edit with large contents). |
| `ASSISTANT_CONTENT_SIZE_CAP_TOKENS` | `12000` | Max size of an assistant message's text; head + tail preserved, middle replaced by placeholder. |
| `USER_CONTENT_SIZE_CAP_TOKENS` | `16000` | Max size of a user message's text; ceiling slightly higher than the assistant to absorb large copy-pastes. |
| `HISTORY_MAX_MESSAGES` | `1000` | Max number of raw messages retrieved from the DB for the conversation history; memory bound. |

## Memory (long-term)

| Env Var | Default | Description |
|---------|---------|-------------|
| `MEMORY_SIMILARITY_THRESHOLD` | `0.5` | Cosine similarity threshold for vector search candidates (lowered to 0.5 for more diversity). |
| `MEMORY_TEMPORAL_DECAY_LAMBDA` | `0.01` | Temporal decay rate; higher = decays faster. |
| `MEMORY_TEMPORAL_DECAY_FLOOR` | `0.7` | Score floor for old memories (prevents very old ones from reaching zero). |
| `MEMORY_CONSOLIDATION_SIMILARITY` | `0.85` | Threshold for merging two memories during consolidation. |
| `MEMORY_CONSOLIDATION_MAX_GEN` | `5` | Max number of consolidation generations before forced merge. |
| `MEMORY_ADAPTIVE_K` | `true` | Enables the adaptive K heuristic to prune low-score results. |
| `MEMORY_ADAPTIVE_K_MIN_SCORE_RATIO` | `0.15` | Min ratio vs the top to avoid winner-take-all. |
| `MEMORY_ADAPTIVE_K_LARGEST_GAP_RATIO` | `0.6` | Largest-gap heuristic: truncate only if there is a drop >60% of the top-current delta. |
| `MEMORY_RRF_K` | `60` | Reciprocal Rank Fusion parameter for hybrid search (vector + FTS). |
| `MEMORY_FTS_BOOST` | `0.5` | FTS score multiplier in the hybrid ranking. |
| `MEMORY_SUBJECT_BOOST` | `1.3` | Relevance multiplier for the subject field. |
| `MEMORY_CATEGORY_BOOST` | `1.25` | Relevance multiplier for the category field. |
| `MEMORY_CONTEXTUAL_REWRITE_THRESHOLD` | `80` | Token threshold triggering contextual rewriting of queries. |
| `MEMORY_TOKEN_BUDGET` | `0` | Max token budget for memory injection; 0 = unlimited. |
| `MEMORY_RECENCY_BOOST` | `true` | Boosts very recent memories in the ranking. |
| `MEMORY_CONSOLIDATION_MODEL` | — | Model for consolidation (`providerId:modelId` format); falls back to the Agent's. |
| `MEMORY_MULTI_QUERY_MODEL` | — | Model for multi-query expansion. |
| `MEMORY_HYDE_MODEL` | — | Model for HyDE reranking. |
| `MEMORY_RERANK_MODEL` | — | Model for secondary reranking. |
| `MEMORY_CONTEXTUAL_REWRITE_MODEL` | — | Model for contextual rewriting of long queries. |

## Browser sessions

| Env Var | Default | Description |
|---------|---------|-------------|
| `BROWSER_SESSION_TTL_MS` | `3_600_000` (1 h) | Hard TTL of a browser session, regardless of activity. |
| `BROWSER_SESSION_IDLE_TIMEOUT_MS` | `600_000` (10 min) | Automatic close after inactivity. |

(See also the `browserSessions.*` documented at the top for `BROWSER_MAX_*` and `BROWSER_DEFAULT_VIEWPORT_*`.)

## File storage & uploads

| Env Var | Default | Description |
|---------|---------|-------------|
| `FILE_STORAGE_DIR` | `{dataDir}/storage` | Directory of the persistent file storage. |
| `FILE_STORAGE_MAX_SIZE` | `0` (unlimited) | Max size of an individual file (MB). `0` or negative = no limit. |
| `FILE_STORAGE_CLEANUP_INTERVAL` | `60` (min) | Interval of the expired-file cleanup job. |
| `UPLOAD_CHANNEL_RETENTION_DAYS` | `30` | Retention of files downloaded by channels; 0 = never purge. |
| `UPLOAD_CHANNEL_CLEANUP_INTERVAL` | `60` (min) | Interval of the channel file purge job. |

## Vault

| Env Var | Default | Description |
|---------|---------|-------------|
| `VAULT_ATTACHMENT_DIR` | `{dataDir}/vault` | Directory of vault attachments. |
| `VAULT_MAX_ATTACHMENT_SIZE` | `50` (MB) | Max size per attachment. |
| `VAULT_MAX_ATTACHMENTS_PER_ENTRY` | `10` | Max number of attachments per vault entry. |

## Terminal

| Env Var | Default | Description |
|---------|---------|-------------|
| `HIVEKEEP_TERMINAL_ENABLED` | `true` | Kill-switch for the admin web terminal. Set to `false` to disable the feature entirely. |
| `HIVEKEEP_TERMINAL_SHELL` | `$SHELL`, then `/bin/bash` | Shell binary spawned for each terminal session. |
| `HIVEKEEP_TERMINAL_SCROLLBACK_KB` | `256` | Scrollback kept server-side per session (KB), replayed when a client reattaches. |
| `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` | `600` | How long a detached session (no client connected) survives before the shell is killed. |
| `HIVEKEEP_TERMINAL_MAX_SESSIONS` | `10` | Hard cap of concurrently running PTY sessions across all users. |

## Webhooks

| Env Var | Default | Description |
|---------|---------|-------------|
| `WEBHOOKS_MAX_PER_KIN` | `20` | Max number of webhooks per Agent. |
| `WEBHOOKS_MAX_PAYLOAD_BYTES` | `1_048_576` (1 MB) | Max payload for delivery. |
| `WEBHOOKS_LOG_RETENTION_DAYS` | `30` | Retention of execution logs. |
| `WEBHOOKS_MAX_LOGS_PER_WEBHOOK` | `500` | Max number of log entries retained per webhook. |
| `WEBHOOKS_RATE_LIMIT_PER_MINUTE` | `60` | Delivery rate limit. |

## Email triggers

Triggers on connected email accounts: a matching incoming email prompts a target Agent (in its conversation or as a task). Polled — see `account_triggers` / `account_sync_state` in `schema.md`.

| Env Var | Default | Description |
|---------|---------|-------------|
| `EMAIL_TRIGGERS_MAX_PER_ACCOUNT` | `20` | Max triggers per connected account. |
| `EMAIL_TRIGGER_POLL_INTERVAL` | `120_000` (2 min) | Poller interval in ms. `<= 0` disables the poller entirely. |
| `EMAIL_TRIGGER_MAX_PER_CYCLE` | `50` | Anti-flood cap: max messages processed per (account, folder) per cycle. |
| `EMAIL_TRIGGER_LOG_RETENTION_DAYS` | `30` | Retention of trigger evaluation logs. |
| `EMAIL_TRIGGER_MAX_LOGS_PER_TRIGGER` | `500` | Max log entries retained per trigger. |
| `EMAIL_TRIGGER_SEEN_IDS_RING` | `200` | Size of the per-(account, folder) seen-ids dedup ring. |

> Whether Agent-created triggers need user approval is a runtime setting (`agent_triggers_require_approval` in `app_settings`, default off), not an env var.

## Channels

| Env Var | Default | Description |
|---------|---------|-------------|
| `CHANNELS_MAX_PER_KIN` | `5` | Max number of channels connected per Agent. |
| `CHANNEL_PENDING_ORIGIN_TTL` | `300_000` (5 min) | TTL of the pending origin verification during setup. |

## Tasks (sub-Agents)

| Env Var | Default | Description |
|---------|---------|-------------|
| `TASKS_MAX_REQUEST_INPUT` | `3` | Max number of `request_input` calls per sub-Agent task. |
| `TASKS_MAX_INTER_KIN_REQUESTS` | `3` | Max number of inter-Agent calls per sub-Agent task. |
| `TASKS_INTER_KIN_RESPONSE_TIMEOUT_MS` | `300_000` (5 min) | Timeout for inter-Agent responses. |

## Crons & scheduling

| Env Var | Default | Description |
|---------|---------|-------------|
| `MODEL_INFO_REFRESH_CRON` | `0 */6 * * *` | Cron for refreshing the model-info cache (picks up provider-side spec changes without restarting). |

## Invitations & sessions

| Env Var | Default | Description |
|---------|---------|-------------|
| `INVITATION_DEFAULT_EXPIRY_DAYS` | `7` | Default expiration of an invitation. |
| `INVITATION_MAX_ACTIVE` | `50` | Max number of active invitations on the server. |
| `QUICK_SESSION_EXPIRATION_HOURS` | `24` | Lifetime of a quick session. |
| `QUICK_SESSION_MAX_PER_USER_KIN` | `1` | Max number of quick-sessions per (user, Agent). |
| `QUICK_SESSION_RETENTION_DAYS` | `7` | Retention of quick-session history. |
| `QUICK_SESSION_CLEANUP_INTERVAL` | `60` (min) | Interval of the purge job. |

## Notifications

| Env Var | Default | Description |
|---------|---------|-------------|
| `NOTIFICATIONS_RETENTION_DAYS` | `30` | Retention of internal notifications. |
| `NOTIFICATIONS_MAX_PER_USER` | `500` | Max number of notifications stored per user. |
| `NOTIFICATIONS_EXT_MAX_PER_USER` | `5` | Max number of external delivery integrations per user. |
| `NOTIFICATIONS_EXT_RATE_LIMIT` | `5` | External delivery rate limit (per minute). |
| `NOTIFICATIONS_EXT_MAX_ERRORS` | `5` | Consecutive errors before auto-disabling the integration. |

## Wakeups & human prompts

| Env Var | Default | Description |
|---------|---------|-------------|
| `WAKEUPS_MAX_PENDING_PER_KIN` | `20` | Max number of scheduled wakeups per Agent. |
| `HUMAN_PROMPTS_MAX_PENDING` | `5` | Max number of pending human prompts per Agent. |

## Projects (Kanban & tickets)

| Env Var | Default | Description |
|---------|---------|-------------|
| `PROJECTS_MAX_DESCRIPTION_PROMPT_TOKENS` | `8000` | Strict ceiling on project description tokens injected into the prompt. |
| `PROJECTS_MAX_TICKETS_IN_PROMPT` | `50` | Max number of non-done tickets injected (sorted by `updated_at` DESC). |
| `PROJECTS_KANBAN_POSITION_STEP` | `1024` | Step between consecutive positions when inserting at the head of a column. |

## Mini-apps

| Env Var | Default | Description |
|---------|---------|-------------|
| `MINI_APPS_DIR` | `{dataDir}/mini-apps` | Directory of mini-app bundles. |
| `MINI_APPS_MAX_PER_KIN` | `20` | Max number of mini-apps deployable per Agent. |
| `MINI_APPS_MAX_FILE_SIZE` | `5` (MB) | Max size of an individual file in a bundle. |
| `MINI_APPS_MAX_TOTAL_SIZE` | `50` (MB) | Max total size of a mini-app bundle. |
| `MINI_APPS_BACKEND_ENABLED` | `true` | Enables/disables the mini-apps backend server. |

## Version checking & self-update

| Env Var | Default | Description |
|---------|---------|-------------|
| `VERSION_CHECK_ENABLED` | `true` | Enables periodic new-version checks. |
| `VERSION_CHECK_REPO` | `MarlBurroW/hivekeep` | Target repo for the checks. |
| `VERSION_CHECK_BRANCH` | `main` | Branch tracked by the **edge** update channel. |
| `VERSION_CHECK_INTERVAL_HOURS` | `1` | Check interval. |
| `VERSION_CHECK_GITHUB_TOKEN` | — | Optional GitHub token to lift the unauthenticated API rate limit (60 req/h). |
| `HIVEKEEP_GIT_SHA` | — | Git sha of the running code; baked into Docker images by CI (images have no `.git`). Enables the edge channel comparison in Docker. |
| `HIVEKEEP_ALLOW_DEV_SELF_UPDATE` | `false` | Allows the UI self-update outside `NODE_ENV=production` (testing only). |

> The update **channel** (`stable` = GitHub releases, `edge` = HEAD of main) is not an env var: it's a runtime admin setting (`app_settings.update_channel`, Settings → Updates), default `stable`. Self-update state lives in `data/update/` (journal, DB snapshots, dist backups, update.log).

## MCP

| Env Var | Default | Description |
|---------|---------|-------------|
| `MCP_REQUIRE_APPROVAL` | `true` | Requires user approval before executing an MCP tool. |

> **Note**: most of these defaults are production-tested and rarely need changing. The `MEMORY_*_MODEL` variables follow the `providerId:modelId` format and fall back to the Agent's main model if not set.
