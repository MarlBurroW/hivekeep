---
title: "Queenie, guided setup"
description: "Queenie is Hivekeep's built-in onboarding and configuration Agent. She sets the platform up through conversation and rescues broken setups."
---

Queenie is the Agent who sets Hivekeep up for you. Instead of a wizard with a dozen forms, you talk to her in chat: she connects AI providers, captures your secret keys safely, sets the default models, helps you create your first real Agent, and explains how everything fits together as she goes. She also stays around afterwards as your permanent configuration assistant and your first responder when something stops working.

Under the hood she is a normal Agent with a special marker. Her row in the `agents` table has `kind = 'configurator'` (every other Agent is `'regular'`), and that single flag drives everything: she gets a dedicated toolbox, a configuration-specific block in her system prompt, and she is excluded from the "real Agent" counts used during onboarding.

## When Queenie appears

Queenie is seeded **once**, for the **first admin only**, during initial setup. The very first user you create always becomes the admin, and the onboarding flow keeps a small unavoidable form before the chat can begin, because an Agent cannot speak without a working language model.

The bootstrap sequence is:

1. **Account and language.** You create the admin account and pick your language. Your own contact record (your "fiche") is created and linked to your account at this step, so Queenie already knows who she is talking to.
2. **One native LLM provider.** You connect a single built-in language-model provider (for example Anthropic, OpenAI, or Gemini) and its API key. This is the one manual key entry; everything else happens in conversation.
3. **Queenie is seeded.** The server picks a reliable model from that provider's live catalogue, creates the configurator Agent named Queenie, assigns her the `configurator` toolbox, copies her bundled avatar, and (if you have not set one yet) makes the bootstrap provider your default LLM. A hidden trigger message makes Queenie greet you first, so the chat opens with her introducing herself rather than a blank box.

Seeding is **idempotent**: only one configurator Agent ever exists. If onboarding is re-run, Queenie is reused, never duplicated, and she is not greeted a second time.

:::note
Onboarding is considered complete the moment the admin account exists. Everything else (embeddings, search, images, voice, channels, your first Agent) is optional and degrades gracefully if skipped. Queenie never tells you the platform is "incomplete" or "locked"; missing capabilities are framed as optional upgrades.
:::

Non-admin users get **no onboarding**. They land in the platform's current state and see Queenie and her conversation in the shared Agent list, but they do not trigger a second setup.

## What Queenie does during setup

Queenie's job is to set Hivekeep up through conversation, one thing at a time, explaining the reason for each step. She works from a checklist of categories she is meant to offer, adapting to what you already have configured rather than following a rigid script:

- **Get to know you**: enrich your contact record so your Agents remember who you are.
- **An embedding model**: so long-term memory can do semantic recall and de-duplication. Without it, memory still saves but falls back to keyword-only search.
- **A web search provider**: so Agents can look things up live.
- **An image provider and an avatar style**: so your Agents get generated avatars with a consistent visual identity.
- **Voice (text-to-speech and speech-to-text)**: optional.
- **A global prompt**: house rules every Agent should follow.
- **Channels**: connect Discord, Telegram, and the rest so you can talk to your Agents from your phone.
- **Your first real Agent**: and a clear explanation of which toolboxes it received and why.
- **A tour of the rest**: custom tools, mini-apps, crons, sub-Agents.

She reuses keys across capabilities where she can. If you connect an OpenAI provider for chat, she can enable embeddings, images, and voice on the **same** key instead of asking again.

### Secrets never reach the model

Queenie never asks you to paste an API key or token into the chat. When she needs a credential she calls a **secure-input** tool, which suspends her turn and opens a small popup in the UI. You type the secret there; it goes straight to the encrypted vault (AES-256-GCM at rest); and Queenie's turn resumes with only a **non-sensitive confirmation** (for example "provider valid: true" or a failure reason). The raw value never enters the language model's context, and it is never written to logs.

Three secure-input tools cover this:

- `request_provider_setup`: connect and test an AI provider. The popup collects the secret fields, the server vaults them, then **creates and tests** the provider in one step.
- `request_channel_setup`: connect a channel (Discord, Telegram, ...) the same way: vault the token, create and activate, then test.
- `prompt_secret`: store any free-form secret under a key, without creating a provider or channel.

These tools end Queenie's turn and resume only after you submit. She trusts the returned valid/failed result instead of re-asking or polling. She can store secrets but cannot read them back; for viewing or editing a stored secret you go to **Settings → Vault**.

### Avatars and customization

Once an image provider is connected, Queenie can help you settle on a look for your Agents empirically. She can set the global art **style** and the global **subject** (robot, human, dragon, ...), generate an example avatar, and iterate until you are happy, then offer to regenerate existing Agents' avatars (including her own) so they match. Generating examples costs image credits, so she offers rather than imposes. She can generate or reset the neutral base image but cannot upload one; uploading a base image is done in **Settings → Avatars**.

## Doctor: diagnosing a broken setup

Queenie is also the platform's first responder. When you tell her something is broken ("I added my key but nothing happens", "it doesn't remember me", "my bot is silent", "my invite link is wrong"), she calls a single read-only diagnostic tool first: **`get_setup_health`**.

`get_setup_health` returns one structured snapshot of the platform's functional health plus a prioritized list of issues, where each issue already names the exact fix tool to call. It is strictly read-only: it diagnoses, it never mutates. What it checks and how Queenie rescues each:

| What it detects | How it is detected | The fix it points at |
|---|---|---|
| **Invalid / failing provider** (the most common case, usually a bad or expired API key) | Each provider's stored `isValid` flag is false; the recorded `lastError` is surfaced verbatim | Re-enter the key with `request_provider_setup`, then `test_provider` to re-validate |
| **Missing capability** (no valid LLM, embedding, image, search, TTS, or STT provider) | No valid provider declares that capability; a missing LLM is `critical`, missing embedding is a `warning`, the rest are `info` | Connect or enable a provider for that capability (often reusing an existing key via `enable_provider_capability`), then set a default |
| **Stale default model** | The configured default model is no longer present in its provider's live catalogue (deprecated or renamed) | `set_default_model` with a current model from `list_models` |
| **Missing / unset default** | A capability has a valid provider but no default is set, or a default points at a provider that no longer exists | `set_default_model` (model services) or `set_default_provider` (search / TTS / STT) |
| **Inactive channel** | A channel's status is `inactive` or `error`, with its last status message | `test_channel` to re-activate; if it still fails, re-run `request_channel_setup` |
| **Public-URL mismatch** | `PUBLIC_URL` is still a localhost default on a non-manual (Docker / systemd) install, so invitation links, channel webhooks, OAuth callbacks, and the CORS allowlist would point at the wrong host | `update_platform_config` to set `PUBLIC_URL` to the address users actually reach, then restart (on Docker, set it via the container env) |

Issues come back sorted by severity (`critical`, then `warning`, then `info`), with a summary line and per-capability coverage. Queenie works the criticals first, applies the named fix, re-tests, and re-runs `get_setup_health` to confirm the issue cleared before telling you it is resolved.

`get_setup_health` is read-only and not admin-gated (reading health is harmless), but the **fix** tools it references are admin-guarded and only reachable through Queenie's toolbox.

## How to re-engage Queenie

The onboarding chat opens automatically in a focused modal while Queenie is the only Agent and you have not dismissed it. Closing the modal asks you to confirm, then sets a "dismissed" flag so it does not auto-open again. Nothing is lost: the modal is just a focused view onto Queenie's permanent conversation.

To talk to her again at any time, select **Queenie** in your Agent list and continue the same thread. Her history is intact, and because she is your permanent configuration assistant she can pick up where you left off, add a capability you skipped, or run a diagnosis on demand.

## What Queenie cannot do

Queenie is honest about her limits. She does not have every tool; she has exactly the `configurator` toolbox. In particular she cannot delete an Agent, read or list vault secrets, connect an email / calendar / contacts account (OAuth login is browser-only by design), upload an avatar base image, or build custom tools, mini-apps, MCP servers, or plugins. For those she points you to a regular Agent or the relevant Settings page.

## Related pages

- [Toolboxes](/docs/features/toolboxes/): the `configurator` toolbox is what scopes everything Queenie can do.
- [Vault and Secrets](/docs/features/vault/): where the keys Queenie captures are stored.
- [Supported Providers](/docs/providers/supported/): the provider types Queenie can connect.
- [Your First Agent](/docs/getting-started/first-agent/): what Queenie helps you build.
