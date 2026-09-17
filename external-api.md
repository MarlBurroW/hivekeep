# External API (machine-to-machine conversational access)

> **Status: P1 to P4 implemented** (backend, Settings UI, docs, reply-retention GC).
> P5 (SSE-by-key stream, outbound webhook delivery) is optional and not built.
> Branch `add-external-communication-system`.
> Lets an external machine hold a *stateful conversation* with an Agent over HTTP,
> authenticated by an API key, without a browser session. This is NOT the channels
> system (that is human chat on Telegram/Slack and carries contact resolution,
> approval gates and fire-and-forget delivery) and NOT the inbound webhooks (those
> are fire-and-forget events). It is a request/reply API with correlation IDs that
> reuses the existing queue, session-lane and turn-completion machinery.

## 1. Problem

There is no way for an external program to talk to an Agent. Today a message only
reaches an Agent through `POST /api/agents/:id/messages` behind a Better Auth
**cookie** session (`src/server/auth/middleware.ts`), and the reply only comes back
over the browser SSE stream. There is no API key, no bearer auth, and no way to get
the reply as an HTTP response.

We want: a declared external client sends a message to an Agent, optionally waits
for the reply inline, and can keep sending follow-ups that the Agent answers *in
context*. Multiple distinct callers, each declared explicitly, each with its own
credentials.

## 2. What we reuse (all grounded in real code)

The platform already has every primitive this needs. We add an auth layer and a
correlation layer on top; we do not touch the Agent loop.

| Piece | File | Role we reuse |
|---|---|---|
| Enqueue | `src/server/services/queue.ts` (`enqueueMessage`, `EnqueueParams`) | `sourceType` / `sourceId` / `requestId` / `sessionId` fields already exist. API messages enqueue at **user priority** (like inbound channel messages): a `mode:'wait'` caller must not starve behind task results and inter-agent traffic |
| Correlation id | `src/server/services/inter-agent.ts` | `requestId` column already routes a reply back to its request; same idea, external caller |
| Turn-completion delivery hook | `src/server/services/agent-engine.ts` (channel branch around the `deliverChannelResponse` call) | precedent for "on turn done, push the reply somewhere by source"; we add an `'api'` branch |
| Isolated lane | `dequeueMessage(agentId, 'quick')` + `processNextQuickSessionMessage` (`agent-engine.ts`), `quick_sessions` table, `messages.session_id` | the existing "a message with a `session_id` runs in its own context lane" mechanism. We reuse the *lane* (separate dequeue + `session_id`-scoped context) but run the **full** capability profile, not the minimal quick-chat one (see §3.3, §7) |
| Sender attribution | channel sender prefix in `src/server/services/channels.ts` | precedent for tagging a message with its external origin |
| Auth dispatch | `src/server/auth/middleware.ts` | we add a `/api/v1/*` bearer branch next to the mini-app-token and internal-actor branches |
| SSE | `src/server/sse/index.ts` | management/observability events |

## 3. Core model

### 3.1 External client (declared caller)

A first-class, explicitly declared entity. It is the *actor* represented in the
conversation, the way a channel attributes a message to a contact.

- An admin declares a client in Settings: name, optional description, target scope.
- Tool calls made on its behalf act as the client's **owner user** (the admin who
  declared it). The external client is never a Better Auth user.
- A client holds one or more rotatable **API keys**.

### 3.2 API key

- Format: `hk_<keyId>.<secret>` where `<secret>` is >=32 bytes of base62 entropy.
  The `hk_` prefix makes leaked keys greppable; embedding `keyId` lets lookup hit
  an index instead of scanning.
- We store only `sha256(secret)` plus a short display prefix. The full key is shown
  **once** at creation, never again.
- Presented as `Authorization: Bearer hk_<keyId>.<secret>`.

### 3.3 Conversation target: hybrid, chosen per request

| Target | How requested | Backed by | Capability profile |
|---|---|---|---|
| **Main timeline** | no `conversationId` | `session_id = NULL` (the Agent's single continuous session) | full Agent, same as a user message. Visible in the app UI, shared with the human. |
| **Isolated thread** | `conversationId` (existing) or `newConversation: true` | a backing session lane (`messages.session_id` set), tracked by `api_conversations` | **full Agent** (all tools, memory write, proactive), but in a **separate context**. Does not pollute the human timeline and is isolated from other callers' threads. |

Both targets run the Agent at full power. The split is purely about **context
isolation**, not about restricting what the Agent can do:

- Main timeline = one shared reality. Best for *your own* scripts driving *your*
  Agent, where you want the external turns interleaved with the app conversation.
- Isolated thread = a private context per caller. Best when several declared clients
  each hold their own ongoing conversation and must not see, or bleed into, each
  other or your human timeline.

> **Why this is the larger part of the work.** Today the lane is binary: a message
> with a `session_id` is processed by `processNextQuickSessionMessage`, which runs a
> deliberately **minimal** profile (read-only memory, no proactive, minimal prompt) for
> the quick-chat UI feature. "Full power but isolated" means decoupling two things the
> code currently conflates: the **context scope** (which messages form the history)
> from the **capability profile** (full vs minimal). The main processing path must be
> parametrizable by a context scope (a `session_id`, or `NULL` for main) while keeping
> the full prompt and toolset. The existing quick-chat minimal path stays untouched.
> See §7.

> **Lifecycle.** The isolated session must not auto-expire under the caller. Its
> `api_conversations` row owns the lifecycle: a sliding TTL refreshed on each message
> (`config.externalApi.conversationIdleTtlHours`); the quick-session idle cleanup
> (`quick-session-cleanup.ts`) must skip API-owned sessions. The thread is closed only
> by the caller (`POST .../close`) or when its sliding TTL elapses.

### 3.4 Reply retrieval: wait or poll, one mechanism

Both modes share the exact same path: enqueue with a `requestId`, and on turn
completion the delivery hook writes the reply into `api_requests`. `wait` is just an
in-process await on that same completion.

- `mode: "wait"` -> the request blocks up to `waitTimeoutMs` (clamped to
  `config.externalApi.waitTimeoutMsMax`). On completion returns
  `200 { requestId, status: "done", reply, conversationId? }`. On timeout returns
  `202 { requestId, status: "pending", conversationId? }` and the caller polls.
- `mode: "async"` (default) -> returns `202 { requestId, status: "pending", conversationId? }` immediately.
- Poll `GET /api/v1/requests/:requestId` -> `{ requestId, status, reply?, error? }`
  in every case.

The in-process wait registry (`Map<requestId, resolver>`) is lost on restart; an
in-flight `wait` then resolves by the caller falling back to poll. Document this; do
not try to make `wait` durable.

## 4. Schema (new tables)

Follow project conventions: UUID text PKs, Unix-ms integer timestamps, booleans as
0/1, JSON as text. Drizzle migration via `bun run db:generate`.

### `api_clients`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | text PK | UUID | |
| `name` | text | NOT NULL | shown as the message attribution `[name]` |
| `description` | text | | |
| `owner_user_id` | text | FK -> user.id, ON DELETE CASCADE, NOT NULL | tool calls act as this user |
| `agent_id` | text | FK -> agents.id, ON DELETE CASCADE | NULL = may target any agent via the path; set = locked to one Agent |
| `allowed_modes` | text | NOT NULL, default `["main","isolated"]` | JSON subset; gates which targets the client may use |
| `rate_limit_per_min` | integer | | NULL -> `config.externalApi.defaultRateLimitPerMinute` |
| `status` | text | NOT NULL, default `'active'` | `'active'` / `'disabled'` |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

### `api_keys`
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | text PK | UUID | this is the `<keyId>` embedded in the token |
| `client_id` | text | FK -> api_clients.id, ON DELETE CASCADE, NOT NULL | |
| `label` | text | NOT NULL | e.g. "CI server" |
| `key_hash` | text | NOT NULL | `sha256(secret)` |
| `key_prefix` | text | NOT NULL | display only, e.g. `hk_a1b2c3…` |
| `last_used_at` | integer | | throttled update |
| `revoked_at` | integer | | soft revoke, never hard-delete (audit) |
| `created_at` | integer | NOT NULL | |

### `api_conversations` (isolated threads)
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | text PK | UUID | the public `conversationId` |
| `client_id` | text | FK -> api_clients.id, ON DELETE CASCADE, NOT NULL | |
| `agent_id` | text | FK -> agents.id, ON DELETE CASCADE, NOT NULL | |
| `session_id` | text | FK -> quick_sessions.id, ON DELETE CASCADE, NOT NULL | backing isolated lane |
| `title` | text | | |
| `status` | text | NOT NULL, default `'active'` | `'active'` / `'closed'` |
| `created_at` | integer | NOT NULL | |
| `last_message_at` | integer | | drives the sliding TTL |
| `expires_at` | integer | | sliding; refreshed each message |

The backing session satisfies the existing `messages.session_id` FK to
`quick_sessions`, so each isolated thread materializes one `quick_sessions` row. Add a
`kind` column to `quick_sessions` (`'quick'` default, `'api'` for these) so the
processor can pick the full vs minimal profile (§7) and the idle cleanup can skip
`kind = 'api'`. No other consumer of `quick_sessions` changes behavior for the default
`'quick'` kind.

### `api_requests` (correlation)
| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | text PK | UUID | the `requestId` (also set as `queue_items.request_id`) |
| `client_id` | text | FK -> api_clients.id, ON DELETE CASCADE, NOT NULL | |
| `agent_id` | text | FK -> agents.id, ON DELETE CASCADE, NOT NULL | |
| `conversation_id` | text | FK -> api_conversations.id, ON DELETE CASCADE | NULL = main timeline |
| `queue_item_id` | text | | the enqueued item |
| `request_message_id` | text | FK -> messages.id | the persisted user message |
| `status` | text | NOT NULL, default `'pending'` | `'pending'` / `'done'` / `'error'` / `'cancelled'` |
| `reply_message_id` | text | FK -> messages.id | |
| `reply_content` | text | | denormalized for cheap poll/wait reads |
| `error_code` | text | | |
| `error_message` | text | | |
| `created_at` | integer | NOT NULL | |
| `completed_at` | integer | | |

`api_requests` rows are retained `config.externalApi.replyRetentionHours` then GC'd.

## 5. Routes

### 5.1 External surface `/api/v1/*` (bearer auth)

Versioned because it is a stable third-party contract.

**`POST /api/v1/agents/:agentId/messages`**
Body:
```json
{
  "content": "string (required)",
  "conversationId": "string (optional) - continue an isolated thread",
  "newConversation": true,
  "mode": "wait | async (default async)",
  "waitTimeoutMs": 60000,
  "metadata": { "free-form": "merged into messages.metadata.api" }
}
```
Target resolution: `conversationId` set -> that isolated thread (must belong to this
client + agent, else `CONVERSATION_NOT_FOUND`); else `newConversation: true` ->
create an isolated thread and return its `conversationId`; else -> main timeline.
Mode/agent scope enforced against the client (`MODE_NOT_ALLOWED` /
`AGENT_SCOPE_VIOLATION`).
Response: `200 { requestId, status: "done", reply, conversationId? }` (wait, done)
or `202 { requestId, status: "pending", conversationId? }` (async, or wait timeout).

**`GET /api/v1/requests/:requestId`** -> `{ requestId, status, reply?, error?, conversationId? }`.
404 `REQUEST_NOT_FOUND` if unknown or owned by another client.

**`POST /api/v1/agents/:agentId/conversations`** -> open an isolated thread,
`201 { conversationId }`. Body: `{ title? }`.

**`GET /api/v1/agents/:agentId/conversations`** -> list this client's threads.

**`GET /api/v1/conversations/:conversationId/messages?limit=&before=`** ->
paginated transcript (this client's thread only). `limit` is clamped to
1..100 (default 50). `before` is a message id and pages BACKWARD from it
(the cursor resolves to that message's position; unknown ids are a 400
`INVALID_CURSOR`); each page is returned in chronological order.

**`POST /api/v1/conversations/:conversationId/close`** -> close the thread.

**`GET /api/v1/agents`** -> agents this key may target (discovery), `[{ id, name }]`.

> Phase 2 (optional, not in the first cut): `GET /api/v1/stream?agentId=&conversationId=`,
> an SSE stream authenticated by the key, emitting `api:token` / `api:reply`. The
> correlation model already supports it; add only if a caller needs token streaming
> rather than wait/poll.

### 5.2 Management surface `/api/api-clients/*` (cookie auth, admin)

Backs the Settings UI. Standard cookie middleware; admin role.
- `GET /api/api-clients` / `POST /api/api-clients` / `PATCH /api/api-clients/:id` / `DELETE /api/api-clients/:id`
- `POST /api/api-clients/:id/keys` -> creates a key, returns the **full key once**:
  `{ id, fullKey, prefix }`.
- `POST /api/api-clients/:id/keys/:keyId/revoke`
- `GET /api/api-clients/:id/usage` -> last-used, request counts (for the UI).

## 6. Auth (the missing primitive)

Add a branch to `authMiddleware` (`src/server/auth/middleware.ts`), alongside the
existing internal-actor and mini-app-token branches. For `path.startsWith('/api/v1/')`:

1. Read `Authorization: Bearer hk_<keyId>.<secret>`. Missing/malformed -> 401 `UNAUTHORIZED`.
2. Look up the key by `keyId`. Compare `sha256(secret)` to `key_hash` with a
   constant-time compare. Mismatch/unknown -> 401 `UNAUTHORIZED`.
3. Key revoked -> 401 `API_KEY_REVOKED`. Client disabled -> 403 `CLIENT_DISABLED`.
4. Enforce per-client rate limit (in-memory counter, same pattern as
   `inter-agent.ts`). Over -> 429 `RATE_LIMITED` with `Retry-After`.
5. `c.set('user', { id: client.owner_user_id, ... })` and `c.set('apiClient', client)`.
   Throttle `last_used_at` writes (e.g. at most once/min per key).

`/api/v1/*` is therefore NOT a blanket auth exemption; it has its own scheme. The
`x-hivekeep-internal-actor` header stays stripped at the edge, so the bearer path is
the only external entry.

## 7. Wiring into the Agent loop

The LLM turn itself is unchanged. Three touch points:

1. **Enqueue.** The send route calls `enqueueMessage` with
   `sourceType: 'api'`, `sourceId: clientId`, `requestId: <new uuid>`, and
   `sessionId: <backing session>` for an isolated thread (omitted for main).
   It writes the `api_requests` row (`status: 'pending'`). Both targets tag the
   persisted message with a sender prefix `[clientName]` and
   `messages.metadata.api = { clientId, requestId }`, mirroring the channel
   sender-prefix precedent.
2. **Processing (the core-loop change for isolated threads).** Generalize the main
   processing path so its context scope is a parameter: `NULL` for the main timeline
   (today's behavior) or a `session_id` for an isolated thread, while keeping the full
   prompt and toolset. Concretely, the `isNull(messages.sessionId)` filters that define
   the main context (in `buildMessageHistory`, `compacting.ts`, `context-preview.ts`)
   become "scope = NULL or scope = thisSessionId". Dispatch: a dequeued session-lane
   item whose backing `quick_sessions.kind = 'api'` runs this full path scoped to its
   `session_id`; `kind = 'quick'` keeps the existing minimal `processNextQuickSessionMessage`.
3. **Turn completion.** In `agent-engine.ts`, next to the existing channel branch
   that fires `deliverChannelResponse`, add: if `queueItem.sourceType === 'api'`,
   resolve the reply into `api_requests` by `queueItem.requestId` (set `status: 'done'`,
   `reply_message_id`, `reply_content`, `completed_at`), release any in-process `wait`
   waiter, refresh the conversation TTL, and emit an `api:reply` SSE event for
   observability. On a turn error, set `status: 'error'` with the code/message so
   `wait`/poll surface it instead of hanging.

## 8. Config (additions to `config.md` / `src/server/config.ts`)

| Key | Env | Default | Meaning |
|---|---|---|---|
| `externalApi.enabled` | `HIVEKEEP_EXTERNAL_API_ENABLED` | `true` | master switch |
| `externalApi.defaultRateLimitPerMinute` | `HIVEKEEP_EXTERNAL_API_RATE_LIMIT` | `60` | per-client fallback |
| `externalApi.waitTimeoutMsDefault` | `HIVEKEEP_EXTERNAL_API_WAIT_DEFAULT_MS` | `60000` | |
| `externalApi.waitTimeoutMsMax` | `HIVEKEEP_EXTERNAL_API_WAIT_MAX_MS` | `120000` | clamp |
| `externalApi.conversationIdleTtlHours` | `HIVEKEEP_EXTERNAL_API_CONV_TTL_HOURS` | `720` | sliding TTL (30 days) |
| `externalApi.maxActiveConversationsPerClient` | `HIVEKEEP_EXTERNAL_API_MAX_CONV` | `200` | |
| `externalApi.replyRetentionHours` | `HIVEKEEP_EXTERNAL_API_REPLY_RETENTION_HOURS` | `168` | api_requests GC (7 days) |

## 9. Errors

Standard `{ error: { code, message } }`. Codes: `UNAUTHORIZED`, `API_KEY_REVOKED`,
`CLIENT_DISABLED`, `AGENT_SCOPE_VIOLATION`, `MODE_NOT_ALLOWED`, `RATE_LIMITED` (429),
`CONVERSATION_NOT_FOUND`, `CONVERSATION_CLOSED`, `REQUEST_NOT_FOUND`,
`EXTERNAL_API_DISABLED`. A `wait` timeout is not an error: it returns `202` with
`status: "pending"`.

## 10. UI (Settings)

A Settings section "External API". Follow the UI workflow rules (reuse-first, mobile,
`PageHeader`, no dead affordances):

- `PageHeader` (icon + title + an "Add client" action in the right slot).
- `EmptyState` when there are no clients.
- A client list. Each client: name, target Agent, allowed modes, last used. Below
  `sm` the table becomes stacked cards (`hidden sm:block` table + `sm:hidden` cards).
- Declare/edit client in a `FormDialog` (panel variant). Reuse the existing
  **AgentSelector** for the target Agent (do not hand-roll one). Allowed modes via a
  small multi-toggle; rate limit optional.
- Keys managed inside the client: "Create key" reveals the full key **once** in a
  copy-to-clipboard field with a clear "you will not see this again" note; revoke via
  `ConfirmDeleteButton`.
- A short "How to use" snippet (curl with the bearer header) so the feature is
  discoverable, not buried.

## 11. Docs

Ships with the feature, not later:
- `api.md`: the `/api/v1/*` contract, the management routes, the auth scheme, the
  `api:reply` SSE event.
- `schema.md`: the four new tables.
- `config.md`: the `externalApi.*` block.
- `docs-site/`: a user page "Talk to an Agent from your own code" with a curl
  walkthrough of send -> wait, and send -> poll, plus opening an isolated thread.

## 12. Phasing

1. **P1 - Foundation + main timeline.** `api_clients` + `api_keys` schema, key
   service (generate/hash/verify), bearer middleware branch, `POST /api/v1/agents/:id/messages`
   (main timeline, wait + async), `GET /api/v1/requests/:id`, `api_requests` +
   completion hook for `sourceType: 'api'`. Usable end-to-end with curl.
2. **P2 - Isolated threads (the larger piece).** Generalize the main processing path
   to take a context scope (decouple context-scope from capability-profile, §7), add
   the `quick_sessions.kind` discriminator, then `api_conversations` + backing session
   creation, conversation routes, GC exemption + sliding TTL, isolated completion hook.
   This is the part that touches the core loop, so it ships after P1 is proven.
3. **P3 - Settings UI.** Clients + keys management (reuse AgentSelector / FormDialog /
   ConfirmDeleteButton / EmptyState; mobile cards).
4. **P4 - Docs.** `api.md` + `schema.md` + `config.md` + docs-site page.
5. **P5 - Optional.** `GET /api/v1/stream` (SSE by key) and/or an outbound webhook
   delivery for callers that prefer push over poll. Both fit the correlation model
   without schema changes.

## 13. Settled decisions

- **Isolated-thread capability profile: full power, isolated context.** Isolated
  threads run the Agent at full capability (all tools, memory write, proactive) in a
  separate context. They do NOT reuse the minimal quick-chat profile. This is the
  reason P2 carries the core-loop generalization (§3.3, §7, §12).
- **Admin-only.** Only an admin declares external clients and manages their keys. Tool
  calls made on a client's behalf act as the client's owner user.
- **Naming.** `external client` in code and UI; tables `api_clients`, `api_keys`,
  `api_conversations`, `api_requests`; routes `/api/v1/*` (external) and
  `/api/api-clients/*` (management).
