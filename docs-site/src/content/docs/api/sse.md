---
title: SSE Events
description: Real-time Server-Sent Events for live UI updates.
---

Hivekeep uses **Server-Sent Events (SSE)** to push real-time updates to the web UI. Connect to the SSE endpoint to receive live notifications about changes.

## Endpoint

```
GET /api/sse
```

Requires authentication. Returns a `text/event-stream` response.

## Connection Lifecycle

1. **Connected**: Server sends a `connected` event with a `connectionId`
2. **Ping**: Server sends `ping` events every 15 seconds to keep the connection alive
3. **Events**: Real-time events are delivered as `message` events with JSON data
4. **Disconnect**: Client closes the connection; server cleans up automatically

## Event Format

Each event is a JSON object with a `type` field and contextual fields:

```json
{
  "type": "event-type",
  "agentId": "optional-agent-id",
  "data": { ... }
}
```

## Event Types

### Chat

Real-time message streaming and conversation events.

| Event | Description | Scope |
|-------|-------------|-------|
| `chat:message` | New message created (user or AI) | Per-Agent |
| `chat:token` | Streaming token chunk during AI response | Per-Agent |
| `chat:reasoning-token` | Streaming reasoning/thinking token chunk | Per-Agent |
| `chat:reasoning-done` | Reasoning/thinking block finished | Per-Agent |
| `chat:tool-call-start` | Tool call started | Per-Agent |
| `chat:tool-call` | Tool call arguments resolved | Per-Agent |
| `chat:tool-result` | Tool result received | Per-Agent |
| `chat:token-usage` | Live token-usage update for the turn | Per-Agent |
| `chat:done` | AI response finished | Per-Agent |
| `chat:cleared` | Conversation history cleared | Per-Agent |

### Reactions

| Event | Description | Scope |
|-------|-------------|-------|
| `reaction:added` | Reaction added to a message | Per-Agent |
| `reaction:removed` | Reaction removed from a message | Per-Agent |

### Tasks

| Event | Description | Scope |
|-------|-------------|-------|
| `task:status` | Task status changed (pending, in_progress, queued, etc.) | Broadcast |
| `task:done` | Task completed or failed | Broadcast |
| `task:deleted` | Task deleted | Broadcast |
| `task:todos` | Sub-agent updated its structured todo list | Broadcast |
| `task:token-usage` | Live token-usage update for a running task | Broadcast |
| `queue:update` | Queue/processing state changed (includes `processingStartedAt` timestamp when processing) | Broadcast |

### Mini-Apps

| Event | Description | Scope |
|-------|-------------|-------|
| `miniapp:created` | A mini-app was created | Broadcast |
| `miniapp:updated` | A mini-app was updated | Broadcast |
| `miniapp:deleted` | A mini-app was deleted | Broadcast |
| `miniapp:file-updated` | A mini-app file was changed | Broadcast |
| `miniapp:reload` | A mini-app requested a live reload | Broadcast |

### Memories

| Event | Description | Scope |
|-------|-------------|-------|
| `memory:created` | Memory created | Per-Agent |
| `memory:updated` | Memory updated | Per-Agent |
| `memory:deleted` | Memory deleted | Per-Agent |

### Compacting

| Event | Description | Scope |
|-------|-------------|-------|
| `compacting:start` | Compaction started | Per-Agent |
| `compacting:done` | Compaction completed (includes summary and memories extracted) | Per-Agent |
| `compacting:error` | Compaction failed (prevents infinite spinner in the UI) | Per-Agent |

### Agents

| Event | Description | Scope |
|-------|-------------|-------|
| `agent:error` | Agent processing error | Per-Agent |
| `agent:created` | New Agent created | Broadcast |
| `agent:updated` | Agent metadata changed (avatar, provider, etc.) | Broadcast |
| `agent:deleted` | Agent deleted | Broadcast |

### Providers

| Event | Description | Scope |
|-------|-------------|-------|
| `provider:created` | Provider added | Broadcast |
| `provider:updated` | Provider configuration changed | Broadcast |
| `provider:deleted` | Provider removed | Broadcast |

### MCP Servers

| Event | Description | Scope |
|-------|-------------|-------|
| `mcp-server:created` | MCP server added | Broadcast |
| `mcp-server:updated` | MCP server config changed or approved | Broadcast |
| `mcp-server:deleted` | MCP server removed | Broadcast |

### Contacts

| Event | Description | Scope |
|-------|-------------|-------|
| `contact:created` | Contact created | Broadcast |
| `contact:updated` | Contact updated | Broadcast |
| `contact:deleted` | Contact deleted | Broadcast |

### Cron Jobs

| Event | Description | Scope |
|-------|-------------|-------|
| `cron:triggered` | Cron job triggered | Broadcast |
| `cron:created` | Cron job created | Broadcast |
| `cron:updated` | Cron job updated | Broadcast |
| `cron:deleted` | Cron job deleted | Broadcast |

### Webhooks

| Event | Description | Scope |
|-------|-------------|-------|
| `webhook:created` | Webhook created | Broadcast |
| `webhook:updated` | Webhook updated | Broadcast |
| `webhook:deleted` | Webhook deleted | Broadcast |
| `webhook:triggered` | Webhook received a payload | Per-Agent |

### Channels

| Event | Description | Scope |
|-------|-------------|-------|
| `channel:created` | Channel created | Broadcast |
| `channel:updated` | Channel updated | Broadcast |
| `channel:deleted` | Channel deleted | Broadcast |
| `channel:message-received` | Message received from external platform | Per-Agent |
| `channel:message-sent` | Message sent to external platform | Per-Agent |
| `channel:user-pending` | New user pending approval | Broadcast |
| `channel:user-approved` | User approved | Broadcast |
| `channel:transferred` | Channel reassigned to a different Agent | Broadcast |

### Human Prompts

| Event | Description | Scope |
|-------|-------------|-------|
| `prompt:pending` | New prompt awaiting human response | Per-Agent |
| `prompt:answered` | Human responded to a prompt | Per-Agent |
| `prompt:expired` | A pending prompt timed out | Per-Agent |
| `prompt:secret-request` | Agent requested a secret via a secure-input popup | Per-Agent |
| `prompt:secret-resolved` | A secure-input request was answered or dismissed | Per-Agent |

### Notifications

| Event | Description | Scope |
|-------|-------------|-------|
| `notification:new` | New notification | Per-User |
| `notification:read` | Notification marked as read | Per-User |
| `notification:read-all` | All notifications marked as read | Per-User |
| `notification:deleted` | Notification deleted | Per-User |

### Quick Sessions

| Event | Description | Scope |
|-------|-------------|-------|
| `quick-session:closed` | Quick session closed | Per-Agent |

### Pending Email Sends

Emitted when an Agent queues an outbound email that needs human approval.

| Event | Description | Scope |
|-------|-------------|-------|
| `email:pending-created` | An outbound email is awaiting approval | Per-Agent |
| `email:pending-resolved` | A pending email was sent, failed, or rejected | Per-Agent |

### Plugins

| Event | Description | Scope |
|-------|-------------|-------|
| `plugin:installed` | Plugin installed | Broadcast |
| `plugin:uninstalled` | Plugin uninstalled | Broadcast |
| `plugin:updated` | Plugin updated to a new version | Broadcast |
| `plugin:reloaded` | Plugin reloaded | Broadcast |
| `plugin:enabled` | Plugin enabled | Broadcast |
| `plugin:disabled` | Plugin disabled | Broadcast |
| `plugin:configUpdated` | Plugin config changed | Broadcast |
| `plugin:autoDisabled` | Plugin auto-disabled due to errors | Broadcast |

### Settings

| Event | Description | Scope |
|-------|-------------|-------|
| `settings:hub-changed` | Hub configuration changed | Broadcast |
| `settings:defaults-updated` | Default models/services configuration changed | Broadcast |

### Platform updates

| Event | Description | Scope |
|-------|-------------|-------|
| `version:update-available` | New Hivekeep version available on the active channel (`{ channel, latestVersion, releaseUrl, publishedAt }`) | Broadcast |
| `update:progress` | Self-update step progress (`{ runId, step, status: 'running' \| 'done' \| 'error', message }`) | Broadcast |
| `update:finished` | Self-update outcome (`{ runId, status: 'success' \| 'failed' \| 'rolled-back', version?, error? }`). `success`/`rolled-back` are emitted after the restart — clients should also poll `GET /api/version-check/last-update` while SSE reconnects | Broadcast |

### System

| Event | Description | Scope |
|-------|-------------|-------|
| `log:entry` | Platform log entry | Broadcast |
| `card:updated` | A live plugin card was updated | Broadcast |

### Other resource events

Most CRUD resources also broadcast `created` / `updated` / `deleted` events so any open tab stays in sync. Beyond the families above, these include: `agent` (plus `agent:active-project`, `agent:read`), `provider`, `mcp-server`, `contact`, `cron`, `webhook`, `memory`, `custom-tool`, `toolbox`, `tool-domain`, `email-account`, `connected-account`, `project`, `project-tag`, and `ticket` (plus `ticket:comment-added` / `comment-updated` / `comment-deleted`). The canonical, exhaustive list of event names lives in `src/server/sse/types.ts`.

## Delivery Scope

Events are delivered based on scope:

- **Broadcast**: Sent to all connected clients (provider changes, MCP updates, settings)
- **Per-Agent**: Sent to clients viewing a specific Agent (chat, memories, compacting, reactions)
- **Per-User**: Sent to a specific user's connections (notifications)

## Client Usage

```javascript
const evtSource = new EventSource('/api/sse', {
  withCredentials: true
})

evtSource.onmessage = (event) => {
  const data = JSON.parse(event.data)

  switch (data.type) {
    case 'chat:token':
      // Append streaming token to UI
      appendToken(data.data.token)
      break
    case 'chat:done':
      // Finalize message display
      finalizeMessage()
      break
    case 'miniapp:updated':
      // Refresh mini-app data
      refreshMiniApp(data.data.app)
      break
  }
}

evtSource.onerror = () => {
  // EventSource auto-reconnects
  console.log('SSE connection lost, reconnecting...')
}
```
