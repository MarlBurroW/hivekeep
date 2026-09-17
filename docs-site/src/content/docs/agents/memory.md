---
title: Agent Memory
description: How Agents remember and learn across conversations.
---

Hivekeep gives every Agent **persistent long-term memory**, in two layers:

| Layer | What it holds | How the Agent sees it |
|---|---|---|
| **Profile** | What the Agent *knows*: current state, standing preferences, active work | Always present in its context |
| **Archive** | What *happened*: dated events, past details, one-off facts | Searched on demand with `recall` |

The split is what keeps memory both reliable and cheap. The profile is small and always there, so the Agent never has to get lucky with a search to know who you are and what you are working on. The archive is unbounded and costs nothing until queried, so it can keep everything else.

## The profile

A short markdown document (default budget: 1500 tokens) injected into every prompt. It has conventional sections: `Pinned`, `Active projects`, `Preferences & conventions`, `Key decisions`, `Open threads`.

It is maintained three ways:

- **Automatically**, during compaction: the maintenance pass rewrites it, folding in what is new and dropping what is resolved.
- **By the Agent**, with `edit_profile`, when you tell it something durable and it should not wait for the next compaction.
- **By you**, in the Agent's **Memory** tab: edit the markdown directly, watch the token count, or regenerate the whole document from the archive.

### Pinned entries

Anything under `## Pinned` is copied verbatim by every automatic rewrite and never edited or dropped. Use it for instructions you want followed forever ("always write GitHub issues in English"). Both `edit_profile(..., pin: true)` and the editor can put entries there.

## The archive

Individual memories, saved automatically during compaction or explicitly with `memorize`. Each carries a category, an optional subject, an importance score, and a **source context** describing where it came from (e.g. *"While discussing weekend plans, user mentioned..."*).

| Category | Use case |
|---|---|
| `fact` | Objective information (names, dates, technical details) |
| `preference` | User preferences and habits |
| `decision` | Decisions that were made and their rationale |
| `knowledge` | Learned domain knowledge |

The archive is never injected into the prompt. The Agent searches it with `recall`, which runs **hybrid search**: vector similarity (embeddings) fused with full-text keyword matching (FTS5). Results are ranked by relevance to the query alone; `subject`, `category` and `since` filters narrow the search when the Agent knows roughly what it is after.

## Which layer gets what

Agents route information with a single test:

> Should this influence the Agent's behavior in most future conversations, without anyone mentioning it?

Yes means the profile. No, but it may matter when a topic comes back, means the archive. Moving something to the archive is filing, not forgetting: it stays searchable, and a finished project leaves the profile at the next rewrite while its decisions remain in the archive.

## Memory tools

| Tool | Purpose |
|---|---|
| `recall` | Search the archive (semantic + keyword, includes shared, optional filters) |
| `memorize` | Save an episodic fact to the archive (private or shared) |
| `edit_profile` | Add, replace or remove a profile entry (optionally pinned) |
| `update_memory` | Update an existing archive memory (content, category, scope) |
| `forget` | Delete an archive memory |
| `list_memories` | Browse the archive by category or scope |
| `review_memories` | LLM-powered audit for contradictions, duplicates, stale entries |
| `search_history` | Search conversation message history |

## Shared memories

Memories default to **private** (only the owning Agent can see them), but Agents can mark memories as **shared** to make them searchable by all other Agents. This is useful for cross-domain facts like infrastructure details, user-wide preferences, or organizational decisions.

- Use `memorize(..., scope: "shared")` or `update_memory(..., scope: "shared")`
- `recall` automatically searches both private and shared memories
- Shared memories include author attribution (e.g. *[shared by Assistant]*)

Profiles are always per-Agent: each Agent curates its own. Cross-Agent context travels through shared archive memories and global contact notes.

## Session compacting

When context usage exceeds the threshold (default: 75% of the model's context window), Hivekeep **compacts** older messages into dated summaries. Key points:

- Original messages are **never deleted**, they're preserved in the database
- Summaries **accumulate chronologically**: each compaction creates a new summary, not a single overwritten snapshot
- When summaries exceed the budget, the oldest merge **telescopically** into higher-level summaries
- Compacting is configurable **per-Agent** (threshold, keep window, summary budget, max summaries, model)
- Users can **force compact** from the Agent's settings at any time

## Memory and privacy

- Profiles and archives are **per-Agent** by default: each Agent has its own memory store
- **Shared** memories are readable by all Agents but still owned by the creator
- Vault secrets are **never** stored in memories (redaction prevents leaking into compacted summaries)
