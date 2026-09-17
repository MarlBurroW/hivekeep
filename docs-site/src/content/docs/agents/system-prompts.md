---
title: System Prompts
description: How Hivekeep builds system prompts and how to craft effective Agent personalities.
---

Every Agent's behavior is shaped by its **system prompt**, which Hivekeep assembles automatically from several sources. Understanding this helps you write better Agent configurations.

## Prompt architecture

Hivekeep builds the system prompt from these blocks (in order):

1. **Platform context**: explains that the Agent lives on Hivekeep, has a continuous session, and sees multiple users
2. **Identity**: name, slug, and role
3. **Core principles**: universal baseline behaviors (genuine helpfulness, resourcefulness, privacy, calibrated responses, tool-call discipline). Includes instructions to never narrate or predict tool results before execution, and to never batch dependent tool calls, each of which must be called one at a time across separate steps. Injected for all main Agents, not sub-Agents or quick sessions
4. **Personality**: the `character` field you define
5. **Expertise**: the `expertise` field you define
6. **Platform directives**: optional global prompt that applies to all Agents (set in Settings)
7. **Contacts directory**: shared contacts across the platform
8. **Agent directory**: other Agents available for collaboration, with delegation instructions (Hub Agents get an enriched view with expertise summaries)
9. **Your memory**: the Agent's curated memory profile, always present. The episodic archive is not injected; the Agent searches it with `recall` when it needs it
10. **Internal instructions**: tool usage guidelines, memory management, contact resolution, secrets handling, response calibration, mini-app creation. Includes a **file & code tool selection table** that steers Agents toward structured tools (`grep`, `multi_edit`, `edit_file`) over `run_shell` for file operations. Mini-app instructions direct Agents to call `get_mini_app_docs` for the full SDK reference rather than embedding it inline. MCP tool sections show server-level summaries only (individual tool descriptions are provided via the LLM's `tools` parameter). Channel instructions include guidance on using `attach_file()` to send files back to external platforms
11. **Workspace**: when an Agent has a workspace directory configured, shows the absolute path and a file tree of its contents. Instructs the Agent to use the workspace for all file operations (repos, scripts, data) and avoid writing to the home folder or other system paths. Empty workspaces get a hint to start organizing
12. **Current speaker profile**: name, role, and contact notes (both global/shared and per-Agent private notes) for the user who sent the current message. If the user has a linked contact but no notes yet, includes a gentle nudge to discover them naturally. Also resolves channel senders (Telegram, Discord, WhatsApp) to their contact records via platform ID
13. **Channel origin context**: when the current turn is part of a causal chain originating from an external channel (e.g. inter-Agent reply or task result), informs the Agent that delivery is automatic and advises adapting formatting for the target platform
14. **Language**: response language from the user's **Agent language** setting in account settings (falls back to the interface language when unset). Agents can speak nearly any language, independent of the UI translation.
15. **Date and context**: current timestamp

## Writing effective characters

The `character` field defines personality and communication style. Be specific:

```
You are warm but direct. You use analogies to explain complex concepts.
You prefer short, actionable answers over lengthy explanations.
When you're not sure, you say so clearly.
You occasionally use dry humor but never at the user's expense.
```

Avoid vague descriptions like "You are helpful and friendly", every AI is that by default.

## Writing effective expertise

The `expertise` field tells the Agent what it knows and what it should focus on:

```
You are an expert in Kubernetes, Docker, and cloud infrastructure.
You know Linux administration, networking (TCP/IP, DNS, TLS), and CI/CD pipelines.
You are familiar with Terraform, Ansible, and Helm charts.
When asked about topics outside your domain, delegate to the appropriate Agent.
```

## Global prompt (platform directives)

Admins can set a **global prompt** in Settings that applies to every Agent. Use this for:

- House rules ("Always respond in French unless the user writes in English")
- Safety guidelines
- Output formatting preferences
- Information about the organization or team

## Sub-Agent prompts

When an Agent spawns a sub-agent (via `spawn_self` or `spawn_agent`), the sub-Agent gets a different prompt structure:

- Mission-focused: the task description is front and center
- Constrained: must call `update_task_status()` to complete
- Tool-call discipline: same rules as main Agents (never narrate or predict tool results, and never batch dependent tool calls)
- Can request input from the parent via `request_input()`
- Can communicate with other Agents via `send_message` and `list_kins` (Agent directory included in prompt)
- For cron tasks: previous run results are injected for continuity

## Tips

- **Be opinionated.** Agents with strong personalities are more useful than generic ones.
- **Define boundaries.** Tell the Agent what it should NOT do or what to delegate.
- **Use the expertise field for knowledge**, the character field for tone. Don't mix them.
- **Test with real conversations.** The best prompt is one refined through actual use.
