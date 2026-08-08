# Hivekeep — Memory v2: profile + archive

Redesign of the long-term memory system. Replaces per-message probabilistic
recall injection with two layers: a small curated **profile document** that is
always in context, and an **episodic archive** the Agent searches on demand
with the existing `recall` tool.

> Status: design. Supersedes the retrieval/scoring half of the current system
> described in `compacting.md` (the extraction pipeline survives in modified
> form; compaction itself is untouched).

---

## 1. Why v1 fails

Measured on the production database (2026-08-08, 205 memories, 12 Agents):

- **50% of memories were never recalled once.** Retrieval is winner-take-all:
  the top memory was injected 330 times, the next ones 191/172/165 times,
  while half the corpus stayed invisible.
- The feedback loop is structural: `retrieval_count` measures *injection*, not
  usefulness, and it multiplies the score, so injected memories get injected
  again. Importance recalibration amplified the same loop (top memories
  drifted to importance 8.6 to 10 on their own). The code already contains
  three generations of nerfs against this (`adaptiveKMinScoreRatio` lowered,
  retrieval boost capped, recalibration deltas reduced); the loop is inherent
  to the design, not a tuning problem.
- The search query is the raw incoming chat message
  (`agent-engine.ts` → `getRelevantMemories(agentId, queueItem.content)`).
  Messages like "vas-y" or "et le déploiement ?" are terrible embedding
  queries against stored fact sentences. Every mitigation built for this
  (contextual rewrite, multi-query, HyDE, LLM rerank) is opt-in via env vars
  and has never been enabled, in production or by default.
- Cost: ~10 memories injected per turn (~800-1200 tokens), mostly the same
  ones, rarely related to the message at hand.
- ~1200 lines of interacting heuristics (temporal decay per category,
  importance weight, retrieval boost, subject boost, regex intent detection,
  adaptive-K, recalibration, pruning) with no evaluation harness. Untestable
  and unfixable by iteration.

The systems around it that *do* work are deterministic: contact notes (always
injected), compaction summaries (always injected), `search_history()`
(agent-driven). Memory v2 aligns on the same two principles: **stable context
is always present; the Agent searches the rest itself.**

---

## 2. Architecture overview

```
                    ┌─────────────────────────────────────┐
                    │  System prompt (stable, cached)     │
                    │  ...persona, tools...               │
                    │  ## Your memory                     │
                    │   └─ Agent profile document         │  ← always injected
                    └─────────────────────────────────────┘

  Compaction ──► one "memory maintenance" LLM call
                   ├─ extracts episodic items ──► memories table (archive)
                   └─ rewrites the profile    ──► agent_profiles table

  Agent turn ──► recall(query) tool when it needs the past   ← on demand
                   └─ plain hybrid search (vec + FTS5, RRF, no boosts)
```

| Layer | Content | Injection | Maintained by |
|---|---|---|---|
| **Profile** | Curated markdown doc per Agent: active projects, durable preferences, key decisions, open threads | Always, in the **stable** (cached) segment | Maintenance call at compaction + `edit_profile` tool + UI |
| **Archive** | Episodic atomized memories (current `memories` table) | Never automatic; `recall` tool only | Extraction at compaction + `memorize`/`forget` tools |

User identity (name, family, role, communication style) stays in **contact
notes** (`set_contact_note`, global scope, "Current speaker" block). The
profile must not duplicate it; it covers the Agent's *domain*: what it is
working on, what was decided, what is pending.

---

## 3. The profile document

### Storage

New table `agent_profiles` (one row per Agent):

```sql
CREATE TABLE agent_profiles (
  id            TEXT PRIMARY KEY,          -- UUID
  agent_id      TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  content       TEXT NOT NULL DEFAULT '',  -- markdown
  token_estimate INTEGER NOT NULL DEFAULT 0,
  last_rewrite_at INTEGER,                 -- last LLM maintenance rewrite
  manually_edited_at INTEGER,              -- last user edit via UI
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
```

### Format

Markdown with conventional sections. The maintenance prompt enforces the
skeleton but free extra sections are allowed:

```markdown
## Pinned
- (verbatim entries the rewrite must never alter or drop)

## Active projects
- Hivekeep promo campaign: goal, current state, next step...

## Preferences & conventions
- GitHub issues on the hivekeep repo are always written in English.

## Key decisions
- (durable decisions with their reasoning, dated)

## Open threads
- (commitments, pending questions)
```

Rules:

- Base language **English** (internal LLM context, same convention as
  compaction summaries).
- Absolute dates, never relative ("decided on 2026-07-17", not "last week").
- `## Pinned` is copied verbatim by every rewrite. It is fed by the
  `edit_profile` tool with `pin: true` and by the UI. This is the guarantee
  that "remember this" survives any future rewrite.
- Budget: `MEMORY_PROFILE_MAX_TOKENS` (default **1500**, counted with the
  shared `countTokens()` BPE estimator). The maintenance prompt states the
  budget; a post-call guard hard-truncates only if the model overshoots by
  more than 20% (and logs a warning).

### Injection

A new stable block in the system prompt (prompt-builder), replacing the
volatile `## Memories` block:

```
## Your memory

This is your curated long-term memory. It is always current; trust it.

{profile content}

This document is what you *know*: current state, standing preferences,
active work. Your archive is what *happened*: dated events, past details,
one-off facts, searchable with recall(query). Rule of thumb: if it should
shape your behavior in most future conversations unprompted, it belongs
here (use edit_profile); if it is something you might need to look up when
a topic comes back, memorize() it. Nothing is ever lost by going to the
archive: search it with recall() BEFORE saying you don't remember.
```

### Profile vs archive: the boundary

The distinction is semantic vs episodic memory, and every decision point in
the system applies the same single-question test:

> **"Should this influence the Agent's behavior in most future
> conversations, without anyone mentioning it?"**
> Yes → profile. No, but it may matter when a topic comes back → archive.

Three properties make the boundary hold:

- **Economic**: the profile is present every turn, so each line pays
  permanent rent from the token budget. The archive is free until queried,
  so it can be exhaustive. Index vs content.
- **Lifecycle**: profile entries are never "deleted", they *demote*. A
  finished project leaves the profile at the next rewrite, but its
  decisions and history remain in the archive (and in compaction
  summaries), reachable via `recall`. Moving to the archive is filing, not
  forgetting.
- **Anti-hoarding**: an LLM told "only the profile is always visible" tends
  to overfill it for fear of losing information. The prompt therefore
  states explicitly that nothing is lost by going to the archive; that is
  what keeps the profile small without fighting the model.

This test is stated verbatim in three places so all decision points agree:
the `## Your memory` prompt block (above), the maintenance-call prompt
(§4, arbitrating integrate-into-profile vs add-to-archive), and the tool
descriptions of `memorize` and `edit_profile` (§5).

Placement: **stable segment**, after the persona/expertise blocks. The
profile changes only at compaction-time rewrites or explicit edits, so the
prompt cache invalidates at the same frequency the summaries block already
does today. Net effect vs v1: the per-turn volatile segment loses ~1k tokens
of memories, and the retrieval latency (embedding call per message) on the
hot path disappears.

Empty profile (new Agent): the block renders with a short note that the
profile is empty and fills itself as conversations happen.

---

## 4. The maintenance call

One LLM call per compaction batch replaces the current `extractMemories`
call. Same trigger point (`compacting.ts` step 4), same lock, same timeout
discipline (3 min hard timeout, holds the compacting lock).

**Input**: current profile + the freshly generated compaction summary + the
batch messages (tool results masked, same as today) + the existing archive
index (for update/dedup decisions, as today).

**Output**: single JSON object:

```json
{
  "archive": [
    { "action": "add" | "update", "content": "...", "category": "...",
      "subject": "...", "importance": 5, "sourceContext": "...",
      "updateIndex": 3 }
  ],
  "profile": "full rewritten markdown document"
}
```

- `archive` follows the exact semantics of the current extraction (add /
  update / skip, dedup via `isDuplicateMemory` on insert). Episodic bar stays
  where it is today.
- `profile` is the complete new document. The prompt requires: carry forward
  everything still relevant, integrate new durable information, drop resolved
  threads and completed projects (their episodic trace lives in the archive
  and summaries), copy `## Pinned` verbatim, stay under budget, absolute
  dates. Profile-vs-archive arbitration uses the boundary test from §3
  verbatim: information that should influence behavior in most future
  conversations unprompted goes into the profile; dated events and details
  that may matter when a topic comes back go to the archive. Demoting a
  resolved item from the profile is filing, not deletion: its trace must
  exist in the archive or summaries.
- If the JSON is unparseable or `profile` is missing, keep the old profile
  and log; archive items are still applied when parseable. A failed call
  never loses the profile (write is transactional: old content is only
  replaced by a validated new one).
- Model resolution unchanged: `extraction_model` app-setting →
  `MEMORY_EXTRACTION_MODEL` env → Agent's own model. (Prod: Haiku 4.5.)
- Emits `agent-profile:updated` SSE after a successful rewrite.

Merging extraction + rewrite into one call keeps cost identical to v1
(one call per compaction) while making the two outputs consistent by
construction.

### Latency of memorization

Compaction can lag hours behind. Two paths cover "remember this now":

- `memorize` (existing) writes to the archive immediately.
- `edit_profile` (new, below) patches the profile immediately for durable
  changes ("from now on, always X").

No per-N-messages incremental rewrite in v2.0; the two tools cover the gap.
(Possible later: trigger the maintenance call on a message-count timer for
Agents that rarely compact.)

---

## 5. The archive and `recall`

### Search simplification

`searchMemories()` becomes plain hybrid search:

- Vector KNN (sqlite-vec) + FTS5, fused with RRF (`rrfK`, `ftsBoost` kept).
- Similarity threshold kept as a spam filter (0.5).
- Recency as a **tie-break only** (stable sort by `updatedAt` within equal
  RRF scores), not a multiplier.
- **Deleted**: temporal decay, importance weight, retrieval-count boost,
  subject boost, category intent regexes, recency multiplier, adaptive-K,
  multi-query, HyDE, LLM rerank, contextual rewrite, importance
  recalibration, stale pruning, retrieval tracking as a scoring input.
  All their config knobs and env vars go with them (see §9).

`retrieval_count` / `last_retrieved_at` columns stay in the schema (still
incremented on `recall` results, useful as UI telemetry) but no longer feed
any score. `importance` stays as metadata shown in results and the UI, with
no score effect. No schema change to `memories`.

### Tools

- **`recall`** (existing): unchanged surface, plus optional filters
  `subject`, `category`, `since` (ISO date) mapped to SQL constraints.
  Description rewritten to position it as the archive search ("your profile
  covers the durable context; recall() searches everything episodic").
- **`memorize` / `forget` / `list_memories`** (existing): unchanged
  surface, including private/shared scope semantics. The `memorize`
  description gains the §3 boundary test: it is for episodic facts that may
  matter when a topic comes back; durable behavior-shaping information
  belongs in the profile via `edit_profile`.
- **`edit_profile`** (new, `availability: ['main']`): direct, LLM-free
  patch. Its description carries the same test from the other side: use it
  only for information that should influence behavior in most future
  conversations unprompted; everything episodic goes through `memorize`.

```typescript
edit_profile({
  section: string,        // e.g. "Preferences & conventions"; created if missing
  operation: 'append' | 'replace_section' | 'remove_line',
  content: string,        // line(s) to append / new section body / line to remove (exact match)
  pin?: boolean,          // route the entry to ## Pinned instead
})
```

Guardrails: token budget enforced (reject with a clear error if the edit
would exceed it, telling the model to prune first), `manually_edited_at`
untouched (tool edits count as agent edits), emits `agent-profile:updated`.
Prompt guidance tells the Agent to use it sparingly, for durable changes the
user states explicitly.

---

## 6. Migration and bootstrap

1. **Drizzle migration**: create `agent_profiles`. Nothing dropped.
2. **One-shot bootstrap** at boot, guarded by an `app_settings` flag
   (`memory_profile_bootstrap_done`). For each Agent with ≥1 memory and no
   profile: one LLM call (extraction model) compiling its existing memories
   (content + category + subject + updatedAt) into an initial profile
   following the section skeleton and budget. Existing memories stay in the
   archive untouched. Failures are logged and retried at next boot (the flag
   is only set when every Agent succeeded or has zero memories); until a
   profile exists the Agent simply runs with an empty profile block, which is
   strictly no worse than v1-off.
3. Bootstrap runs in the background after boot (never blocks startup) and
   respects the per-Agent compacting lock.

---

## 7. Prompt changes

- `prompt-builder.ts`: delete `buildMemoriesBlock`, relevance tags,
  category/subject grouping, memory token-budget trimming. Add
  `buildProfileBlock` (stable segment). Update the tool-guidance block that
  mentions memory (`memorize` scope guidance stays; add the
  profile-vs-archive sentence).
- `agent-engine.ts` (both call sites) and `context-preview.ts`: remove
  `getRelevantMemories` / `rewriteQueryWithContext` calls and the
  `relevantMemories` prompt param; add `profile` param (single indexed read).
- `prompt-system.md`: replace block [5]/[11] documentation with the new
  stable block; note the volatile-segment size reduction.

---

## 8. API, SSE, UI

### REST (api.md to update)

| Route | Description |
|---|---|
| `GET /api/agents/:id/profile` | `{ profile: { content, tokenEstimate, lastRewriteAt, manuallyEditedAt, updatedAt } }` (empty content if none) |
| `PUT /api/agents/:id/profile` | Body `{ content }`. Sets `manually_edited_at`. Validates token budget (413-style error `PROFILE_TOO_LARGE` if over). |
| `POST /api/agents/:id/profile/regenerate` | Runs the bootstrap-style compile from archive + summaries. Async, returns 202; result lands via SSE. |

### SSE (sse.md to update)

- `agent-profile:updated` `{ agentId, tokenEstimate, source: 'maintenance' | 'tool' | 'user' | 'regenerate' }`.
  (Named `agent-profile:*`, not `profile:*`: the latter already exists and
  carries the **user** profile from `me.ts`.)
  Client refetches on event (and via `useSSEResync` on resume).

### UI

Memories settings page (`MemoriesSettings.tsx`) gains a **Profile** tab as
the default tab:

- Markdown editor (CodeMirror, same component as the Files section), token
  count vs budget, save button, "Regenerate from archive" button
  (AlertDialog confirm since it overwrites, minus Pinned).
- The existing archive list moves to an **Archive** tab, unchanged except
  importance loses its editing emphasis (display-only badge).
- Context preview updated (profile shown in stable segment, memories block
  gone).
- Mobile: tabs already stack; editor is full-width; verify at 360-400px.
- i18n: all 10 locales, key parity via `check-locales.ts`.

Docs: `docs-site/` memory page rewritten (profile + archive model, tools,
regeneration); ships in the same change (workflow rule 12).

---

## 9. Config after v2

Kept (memory section of `config.ts`):

| Env | Default | Role |
|---|---|---|
| `MEMORY_EXTRACTION_MODEL` | Agent's own | Maintenance call model (app-setting override kept) |
| `MEMORY_EMBEDDING_MODEL` / `_PROVIDER` / `_DIMENSION` / `_TIMEOUT` | as today | Embeddings for archive search + dedup |
| `MEMORY_SIMILARITY_THRESHOLD` | 0.5 | Vector spam filter |
| `MEMORY_RRF_K` / `MEMORY_FTS_BOOST` | 60 / 0.5 | Rank fusion |
| `MEMORY_MAX_RELEVANT` | 10 | Default `recall` result count |
| `MEMORY_PROFILE_MAX_TOKENS` | 1500 | **New**: profile budget |

Removed (env + config + code paths):
`MEMORY_TEMPORAL_DECAY_LAMBDA`, `MEMORY_TEMPORAL_DECAY_FLOOR`,
`MEMORY_ADAPTIVE_K*`, `MEMORY_SUBJECT_BOOST`, `MEMORY_CATEGORY_BOOST`,
`MEMORY_RECENCY_BOOST`, `MEMORY_MULTI_QUERY_MODEL`, `MEMORY_HYDE_MODEL`,
`MEMORY_RERANK_MODEL`, `MEMORY_CONTEXTUAL_REWRITE_MODEL` (+ `_PROVIDER`
variants), `MEMORY_CONTEXTUAL_REWRITE_THRESHOLD`,
`MEMORY_RETRIEVAL_LLM_TIMEOUT`, `MEMORY_TOKEN_BUDGET`,
`MEMORY_CONSOLIDATION_*` (consolidation service deleted; insert-time dedup
covers the need). `config.md` updated accordingly, with a "removed in v2"
note for upgraders.

---

## 10. Cost accounting

| | v1 (prod) | v2 |
|---|---|---|
| Per user message | 1 embedding call + hybrid search + ~800-1200 volatile tokens | nothing (profile is in the cached stable prefix) |
| Per compaction | 1 extraction call + consolidation embeddings + recalibration + pruning | 1 maintenance call (extraction + rewrite fused) |
| Recall | forced, query = raw message | on demand, query formulated by the model |
| Steady-state prompt | ~10 stale memories, changing per turn | ≤1500-token curated doc, cached |

---

## 11. Implementation phases

Each phase compiles, passes `bun run typecheck` + `bun run test`, and is one
commit.

1. **P1 — Profile storage + injection**: migration, `profile.ts` service
   (get/set/tokens), `buildProfileBlock`, engine wiring, REST GET/PUT, SSE
   event. Profile starts empty; v1 recall still active (coexists briefly).
2. **P2 — Maintenance call**: replace `extractMemories` with the fused call
   in `compacting.ts`; transactional profile write; tests on JSON parsing and
   the keep-old-profile-on-failure path.
3. **P3 — Tools**: `edit_profile`, `recall` filters + new description,
   prompt guidance updates.
4. **P4 — The purge**: remove auto-injection call sites, scoring machinery,
   consolidation/recalibration/pruning, dead config; simplify
   `searchMemories`; update `prompt-system.md`, `config.md`, `sse.md`.
5. **P5 — Bootstrap + regenerate**: boot job, `POST .../regenerate`, flag.
6. **P6 — UI + docs**: Profile/Archive tabs, context preview, i18n (10
   locales), `docs-site/`, `api.md`, `schema.md`.

Verification on the seeded test instance (`testing-instance.md`): run a
conversation past a compaction, confirm the profile rewrite lands and the
prompt shows it; confirm `recall` still finds seeded archive items; confirm
prod-DB bootstrap output reads sensibly on a `VACUUM INTO` copy.

---

## 12. Decided defaults (and why)

- **Profile is per-Agent, not global.** Each Agent's domain differs; the
  cross-Agent layer already exists (contact global notes + shared archive
  memories). A global profile would re-create the duplication problem.
- **One fused maintenance call**, not two: same cost as v1, consistent
  outputs, one failure domain.
- **No incremental per-N-messages rewrite in v2.0**: `edit_profile` +
  `memorize` cover immediacy; revisit only if real usage shows a gap.
- **Archive schema untouched**: cheap rollback, no data loss, UI keeps
  working during the transition.
- **Consolidation deleted** rather than kept: insert-time dedup
  (`isDuplicateMemory`) already guards the archive, and archive bloat no
  longer pollutes a per-turn injection path, so its cost/benefit collapsed.
