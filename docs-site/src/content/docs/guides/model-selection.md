---
title: Model Selection & Troubleshooting
description: Choose the right model for your Agents and fix common issues like "text mode" and failed tool calls.
---

The model you assign to an Agent has a **massive** impact on how well it performs, especially for autonomous tasks. This guide helps you choose the right model and debug common problems.

:::note
Which models are available to assign is governed by the [Model Registry](/docs/providers/model-registry/). Disable the ones you don't want, and each model's context window, capabilities and label come from there (auto-filled from models.dev).
:::

## Recommended models

### For autonomous / agentic Agents

These Agents run crons, process webhooks, and work without human oversight. They **must** reliably call tools.

| Model | Provider | Verdict | Notes |
|---|---|---|---|
| **Claude Sonnet 4** | Anthropic | ✅ Best choice | Excellent tool use, follows complex instructions |
| **Claude Sonnet 3.5** | Anthropic | ✅ Excellent | Battle-tested, great cost/performance ratio |
| **Claude Haiku 3.5** | Anthropic | ✅ Good for simple tasks | Fast and cheap, but less reliable on complex multi-step workflows |
| **GPT-4o** | OpenAI | ⚠️ Usable with caveats | Sometimes falls into "text mode", needs stronger prompting |
| **GPT-4o-mini** | OpenAI | ⚠️ Limited | Struggles with complex tool sequences |
| **Gemini 2.5 Pro** | Google | ✅ Good | Strong tool use, very large context window |
| **Gemini 2.5 Flash** | Google | ⚠️ Usable | Fast but sometimes skips tool calls on complex tasks |
| **DeepSeek V3** | DeepSeek | ⚠️ Usable | Can work but less consistent on multi-step tool use |
| **Llama 3.x (70B+)** | Groq/Together/Ollama | ⚠️ Limited | Open models struggle with reliable tool calling |
| **Mistral Large** | Mistral | ⚠️ Usable | Decent tool use but less consistent than Claude |

### For conversational Agents

These Agents primarily chat with users and occasionally use tools. Most capable models work fine.

| Model | Provider | Verdict |
|---|---|---|
| **Claude Sonnet 4** | Anthropic | ✅ Excellent |
| **Claude Haiku 3.5** | Anthropic | ✅ Great for fast responses |
| **GPT-4o** | OpenAI | ✅ Excellent |
| **GPT-4o-mini** | OpenAI | ✅ Good and cheap |
| **Gemini 2.5 Pro** | Google | ✅ Excellent |
| **Gemini 2.5 Flash** | Google | ✅ Fast and capable |
| **Llama 3.x (70B+)** | Groq/Together/Ollama | ✅ Good for self-hosted |

:::tip
When in doubt, start with **Claude Sonnet 4** or **Claude Sonnet 3.5**. They have the most consistent tool-calling behavior across all Hivekeep features.
:::

## The "text mode" problem

The most common issue with autonomous Agents is the model falling into **text mode**, where it describes what it would do instead of actually calling tools.

### What it looks like

Instead of calling `web_search("latest AI news")`, the model outputs:

> I'll search the web for the latest AI news and compile a summary. Let me start by looking at major tech publications for recent developments in artificial intelligence...

No tool calls appear. The model writes a plausible-sounding response entirely from its training data, without accessing any real information.

### Why it happens

1. **Model capability**: Some models aren't trained for reliable function calling
2. **Prompt ambiguity**: If the prompt sounds like a conversation, the model converses instead of acting
3. **Missing instruction**: The model doesn't know it should USE tools rather than DESCRIBE tool usage
4. **Context confusion**: Very long contexts can cause the model to "forget" it has tools available

### How to fix it

#### 1. Use a recommended model

Claude Sonnet models are specifically trained for tool use. If you're experiencing text mode with another model, switch to Claude Sonnet first. This fixes the problem in most cases.

#### 2. Add explicit execution instructions

In your Agent's system prompt, include:

```
You ALWAYS use tools to accomplish tasks. You NEVER describe what you would do —
you DO it by calling the appropriate tools.

When you need information, call web_search or browse_url.
When you need to save something, call memorize or write_file.
When you need to process data, call the relevant tools step by step.

WRONG: "I'll search for the latest news about AI..."
RIGHT: [calls web_search("latest AI news", freshness="pd")]
```

#### 3. Use the EXEC pattern in task descriptions

For sub-Agent tasks (crons, webhooks), structure the task description as explicit commands:

```
## Steps — EXECUTE each one using tools

EXEC: web_search("artificial intelligence news", freshness="pd")
EXEC: browse_url on the top 3 results
EXEC: memorize the key findings
EXEC: update_task_status("completed", summary)

Do NOT describe these steps. CALL the tools.
```

This pattern tells the model unambiguously that it should execute tool calls, not write about them.

#### 4. Check tool call indicators

In the Hivekeep UI, each message shows whether tool calls were made. Look for the tool call indicators (collapsible sections showing the tool name and parameters). If a response has no tool calls, the Agent operated in text mode.

## Provider setup tips

### Anthropic (recommended)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. In Hivekeep, go to **Settings > Providers > Add Provider**
3. Select **Anthropic**, paste your API key
4. The connection test will verify models are accessible

Anthropic also supports **OAuth via Claude Max** (no API key needed if you have a Claude Max subscription).

:::note
Anthropic models are the most thoroughly tested with Hivekeep's tool system. The platform's core principles prompt and tool-call discipline instructions are optimized for Claude models.
:::

### OpenAI

1. Get an API key from [platform.openai.com](https://platform.openai.com/api-keys)
2. Add as a provider in Hivekeep
3. For autonomous Agents, use `gpt-4o` (not `gpt-4o-mini`)

:::caution
OpenAI models occasionally fall into "text mode" on complex multi-step tool chains. If this happens, add stronger execution instructions to your system prompt (see the EXEC pattern above).
:::

### Self-hosted & OpenAI-compatible (Ollama, vLLM, llama.cpp, LM Studio, NewAPI, LiteLLM)

Use the built-in **OpenAI-compatible** provider to point Hivekeep at any OpenAI-style endpoint:

1. Add an **OpenAI-compatible** provider in Hivekeep
2. Set the **Base URL** to your endpoint, including the version path. For Ollama: `http://localhost:11434/v1` (from Docker: `http://host.docker.internal:11434/v1`). After `ollama pull llama3.3:70b`, the model appears in the list.
3. Set the API key only if your server requires one (local servers usually don't)

The same connector also covers **embeddings** (`/embeddings`) and **image generation** when the endpoint implements the OpenAI Images API (`/images/generations` — LiteLLM, NewAPI, LocalAI). Stock Ollama / llama.cpp / vLLM typically do not; see [OpenAI-compatible image gaps](/docs/providers/supported/#openai-compatible-image-gaps).

:::caution
Local models are great for conversational use but often struggle with reliable tool calling. For autonomous Agents, prefer a cloud provider with a strong model.
:::

### OpenRouter (access to many models)

1. Get an API key from [openrouter.ai](https://openrouter.ai/keys)
2. Add as a provider in Hivekeep
3. You can access Claude, GPT-4o, Gemini, and many other models through a single provider

OpenRouter is convenient if you want to test different models without setting up multiple providers.

## Verifying tool use is working

After setting up an Agent, verify it's actually using tools:

### Quick test

Send your Agent a message that **requires** a tool call:

> What's the current weather in Paris? Use web search to find out.

A working Agent will call `web_search` and return real, current data. A text-mode Agent will make up a plausible weather report.

### Cron test

1. Create a simple cron job: "Search the web for 'Hivekeep' and summarize what you find"
2. Trigger it manually
3. Check the task result: does it contain actual search results or fabricated content?
4. Look at the task detail for tool call indicators

### What to check in the UI

- **Tool call sections**: Each message shows collapsible tool call blocks. No blocks = no tools were called
- **Task status**: Autonomous tasks should end with `completed` and a meaningful result
- **Cron journal**: Check `get_cron_journal` for execution history (failed runs often indicate tool issues)

## Cost considerations

:::tip
Track actual token spend per model, provider or Agent (with an estimated USD cost) in [Settings → Token Usage](/docs/features/token-usage/).
:::

Autonomous Agents consume more tokens than conversational ones because:

- **Cron jobs** run on schedule regardless of whether there's work to do
- **Webhook tasks** process each event individually
- **Sub-tasks** each require their own LLM call(s)
- **Tool results** are included in the context, adding to input token count

### Cost optimization tips

| Tip | Impact |
|---|---|
| Use **Haiku** for simple, single-step crons | 5 to 10x cheaper than Sonnet |
| Add **webhook payload filters** | Avoid processing irrelevant events |
| Set **concurrency limits** on webhook tasks | Prevent burst cost spikes |
| Use **concise task descriptions** | Fewer input tokens per run |
| Store results in **memory** instead of long outputs | Keeps future context smaller |

## Quick reference: model selection flowchart

1. **Is the Agent autonomous?** (crons, webhooks, sub-tasks)
   - Yes → **Claude Sonnet 4** or **Claude Sonnet 3.5**
   - No → continue

2. **Does the Agent use tools frequently?**
   - Yes → **Claude Sonnet 3.5** or **GPT-4o**
   - No → continue

3. **Is cost the primary concern?**
   - Yes → **Claude Haiku 3.5** or **GPT-4o-mini**
   - No → **Claude Sonnet 3.5** (best all-rounder)

4. **Must it be self-hosted?**
   - Yes → **Llama 3.3 70B+** via Ollama (conversational) or **Gemini 2.5 Flash** via API (agentic)
   - No → Use a cloud provider
