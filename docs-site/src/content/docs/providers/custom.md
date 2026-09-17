---
title: Adding Custom Providers
description: Extend Hivekeep with custom AI providers via plugins.
---

Beyond the built-in providers, you can ship your own through the **plugin system**. Plugin providers register into the same four native registries as built-ins (LLM, embedding, image, search) and appear alongside them in the Settings UI. There is no second-class plugin shape.

This page is a quick orientation. The full author guide is on the [Developing Plugins](/docs/plugins/developing/) page, including a complete `SearchProvider` example.

## When you need a plugin

- **Proprietary or internal endpoints**: your own model server, an internal RAG service.
- **Specialized search APIs** not shipped as a built-in (Kagi, You.com, Exa, …).
- **Embedding or image services** not in the built-in set.
- **OpenAI-compatible endpoints with non-standard auth or wire quirks** that the built-in **OpenAI-compatible** provider can't express.

If your endpoint is plainly OpenAI-compatible (NewAPI, LiteLLM, vLLM, llama.cpp server, LM Studio, LocalAI, Ollama, …), use the built-in **OpenAI-compatible** provider instead: just set its Base URL (and an optional API key). No plugin needed. See [Supported Providers](/docs/providers/supported/).

## Provider shape

A plugin exports a `providers` array. Each entry implements one of the four native SDK interfaces (`LLMProvider`, `EmbeddingProvider`, `ImageProvider`, `SearchProvider`), the same interfaces the built-in Anthropic / OpenAI / Brave / Tavily providers implement.

```typescript
// In your plugin's main file
import type { SearchProvider, PluginContext } from '@hivekeep/sdk'

class MySearchProvider implements SearchProvider {
  readonly type = 'my-search'
  readonly displayName = 'My Search Service'
  readonly apiKeyUrl = 'https://my-service.example/keys'
  readonly configSchema = [
    { key: 'apiKey', type: 'secret', label: 'API key', required: true },
  ] as const
  readonly capabilities = {
    supportsAnswer: false,
    supportsFreshness: true,
    supportsDomainFilter: false,
    supportsLanguage: true,
    supportsLocation: false,
  }

  async authenticate(config) { return { valid: true } }
  async search(request, config) { return { results: [] } }
}

export default function (ctx: PluginContext) {
  return { providers: [new MySearchProvider()] }
}
```

The plugin loader inspects which method each provider exposes (`chat` → LLM, `embed` → embedding, `generate` → image, `search` → search) and registers it into the matching registry. The provider's `type` is prefixed internally to `plugin:<your-plugin-name>:<type>` so it can't collide with built-ins.

Once your plugin is enabled, the provider appears in **Settings > Providers** and Agents can use it through the standard tools (`web_search`, `generate_image`, etc.), with no further wiring needed on the host side.

## OpenAI-Compatible Endpoints

Many gateways and self-hosted runtimes expose an OpenAI-compatible API. You do **not** need a plugin for these: use the built-in **OpenAI-compatible** provider:

1. Go to **Settings > Providers > Add provider** and pick **OpenAI-compatible**
2. Set the **Base URL** to your endpoint, including the version path (e.g. `http://localhost:8000/v1`)
3. Set the API key only if your server requires one (leave it empty for key-less local servers)

The same connector serves **LLM, embeddings, and image generation**: enable the matching capabilities when adding it. For embeddings it calls `/embeddings` and accepts free-form model names (e.g. Ollama's `nomic-embed-text` or `qwen3-embedding`). For images it calls the OpenAI Images API (`/images/generations`, and `/images/edits` when a source image is provided) — the endpoint must actually implement that route (LiteLLM, NewAPI, LocalAI, …). Chat-only servers such as stock Ollama will not generate images through this connector.

Its model list comes from the endpoint's `/models`. Image models are filtered by name (dall-e, gpt-image, flux, …); set the optional **Image model IDs** field when your gateway uses a name the heuristic misses. This works with NewAPI, LiteLLM, vLLM, llama.cpp server, LM Studio, LocalAI, Ollama (`/v1`), and similar services. Reach for a plugin only when the endpoint needs custom authentication or has non-standard wire behavior the generic connector can't express. See [Supported Providers](/docs/providers/supported/#openai-compatible-image-gaps) for the image-generation gaps.
