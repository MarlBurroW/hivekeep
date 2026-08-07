---
title: Toolboxes
description: "Toolboxes scope which native tools an Agent can use. Pick the right set so each Agent has exactly the capabilities its job needs."
---

A **toolbox** is a named set of tools. It is how you decide what an Agent (and the sub-Agents it spawns) is allowed to do. Give an Agent the `research` toolbox and it can browse the web and write memories; give it the `email` toolbox and it can read and send mail; give it nothing and it can still read and write files but has no web, no memory, and no admin powers.

This matters because Hivekeep ships with a large catalogue of native tools. Handing every Agent everything is both confusing for the model and risky. Toolboxes let you build focused specialists: a researcher with web and memory, an ops Agent with the vault and HTTP, a coding Agent with the filesystem and shell.

## What a toolbox actually is

A toolbox is an explicit allow-list of individual tool names. There is one special value: `"*"`, which means "every native tool plus every enabled custom tool". (The `"*"` wildcard does **not** cover MCP or plugin tools; those must be listed by their explicit name in a toolbox.)

An Agent references an **array** of toolboxes. The tools it ends up with are:

```
CORE_TOOLS  UNION  (every tool listed across all its toolboxes)
```

### The core floor

`CORE_TOOLS` is a mandatory floor that is **always present**, no matter which toolboxes you pick (even none). It is the minimum any Agent needs to function:

- File operations: `read_file`, `write_file`, `edit_file`, `multi_edit`, `list_directory`, `grep`
- Shell: `run_shell`
- The sub-Agent reply protocol: `update_task_status`, `request_input`, `report_to_parent`
- Human-in-the-loop: `prompt_human`, `notify`
- Secure secret entry: `prompt_secret` (the value goes to the vault, never to the model)
- Attachments and reasoning aids: `attach_file`, `think`, `task_todos`

The floor deliberately does **not** include web, memory, channels, contacts, images, or any provider/admin tools. Those only arrive through a toolbox.

:::caution
An Agent with an **empty** toolbox list is stripped to the core floor only. It will correctly tell you it lacks web search, memory, and so on. Do not "leave it empty for everything": empty means floor only. The `create_agent` tool defaults an *omitted* toolbox argument to the `all` toolbox for convenience, but an explicit empty list is honored as floor-only.
:::

## Built-in toolboxes

Hivekeep seeds these built-in toolboxes idempotently at startup. They are kept in sync with their definitions on every boot and **cannot be edited or deleted**.

| Toolbox | What it grants |
|---|---|
| `all` | Every native tool plus every enabled custom tool. MCP and plugin tools still need to be listed by name. |
| `research` | Web browsing and history, summaries, and full read/write memory (`web_search`, `browse_url`, `extract_links`, `screenshot_url`, `search_history`, `recall`, `memorize`, `update_memory`, `forget`, ... and `scout`). |
| `ops` | Operations and integrations: memory, vault secrets, redaction, `http_request`, `get_system_info`, and `scout`. |
| `code` | Implementation work: task introspection, web docs lookup, **read-only** memory, and `scout`. |
| `scout` | Read-only exploration only: `grep`, `read_file`, `list_directory`, `web_search`, `browse_url`, `extract_links`. No writes, no memory. This is the toolbox a delegated scout runs with. |
| `email` | Email account access: list, read, search, send, and download attachments through connected accounts. |
| `calendar` | Calendar access (Google, Outlook, CalDAV): list and search events, create, update, delete. |
| `address-book` | Read-only access to **external** address books (iCloud, ...), distinct from Hivekeep's own contacts. |
| `configurator` | The configuration toolbox used by [Queenie](/docs/features/queenie/). See below. |

The `code`, `research`, and `ops` toolboxes all include the `scout` tool so an Agent can offload heavy read-only exploration to a cheaper model. See [Scout](/docs/features/scout/) for how that delegation works.

### The configurator toolbox

The `configurator` toolbox is the one assigned to [Queenie](/docs/features/queenie/), the onboarding and configuration Agent. It is a broad, configuration-focused set that lets one Agent set the whole platform up through conversation:

- **Providers and defaults**: discover provider types and config schemas, connect and test providers via secure popups (`request_provider_setup`, `test_provider`), enable extra capabilities on an existing key (`enable_provider_capability`), and set the default models and providers (`set_default_model`, `set_default_provider`, `get_default_models`).
- **Global prompt and avatars**: read and write the global prompt, and manage the avatar style, subject, and base image.
- **Agents and toolboxes**: create, update, and inspect Agents, browse every tool with `list_tools`, and compose minimal toolboxes (`create_toolbox`, `update_toolbox`, `delete_toolbox`) so a new Agent gets exactly what it needs.
- **Contacts and memory**: manage the user's contact record and write memories.
- **Channels**: connect and test channels via secure popups.
- **Diagnostics and platform**: the read-only `get_setup_health` doctor tool, plus platform config and logs.

Notably, several of these tools (`create_agent`, `update_agent`, the platform tools) are otherwise disabled by default. Listing a tool by name in a toolbox grants it, which is how Queenie gets capabilities a regular Agent would not have out of the box.

## Assigning a toolbox to an Agent

Tool grants are managed **exclusively** through toolboxes. To set which toolboxes an Agent has:

1. Open the Agent in the UI and go to its **Tools** tab.
2. Select one or more toolboxes. Selecting none leaves the Agent on the core floor only.

Queenie can also build and assign toolboxes for you in conversation: she browses the catalogue with `list_tools`, creates a tight custom toolbox listing only the tools a specialist needs, and grants it when she creates the Agent. Prefer a focused custom toolbox over `all` for a specialized Agent.

Custom (user-created) toolboxes can be edited with `update_toolbox` and removed with `delete_toolbox`. Built-in toolboxes are read-only.

## Individual grants & agents requesting tools

Toolboxes are the fast way to hand an Agent a coherent set, but they are not the only way anymore. Each Agent also carries **individual grants**: single tools added on top of its toolboxes. You manage them from the Agent's **Tools tab → Individual grants** (add from the full catalogue, remove with one click), and they resolve as `core floor ∪ toolboxes ∪ grants`.

Agents can also ask for tools themselves. Every Agent's core floor includes `list_tools` (discover everything the platform offers) and `request_tool_access`: when a capability is missing, the Agent names the exact tools it needs and why, and an **approval card** appears in the conversation, one pre-checked checkbox per tool plus the Agent's reason. Grant everything, a subset, or deny; any workspace user can respond. Approved tools become permanent individual grants (revocable from the Tools tab), and the Agent resumes immediately with the verdict.

## Main Agents vs sub-Agents

Tool availability is not the same in every context. Each tool declares an **availability** of `main`, `sub-agent`, or both:

- **Main** is the primary Agent in a conversation.
- **Sub-agent** is an ephemeral instance spawned for delegated work (a task or a scout).

Administrative tools (creating crons, webhooks, channels, managing Agents) are typically **main-only**, so even if a sub-Agent's toolbox lists them, they are filtered out for the sub-Agent context. Sub-Agents do keep access to the standard read/write tools their toolbox grants (memory, web, files, contacts) and to inter-Agent communication. A scout sub-Agent is deliberately the most restricted case: it runs with the `scout` toolbox, which has no writes and no ability to spawn or scout further, so a scout is always a leaf.

## Tool flags: readOnly, concurrencySafe, destructive

Independently of toolboxes, every tool carries three optional behavioural flags. They do not change *whether* an Agent can call a tool (that is what toolboxes decide); they describe *how* the tool behaves. All three default to `false` (the conservative assumption: a tool writes, is not safe to parallelize, and is not destructive).

| Flag | Meaning |
|---|---|
| `readOnly` | The tool never modifies external state; it is a pure read. Used to bundle consecutive read-only calls into one parallel batch. A `get_*` or `list_*` tool usually qualifies; anything that writes a log, caches to disk, or mutates upstream state does not. |
| `concurrencySafe` | Calling this tool in parallel with other concurrency-safe tools within the same LLM step is correct. When set, it runs alongside other safe tools in a batch bounded by `HIVEKEEP_MAX_TOOL_USE_CONCURRENCY` (default 10). Tools without it each run alone, in order. Stateful or order-dependent tools stay at `false`. |
| `destructive` | The tool may delete or overwrite data the user cares about (for example removing a record). This is a user-facing signal surfaced as a confirmation prompt; it does not change execution scheduling. |

Within one LLM step, the tool executor partitions calls into batches: consecutive tools flagged `concurrencySafe` fuse into a single parallel batch, and every other tool runs alone in its own serial batch.

## The plugins tool domain

Native tools are organized into internal domains (memory, web, channels, and so on) for registration and discovery. Plugins extend this: an installed plugin can register **additional** tools that join the same registry, namespaced with a `plugin_` prefix.

Plugin tools (and MCP tools, prefixed `mcp_`) behave differently from native and custom tools when it comes to the wildcard. The `"*"` value in a toolbox expands to native tools plus enabled custom tools only. It deliberately **excludes** `plugin_*` and `mcp_*` tools. To grant a plugin or MCP tool to an Agent, a toolbox must list it by its explicit name. Custom tools (the user's own scripts, exposed as `custom_<slug>`) are first-class extensions and *do* ride the wildcard once enabled.

## Related pages

- [Queenie, guided setup](/docs/features/queenie/): uses the `configurator` toolbox.
- [Scout](/docs/features/scout/): the cheap read-only delegation that the `scout` toolbox powers.
- [Native Tools](/docs/agents/tools/): the full catalogue of tools a toolbox can grant.
- [MCP (Model Context Protocol)](/docs/features/mcp/): external tools that must be granted by name.
