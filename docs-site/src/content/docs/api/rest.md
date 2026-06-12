---
title: REST API
description: Hivekeep REST API endpoint reference.
---

Hivekeep exposes a REST API used by the web UI and available for external integrations. All endpoints are under `/api/` and require authentication unless noted otherwise.

## Authentication

Authenticate using either:

- **API key header:** `X-API-Key: <your-api-key>`
- **Session cookie** set during login

Auth routes (`/api/auth/*`) are handled by [Better Auth](https://www.better-auth.com/) and don't require pre-authentication. Onboarding routes (`/api/onboarding/*`) are also unauthenticated (first-run setup).

## Error Format

All API routes return JSON. Errors use a consistent envelope with a machine-readable `code` and a human-readable `message`:

```json
{
  "error": {
    "code": "PROVIDER_NOT_FOUND",
    "message": "Provider not found"
  }
}
```

The HTTP status reflects the error class (`400` validation, `401` unauthenticated, `403` forbidden, `404` not found, `409` conflict, `429` rate-limited, `500` server error). Common codes include `VALIDATION_ERROR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, and resource-specific codes such as `PROVIDER_NOT_FOUND` or `SESSION_EXPIRED`.

## Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all Agents |
| `POST` | `/api/agents` | Create a new Agent |
| `GET` | `/api/agents/:id` | Get Agent details |
| `PATCH` | `/api/agents/:id` | Update an Agent |
| `DELETE` | `/api/agents/:id` | Delete an Agent |
| `GET` | `/api/agents/:id/tools` | List available tools (grouped by domain) |
| `GET` | `/api/agents/:id/context-usage` | Get context window usage |
| `GET` | `/api/agents/:id/context-preview` | Get full LLM context preview (system prompt, messages, tools, token estimates). Accepts `?taskId` or `?sessionId` query params |
| `POST` | `/api/agents/:id/avatar` | Upload avatar (multipart) |
| `POST` | `/api/agents/:id/avatar/generate` | Generate avatar with AI |
| `POST` | `/api/agents/avatar/preview` | Preview generated avatar |
| `POST` | `/api/agents/generate-config` | AI-generate Agent config from description |
| `GET` | `/api/agents/:id/export` | Export Agent as archive |
| `POST` | `/api/agents/import` | Import Agent from archive |

## Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:agentId/messages` | Get conversation history |
| `POST` | `/api/agents/:agentId/messages` | Send a message to an Agent |
| `POST` | `/api/agents/:agentId/messages/inject` | Inject a message with high priority (aborts current stream if active, used by `/btw` command) |

## Reactions

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:agentId/messages/:messageId/reactions` | List reactions on a message |
| `POST` | `/api/agents/:agentId/messages/:messageId/reactions` | Add or toggle a reaction |

## Compacting

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:id/compacting/summaries` | List compacting summaries (with date ranges, token estimates, depth) |
| `GET` | `/api/agents/:id/compacting/snapshots` | List compacting summaries (backwards-compatible alias, returns legacy format) |
| `POST` | `/api/agents/:id/compacting/run` | Trigger manual compacting |
| `POST` | `/api/agents/:id/compacting/purge` | Purge compacting data (deactivate all active summaries) |
| `POST` | `/api/agents/:id/compacting/rollback` | Rollback to a summary (archives newer summaries) |

## Memories

Memories can be accessed via Agent-scoped routes or global maintenance routes.

### Agent-scoped

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:id/memories` | List memories for an Agent |
| `POST` | `/api/agents/:id/memories` | Create a memory |
| `PATCH` | `/api/agents/:id/memories/:memoryId` | Update a memory |
| `DELETE` | `/api/agents/:id/memories/:memoryId` | Delete a memory |

### Global maintenance

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/memories` | List all memories (cross-Agent) |
| `POST` | `/api/memories/backfill-importance` | Backfill importance scores |
| `POST` | `/api/memories/consolidate` | Run memory consolidation |
| `POST` | `/api/memories/reembed` | Re-embed all memories |

## Knowledge

Agent-scoped knowledge base (RAG document sources).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:agentId/knowledge` | List knowledge sources |
| `POST` | `/api/agents/:agentId/knowledge` | Add a knowledge source |
| `GET` | `/api/agents/:agentId/knowledge/search` | Search knowledge |
| `GET` | `/api/agents/:agentId/knowledge/:sourceId` | Get source details |
| `DELETE` | `/api/agents/:agentId/knowledge/:sourceId` | Delete a source |
| `POST` | `/api/agents/:agentId/knowledge/:sourceId/reprocess` | Reprocess a source |

## Channels

Channels are managed globally (not scoped to an Agent).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/channels` | List all channels |
| `POST` | `/api/channels` | Create a channel |
| `GET` | `/api/channels/pending-count` | Get pending message counts |
| `GET` | `/api/channels/:id` | Get channel details |
| `PATCH` | `/api/channels/:id` | Update a channel |
| `DELETE` | `/api/channels/:id` | Delete a channel |
| `POST` | `/api/channels/:id/activate` | Activate a channel |
| `POST` | `/api/channels/:id/deactivate` | Deactivate a channel |
| `POST` | `/api/channels/:id/test` | Test channel configuration |
| `GET` | `/api/channels/:id/user-mappings` | List user mappings |
| `POST` | `/api/channels/:id/user-mappings/:mapId/approve` | Approve a user mapping |

### Channel webhooks

Platform-specific webhook endpoints (no auth required, verified by platform signature):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/channels/telegram/:channelId` | Telegram webhook |
| `POST` | `/api/channels/slack/webhook/:channelId` | Slack Events API |
| `GET/POST` | `/api/channels/whatsapp/webhook/:channelId` | WhatsApp verification & webhook |
| `POST` | `/api/channels/signal/webhook/:channelId` | Signal webhook |

## Mini-Apps

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mini-apps` | List all mini-apps |
| `POST` | `/api/mini-apps` | Create a mini-app |
| `GET` | `/api/mini-apps/:id` | Get mini-app details |
| `PATCH` | `/api/mini-apps/:id` | Update a mini-app |
| `DELETE` | `/api/mini-apps/:id` | Delete a mini-app |
| `GET` | `/api/mini-apps/by-slug/:agentId/:slug` | Get mini-app by Agent + slug |
| `GET` | `/api/mini-apps/gallery/browse` | Browse mini-app gallery |
| `POST` | `/api/mini-apps/:id/generate-icon` | Generate an icon with AI |

### Mini-App files

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mini-apps/:id/files` | List app files |
| `GET` | `/api/mini-apps/:id/files/*` | Read a file |
| `PUT` | `/api/mini-apps/:id/files/*` | Write a file |
| `DELETE` | `/api/mini-apps/:id/files/*` | Delete a file |

### Mini-App storage (key-value)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mini-apps/:id/storage` | List all keys |
| `GET` | `/api/mini-apps/:id/storage/:key` | Get a value |
| `PUT` | `/api/mini-apps/:id/storage/:key` | Set a value |
| `DELETE` | `/api/mini-apps/:id/storage/:key` | Delete a key |
| `DELETE` | `/api/mini-apps/:id/storage` | Clear all storage |

### Mini-App snapshots

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mini-apps/:id/snapshots` | List snapshots |
| `POST` | `/api/mini-apps/:id/snapshots` | Create a snapshot |
| `POST` | `/api/mini-apps/:id/snapshots/:version/rollback` | Rollback to snapshot |

### Mini-App backend

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/mini-apps/:id/http` | Proxy HTTP request to app backend |
| `GET` | `/api/mini-apps/:id/events` | SSE stream from app backend |
| `GET` | `/api/mini-apps/:id/memories/search` | Search mini-app memories |
| `POST` | `/api/mini-apps/:id/memories` | Create a mini-app memory |

### Mini-App serving

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mini-apps/:id/serve` | Serve mini-app HTML |
| `GET` | `/api/mini-apps/:id/static/*` | Serve static assets |

### Mini-App SDK

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mini-apps/sdk/hivekeep-sdk.js` | SDK JavaScript |
| `GET` | `/api/mini-apps/sdk/hivekeep-react.js` | React bindings |
| `GET` | `/api/mini-apps/sdk/hivekeep-components.js` | Component library |
| `GET` | `/api/mini-apps/sdk/hivekeep-sdk.css` | SDK stylesheet |
| `GET` | `/api/mini-apps/sdk/*.d.ts` | TypeScript declarations |

## Quick Sessions

Ephemeral conversation sessions for quick interactions.

All session responses include an `expiresAt` field (Unix timestamp in ms, or `null`). Sending a message to an expired session returns `409 SESSION_EXPIRED`.

### Agent-scoped

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents/:agentId/quick-sessions` | List sessions for an Agent |
| `POST` | `/api/agents/:agentId/quick-sessions` | Create a session |

### Session detail

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/quick-sessions/:id` | Get session with messages |
| `POST` | `/api/quick-sessions/:id/messages` | Send a message |
| `POST` | `/api/quick-sessions/:id/messages/stop` | Stop AI generation |
| `POST` | `/api/quick-sessions/:id/close` | Close a session |

## Tasks

Sub-tasks spawned by Agents (inter-Agent delegation, subtasks). Tasks support **concurrency groups**: tasks in the same group are limited to a max number of parallel executions, with excess tasks queued and auto-promoted.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks` | List all tasks |
| `GET` | `/api/tasks/:id` | Get task details with messages |
| `POST` | `/api/tasks/:id/cancel` | Cancel a running task |
| `POST` | `/api/tasks/:id/pause` | Pause a running task (preserves state) |
| `POST` | `/api/tasks/:id/resume` | Resume a paused task, optionally with a message (`{ message?: string }`) |
| `POST` | `/api/tasks/:id/inject` | Inject a message into a running task (`{ content: string }`), aborts current stream and re-triggers with addendum |
| `POST` | `/api/tasks/:id/force-promote` | Force-start a queued task (ignoring concurrency limit) |

## Plugins

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plugins` | List installed plugins |
| `POST` | `/api/plugins` | Install a plugin |
| `PATCH` | `/api/plugins/:id` | Update plugin config |
| `DELETE` | `/api/plugins/:id` | Uninstall a plugin |

See [Plugin API](/docs/plugins/api/) for the full plugin store and registry routes.

## Providers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/providers` | List providers with status |
| `POST` | `/api/providers` | Configure a provider |
| `PATCH` | `/api/providers/:id` | Update provider config |
| `DELETE` | `/api/providers/:id` | Remove provider config |
| `POST` | `/api/providers/:id/test` | Test provider connection |

See [Providers](/docs/providers/supported/) for the full provider reference.

## Contacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/contacts` | List contacts |
| `POST` | `/api/contacts` | Create a contact |
| `GET` | `/api/contacts/:id` | Get contact details |
| `PATCH` | `/api/contacts/:id` | Update a contact |
| `DELETE` | `/api/contacts/:id` | Delete a contact |
| `PUT` | `/api/contacts/:id/identifiers` | Replace all identifiers atomically |
| `POST` | `/api/contacts/:id/identifiers` | Add an identifier |
| `PATCH` | `/api/contacts/:id/identifiers/:identifierId` | Update an identifier |
| `DELETE` | `/api/contacts/:id/identifiers/:identifierId` | Remove an identifier |
| `GET` | `/api/contacts/:id/platform-ids` | List platform IDs |
| `POST` | `/api/contacts/:id/platform-ids` | Add a platform ID |
| `DELETE` | `/api/contacts/:id/platform-ids/:pidId` | Remove a platform ID |
| `POST` | `/api/contacts/:id/notes` | Add a note |
| `PATCH` | `/api/contacts/:id/notes/:noteId` | Update a note |
| `DELETE` | `/api/contacts/:id/notes/:noteId` | Delete a note |

## MCP Servers

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/mcp-servers` | List MCP server configs |
| `POST` | `/api/mcp-servers` | Add an MCP server |
| `PATCH` | `/api/mcp-servers/:id` | Update MCP server |
| `POST` | `/api/mcp-servers/:id/approve` | Approve an MCP server |
| `DELETE` | `/api/mcp-servers/:id` | Remove MCP server |

## Cron Jobs

Cron jobs are managed globally (not scoped to an Agent).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/crons` | List cron jobs |
| `POST` | `/api/crons` | Create a cron job |
| `PATCH` | `/api/crons/:id` | Update a cron job |
| `POST` | `/api/crons/:id/trigger` | Trigger a job immediately |
| `POST` | `/api/crons/:id/approve` | Approve a pending job |
| `DELETE` | `/api/crons/:id` | Delete a cron job |

## Webhooks

Webhooks are managed globally.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/webhooks` | List webhooks |
| `POST` | `/api/webhooks` | Create a webhook |
| `PATCH` | `/api/webhooks/:id` | Update a webhook |
| `DELETE` | `/api/webhooks/:id` | Delete a webhook |
| `GET` | `/api/webhooks/:id/logs` | Get webhook execution logs |
| `POST` | `/api/webhooks/:id/regenerate-token` | Regenerate webhook token |
| `POST` | `/api/webhooks/:id/test-filter` | Test a payload filter against a sample payload |
| `POST` | `/api/webhooks/:id/suggest-fields` | Extract field path suggestions from the last received payload |

### Incoming webhook endpoint

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/webhooks/incoming/:webhookId` | Receive an incoming webhook (rate-limited) |

## Vault

Secure storage for secrets and sensitive data.

### Vaults

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/vault` | List vaults |
| `POST` | `/api/vault` | Create a vault |
| `PATCH` | `/api/vault/:id` | Update a vault |
| `DELETE` | `/api/vault/:id` | Delete a vault |

### Entries

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/vault/entries` | List entries |
| `POST` | `/api/vault/entries` | Create an entry |
| `GET` | `/api/vault/entries/:id` | Get entry details |
| `PATCH` | `/api/vault/entries/:id` | Update an entry |
| `DELETE` | `/api/vault/entries/:id` | Delete an entry |

### Attachments

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/vault/entries/:id/attachments` | List attachments |
| `POST` | `/api/vault/entries/:id/attachments` | Upload attachment |
| `GET` | `/api/vault/attachments/:id` | Download attachment |
| `DELETE` | `/api/vault/attachments/:id` | Delete attachment |

### Types

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/vault/types` | List vault types |
| `POST` | `/api/vault/types` | Create a type |
| `PATCH` | `/api/vault/types/:id` | Update a type |
| `DELETE` | `/api/vault/types/:id` | Delete a type |

## File Storage

Shared file hosting with optional expiration and passwords.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/file-storage` | List stored files |
| `POST` | `/api/file-storage` | Upload a file (multipart) |
| `GET` | `/api/file-storage/:id` | Download a file |
| `PATCH` | `/api/file-storage/:id` | Update file metadata |
| `DELETE` | `/api/file-storage/:id` | Delete a file |

## Files

Internal file uploads (used by messages).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/files/upload` | Upload a file (multipart) |

## Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/notifications` | List notifications |
| `GET` | `/api/notifications/unread-count` | Get unread count |
| `PATCH` | `/api/notifications/:id/read` | Mark as read |
| `POST` | `/api/notifications/mark-all-read` | Mark all as read |
| `DELETE` | `/api/notifications/:id` | Delete a notification |

## Prompts

Pending approval prompts (e.g. tool use confirmations).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/prompts/pending` | List pending prompts |
| `POST` | `/api/prompts/:id/respond` | Respond to a prompt |

## Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | List users |
| `GET` | `/api/users/mentionables` | List mentionable users |
| `DELETE` | `/api/users/:id` | Delete a user |

## Invitations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/invitations` | List invitations |
| `POST` | `/api/invitations` | Create an invitation |
| `DELETE` | `/api/invitations/:id` | Delete an invitation |
| `GET` | `/api/invitations/:token/validate` | Validate an invitation token |

## Settings

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/settings/global-prompt` | Get global system prompt |
| `PUT` | `/api/settings/global-prompt` | Update global prompt |
| `GET` | `/api/settings/models` | Get extraction + embedding model config (legacy) |
| `GET` | `/api/settings/default-models` | Get all model/service defaults (LLM, image, compacting, scout, extraction, embedding, search, TTS, STT) |
| `PUT` | `/api/settings/default-llm` | Set default LLM model + provider |
| `PUT` | `/api/settings/default-image` | Set default image generation model + provider |
| `PUT` | `/api/settings/default-compacting` | Set default compacting model + provider |
| `PUT` | `/api/settings/default-scout` | Set default scout model + provider |
| `PUT` | `/api/settings/default-search` | Set default search provider |
| `PUT` | `/api/settings/default-tts` | Set default text-to-speech provider/model |
| `PUT` | `/api/settings/default-stt` | Set default speech-to-text provider/model |
| `PUT` | `/api/settings/extraction-model` | Set memory extraction model |
| `PUT` | `/api/settings/embedding-model` | Set embedding model |
| `GET` | `/api/settings/task-limits` | Get task concurrency/depth limits |
| `PUT` | `/api/settings/task-limits` | Update task limits |
| `GET` | `/api/settings/avatar-style` | Get the global avatar art style |
| `PUT` | `/api/settings/avatar-style` | Update the avatar art style |
| `GET` | `/api/settings/dismissed-setup-items` | List dismissed setup-checklist items |
| `POST` | `/api/settings/dismissed-setup-items/:itemId` | Dismiss a setup-checklist item |
| `DELETE` | `/api/settings/dismissed-setup-items/:itemId` | Restore a dismissed setup item |

## Current User

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/me` | Get current user info |
| `PATCH` | `/api/me` | Update profile |
| `POST` | `/api/me/avatar` | Upload avatar (multipart) |

## Shared Links

Public access to shared files (no auth required, token-based).

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/s/:token` | View shared content |
| `POST` | `/s/:token` | Access password-protected share |

## Platform Updates

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/version-check` | Cached version info: current version/sha, channel (`stable`/`edge`), installation type, latest version, cumulative changelog, `canSelfUpdate` |
| `POST` | `/api/version-check/check` | Force a fresh version check against GitHub (admin only). Returns 400 if version check is disabled |
| `PUT` | `/api/version-check/channel` | Switch the update channel: `{ "channel": "stable" \| "edge" }` (admin only) |
| `POST` | `/api/version-check/update` | Start the safe self-update (admin only, git installs). Returns `{ runId }`; progress over SSE `update:progress`, outcome in `/last-update`. 400 for Docker/dev installs, 409 if already running |
| `GET` | `/api/version-check/last-update` | Latest update attempt (`running`/`restarting`/`success`/`failed`/`rolled-back`) — persisted, survives the restart |

## Usage (admin only)

Token usage tracking for all LLM calls. All routes require admin role.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/usage` | Paginated list of LLM usage records with filters (agentId, providerId, providerType, modelId, taskId, cronId, callSite, from/to timestamps) |
| `GET` | `/api/usage/summary` | Aggregated usage grouped by dimension (groupBy: `provider_type`, `model_id`, `agent_id`, `call_site`, `day`) |

## SSE

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sse` | SSE event stream (see [SSE Events](/docs/api/sse/)) |
