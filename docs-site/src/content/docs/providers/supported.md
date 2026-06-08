---
title: Supported Providers
description: "Built-in providers (LLM, embedding, image, search, STT, TTS) shipped with Hivekeep."
---

Hivekeep ships with built-in providers across six capability families: language models (LLM), embeddings, image generation, web search, speech-to-text (STT), and text-to-speech (TTS). A single provider often covers several families: capabilities are auto-detected from one config entry. Additional providers (Mistral, Replicate, …) are available as first-party plugins, and you can write your own via the [Custom Providers](/hivekeep/docs/providers/custom/) plugin path.

## Provider Table

| Provider | LLM | Embedding | Image | Search | STT | TTS | API Key Required |
|----------|:---:|:---------:|:-----:|:------:|:---:|:---:|:----------------:|
| [Anthropic](https://console.anthropic.com/settings/keys) | ✅ | | | | | | ✅ |
| Anthropic (Claude Max) | ✅ | | | | | | ❌ (OAuth) |
| [OpenAI](https://platform.openai.com/api-keys) | ✅ | ✅ | ✅ | | ✅ | ✅ | ✅ |
| OpenAI (Codex CLI) | ✅ | | | | | | ❌ (OAuth) |
| [Google Gemini](https://aistudio.google.com/apikey) | ✅ | | ✅ | | | | ✅ |
| [OpenRouter](https://openrouter.ai/keys) | ✅ | | | | | | ✅ |
| [xAI](https://console.x.ai) | ✅ | | | | | | ✅ |
| [Brave Search](https://brave.com/search/api/) | | | | ✅ | | | ✅ |
| [SerpAPI](https://serpapi.com/manage-api-key) | | | | ✅ | | | ✅ |
| [Tavily](https://app.tavily.com/home) | | | | ✅ | | | ✅ |
| [Perplexity Sonar](https://www.perplexity.ai/settings/api) | | | | ✅ | | | ✅ |
| [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) | | | | | ✅ | ✅ | ✅ |

This table is the exact set of built-in providers (see `src/shared/provider-metadata.ts`). Notably:

- **Embeddings** are provided only by **OpenAI** out of the box. Other embedding sources come from plugins.
- **Image generation** is built in for **OpenAI** and **Gemini**.
- **STT and TTS** are built in for **OpenAI** and **ElevenLabs**.
- Providers such as **Mistral** and **Replicate** are not built in: they ship as plugins.

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

## Configuration

Providers are configured in **Settings > Providers** in the Hivekeep UI. Each provider requires an **API key** (except those using OAuth).

A configured search provider is automatically picked up by the `web_search` tool. To make it the default for all Agents, set it under **Settings > Models & Services > Default Search Provider**: otherwise `web_search` falls back to the first valid configured search provider.

## API Endpoints

Hivekeep exposes several provider management endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/providers` | List all configured providers |
| `POST` | `/api/providers` | Add a new provider (auto-tests connection unless `skipTest: true`) |
| `PATCH` | `/api/providers/:id` | Update provider config (re-tests connection unless `skipTest: true`) |
| `DELETE` | `/api/providers/:id` | Delete a provider (warns when removing the last with a given capability; never blocks) |
| `GET` | `/api/providers/types` | List all available provider types (built-in + plugin) |
| `GET` | `/api/providers/capabilities` | Check which capabilities are currently available |
| `GET` | `/api/providers/models` | List all available models across valid providers |
| `POST` | `/api/providers/test` | Test a connection without saving |
| `POST` | `/api/providers/:id/test` | Re-test an existing provider's connection |

## Minimum Setup

To use Hivekeep, you need at minimum:

1. **One LLM provider**: For Agent conversations (Anthropic, OpenAI, Gemini, OpenRouter, xAI, or an OpenAI-compatible endpoint via a plugin)
2. **One embedding provider**: For memory to work. Built in only via **OpenAI** (e.g. `text-embedding-3-small`); other embedding sources come from plugins or an OpenAI-compatible endpoint

Optional but recommended:
- A **search provider** for `web_search` (Brave, SerpAPI, Tavily, or Perplexity Sonar)
- An **image provider** for `generate_image` (OpenAI or Gemini)
- A **voice provider** for `text_to_speech` / `transcribe_audio` (OpenAI or ElevenLabs)
