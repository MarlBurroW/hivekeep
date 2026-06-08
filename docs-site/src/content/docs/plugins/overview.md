---
title: Plugins Overview
description: Extend Hivekeep with custom tools, providers, channels, and hooks.
---

Hivekeep's plugin system lets you extend functionality without modifying core code. Drop a folder into `plugins/` and get new capabilities instantly.

## What Plugins Can Do

A single plugin can contribute one or more of these:

| Type | Description |
|------|-------------|
| **Tools** | New AI-callable functions for Agents (weather, SMS, RSS...) |
| **Providers** | Custom providers across all nine native families: LLM, embedding, image, search, TTS, STT, email, contacts, calendar |
| **Channels** | New messaging platforms |
| **Hooks** | Intercept lifecycle events (before/after chat, before/after tool calls) |
| **Cards** | Rich, live-updating UI emitted into the chat (progress, action buttons, structured data) |

Plugin providers implement the **same** native interfaces as Hivekeep's built-in providers: `LLMProvider`, `EmbeddingProvider`, `ImageProvider`, `SearchProvider`, `TTSProvider`, `STTProvider`, `EmailProvider`, `ContactsProvider`, `CalendarProvider`. There is no separate, simplified shape for plugins.

## Design Principles

1. **Low barrier to entry**: a plugin is a folder with a manifest and a TypeScript file
2. **TypeScript-first**: compiled by Bun at load time, no separate build step
3. **Safe by default**: plugins declare permissions; users approve before activation
4. **Agent-scoped**: enable plugins globally or per-Agent
5. **Compatible**: built-in tools remain unchanged; plugins use the same patterns

## Managing Plugins

Plugins are admin-only and managed exclusively from the UI: **Settings → Plugins** lets an admin browse the npm marketplace, install, enable/disable, configure, and uninstall plugins. The UI auto-generates settings forms from the plugin's `configSchema`.

Agents cannot install or manage plugins themselves: that capability was intentionally removed to keep the attack surface admin-gated.

## Plugin Lifecycle

```
Server Start
  → Scan plugins/ directory
  → Validate each plugin.json
  → Register discovered plugins (not yet activated)
  → Activate globally-enabled plugins
  → For each Agent, activate Agent-specific plugins
```

### Enable/Disable Levels

Plugins have two levels of enablement:

- **Global**: plugin is active at the platform level. Its providers, channels, and hooks are registered.
- **Per-Agent**: plugin's tools are available to specific Agents. Configured in each Agent's settings.

### Hot Reload

- **Config changes**: applied immediately (no restart). Plugin deactivates, re-initializes with new config, then activates.
- **Code changes**: require clicking **Reload Plugins** or restarting Hivekeep.
- **Manifest changes**: require reload.

## Installation Methods

| Method | How | Use Case |
|--------|-----|----------|
| **npm marketplace** | Settings → Plugins → Browse → search → Install | Published plugins (any package tagged with the `hivekeep-plugin` keyword) |
| **Git URL** | Settings → Plugins → Install from URL | Unpublished, private, or in-development plugins |
| **Manual** | Drop a folder into `plugins/` | Local development; managed entirely by hand |

See [Developing Plugins](/hivekeep/docs/plugins/developing/) for the full development guide.

## Next Steps

- [Developing Plugins](/hivekeep/docs/plugins/developing/): build your first plugin
- [Plugin API](/hivekeep/docs/plugins/api/): full API reference
