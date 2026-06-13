---
title: Backend (_server.js)
description: Add server-side logic to mini-apps with Hono.
---

Mini-apps can have a backend by creating a `_server.js` file. The backend runs server-side in Hivekeep's process and is accessible via a scoped API.

## Quick Start

Create `_server.js` via the `write_mini_app_file` tool:

```javascript
export default function(ctx) {
  const app = new ctx.Hono();

  app.get("/hello", (c) => {
    return c.json({ message: "Hello from the backend!" });
  });

  return app;
}
```

The file must default-export a function that receives a context object and returns a [Hono](https://hono.dev) app (or any object with a `.fetch()` method).

:::note
`_server.ts` is also supported. Hivekeep will use whichever exists.
:::

## Lifecycle Exports

Besides the default export, a backend can export lifecycle hooks. All exports are optional, but at least one of `default` / `onStart` / `onStop` is required:

```javascript
export async function onStart(ctx) {
  // Runs when the backend instance loads (boot or first request).
  // Start jobs, warm caches, open watchers here.
}

export async function onStop(ctx) {
  // Runs before the instance is unloaded or reloaded (5s budget).
  // ctx.timers and ctx.schedule jobs are cleaned up automatically.
}

export function onClientEvent(ctx, event, data, meta) {
  // Receives events sent from the UI via Hivekeep.events.send().
  // meta = { userId, userName }. The return value is sent back to the caller.
  if (event === "vote") return { accepted: true };
}
```

## Background Mode

By default a backend is loaded lazily on its first HTTP request and stays passive between requests. Declare background mode in `app.json` to make it a **live service**:

```json
{ "background": true }
```

A background backend:

- loads at server boot (and `onStart` runs immediately),
- is restarted automatically after every `_server.js` / `app.json` edit (stop → reload → `onStart`),
- keeps its scheduled jobs and timers running with no UI open.

## Scheduled Jobs

`ctx.schedule(name, cronPattern, handler)` registers a named cron job (standard cron syntax, evaluated with the server's timezone):

```javascript
export async function onStart(ctx) {
  ctx.schedule("poll-feed", "*/15 * * * *", async () => {
    const res = await ctx.fetch("https://api.example.com/feed");
    const items = await res.json();
    await ctx.storage.set("items", items);
    ctx.events.emit("feed:updated", { count: items.length });
  });
}
```

- Max 10 jobs per app; runs are overlap-protected and spaced at least 15 seconds apart.
- Re-registering an existing name replaces the job. `ctx.schedule(...)` returns `{ stop() }`.
- Jobs stop automatically when the instance stops or reloads.
- Handler errors land in the app console (`get_mini_app_console`).

## Reacting to Platform Events

`ctx.on(eventType, handler)` subscribes to Hivekeep's platform events — the same catalogue the app sends over SSE (see [the SSE reference](https://github.com/MarlBurroW/hivekeep/blob/main/api.md)). This is what makes a background app **reactive** instead of having to poll: run something the moment a task finishes, a message arrives on a channel, a contact is created, a cron fires.

```javascript
export async function onStart(ctx) {
  ctx.on("task:done", (event) => {
    // event = { type, agentId?, data }
    ctx.notify("Task finished", String(event.data.taskId));
  });

  ctx.on("channel:message-received", (event) => {
    ctx.storage.set("lastInbound", event.data);
    ctx.events.emit("inbound", event.data); // forward to the open UI
  });
}
```

- Gated by the `events:<prefix>` permission — `events:task` covers `task:*`, `events:channel` covers `channel:*`, etc. Declare them in `app.json`.
- The handler receives `{ type, agentId?, data }`. Returns an unsubscribe function; all subscriptions are torn down automatically on reload/stop. Max 30 per app.
- High-frequency / internal events are **not** subscribable (`chat:token`, `queue:update`, `*-token-usage`, …) — a per-token handler would be a footgun.
- **Avoid feedback loops**: a handler reacting to an event that itself triggers that event (e.g. handling `contact:updated` by updating a contact) will recurse. The action capabilities are rate-limited, but design handlers to be idempotent / guarded.

## Timers and Cancellation

Never use the global `setInterval`/`setTimeout` in a backend — they would survive reloads and leak. Use the managed equivalents:

```javascript
const id = ctx.timers.setInterval(() => { /* ... */ }, 60_000); // min 1s
ctx.timers.clearInterval(id);

// ctx.signal aborts when the instance stops — pass it to long work:
await fetch(url, { signal: ctx.signal });
```

All managed timers are cleared automatically when the instance stops.

## Notifications

`ctx.notify(title, body?)` sends a persistent platform notification (notification center, SSE, and the user's configured external channels). Rate-limited to 10 per hour per app.

```javascript
await ctx.notify("Price alert", "AAPL crossed $200");
```

## Capability Permissions

Backends can access platform capabilities after the user approves them. Declare what you need in `app.json`:

```json
{
  "background": true,
  "permissions": ["llm", "agent:inform", "secrets:OPENWEATHER_API_KEY"]
}
```

When the app panel is open and permissions are missing, Hivekeep shows an approval banner. Until granted, the matching `ctx` members throw a descriptive error.

| Capability | Permission | Limit | Description |
|------------|------------|-------|-------------|
| `ctx.secrets.get(name)` | `secrets:<NAME>` (per secret) | — | Read a vault secret. Never store API keys in code or storage. |
| `ctx.llm.complete(prompt, opts?)` | `llm` | 30/hour | One-shot LLM completion via the platform's providers (defaults to the maintainer Agent's model). `opts`: `{ model, providerId, maxTokens }`. |
| `ctx.agent.inform(text)` | `agent:inform` | 10/hour | Drop an informational message into the maintainer Agent's queue. |
| `ctx.agent.task(description, opts?)` | `agent:task` | 5/hour | Spawn an async sub-task on the maintainer Agent. Returns `{ taskId }`. |
| `ctx.channels.list()` / `.send(channelId, chatId, text)` / `.sendToContact(contact, platform, text)` | `channels:send` | 20/hour | Send through the platform's existing messaging channels (Telegram, Discord, Twilio SMS, plugin platforms…). `sendToContact` resolves the contact's platform identifier and an active channel automatically. Prefer this over re-implementing a provider API with raw secrets: one permission, audited sends, no credentials in the app. |
| `ctx.on(eventType, handler)` | `events:<prefix>` (e.g. `events:task`) | 30 subscriptions | Subscribe to platform events ([Reacting to Platform Events](#reacting-to-platform-events)). |

`ctx.permissions` exposes `{ requested, granted, has(permission) }` for introspection.

## Outbound HTTP and Files

These are always available (no permission needed):

- `ctx.fetch(url, options?)` — SSRF-guarded fetch: http/https only, private/internal hosts blocked, 30s default timeout.
- `ctx.files` — file storage scoped to the app's `_data/` directory (excluded from snapshots and rollbacks):

```javascript
await ctx.files.write("cache/feed.json", JSON.stringify(items));
const raw = await ctx.files.read("cache/feed.json"); // string | null
await ctx.files.list();    // [{ path, size }]
await ctx.files.exists("cache/feed.json");
await ctx.files.delete("cache/feed.json");
```

## Backend Context

| Property | Type | Description |
|----------|------|-------------|
| `ctx.Hono` | `class` | Hono constructor (no import needed) |
| `ctx.storage` | `object` | Key-value storage scoped to this app (see [Storage](#storage)) |
| `ctx.events` | `object` | SSE event emitter (see [Real-Time Events](#real-time-events-sse)) |
| `ctx.appId` | `string` | The mini-app's ID |
| `ctx.agentId` | `string` | The maintainer Agent's ID |
| `ctx.appName` | `string` | The mini-app's display name |
| `ctx.version` | `number` | App version this instance was loaded from |
| `ctx.background` | `boolean` | Whether `app.json` declares `"background": true` |
| `ctx.signal` | `AbortSignal` | Aborted when the instance stops (see [Timers](#timers-and-cancellation)) |
| `ctx.timers` | `object` | Managed timers, auto-cleared on stop (see [Timers](#timers-and-cancellation)) |
| `ctx.schedule` | `function` | Named cron jobs (see [Scheduled Jobs](#scheduled-jobs)) |
| `ctx.on` | `function` | Subscribe to platform events (see [Reacting to Platform Events](#reacting-to-platform-events)) |
| `ctx.notify` | `function` | Platform notifications (see [Notifications](#notifications)) |
| `ctx.fetch` | `function` | SSRF-guarded outbound HTTP (see [Outbound HTTP and Files](#outbound-http-and-files)) |
| `ctx.files` | `object` | Scoped `_data/` file storage (see [Outbound HTTP and Files](#outbound-http-and-files)) |
| `ctx.secrets` / `ctx.llm` / `ctx.agent` / `ctx.channels` | `object` | Permission-gated capabilities (see [Capability Permissions](#capability-permissions)) |
| `ctx.permissions` | `object` | `{ requested, granted, has() }` introspection |
| `ctx.log` | `object` | Scoped logger (see [Logging](#logging)) |

## Routes

Backend routes are served at:

```
/api/mini-apps/<appId>/api/*
```

Define routes using standard Hono patterns:

```javascript
export default function(ctx) {
  const app = new ctx.Hono();

  app.get("/items", async (c) => {
    const items = await ctx.storage.get("items") ?? [];
    return c.json(items);
  });

  app.post("/items", async (c) => {
    const body = await c.req.json();
    const items = await ctx.storage.get("items") ?? [];
    items.push({ id: Date.now(), ...body });
    await ctx.storage.set("items", items);
    return c.json({ success: true });
  });

  app.delete("/items/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const items = await ctx.storage.get("items") ?? [];
    await ctx.storage.set("items", items.filter(i => i.id !== id));
    return c.json({ success: true });
  });

  return app;
}
```

## Frontend Access

From React, use the `useApi` hook:

```jsx
import { useApi } from "@hivekeep/react";

function ItemList() {
  const { data: items, loading, error, refetch } = useApi("/items");

  const addItem = async (name) => {
    await Hivekeep.api.post("/items", { name });
    refetch();
  };

  // ...
}
```

The `useApi` hook accepts an optional second argument with `method`, `body`, `headers`, and `enabled` options. Pass `null` as the path to skip fetching.

Or use the raw API client directly:

```javascript
// GET + parse JSON
const items = await Hivekeep.api.get("/items");

// POST JSON
await Hivekeep.api.post("/items", { name: "New item" });

// PUT, PATCH, DELETE
await Hivekeep.api.put("/items/123", { name: "Updated" });
await Hivekeep.api.patch("/items/123", { name: "Patched" });
await Hivekeep.api.delete("/items/123");

// Raw fetch (returns Response object)
const response = await Hivekeep.api("/items", { method: "GET" });
```

## Real-Time Events (SSE)

The backend can push events to the frontend in real-time using `ctx.events`.

### Backend: Emit Events

```javascript
export default function(ctx) {
  const app = new ctx.Hono();

  app.post("/process", async (c) => {
    const body = await c.req.json();

    // Emit progress events to all connected clients
    ctx.events.emit("progress", { step: 1, total: 3 });
    // ... do work ...
    ctx.events.emit("progress", { step: 2, total: 3 });
    // ... more work ...
    ctx.events.emit("progress", { step: 3, total: 3 });
    ctx.events.emit("done", { result: "Complete!" });

    return c.json({ success: true });
  });

  // Check how many clients are listening
  app.get("/listeners", (c) => {
    return c.json({ count: ctx.events.subscriberCount });
  });

  return app;
}
```

### Frontend: Subscribe with Hook

```jsx
import { useEventStream } from "@hivekeep/react";

function ProcessMonitor() {
  const { messages, connected, clear } = useEventStream("progress");

  // Or with a callback (no accumulation):
  useEventStream("done", (data) => {
    Hivekeep.toast(data.result, "success");
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <p key={i}>Step {msg.data.step}/{msg.data.total}</p>
      ))}
      <button onClick={clear}>Clear messages</button>
    </div>
  );
}
```

Each message in `messages` has the shape `{ event, data, ts }`.

### Frontend: Subscribe with SDK

```javascript
// Listen for a specific event
Hivekeep.events.on("progress", (data) => {
  console.log(`Step ${data.step}/${data.total}`);
});

// Listen for all events
Hivekeep.events.subscribe(({ event, data }) => {
  console.log(event, data);
});

// Check connection status
console.log(Hivekeep.events.connected);

// Disconnect
Hivekeep.events.close();
```

### Targeting a Single User

`ctx.events.emit(event, data, { userId })` delivers only to that user's connections (useful for per-user state in shared apps):

```javascript
ctx.events.emit("your-turn", { board }, { userId: meta.userId });
```

### Frontend → Backend Events

The upstream half of the realtime channel: the UI sends an event, the backend's `onClientEvent` export handles it and can answer.

```javascript
// Frontend
const ack = await Hivekeep.events.send("vote", { choice: "A" });
// ack = { handled: true, result: { accepted: true } }

// or from React:
const { send } = useEventStream();
await send("vote", { choice: "A" });
```

```javascript
// Backend (_server.js)
export function onClientEvent(ctx, event, data, meta) {
  if (event === "vote") {
    ctx.events.emit("votes-changed", { by: meta.userName });
    return { accepted: true };
  }
}
```

## Storage

The backend shares the same storage namespace as the frontend. Data written by one is readable by the other.

### Backend Storage API

| Method | Returns | Description |
|--------|---------|-------------|
| `ctx.storage.get(key)` | `Promise<unknown \| null>` | Get a value (auto JSON-parsed) |
| `ctx.storage.set(key, value)` | `Promise<void>` | Set a value (auto JSON-serialized) |
| `ctx.storage.delete(key)` | `Promise<boolean>` | Delete a key |
| `ctx.storage.list()` | `Promise<{ key, size }[]>` | List all keys with sizes |
| `ctx.storage.clear()` | `Promise<number>` | Delete all keys, returns count |

```javascript
// Backend
await ctx.storage.set("config", { theme: "dark" });
const keys = await ctx.storage.list();
// [{ key: "config", size: 22 }]

// Frontend
const [config] = useStorage("config");
// config === { theme: "dark" }
```

## Caching & Invalidation

Backends are cached by version number. When you update `_server.js` via `write_mini_app_file`, the running instance is stopped cleanly (`onStop`, jobs and timers cleared) and reloaded — immediately for background apps, on the next request otherwise. No manual restart needed.

Use the `get_mini_app_backend_status` tool to inspect the live instance: loaded state, background mode, scheduled jobs with next run times, active timers, SSE subscribers, and the permission state.

## Logging

```javascript
ctx.log.info("Processing request");
ctx.log.warn("Something looks off");
ctx.log.error("Something went wrong:", err.message);
ctx.log.debug("Received data:", data);
```

Logs appear in Hivekeep's server logs tagged with the app ID, and `info`/`warn`/`error` entries also land in the app console (readable with `get_mini_app_console`, marked `source: backend`). The logger accepts simple string arguments (not structured objects like pino).
