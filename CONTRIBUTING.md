# Contributing to Hivekeep

Thanks for considering contributing to Hivekeep! Whether it's a bug fix, new provider, feature, or docs improvement, every contribution helps.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0
- [Git](https://git-scm.com/)
- At least one AI provider API key (Anthropic, OpenAI, Gemini, etc.)

### Local Development Setup

```bash
git clone https://github.com/MarlBurroW/hivekeep.git
cd hivekeep
bun install
bun run db:migrate
bun run dev
```

This starts both the Vite dev server (frontend) and the Bun server (backend) with hot reload. Open [http://localhost:5173](http://localhost:5173) in your browser.

### Project Structure

```
src/
├── client/          # React frontend (Vite + Tailwind)
├── server/          # Bun + Hono backend
│   ├── providers/   # AI provider adapters
│   ├── channels/    # Chat platform adapters (Telegram, Discord, etc.)
│   └── ...
├── shared/          # Shared types & utilities
site/                # Landing page (React + Vite + Tailwind v4)
```

### Useful Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server (client + server) |
| `bun run build` | Production build |
| `bun run db:generate` | Generate DB migrations (Drizzle) |
| `bun run db:migrate` | Run pending migrations |
| `bun test` | Run tests |

## How to Contribute

### Reporting Bugs

Use the [bug report template](https://github.com/MarlBurroW/hivekeep/issues/new?template=bug_report.yml). Include:
- Steps to reproduce
- Expected vs actual behavior
- Browser, OS, and Hivekeep version

### Requesting Features

Use the [feature request template](https://github.com/MarlBurroW/hivekeep/issues/new?template=feature_request.yml). Describe the problem you're solving, not just the solution you want.

### Submitting Code

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b feat/my-feature`
3. **Make your changes** with clear, focused commits
4. **Test** your changes: `bun test` and manual testing
5. **Push** and open a Pull Request

### Adding a Provider

Providers are self-contained adapters in `src/server/providers/`. To add one:

1. Create `src/server/providers/<name>.ts` (use an existing one as template)
2. Implement the `ProviderDefinition` interface: `testConnection()` + `listModels()`
3. Register it in `src/server/providers/index.ts`
4. Add the type to the `ProviderType` union in `src/shared/types.ts`
5. Commit: `feat: add <name> provider`

For OpenAI-compatible providers, reuse the pattern from `openai.ts` with a custom `baseUrl`.

### Adding a Channel

Channel adapters live in `src/server/channels/` and implement the `ChannelAdapter` interface:

1. Create the adapter file in `src/server/channels/`
2. Implement: `start()`, `stop()`, `sendMessage()`, `validateConfig()`, `getBotInfo()`
3. Register it in `src/server/channels/index.ts`
4. Add the platform to `ChannelPlatform` in `src/shared/types.ts`
5. Commit: `feat: add <platform> channel`

## Writing a Plugin

Plugins live in the `plugins/` directory and ship with Hivekeep. The three reference implementations are:

- `plugins/teamspeak/` — channel adapter + tools (WebSocket-based external service)
- `plugins/twilio-sms/` — channel adapter (HTTP-based + signed webhook)
- `plugins/home-automation/` — tools (Home Assistant integration)

### Scaffold a new plugin

```bash
bunx create-hivekeep-plugin
```

This generates a `plugin.json` manifest, an `index.ts` entry point, and a `README.md`.

### Plugin SDK

Plugin authors should import everything they need from `@hivekeep/sdk`:

```ts
import { tool, z } from '@hivekeep/sdk'
import type { ChannelAdapter, PluginContext, PluginExports } from '@hivekeep/sdk'
```

The SDK exposes `tool()`, `asSchema()`, `z` (re-export of zod), and the full type surface needed for tools, channels, providers, and hooks. Plugins should NOT import from `@/server/*` — that path is reserved for Hivekeep internals.

### Tips

- Use `plugins/teamspeak/` as a reference for a tool + channel plugin
- Keep plugins focused: one clear purpose per plugin
- Write a helpful README so users know how to configure and use it
- Use `ctx.log` for logging, `ctx.storage` for persistence, `ctx.config` for user-supplied settings
- See the [Plugin Development Guide](https://marlburrow.github.io/hivekeep/docs/plugins/developing/) for the full API reference

## Code Style

- **TypeScript** strict mode
- **Imports** use the `@/` alias (configured in tsconfig)
- **Logging** via `createLogger('scope:name')`
- Prefer `fetch` over heavy SDK dependencies
- Keep files focused: one provider/channel per file

## Commit Messages

Follow conventional commits:

- `feat: add <thing>` for new features
- `fix: resolve <issue>` for bug fixes
- `docs: update <what>` for documentation
- `site: <description>` for landing page changes
- `refactor:`, `test:`, `ci:`, `chore:` as needed

## Landing Page

The landing page lives in `site/` and deploys automatically to GitHub Pages on push to `main`.

```bash
cd site
bun install
bun run dev      # Local dev server
bun run build    # Test production build
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

## Questions?

Open a [discussion](https://github.com/MarlBurroW/hivekeep/discussions) or an issue. We're happy to help!
