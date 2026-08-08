---
title: What are Agents?
description: Understanding Hivekeep's persistent AI agents.
---

Agents are Hivekeep's core concept: **persistent AI agents** that live on your server, remember everything, and work as a team.

Unlike disposable chatbot sessions, an Agent has:

- **A permanent identity**: name, role, personality, expertise, avatar
- **Continuous memory**: every conversation is remembered forever through vector + full-text search
- **A continuous session**: there's no "new conversation"; the session never resets
- **Collaboration skills**: Agents talk to each other, delegate tasks, and spawn sub-agents
- **Autonomy**: cron jobs, webhooks, and channel integrations let them work while you sleep

## Anatomy of an Agent

When you create an Agent, you define:

| Field | Purpose |
|---|---|
| **Name** | Display name (e.g. "Atlas") |
| **Slug** | Unique identifier for inter-Agent communication (e.g. `atlas`) |
| **Role** | One-line description of what it does (e.g. "Infrastructure specialist") |
| **Character** | Personality traits and communication style |
| **Expertise** | Domain knowledge and capabilities |
| **Model** | Which LLM to use (from your configured providers) |
| **Provider** | Which AI provider to use (optional, defaults to instance default) |
| **Avatar** | Visual identity in the UI |

## How they work

1. **Messages queue**: each Agent has its own priority queue. User messages are processed before automated ones (cron, webhooks, inter-Agent). Within the same priority, messages are processed in order.
2. **System prompt**: Hivekeep builds a rich system prompt from the Agent's identity, its memory profile, contacts directory, Agent directory, active channels, and platform directives.
3. **Memory**: the curated profile is always present in the prompt; the episodic archive is searched on demand by the Agent with `recall`.
4. **Session compacting**: when the conversation gets too long for the model's context window, older messages are summarized into a snapshot. Original messages are always preserved in the database, so no data is lost.
5. **Tool execution**: Agents have access to 100+ built-in tools plus MCP servers and custom tools.

## Shared Agents

All users on the instance interact with the same Agents. Each message is tagged with the sender's identity, so the Agent knows who it's talking to.

## The Hub

You can designate one Agent as the **Hub**: a central coordinator that receives all incoming requests and routes them to the most appropriate specialist Agent. The Hub gets an enriched directory view with expertise summaries and active channel information.

## What's next?

- [System Prompts](/docs/agents/system-prompts/): craft the perfect personality
- [Tools](/docs/agents/tools/): give your Agents capabilities
- [Memory](/docs/agents/memory/): how Agents remember
