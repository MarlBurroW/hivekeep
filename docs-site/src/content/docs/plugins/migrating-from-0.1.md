---
title: Migrating from 0.1
description: Update plugins written against @kinbot-developer/sdk 0.1 to the 0.2 contract.
---

If you wrote a plugin against `@kinbot-developer/sdk@0.1` (or against KinBot before that, when plugins reached into `@/server/...` paths), here's what changed and how to bring it forward to 0.2.

Most of these are mechanical edits — the runtime behaviour is identical or strictly improved. The only "you have to think about it" item is providers (see [§ Providers](#providers)).

## TL;DR

| Area | 0.1 | 0.2 |
|---|---|---|
| Import path | `from 'ai'` | `from '@kinbot-developer/sdk'` |
| `tool()` schema field | `parameters` | `inputSchema` |
| `PluginContext` | loose `config: any` | `PluginContext<Config>` generic |
| Vault access | `import { getSecretValue } from '@/server/services/vault'` | `ctx.vault.getSecret(key)` |
| Hook context | loose `HookContext` (with `[key: string]: unknown`) | `HookPayloadMap[H]` typed per hook |
| Plugin providers | `{ definition, displayName, capabilities, noApiKey?, apiKeyUrl? }` legacy `ProviderDefinition` | Native `LLMProvider` / `EmbeddingProvider` / `ImageProvider` (same shape as built-ins) |
| `PluginExports.providers` | `Record<string, PluginProviderRegistration>` | `PluginProvider[]` (flat list of native providers) |
| Card primitives | `Record<string, unknown>` | Strict `PluginCardPrimitive` discriminated union + `card.*` builders |
| `manifest.permissions` `http:*` | broken — silently rejected every call | works as a catch-all |

## Imports

Replace every `from 'ai'` import with `from '@kinbot-developer/sdk'`:

```diff
- import { tool } from 'ai'
- import { z } from 'zod'
+ import { tool, z } from '@kinbot-developer/sdk'
```

`zod` is now re-exported from the SDK so you don't carry your own dep.

If you reached into KinBot internals (`from '@/server/channels/adapter'`, `from '@/server/services/vault'`, etc.), switch those to the SDK as well:

```diff
- import type { ChannelAdapter, IncomingMessage } from '@/server/channels/adapter'
+ import type { ChannelAdapter, IncomingMessage } from '@kinbot-developer/sdk'
```

`@/server/...` paths are KinBot-internal — only the host can resolve them. Third-party plugins published on npm will fail to load if they import from there.

## Tools

The zod schema field on `tool()` is now `inputSchema`, not `parameters`:

```diff
  tool({
    description: 'Greet someone',
-   parameters: z.object({ name: z.string() }),
+   inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => ({ reply: `Hi ${name}` }),
  })
```

## PluginContext\<Config\>

`ctx.config` is now generic. Declare your config shape and `ctx.config.<field>` is typed:

```diff
+ interface MyConfig { apiKey: string; region?: 'eu' | 'us' }

- export default function (ctx) {
+ export default function (ctx: PluginContext<MyConfig>) {
-   const apiKey = ctx.config.apiKey as string
+   const apiKey = ctx.config.apiKey   // typed: string
  }
```

The runtime never validates against the generic — KinBot already validated against your manifest's `config` schema. The generic is purely for autocomplete.

## Vault

If you read secrets via the internal vault module, switch to `ctx.vault`:

```diff
- import { getSecretValue } from '@/server/services/vault'
- const token = await getSecretValue(cfg.authTokenVaultKey)
+ const token = await ctx.vault.getSecret(cfg.authTokenVaultKey)
```

`ctx.vault.getSecret(key)` is permissive — you read any vault key you know about (typically a key reference KinBot persisted from a `password`-type config field).

`ctx.vault.setSecret(key, value)` / `deleteSecret(key)` / `listKeys()` are scoped to a `plugin:<your-name>:` namespace. You cannot touch another plugin's secrets, even by guessing the prefix.

## Hooks

`HookContext` was a loose `{ kinId, userId?, taskId?, [key: string]: unknown }`. It's now a discriminated union keyed by hook name:

```diff
- import type { HookHandler } from '@/server/hooks/types'
+ import type { HookHandler } from '@kinbot-developer/sdk'

  hooks: {
-   afterChat: (ctx) => {
-     const response = ctx.response as string   // had to cast
-   },
+   afterChat: (ctx) => {
+     // ctx.message, ctx.response, ctx.kinId, ctx.userId — all typed
+   },
+   afterToolCall: (ctx) => {
+     // ctx.toolName, ctx.toolArgs, ctx.toolResult — all typed
+   },
  }
```

The four hook names that were declared but never fired in 0.1 (`beforeCompacting`, `afterCompacting`, `onTaskSpawn`, `onCronTrigger`) have been removed from the type. They never actually ran — handlers registered against them were silently dead. If you had such a handler, delete it.

## Providers

Plugin providers used to ship a `ProviderDefinition` wrapper:

```ts
// 0.1 — DELETED
providers: {
  mistral: {
    definition: {
      type: 'mistral',
      testConnection: async (config) => ({ valid: true }),
      listModels: async (config) => [{ id: 'mistral-medium', name: 'Mistral Medium', capability: 'llm' }],
    },
    displayName: 'Mistral',
    capabilities: ['llm'],
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
  },
}
```

That shape is **gone**. In 0.2 you implement the same native interfaces as the built-in providers:

```ts
// 0.2
import type { LLMProvider, ChatRequest, ChatChunk } from '@kinbot-developer/sdk'

class MistralProvider implements LLMProvider {
  readonly type = 'mistral'
  readonly displayName = 'Mistral'
  readonly apiKeyUrl = 'https://console.mistral.ai/api-keys'
  readonly configSchema = [
    { key: 'apiKey', type: 'secret', label: 'API Key', required: true },
  ] as const

  async authenticate(config) { return { valid: true } }
  async listModels(config) {
    return [{ id: 'mistral-medium', name: 'Mistral Medium', contextWindow: 32768 }]
  }

  async *chat(model, request: ChatRequest, config): AsyncIterable<ChatChunk> {
    // stream text-delta / tool-use / thinking-delta / thinking-signature,
    // finish with one finish chunk carrying { reason, usage }
  }
}

export default function (ctx) {
  return { providers: [new MistralProvider()] }
}
```

`PluginExports.providers` is now a **flat array** (`PluginProvider[]`) instead of a `Record`. The loader detects each provider's family by inspecting which method it implements (`chat` → LLM, `embed` → embedding, `generate` → image).

Why bother: a native `LLMProvider` does streaming, prompt caching, thinking, tool calls — the same surface the built-in Anthropic / OpenAI providers use. The legacy `{ testConnection, listModels }` shape only supported basic chat-completions, with no way to declare advanced features.

## Cards

If you emitted cards with `Record<string, unknown>[]` layouts, you can keep doing that — the new `PluginCardPrimitive` union accepts any object that matches one of the known `type` discriminants. But you'll get autocomplete and compile-time validation by switching to the `card.*` builders:

```diff
+ import { card } from '@kinbot-developer/sdk'

  ctx.cards.emit({
    kinId,
    cardType: 'progress',
    layout: [
-     { type: 'header', title: 'Working...' },
-     { type: 'progress', indeterminate: true },
+     card.header({ title: 'Working...' }),
+     card.progress({ indeterminate: true }),
    ],
    initialState: {},
  })
```

Hand-written literals still work — the builders are sugar, not gatekeepers.

## Permissions

`manifest.permissions: ["http:*"]` was silently broken in 0.1 — the matcher only recognized exact hosts and `*.domain.tld` subdomain patterns. In 0.2 the catch-all works:

```json
{
  "permissions": [
    "http:*",                  // any host (use sparingly)
    "http:api.example.com",    // exact
    "http:*.example.com"       // subdomains + apex
  ]
}
```

`ctx.http.fetch()` enforces these. A blocked call throws `PluginPermissionError` (`code: 'PLUGIN_PERMISSION_DENIED'`) with a message that suggests the right declaration. Raw `globalThis.fetch()` from inside your plugin is not blocked — `ctx.http.fetch` is opt-in hardening, not a sandbox.

## Manifest

Two small ergonomic improvements:

1. **JSON Schema** — add the `$schema` line to your `plugin.json` and any editor with JSON-Schema support (VSCode, JetBrains) autocompletes the manifest fields and surfaces typos inline.

   ```diff
    {
   +  "$schema": "https://unpkg.com/@kinbot-developer/sdk/schemas/plugin-manifest.schema.json",
      "name": "my-plugin",
      "version": "0.1.0",
   ```

2. **`kinbot` range** — declare which KinBot host versions your plugin targets so users don't try to load incompatible builds. `>=0.40.0` is the floor for the 0.2 SDK.

## Checklist

Done with your migration when:

- [ ] No `from 'ai'` left in your plugin's imports.
- [ ] No `from '@/server/...'` left in your plugin's imports.
- [ ] `tool()` calls use `inputSchema` (not `parameters`).
- [ ] Vault access goes through `ctx.vault.getSecret(...)`.
- [ ] Hook handlers don't cast away the payload type.
- [ ] Plugin providers implement `LLMProvider` / `EmbeddingProvider` / `ImageProvider` directly; `PluginExports.providers` is an array.
- [ ] `plugin.json` has a `$schema` line and an explicit `kinbot` range.
- [ ] `bun typecheck` passes.

Stuck on something not covered here? Open an issue at <https://github.com/MarlBurroW/kinbot/issues> with the plugin's source — the SDK's tests run against the `hello-kin` reference example, so anything matching that shape is guaranteed to load.
