# Hivekeep system prompt construction

This document specifies how the system prompt is assembled before each LLM call for an Agent.

It describes what the **code actually does**, not an idealized design. The source of truth is `src/server/services/prompt-builder.ts` (the assembly), `src/server/services/llm-cache-hints.ts` (how the segments reach the provider), and `src/server/tools/register.ts` (the live native-tool inventory). When this doc and those files disagree, the files win.

> **Language convention**: all prompt templates are written in English as the base language. The Agent adapts its reply language from the `## Language` block, which is rebuilt every turn from the current speaker's profile.

---

## 1. The big picture

`buildSystemPrompt(params: PromptParams): BuiltSystemPrompt` does not return one string. It returns a pair:

```ts
interface BuiltSystemPrompt {
  stable: string    // rarely-changing prefix (identity, principles, instructions, directory, MCP/channels)
  volatile: string  // per-turn content (memories, contacts, speaker, summaries, language, workspace, date)
}
```

The split exists for **Anthropic prompt caching**. The two segments are placed differently when the request is built (`buildSegmentedMessages` in `llm-cache-hints.ts`):

- `stable` becomes the actual `system` text block, marked with a cache breakpoint (`cacheControl: { type: 'ephemeral' }`). It is the long-lived cached prefix.
- `volatile` is **not** appended to the system prompt. It is wrapped in a `<system-reminder>…</system-reminder>` block and prepended to the **last user message's** content. Putting the per-turn content after the cached prefix (rather than inside it) keeps the cache from being invalidated every turn by date/time, memories, and other volatile blocks.

`joinSystemPrompt(p)` concatenates `${stable}\n\n${volatile}` back into a single string. It is used only by callers that don't care about caching (token estimation, the context-preview UI). The real LLM path (`agent-engine.ts`, `tasks.ts`) goes through `buildSegmentedMessages`, never `joinSystemPrompt`.

So the full request sent to `LLMProvider.chat()` is:

```
system:   [ {text: <stable>, cache breakpoint} ]
messages: <compacted history is already folded into the prompt, see §6 [9]>
          <recent messages, with cache breakpoints (BP3/BP4) on the right anchors>
          <last user message = <system-reminder>{volatile}</system-reminder> + original content>
tools:    <provider-native tool schemas, resolved from the Agent's toolboxes>
```

> Tools are NOT listed in the textual prompt. They are passed via the provider's native `tools` parameter (the Vercel AI SDK was removed pre-2.0). Native primitives now live under `src/server/llm/{llm,embedding,image,search,stt,tts,core}/`. The prompt only *references tools by name* inside instruction blocks; it never enumerates a tool list.

---

## 2. The `toolsEnabled` gate

`const toolsEnabled = params.toolsEnabled !== false` (prompt-builder.ts:972).

When the resolved model cannot tool-call (`LLMModel.maxTools: 0`, e.g. some Replicate completion models), the engine passes `toolsEnabled: false`. This is computed in `agent-engine.ts` via `getMaxToolsForRequest(...) > 0`.

When `toolsEnabled` is false, the builder **omits** every tool-usage section: `## Tool calling discipline`, the `## Internal instructions` mega-block, and the `## MCP Tools` summary. Without an actual tool channel, leaving that guidance in just teaches the model to emit JSON tool-call syntax as plain text.

Defaults to `true` for legacy compatibility (every built-in provider supports tools).

---

## 3. The three prompt shapes

`buildSystemPrompt` branches into three distinct shapes:

| Shape | Condition | Roughly |
|---|---|---|
| **A. Main Agent** | `else` branch (not sub-Agent, not quick session) | ~27 blocks |
| **B. Sub-Agent (task)** | `isSubAgent && taskDescription` | ~16 blocks |
| **C. Quick session** | `isQuickSession` (returns early) | 5 blocks |

Each block below is tagged `[stable]` or `[volatile]` exactly as the code segments it. The legacy `[n]` block numbers are kept in code comments and shown here in parentheses for cross-reference, but they are not contiguous and do not match emission order. Treat the order in the tables as authoritative.

### A. Main Agent prompt (prompt-builder.ts:1088–1163 + shared tail 1202–1647)

| # | Block (heading) | Seg | Fed by | Notes |
|---|---|---|---|---|
| 1 | `## Platform context` (`[0]`) | stable | hardcoded | continuous session, multi-user, queue model |
| 2 | `You are {name} (slug: {slug}), {role}.` (`[1]`) | stable | `agent.name/slug/role` | identity line |
| 3 | `## Core principles` (`[1.5]`) | stable | hardcoded | universal baseline behaviors |
| 4 | `## Tool calling discipline` (`[1.6]`) | stable | hardcoded, gated on `toolsEnabled` | intent-sentence-only-before-results rule + anti simulated-interleaving + concrete anti-patterns + image-embedding sub-block |
| 5 | `## Personality` (`[2]`) | stable | `agent.character` (if set) | injected verbatim, no translation |
| 6 | `## Expertise` (`[3]`) | stable | `agent.expertise` (if set) | injected verbatim |
| 7 | `## Platform directives` (`[3.5]`) | stable | `globalPrompt` (if set) | the admin-set global prompt (see §4) |
| 8 | `## Configurator mission` + `## Hivekeep knowledge` (`[3.6]`) | stable | `agent.kind === 'configurator'` | Queenie only (see §5) |
| 9 | `## Known contacts` | volatile | `contacts[]` | shared registry, with aka/system-user/identifier summary |
| 10 | `## Agent directory` + Collaboration & delegation | stable | `agentDirectory[]` | main-agent variant |
| 11 | `## Memories` (full code heading: `Memories · what you actually know`) | volatile | `relevantMemories[]` | scored, grouped, relevance/importance legend (see §6 [5]) |
| 12 | `## Relevant knowledge` | volatile | `relevantKnowledge[]` | knowledge-base chunks |
| 13 | `## Internal instructions (do not share…)` | stable | hardcoded, gated on `!isSubAgent && toolsEnabled` | large block |
| 14 | `## MCP Tools (external servers)` | stable | `mcpTools[]`, gated on `toolsEnabled` | one summary line per server (counts only) |
| 15 | `## External channels` + platform formatting guide | stable | `activeChannels[]` | Discord/Telegram/WhatsApp/Slack/Web formatting rules |
| 16 | `## Current speaker` | volatile | `currentSpeaker{}` | name, role, shared/user/private notes, priority-onboard prompt when unknown |
| 17 | `## Active participants` | volatile | `participants[]` | group vs 1:1 hint |
| 18 | `## Conversation state` | volatile | `conversationState{}` | visible/total counts, compaction awareness |
| 19 | `## Conversation history summaries` | volatile | `compactingSummaries[]` | see §6 [9] |
| 20 | `## Language` | volatile | `userLanguage` | per-speaker |
| 21 | `Current message from: **{platform}**` hint | volatile | `currentMessageSource{}` | one-line origin + per-platform formatting reminder |
| 22 | `## Channel origin context` | volatile | `pendingChannelContext{}` | reply auto-delivered back to the originating channel |
| 23 | `## Workspace` (+ file tree) | volatile | `workspacePath` → `generateWorkspaceTree()` | depth-limited tree |
| 24 | `## Current plan` (task_todos) | volatile | `taskTodos[]` | rare on main; primary on sub-Agents |
| 25 | `## Context` | volatile | `buildContextBlock()` | date/time/tz/version/install/RAM/uptime (see §6 [8]) |
| 26 | `## Final reminder (most important rule of this turn)` | volatile | hardcoded | recency-positioned tool-discipline tie-breaker |

### B. Sub-Agent (task) prompt (prompt-builder.ts:974–1087 + shared tail)

| # | Block | Seg | Fed by | Notes |
|---|---|---|---|---|
| 1 | `You are {name}, a specialized AI agent on Hivekeep, executing a delegated task.` | stable | `agent.name` | + one line on what Hivekeep is |
| 2 | `## Your mission` | stable | `taskDescription` | |
| 3 | `## Environment` | stable | `systemContext{}` | platform/arch/available CLIs + workspace cwd; saves probe calls |
| 4 | `## Constraints` + `## Tool calling discipline` + `## Execution discipline` + `## CRITICAL - Task resolution` | stable | hardcoded | cron-journal addendum when it's a cron task |
| 5 | `## Previous runs` | stable | `previousCronRuns[]` | cron continuity (newest first) |
| 6 | `## Learnings from previous runs` | stable | `cronLearnings[]` | accumulated lessons |
| 7 | `## Platform directives` | stable | `globalPrompt` | global prompt applies to sub-Agents too |
| 8 | `## Known contacts` | volatile | `contacts[]` | **injected**: sub-Agents DO see contacts |
| 9 | `## Agent directory` + Inter-Agent comms + Escalation | stable | `agentDirectory[]` | sub-Agent variant; references `send_message`/`list_kins` |
| 10 | `## Memories` | volatile | `relevantMemories[]` | same renderer as main |
| 11 | speaker / participants / state / summaries / language / message-hint / channel / workspace | mixed | shared tail | same blocks as main (only those with data render) |
| 12 | `## Current plan` (task_todos) | volatile | `taskTodos[]` | primary use case: the live plan, re-shown every turn |
| 13 | `## Context` | volatile | `buildContextBlock()` | |
| 14 | `## Final reminder (this turn)` | volatile | hardcoded | execution-efficiency variant (don't re-read, fan out, no shell wrappers, no safety bypass) |

> The sub-Agent shape skips: `## Platform context`, `## Core principles`, `## Personality`, `## Expertise`, the main-agent `## Internal instructions` mega-block, and the `## MCP Tools` / `## External channels` summaries. Its discipline blocks are inlined into the `## Constraints` group instead.

### C. Quick session prompt (prompt-builder.ts:1166–1200)

Returns early. Order: `## Memories` (if any, volatile) → `## Platform directives` (if set, stable) → `## Quick session` notice (stable) → `## Language` (volatile) → `## Context` (volatile). Skips contacts, agent directory, internal instructions, and MCP. Quick sessions are stateless one-offs with no main conversation history, no inter-Agent comms, and no admin tools.

---

## 4. The global prompt (`## Platform directives`)

An admin-set, platform-wide instruction block (`app_settings`, read/written via the `get_global_prompt` / `set_global_prompt` tools). Injected into all three shapes when non-empty, in the **stable** segment. Use it for conduct rules every Agent must follow ("anything all your Agents should respect?"). Queenie proposes and edits it during onboarding.

---

## 5. The Queenie configurator block

When `agent.kind === 'configurator'` (the seeded onboarding Agent, Queenie), the main-Agent shape appends a stable block built by `buildConfiguratorBlock()`:

- `## Configurator mission`: a hardcoded onboarding playbook (assess-before-asking, one thing at a time, secrets via secure-input popups never chat, reuse keys across capabilities, avatar style/subject/base, the global prompt, and the full setup checklist).
- `## Hivekeep knowledge`: loaded once (and cached) from `src/server/assets/queenie-knowledge.md`, so Queenie can answer "what can Hivekeep do?" without guessing.

The configurator-only tools (`describe_provider_config`, `request_provider_setup`, `prompt_secret`, `enable_provider_capability`, `set_default_*`, `get/set_global_prompt`, the `*_avatar_*` family, `test_channel`, `request_channel_setup`) live in the `system` tool family and are granted through Queenie's permanent toolbox. See `queenie.md` for the full configurator spec.

---

## 6. Selected block details

### [1.6] Tool calling discipline (stable, main; inlined for sub-Agents)

Result-discipline rule modeled on Claude Code's `IMPORTANT:` pattern. One short sentence of intent before a tool call is allowed (a total preamble ban is documented by Anthropic as counterproductive: it pushes models to write tool calls into plain text). What is forbidden: stating a tool's RESULTS before its output is visible (even values remembered from earlier in the conversation), simulated interleaving (a single narrated message with all the tool calls stacked at the end, the observed Opus 4.7 pathology), and ending a turn on a tool call with no follow-up text. Ships concrete BAD/GOOD anti-patterns. Necessary because personality blocks often push warm/conversational tones that fight terse tool discipline. Includes an **Embedding images** sub-block: tools that return an image URL should be embedded with `![alt](url)` markdown so the chat renderer shows them inline with click-to-zoom.

### [5] Memories: `buildMemoriesBlock` (volatile)

Long-term memories retrieved by hybrid search for the incoming message. Rendering adapts:
- ≤3 memories → flat list.
- ≥60% have a subject → grouped by subject (most natural for the LLM).
- Otherwise → grouped by category (Facts/Preferences/Decisions/Knowledge).

Each line carries indicators: `★` (importance ≥7), relevance tags `⬤`/`◉`/`○` (from the retrieval score, normalized against the top score), `[category]`, `*[shared by {agent}]*` for shared memories, subject, source context, and a relative timestamp. A `config.memory.tokenBudget` (when set) trims the lowest-relevance memories first. The header tells the Agent to weight `⬤`/`★` highest, prefer recent on conflict, and weave them in naturally.

### [8] Context: `buildContextBlock` (volatile)

Rebuilt every turn. Emits: current date (weekday + full date), current time + timezone, ISO timestamp, a timezone-interpretation note, `Platform: Hivekeep v{config.version}`, installation type (Docker / systemd-user / systemd-system / manual, with user and config-file path when known), data directory, public URL, and a live system line (`{platform} {release} ({arch}) | Uptime: … | RAM: used/total GB`). All wall-clock times render in `config.timezone`.

### [9] Conversation history summaries (volatile)

When older messages have been compacted, their summaries are injected as a `## Conversation history summaries` block in the **volatile** segment of the system prompt content (i.e. inside the `<system-reminder>` on the last user message). They are NOT a separate `role:"system"` message in the history. Each summary is rendered with its date range and a `[compressed]` flag when re-summarized (`depth > 0`). The block points the Agent at `list_summaries`/`read_summary` and `browse_history`/`search_history` to dig further back. Source: `compactingSummaries` rows with `isInContext = true`, gathered in `agent-engine.ts:buildMessageHistory`. See `compacting.md` for how summaries are produced.

### Recent messages and message prefixing

Recent (not-yet-compacted) messages go into the `messages` array as-is, with their original role. Each is prefixed with its sender's identity so the Agent can address the right person:

| Source | Prefix |
|---|---|
| User | `[{pseudonym}]` |
| Other Agent | `[Agent: {name}]` (+ request/inform/reply + request_id when applicable) |
| Task result | `[Task: {description}] Result:` |
| Cron result | `[Cron: {name}] Result:` |
| request_input reply | `[Parent response]:` |

The volatile `<system-reminder>` (per §1) is prepended to the **last user message** specifically.

---

## 7. The `PromptParams` shape

The builder takes a single `~30`-field params object. Rather than restating it (it drifts), read `PromptParams` in `prompt-builder.ts` (lines 91–184). The fields, grouped:

- **Identity / mode**: `agent { name, slug, role, character, expertise, kind }`, `isSubAgent`, `isQuickSession`, `taskDescription`, `toolsEnabled`.
- **Knowledge & people**: `contacts`, `relevantMemories`, `relevantKnowledge`, `agentDirectory`, `currentSpeaker`, `participants`.
- **Conversation**: `compactingSummaries`, `conversationState`, `currentMessageSource`, `pendingChannelContext`, `userLanguage`.
- **Platform**: `globalPrompt`, `mcpTools`, `activeChannels`, `workspacePath`.
- **Tasks**: `taskTodos`.
- **Sub-Agent extras**: `systemContext`, `previousCronRuns`, `cronLearnings`.

```ts
function buildSystemPrompt(params: PromptParams): BuiltSystemPrompt
// see prompt-builder.ts for the authoritative type
```

---

## 8. Tools

Tools are not part of the textual prompt. The Agent's available tools are resolved from its **toolboxes** (the DB-backed toolbox system), converted to the provider's native tool-schema shape, and passed in the LLM call's `tools` parameter. The prompt only references tools by name inside instruction blocks (e.g. "use `memorize()`", "delegate with `scout`").

The **authoritative native-tool inventory is `src/server/tools/register.ts`**. Do not maintain a hand-written tool list here; it always drifts. Every native tool is registered there with a tool name and a **family** (the third `register()` argument). The families below are derived from that file; consult it for the exact, current per-family tool set.

| Family (register arg) | What it covers |
|---|---|
| `browse` | one-shot web reads (`browse_url`, `extract_links`, `screenshot_url`, `http_request`) + stateful browser sessions (`browser_*`) |
| `search` | `web_search`, `list_search_providers` |
| `email` | list/read/search/send email + attachment download |
| `contacts` | Hivekeep CRM contacts (`get/search/create/update/delete_contact`, `set_contact_note`, `find_contact_by_identifier`) + read-only external address books (`*_address_book*`) |
| `calendar` | list/get/create/update/delete events across slug-resolved accounts |
| `voice` | TTS + STT discovery and actions (`text_to_speech`, `transcribe_audio`, list providers/voices/models) |
| `memory` | `recall`/`memorize`/`update_memory`/`forget`/`list_memories`/`review_memories`, history (`search_history`, `browse_history`, `read_message`, `list_summaries`, `read_summary`), knowledge base (`search_knowledge`, `list_knowledge_sources`) |
| `vault` | secrets (`get/create/update/delete/search_secret(s)`, `redact_secret_leak`) + vault entries/types/attachments |
| `tasks` | delegation & control (`spawn_self`, `spawn_agent`, `scout`, `respond_to_task`, `cancel_task`, `list_tasks`, `list_active_queues`, `get_task_detail`, `get_task_messages`), sub-Agent side (`report_to_parent`, `update_task_status`, `request_input`), cron learnings (`save/delete_run_learning`), human-in-the-loop (`prompt_human`, `notify`), reasoning (`think`), planning (`task_todos`) |
| `inter-agent` | `send_message`, `reply`, `list_kins` (registers `listAgentsTool`; the `list_kins` name is the registered identifier the prompt correctly matches) |
| `crons` | cron CRUD + journal/trigger + wake-up scheduler (`wake_me_in`, `wake_me_every`, `cancel_wakeup`, `list_wakeups`) |
| `custom` | authoring GLOBAL custom tools (`create/write/test/update/delete_custom_tool`, `run_custom_tool_setup`, `list_custom_tools`) + tool domains |
| `images` | `generate_image`, `list_image_models`, `describe_image_model` |
| `system` | provider/model discovery, platform-config (`get_platform_logs`, `restart_platform`, `get_system_info`, …), configurator provider/default/avatar/global-prompt config, and secure-input (`request_provider_setup`, `request_channel_setup`, `prompt_secret`) |
| `mcp` | MCP server management (`add/update/remove/list_mcp_server(s)`) |
| `shell` | `run_shell` |
| `file-storage` | shareable files (`store_file`, `list_stored_files`, `search_stored_files`, `get/download/update/delete_stored_file`) |
| `agent-management` | create/update/delete/get Agents + toolbox management (`list_tools`, `list/create/update/delete_toolbox`) |
| `webhooks` | webhook CRUD |
| `channels` | external messaging (`list_channels`, `send_channel_message`, `send_to_contact`, `attach_file`, `transfer_channel`, channel CRUD/activate, `list_endpoints`, …) |
| `mini-apps` | the full mini-app builder (files, storage, snapshots/rollback, docs/templates/gallery, console/reload, backend status, icon generation, maintainer) — backends can run as background services (lifecycle hooks, local crons, notifications, permission-gated secrets/LLM/Agent access) |
| `filesystem` | `read_file`, `write_file`, `edit_file`, `multi_edit`, `list_directory`, `grep` |
| `database` | `execute_sql` (opt-in, God-tier) |
| `users` | `list_users`, `get_user`, `create_invitation` |

**Custom tools** are GLOBAL, exposed separately as `custom_<slug>` (resolved by `services/custom-tools.ts`, MCP-style, not in `register.ts`), and granted via toolboxes. They carry UI-only localized `translations` that never change the LLM-visible definition.

**Tool concurrency**: within an LLM step, consecutive tools flagged `concurrencySafe: true` fuse into one parallel batch (bounded by `HIVEKEEP_MAX_TOOL_USE_CONCURRENCY`, default 10); everything else runs serially. See `tool-executor.ts` and the `ToolRegistration` flags (`readOnly`, `concurrencySafe`, `destructive`).

### Sub-Agent tool scope

Sub-Agent tool availability is governed by the **toolbox system** (and scout-toolbox resolution), not by a fixed table in the prompt builder. There is no hardcoded "sub-Agents only get tools X, Y, Z" list here. One thing the builder *does* do for sub-Agents:

- It injects `## Known contacts` and a sub-Agent `## Agent directory` with inter-Agent communication instructions, so a delegated task can read contacts and message other Agents when its toolbox grants those tools.

For the exact tools a given sub-Agent can call, consult its toolbox configuration and the `defaultDisabled`/opt-in flags in `register.ts`, not this document.

---

## 9. Token budget

The system prompt competes with the message history and the response for the context window.

- Base main-Agent prompt: roughly ~1500–3000 tokens depending on memories, contacts, and the instruction blocks.
- Memories are bounded by `config.memory.tokenBudget` when set; the workspace tree targets ~200–500 tokens.

The compacting service triggers a new summary when the history exceeds its thresholds (see `compacting.md`), keeping the messages segment within budget while older context survives as `## Conversation history summaries`.

---

## 10. Cross-references

- `src/server/services/prompt-builder.ts`: the assembly (source of truth for block content and order).
- `src/server/services/llm-cache-hints.ts`: `buildSegmentedMessages`, how `stable`/`volatile` reach the provider and where cache breakpoints land.
- `src/server/tools/register.ts`: the live native-tool inventory (source of truth for tool names and families).
- `queenie.md`: the configurator Agent spec (mission, secure-input, avatars, onboarding flow).
- `compacting.md`: how compacting summaries (block [9]) are produced and the memory-extraction pipeline.
- `sse.md`: real-time/SSE rules (orthogonal to prompt assembly, but relevant when touching shared state).
