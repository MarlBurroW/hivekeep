# Hivekeep — Compacting algorithm

Compacting maintains a synthesized **working memory** for each Agent. It summarizes older exchanges so that the context sent to the LLM stays within the token window limits, while preserving important information.

> **Language convention**: Compacting and extraction prompts are written in English as the base language. The summary is generated in English regardless of the conversation language, since it is internal context for the LLM (not shown to users).

---

## Progressive context compaction pipeline

Before compacting (DB-level summarization) even runs, Hivekeep applies a **3-zone progressive compaction pipeline** to the in-memory context sent to the LLM. This reduces token usage without any LLM calls:

### Zone 1 — Intact (most recent)

The last N tool call groups are kept **fully intact** with complete tool results. Controlled by `TOOL_RESULT_MASK_KEEP_LAST` (default: 2).

### Zone 2 — Observation/Truncated (middle)

Older tool results are **truncated** to a maximum character limit. Long assistant and user messages in this zone are also trimmed. Controlled by:
- `OBSERVATION_COMPACTION_WINDOW` (default: 10) — number of turns in this zone
- `OBSERVATION_MAX_CHARS` (default: 200) — max characters for truncated tool results

### Zone 3 — Collapsed (oldest)

The oldest tool call groups are **fully collapsed** to one-line summaries (e.g. `[Tool result collapsed — 3.2k chars saved]`). This aggressively saves tokens on historical tool interactions.

### Emergency token budget

`HISTORY_TOKEN_BUDGET` (default: 0 = disabled) acts as a last-resort safety net. If set, messages are trimmed from the oldest end when the total estimated tokens exceed this budget. This should rarely activate since the pipeline + compacting handle context size.

---

## When compacting triggers

Compacting is evaluated **after each LLM turn** (after the Agent has responded). It uses a **token-percentage-based** trigger:

| Condition | Threshold (configurable) |
|---|---|
| Estimated context tokens | > `min(thresholdPercent`% of the model's context window, `triggerMaxTokens)` (defaults: **75%** / **300k tokens**) |

The trigger is the **smaller** of a percentage of the window and an absolute token ceiling. On a 200k model the percentage dominates (75% = 150k < 300k cap); on a 1M model the absolute cap bites (75% = 750k → capped to 300k), so a huge window doesn't let context balloon before compaction fires. See **Absolute token ceilings** below.

The context token count comes from the actual provider-reported usage data when available (post-turn), or is estimated from the database as a fallback.

> **Important**: messages with `redact_pending = 1` are **excluded** from compacting. Compacting waits until redaction is effective before including them.

### Per-Agent configuration

Each Agent can override the global compacting settings via its `compactingConfig` (stored as JSON in `agents.compacting_config`). Available per-Agent fields:

| Field | Type | Description |
|---|---|---|
| `thresholdPercent` | number | Context usage % before compaction triggers (default: 75) |
| `keepPercent` | number | % of context window preserved as raw messages (default: 25) |
| `summaryBudgetPercent` | number | Max % of context window for summary tokens before merge (default: 20) |
| `maxSummaries` | number | Max active summaries before telescopic merge (default: 10) |
| `keepMaxTokens` | number | **Absolute** ceiling (real tokens) on the keep-window — caps `keepPercent` (default: 100000) |
| `triggerMaxTokens` | number | **Absolute** ceiling (real tokens) on context size before compaction triggers — caps `thresholdPercent` (default: 300000) |
| `summaryMaxTokens` | number | **Absolute** ceiling (real tokens) on total summary tokens before merge — caps `summaryBudgetPercent` (default: 48000) |
| `compactingModel` | string | Model for compaction LLM calls. Special value `__agent_own__` uses the Agent's own model |
| `compactingProviderId` | string | Provider ID for the compacting model |

Per-Agent config is managed in the UI via the **Compaction** settings tab.

---

## Token-based compacting with keep-window

Instead of compacting by turn count, Hivekeep uses a **token-aware keep-window** approach: recent messages that fit within a percentage of the context window are preserved as raw context, and everything older is summarized.

### Algorithm

#### Step 1 — Determine the keep-window

```
contextWindow = model's max context tokens
keepBudget = min(keepPercent% of contextWindow,  keepMaxTokens)   // defaults: 25%, 100k

// Walk backward from newest message, accumulating tokens
for (i = newest → oldest):
    if (keepTokens + msgTokens > keepBudget): break
    keepTokens += msgTokens
    keepStartIndex = i

// Messages before keepStartIndex → to summarize
// Messages from keepStartIndex onward → kept as raw context
```

`keepBudget` is the **smaller** of `keepPercent`% of the window and the absolute
`keepMaxTokens` ceiling. The cap is what keeps the post-compaction footprint
bounded on large-window models: 25% of a 1M window would be 250k tokens of raw
messages, but `keepMaxTokens` (100k) holds it to ~100k. Per-message sizes in the
walk are counted with the **shared BPE tokenizer** (see below), so the budget is
measured in honest tokens.

#### Step 2 — Build the compacting prompt

The summary is generated by a dedicated LLM call (model configurable via `COMPACTING_MODEL`, per-Agent override, or the Agent's own model).

Verbose tool results (>500 chars) in the batch are **masked** before being sent to the summarization LLM — replaced with `[Tool result — N chars, collapsed for summarization]`. This reduces the token cost of summarization calls.

The prompt uses a structured output format with sections:

```
System: You are an assistant specialized in conversation summarization.
Your role is to produce a faithful, structured summary of the exchanges below.

Time range: {firstTimestamp} to {lastTimestamp} ({messageCount} messages)

## Output structure

### Key facts & decisions
Bullet points of important information learned, decisions made, preferences expressed.

### Completed work
What was accomplished: tasks finished, research done, problems solved.

### Open threads
Unresolved questions, pending tasks, things promised but not yet done.
(This section is CRITICAL — it ensures nothing falls through the cracks.)

### Conversation dynamics
Only if relevant: who was active, notable interactions, tone shifts.

## Rules
- Preserve ALL important facts, decisions, commitments, and expressed preferences
- Preserve the identity of who said what (use names/pseudonyms)
- Do not invent anything — only summarize what is explicitly present
- Pay special attention to OPEN THREADS — unfinished business is the most important thing to preserve

## Exchanges to summarize

{formatted_messages}
```

#### Step 3 — Save the summary

Each compaction creates a **new summary** in the `compacting_summaries` table. Summaries accumulate chronologically — they are never overwritten.

```typescript
await db.insert(compactingSummaries).values({
  id: generateUUID(),
  agentId,
  summary,
  firstMessageAt, lastMessageAt,
  firstMessageId, lastMessageId,
  messageCount,
  tokenEstimate: estimateTokens(summary),
  isInContext: true,
  depth: 0,           // depth 0 = direct summary, higher = merged
  createdAt: new Date(),
})
```

#### Step 4 — Memory maintenance

One LLM call extracts episodic memories into the archive AND rewrites the Agent's memory profile, on the messages that were just summarized (see Memory maintenance below).

#### Step 5 — Check for telescopic merge

After saving the new summary, check if summaries need merging (see Telescopic Summary Merge section below).

#### Step 6 — Clean up old summaries

If the total number of summaries (active + archived) exceeds `COMPACTING_MAX_SUMMARIES_PER_KIN` (default: 50), the oldest archived summaries are deleted.

---

## Multi-summary accumulation

Unlike a single-snapshot system, Hivekeep **accumulates multiple summaries** chronologically. Each compaction cycle creates a new summary covering a different time range. All active summaries (`isInContext = true`) are injected into the system prompt, ordered oldest to newest:

```
## Conversation summaries

### Summary 1 (2025-01-15T10:00:00Z → 2025-01-15T14:30:00Z)
[Key facts & decisions...]
[Completed work...]
[Open threads...]

### Summary 2 (2025-01-15T14:30:00Z → 2025-01-16T09:00:00Z)
[Key facts & decisions...]
[Completed work...]

### Summary 3 [compressed] (2025-01-16T09:00:00Z → 2025-01-18T16:00:00Z)
[Higher-level merged summary...]
```

This preserves temporal structure: the LLM can see when things happened and how the conversation evolved.

---

## Telescopic summary merge

When summaries accumulate beyond the budget, the oldest ones are **merged telescopically** into higher-level summaries:

### Trigger conditions

Merge runs when **either** condition is met:
- Active summary count > `maxSummaries` (default: 10)
- Total summary tokens > `min(summaryBudgetPercent`% of context window, `summaryMaxTokens)` (defaults: 20% / 48k tokens)

### Merge process

1. Take the oldest half of active summaries (minimum 2)
2. Send them to the LLM with a consolidation prompt
3. Create a new merged summary with `depth = max(source depths) + 1`
4. Archive the originals (`isInContext = false`)

Merged summaries carry a `[compressed]` marker and their depth is incremented. This tells the LLM the summary is a higher-level abstraction.

### No re-extraction

Memory maintenance does **not** run during merges — it already ran when each source summary was created at depth 0.

---

## Catch-up loop

When an Agent has accumulated a large backlog (e.g. context at 95% after a long conversation), a single compaction might not be enough. `maybeCompact()` runs in a **loop**: it keeps triggering compaction until the context usage drops below the threshold, up to a maximum of 5 cycles. SSE progress events include the current cycle and estimated total so the UI can show progress.

---

## Force compact

Users can trigger compaction manually from the UI (Agent settings → Compaction tab). Force compact bypasses the threshold check and runs `runCompacting()` directly. If there aren't enough messages to compact (< 2 messages outside the keep window), a `NOTHING_TO_COMPACT` error is persisted in the conversation history.

---

## Error persistence

Compacting errors (LLM failures, nothing to compact, etc.) are **persisted as system messages** in the conversation history with `sourceType: 'compacting'` and error details in `metadata`. This ensures errors survive page refreshes and are visible in the chat timeline.

---

## Memory maintenance

Compacting triggers one **memory maintenance** LLM call on the messages that were just summarized. It updates both memory layers at once (design in `memory.md`):

- the **archive** (`memories`): episodic items, added or updated, deduplicated at insert time;
- the **profile** (`agent_profiles`): the curated document injected into every prompt, rewritten in full.

Fusing them into a single call keeps the cost identical to the previous extraction-only call and makes the two outputs consistent by construction.

### Response format

The model returns two delimited blocks: `<archive>` holding a JSON array, and `<profile>` holding the complete new markdown document. The profile is deliberately **not** carried inside the JSON payload — a multi-line markdown document embedded in a JSON string is a reliable source of broken escaping, and a parse failure there would take the archive items down with it. Each half degrades independently: broken archive JSON still lets the profile rewrite land, and a missing profile block still applies the archive items.

### Guards

Enforced in code, not trusted to instruction-following:

- the previous `## Pinned` section is reinstated verbatim after every rewrite;
- a rewrite far over `MEMORY_PROFILE_MAX_TOKENS` drops whole trailing sections, never `## Pinned`;
- a missing or empty profile block keeps the previous document, since losing a curated profile to one bad generation is worse than a stale one.

### Routing rule

The prompt states the same profile-vs-archive test used by the prompt block and the memory tools: *should this influence the Agent's behavior in most future conversations, without anyone mentioning it?* Yes goes to the profile, no goes to the archive. Demoting a resolved item out of the profile is filing, not deletion — its trace stays in the archive and in these summaries.

### Model

`extraction_model` (app setting) → `MEMORY_EXTRACTION_MODEL` → the Agent's own model. Hard 3-minute timeout: the call is awaited inside `runCompacting`, which holds the per-Agent compacting lock.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `COMPACTING_THRESHOLD_PERCENT` | `75` | Context usage % before compaction triggers |
| `COMPACTING_KEEP_PERCENT` | `25` | % of context window preserved as raw messages |
| `COMPACTING_SUMMARY_BUDGET_PERCENT` | `20` | Max % of context window for summary tokens before telescopic merge |
| `COMPACTING_MAX_SUMMARIES` | `10` | Max active summaries before telescopic merge |
| `COMPACTING_MAX_SUMMARIES_PER_KIN` | `50` | Total summary retention per Agent (active + archived) |
| `COMPACTING_KEEP_MAX_TOKENS` | `100000` | **Absolute** ceiling (real tokens) on the keep-window — caps `keepPercent` |
| `COMPACTING_TRIGGER_MAX_TOKENS` | `300000` | **Absolute** ceiling (real tokens) before compaction triggers — caps `thresholdPercent` |
| `COMPACTING_SUMMARY_MAX_TOKENS` | `48000` | **Absolute** ceiling (real tokens) on summaries before merge — caps `summaryBudgetPercent` |
| `COMPACTING_MODEL` | Provider default | Model used for compaction summarization |

---

## Absolute token ceilings

Every percentage knob above scales with the model's context window. That is fine
at 200k, but on a **1M-token** model even a "small" 25% keep-window is 250k tokens
— and because the old `chars/4` estimate under-counted real tokens by ~2× on
tool-heavy history (see Token counting), the real footprint was larger still. A
Agent could sit at **400k+ tokens of raw kept messages** right after compaction.

Three absolute ceilings bound the real footprint regardless of window size. Each
effective budget is `min(percentage × window, cap)`:

| Budget | Percentage knob | Absolute cap | 200k model | 1M model |
|---|---|---|---|---|
| Keep-window | `keepPercent` (25%) | `keepMaxTokens` (100k) | 50k (% wins) | **100k** (cap wins) |
| Trigger | `thresholdPercent` (75%) | `triggerMaxTokens` (300k) | 150k (% wins) | **300k** (cap wins) |
| Summaries | `summaryBudgetPercent` (20%) | `summaryMaxTokens` (48k) | 40k (% wins) | **48k** (cap wins) |

On small-window models the percentage still dominates, so behaviour there is
unchanged — the caps only engage on large-window models. Resulting envelope on a
1M model: post-compaction floor ≈ 100k (keep) + ≤48k (summaries) + ~20k (system
prompt + tools) ≈ **~170k**, growing to 300k before the next compaction.

## Token counting

All compaction budgets are measured in **real** tokens (the context window is the
provider's `max_input_tokens`). Token counts come from the shared BPE tokenizer
`countTokens()` (`src/shared/token-estimator.ts`, backed by `gpt-tokenizer` /
`o200k_base`), the same estimator the chat banner and context visualizer use —
within **~5-15%** of the real provider count, versus the old `chars/4` heuristic
which under-counted JSON/tool-heavy history by ~2×. Because the budget math and
the context window are now in the same honest unit, **no estimate→real
calibration factor is needed**. The provider-reported `apiContextTokens` (ground
truth from the last turn) is still preferred for the trigger when available.

---

## SSE events

| Event | Description |
|---|---|
| `compacting:start` | Compaction started for an Agent (includes cycle number and estimated total for catch-up progress) |
| `compacting:done` | Compaction completed (includes summary and memories extracted) |
| `compacting:error` | Compaction failed (error persisted in conversation history) |

---

## Complete flow diagram

```
Message processed by the Agent
         │
         ▼
   Progressive context pipeline
   (tool masking → observation
   compaction → emergency trim)
         │
         ▼
   Token-percentage evaluation
   (context tokens >
   thresholdPercent% of
   context window?)
         │
    No ──┘└── Yes
    │          │
    ▼          ▼
  (end)    Catch-up loop (max 5 cycles)
           ┌──────────────────┐
           │ Compute keep-    │
           │ window (newest   │
           │ messages fitting │
           │ keepPercent% of  │
           │ context window)  │
           └────────┬─────────┘
                    │
                    ▼
              LLM call: generate
              structured summary
              of pre-window msgs
                    │
                    ▼
              Save NEW summary
              (accumulates, never
              overwrites)
                    │
                    ▼
              Memory maintenance
              (archive extraction
              + profile rewrite)
                    │
                    ▼
              Telescopic merge
              if summaries exceed
              budget or count
                    │
                    ▼
              Cleanup archived
              summaries (> max
              per Agent)
                    │
                    ▼
              Still above
              threshold?
                │       │
              Yes       No
                │       │
                └──┐    ▼
                   │  (end)
                   └────→ next cycle
```
