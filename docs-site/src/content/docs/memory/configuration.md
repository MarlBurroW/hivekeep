---
title: Memory Configuration
description: Configure the memory profile, archive search, maintenance, and compacting behavior.
---

Memory behavior is controlled through environment variables. All settings have sensible defaults.

Memory has two layers (see [How Memory Works](/docs/memory/how-it-works/)): a curated **profile** always injected into the prompt, and an episodic **archive** searched on demand with `recall`.

## Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_PROFILE_MAX_TOKENS` | `1500` | Token budget for the profile document. It sits in the cached prompt prefix, so every line costs on every turn. The maintenance rewrite is told to stay under it; a rewrite far over drops whole trailing sections, never `## Pinned` |
| `MEMORY_EXTRACTION_MODEL` | Agent's model | Model for the compaction-time maintenance call (archive extraction + profile rewrite). Overridden by the `extraction_model` app setting |
| `MEMORY_MAX_RELEVANT` | `10` | Default number of results returned by a `recall` search |
| `MEMORY_SIMILARITY_THRESHOLD` | `0.5` | Minimum cosine similarity for vector search candidates. A spam filter, not a relevance gate |
| `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model for memory vectors |
| `MEMORY_EMBEDDING_DIMENSION` | `1536` | Vector dimension for embeddings |
| `MEMORY_EMBEDDING_TIMEOUT` | `60000` | Ceiling for one embedding call, in ms |

## Search Settings

`recall` fuses a vector arm and an FTS arm with reciprocal rank fusion. Relevance to the query is the only ranking signal; recency breaks ties.

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_RRF_K` | `60` | Reciprocal Rank Fusion smoothing constant. Higher values give more weight to lower-ranked results |
| `MEMORY_FTS_BOOST` | `0.5` | Weight of the FTS arm relative to the vector arm at the same rank |

## Removed in memory v2

The scoring heuristics below no longer exist, and setting their variables is a no-op. They tuned a per-message injection pipeline that produced a winner-take-all archive (half the corpus never retrieved, a handful injected hundreds of times); the profile layer replaced the need for it.

`MEMORY_TEMPORAL_DECAY_LAMBDA`, `MEMORY_TEMPORAL_DECAY_FLOOR`, `MEMORY_ADAPTIVE_K`, `MEMORY_ADAPTIVE_K_MIN_SCORE_RATIO`, `MEMORY_ADAPTIVE_K_LARGEST_GAP_RATIO`, `MEMORY_SUBJECT_BOOST`, `MEMORY_CATEGORY_BOOST`, `MEMORY_RECENCY_BOOST`, `MEMORY_TOKEN_BUDGET`, `MEMORY_RETRIEVAL_LLM_TIMEOUT`, `MEMORY_MULTI_QUERY_MODEL`, `MEMORY_HYDE_MODEL`, `MEMORY_RERANK_MODEL`, `MEMORY_CONTEXTUAL_REWRITE_MODEL`, `MEMORY_CONTEXTUAL_REWRITE_THRESHOLD`, `MEMORY_CONSOLIDATION_MODEL`, `MEMORY_CONSOLIDATION_SIMILARITY`, `MEMORY_CONSOLIDATION_MAX_GEN`.

## Compacting Settings

Session compacting uses **token-aware multi-summary accumulation**: when context usage exceeds a configurable threshold, older messages outside a keep-window are summarized into dated summaries that stack chronologically. When summaries accumulate beyond the budget, the oldest merge telescopically.

### Token-based trigger

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACTING_THRESHOLD_PERCENT` | `75` | Context usage % before compaction triggers |
| `COMPACTING_KEEP_PERCENT` | `40` | % of context window preserved as raw messages (keep-window) |
| `COMPACTING_SUMMARY_BUDGET_PERCENT` | `20` | Max % of context window for summary tokens before telescopic merge |
| `COMPACTING_MAX_SUMMARIES` | `10` | Max active summaries before telescopic merge |
| `COMPACTING_MAX_SUMMARIES_PER_KIN` | `50` | Total summary retention per Agent (active + archived) |

### General settings

| Variable | Default | Description |
|----------|---------|-------------|
| `COMPACTING_MODEL` | Provider default | Model used for session compacting/summarization. Supports `providerId:modelId` format |

All compacting settings can be configured **per-Agent** (overrides global values) via the **Compaction** tab in the Agent's settings. Available per-Agent fields: `thresholdPercent`, `keepPercent`, `summaryBudgetPercent`, `maxSummaries`, `compactingModel`, and `compactingProviderId`.

### Progressive context pipeline

Before compacting runs, Hivekeep applies a progressive pipeline to reduce context size without LLM calls:

| Variable | Default | Description |
|----------|---------|-------------|
| `TOOL_RESULT_MASK_KEEP_LAST` | `2` | Number of recent tool call groups kept fully intact. Older groups are collapsed to one-line summaries |
| `OBSERVATION_COMPACTION_WINDOW` | `10` | Number of recent turns kept at full resolution. Older turns have tool results truncated. `0` = disabled |
| `OBSERVATION_MAX_CHARS` | `200` | Max characters for truncated tool results in the observation zone |
| `HISTORY_TOKEN_BUDGET` | `0` (disabled) | Emergency safety net: max tokens for conversation history. Messages trimmed from oldest end if exceeded. `0` = no limit |

### Tool output spill

Large tool results are automatically spilled to temporary files instead of being included inline in the LLM context:

| Variable | Default | Description |
|----------|---------|-------------|
| `TOOL_OUTPUT_SPILL_THRESHOLD` | `10000` | Byte threshold before spilling to file. `0` = disabled |
| `TOOL_OUTPUT_PREVIEW_LINES` | `200` | Lines included in the compact preview reference |
| `TOOL_OUTPUT_PREVIEW_MAX_CHARS` | `4000` | Hard size bound on that preview, so a result made of one very long line (email body, shell output) cannot keep its full payload in context |
| `TOOL_OUTPUT_TTL_HOURS` | `24` | Hours before spilled files are cleaned up |

## Embedding Provider

Memory requires an **embedding provider** to be configured in **Settings > Providers**. Built-in embedding providers:

- **OpenAI**: `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`
- **OpenAI-compatible**: any endpoint exposing `/v1/embeddings`, via a custom base URL and an optional API key. This is how you run **fully local embeddings**: point it at Ollama (`nomic-embed-text`, `qwen3-embedding`, `embeddinggemma`, …), llama.cpp, LM Studio, vLLM, LiteLLM, or NewAPI. Model names are free-form (no `text-embedding-*` restriction) and the vector dimension is detected automatically.

Other embedding sources (Voyage, Jina, Cohere, Mistral, …) ship as **plugins**.

:::caution
Without an embedding provider, memory storage and retrieval will not work. The Agent will still function but won't remember anything across sessions.
:::

## Tuning Tips

### Profile
- **Raise `MEMORY_PROFILE_MAX_TOKENS`** if Agents track a lot of parallel work and their profiles keep getting truncated. It is a per-turn cost on every conversation, so raise it deliberately.
- If a profile drifts or bloats, edit it directly in the Agent's **Memory** tab, or use **Regenerate** to recompile it from the archive.

### Search
- **Lower `MEMORY_SIMILARITY_THRESHOLD`** to let more vector candidates through when `recall` comes back empty on valid queries.
- **Raise `MEMORY_FTS_BOOST`** if keyword matching should matter more than semantic similarity in your corpus.
- **Raise `MEMORY_MAX_RELEVANT`** if `recall` results are consistently too narrow.

### Compacting
- **Lower `COMPACTING_THRESHOLD_PERCENT`** (e.g. 60) for earlier compaction triggers.
- **Raise `COMPACTING_KEEP_PERCENT`** (e.g. 50) to keep more raw context visible to the LLM.

### Performance
- Use a **fast, tool-reliable model** for `MEMORY_EXTRACTION_MODEL`: it runs once per compaction and writes both memory layers.
