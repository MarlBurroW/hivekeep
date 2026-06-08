---
title: Plugin API Reference
description: Complete API reference for Hivekeep plugin development.
---

## Plugin Context

The `PluginContext` object is passed to your plugin's default-exported entry function. It provides access to Hivekeep services. It is generic over the shape of your resolved config (`PluginContext<Config>`), so `ctx.config.<field>` can be strongly typed.

```typescript
interface PluginContext<Config = Record<string, unknown>> {
  config: Config
  log: PluginLogger
  storage: PluginStorageAPI
  http: PluginHTTPClient
  vault: PluginVaultAPI
  manifest: PluginManifestInfo
  cards: PluginCardsAPI
}
```

All seven members are always present. Plugins typically use one or two of them.

### `ctx.config`

An object containing resolved configuration values. Secret values are decrypted automatically. Defaults from `plugin.json` are applied for unset fields.

Pass your config shape into the generic for typed access. The runtime never validates against the generic (Hivekeep already validated the values against the manifest's `config` schema before instantiating the context). The generic is purely a type-side convenience.

```typescript
interface MyConfig { apiKey: string; units?: 'metric' | 'imperial' }

export default function (ctx: PluginContext<MyConfig>): PluginExports {
  const { apiKey, units = 'metric' } = ctx.config  // typed
  // ...
}
```

### `ctx.log`

A scoped logger tagged with your plugin name. Supports structured logging:

```typescript
ctx.log.info('Processing request')
ctx.log.error({ err, userId }, 'Failed to fetch data')
ctx.log.debug({ response }, 'API response received')
ctx.log.warn('Deprecated feature used')
```

```typescript
interface PluginLogger {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}
```

### `ctx.storage`

Persistent key-value store scoped to your plugin. Values are JSON-serialized. Backed by SQLite.

```typescript
interface PluginStorageAPI {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  clear(): Promise<void>
}
```

```typescript
// Examples
await ctx.storage.set('lastSync', Date.now())
const lastSync = await ctx.storage.get<number>('lastSync')
await ctx.storage.delete('lastSync')
const keys = await ctx.storage.list('cache:')
await ctx.storage.clear()
```

### `ctx.http`

A sandboxed HTTP client. Only URLs matching declared `permissions` (`http:*.example.com`) are allowed. Attempts to access undeclared hosts throw a `PluginPermissionError` (its `code` is `PLUGIN_PERMISSION_DENIED`). Note that only `ctx.http.fetch` is gated; a raw `globalThis.fetch` from plugin code is not sandboxed.

```typescript
interface PluginHTTPClient {
  fetch(url: string, init?: RequestInit): Promise<Response>
}
```

```typescript
// Must declare "http:api.example.com" in permissions
const res = await ctx.http.fetch('https://api.example.com/data', {
  headers: { 'Authorization': `Bearer ${ctx.config.apiKey}` },
})
const data = await res.json()
```

### `ctx.vault`

Encrypted secret storage. Reads are permissive (you must already know the key, typically handed to your plugin via its config); writes, deletes, and key listing are strictly scoped to a `plugin:<your-plugin-name>:` namespace so plugins cannot touch each other's secrets or Hivekeep's own.

```typescript
interface PluginVaultAPI {
  getSecret(key: string): Promise<string | null>                  // read any key (you must know it)
  setSecret(key: string, value: string, description?: string): Promise<void>  // scoped
  deleteSecret(key: string): Promise<void>                        // scoped
  listKeys(): Promise<string[]>                                   // your plugin's keys, unprefixed
}
```

### `ctx.cards`

Emit and update rich, live-updating cards in the chat. The plugin name is captured at context creation, so a plugin can only emit cards under its own identity. See [Plugin Cards](#plugin-cards) below.

```typescript
interface PluginCardsAPI {
  emit(params: {
    agentId: string
    cardType: string
    layout: PluginCardPrimitive[]
    initialState: Record<string, unknown>
  }): Promise<{ messageId: string; cardInstanceId: string }>
  update(params: {
    cardInstanceId: string
    state: Record<string, unknown>
  }): Promise<void>
}
```

### `ctx.manifest`

Read-only manifest info, just `{ name, version }`:

```typescript
interface PluginManifestInfo {
  name: string
  version: string
}
```

## Plugin Exports

The object your default-exported function returns. Every field is optional; plugins typically declare one or two.

```typescript
interface PluginExports {
  tools?: Record<string, ToolRegistration>
  providers?: PluginProvider[]
  channels?: Record<string, ChannelAdapter>
  hooks?: { [H in HookName]?: HookHandler<H> }
  onCardAction?(ctx: PluginCardActionContext): Promise<PluginCardActionResult>
  activate?(): Promise<void>
  deactivate?(): Promise<void>
}
```

> **`providers` is an array, not a record.** It is a list of native provider instances (`PluginProvider[]`), each implementing one of the nine native provider interfaces. The loader auto-detects each provider's family by which method it exposes (see [Providers](#providers) below). A `Record` shape will not load.

### Tool Registration

```typescript
interface ToolRegistration {
  create: (execCtx: ToolExecutionContext) => Tool
  availability: Array<'main' | 'sub-agent'>
  defaultDisabled?: boolean
  readOnly?: boolean
  concurrencySafe?: boolean
  destructive?: boolean
  condition?: (ctx: ToolExecutionContext) => boolean
  label?: string | Record<string, string>
}
```

| Field | Default | Effect |
|---|---|---|
| `create` | required | Factory bound to a fresh `ToolExecutionContext` per Agent turn; returns the `tool()`. |
| `availability` | required | Where the tool is exposed: `'main'`, `'sub-agent'`, or both. |
| `defaultDisabled` | `false` | If true, an Agent must opt in before the tool is exposed. (Host forces this to `true` for plugin tools.) |
| `readOnly` | `false` | Declares the tool never mutates external state. Used (with `concurrencySafe`) to batch reads. |
| `concurrencySafe` | `false` | Allows the executor to run this tool in parallel with other concurrency-safe tools in the same step. |
| `destructive` | `false` | Marks the tool as deleting / overwriting data the user cares about. Surfaced as a UI confirmation; does not affect scheduling. |
| `condition` | none | Predicate evaluated at resolve time. Return `false` to omit the tool for a particular context. |
| `label` | none | Human-readable label for the Tools settings list. A single string, or a locale map (`{ en, fr }`). Falls back to the prefix-stripped tool name. |

Tools use the `tool()` helper exported by [`@hivekeep/sdk`](https://www.npmjs.com/package/@hivekeep/sdk) with [Zod](https://zod.dev/) schemas for parameters. The host prefixes each registered tool name to `plugin_<plugin-name>_<tool>`.

### Hook Names

The SDK's typed `HookPayloadMap` defines exactly four hooks. These are the only hooks that are both first-class typed and actually fired by the host:

```typescript
type HookName =
  | 'beforeChat'
  | 'afterChat'
  | 'beforeToolCall'
  | 'afterToolCall'
```

Each handler receives a payload typed by its hook name and may return a modified payload (passed to the next handler) or `void` (keeps the previous payload).

```typescript
type HookHandler<H extends HookName = HookName> = (
  context: HookPayloadMap[H],
) => HookPayloadMap[H] | void | Promise<HookPayloadMap[H] | void>
```

| Hook | Fired | Payload (beyond `agentId`, `userId?`) |
|---|---|---|
| `beforeChat` | Once per Agent turn, before the system prompt is assembled. | `message` |
| `afterChat` | Once per Agent turn, after the assistant response is finalized. | `message`, `response` |
| `beforeToolCall` | Before each tool call in a turn. | `toolName`, `toolArgs`, `taskId?`, `isSubAgent`, `channelOriginId?`, `cronId?`, `ticketId?` |
| `afterToolCall` | After each tool call. | the `beforeToolCall` fields plus `toolResult` |

> **Runtime-tolerated extras.** The host's manifest/exports validator also accepts `beforeCompacting`, `afterCompacting`, `onTaskSpawn`, and `onCronTrigger` without warning, but they are **not** in `HookPayloadMap` (so they are untyped) and the host does **not** currently fire any of them. Registering a handler for one of these names is silently a no-op today. Stick to the four typed hooks above.

## Providers

A plugin contributes native AI providers via `exports.providers` (a `PluginProvider[]`). Each entry implements one of the nine native provider interfaces (the very same interfaces back Hivekeep's built-in providers, so there is no separate "plugin shape"). The loader auto-detects each provider's family by method presence, then prefixes the provider's `type` to `plugin:<plugin-name>:<type>` so it cannot collide with a built-in.

```typescript
type PluginProvider =
  | LLMProvider
  | EmbeddingProvider
  | ImageProvider
  | SearchProvider
  | TTSProvider
  | STTProvider
  | EmailProvider
  | ContactsProvider
  | CalendarProvider
```

| Family | Interface | Detected by | Defining methods (beyond `type` / `displayName` / `configSchema` / `authenticate`) |
|---|---|---|---|
| LLM | `LLMProvider` | `chat` | `listModels`, `chat` (streams `ChatChunk`) |
| Embedding | `EmbeddingProvider` | `embed` | `listModels`, `embed` |
| Image | `ImageProvider` | `generate` | `listModels`, `generate`, `describeModel?` |
| Search | `SearchProvider` | `search` | static `capabilities`, `search` (no `listModels`) |
| TTS | `TTSProvider` | `speak` | static `capabilities`, `listVoices`, `speak` |
| STT | `STTProvider` | `transcribe` | static `capabilities`, `listModels`, `transcribe` |
| Email | `EmailProvider` | `sendMessage` + `listMessages` | static `capabilities`, `oauth?`, `listMessages`, `getMessage`, `sendMessage`, `searchMessages?`, `getAttachment?` |
| Contacts | `ContactsProvider` | `listContacts` + `getContact` | static `capabilities`, `oauth?`, `listContacts`, `getContact`, `searchContacts?` |
| Calendar | `CalendarProvider` | `listEvents` + `listCalendars` | static `capabilities`, `oauth?`, `listCalendars`, `listEvents`, `getEvent`, `createEvent?`, `updateEvent?`, `deleteEvent?` |

All provider interfaces extend `ProviderUIHints` (optional `noApiKey?`, `optionalApiKey?`, `apiKeyUrl?`, `lobehubIcon?`, `reactIcon?`, `brandColor?`) for the "add provider" picker. Email, Contacts, and Calendar providers may declare an `oauth: OAuthProfile` to use the host's generic OAuth2 flow instead of typed credentials.

```typescript
export default function (ctx: PluginContext): PluginExports {
  return { providers: [new MyMistralProvider(), new MyVoxtralSTTProvider()] }
}
```

See [Developing Plugins → Providers](/hivekeep/docs/plugins/developing/#providers) for worked examples, and the [Mistral provider tutorial](/hivekeep/docs/plugins/tutorial-mistral/) for a complete two-capability plugin.

## Plugin Cards

Cards are declarative, live-updating UI primitives a plugin emits into the chat (progress for a long task, structured data, action buttons). Emit them imperatively from inside a tool via `ctx.cards`, and handle button clicks via `exports.onCardAction`.

```typescript
type PluginCardPrimitive =
  | { type: 'header'; title: string; icon?: string; accent?: PluginCardVariant }
  | { type: 'info-grid'; columns?: 2 | 3; items: PluginCardInfoGridItem[] }
  | { type: 'status-banner'; label: string; sublabel?: string; variant?: PluginCardVariant; icon?: string; animated?: 'pulse' | 'shimmer' | 'spin' | 'none' }
  | { type: 'progress'; value?: number; max?: number; indeterminate?: boolean; label?: string }
  | { type: 'collapsible'; label: string; defaultOpen?: boolean; content: PluginCardPrimitive | PluginCardPrimitive[] }
  | { type: 'log-stream'; lines: string[]; autoscroll?: boolean; maxHeight?: number }
  | { type: 'action-row'; actions: PluginCardAction[] }
  | { type: 'markdown'; content: string }
  | { type: 'spinner'; label?: string }
  | { type: 'badge'; text: string; variant?: PluginCardVariant; icon?: string }
  | { type: 'divider'; label?: string }

type PluginCardVariant =
  | 'default' | 'success' | 'warning' | 'destructive' | 'primary' | 'muted'
```

The SDK exports a `card` builder with one helper per primitive (`card.header`, `card.infoGrid`, `card.statusBanner`, `card.progress`, `card.collapsible`, `card.logStream`, `card.actionRow`, `card.markdown`, `card.spinner`, `card.badge`, `card.divider`). String fields may contain `{{key}}` placeholders, interpolated against the card's state on each `ctx.cards.update`.

### `onCardAction`

When a user clicks an action-row button, Hivekeep calls your plugin's `onCardAction`:

```typescript
interface PluginCardActionContext {
  cardInstanceId: string
  actionId: string
  input?: string
  agentId: string
}

type PluginCardActionResult = { ok: true } | { ok: false; error: string }
```

```typescript
export default function (ctx: PluginContext): PluginExports {
  return {
    // tools that call ctx.cards.emit(...) / ctx.cards.update(...)
    async onCardAction({ actionId, cardInstanceId }) {
      if (actionId === 'cancel') {
        await cancelTask(cardInstanceId)
        return { ok: true }
      }
      return { ok: false, error: 'Unknown action' }
    },
  }
}
```

## Plugin Manifest Types

```typescript
interface PluginManifest {
  name: string
  version: string
  description: string
  main: string
  $schema?: string
  displayName?: string
  author?: string
  homepage?: string
  license?: string
  hivekeep?: string
  icon?: string             // emoji or path
  iconUrl?: string          // path to a logo asset (e.g. "logo.svg"), served via /api/plugins/:name/logo
  permissions?: string[]
  dependencies?: Record<string, string>   // other plugins by name → semver range
  config?: Record<string, PluginConfigField>
  channels?: Record<string, { configSchema?: ChannelConfigSchema }>
  tags?: string[]
}

interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select' | 'text' | 'password'
  label: string
  description?: string
  required?: boolean
  default?: string | number | boolean
  secret?: boolean
  options?: string[]       // select only
  min?: number             // number only
  max?: number             // number only
  step?: number            // number only
  placeholder?: string     // string, text
  pattern?: string         // string only
  rows?: number            // text only
}
```

## REST API

Plugin management is also available via the REST API:

**Plugin management:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plugins` | List all installed plugins with status |
| `POST` | `/api/plugins/:name/enable` | Enable a plugin |
| `POST` | `/api/plugins/:name/disable` | Disable a plugin |
| `GET` | `/api/plugins/:name/config` | Get plugin config (secrets masked) |
| `PUT` | `/api/plugins/:name/config` | Update plugin config |
| `POST` | `/api/plugins/install` | Install from git or npm (`{ source, url/package }`) |
| `DELETE` | `/api/plugins/:name` | Uninstall a plugin |
| `POST` | `/api/plugins/:name/update` | Update an installed plugin |
| `POST` | `/api/plugins/reload` | Reload all plugins |
| `GET` | `/api/plugins/updates` | Check for available plugin updates |
| `POST` | `/api/plugins/:name/update` | Update a plugin to latest version |
| `POST` | `/api/plugins/:name/health/reset` | Reset plugin health stats |

**Discovery (npm marketplace):**

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plugins/registry/npm-search` | Search the public npm registry for packages tagged with the `hivekeep-plugin` keyword (`?q=<query>`). Results are tagged with `installed: boolean`. Server-side cache: 5 min per query. |
| `GET` | `/api/plugins/version` | Get Hivekeep version for compatibility checks |

## Plugin Health Monitoring

Hivekeep tracks error statistics for each plugin. If a plugin's hooks or tools throw errors repeatedly, it is automatically disabled to protect system stability.

**Health stats** are included in every plugin summary (`GET /api/plugins`):

```typescript
interface PluginHealthStats {
  totalErrors: number        // Total errors since last reset
  consecutiveErrors: number  // Errors in a row (resets on success)
  lastError?: string         // Last error message with source
  lastErrorAt?: string       // ISO timestamp
  autoDisabled: boolean      // Whether circuit breaker triggered
  autoDisabledAt?: string    // When it was auto-disabled
}
```

**Circuit breaker:** After 10 consecutive hook errors, the plugin is automatically disabled and a `plugin:autoDisabled` SSE event is broadcast. To re-enable, use the UI toggle or `POST /api/plugins/:name/enable` (this resets health stats).

**Reset health stats** without disabling/re-enabling:

```bash
curl -X POST http://localhost:3000/api/plugins/my-plugin/health/reset
```

### Install from npm

```bash
curl -X POST http://localhost:3000/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source": "npm", "package": "hivekeep-plugin-weather"}'
```

### Install from Git URL (unpublished / private plugins)

```bash
curl -X POST http://localhost:3000/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source": "git", "url": "https://github.com/user/hivekeep-plugin-weather"}'
```
