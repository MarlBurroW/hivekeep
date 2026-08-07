# Hivekeep API Contracts

> ⚠️ **Partially outdated.** This document describes the REST contracts as envisioned before the providers/plugins/images refactor. Routes that have changed since:
> - `POST/PATCH /api/providers`: `families[]` payload instead of `family`, multiple capabilities per row (`capabilities[]`)
> - `GET /api/providers/:id`: new (returns `safeConfig` for pre-filling the edit form)
> - `GET /api/providers/:id/models`: new (browser modal)
> - `POST /api/providers/:id/test`: now accepts an optional `{ config: {...} }` body to test a partial config without re-encoding the secrets
> - Image tools (`generate_image`, `list_image_models`, new `describe_image_model`): different payload (`imageUrls[]`, `params`, `maxImageInputs`)
>
> The **route code** in `src/server/routes/` is authoritative. When a contract here contradicts the route, it's this file that is outdated. Use it as a reference of intent, not as a strict spec.

All routes return JSON. Errors follow the standard format:

```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable description" } }
```

Authentication: HTTP-only cookie managed by Better Auth, verified by middleware on all `/api/*` routes (except `/api/auth/*`).

---

## Auth

### `POST /api/auth/register`

Created automatically by Better Auth.

```typescript
// Request
{ name: string, email: string, password: string }

// Response 200
{ user: { id: string, name: string, email: string }, session: { token: string } }
```

### `POST /api/auth/login`

```typescript
// Request
{ email: string, password: string }

// Response 200
{ user: { id: string, name: string, email: string }, session: { token: string } }
```

### `POST /api/auth/logout`

```typescript
// Response 200
{ success: true }
```

---

## Onboarding

### `GET /api/onboarding/status`

Checks whether the initial onboarding has been completed. **`completed` is strictly `hasAdmin`.** The onboarding redesign (Phase 1) decoupled `completed` from the provider configuration. The `hasLlm` / `hasEmbedding` fields are still returned for informational purposes (used by the dashboard setup checklist) but no longer gate access to the app.

```typescript
// Response 200
{ completed: boolean, hasAdmin: boolean, hasLlm: boolean, hasEmbedding: boolean }
```

---

## Account

### `GET /api/me`

```typescript
// Response 200
{
  id: string
  email: string
  firstName: string
  lastName: string
  pseudonym: string
  language: string             // UI language: a code from SUPPORTED_LANGUAGES
  agentLanguage: string | null // language spoken by the Agents (AGENT_LANGUAGES code); null = follows `language`
  role: 'admin' | 'user'
  avatarUrl: string | null
}
```

### `PATCH /api/me`

```typescript
// Request (all fields optional)
{
  firstName?: string
  lastName?: string
  pseudonym?: string
  language?: string             // a code from SUPPORTED_LANGUAGES
  agentLanguage?: string | null // a code from AGENT_LANGUAGES; null = follow the UI language
  password?: { current: string, new: string }
}

// Response 200
{ ...same as GET /api/me }

// Error 400 (one or more invalid fields)
{ error: { code: "VALIDATION_ERROR", message: "..." } }
```

> **Name/pseudonym trio validation** (rules shared via `src/shared/profile-validation.ts`, common to `PATCH /api/me` and `POST /api/onboarding/profile`): `firstName` / `lastName` <= 100 characters, `pseudonym` between 2 and 30 characters and limited to `[a-zA-Z0-9_-]`. Values are trimmed before writing. `PATCH /api/me` is partial: no field is required, but any field present and non-empty is validated with these same rules (a single-character `pseudonym` is therefore rejected here too). Signup (`POST /api/onboarding/profile`) additionally requires non-empty `firstName` + `pseudonym`.

### `POST /api/me/avatar`

Multipart/form-data upload.

```typescript
// Request: FormData with a "file" field

// Response 200
{ avatarUrl: string }
```

---

## Providers

### `GET /api/providers`

```typescript
// Response 200
{
  providers: Array<{
    id: string
    name: string
    type: 'anthropic' | 'openai' | 'gemini' | 'voyage_ai'
    capabilities: ('llm' | 'embedding' | 'image' | 'search')[]
    isValid: boolean
    createdAt: number
  }>
}
```

### `POST /api/providers`

```typescript
// Request
{
  name: string
  type: 'anthropic' | 'openai' | 'gemini' | 'voyage_ai'
  config: { apiKey: string, baseUrl?: string }
}

// Response 201
{ provider: { id: string, name: string, type: string, capabilities: string[], isValid: boolean } }
```

> The server tests the connection and detects the capabilities before returning.

### `PATCH /api/providers/:id`

```typescript
// Request (all optional)
{ name?: string, config?: { apiKey?: string, baseUrl?: string } }

// Response 200
{ provider: { ...same shape } }
```

### `DELETE /api/providers/:id`

```typescript
// Response 200
{ success: true }

// Error 409 if it's the last provider covering a required capability (llm or embedding)
{ error: { code: "PROVIDER_REQUIRED", message: "..." } }
```

### `POST /api/providers/:id/test`

Tests the connection to the provider.

```typescript
// Response 200
{ valid: boolean, capabilities: string[], error?: string }
```

### `POST /api/providers/oauth/:type/start`

Begins the CLI-free OAuth sign-in (PKCE public-client flow) for a subscription
provider that supports it (`anthropic-oauth`, `openai-codex`). The server mints a code verifier
+ challenge, holds the verifier in memory keyed by `state`, and returns the
browser authorize URL.

```typescript
// Response 200
{ authUrl: string, state: string }

// Error 400 if the type does not support in-app sign-in
{ error: { code: "NOT_OAUTH_SIGNIN", message: "..." } }
```

### `POST /api/providers/oauth/:type/complete`

Finishes the flow: exchanges the pasted authorization code (the input may be a
bare code, Anthropic's `<code>#<state>` fragment, or a full redirect URL) for
tokens, stores them in the encrypted vault, and creates the provider (or
re-authenticates an existing one when `providerId` is supplied).

```typescript
// Request
{ state: string, code: string, name?: string, providerId?: string }

// Response 201 (create) / 200 (re-auth)
{ provider: { id: string, slug: string, name: string, type: string, capabilities: string[], isValid: boolean } }

// Errors 400: INVALID_STATE | INVALID_CODE | EXCHANGE_FAILED | NO_REFRESH_TOKEN
{ error: { code: string, message: string } }
```

### `GET /api/providers/models`

Lists all available models across all configured providers.

```typescript
// Response 200
{
  models: Array<{
    id: string              // e.g. 'claude-sonnet-4-20250514'
    name: string            // e.g. 'Claude Sonnet 4'
    providerId: string
    providerType: string
    capability: 'llm' | 'embedding' | 'image' | 'search'
    supportsImageInput?: boolean   // llm only: tri-state (absent = unknown)
    supportsPdfInput?: boolean     // llm only: tri-state (absent = unknown)
    maxImageInputs?: number        // image only
    contextWindow?: number
    maxOutput?: number
    // llm only: reasoning support after registry enrichment.
    // Absent = not a reasoning model; efforts: [] = on/off toggle
    // without granularity. Drives the client-side effort selectors.
    thinking?: {
      efforts: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
      note?: string
    }
  }>
}
```

---

## Agents

### `GET /api/agents`

```typescript
// Response 200
{
  agents: Array<{
    id: string
    name: string
    role: string
    avatarUrl: string | null
    model: string
    createdAt: number
    // No character/expertise here (too large for the list)
  }>
}
```

### `GET /api/agents/:id`

```typescript
// Response 200
{
  id: string
  name: string
  role: string
  avatarUrl: string | null
  character: string
  expertise: string
  model: string
  workspacePath: string
  mcpServers: Array<{ id: string, name: string }>
  queueSize: number          // number of pending messages
  isProcessing: boolean      // currently processing a message
  createdAt: number
}
```

### `POST /api/agents`

```typescript
// Request
{
  name: string
  role: string
  character: string
  expertise: string
  model: string
  mcpServerIds?: string[]
  avatar?: 'upload' | 'generate' | 'prompt'
  avatarPrompt?: string       // if avatar === 'prompt'
}

// If avatar === 'upload', use POST /api/agents/:id/avatar after creation

// Response 201
{ agent: { ...same as GET /api/agents/:id } }
```

### `PATCH /api/agents/:id`

```typescript
// Request (all optional)
{
  name?: string
  role?: string
  character?: string
  expertise?: string
  model?: string
  mcpServerIds?: string[]
  toolboxIds?: string[] | null
  // Individual grants (in addition to toolboxes): manual additions + approved
  // request_tool_access requests. [] or null clears everything.
  extraToolNames?: string[] | null
}

// Response 200
{ agent: { ...same shape } }
```

### `DELETE /api/agents/:id`

```typescript
// Response 200
{ success: true }
```

### `POST /api/agents/:id/avatar`

Avatar upload or generation.

```typescript
// Upload mode: FormData with a "file" field
// Generate mode: { mode: 'generate' }
// Prompt mode: { mode: 'prompt', prompt: string }

// Response 200
{ avatarUrl: string }
```

### `GET /api/agents/:id/context-preview`

Rebuilds and returns the full LLM context exactly as it would be sent to the model.
Useful for debugging and transparency. Accepts optional query params for tasks and quick sessions.

```typescript
// Optional query params:
// ?taskId={string}     - context of a specific task
// ?sessionId={string}  - context of a quick session

// Response 200
{
  systemPrompt: string           // Full system prompt (with tools appended)
  compactingSummary: string | null // Compacting summary (null if no compacting)
  rawPayload: {
    system: string
    messages: Array<{
      role: string
      content: string | null
      hasToolCalls: boolean
      createdAt: number | null
    }>
    tools: Array<{
      name: string
      description: string
      parameters: Record<string, unknown> | null
    }>
  }
  tokenEstimate: {
    systemPrompt: number
    summary: number
    messages: number
    tools: number
    total: number
  }
  contextWindow: number          // Max context size of the model (in tokens)
  messageCount: number
  generatedAt: number
}
```


## Messages / Chat

### `POST /api/agents/:id/messages`

Sends a message to an Agent. Triggers processing and SSE streaming of the response.

```typescript
// Request
{
  content: string
  fileIds?: string[]        // IDs of already-uploaded files
  clientMessageId?: string  // Optimistic reconciliation token (≤100 chars, NOT the PK).
                            // Re-emitted as-is in the chat:message SSE event for the
                            // user message: the emitting client reconciles its
                            // optimistic bubble, other devices add it.
}

// Response 202
{ messageId: string, queuePosition: number }   // messageId = queue item id, ≠ message PK
```

> The Agent's response arrives via SSE (not in this HTTP response).
> The user message itself is also broadcast in real time via `chat:message`
> (multi-device / multi-member sync), with `clientMessageId` for reconciliation.

### `GET /api/agents/:id/messages`

Paginated message history.

```typescript
// Query params: ?before={messageId}&limit={number, default 50}

// Response 200
{
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    sourceType: 'user' | 'agent' | 'task' | 'cron' | 'system'
    sourceId: string | null
    sourceName: string | null   // pseudonym, agent name, task name, cron name
    isRedacted: boolean
    tokenUsage: { inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number, stepCount?: number } | null
    files: Array<{ id: string, name: string, mimeType: string, url: string }>
    createdAt: number
  }>
  hasMore: boolean
}
```

### `GET /api/agents/:id/tools`

The Agent's RESOLVED toolset: the exact set of tools a turn would receive (native + plugins + MCP + customs, after toolbox filtering). `?quick=1` returns the quick-session variant (without the tools excluded in a session: tasks, crons, inter-agent...). Feeds the composer's tools badge and its listing modal (the client groups by domain via `/api/tools/domains`).

```typescript
// Response 200
{ tools: Array<{ name: string, description: string }> }  // sorted by name
```

### `POST /api/agents/:id/messages/inject`

Injects a message into the ongoing conversation. If the Agent is currently streaming a response, the stream is interrupted (the partial response is saved) and the injected message is queued at high priority. Used by the `/btw` command and the promotion of messages from the queue.

```typescript
// Request
{
  content: string
  queueItemId?: string    // If promotion from the queue, removes the original item
}

// Response 202
{
  messageId: string
  queuePosition: number
  injected: boolean       // true if an active stream was interrupted
}
```

### `DELETE /api/agents/:id/messages/:messageId`

Deletes a single message from the main conversation (context savings). The row carries its complete step (tool calls + results in the `toolCalls` JSON), so the LLM history stays well-formed. Refused while a turn is in progress (409 `AGENT_BUSY`). Cascade cleanup: attached files deleted, `human_prompts`/`memories` references nulled, compaction summary boundaries repaired (the time cutoff stays intact). Emits `chat:messages-deleted`.

```typescript
// Response 200
{ ok: true, deletedCount: 1 }
```

### `POST /api/agents/:id/messages/rewind`

Rewind: the target message becomes the most recent one. Everything after it (including hidden context messages) is deleted, and the compaction summaries covering the deleted zone are removed. Refused during an in-progress turn (409). Emits `chat:messages-deleted` with the list of ids.

```typescript
// Request
{ messageId: string }

// Response 200
{ ok: true, deletedCount: number }
```

---

## Tasks

### `GET /api/tasks`

Lists all ongoing tasks.

```typescript
// Query params: ?status={pending|in_progress|paused|completed|failed|cancelled}&agentId={string}

// Response 200
{
  tasks: Array<{
    id: string
    parentAgentId: string
    parentAgentName: string
    description: string
    status: 'pending' | 'in_progress' | 'paused' | 'completed' | 'failed' | 'cancelled'
    mode: 'await' | 'async'
    depth: number
    createdAt: number
    updatedAt: number
  }>
}
```

### `GET /api/tasks/:id`

Details of a task with its messages.

```typescript
// Response 200
{
  task: { ...same as list item + result: string | null, error: string | null }
  messages: Array<{ ...same as message shape }>
}
```

### `POST /api/tasks/:id/cancel`

```typescript
// Response 200
{ success: true }
```

### `POST /api/tasks/:id/pause`

Pauses a running task. The task keeps its state and can be resumed later.

```typescript
// Response 200
{ success: true }

// Response 409: task not running
{ error: { code: 'TASK_NOT_PAUSABLE', message: 'Task is not currently running' } }
```

### `POST /api/tasks/:id/resume`

Resumes a paused task, with an optional message injected into the context.

```typescript
// Request (optional)
{ message?: string }

// Response 200
{ success: true }

// Response 409: task not paused
{ error: { code: 'TASK_NOT_PAUSED', message: 'Task is not paused' } }
```

### `POST /api/tasks/:id/inject`

Injects a message into a running task. If the task is streaming, the stream is interrupted and restarted with the additional message.

```typescript
// Request
{ content: string }

// Response 202
{ success: true, injected: boolean }

// Response 400: empty content
{ error: { code: 'EMPTY_CONTENT', message: 'Message content is required' } }

// Response 409: injection failed
{ error: { code: 'INJECT_FAILED', message: string } }
```

---

## Crons

### `GET /api/crons`

```typescript
// Query params: ?agentId={string}

// Response 200
{
  crons: Array<{
    id: string
    agentId: string
    agentName: string
    name: string
    schedule: string
    taskDescription: string
    targetAgentId: string | null
    model: string | null
    toolboxIds: string[]        // toolbox IDs; [] = full native surface ('all')
    isActive: boolean
    requiresApproval: boolean
    lastTriggeredAt: number | null
    createdAt: number
  }>
}
```

### `POST /api/crons`

```typescript
// Request
{
  agentId: string
  name: string
  schedule: string
  taskDescription: string
  targetAgentId?: string
  model?: string
  toolboxIds?: string[]         // native toolset of the spawned tasks; omitted = 'all'
}

// Response 201
{ cron: { ...same shape } }
```

### `PATCH /api/crons/:id`

```typescript
// Request (all optional)
{
  name?: string
  schedule?: string
  taskDescription?: string
  targetAgentId?: string
  model?: string
  isActive?: boolean
  toolboxIds?: string[] | null  // [] or null clears the restriction (back to 'all')
}

// Response 200
{ cron: { ...same shape } }
```

### `DELETE /api/crons/:id`

```typescript
// Response 200
{ success: true }
```

### `POST /api/crons/:id/approve`

Approves a cron created by an Agent (which requires validation).

```typescript
// Response 200
{ cron: { ...same shape, requiresApproval: false, isActive: true } }
```

---

## MCP Servers

### `GET /api/mcp-servers`

```typescript
// Response 200
{
  servers: Array<{
    id: string
    name: string
    command: string
    args: string[]
    env: Record<string, string> | null
    createdAt: number
  }>
}
```

### `POST /api/mcp-servers`

```typescript
// Request
{ name: string, command: string, args?: string[], env?: Record<string, string> }

// Response 201
{ server: { ...same shape } }
```

### `DELETE /api/mcp-servers/:id`

```typescript
// Response 200
{ success: true }
```

---

## Custom Tools & Tool Domains

**Global** custom tools (scripts authored via the UI or the Agents) and dynamic domains. See `schema.md`.

### `GET /api/tools/catalog`
Agnostic catalog of all grantable tools (native / plugin / mcp / custom). Custom entries are global (`custom_<slug>`, `domain` = their `domain_slug`, `enabled`).

### `GET /api/tools/domains`
Map `name → domain` (registry + `custom_<slug> → domain_slug`), used to color the tool-call badges.

### `GET /api/tools/domain-meta`
`{ domains: [{ slug, icon, bg, text, border, builtin, labelKey, label }] }`: rendering metadata (built-in + custom) hydrated by the client.

### `GET /api/tools/custom-tool-names`
`{ "custom_<slug>": { "name": "<localized name>", "hasRenderer": <bool> } }`: per custom tool, the display name resolved for the current user's UI language (`user_profiles.language`) + presence of a result renderer (`renderer.tsx`/`.jsx`/`.js` file, detected on disk). UI-only (best-effort): the client hydrates it at boot to show a human name in the chat tool-calls instead of the raw `custom_<slug>`, and to decide whether to load the renderer.

### `GET|POST|PATCH|DELETE /api/tool-domains[/:slug]`
CRUD for tool domains. Built-in are read-only; deletion is blocked if the domain is in use (`TOOL_DOMAIN_IN_USE`).

### `GET|POST|PATCH|DELETE /api/custom-tools[/:slug]`
CRUD for global custom tools. Created via the UI → `created_by='user'`, active immediately. POST/PATCH accept `translations` (localized object `{ "<locale>": { name?, description?, parameters?: { "<param>": { label?, description? } } } }`); GET returns it (parsed). UI-only: translations never affect the tool definition sent to the LLM.

### `GET /api/custom-tools/:slug/file?path=…` · `PUT /api/custom-tools/:slug/files`
Read / write a file in the tool's managed folder (`{ path, content }`).

### `GET /api/custom-tools/:slug/renderer.js`
Server-side bundled ESM module of the tool's optional **result renderer** (default export = React component). Source: `renderer.tsx` (fallback `renderer.jsx`/`renderer.js`) in the tool's folder, bundled via Bun (classic JSX, react/react-dom mapped onto the host's React instance `window.__HIVEKEEP_REACT__`). The client loads it on the fly (`React.lazy(import(url))`) in the tool-call detail view. Server-side memory cache (key slug + mtime); response with `ETag` (`304` revalidation). `404 NO_RENDERER` if the tool has no renderer; `500` (module that throws on load, with the build message) on bundling failure: the client then falls back to the JSON display via its ErrorBoundary. Authenticated like all `/api/*` routes. Host context (full privileges, no isolation): acceptable because custom tools are trusted (self-hosted) and the renderer is only for display.

### `POST /api/custom-tools/:slug/setup`
Installs the dependencies (`requirements.txt` → `.venv` + pip; `package.json` → `bun install`).

### `POST /api/custom-tools/:slug/test`
Runs the tool with test args (`{ args }`) → `{ success, output, error, exitCode, executionTime }`.

---

## Vault

Agents only access secrets through the `{{secret:KEY}}` **placeholder** (substituted at tool execution time, see `vault-placeholders.md`). The routes below serve the admin UI.

### `GET /api/vault`

Lists the secrets (keys only, never the values). `lastUsedAt` is stamped on every placeholder expansion.

```typescript
// Response 200
{
  secrets: Array<{
    id: string
    key: string
    lastUsedAt: number | null
    createdAt: number
    updatedAt: number
  }>
}
```

### Per-secret scoping (entries)

`POST /api/vault/entries` and `PATCH /api/vault/entries/:id` accept two optional fields, returned by `GET /api/vault/entries`:

```typescript
{
  allowedTools?: string[] | null  // tools allowed to expand this secret (null = all)
  allowedHosts?: string[] | null  // hosts allowed for URL-bearing tools, wildcard *.domain supported (null = all)
}
```

An out-of-scope expansion is refused before execution (fail-closed) and emits `vault:secret-used` with `violation: { type: 'tool-scope' | 'host-scope' }` on the event bus.

### `POST /api/vault`

```typescript
// Request
{ key: string, value: string }

// Response 201
{ secret: { id: string, key: string, createdAt: number } }
```

### `PATCH /api/vault/:id`

```typescript
// Request
{ key?: string, value?: string }

// Response 200
{ secret: { id: string, key: string, updatedAt: number } }
```

### `DELETE /api/vault/:id`

```typescript
// Response 200
{ success: true }
```

---

## Files

### `POST /api/files/upload`

Multipart/form-data upload.

```typescript
// Request: FormData with a "file" field + "agentId"

// Response 201
{ file: { id: string, name: string, mimeType: string, size: number, url: string } }
```

---

## Workspace files (Files section)

Routes of the **Files** section (workspace browser/editor, see `files.md`). Mounted under `/api/agents/:agentId/workspace`; `:agentId` accepts an id or a slug. Agent not found → `404 AGENT_NOT_FOUND`. All `path` values are **relative to the workspace root** and strictly confined (no absolute path, no `..`, no symlink escape, leaf included).

Common error codes: `AGENT_NOT_FOUND` (404), `PATH_FORBIDDEN` (400), `FILE_NOT_FOUND` (404), `IS_DIRECTORY` (400), `NOT_A_DIRECTORY` (400), `FILE_TOO_LARGE` (413), `INVALID_NAME` (400), `DEST_EXISTS` (409), `CONFLICT` (409), `COPY_TOO_LARGE` (413).

### `GET /api/agents/:agentId/workspace/ls`

Lists a folder (lazy: never a recursive tree).

```typescript
// Query params: ?path=docs/reports        (default: root "")

// Response 200
{
  path: string,
  entries: Array<{
    name: string,
    path: string,              // relative to the root
    type: 'file' | 'dir',
    size: number,              // 0 for dirs
    modifiedAt: number,        // Unix ms
    isSymlink: boolean
  }>
}
// Workspace not created yet → 200 { path: "", entries: [] } (lazy creation)

// Error 404 FILE_NOT_FOUND (nonexistent subfolder) · 400 NOT_A_DIRECTORY · 400 PATH_FORBIDDEN
```

> Server-side sort: folders first, then case-insensitive alphabetical. Everything is listed, dotfiles included (no ignore filter).

### `GET /api/agents/:agentId/workspace/file`

Reads a file: metadata + text content.

```typescript
// Query params: ?path=docs/report.md

// Response 200
{
  path: string,
  name: string,
  size: number,
  modifiedAt: number,          // ← to be returned in the PUT (optimistic concurrency)
  mimeType: string,            // guessed by extension
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'too-large',
  content: string | null       // null unless kind === 'text'
}

// Error 404 FILE_NOT_FOUND · 400 IS_DIRECTORY · 400 PATH_FORBIDDEN
```

> `kind: 'too-large'` = text file beyond `workspaceFiles.maxEditableSizeMb` (download only). `binary` = null-byte detected in the first 8 KB.

### `PUT /api/agents/:agentId/workspace/file`

Writes a text file (creates the file and its parent folders if missing). Emits `workspace:changed`.

```typescript
// Request
{
  path: string,
  content: string,             // text only
  baseModifiedAt?: number,     // mtime read by the client; absent = forced overwrite
  createOnly?: boolean         // true = strict creation ("New file")
}

// Response 200
{ path: string, size: number, modifiedAt: number }

// Error 409: optimistic concurrency: the disk mtime changed since the read
// (typically: the agent wrote the same file in the meantime)
{ error: { code: 'CONFLICT', message: '...' } }
// Error 409: createOnly and the path already exists
{ error: { code: 'DEST_EXISTS', message: '...' } }
// Error 413 FILE_TOO_LARGE · 400 PATH_FORBIDDEN · 400 INVALID_NAME · 400 IS_DIRECTORY
```

### `GET /api/agents/:agentId/workspace/raw`

Streams the raw bytes (download / image & PDF viewers).

```typescript
// Query params: ?path=images/chart.png&inline=1

// Response 200: binary stream
//   Content-Type: <mime>                   (guessed by extension)
//   Content-Length: <size>
//   X-Content-Type-Options: nosniff        (always)
//   Content-Disposition: attachment (default) | inline (if inline=1 AND MIME in the allowlist)

// Error 404 FILE_NOT_FOUND · 400 IS_DIRECTORY · 400 PATH_FORBIDDEN
```

> **Inline allowlist**: `image/*` **except `image/svg+xml` and any `image/*+xml`** (an inline SVG would execute its scripts in the authenticated origin), `application/pdf`, `text/plain`. Everything else, including SVG and `text/html`, is served as `attachment`. Inline responses additionally carry `Content-Security-Policy: default-src 'none'; sandbox`.

### `POST /api/agents/:agentId/workspace/mkdir`

```typescript
// Request
{ path: string }

// Response 200
{ path: string }

// Error 409 DEST_EXISTS · 400 INVALID_NAME · 400 PATH_FORBIDDEN
```

### `POST /api/agents/:agentId/workspace/move`

Rename / move (rename = move within the same folder). Cross-workspace via `fromAgentId`.

```typescript
// Request
{
  from: string,
  to: string,
  fromAgentId?: string         // id or slug ≠ :agentId = cross-workspace move (cut/paste).
                               // `from` is validated against the root of fromAgentId, `to` against the root of :agentId
}

// Response 200
{ from: string, to: string }

// Error 409 DEST_EXISTS · 404 FILE_NOT_FOUND · 400 INVALID_NAME · 400 PATH_FORBIDDEN
```

### `POST /api/agents/:agentId/workspace/copy`

Same contract as `move`; collision resolved by automatic suffix ` (copy)` / ` (copy 2)` …

```typescript
// Request
{ from: string, to: string, fromAgentId?: string }

// Response 200
{ from: string, to: string }   // to = final path, suffixed if applicable

// Error 413: recursive copy budget exceeded (bytes workspaceFiles.maxCopySizeMb
// OR entries workspaceFiles.maxCopyEntries); streamed copy, abort in progress, partial copy cleaned up
{ error: { code: 'COPY_TOO_LARGE', message: '...' } }
// Error 404 FILE_NOT_FOUND · 400 INVALID_NAME · 400 PATH_FORBIDDEN
```

### `DELETE /api/agents/:agentId/workspace/file`

Deletes a file OR a folder (recursive).

```typescript
// Query params: ?path=docs/old

// Response 200
{ deleted: true, path: string }

// Error 404 FILE_NOT_FOUND · 400 PATH_FORBIDDEN
```

### `POST /api/agents/:agentId/workspace/upload`

Multipart upload into a workspace folder.

```typescript
// Request: multipart/form-data
//   file: File          (repeatable: multi-upload)
//   path: string        (destination folder, default root "")

// Response 201: partial failure possible: accepted files are written,
// rejected ones are listed in `errors`
{
  files: Array<{ path: string, size: number, modifiedAt: number }>,
  errors: Array<{ name: string, code: string }>    // e.g. FILE_TOO_LARGE, INVALID_NAME
}

// Error 400 NOT_A_DIRECTORY · 400 PATH_FORBIDDEN · 400 VALIDATION_ERROR (no file)
```

> The multipart filename is controlled by the client: only its **basename** survives (any embedded path is stripped), and the name is validated (`INVALID_NAME`). Collision: automatic suffix ` (copy N)`: an upload never silently overwrites. Cap `workspaceFiles.maxUploadSizeMb` per file.

### `GET /api/agents/:agentId/workspace/search`

Searches files by name/path (case-insensitive substring). Serves the chat `@` palette and quick-open (Ctrl+P).

```typescript
// Query params: ?q=report&limit=20      (limit default 20, cap workspaceFiles.searchMaxResults)

// Response 200
{ hits: Array<{ path: string, name: string, size: number, modifiedAt: number }> }
```

> Server-side walk bounded by `workspaceFiles.searchMaxEntries`; never descends into a symlinked directory; ignores heavy folders (`node_modules`, `.git`, …).

### `POST /api/agents/:agentId/workspace/resolve-paths`

Batched existence check, used by the clickable path chips in chat.

```typescript
// Request
{ paths: string[] }            // ≤ 50 (truncated beyond that)

// Response 200
{ existing: string[] }         // subset that exists (files only)
```

> Invalid paths (traversal) are silently absent from `existing`: no error, they are regex candidates.

### `POST /api/file-storage/from-workspace`

Share: snapshot of a workspace file into file-storage (same semantics as the `store_file` tool: frozen copy, not a live link).

```typescript
// Request
{
  agentId: string,             // id or slug
  path: string,                // relative to the workspace
  name?: string,               // default: basename
  description?: string,
  isPublic?: boolean,          // default true
  password?: string,
  expiresIn?: number,          // MINUTES: same unit as POST /api/file-storage and store_file
  readAndBurn?: boolean
}

// Response 201
{
  file: {
    id: string, name: string, originalName: string, mimeType: string, size: number,
    url: string,               // share URL {publicUrl}/s/{token}
    isPublic: boolean, hasPassword: boolean, readAndBurn: boolean,
    expiresAt: number | null
  }
}

// Error 404 AGENT_NOT_FOUND · 404 FILE_NOT_FOUND · 400 PATH_FORBIDDEN
// Error 413 FILE_TOO_LARGE (file-storage limit FILE_STORAGE_MAX_SIZE)
```

> Share is **agent-scoped**: a stored file is owned by an agent, so the Files UI
> only offers "Share" on agent workspaces (not on mini-app dirs or FS folders).

### Generalized workspace sources

The Files **page** browses three kinds of source: an agent workspace, a mini-app
source directory, or a user-added FS folder. They share
one route family, mounted under `/api/workspace/:sourceType/:sourceId`, mirroring
the agent routes above (`ls`, `file`, `raw`, `PUT file`, `mkdir`, `move`, `copy`,
`DELETE file`, `upload`, `search`). `:sourceType` is `agent` | `miniapp` | `folder`.
The containment/confinement guarantees are identical for every source.

```typescript
// GET /api/workspace/agent/:id/ls?path=docs
// GET /api/workspace/folder/:id/file?path=notes.md
// GET /api/workspace/miniapp/:id/ls?path=src
// PUT /api/workspace/folder/:id/file        // body identical to the agent PUT
// move/copy accept an optional `fromSource: { type, id }` for cross-source paste

// Error 404 SOURCE_NOT_FOUND · 400 SOURCE_INVALID
//   (plus the same PATH_FORBIDDEN / FILE_NOT_FOUND / CONFLICT / … as the agent routes)
```

### `GET /api/workspace/:sourceType/:sourceId/export-pdf`

Renders an HTML file (`text/html` only) to a PDF and streams it back as a
download (`Content-Disposition: attachment`). The server loads the file via
`file://` with Playwright, so relative sibling assets (images/CSS on disk) resolve
as they would in a real browser.

```typescript
// GET /api/workspace/agent/:id/export-pdf?path=reports/q3.html
// Response 200: application/pdf (attachment; filename = <base>.pdf)

// Error 400 NOT_HTML (path is not an HTML file)
//   · 503 PDF_EXPORT_FAILED (headless browser disabled / Chromium missing / render error)
//   · plus the same SOURCE_* / PATH_FORBIDDEN / FILE_NOT_FOUND as the browse routes
```

### `GET /api/workspace/:sourceType/:sourceId/git-status`

Lightweight git badge for any source whose root is a git repo (a git-backed
workspace, folder or mini-app dir).

```typescript
// Response 200
{ gitStatus: { branch: string, dirtyCount: number, ahead?: number, behind?: number } | null }
// gitStatus is null when the root is not a git repository.
```

### `GET /api/workspace/:sourceType/:sourceId/git-changes`

Working-tree change list (porcelain) for the changed-files panel opened from the
git badge. `core.quotepath=false` keeps UTF-8 paths literal.

```typescript
// Response 200
{ changes: Array<{ path: string, status: string }> }
// status is the two-letter porcelain code (e.g. "M", "??", "A", "D", "R").
// changes is [] when the source root is not a git work tree.
```

### `GET /api/workspace/:sourceType/:sourceId/git-diff`

Unified working-tree diff of a single file vs `HEAD` (or vs empty for an
untracked file), for the in-editor Diff toggle. The `?path=` is re-confined to
the source root before reaching git.

```typescript
// Query: ?path=src/main.ts
// Response 200
{ diff: string, isRepo: boolean }
// isRepo is false when the source root is not a git work tree (diff is "").
// diff is "" when the tracked file has no changes vs HEAD.
```

### `GET/POST/DELETE /api/workspace-folders`

CRUD for the user-added FS folders shown in the Files selector. Open to every
authenticated user (same access as agent workspaces). The path is canonicalized
(realpath) and validated on create, and re-validated on every browse.

```typescript
// GET  /api/workspace-folders → { folders: Array<{ id, label, path, createdAt }> }
// POST /api/workspace-folders   { label: string, path: string }   // path must be ABSOLUTE
//   → 201 { folder: { id, label, path, createdAt } }
//   Error 400 INVALID_LABEL · INVALID_PATH (missing/relative) · NOT_A_DIRECTORY · PATH_BLOCKED
// DELETE /api/workspace-folders/:id → { success: true } · 404 NOT_FOUND
```

---

## Memories (management via UI)

### `GET /api/agents/:id/memories`

```typescript
// Query params: ?category={fact|preference|decision|knowledge}&subject={string}&limit={number}

// Response 200
{
  memories: Array<{
    id: string
    content: string
    category: 'fact' | 'preference' | 'decision' | 'knowledge'
    subject: string | null
    sourceChannel: 'automatic' | 'explicit'
    createdAt: number
    updatedAt: number
  }>
}
```

### `DELETE /api/agents/:id/memories/:memoryId`

```typescript
// Response 200
{ success: true }
```

---

## Contacts (management via UI)

### `GET /api/contacts`

Admin list of contacts with identifiers, nicknames, platform ids and notes.
Supports optional server-side search + pagination. With no `limit`, returns the
full list (the contact-picker callers rely on that shape); `total` and `hasMore`
are always present.

```typescript
// Query params (all optional):
//   ?search={string}   matches name / nickname / identifier / platform id / note
//   &limit={number}    page size (1-200); omit for the full list
//   &offset={number}   page offset (default 0); ignored without limit
// Ordered newest-first when limit or search is provided.

// Response 200
{
  contacts: Array<ContactWithDetails>  // see ContactCard data shape
  total: number                        // size of the filtered set (before paging)
  hasMore: boolean
}
```

---

## Compacting (management via UI)

### `POST /api/agents/:id/compacting/purge`

Resets the compacting (deletes the active snapshot).

```typescript
// Response 200
{ success: true }
```

### `GET /api/agents/:id/compacting/snapshots`

Lists the snapshots for rollback.

```typescript
// Response 200
{
  snapshots: Array<{
    id: string
    messagesUpToId: string
    isActive: boolean
    createdAt: number
  }>
}
```

### `POST /api/agents/:id/compacting/rollback`

```typescript
// Request
{ snapshotId: string }

// Response 200
{ success: true }
```

---

## Settings

Admin routes for the platform's global settings (admin only).

### `GET /api/settings/global-prompt`

```typescript
// Response 200
{ globalPrompt: string }
```

### `PUT /api/settings/global-prompt`

```typescript
// Request
{ globalPrompt: string }

// Response 200
{ globalPrompt: string }
```

### `GET /api/settings/models`

Legacy endpoint (extraction + embedding only).

```typescript
// Response 200
{ extractionModel: string | null, embeddingModel: string | null, extractionProviderId: string | null, embeddingProviderId: string | null }
```

### `GET /api/settings/default-models`

Returns all default models/services in a single payload.

```typescript
// Response 200
{
  defaultLlmModel: string | null
  defaultLlmProviderId: string | null
  defaultImageModel: string | null
  defaultImageProviderId: string | null
  defaultCompactingModel: string | null
  defaultCompactingProviderId: string | null
  extractionModel: string | null
  extractionProviderId: string | null
  embeddingModel: string | null
  embeddingProviderId: string | null
  defaultSearchProviderId: string | null
}
```

### `PUT /api/settings/default-llm`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ defaultLlmModel: string | null, defaultLlmProviderId: string | null }
```

### `PUT /api/settings/default-image`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ defaultImageModel: string | null, defaultImageProviderId: string | null }
```

### `PUT /api/settings/default-compacting`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ defaultCompactingModel: string | null, defaultCompactingProviderId: string | null }
```

### `PUT /api/settings/extraction-model`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ extractionModel: string | null, extractionProviderId: string | null }
```

### `PUT /api/settings/embedding-model`

```typescript
// Request
{ model: string, providerId?: string | null }

// Response 200
{ embeddingModel: string, embeddingProviderId: string | null }
```

### `PUT /api/settings/default-search`

Search providers have no companion "model": the body is provider-only.

```typescript
// Request
{ providerId: string | null }

// Response 200
{ defaultSearchProviderId: string | null }
```

The current default is read from `GET /api/settings/default-models` (see `defaultSearchProviderId` in that payload).

### `GET /api/settings/dismissed-setup-items`

List of the setup checklist item IDs the user has explicitly skipped. **Global** storage (not per-user) under `app_settings.dismissed_setup_items`: Hivekeep is an individual or small-group product with shared configuration.

```typescript
// Response 200
{ items: string[] }
```

Item IDs recognized by the UI: `add_llm_provider`, `set_default_llm`, `add_embedding_provider`, `set_default_embedding`, `add_image_provider`, `add_search_provider`, `create_first_agent`.

### `POST /api/settings/dismissed-setup-items/:itemId`

Marks an item as skipped.

```typescript
// Response 200
{ items: string[] }   // updated list

// Errors
// 400 INVALID_ITEM_ID: itemId empty or > 64 characters
```

### `DELETE /api/settings/dismissed-setup-items/:itemId`

Restores (un-skips) an item, used by "Show setup checklist" in Settings → General.

```typescript
// Response 200
{ items: string[] }
```

---

## Usage (admin only)

LLM token consumption tracking. All routes require the admin role.

### `GET /api/usage`

Paginated list of LLM consumption records.

```typescript
// Query params (all optional)
agentId?: string
providerId?: string
providerType?: string
modelId?: string
taskId?: string
cronId?: string
callSite?: string
from?: number        // timestamp ms
to?: number          // timestamp ms
limit?: number       // max 200, default 50
offset?: number      // default 0

// Response 200
{
  items: Array<{
    id: string
    createdAt: number
    callSite: string
    callType: string
    providerType: string | null
    providerId: string | null
    modelId: string | null
    agentId: string | null
    taskId: string | null
    cronId: string | null
    sessionId: string | null
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    reasoningTokens: number | null
    embeddingTokens: number | null
    stepCount: number
  }>,
  total: number
}
```

### `GET /api/usage/summary`

Consumption aggregation grouped by a dimension.

```typescript
// Query params
groupBy: 'provider_type' | 'model_id' | 'agent_id' | 'call_site' | 'day'  // required
agentId?: string
providerType?: string
modelId?: string
from?: number
to?: number

// Response 200
{
  summary: Array<{
    group: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    count: number
  }>
}
```

---

## Account Triggers

Triggers per connected email account (table `account_triggers`, see `schema.md`). When a new email from a connected account matches the condition tree, the target Agent is solicited: in its main conversation (with context) or via an isolated sub-task (the prompt must then be self-sufficient). Reuses the webhook dispatch engine. Polling makes no API call when no trigger is active.

### `GET /api/account-triggers?accountId=`

Lists the triggers, optionally filtered on an account. → `{ triggers: AccountTriggerSummary[] }`.

### `POST /api/account-triggers`

Creates a trigger (`created_by: 'user'`). Body: `{ accountId, name, folder?, conditions, prompt, targetAgentId, dispatchMode?, maxConcurrentTasks? }`. `conditions` = `ConditionNode` tree, server-validated (depth ≤ 4, ≤ 30 leaves, non-empty group, compilable regex). `201` → `{ trigger }`, otherwise `400 VALIDATION_ERROR`.

### `PATCH /api/account-triggers/:id`

Updates (or approves via `isActive: true`). → `{ trigger }` or `404`.

### `DELETE /api/account-triggers/:id`

Deletes the trigger.

### `GET /api/account-triggers/:id/logs?limit=`

Evaluation/firing log (`trigger_logs`). → `{ logs: TriggerLogEntry[] }`.

### `GET /api/account-triggers/settings/approval` · `PUT /api/account-triggers/settings/approval`

Global setting: whether triggers created by an Agent must be approved before becoming active (default `false`). `GET` → `{ requireApproval }`; `PUT { enabled: boolean }`.

### `GET /api/email-accounts/:id/folders`

Lists the folders/labels of a connected account (for a trigger's folder picker). → `{ folders: { id, name, type? }[] }`. Falls back to `INBOX` if the provider does not expose `listFolders`.

## Secure input (secret prompts)

Secure-input popup: an Agent (configurator or via `prompt_secret` / `request_provider_setup`) requests a secret (API key, token). The value goes **directly to the vault**; it never transits through the LLM, is neither logged nor stored in `secret_prompts`. See `secret-prompts.ts`. Emits `prompt:secret-request` / `prompt:secret-resolved` over SSE.

### Human prompts: type `tool_access`

`request_tool_access` (a floor tool, available to any Agent) creates a `promptType: 'tool_access'` human prompt: `description` = the Agent's reason, `options[]` = one item per requested tool. Response via the standard endpoint `POST /api/prompts/:id/respond` with `{ response: string[] }`: the list of **granted** tools (empty array = deny all, valid unlike `multi_select`). On approval the server merges the granted names into `agents.extra_tool_names` (permanent, revocable via `PATCH /api/agents/:id`) then restarts the Agent; SSE `agent:tools-granted` `{ agentId, granted, extraToolNames }`.

### `GET /api/secret-prompts/pending?agentId=`

Pending prompts for the Agent (hydration on mount / reconnect). Field metadata only, **never** a secret value. → `{ prompts: SecretPromptRequest[] }`.

### `POST /api/secret-prompts/:id/respond`

Submits the values: `{ values: Record<fieldKey, string> }`. The server stores them in the vault and runs the side effect (create+test a provider, store a secret, create a channel). Purpose `reveal` (tool `reveal_secret`): no value entered, the submission counts as **approval**; the raw value is injected into the resume message ONLY (never into the SSE/HTTP `summary`), the carrier message is flagged `redact_pending` + metadata `{ reveal: { key } }` and it is auto-redacted at the end of the turn (sweep + `tool_calls` scrub; recovery sweep at boot). Cancel counts as refusal. Emits `vault:secret-revealed { agentId, secretKey, approved }` on the event bus. For the `vault` purpose, an already-present key is **updated** (upsert) instead of failing on the `UNIQUE(key)` constraint. In all cases, the prompt leaves the `pending` state (success **as well as** failure) and the Agent is restarted via a non-sensitive confirmation message: a side effect that throws no longer leaves the prompt stuck (otherwise it would re-trigger on every reload). → `{ success: true, summary }` or `400 SECRET_PROMPT_ERROR`.

### `POST /api/secret-prompts/:id/cancel`

Permanently discards a pending prompt without providing the value: status `cancelled`, the Agent (or the suspended sub-task) is restarted with a "refused" note. Idempotent if already resolved. → `{ success: true }` or `400 SECRET_PROMPT_ERROR`.

## Platform updates (version-check)

Two channels: `stable` (GitHub releases) and `edge` (HEAD of `main`). The channel is a global setting (`app_settings.update_channel`, default `stable`).

### `GET /api/version-check`

Cached version info (refreshed in the background if stale). Accessible to any authenticated user.

**Response 200**
```json
{
  "currentVersion": "1.2.0",
  "currentSha": "3492373",
  "channel": "stable",
  "installationType": "systemd-system",
  "latestVersion": "1.3.0",
  "isUpdateAvailable": true,
  "canSelfUpdate": true,
  "selfUpdateBlockedReason": null,
  "releaseUrl": "https://github.com/MarlBurroW/hivekeep/releases/tag/v1.3.0",
  "changelog": [
    { "version": "1.3.0", "title": "Hivekeep v1.3.0", "notes": "### Features\n- ...", "url": "...", "publishedAt": 1765000000000 }
  ],
  "publishedAt": 1765000000000,
  "lastCheckedAt": 1765000100000
}
```

- `installationType`: `docker` | `systemd-system` | `systemd-user` | `launchd` | `manual`.
- `canSelfUpdate` is `false` (with `selfUpdateBlockedReason`: `docker` | `not-git` | `dev-mode`) when the update must happen outside the UI (docker image repull, dev checkout…).
- `changelog` is **cumulative**: all releases between the current version and the latest (stable), or the list of `HEAD..origin/main` commits (edge, `notes` = null).

### `POST /api/version-check/check`

Forces an immediate check against GitHub (admin). Same response as `GET /`. **400 `DISABLED`** if `VERSION_CHECK_ENABLED=false`.

### `PUT /api/version-check/channel`

Changes the channel (admin). Body: `{ "channel": "stable" | "edge" }`. Invalidates the cache and re-runs a check; returns the fresh info. **400 `INVALID_CHANNEL`** otherwise.

### `POST /api/version-check/update`

Starts the auto-update (admin, non-docker git installs only). Responds immediately:

```json
{ "started": true, "runId": "a1b2c3d4" }
```

Progress arrives via SSE (`update:progress`), the final outcome via `GET /api/version-check/last-update` (the server restarts along the way, the client must poll). Errors: **400 `SELF_UPDATE_UNAVAILABLE`** (docker/dev/non-git), **400 `NO_UPDATE`**, **409 `UPDATE_IN_PROGRESS`**.

Server sequence: preflight (clean worktree, disk) → DB snapshot (`VACUUM INTO`) → backup `dist/` + sha → download the release's pre-built client assets (sha256 verified, fallback local build) → `git checkout` of the tag (stable) / fast-forward `main` (edge) → `bun install` → restart. If the new code does not start, the boot-guard (`src/server/index.ts`) automatically restores the old version (repo + dist + deps + DB snapshot): status `rolled-back`.

### `GET /api/version-check/last-update`

Last update attempt (persistent journal `data/update/journal.json`, survives the restart).

**Response 200**
```json
{
  "run": {
    "id": "a1b2c3d4",
    "channel": "stable",
    "fromVersion": "1.2.0",
    "fromSha": "3492373",
    "toVersion": "1.3.0",
    "status": "success",
    "currentStep": null,
    "error": null,
    "startedAt": 1765000000000,
    "finishedAt": 1765000090000
  }
}
```

`status`: `running` | `restarting` | `success` | `failed` (nothing changed, the old version is still running) | `rolled-back` (the new code did not boot, automatic restore).

## Terminal (admin only)

Web terminal on the host machine (or the container under Docker). Section `/terminal`, reserved for admins. tmux-style model: each session is a shell (PTY, `bun-pty`) on the server, scoped to its owner, that **survives WebSocket disconnects**: you can close the browser and reattach from another device (the scrollback is replayed). A session only dies when its shell exits, when the user closes it from the sidebar, or (if `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` > 0, disabled by default) after staying detached too long. Disableable globally via `HIVEKEEP_TERMINAL_ENABLED=false`.

**Persistence across restart.** Session metadata and a bounded scrollback tail are persisted to the DB (`terminal_sessions` table). After a restart, sessions come back as **dormant** (no live shell): the sidebar and history are there, and the first reattach revives the session. Reuse depends on the backend:
- **tmux available** (default in the Docker image): sessions are backed by a tmux session. tmux's server outlives the Bun process, so after a process-only restart (e.g. an in-place self-update) reattaching reconnects to the **live** shell with its running processes intact. A container recreation still loses the processes (tmux dies with the container), but the scrollback is restored.
- **tmux unavailable**: sessions fall back to a direct PTY. Only the scrollback is persisted; reattaching spawns a **fresh** shell in the last working directory. tmux is never a hard dependency.

Any lifecycle change (creation, attach/detach, rename, death, dormancy) emits `terminal:sessions-changed` (SSE, user scope) with the fresh list: that's what syncs the sidebar across devices.

### `GET /api/terminal/status`

Probes the feature's availability (the page calls it before opening the WebSocket, because an upgrade refusal carries no error body).

**Response 200**: `{ "enabled": true, "shell": "/bin/bash", "tmux": true }`
`tmux`: whether tmux backs sessions (so their processes survive a process-only restart). When `false`, only the scrollback is restored. The page surfaces this in the sidebar.
**403 `TERMINAL_DISABLED`** if disabled by env var. **403 `FORBIDDEN`** if non-admin.

### `GET /api/terminal/sessions`

Lists the current user's live sessions (sorted by creation date).

**Response 200**
```json
{
  "sessions": [
    {
      "id": "…",
      "name": "Session 1",
      "createdAt": 1765000000000,
      "lastActiveAt": 1765000050000,
      "attached": true,
      "dormant": false,
      "persistent": true,
      "cwd": "/home/hivekeep/projects/app",
      "command": "vim"
    }
  ]
}
```

- `attached`: a client (any device) is currently connected to this session.
- `dormant`: restored from the DB after a restart, no live shell yet (reattaching revives it).
- `persistent`: backed by tmux, so its running processes survive a process-only restart.
- `cwd`: working directory of the foreground process (or shell when idle). Best-effort: omitted when it can't be inspected (e.g. non-Linux direct-PTY hosts).
- `command`: foreground command currently running, if any (omitted at an idle shell prompt).

### `PATCH /api/terminal/sessions/:id`

Renames a session. Body: `{ "name": "claude code prod" }` (trim, max 60 characters). → `{ "session": { … } }`. **404 `NOT_FOUND`** if the session does not exist, does not belong to the caller, or if the name is empty.

### `DELETE /api/terminal/sessions/:id`

Kills the shell and destroys the session (the sidebar's "close" button). If a client is attached to it, it receives the WS `exit` message. → `{ "success": true }`. **404 `NOT_FOUND`** otherwise.

### Session presets

Reusable per-user templates: a working directory + an init script run once when a session is created from the preset. Mutations emit `terminal:presets-changed` (SSE, user scope) with the fresh list.

`TerminalPresetDTO`: `{ id, name, cwd: string | null, initScript: string | null, createdAt, updatedAt }`.

- **`GET /api/terminal/presets`** → `{ "presets": TerminalPresetDTO[] }` (caller's presets, oldest first).
- **`POST /api/terminal/presets`** — body `{ name, cwd?, initScript? }` (name required, trimmed; cwd/initScript trimmed, empty → null). → `{ "preset": … }` (201). **400 `INVALID`** if the name is empty.
- **`PATCH /api/terminal/presets/:id`** — same body as POST. → `{ "preset": … }`. **404 `NOT_FOUND`** if missing/not owned/empty name.
- **`DELETE /api/terminal/presets/:id`** → `{ "success": true }`. **404 `NOT_FOUND`** otherwise.

### `GET /api/terminal/ws`

WebSocket upgrade (Better Auth session cookie required, same guards as `/status`).

**Query params**: `cols`, `rows` (initial size), `sessionId` (optional: reattaches a still-live session of the same user; otherwise a new shell is created), `presetId` (optional, ignored when `sessionId` is set: seeds the new session with the preset's `cwd` and runs its `initScript` once). The `cwd` is expanded (`~` → home) and falls back to home if it isn't an existing directory. Multiple clients (tabs/devices) can attach **simultaneously** to the same session: the output is mirrored to all, each one's input goes to the PTY.

**Client → server messages** (JSON):

| Type | Payload | Effect |
|---|---|---|
| `input` | `{ "type": "input", "data": "ls\r" }` | Writes to the PTY |
| `resize` | `{ "type": "resize", "cols": 120, "rows": 32 }` | Declares the size of THIS client; the PTY is sized to the smallest attached client (tmux-style) |
| `kill` | `{ "type": "kill" }` | Kills the shell and destroys the session |
| `ping` | `{ "type": "ping" }` | Keepalive (ignored on the server) |

**Server → client messages** (JSON):

| Type | Payload | Meaning |
|---|---|---|
| `ready` | `{ "type": "ready", "sessionId": "…", "resumed": false }` | Session attached. If `resumed: true`, the full scrollback follows in an `output` message |
| `output` | `{ "type": "output", "data": "…" }` | Raw PTY output (ANSI sequences included) |
| `exit` | `{ "type": "exit" }` | This attachment ended: the shell terminated (exit, kill, TTL) and the session is gone, OR a tmux-backed session went dormant (its server still holds the shell) and can be reattached |
| `error` | `{ "type": "error", "code": "TERMINAL_MAX_SESSIONS" }` | Creation refused (`HIVEKEEP_TERMINAL_MAX_SESSIONS` cap reached), the server then closes the socket |

## Mini-Apps (backend runtime)

> The full mini-app CRUD (files, storage, snapshots, console, icons) is documented on the `docs-site/` side (Mini-Apps section). This section covers the **backend runtime** contracts (`_server.js`).

### `ALL /api/mini-apps/:id/api/*`

Proxy to the Hono routes of the app's `_server.js` (loaded lazily, or at boot if `app.json` declares `"background": true`). `404 NO_BACKEND` if the app has no backend, `404 NO_HTTP_ROUTES` if the module only exports lifecycle hooks.

### `GET /api/mini-apps/:id/events`

**Per-app** SSE stream (distinct from the global SSE): events emitted by `ctx.events.emit()` on the backend side. Each subscriber is tagged with the session user, which enables targeted emission `ctx.events.emit(event, data, { userId })`.

```
event: connected   data: { appId }
event: app-event   data: { event: string, data: unknown, timestamp: number }
: ping             (keep-alive every 30s)
```

### `ALL /api/mini-apps/:id/platform/*`

Permissioned gateway to the platform's REST API: lets a mini-app (front) manage any resource the way the settings pages do. The sub-path is replayed onto the real `/api/<resource>` route carrying the user's session, after checking the `platform:<resource>:<read|write>` permission granted to the app (GET/HEAD = read, the rest = write; a `write` grant implies `read`).

```
GET  /api/mini-apps/:id/platform/contacts        -> proxy GET  /api/contacts        (platform:contacts:read)
POST /api/mini-apps/:id/platform/contacts        -> proxy POST /api/contacts        (platform:contacts:write)
```

Errors: `403 PERMISSION_REQUIRED` (permission not granted), `403 RESOURCE_FORBIDDEN` (resource forbidden via the gateway: `auth`, `onboarding`, `vault`, `database`, `users`, `mini-apps`, `sse`, `health`, `uploads`), `400 INVALID_PATH`.

> Security: the iframe is same-origin (session cookie). The **mini-app origin guard** (`auth/mini-app-origin-guard.ts`) sandboxes the iframes to their own namespace `/api/mini-apps/<id>/*` via the `Referer` (layer 1, non-breaking), so the gateway is the path to reach the resources. This is defense in depth (a hostile app can drop its Referer); the full barrier (scoped token instead of the cookie + removal of `allow-same-origin`) remains a planned hardening (layer 2).

### `POST /api/mini-apps/:id/client-event`

Upstream UI → backend channel (`Hivekeep.events.send()`). Delivered to the `_server.js`'s `onClientEvent(ctx, event, data, meta)` export (`meta = { userId, userName }`, execution bounded to 10s).

```typescript
// Request
{ event: string, data?: unknown }

// Response 200
{ handled: boolean, result: unknown | null }   // handled=false if no onClientEvent export

// Errors: 404 NOT_FOUND / NO_BACKEND, 400 INVALID_BODY, 500 CLIENT_EVENT_ERROR
```

### `GET /api/mini-apps/:id/permissions`

State of the capability permissions: requested in `app.json` (`"permissions": ["llm", "agent:inform", "agent:task", "channels:send", "secrets:<NAME>", "platform:<resource>:<read|write>", "events:<prefix>"]`) vs granted by the user.

```typescript
// Response 200
{ requested: string[], granted: string[], missing: string[] }
```

### `POST /api/mini-apps/:id/permissions`

Grants permissions (additive: never an implicit revocation). Only permissions present in the manifest can be granted. Restarts the backend and emits `miniapp:updated`.

```typescript
// Request
{ grant: string[] }

// Response 200
{ requested: string[], granted: string[], invalid: string[] }
```

## Feedback

In-app feedback. The browser never calls the external collector directly: the server enriches each submission with the instance version + an anonymous per-install id, then relays it. No new SSE events.

### `GET /api/feedback/state`

Returns the proactive-banner eligibility for the current user.

```json
{
  "enabled": true,
  "shouldPrompt": false,
  "starred": false,
  "githubUrl": "https://github.com/MarlBurroW/hivekeep"
}
```

- `enabled` — feature configured on this instance (`HIVEKEEP_FEEDBACK_ENDPOINT` set).
- `shouldPrompt` — true when the discreet chat banner should be shown now (usage threshold reached, not dismissed, not snoozed).
- `starred` — the user already clicked the GitHub star CTA.

### `PATCH /api/feedback/state`

Record a banner action. Returns the updated state (same shape as `GET /state`).

```json
{ "action": "snooze" }
```

`action` is one of `snooze` (hide for `HIVEKEEP_FEEDBACK_SNOOZE_DAYS`), `dismiss` (hide permanently), `starred` (record star click), `shown` (mark the banner as displayed). Invalid action → `400 INVALID_ACTION`.

### `POST /api/feedback`

Submit written feedback. Relayed to the central collector.

```json
{
  "type": "bug",
  "message": "Steps to reproduce...",
  "email": "you@example.com",
  "locale": "fr"
}
```

- `type` — `bug` | `suggestion` | `experience` (required; otherwise `400 INVALID_TYPE`).
- `message` — required, trimmed, max `HIVEKEEP_FEEDBACK_MAX_LENGTH` chars (`400 EMPTY_MESSAGE` / `400 MESSAGE_TOO_LONG`).
- `email` — optional, max 200 chars.
- `locale` — optional UI locale, attached for triage.

Returns `201 { "ok": true }`. Errors: `503 FEEDBACK_DISABLED` (feature off), `502 FEEDBACK_RELAY_FAILED` (collector unreachable).

## SSE

### `GET /api/sse`

**Global** SSE connection (a single one per client). The server multiplexes the events of all Agents.

#### Event types

```typescript
// Streaming LLM text, one event per provider delta. `contentLength` is the
// total streamed length (committed + provisional) AFTER appending `token`;
// clients use it to skip tokens already covered by a rehydration snapshot.
// Text streamed during a step that ends in tool calls is PROVISIONAL
// (pre-narration) and is followed by a `chat:token-retract`. The first delta
// of a message also carries attribution fields (sourceName, sourceAvatarUrl…).
{ event: 'chat:token', data: { agentId: string, messageId: string, token: string, contentLength: number } }

// The current step's streamed text turned out to be pre-narration before
// tool calls (or the step errored/was aborted): truncate the streaming
// bubble content back to `contentLength` characters.
{ event: 'chat:token-retract', data: { agentId: string, messageId: string, contentLength: number } }

// LLM response finished
{ event: 'chat:done', data: { agentId: string, messageId: string, tokenUsage?: { inputTokens: number, outputTokens: number, totalTokens: number } } }

// New incoming chat message: emitted for ALL sources, including
// user messages (real-time multi-device / multi-member sync).
// For web user messages, `clientMessageId` echoes the token sent to the
// POST: the emitting client reconciles its optimistic bubble, the others add it.
// (The payload is flattened at the root level, not nested under `message`.)
{ event: 'chat:message', data: { agentId: string, id: string, clientMessageId?: string | null, role: string, content: string, files: FileShape[], ... } }

// Deleted messages (single deletion or rewind): clients remove
// these ids from their list (idempotent filter, multi-device sync).
{ event: 'chat:messages-deleted', data: { agentId: string, messageIds: string[] } }

// Messages cleaned in place by redact_secret_leak (a secret's value was
// replaced by its placeholder {{secret:KEY}} in content/tool_calls): the
// clients re-fetch the conversation (the content changed, did not disappear).
{ event: 'chat:messages-redacted', data: { agentId: string, messageIds: string[] } }

// Task status change
{ event: 'task:status', data: { taskId: string, agentId: string, status: string } }

// Task finished
{ event: 'task:done', data: { taskId: string, agentId: string, result: string } }

// Cron execution
{ event: 'cron:triggered', data: { cronId: string, agentId: string, taskId: string } }

// Email trigger (connected account): created / updated / deleted / fired
{ event: 'trigger:created', data: { triggerId: string, accountId: string } }
{ event: 'trigger:updated', data: { triggerId: string, accountId: string } }
{ event: 'trigger:deleted', data: { triggerId: string, accountId: string } }
{ event: 'trigger:fired',   data: { triggerId: string, accountId: string } }

// Queue updated
{ event: 'queue:update', data: { agentId: string, queueSize: number, isProcessing: boolean, processingStartedAt?: number } }

// Error on an Agent
{ event: 'agent:error', data: { agentId: string, error: string } }


// Channel interactive pairing (e.g. WhatsApp QR): emitted during a pairing
// adapter's activation. `status: 'qr'` carries a `qrImage` data-URL (PNG) to
// render; `'connected'` means the session paired (the channel turns active);
// `'logged-out'` / `'error'` carry an optional `message`. Trigger pairing by
// POST /api/channels/:id/activate; re-activate for a fresh QR.
{ event: 'channel:pairing', data: {
  channelId: string,
  agentId: string,
  status: 'qr' | 'connected' | 'logged-out' | 'error',
  qrImage?: string,   // data:image/png;base64,... when status === 'qr'
  message?: string    // when status === 'error' | 'logged-out'
} }

// Workspace mutated (Files section): emitted by the /workspace/* routes AND by the
// native tools that write into the static workspace (write_file, edit_file,
// multi_edit, download_stored_file, download_email_attachment). A recursive
// operation (delete/move/copy/upload of a folder) emits ONE coarse change
// on the folder (isDirectory: true), never one entry per descendant; the
// `changes` array is bounded (≤ 20: beyond that, a single change on the common parent).
// `modifiedAt` (resulting mtime) lets the emitting device ignore its own echo.
// Scope: agent sources keep the per-agent scope (sendToAgent) and carry `agentId`;
// folder/mini-app sources are broadcast and carry only `source`. The client filters
// by the source it is currently viewing (agentId for agents, source otherwise).
{ event: 'workspace:changed', data: {
  agentId?: string,                                  // present for agent sources
  source: { type: 'agent' | 'folder' | 'miniapp', id: string },
  changes: Array<{
    path: string,
    type: 'created' | 'modified' | 'deleted' | 'renamed',
    isDirectory: boolean,
    newPath?: string,         // for renamed
    modifiedAt?: number
  }>
} }

// Admin terminal sessions changed (creation / attach / detach / rename /
// death): user scope (sendToUser): only the owner receives it. The payload carries
// the full fresh list (the sidebar replaces, no merge needed).
{ event: 'terminal:sessions-changed', data: { sessions: TerminalSessionDTO[] } }
{ event: 'terminal:presets-changed', data: { presets: TerminalPresetDTO[] } }

// Mini-apps: lifecycle (CRUD + files). `miniapp:notify` does not exist here:
// app notifications go through the standard notification:new channel
// (type 'miniapp:notify', relatedType 'miniapp', relatedId = appId).
{ event: 'miniapp:created', data: { app: MiniAppSummary } }
{ event: 'miniapp:updated', data: { app: MiniAppSummary } }       // includes maintainer reassignment + permission grant
{ event: 'miniapp:deleted', data: { appId: string } }
{ event: 'miniapp:file-updated', data: { appId: string, path: string, version: number } }
{ event: 'miniapp:reload', data: { appId: string } }              // iframe reload request (tool reload_mini_app)

// Platform updates
// New version detected by the check cron (emitted once per version)
{ event: 'version:update-available', data: { channel: 'stable' | 'edge', latestVersion: string, releaseUrl: string | null, publishedAt: number | null } }
// Progress of an in-progress self-update (steps: preflight, snapshot, backup,
// download, apply, dependencies, assets, restart)
{ event: 'update:progress', data: { runId: string, step: string, status: 'running' | 'done' | 'error', message: string | null } }
// Outcome of a self-update. 'success' and 'rolled-back' are emitted AFTER the restart
// (so the client must also poll GET /api/version-check/last-update during
// the SSE outage); 'failed' is emitted before restart (the old version is running).
{ event: 'update:finished', data: { runId: string, status: 'success' | 'failed' | 'rolled-back', version?: string, error?: string } }
```

> Mini-app backends can subscribe IN-PROCESS to this catalog via `ctx.on(eventType, handler)` (guarded by the `events:<prefix>` permission, e.g. `events:task`). High-frequency/internal types (`chat:token`, `queue:update`, `*-token-usage`…) are not subscribable. See `docs-site` > mini-apps > backend.

> The SSE is **global** (not per Agent). The client filters on the frontend side by `agentId` to display only the relevant events. This makes it possible to update the sidebar (badges, statuses) for all Agents simultaneously.

---

## External API (machine-to-machine)

A bearer-authenticated surface so an external program can hold a conversation with an Agent without a browser session. Full spec: `external-api.md`.

**Auth.** `Authorization: Bearer hk_<keyId>.<secret>` on every `/api/v1/*` route (its own scheme, not the cookie session). The request runs as the client's owner user. Errors: `UNAUTHORIZED` (401), `API_KEY_REVOKED` (401), `CLIENT_DISABLED` (403), `RATE_LIMITED` (429), `EXTERNAL_API_DISABLED` (403).

### `POST /api/v1/agents/:agentId/messages`

Send a message; optionally wait for the reply inline. No `conversationId`/`newConversation` targets the **main timeline**; otherwise an **isolated thread** (full Agent power, private context).

```typescript
// Request
{
  content: string,            // required
  conversationId?: string,    // continue an isolated thread
  newConversation?: boolean,  // open a new isolated thread
  title?: string,             // title for newConversation
  mode?: 'wait' | 'async',    // default: async
  waitTimeoutMs?: number       // clamped to externalApi.waitTimeoutMsMax
}

// Response 200 (mode 'wait', reply ready)
{ requestId: string, status: 'done', reply: string, conversationId: string | null }

// Response 202 (mode 'async', or 'wait' timed out, then poll)
{ requestId: string, status: 'pending', conversationId: string | null }
```

Errors: `AGENT_NOT_FOUND` (404), `AGENT_SCOPE_VIOLATION` (403), `MODE_NOT_ALLOWED` (403), `EMPTY_MESSAGE`/`MESSAGE_TOO_LONG` (400), `CONVERSATION_NOT_FOUND` (404), `CONVERSATION_CLOSED` (409), `TOO_MANY_CONVERSATIONS` (429).

### `GET /api/v1/requests/:requestId`

Poll a request. Scoped to the calling client.

```typescript
// Response 200
{ requestId: string, status: 'pending' | 'done' | 'error', reply: string | null, error: { code: string, message: string } | null, conversationId: string | null }
```

### `GET /api/v1/agents`

Agents this key may target: `{ agents: Array<{ id, slug, name, role, avatarUrl }> }` (`avatarUrl` is null when the Agent has no avatar). Scoped to the locked Agent if the client has one.

### `POST /api/v1/agents/:agentId/conversations`

Open an isolated thread. Body `{ title? }` → `201 { conversationId }`.

### `GET /api/v1/agents/:agentId/conversations`

List this client's threads: `{ conversations: Array<{ conversationId, agentId, title, status, createdAt, lastMessageAt }> }`.

### `GET /api/v1/conversations/:conversationId/messages`

Transcript of a thread (this client's only). Query `?limit=&before=`. Returns `{ messages: Array<{ id, role, content, sourceType, createdAt }> }`.

### `POST /api/v1/conversations/:conversationId/close`

Close a thread → `{ ok: true }`.

### Management routes `/api/api-clients/*` (cookie auth, admin)

Back the Settings UI.

- `GET /api/api-clients` → `{ clients: ApiClientSummary[] }` (with keys, never secrets)
- `POST /api/api-clients` → create. Body `{ name, description?, agentId?, allowedModes?, rateLimitPerMin? }`
- `PATCH /api/api-clients/:id` → update (same fields + `status`)
- `DELETE /api/api-clients/:id` → delete (cascades keys + requests)
- `POST /api/api-clients/:id/keys` → mint a key. Body `{ label? }` → `{ id, label, prefix, fullKey }` (**fullKey shown once**)
- `POST /api/api-clients/:id/keys/:keyId/revoke` → soft-revoke a key
