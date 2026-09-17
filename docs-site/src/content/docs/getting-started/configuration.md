---
title: Configuration
description: Environment variables and settings for Hivekeep.
---

Hivekeep uses environment variables for configuration. Copy `.env.example` to `.env` and adjust as needed. All values have sensible defaults, so you can start with an empty `.env`.

## Core settings

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on all interfaces) |
| `HIVEKEEP_DATA_DIR` | `./data` | Persistent data directory (DB, uploads, workspaces) |
| `DB_PATH` | `$HIVEKEEP_DATA_DIR/hivekeep.db` | SQLite database file path |
| `ENCRYPTION_KEY` | *(auto-generated)* | 64-char hex key for AES-256-GCM vault encryption. Auto-generated and persisted to `data/.encryption-key` on first run. |
| `BETTER_AUTH_SECRET` | *(uses ENCRYPTION_KEY)* | Secret for session signing. Falls back to `ENCRYPTION_KEY` if not set. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Public-facing URL (used in webhooks, invitation links, and CORS). Sign-in works from any address the server itself is reached at (same-origin requests are always trusted), so this is about the URLs Hivekeep generates, not about being able to log in. |
| `TRUSTED_ORIGINS` | *(none)* | Comma-separated list of additional origins allowed for CORS and auth (e.g. `https://app.example.com,https://other.example.com`). Setting it replaces the defaults (`PUBLIC_URL` + localhost dev origins), so include `PUBLIC_URL` yourself. The origin a request arrives on is always trusted regardless. |

## Data directory

Hivekeep stores everything in a single directory (`HIVEKEEP_DATA_DIR`):

- **SQLite database**: messages, agents, settings, memories
- **File uploads**: user-uploaded files and generated images
- **Agent workspaces**: custom tools and scripts created by Agents
- **Encryption key**: auto-generated on first run if not provided

:::tip
When using Docker, mount a volume to `/app/data` to persist data across container restarts.
:::

## History

| Variable | Default | Description |
|---|---|---|
| `HISTORY_TOKEN_BUDGET` | `0` | Emergency history token cap; `0` disables this cap (compaction still applies) |

## Custom tools

| Variable | Default | Description |
|---|---|---|
| `HIVEKEEP_CUSTOM_TOOL_TIMEOUT` | `30000` | Default execution timeout for custom tools (ms) |
| `HIVEKEEP_CUSTOM_TOOL_MAX_TIMEOUT` | `300000` | Maximum allowed timeout for custom tools (ms). Per-invocation values are capped to this limit |

## Webhooks

| Variable | Default | Description |
|---|---|---|
| `WEBHOOKS_LOG_RETENTION_DAYS` | `30` | Webhook execution log retention period in days |
| `WEBHOOKS_MAX_LOGS_PER_WEBHOOK` | `500` | Max stored execution logs per webhook |
| `WEBHOOKS_RATE_LIMIT_PER_MINUTE` | `60` | Max webhook executions per minute |

## Uploads

| Variable | Default | Description |
|---|---|---|
| `MAX_REQUEST_BODY_MB` | `256` | HTTP request envelope in MB, including multipart overhead (maximum 1024) |
| `FILE_STORAGE_MAX_SIZE` | `128` | Maximum MB per stored file (maximum 1024) |
| `UPLOAD_CHANNEL_RETENTION_DAYS` | `30` | Channel file retention period in days |
| `UPLOAD_CHANNEL_CLEANUP_INTERVAL` | `60` | Channel file cleanup interval in minutes |

Legacy `0` values for HTTP, stored-file and workspace-upload size limits now use
their finite defaults and emit a startup warning. Increase the HTTP envelope
limit as well as the file limit when allowing larger uploads.

## Graceful shutdown

| Variable | Default | Description |
|---|---|---|
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `20000` | Time allowed for active work after stopping new admissions |
| `SHUTDOWN_CLEANUP_TIMEOUT_MS` | `5000` | Deadline for abort settling and resource cleanup |

SIGTERM and SIGINT stop schedulers and new work before draining existing turns.
Pending inputs survive restart. Work still running after the deadline is
interrupted; external actions are not guaranteed to execute exactly once.

## Workspace files (Files section)

Limits of the [Files workspace browser](/docs/features/files/).

| Variable | Default | Description |
|---|---|---|
| `WORKSPACE_FILES_MAX_EDITABLE_SIZE` | `5` | Max size (MB) of a text file editable in the browser; above this it becomes download-only |
| `WORKSPACE_FILES_MAX_UPLOAD_SIZE` | `100` | Max size (MB) per workspace upload; legacy `0` uses the finite default |
| `WORKSPACE_FILES_MAX_COPY_SIZE` | `500` | Byte budget (MB) of a recursive folder copy |
| `WORKSPACE_FILES_COPY_MAX_ENTRIES` | `5000` | Entry-count budget of a recursive folder copy |
| `WORKSPACE_FILES_SEARCH_MAX_RESULTS` | `50` | Hard cap on file-search results |
| `WORKSPACE_FILES_SEARCH_MAX_ENTRIES` | `20000` | Files walked per search request |

## Version checking

| Variable | Default | Description |
|---|---|---|
| `HIVEKEEP_VERSION` | *(auto-detected)* | Explicit version override. Read from `package.json` by default. In Docker, automatically set by the entrypoint. Only needed if version detection fails. |
| `VERSION_CHECK_ENABLED` | `true` | Enable automatic version checking against GitHub releases |
| `VERSION_CHECK_REPO` | `MarlBurroW/hivekeep` | GitHub repo to check for new releases |
| `VERSION_CHECK_INTERVAL_HOURS` | `1` | Hours between version checks |

## Advanced options

See [`.env.example`](https://github.com/MarlBurroW/hivekeep/blob/main/.env.example) for the complete list of all options including:

- Compacting threshold (`COMPACTING_THRESHOLD_PERCENT`, default 75%)
- Memory tuning (extraction, vector dimensions, search pipeline)
- Tool step limit (`TOOLS_MAX_STEPS`, default 0 = unlimited)
- Read-only tool concurrency (`TOOLS_CONCURRENCY_CAP`, default 5)
- Tool-turn temperature (`TOOLS_TEMPERATURE`, default 0; steadies tool-call JSON on small local models; `off` defers to the backend)
- Queue settings
- Cron limits
- Web browsing configuration
- Channel origin TTL (`CHANNEL_ORIGIN_TTL`, default 24h)
