---
title: SDK Reference
description: Complete Hivekeep mini-app SDK API reference.
---

The Hivekeep SDK (`hivekeep-sdk.js`) is the low-level API that powers the React hooks. You can use it directly for non-React apps or advanced use cases.

## Hivekeep Global Object

After the SDK loads, the `Hivekeep` global is available.

### Lifecycle

```javascript
Hivekeep.ready()  // Signal that the app has finished loading
```

:::note
`ready()` is a method you call once your app is initialized, not a boolean property. The parent waits for this signal before showing the app.
:::

### App Info

```javascript
Hivekeep.app
// { id, name, slug, agentId, agentName, agentAvatarUrl, isFullPage, locale, user }

Hivekeep.agent       // { id, name, avatarUrl }
Hivekeep.user      // { id, name, pseudonym, locale, timezone, avatarUrl }
Hivekeep.locale    // string — current UI language code (e.g. 'en', 'fr')
Hivekeep.version   // string — SDK version
Hivekeep.isFullPage // boolean — whether the app is in full-page mode
```

### Theme

```javascript
Hivekeep.theme       // { mode: "light"|"dark", palette: string }
Hivekeep.on("theme-changed", ({ mode, palette }) => { ... })
```

### Events

Listen for parent events or emit your own:

```javascript
Hivekeep.on(eventName, callback)   // Listen for events from the parent
Hivekeep.emit(eventName, data?)    // Send events to the parent
```

**Built-in event names:**

| Event | Description |
|---|---|
| `theme-changed` | Theme mode or palette changed |
| `app-meta` | App metadata updated |
| `locale-changed` | UI language changed |
| `fullpage-changed` | Full-page mode toggled |
| `shared-data` | Data received from another mini-app |

## Storage

Persistent key-value storage (server-side, max 64KB per value, 500 keys per app).

```javascript
await Hivekeep.storage.get(key)      // → value | null
await Hivekeep.storage.set(key, value)  // JSON-serializable
await Hivekeep.storage.delete(key)   // → boolean (true if deleted)
await Hivekeep.storage.list()        // → [{ key, size }]
await Hivekeep.storage.clear()       // → number (keys cleared)
```

:::note
`list()` takes no arguments and returns objects with `key` and `size` (bytes), not just key strings.
:::

## Navigation & Display

```javascript
Hivekeep.navigate(path)          // Navigate the parent Hivekeep UI to a path
Hivekeep.fullpage(bool)          // Toggle full-page or side-panel mode
Hivekeep.setTitle(title)         // Dynamically update the panel header title
Hivekeep.setBadge(value)         // Set sidebar badge (number, string, or null to clear)
Hivekeep.resize(width?, height?) // Request panel resize (320-1200px width, 200-2000px height)
Hivekeep.openApp(slug)           // Open another mini-app from the same Agent by slug
```

## Messaging

```javascript
await Hivekeep.sendMessage(text, options?)
// Send a message to the Agent's conversation
// options: { silent?: boolean }
// Rate limited: 5 per 30s

await Hivekeep.conversation.history(limit?)
// Get recent messages (default 20, max 100)
// Returns: [{ id, role, content, createdAt, sourceType }]

await Hivekeep.conversation.send(text, options?)
// Alias of sendMessage
```

## Memory

```javascript
await Hivekeep.memory.search(query, limit?)
// Semantic search Agent memories (default 20, max 50)
// Returns: [{ id, content, category, subject, score, updatedAt }]

await Hivekeep.memory.store(content, { category?, subject? })
// Store a new memory
// category: "fact" | "preference" | "decision" | "knowledge" (default)
// Max 2000 chars
// Returns: { id, content, category, subject }
```

## Clipboard

```javascript
await Hivekeep.clipboard.write(text)  // Copy text to system clipboard (bypasses iframe restrictions)
await Hivekeep.clipboard.read()       // Read text from system clipboard (may require permission)
```

## Notifications

```javascript
await Hivekeep.notification(title, body?)  // → boolean
// Shows a browser notification via the parent window
```

## Toast & Dialogs

These are methods on the `Hivekeep` object directly:

```javascript
Hivekeep.toast("Saved!", "success")
// type: "info" (default) | "success" | "warning" | "error"

const ok = await Hivekeep.confirm("Delete this item?", {
  title: "Confirm",
  confirmText: "Delete",
  cancelText: "Cancel",
})
// Returns: boolean

const name = await Hivekeep.prompt("Enter your name", {
  title: "Input",
  placeholder: "John Doe",
  defaultValue: "",
  confirmText: "OK",
  cancelText: "Cancel",
})
// Returns: string | null
```

:::note
In the React layer (`@hivekeep/react`), `toast`, `confirm`, and `prompt` are re-exported as standalone functions for convenience. Under the hood they call these same SDK methods.
:::

## Keyboard Shortcuts

```javascript
const unregister = Hivekeep.shortcut("ctrl+k", callback)
// Returns unregister function. Pass null callback to remove.
// Examples: "ctrl+k", "meta+shift+p", "escape"
```

## File Downloads

```javascript
await Hivekeep.download(filename, content, mimeType?)
// content: string, object (auto-JSON), Blob, or ArrayBuffer
// mimeType is auto-detected if omitted
```

## Inter-App Communication

```javascript
Hivekeep.share(targetSlug, data)
// Share JSON data with another mini-app and open it
// Note: this is synchronous (fire-and-forget)

Hivekeep.on("shared-data", ({ from, fromName, data, ts }) => { ... })
// Receive shared data from another app

await Hivekeep.apps.list()     // List all mini-apps from the same Agent
await Hivekeep.apps.get(appId) // Get details of a specific app
// Returns: { id, name, slug, description, icon, version }
```

## HTTP Proxy

Make external HTTP requests via Hivekeep's server (bypasses CORS). Rate limited: 60 req/min, 5MB max, 15s timeout.

```javascript
const res = await Hivekeep.http(url, options?)
const data = await Hivekeep.http.json(url)
const data = await Hivekeep.http.post(url, body)
```

## Backend API Client

Call routes defined in `_server.js`:

```javascript
const data = await Hivekeep.api.get("/path")         // GET → JSON
const data = await Hivekeep.api.post("/path", body)   // POST → JSON
const data = await Hivekeep.api.put("/path", body)     // PUT → JSON
const data = await Hivekeep.api.patch("/path", body)   // PATCH → JSON
const data = await Hivekeep.api.delete("/path")        // DELETE → JSON
const data = await Hivekeep.api.json("/path", headers?) // GET + JSON parse
const res = await Hivekeep.api("/path", opts?)          // Raw Response
```

## Platform API Client

Call Hivekeep's **own** REST API — the same endpoints the settings pages use — to build a mini-app that manages a platform resource (a contacts manager, a crons board, a projects dashboard) instead of sending the user into settings.

```javascript
const { contacts } = await Hivekeep.platform.get("/contacts")
await Hivekeep.platform.post("/contacts", { firstName: "Ada", lastName: "Lovelace" })
await Hivekeep.platform.patch("/contacts/" + id, { lastName: "King" })
await Hivekeep.platform.delete("/contacts/" + id)
const res = await Hivekeep.platform("/contacts", opts?)  // Raw Response
```

Same shorthands as `Hivekeep.api` (`get/post/put/patch/delete/json`), but proxied to `/api/<resource>` instead of your backend.

**Permissions.** Each call is gated by a `platform:<resource>:<read|write>` permission you declare in `app.json`; the user approves them in the app's permission banner. The resource is the first path segment, and a `write` grant implies `read`:

```json
{ "permissions": ["platform:contacts:read", "platform:contacts:write"] }
```

| Call | Needs |
|------|-------|
| `platform.get("/contacts")` | `platform:contacts:read` |
| `platform.post("/contacts", …)` | `platform:contacts:write` |
| `platform.delete("/crons/123")` | `platform:crons:write` |

Discover each resource's routes and payload shapes in [the API reference](https://github.com/MarlBurroW/hivekeep/blob/main/api.md). A few resources are never reachable through the gateway: `auth`, `vault` (secret values), `database`, `users`, and `mini-apps` (so an app can't grant itself permissions).

:::caution
The platform API runs with **your** privileges. Only install mini-apps you trust with the resources they request, and review the permission banner before approving. (Mini-app iframes are sandboxed to their own namespace server-side, but a self-hosted instance still runs the app code you install.)
:::

## Server-Sent Events

Subscribe to real-time events from the backend (`_server.js` using `ctx.events.emit()`).

```javascript
Hivekeep.events.on("eventName", (data) => { ... })
Hivekeep.events.subscribe((event) => { ... })  // all events — { event, data }
Hivekeep.events.send("eventName", data)        // → backend onClientEvent(); resolves { handled, result }
Hivekeep.events.close()
Hivekeep.events.connected  // boolean
```

## CSS Design System

A design system CSS is auto-injected into every mini-app.

### CSS Variables

```css
/* Core */
var(--color-primary)
var(--color-background)
var(--color-foreground)
var(--color-muted)
var(--color-card)
var(--color-border)

/* Semantic */
var(--color-secondary)
var(--color-accent)
var(--color-destructive)
var(--color-success)
var(--color-warning)
var(--color-info)

/* Charts */
var(--color-chart-1) through var(--color-chart-5)

/* Gradients & effects */
var(--color-gradient-start)
var(--color-gradient-mid)
var(--color-gradient-end)
var(--color-glow-1) through var(--color-glow-3)
var(--color-glass-bg)
var(--color-glass-strong-bg)

/* Typography */
var(--font-sans)
var(--font-mono)

/* Radius */
var(--radius-sm) through var(--radius-full)

/* Shadows */
var(--shadow-xs) through var(--shadow-xl)
```

### Utility Classes

**Layout (Tailwind-like):** `.flex`, `.flex-col`, `.grid`, `.grid-cols-2`, `.items-center`, `.justify-between`, `.gap-4`, `.p-4`, `.m-4`, `.w-full`, `.max-w-md`, `.space-y-4`, `.overflow-auto`.

**Typography:** `.text-sm`, `.text-xl`, `.font-bold`, `.text-center`.

**Appearance:** `.bg-card`, `.bg-muted`, `.border`, `.rounded-lg`, `.shadow-md`.

**Components:** `.btn`, `.btn-primary`, `.card`, `.input`, `.badge`, `.table`, `.spinner`.

**Glass/Effects:** `.glass-strong`, `.surface-card`, `.gradient-primary`, `.btn-shine`, `.card-hover`.

### Responsive Utilities

Breakpoints: `sm` (≥640px), `md` (≥768px), `lg` (≥1024px), `xl` (≥1280px).

Prefix any utility: `md:grid-cols-2`, `lg:hidden`, `sm:flex-row`.

```html
<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
```

### Animations

`.animate-fade-in`, `.animate-fade-in-up`, `.animate-slide-in-left`, `.animate-scale-in`, `.animate-bounce-in`, `.animate-shake`, `.animate-spin`, `.animate-wiggle`, `.animate-levitate`.

Modifiers: `.delay-1` to `.delay-10`, `.duration-75` / `.duration-1000`.

Transitions: `.transition-all`, `.transition-colors`, `.ease-bounce`, `.ease-spring`.

All animations respect `prefers-reduced-motion`.

## TypeScript Definitions

Full type definitions are available at:

- `/api/mini-apps/sdk/hivekeep-sdk.d.ts`
- `/api/mini-apps/sdk/hivekeep-react.d.ts`
- `/api/mini-apps/sdk/hivekeep-components.d.ts`
