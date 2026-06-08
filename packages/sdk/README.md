# `@hivekeep/sdk`

Plugin SDK for [Hivekeep](https://github.com/MarlBurroW/hivekeep). One package, every extension point.

```bash
bun add @hivekeep/sdk
# or
npm i @hivekeep/sdk
```

> Hivekeep's plugin loader resolves this package against the host install — declare it as a peer dep in your plugin's `package.json` so the host version is the one your code links against at runtime.

## What's in here

| Surface | What you get |
|---|---|
| **Tools** | `tool()` helper with INPUT inferred from a zod `inputSchema`, plus `z` re-exported. |
| **Channels** | `ChannelAdapter`, `IncomingMessage`, `OutboundMessageParams`, etc. — full adapter contract. |
| **Providers** | `LLMProvider`, `EmbeddingProvider`, `ImageProvider`, `SearchProvider` — the **same** native interfaces Hivekeep's built-in Anthropic / OpenAI / Brave / Tavily providers implement. Streaming `chat()` yielding `ChatChunk`s, prompt caching, thinking effort, tool use, per-provider tunables (`defaultMaxTools`, `billing`). Image providers can implement `describeModel()` to surface per-model parameters (seed, guidance, LoRA scale, …) to the LLM via the `describe_image_model` tool; `ImageRequest` carries plural `imageInputs` for multi-reference models (Nano Banana Pro, Flux-Kontext multi) and a free-form `params` map for the tunables. Search providers declare static `SearchCapabilities` (`supportsAnswer`, `supportsFreshness`, `supportsDomainFilter`, `supportsLanguage`, `supportsLocation`) so the host can warn the LLM when a request asks for something the provider doesn't expose; `SearchRequest.extra` is a free-form passthrough for provider-specific quirks (Perplexity `search_recency_filter`, Tavily `include_raw_content`, …) that the standard schema doesn't model. |
| **Hooks** | `HookPayloadMap` discriminated union → each hook handler gets the typed payload for its hook name. |
| **Cards** | `PluginCardPrimitive` (header / info-grid / status-banner / progress / collapsible / log-stream / action-row / markdown / spinner / badge / divider) + `card.*` builders. |
| **Plugin context** | `PluginContext<Config>` generic with `log`, `storage`, `http` (permission-enforced), `vault` (scoped), `cards`, typed `config`, and manifest info. |

## Usage

```ts
import { tool, z, card } from '@hivekeep/sdk'
import type {
  ChannelAdapter,
  LLMProvider,
  PluginContext,
  PluginExports,
} from '@hivekeep/sdk'

interface MyConfig { apiKey: string; region?: 'eu' | 'us' }

export default function (ctx: PluginContext<MyConfig>): PluginExports {
  return {
    tools: {
      greet: {
        availability: ['main', 'sub-agent'],
        readOnly: true,
        concurrencySafe: true,
        create: () => tool({
          description: 'Say hi',
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => ({ reply: `Hi ${name}` }),
        }),
      },
    },

    providers: [/* one or more LLM / Embedding / Image / Search providers */],

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
  "$schema": "https://unpkg.com/@hivekeep/sdk/schemas/plugin-manifest.schema.json",
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "…",
  "main": "index.ts",
  "hivekeep": ">=0.40.0"
}
```

## Reference example

[`examples/hello-agent/`](./examples/hello-agent/) — a single-file plugin demonstrating every extension point (tool, channel, native LLM provider, hooks with typed payloads, card emission, lifecycle). Used by the SDK's own test suite to guarantee the public surface stays loadable.

## Documentation

The canonical plugin author guide lives on the docs site:

- [Developing Plugins](https://marlburrow.github.io/hivekeep/docs/plugins/developing/)
- [Migrating from 0.1](https://marlburrow.github.io/hivekeep/docs/plugins/migrating-from-0.1/)
- [Plugins Overview](https://marlburrow.github.io/hivekeep/docs/plugins/overview/)

## License

MIT.
