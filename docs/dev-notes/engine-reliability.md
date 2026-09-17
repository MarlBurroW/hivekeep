# Engine reliability study

> Written 2026-08-05, after the Majordome context deadlock (fixed in `dc188c71` and
> `1ccc153e`). Field data comes from the live instance's DB and journald. Line numbers
> refer to `main` at `be5a7764`; they will drift.
>
> Goals, as set by the founder:
> 1. the reported context size must never lie;
> 2. an agent must never fail silently or sit in "processing" for hours with no way
>    to unblock it;
> 3. a causal chain that starts on an external channel must always surface an
>    outcome there — no silent crash reachable from Telegram.

## 1. Field evidence (30 days of production)

Queue latency for the one agent a non-technical user (Émilie) talks to exclusively
through Telegram, `source_type='channel'`, n=150:

| p50 | p90 | p99 | >5 min | >15 min | >30 min |
|---|---|---|---|---|---|
| 0.8 min | 4.4 min | 118 min | 14 | 11 | 9 |

Roughly 7% of her messages disappeared into a black hole for over five minutes, with
zero feedback on Telegram (see §4: the typing indicator dies after ~5 s and is never
renewed). Three days out of thirty had at least one turn above 15 minutes; the worst
turn lasted 222 minutes.

Two distinct failure modes show up in the data:

**Mode A — a monster turn serializes the queue.** 2026-08-04, 16:01–17:02: one turn
legitimately ran 60 minutes (5 steps, 1.73M cumulative input tokens, long kubectl
shell commands). The queue is FIFO per agent, so the three Telegram messages sent
during it waited 47–60 minutes, then four replies arrived in a burst. Nothing was
broken; nothing was visible either.

**Mode B — a true hang, ended only by a restart.** 2026-07-31: last engine log line
at 15:17:01, then 94 minutes of total silence until the 16:51 restart. The turns
"completed" only because boot recovery reset them. Consistent with an LLM stream that
stopped emitting (see §3.1): no error, no timeout, `await` never returns.

Also notable: `queue_items` has 2 870 rows and **no `failed` status has ever
existed** — the schema only knows `pending | processing | done`. A failed turn is
indistinguishable from a successful one at the queue level.

## 2. Why "stuck for hours" is possible at all

The per-turn cleanup is actually sound: `processNextMessage` has a `finally` that
marks the item done and releases `agentLocks` on every exit path, and boot recovery
exists for both queues (`recoverStaleProcessingItems`, queue.ts:307) and tasks
(`recoverStaleTasks`, tasks.ts:213). The stuck states are therefore not leaked
locks — they are **awaits that never resolve**, so the `finally` never runs:

| # | Hang site | Lock held | User-visible exit |
|---|---|---|---|
| 1 | LLM stream stops emitting mid-body (§3.1) | `agentLocks` + item `processing` | Stop button (works) or restart |
| 2 | Plugin `afterChat` hook never resolves (hooks/index.ts:41, no timeout) — runs *after* the abort controller was deleted at agent-engine.ts:1756 | `agentLocks`, **Stop returns 409** | none — restart only |
| 3 | Same, but after `markQueueItemDone` already ran: DB says done, UI says idle, agent silently ignores every message forever | `agentLocks` only | none — invisible even to boot recovery |
| 4 | Embedding call under compacting (compacting.ts:549/561/572/840/842 → embedding providers, no timeout anywhere) | `compactingAgents` → engine refuses every message; force-compact API answers 409 | none — restart only |
| 5 | Tool batch with an unbounded tool (§3.2) | `agentLocks` + item `processing` | Stop button |
| 6 | `maxSteps` defaults to 0 = Infinity (config.ts:467) — a looping model runs forever | same | Stop button |

**There is no admin escape hatch.** No route writes `queue_items.status`, none touches
`agentLocks`/`compactingAgents`, `recoverStaleProcessingItems` is boot-only. The only
real force-unblock in the whole system is `cancelTask` — for sub-agents, not for the
main thread.

Minor leaks found on the way: `activeAbortControllers` is not cleaned on early
returns (agent-engine.ts:1005) nor in `executeSubAgent`'s catch (tasks.ts:1924 —
`activeTaskStreams` is deleted, `activeTaskAbortControllers` is not, so
`isTaskStreaming` lies forever).

## 3. Nothing bounds time

### 3.1 The SDK timeout is a lie for streaming

`@anthropic-ai/sdk` (`client.js:325-356`) clears its 10-minute timer in a `finally`
around the header fetch: **the timer dies the moment response headers arrive**. The
entire SSE body is then read with no bound. The `x-stainless-timeout: 600` header
(anthropic-oauth.ts:169) is declarative, sent to the server, arms nothing locally.
Every one of the 10 providers iterates its stream with no stall detection
(`_anthropic-shared.ts:314`, `openai-compatible.ts:354`, `gemini.ts:479`,
`openai-codex.ts:363`, xai, openrouter, deepseek, moonshot, minimax, openai-key).

They all converge on a single `for await` in `stream-runner.ts:243`. One
inactivity-watchdog wrapper there covers all providers at once.

### 3.2 Unbounded awaits on the main turn path

| Wait | Where | Bound |
|---|---|---|
| Tool batch | tool-executor.ts:399-414 | none — the race's only other arm is the *user* abort signal; nothing arms it on a delay |
| `web_search` (all 5 providers) | search-tools.ts:257 | none — `signal` never passed |
| Gmail / MS Graph fetch | gmail.ts:209, microsoft.ts:136 | none (IMAP is properly bounded) |
| Memory LLM calls during prompt building | memory.ts:346/393/816/944 | none — the helper *accepts* `timeoutMs` and compacting uses it everywhere; these four call sites just don't pass it |
| Embeddings | embeddings.ts:36 + llm/embedding/* | none |
| OAuth token refresh (before every Anthropic request) | _anthropic-oauth-auth.ts:133 | none |
| MCP `listTools` | mcp.ts:72 | none (connect and callTool are bounded) |
| Plugin hooks (`hookRegistry.execute`) | hooks/index.ts:41-65 | none |
| Channel adapter sends (all six platforms) | telegram.ts:55, discord.ts:64, whatsapp.ts:58, matrix.ts:65, slack.ts:59, signal.ts:66 | none (fire-and-forget, leaks but doesn't block the turn) |

Well-bounded already: `http_request`, `run_shell`, `browse_url`/Playwright, IMAP,
MCP connect/callTool, compacting's own LLM calls (5 min via `safeGenerateText`).

## 4. The channel never hears about failures

There is exactly **one** call to `deliverChannelResponse` in the repo
(agent-engine.ts:1972), inside `if (!wasAborted)` and `if (fullContent && …)`.
Everything outside that path is mute on Telegram:

| Outcome of a channel-origin turn | What Émilie sees |
|---|---|
| Turn throws (the whole catch block contains zero references to channels) | **nothing** |
| Turn aborted | **nothing** (partial text saved to DB, never delivered) |
| Empty content, non-substituted | **nothing** (silent `else`) |
| `deliverChannelResponse` itself fails (Telegram API error; no retry, no 429 handling; multi-chunk messages can be delivered half-way) | **nothing**, `log.error` only |
| Inbound enqueue fails (polling offset already advanced → message lost for good) | **nothing** |
| Async sub-task fails (non-cron): parent gets an informational note, no turn runs | **nothing** |
| emptyTurn / silentStop / stepLimit fallbacks | delivered (these paths substitute `fullContent` before the delivery block — fine) |

The typing indicator is sent at most twice (enqueue + turn start), never renewed;
Telegram expires it after ~5 s. A 10-minute turn shows 9 min 55 s of dead air, and a
*hung* turn looks identical to a *working* one. Follow-up turns (`task_result`,
`wakeup`, `agent_reply` with a `channelOriginId`) emit no typing at all.

## 5. Where the context accounting still lies

The `buildMessageHistory` transformation chain itself is honest (every counter
maps to a real mutation in the returned history — verified link by link). The lies
are elsewhere:

1. **The account-effective window is recorded, then thrown away.** `dc188c71` made
   `recordApiContextOverflow` store the provider's real limit — but
   `getLastContextUsage` overwrites `contextWindow` with the registry value **on
   every read** (agent-engine.ts:467). The registry has no notion of per-account
   windows (model-info-cache is keyed by modelId alone, last-write-wins across
   providers), so "1M" from the registry beats "200k" measured from the account.
2. **Nothing is re-measured during a turn.** Per-step `usage.inputTokens` is
   available at every step (agent-engine.ts:1677-1691) and discarded; the navbar,
   `/context-usage` and compacting-proximity all read the pre-turn estimate for the
   whole duration of a multi-hour turn.
3. **In-turn tool results bypass every cap.** Fresh results are pushed raw into the
   history for the next step (agent-engine.ts:1743-1751); `read_file` is exempt from
   spilling by design; SIZE_CAP/ARGS_CAP/CONTENT_CAP only apply at the *next* turn's
   rebuild. Tasks and quick sessions have no caps and no measurement at all.
4. **Two rulers.** `maybeCompact` receives the raw, uncalibrated estimate while the
   UI shows the calibrated one; compacting sizes its keep-window on *pre-trim* DB
   content (a message the engine actually sends as a 50-token placeholder is counted
   at 80k), while context-preview measures *post-trim*. The two services disagree
   about the same conversation by construction.
5. Bonus functional bug found on the way: the vercel bridge drops `type:'file'`
   parts — **inline PDFs never reach the model at all** (vercel-bridge.ts:166-189,
   no `file` case). Not a counting lie (they aren't counted either), but user-facing.

## 6. Hardening plan

P0 = removes an entire failure class; P1 = major visibility/correctness; P2 = polish.

### Chantier 1 — time is always bounded (kills mode B)

| | Fix | Notes |
|---|---|---|
| P0 | **Stream stall watchdog** in `stream-runner.ts:243`: inactivity timer reset on every chunk (default ~120 s, config), fires the existing abort → normal error path | one wrapper covers all 10 providers |
| P0 | **Turn watchdog**: wall-clock ceiling per main turn (default ~20 min, config; excludes queue wait), arms the turn's own `AbortController` so the existing abort machinery does the cleanup | converts "stuck forever" into "failed loudly", which chantier 3 then surfaces to the channel |
| P1 | Bound the stragglers: `hookRegistry.execute` (Promise.race, ~30 s, log the offending plugin), embeddings, the 4 memory calls (just pass `timeoutMs`), web_search signal, Gmail/Graph fetch, OAuth refresh, MCP `listTools` | mechanical |
| P1 | `maxSteps` default: finite (e.g. 100) instead of 0=Infinity | |

### Chantier 2 — never stuck without an exit

| | Fix | Notes |
|---|---|---|
| P0 | **Force-reset route + UI**: `POST /api/agents/:id/force-reset` — abort stream if any, clear `agentLocks`/`compactingAgents`/controllers for that agent, reset its `processing` items to `pending`, SSE refresh. UI entry appears on an agent processing for > N min | the missing escape hatch; `cancelTask` proves the pattern |
| P1 | Age-based sweeper: `processing` items older than 2× the turn ceiling reset + `log.warn` + web notification — recovery is no longer boot-only | catches hang class #3 (item done, lock held) indirectly via notification |
| P1 | Stuck-agent notification: "Agent X processing for 15 min" via `createNotification`, so the operator sees what Émilie can't | |
| P2 | Fix the two controller leaks (early return agent-engine.ts:1005; `executeSubAgent` catch) with `finally` blocks | |

### Chantier 3 — the causal chain always surfaces (the Émilie guarantee)

| | Fix | Notes |
|---|---|---|
| P0 | **Errors reach the channel**: resolve the channel target *before* the try (peek, don't pop), use it in the catch and in the dead-end elses to send a short failure notice to the channel (rate-limited per channel) | invariant: a channel-origin turn ends in exactly one of {reply delivered, error notice delivered} |
| P0 | **Typing keepalive**: interval ~5 s while the turn runs, cleared in `finally`; also for follow-up turns carrying `channelOriginId` | makes "working" distinguishable from "dead"; with the watchdog, "dead" now ends |
| P1 | `deliverChannelResponse`: retry with backoff, honor Telegram 429 `retry_after`, and on final failure call `reportUndeliveredChannelReply` + notification (today: `log.error` and nothing else) | |
| P1 | Queue-wait feedback: a channel message waiting > N min behind a long turn gets one "still busy on the previous request" notice | addresses mode A, which is otherwise legitimate |
| P1 | Inbound robustness: don't advance the polling offset when processing failed; async task failure with a `channelOriginId` notifies the channel | |

### Chantier 4 — the context never lies

| | Fix | Notes |
|---|---|---|
| P0 | Stop overwriting the observed window: persist an **effective window** per agent (min(registry, last observed from overflow)), make `getLastContextUsage` respect it | one-line-ish; un-neuters `dc188c71` |
| P1 | Per-step ground truth: feed each step's `usage.inputTokens` into the usage cache during the turn (navbar + compacting see real growth live) | the data is already in hand and currently discarded |
| P1 | One ruler: `maybeCompact` gets the calibrated estimate (or last per-step api count); compacting's keep-window measured post-trim like the engine | |
| P1 | In-turn caps: spill-wrap `read_file` (or cap it), apply SIZE_CAP to results pushed mid-turn, same for tasks and quick sessions | |
| P2 | Fix the dropped `file` parts in the bridge (PDFs currently never reach the model) — and count them | separate functional bug |
| P2 | Preflight: before each step, if the effective context approaches the effective window, compact/trim instead of collecting a 400 | |

### Suggested order

The P0 line (~5 focused changes) delivers the three guarantees end to end:
stall+turn watchdogs (1) make every turn finite; the error path they trigger is made
visible on the channel (3); force-reset (2) covers whatever slips through; the
effective-window fix (4) stops the recurrence of the original deadlock. P1 hardens
each pillar independently and can ship piecemeal.
