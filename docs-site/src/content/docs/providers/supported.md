---
title: Supported Providers
description: "Built-in providers (LLM, embedding, image, search, STT, TTS) shipped with Hivekeep."
---

Hivekeep ships with built-in providers across six capability families: language models (LLM), embeddings, image generation, web search, speech-to-text (STT), and text-to-speech (TTS). A single provider often covers several families: capabilities are auto-detected from one config entry. Additional providers (Mistral, Replicate, …) are available as first-party plugins, and you can write your own via the [Custom Providers](/docs/providers/custom/) plugin path.

## Provider Table

| Provider | LLM | Embedding | Image | Search | STT | TTS | API Key Required |
|----------|:---:|:---------:|:-----:|:------:|:---:|:---:|:----------------:|
| [Anthropic](https://console.anthropic.com/settings/keys) | ✅ | | | | | | ✅ |
| Anthropic (Claude Max) | ✅ | | | | | | ❌ (OAuth) |
| [OpenAI](https://platform.openai.com/api-keys) | ✅ | ✅ | ✅ | | ✅ | ✅ | ✅ |
| OpenAI (Codex CLI) | ✅ | | | | | | ❌ (OAuth) |
| [Google Gemini](https://aistudio.google.com/apikey) | ✅ | | ✅ | | | | ✅ |
| [OpenRouter](https://openrouter.ai/keys) | ✅ | ✅ | ✅ | | | | ✅ |
| [Kilo Gateway](https://kilo.ai/gateway) | ✅ | | | | | | ✅ |
| [Ollama Cloud](https://ollama.com/) | ✅ | | | ✅ | | | ✅ |
| [xAI](https://console.x.ai) | ✅ | | | | | | ✅ |
| [DeepSeek](https://platform.deepseek.com/api_keys) | ✅ | | | | | | ✅ |
| [MiniMax](https://platform.minimax.io/user-center/basic-information/interface-key) | ✅ | | | | | | ✅ |
| [Kimi (Moonshot)](https://platform.moonshot.ai/console/api-keys) | ✅ | | | | | | ✅ |
| OpenAI-compatible (custom base URL) | ✅ | ✅ | | | | | ⚪ (optional) |
| [Brave Search](https://brave.com/search/api/) | | | | ✅ | | | ✅ |
| [SerpAPI](https://serpapi.com/manage-api-key) | | | | ✅ | | | ✅ |
| [Tavily](https://app.tavily.com/home) | | | | ✅ | | | ✅ |
| [Perplexity Sonar](https://www.perplexity.ai/settings/api) | | | | ✅ | | | ✅ |
| [SearXNG](https://github.com/searxng/searxng) (self-hosted, custom base URL) | | | | ✅ | | | ⚪ (optional) |
| [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) | | | | | ✅ | ✅ | ✅ |

This table is the exact set of built-in providers (see `src/shared/provider-metadata.ts`). Notably:

- **Embeddings** are built in for **OpenAI**, **OpenRouter**, and the generic **OpenAI-compatible** connector (point it at Ollama, llama.cpp, LM Studio, vLLM, etc. for fully local embeddings). Other embedding sources come from plugins.
- **Image generation** is built in for **OpenAI**, **Gemini**, and **OpenRouter**.
- **Ollama Cloud** is built in for LLMs and result-only web search via Ollama's API.
- **Kilo Gateway** is built in as an LLM gateway.
- **STT and TTS** are built in for **OpenAI** and **ElevenLabs**.
- **SearXNG** is a self-hosted search connector: point it at your own [SearXNG](https://github.com/searxng/searxng) instance (custom base URL) to run web search privately, with no commercial search API. The instance must have the `json` format enabled (`search.formats` in `settings.yml`); the API key is optional and only needed for protected instances (sent via a configurable auth header). Do not configure it through the Tavily provider: SearXNG is not Tavily-compatible and will fail with HTTP 401.
- Providers such as **Mistral** and **Replicate** are not built in: they ship as plugins.
- **OpenAI-compatible** is a generic connector: you supply a **custom base URL** (and an optional API key) to point Hivekeep at any OpenAI-style endpoint, NewAPI, LiteLLM, llama.cpp, LM Studio, vLLM, Ollama, and similar. It serves **both LLM and embedding** capabilities (`/chat/completions` and `/embeddings`), so a single connector can run your agents and your semantic memory fully locally. Its model list comes from the endpoint's `/models`; the API key is optional (local servers often need none).
- **Local models without native tool calling still work.** Some self-hosted models reject the native tools API (for example Gemma on Ollama, which returns `400 does not support tools`). When Hivekeep detects this, it automatically switches that model to a prompt-based tool protocol, describing the tools in the prompt and parsing the model's tool calls back out, so the agent keeps working. This happens transparently, with no configuration, and is remembered per model so there is no repeated failed attempt. A low [`TOOLS_TEMPERATURE`](/docs/getting-started/configuration/) and tolerant parsing further steady tool calls on small models.

Per-model metadata (context window, image/PDF support, reasoning, pricing, and the display label) is **not configured per provider**. It's auto-filled from [models.dev](https://models.dev) and managed in the [Model Registry](/docs/providers/model-registry/), where you can also enable/disable models, fix a wrong match, or override any value.

## Capabilities

- **LLM**: Chat and text completion models used for Agent conversations
- **Embedding**: Vector embedding models used for memory storage and retrieval
- **Image**: Image generation models (used by `generate_image`)
- **Search**: Web search APIs (used by `web_search` and discovered via `list_search_providers`)
- **STT**: Speech-to-text (used by `transcribe_audio`)
- **TTS**: Text-to-speech (used by `text_to_speech`)

## Search-provider capabilities at a glance

Search providers declare static capability flags so an Agent can pick the right one for the job. `web_search` honors what each provider supports and emits a warning when the LLM asks for something the provider doesn't expose.

| Provider | `answer` | `freshness` | `domains` | `lang` | `location` | Notes |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Brave Search | ❌ | ✅ | ✅ | ✅ | ✅ | Domain filter via `site:` operators in the query. |
| SerpAPI | ❌ | ✅ | ✅ | ✅ | ✅ | Google as upstream; auth check uses `/account` (free). |
| Tavily | ✅ | ✅ | ✅ | ❌ | ❌ | Purpose-built for LLM grounding; native answer synthesis. |
| Perplexity Sonar | ✅ | ✅ | ✅ | ❌ | ❌ | LLM-with-search; recency caps at one month (`year` → `month` with warning). |
| SearXNG | ❌ | ✅ | ✅ | ✅ | ❌ | Self-hosted metasearch; needs `json` enabled in `search.formats`. Domain filter via `site:` operators. |
| Ollama Cloud | ❌ | ❌ | ❌ | ❌ | ❌ | Result-only web search through Ollama's `/web_search` endpoint; no synthesized answer or advanced filters advertised. |

## Configuration

Providers are configured in **Settings > Providers** in the Hivekeep UI. Each provider requires an **API key** (except those using OAuth).

A configured search provider is automatically picked up by the `web_search` tool. To make it the default for all Agents, set it under **Settings > Models & Services > Default Search Provider**: otherwise `web_search` falls back to the first valid configured search provider.

### Subscription providers: sign in without a CLI

The subscription providers, **Anthropic (Claude Max)** and **OpenAI (Codex CLI)**, bill against your existing Claude or ChatGPT plan instead of a metered API key. Both support two connection methods, chosen with a toggle in the **Add provider** dialog:

- **Sign in** (no CLI needed): pick "Sign in", click the sign-in button, approve in the browser tab that opens, then paste back the authorization code the page shows. Hivekeep completes the OAuth PKCE exchange and stores the resulting tokens in its **encrypted vault**, refreshing them automatically. This is the recommended path and requires nothing installed on the server. For Codex, copy the code (or the whole `http://localhost:1455/...` address the page redirects to) and paste it back; Hivekeep pulls the code out.
- **Credentials file**: if you already use the official CLI on the same machine (`claude` / `codex`), leave the toggle on "Credentials file" and Hivekeep reads its OAuth tokens from `~/.claude/.credentials.json` / `~/.codex/auth.json` (an explicit path override is available for non-standard environments). Existing setups keep working with no change.

Both methods feed the same provider. Tokens obtained via "Sign in" never touch the CLI files: they live only in the vault, and are removed when the provider is deleted.

You can also just **ask Queenie** (the configurator Agent) to connect Claude Max or Codex: she opens the sign-in as an in-chat card (the same button + paste-the-code step), so you never have to leave the conversation.

Codex does not need its CLI model cache (`~/.codex/models_cache.json`): Hivekeep fetches your live, per-account model catalog straight from the Codex backend (the same source the CLI uses), so it always lists the models your plan actually supports. The CLI cache and a small built-in list are only fallbacks for when that request can't be made. Per-model metadata is enriched from the [Model Registry](/docs/providers/model-registry/).

## API Endpoints

Hivekeep exposes several provider management endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/providers` | List all configured providers |
| `POST` | `/api/providers` | Add a new provider (auto-tests connection unless `skipTest: true`) |
| `PATCH` | `/api/providers/:id` | Update provider config (re-tests connection unless `skipTest: true`) |
| `DELETE` | `/api/providers/:id` | Delete a provider (warns when removing the last with a given capability; never blocks) |
| `POST` | `/api/providers/oauth/:type/start` | Begin the CLI-free OAuth sign-in (PKCE) for a subscription provider; returns the authorize URL |
| `POST` | `/api/providers/oauth/:type/complete` | Finish sign-in: exchange the pasted code, store tokens in the vault, create the provider |
| `GET` | `/api/providers/types` | List all available provider types (built-in + plugin) |
| `GET` | `/api/providers/capabilities` | Check which capabilities are currently available |
| `GET` | `/api/providers/models` | List all available models across valid providers |
| `POST` | `/api/providers/test` | Test a connection without saving |
| `POST` | `/api/providers/:id/test` | Re-test an existing provider's connection |

## Minimum Setup

To use Hivekeep, you need at minimum:

1. **One LLM provider**: For Agent conversations (Anthropic, OpenAI, Gemini, OpenRouter, Kilo Gateway, Ollama Cloud, xAI, or the built-in **OpenAI-compatible** connector pointed at any custom endpoint)
2. **One embedding provider**: For memory to work. Built in via **OpenAI** (e.g. `text-embedding-3-small`), **OpenRouter**, or the **OpenAI-compatible** connector pointed at a local endpoint (e.g. Ollama with `nomic-embed-text` or `qwen3-embedding`); other embedding sources come from plugins

Optional but recommended:
- A **search provider** for `web_search` (Brave, SerpAPI, Tavily, Perplexity Sonar, Ollama Cloud, or a self-hosted SearXNG instance)
- An **image provider** for `generate_image` (OpenAI, Gemini, or OpenRouter)
- A **voice provider** for `text_to_speech` / `transcribe_audio` (OpenAI or ElevenLabs)
