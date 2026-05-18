# `@kinbot-developer/sdk`

Plugin SDK for [KinBot](https://github.com/MarlBurroW/kinbot). One package, every extension point.

```bash
bun add @kinbot-developer/sdk
# or
npm i @kinbot-developer/sdk
```

> KinBot's plugin loader resolves this package against the host install — declare it as a peer dep in your plugin's `package.json` so the host version is the one your code links against at runtime.

## What's in here

| Surface | What you get |
|---|---|
| **Tools** | `tool()` helper with INPUT inferred from a zod `inputSchema`, plus `z` re-exported. |
| **Channels** | `ChannelAdapter`, `IncomingMessage`, `OutboundMessageParams`, etc. — full adapter contract. |
| **Providers** | `LLMProvider`, `EmbeddingProvider`, `ImageProvider` — the **same** native interfaces KinBot's built-in Anthropic/OpenAI providers implement. Streaming `chat()` yielding `ChatChunk`s, prompt caching, thinking effort, tool use — all of it. |
| **Hooks** | `HookPayloadMap` discriminated union → each hook handler gets the typed payload for its hook name. |
| **Cards** | `PluginCardPrimitive` (header / info-grid / status-banner / progress / collapsible / log-stream / action-row / markdown / spinner / badge / divider) + `card.*` builders. |
| **Plugin context** | `PluginContext<Config>` generic with `log`, `storage`, `http` (permission-enforced), `vault` (scoped), `cards`, typed `config`, and manifest info. |

## Usage

```ts
import { tool, z, card } from '@kinbot-developer/sdk'
import type {
  ChannelAdapter,
  LLMProvider,
  PluginContext,
  PluginExports,
} from '@kinbot-developer/sdk'

interface MyConfig { apiKey: string; region?: 'eu' | 'us' }

export default function (ctx: PluginContext<MyConfig>): PluginExports {
  return {
    tools: {
      greet: {
        availability: ['main', 'sub-kin'],
        readOnly: true,
        concurrencySafe: true,
        create: () => tool({
          description: 'Say hi',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => ({ reply: `Hi ${name}` }),
        }),
      },
    },

    providers: [/* one or more LLM / Embedding / Image providers */],

    channels: { /* platform -> ChannelAdapter */ },

    hooks: {
      afterToolCall: (h) => {
        // h.toolName, h.toolArgs, h.toolResult — fully typed per hook
      },
    },

    async activate() {},
    async deactivate() {},
  }
}
```

## Manifest JSON Schema

Reference the published schema from your `plugin.json` and any JSON-aware editor (VSCode, JetBrains) gives you autocomplete and inline validation:

```json
{
  "$schema": "https://unpkg.com/@kinbot-developer/sdk/schemas/plugin-manifest.schema.json",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "…",
  "main": "index.ts",
  "kinbot": ">=0.40.0"
}
```

## Reference example

[`examples/hello-kin/`](./examples/hello-kin/) — a single-file plugin demonstrating every extension point (tool, channel, native LLM provider, hooks with typed payloads, card emission, lifecycle). Used by the SDK's own test suite to guarantee the public surface stays loadable.

## Documentation

The canonical plugin author guide lives on the docs site:

- [Developing Plugins](https://marlburrow.github.io/kinbot/docs/plugins/developing/)
- [Migrating from 0.1](https://marlburrow.github.io/kinbot/docs/plugins/migrating-from-0.1/)
- [Plugins Overview](https://marlburrow.github.io/kinbot/docs/plugins/overview/)

## License

AGPL-3.0-only.
