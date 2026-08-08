---
title: How Memory Works
description: "Understanding Hivekeep's memory system: the always-injected profile, the searchable archive, and how both are maintained."
---

Hivekeep gives each Agent persistent memory across conversations, split into two layers: an always-present **profile** and a searchable **archive**. Memories can be **private** (default, only the owning Agent can access them) or **shared** (visible and searchable by all Agents).

:::note
For the user-facing tour of both layers, see [Agent Memory](/docs/agents/memory/).
:::

## Two Layers

| Layer | Contents | Injection |
|---|---|---|
| **Profile** (`agent_profiles`) | What the Agent *knows*: current state, standing preferences, active work | Always, in the cached system-prompt prefix |
| **Archive** (`memories`) | What *happened*: dated events, past details, one-off facts | Never automatic; searched with `recall` |

The profile is bounded (default 1500 tokens) because it costs context on every turn. The archive is unbounded because it costs nothing until queried.

### Why the archive is not injected

Earlier versions searched the archive on every user message and injected the top results. Measured on a real instance, that produced a winner-take-all corpus: half the memories were never retrieved once, while a handful were injected hundreds of times. The cause was structural. The relevance score was multiplied by temporal decay, importance, retrieval count, and subject/category boosts, and `retrieval_count` measures *injection* rather than usefulness, so surfacing a memory made it more likely to surface again. On top of that, the search query was the raw chat message, which is a poor embedding query against stored fact sentences.

Memory v2 removes those heuristics. The profile carries the context that must always be present, and the Agent formulates its own query when it needs the archive.

## Maintenance

Both layers are updated by a single LLM call that runs during compacting:

- **Archive extraction**: new episodic memories are added or existing ones updated, deduplicated at insert time by cosine distance.
- **Profile rewrite**: the whole document is regenerated, folding in what is new and durable, dropping what is resolved.

Fusing them keeps the cost identical to the old extraction-only call and makes the two outputs consistent. The model is configurable via `MEMORY_EXTRACTION_MODEL` (or the `extraction_model` app setting).

Between compactions, two tools cover immediacy: `memorize` writes to the archive right away, and `edit_profile` patches the profile without an LLM call.

### Guards

- The `## Pinned` section is reinstated verbatim after every automatic rewrite, so pinned instructions cannot be edited away.
- A rewrite far over budget drops whole trailing sections, never `## Pinned`.
- A missing or malformed profile block leaves the previous document in place: a stale profile beats one lost to a bad generation.

### Routing rule

Every decision point (the prompt block, the maintenance call, and the `memorize` / `edit_profile` tool descriptions) states the same test:

> Should this influence the Agent's behavior in most future conversations, without anyone mentioning it?

Yes routes to the profile, no routes to the archive. Demotion out of the profile is filing, not deletion.

## Shared Memories

By default, memories are **private** to the Agent that created them. However, Agents can mark memories as **shared** to make them searchable by all other Agents in the instance.

### When to share

Shared memories are for information that genuinely helps other Agents: cross-domain facts (infrastructure details, user-wide preferences, project decisions affecting everyone), organizational changes, or user availability. Agents should **not** share internal reasoning, task-specific details, or domain-specific knowledge that other Agents would never need.

### How it works

- The `memorize` and `update_memory` tools accept an optional `scope` parameter: `"private"` (default) or `"shared"`
- `recall` automatically searches both private and shared memories, with shared results attributed to their author Agent (e.g. *[shared by Assistant]*)
- `list_memories` can filter by scope; `"shared"` lists shared memories from all Agents
- Deduplication checks span both scopes to prevent redundant entries
- The prompt builder adds `*[shared by Agent Name]*` attribution to shared memories injected in context

## Memory Tools

Memory tools are available to main agents only:

| Tool | Description |
|------|-------------|
| `recall` | Semantic + keyword search across private + shared archive memories, with optional `subject` / `category` / `since` filters |
| `memorize` | Save an episodic memory to the archive (private or shared) |
| `edit_profile` | Patch the profile: `append`, `replace_section` or `remove_line`, optionally into `## Pinned` |
| `update_memory` | Update content, category, subject, or scope |
| `forget` | Delete an outdated or incorrect memory |
| `list_memories` | List memories, filtered by subject, category, or scope |
| `review_memories` | LLM-powered audit that detects contradictions, duplicates, stale entries, and clutter |

Both `recall` and `list_memories` include conversational provenance: when a memory has a `sourceContext` (the context in which it was learned), it's included in the result. Shared memories also include `authorAgentName` attribution.

## Storage

Memories are stored as vector embeddings using an embedding provider (OpenAI, Voyage, Jina, etc.) in a SQLite database with two search indexes:

- **sqlite-vec**: KNN vector index for semantic similarity
- **FTS5**: Full-text search index for keyword matching

## Search Pipeline

`recall` runs a two-arm hybrid search and fuses the results. There is no automatic injection path, and no LLM call on the search path.

### 1. Hybrid search (vector + FTS)

Two searches run in parallel:

- **Vector similarity**: KNN via sqlite-vec, filtered by a cosine similarity floor (`MEMORY_SIMILARITY_THRESHOLD`, default 0.5). The floor is a spam filter, not a relevance gate.
- **Full-text search**: FTS5 with prefix matching, AND-first with an OR fallback.

Optional `subject`, `category` and `since` filters are applied in SQL in **both** arms, so a filter can never silently apply to only one. When a filter is present the vector arm widens its candidate pool, otherwise the filter would starve it.

### 2. Reciprocal rank fusion

```
score = Σ (weight / (K + rank + 1))
```

`K` is a smoothing constant (`MEMORY_RRF_K`, default 60). The FTS arm carries its own weight (`MEMORY_FTS_BOOST`, default 0.5), since a keyword hit and a vector neighbour at the same rank are not equally trustworthy.

### 3. Ranking

Relevance to the query is the only ranking signal. Recency breaks ties. `importance` and `retrieval_count` are still recorded and shown in the UI, but they no longer affect ranking.

## Storage Metadata

Each archive memory carries a category, an optional subject, an importance score, and a **source context** describing where it was learned. `recall` and `list_memories` return the source context when present, and shared results are attributed to their author Agent.

## Bootstrap and Regeneration

Upgrading an existing instance does not start with empty profiles. A deferred, idempotent boot job compiles each Agent's existing archive into an initial profile, using the same routing rule as the maintenance call. The archive is left untouched. The done flag is only set once every Agent succeeded or had nothing to compile, so a provider outage at boot retries on the next start.

The same compile is available per-Agent from the **Memory** tab ("Regenerate"), which preserves pinned entries.

## Session Compacting

When conversations grow long, Hivekeep automatically **compacts** them using **token-aware multi-summary accumulation**:

1. After each LLM turn, the system checks if context usage exceeds a configurable threshold (`COMPACTING_THRESHOLD_PERCENT`, default: **75%** of the model's context window)
2. A **keep-window** preserves recent messages that fit within `COMPACTING_KEEP_PERCENT` (default: 40%) of the context window as raw context
3. Everything before the keep-window is summarized into a **new dated summary**. Summaries accumulate chronologically, never overwrite
4. When summaries exceed the budget (`COMPACTING_MAX_SUMMARIES` or `COMPACTING_SUMMARY_BUDGET_PERCENT`), the oldest merge **telescopically** into higher-level summaries marked `[compressed]`

Before compacting runs, a **progressive context pipeline** reduces in-memory context size without any LLM calls:
- **Intact zone**: Recent tool results kept in full
- **Observation zone**: Middle-aged tool results truncated
- **Collapsed zone**: Oldest tool results collapsed to one-line summaries

Users can **force compact** from the UI at any time. All compaction results and errors are persisted in the conversation history, with real-time progress via SSE events. Compacting is fully configurable **per-Agent** (threshold, keep window, summary budget, max summaries, model).

## Data Flow

```
User message
  → Profile is already in the cached system prompt (no search, no LLM call)
  → LLM processes and responds
  → If it needs something episodic: recall(query[, filters])
        → hybrid search (vector + FTS) → RRF fusion → results

Compacting cycle (after each LLM turn):
  → Progressive context pipeline (tool masking + observation compaction)
  → Token-percentage check → keep-window summarization if threshold exceeded
  → New summary added (accumulates chronologically)
  → Memory maintenance call:
        → archive extraction (add / update, deduplicated)
        → profile rewrite (Pinned preserved, budget enforced)
  → Telescopic merge if summaries exceed budget or count
```
