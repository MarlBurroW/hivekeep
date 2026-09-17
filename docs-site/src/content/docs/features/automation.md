---
title: "Automation: crons and webhooks"
description: Schedule Agents on a cron and trigger them from external services with webhooks.
---

Automation lets your Agents do work without you driving every step. Two mechanisms cover most cases: **crons** run an Agent on a schedule, and **webhooks** let an external service trigger an Agent over HTTP. Both spawn a sub-Agent task to do the work, so they slot into the same task machinery Agents already use.

## Crons

A cron is a scheduled job that spawns a sub-Agent on a schedule and asks it to do something. Scheduling runs **in-process** using the [croner](https://github.com/Hexagon/croner) library; there is no external scheduler, no extra container. When the server restarts, active crons are restored on boot.

### What happens when a cron fires

When a cron triggers, Hivekeep spawns a task with the cron's description, on the cron's owner Agent (or a different target Agent if configured). By default the result is **informational**: the report is recorded but the parent Agent does **not** get an LLM turn. This keeps frequent crons cheap. The sub-Agent does the work and its report is filed; the parent only "wakes up" if you opt in.

If you set **trigger parent turn**, the final report instead wakes the parent Agent for a turn, so it re-reads its own report and can act on it (self-calibration, conditional follow-up actions). This is more capable but costs tokens on every run, so use it deliberately.

A cron can be **recurring** (a cron expression like `0 9 * * *`) or **run once** (an ISO 8601 datetime; it fires once and then deactivates itself).

Schedules are interpreted in a server-wide timezone, resolved in order from `HIVEKEEP_TIMEZONE`, then `TZ`, then the system timezone, then UTC. Set `HIVEKEEP_TIMEZONE` (for example `Europe/Paris`) so `0 9 * * *` means 9am where you are. See [Configuration](/docs/getting-started/configuration/).

### Agent-created crons require approval

You can create crons yourself in the UI; those are active immediately. But when an **Agent** creates a cron with `create_cron`, it is created **inactive and pending approval**. It will not run until you approve it. You get a notification, and you approve (or delete) it in the UI. This is the safety boundary: an Agent cannot silently schedule itself to act on a recurring basis.

A pending cron also cannot be triggered manually until it is approved.

### Managing crons with tools

Agents have a set of cron tools (all in the main conversation only):

- `create_cron`: create a scheduled task. Returns immediately with `requiresApproval: true` when created by an Agent.
- `update_cron`: change any field (schedule, description, active state, target Agent, model/provider override, thinking effort, toolboxes, run-once, trigger-parent-turn).
- `list_crons`: list this Agent's crons with their configuration.
- `get_cron_journal`: review the execution history of a cron (recent run statuses, results, durations).
- `trigger_cron`: run a cron immediately without affecting its regular schedule.
- `delete_cron`: remove a cron permanently.

Each cron can override the model, provider, reasoning effort, and the **toolboxes** the spawned task may use, so a lightweight scheduled job can run on a cheaper model with a narrow tool surface. See [Toolboxes](/docs/features/toolboxes/) and [Choosing a Model](/docs/guides/model-selection/).

### Managing crons in the UI

The Crons view lists every cron with its schedule, owner and target Agent, last run, and active state. From there you create crons, approve Agent-created ones, trigger a run on demand, edit, and delete. Crons are also reachable over the REST API (`/api/crons`), including an approve endpoint.

### Configuration

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| Max active crons | `CRONS_MAX_ACTIVE` | 50 | Cap on simultaneously active crons. |
| Max concurrent executions | `CRONS_MAX_CONCURRENT_EXEC` | 5 | Per-cron concurrency; extra runs queue instead of being dropped. |
| Server timezone | `HIVEKEEP_TIMEZONE` (or `TZ`) | system / UTC | Timezone used to interpret schedules. |

## Webhooks

A webhook is an inbound HTTP endpoint that lets an external service trigger one of your Agents. Each webhook belongs to an Agent and has a unique URL and a secret token shown only once at creation. Point a service (GitHub, a monitoring tool, a form backend, anything that can POST) at the URL, and each call drives the Agent.

### The incoming endpoint

External services POST to `/api/webhooks/incoming/:webhookId`. The request must carry the token, either as `Authorization: Bearer <token>` or a `?token=` query parameter. The endpoint:

1. Rate-limits per webhook (a sliding one-minute window).
2. Looks up the webhook and verifies the token with a constant-time comparison.
3. Rejects calls if the webhook is inactive.
4. Enforces a maximum payload size.
5. Applies the optional payload filter, then dispatches.

Only POST is accepted. The body is treated as the payload (typically JSON).

### Filtering payloads

A webhook can ignore calls that do not match a filter, so a busy source (say, every GitHub event) only wakes the Agent on the ones that matter:

- **Simple**: extract a field by dot-path from the JSON payload (for example `action`, or `event.type`) and accept it only if the value is in an allow-list (case-insensitive).
- **Advanced**: test a regular expression against the raw payload body.
- **None**: accept every call.

Filtered-out calls return success but do nothing.

### Dispatch modes

When a call passes the filter, the webhook dispatches in one of two modes:

- **conversation** (default): the payload is injected as a message into the Agent's main session, as if you had sent it.
- **task**: the payload spawns a sub-Agent task built from templates. `task_title_template` and `task_prompt_template` support `{{field.path}}` placeholders resolved against the JSON payload, and `{{__payload__}}` for the full raw body. A `max_concurrent_tasks` limit (default 1, 0 for unlimited) keeps a flood of calls from spawning unbounded tasks; extra calls queue.

For example, a GitHub webhook filtered to `action: ["opened"]` in task mode could spawn a task titled `GitHub: opened on #{{issue.number}}` whose prompt asks the Agent to triage the new issue. See the [GitHub Issue Processor blueprint](/docs/guides/blueprints/github-issue-processor/) for an end-to-end walk-through.

### Managing webhooks with tools

- `create_webhook`: create an endpoint; returns the URL and the one-time token, plus filter and dispatch settings.
- `update_webhook`: change name, description, active state, filter, or dispatch settings.
- `list_webhooks`: list this Agent's webhooks (tokens are never returned).
- `delete_webhook`: remove a webhook (external callers then get 404).

You can also manage webhooks in the UI, where the URL and token are surfaced at creation.

### Configuration

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| Max per Agent | `WEBHOOKS_MAX_PER_KIN` | 20 | Cap on webhooks per Agent. |
| Max payload size | `WEBHOOKS_MAX_PAYLOAD_BYTES` | 1048576 (1 MB) | Larger payloads are rejected. |
| Rate limit | `WEBHOOKS_RATE_LIMIT_PER_MINUTE` | 60 | Calls per minute per webhook. |
| Log retention | `WEBHOOKS_LOG_RETENTION_DAYS` | 30 | How long trigger logs are kept. |

> Webhook URLs are only reachable if your Hivekeep instance is reachable by the calling service. For external services, that means a public origin (set `PUBLIC_URL`) and, usually, a reverse proxy with TLS. See [Configuration](/docs/getting-started/configuration/).

## Keeping a human in the loop

Automation does not mean losing control:

- **Agent-created crons need your approval** before they ever run.
- **Webhooks require a secret token**, are rate-limited and size-capped, and can be filtered to only the events you care about, deactivated, or deleted at any time.
- **Cron tasks cannot prompt you.** The `prompt_human` tool (which suspends a task to ask a question) is disabled in cron-triggered tasks, because there is no interactive session waiting on the other side. Use webhook conversation mode or a normal task if you want a back-and-forth.
- **By default cron results are informational**, so a scheduled Agent reports rather than barging into your conversation; opt into a parent turn only when you want the Agent to react.

## Related

- [Autonomy Quickstart](/docs/guides/autonomy-quickstart/) for a hands-on path to your first scheduled Agent.
- [Blueprints](/docs/guides/blueprints/github-issue-processor/) for ready-made automation recipes.
- [Toolboxes](/docs/features/toolboxes/) and [Choosing a Model](/docs/guides/model-selection/) to scope and cost scheduled work.
- [Configuration](/docs/getting-started/configuration/) for timezone, public origin, and the env vars above.
