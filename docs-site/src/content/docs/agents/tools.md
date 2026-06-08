---
title: Tools
description: Give your Agents capabilities with built-in tools, MCP servers, and custom scripts.
---

Agents interact with the world through **tools**: functions they can call during conversations. Hivekeep provides 100+ built-in tools, plus support for MCP servers and custom scripts.

## Built-in tools

### Memory & Knowledge

| Tool | Description |
|---|---|
| `recall` | Semantic search across memories |
| `memorize` | Store a new memory |
| `update_memory` | Edit an existing memory |
| `forget` | Delete a memory |
| `list_memories` | Browse all memories with filters |
| `review_memories` | Review and curate memories |
| `search_history` | Full-text search through past conversation messages |
| `browse_history` | Browse messages by date range with pagination |
| `list_summaries` | List all compacting summaries (active and archived) with metadata |
| `read_summary` | Read the full text of a specific compacting summary by ID |
| `search_knowledge` | Search the knowledge base (uploaded documents) |
| `list_knowledge_sources` | List available knowledge sources |

### Web & Browsing

| Tool | Description |
|---|---|
| `web_search` | Search the web (provider configurable per Agent) |
| `browse_url` | Fetch and read a web page |
| `extract_links` | Extract all links from a URL |
| `screenshot_url` | Take a screenshot of a web page |

### Contacts

| Tool | Description |
|---|---|
| `get_contact` | Get full contact details by ID |
| `search_contacts` | Search across all contacts |
| `create_contact` | Create a new contact with identifiers |
| `update_contact` | Update contact info or add identifiers |
| `delete_contact` | Remove a contact |
| `set_contact_note` | Add private or global notes to a contact |
| `find_contact_by_identifier` | Look up a contact by platform/identifier |

### Vault & Secrets

| Tool | Description |
|---|---|
| `get_secret` | Retrieve a secret value by key |
| `create_secret` | Store a new secret |
| `update_secret` | Update an existing secret |
| `delete_secret` | Remove a secret |
| `search_secrets` | Search secrets by query |
| `redact_message` | Redact sensitive content from a chat message |
| `get_vault_entry` | Retrieve a structured vault entry |
| `create_vault_entry` | Create a structured vault entry |
| `create_vault_type` | Define a custom vault type (e.g. "WiFi Network") |
| `get_vault_attachment` | Retrieve a vault entry's attachment |

### Tasks (multi-agent)

These tools let an Agent spawn background sub-agents and manage delegated work:

| Tool | Availability | Description |
|---|---|---|
| `spawn_self` | main | Spawn a sub-agent of yourself |
| `spawn_agent` | main | Spawn a sub-agent of another Agent |
| `respond_to_task` | main | Respond to a completed/failed task |
| `cancel_task` | main | Cancel a running task |
| `list_tasks` | main | List all tasks |
| `list_active_queues` | main | List active concurrency groups with status (active/queued counts) |
| `get_task_detail` | main | Get details of a specific task |
| `report_to_parent` | sub-agent | Send progress updates to the parent |
| `update_task_status` | sub-agent | Mark the task as completed or failed (**mandatory**) |
| `request_input` | sub-agent | Ask the parent for clarification |

#### Concurrency groups

`spawn_self` and `spawn_agent` support optional concurrency control:

- **`concurrency_group`**: Queue name (e.g. `"batch-issues"`, `"api-calls"`). Tasks in the same group are limited to `concurrency_max` parallel executions.
- **`concurrency_max`**: Max concurrent tasks in the group. Required if `concurrency_group` is set. Default: 1.

Excess tasks enter `queued` status and are automatically promoted (FIFO) when a slot opens. Use `list_active_queues` to monitor queue status.

### Inter-Agent communication

| Tool | Description |
|---|---|
| `send_message` | Send a message to another Agent (request or inform) |
| `reply` | Reply to an inter-Agent request |
| `list_kins` | List all available Agents |

### Automation & Scheduling

| Tool | Description |
|---|---|
| `create_cron` | Create a scheduled recurring task |
| `update_cron` | Update a cron job |
| `delete_cron` | Remove a cron job |
| `list_crons` | List all cron jobs |
| `get_cron_journal` | View a cron's execution history |
| `trigger_cron` | Manually trigger a cron job |
| `wake_me_in` | Set a one-shot timer ("remind me in 30 minutes") |
| `cancel_wakeup` | Cancel a pending wakeup |
| `list_wakeups` | List pending wakeups |

### Mini-Apps

| Tool | Description |
|---|---|
| `create_mini_app` | Create a new mini-app |
| `update_mini_app` | Update app metadata |
| `delete_mini_app` | Delete an app |
| `list_mini_apps` | List all mini-apps |
| `write_mini_app_file` | Write a file to an app's workspace |
| `read_mini_app_file` | Read a file from an app |
| `delete_mini_app_file` | Delete a file |
| `list_mini_app_files` | List all files in an app |
| `get_mini_app_storage` | Read a persistent KV entry |
| `set_mini_app_storage` | Write a persistent KV entry |
| `delete_mini_app_storage` | Delete a KV entry |
| `list_mini_app_storage` | List all KV keys |
| `clear_mini_app_storage` | Clear all KV entries |
| `create_mini_app_snapshot` | Save a snapshot before risky changes |
| `list_mini_app_snapshots` | List available snapshots |
| `rollback_mini_app` | Restore from a snapshot |
| `get_mini_app_templates` | Browse starter templates |
| `get_mini_app_docs` | Get mini-app SDK documentation |
| `browse_mini_apps` | Browse the App Gallery (apps from all Agents) |
| `generate_mini_app_icon` | Generate an icon for an app |
| `get_mini_app_console` | Get recent console output (logs, warnings, errors) from a running mini-app |
| `edit_mini_app_file` | Edit a mini-app file by replacing exact text (single match by default, optional `replaceAll`) |
| `multi_edit_mini_app_file` | Apply multiple text replacements to a single mini-app file atomically |

### Channels

| Tool | Description |
|---|---|
| `list_channels` | List configured messaging channels |
| `list_channel_conversations` | List recent conversations on a channel |
| `send_channel_message` | Send a message to a channel |
| `create_channel` | Create a new messaging channel |
| `update_channel` | Update channel configuration |
| `delete_channel` | Delete a messaging channel |
| `activate_channel` | Activate an inactive channel |
| `deactivate_channel` | Deactivate an active channel |

### Files & Images

| Tool | Description |
|---|---|
| `store_file` | Create a shareable file (text, base64, URL, or workspace path) |
| `get_stored_file` | Get file metadata and download URL |
| `list_stored_files` | List all stored files |
| `search_stored_files` | Search files by name or description |
| `update_stored_file` | Update file metadata |
| `delete_stored_file` | Delete a stored file |
| `attach_file` | Attach a file to the current message |
| `list_image_models` | Discover image models available across configured providers (with `maxImageInputs`: 0 = text-to-image, 1 = single-image edit, N>1 = multi-reference) |
| `describe_image_model` | Fetch the tunable per-model parameters (seed, guidance, style, lora_scale, …) for a chosen model, call this before `generate_image` to populate its `params` field |
| `generate_image` | Generate an image with a chosen model. Accepts a text `prompt`, optional `imageUrls` array (source images, capped by the model's `maxImageInputs`), and optional `params` from `describe_image_model` |

#### Image generation workflow

The three image tools are designed to be chained:

1. **`list_image_models`**: see what's available across the user's configured providers. Each entry includes `maxImageInputs` so you know whether the model is text-to-image only (0), single-image edit/inpainting (1), or multi-reference (N>1, e.g. Nano Banana Pro, Flux-Kontext multi).
2. **`describe_image_model`** *(optional but recommended)*, for the model you want to use, fetch its parameter schema (each entry has `type`, `description`, `default`, and either an `enum` or `minimum`/`maximum`). Image-input fields are deliberately excluded, those are driven by `generate_image`'s `imageUrls`, not by `params`.
3. **`generate_image`**: provide `prompt`, optional `imageUrls` (one or more URLs from the conversation or a previous `generate_image` call), and optional `params` from step 2. Validation is loose on the client side: an invalid `params` value surfaces as a 422 from the upstream provider, which round-trips back as a tool error so you can self-correct on the next call.

### Webhooks

| Tool | Description |
|---|---|
| `create_webhook` | Create an incoming webhook with optional payload filtering and dispatch mode |
| `update_webhook` | Update webhook configuration, including filters and dispatch mode |
| `delete_webhook` | Remove a webhook |
| `list_webhooks` | List all webhooks with filter, dispatch, and stats info |

Webhooks support **payload filtering** to drop irrelevant events before they reach the Agent queue, saving LLM tokens. Two filter modes are available:

- **Simple mode** (`filter_mode: "simple"`): Extract a value from the JSON payload using a dot-notation path (`filter_field`, e.g. `"action"` or `"event.type"`) and match against an allowlist (`filter_allowed_values`). Case-insensitive matching.
- **Advanced mode** (`filter_mode: "advanced"`): Test the raw payload body against a regex pattern (`filter_expression`).

Set `filter_mode` to `null` to disable filtering.

#### Dispatch modes

Webhooks support two dispatch modes:

- **`conversation`** (default): The payload is injected as a message in the Agent's main conversation session.
- **`task`**: The payload spawns an autonomous sub-task with a configurable prompt template.

Task mode parameters:

| Parameter | Description |
|---|---|
| `dispatch_mode` | `"conversation"` or `"task"` |
| `task_title_template` | Template for task title. Use `{{field.path}}` placeholders resolved against the JSON payload (e.g. `"GitHub: {{action}} on #{{issue.number}}"`) |
| `task_prompt_template` | Template for the task description/prompt. Use `{{field.path}}` placeholders and `{{__payload__}}` for the full raw payload |
| `max_concurrent_tasks` | Max concurrent webhook-spawned tasks. Default: 1. `0` = unlimited. Uses the concurrency group system internally |

### Agent Management

| Tool | Description |
|---|---|
| `create_agent` | Create a new Agent |
| `update_agent` | Update an Agent's configuration |
| `delete_agent` | Delete an Agent |
| `get_agent_details` | Get full details of an Agent |

:::note
Agent management tools are powerful (they change platform structure). They are granted only when an Agent references a toolbox that lists them by name (or the `all` toolbox). They are not part of the curated default toolboxes.
:::

### User Management

| Tool | Description |
|---|---|
| `list_users` | List all platform users |
| `get_user` | Get user details |
| `create_invitation` | Create a signup invitation link |

### Human-in-the-loop

| Tool | Availability | Description |
|---|---|---|
| `prompt_human` | main, sub-agent | Ask the user a question and wait for a response |
| `notify` | main, sub-agent | Send a notification to the user |

### Filesystem & Code

| Tool | Description |
|---|---|
| `read_file` | Read a text file or extract text from a PDF. Supports offset/limit for large files |
| `write_file` | Create or overwrite a file |
| `edit_file` | Replace exact text in a file. Supports `replaceAll` flag for bulk find-and-replace |
| `multi_edit` | Apply multiple text replacements to a single file atomically (all succeed or none applied) |
| `list_directory` | List files and directories with optional glob pattern filtering |
| `grep` | Regex search across files using ripgrep (with grep fallback). Supports 3 output modes: `content`, `files_with_matches`, `count`. Glob filtering, context lines, multiline mode |

:::tip[Tool selection guidance]
The system prompt includes a tool selection table that steers Agents toward structured file tools over `run_shell`:

- **Search file contents** → `grep` (not `run_shell` with grep/rg)
- **Find files by pattern** → `list_directory` with pattern (not `run_shell` with find/ls)
- **Single text replacement** → `edit_file` (not `run_shell` with sed/awk)
- **Replace all occurrences** → `edit_file` with `replaceAll=true`
- **Multiple edits, same file** → `multi_edit` (not sequential `edit_file` calls)
- **Git, builds, tests** → `run_shell`
:::

### System & Advanced

| Tool | Description |
|---|---|
| `run_shell` | Execute a shell command (main + sub-agent) |
| `http_request` | Make HTTP requests to external APIs |
| `get_platform_config` | Read current Hivekeep configuration (sensitive values redacted) |
| `get_platform_logs` | View Hivekeep platform logs (dangerous; grant via toolbox) |
| `update_platform_config` | Modify a config value in the .env file (dangerous; grant via toolbox) |
| `restart_platform` | Trigger a graceful restart of Hivekeep (dangerous; grant via toolbox) |
| `get_system_info` | Get system/platform information |
| `get_setup_health` | Read-only setup diagnostic: capability coverage, invalid providers, stale defaults, channel status, public-URL sanity, plus a prioritized fix list |
| `list_providers` | List all configured AI providers with their capabilities (available to every Agent, not just the configurator) |
| `list_models` | List available models across providers, optionally filtered by capability (llm, image, embedding, search, rerank). Available to every Agent |
| `execute_sql` | Run raw SQL on the database (dangerous; grant via toolbox) |

### MCP Server Management

| Tool | Description |
|---|---|
| `add_mcp_server` | Register a new MCP server |
| `update_mcp_server` | Update MCP server configuration |
| `remove_mcp_server` | Remove an MCP server |
| `list_mcp_servers` | List configured MCP servers |

### Custom Tools

Custom tools are **global** and script-based. The authoring tools below create and manage them; each finished tool is then exposed to Agents under its own name, `custom_<slug>` (resolved separately, not listed in this registry), and runs with its configured timeout.

| Tool | Description |
|---|---|
| `create_custom_tool` | Create a custom tool definition |
| `write_custom_tool_file` | Write or update the tool's script file |
| `run_custom_tool_setup` | Run the tool's one-time setup step (e.g. install dependencies) |
| `test_custom_tool` | Execute a custom tool to validate it before publishing |
| `update_custom_tool` | Update a custom tool's metadata or config |
| `delete_custom_tool` | Remove a custom tool |
| `list_custom_tools` | List registered custom tools |
| `create_tool_domain` | Create a tool domain (logical grouping for custom tools) |
| `list_tool_domains` | List tool domains |
| `update_tool_domain` | Update a tool domain |
| `delete_tool_domain` | Remove a tool domain |

Custom tool execution timeout is configurable via environment variables:

- `HIVEKEEP_CUSTOM_TOOL_TIMEOUT`, default timeout (default: 30s)
- `HIVEKEEP_CUSTOM_TOOL_MAX_TIMEOUT`, maximum allowed timeout (default: 300s / 5min)

Per-invocation timeout values passed by the Agent are clamped between 1 second and the server maximum.

## Tool configuration

Tool access is governed by **toolboxes**: the single tool-grant primitive for both main Agents and tasks, across all four tool sources (native, plugin, MCP, custom). There is no per-Agent deny-list, no MCP access gate, and no capability flags.

Each Agent (and each task/cron) references an array of toolbox ids:

```json
{
  "toolboxIds": ["all"]
}
```

The resolved toolset is:

```
allowed = CORE_TOOLS ∪ (union of every referenced toolbox's tool names)
toolset = { tool ∈ universe | tool ∈ allowed }
```

- **CORE_TOOLS**: a mandatory floor of always-available tools, layered on top of any selection. Even an empty toolbox list still gets the core floor.
- **A toolbox** lists tool names by their stable name. The built-in `all` toolbox uses `*`, which expands to every native tool plus every enabled custom tool. MCP and plugin tools must still be listed by name to be granted (`*` does not cover them).
- An empty / null selection resolves to the core floor only. Existing Agents that predate toolboxes are migrated to an explicit `['all']` selection at boot, preserving their previous behavior.

Assign toolboxes in the Agent's settings page in the UI.

### Built-in toolboxes

| Toolbox | Purpose |
|---|---|
| `all` | All native tools plus all enabled custom tools (MCP/plugin tools still granted by name) |
| `code` | Ticket-bound implementation: project/ticket tools, web docs lookup, read-only memory, project knowledge |
| `research` | Web browsing, history/summaries, full memory read/write |
| `ops` | Memory, vault secrets, redaction, HTTP requests, system info |
| `scout` | Read-only exploration: grep, file/directory reads, web lookups (no writes) |
| `email` | Email account access (list, read, search, send) |
| `address-book` | Read-only external address books (iCloud, …) |
| `calendar` | Calendar access (list/create/update/delete events) |
| `configurator` | Platform setup set used by the Queenie onboarding guide |

You can also create custom toolboxes via the toolbox management tools (`create_toolbox`, `update_toolbox`, `delete_toolbox`, `list_toolboxes`, `list_tools`).

## Dangerous tools

There is no separate "opt-in" allow-list. Powerful or destructive tools are simply not part of curated toolboxes by default: an Agent receives them only when a toolbox it references lists the tool by name (or via the `all` wildcard for native tools). Grant these deliberately:

| Tools | Why to grant carefully |
|---|---|
| `create_agent`, `update_agent`, `delete_agent`, `get_agent_details` | Can modify platform structure |
| Plugin management tools | Can install/remove server extensions |
| `get_platform_logs` | Exposes internal server logs |
| `update_platform_config` | Can modify server configuration |
| `restart_platform` | Can restart the entire Hivekeep process |
| `execute_sql` | Direct database access, use with extreme caution |

For sub-agents, a hard exclusion floor is subtracted after the allow-list, so even an `all` toolbox cannot grant a main-session-only tool to a task.

## Tool availability

Tools declare which contexts they're available in:

| Context | Description |
|---|---|
| **main** | The primary Agent agent in a conversation |
| **sub-agent** | A sub-agent spawned via `spawn_self` or `spawn_agent` |

Most tools are **main-only**. The following are also available to sub-agents:

- `report_to_parent`, `update_task_status`, `request_input` (sub-agent only)
- `save_run_learning`, `delete_run_learning` (sub-agent only, cron tasks only, persist lessons learned across cron runs)
- `prompt_human`, `notify`, `run_shell`, `http_request`

Sub-agents have access to standard tools (memory, web, contacts, vault, files, etc.) and **inter-Agent communication** (`send_message`, `list_kins`), but not administrative tools (cron, webhooks, channels, agent management).

When a sub-agent sends an inter-Agent message:
- **`request` type**: The task suspends (`awaiting_agent_response` status) until the recipient replies or the timeout expires (default: 5 minutes)
- **`inform` type**: Fire-and-forget, the task continues immediately
- Sub-agents can make up to 3 inter-Agent requests per task (configurable via `maxInterAgentRequests`)

## MCP servers

[Model Context Protocol](https://modelcontextprotocol.io/) servers extend Agents with external tools. Agents can even manage their own MCP connections (with user approval).

MCP servers added by an Agent start in `pending_approval` status and must be approved by an admin before they become active.

MCP servers are global once active: their tools join the universe of grantable tools. To expose specific MCP tools to an Agent, list them by name in a toolbox the Agent references (the `all` wildcard does not auto-grant MCP tools).

To connect an MCP server:
1. Go to Settings > MCP Servers
2. Add the server command, args, and environment variables
3. Add the MCP tool names to a toolbox, then assign that toolbox to the Agent

Agents can also manage MCP servers programmatically using `add_mcp_server`, `update_mcp_server`, `remove_mcp_server`, and `list_mcp_servers`.

## Custom tools

Agents can create their own tools by writing scripts:

1. The Agent calls `create_custom_tool` with a name and description, then `write_custom_tool_file` to add the script
2. If the tool needs dependencies, the Agent runs `run_custom_tool_setup` once
3. The Agent validates it with `test_custom_tool`
4. Once published, the tool becomes available to Agents under its own name (`custom_<slug>`)

Custom tools are global (shared across Agents), not stored per-Agent. This lets Agents build specialized automation without needing code changes to Hivekeep.
