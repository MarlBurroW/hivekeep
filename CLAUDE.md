# Hivekeep

Self-hosted platform of specialized AI agents (Agents) for individuals and small groups. Each Agent has a persistent identity, expertise, memory, and tools. Agents share a single continuous session (no "new conversation"), collaborate with each other, spawn sub-Agents for tasks, and execute scheduled jobs.

## Documentation map

Read these files **before starting any phase**. They are the source of truth.

| File | Content |
|---|---|
| `idea.md` | Full functional specification (features, UX, architecture) toujours inclure dans le contexte pour etre aligné |
| `schema.md` | Complete SQLite database schema (all tables, indexes, virtual tables) |
| `api.md` | REST API contracts (request/response for every route) + SSE events |
| `sse.md` | **Real-time/SSE cheat sheet** — emit↔handle rules, the 8 recurring sync-bug traps, optimistic reconciliation, review checklist. Read before touching SSE or shared state. |
| `config.md` | All configurable values with env vars and defaults |
| `structure.md` | Project file tree, naming conventions, imports, i18n, error format |
| `prompt-system.md` | How the Agent system prompt is assembled (blocks 1-12) |
| `compacting.md` | Compacting algorithm + memory extraction pipeline |
| `queenie.md` | **Conversational onboarding** spec — the `Queenie` configurator Agent, vault-centralized secrets, secure-input tools, avatar-style customization (Phase 27) |

## Tech stack

**Backend**: Bun + Hono + SQLite (bun:sqlite) + Drizzle ORM + Better Auth + croner. AI provider primitives are native, organized by capability in `src/server/llm/{llm,embedding,image,search,stt,tts,core}/`; plugins consume `@hivekeep/sdk`. (Vercel AI SDK was removed pre-2.0.)
**Frontend**: React + Vite + Tailwind CSS + shadcn/ui + i18next
**Single process, single DB file, single Docker container. Zero external infrastructure.**

## Key conventions

### Naming

- Files: `kebab-case.ts` / Components: `PascalCase.tsx`
- Types/Interfaces: `PascalCase` / Functions: `camelCase` / Constants: `SCREAMING_SNAKE_CASE`
- DB tables: `snake_case` / API routes: `kebab-case` / Env vars: `SCREAMING_SNAKE_CASE`

### Imports

Use absolute paths with tsconfig aliases:
```typescript
import { buildSystemPrompt } from '@/server/services/prompt-builder'
import type { Agent } from '@/shared/types'
```
No index barrels in deep folders — use explicit imports.

### Shared types

Any type used by both client and server goes in `src/shared/types.ts`. Any constant shared between client and server goes in `src/shared/constants.ts`.

### API errors

All API routes return JSON. Errors follow this format:
```json
{ "error": { "code": "ERROR_CODE", "message": "Human-readable description" } }
```

### i18n

- Base language: English (`en.json`). Supported: `en`, `fr`
- Key convention: `namespace.element.action` (e.g. `sidebar.agents.title`)
- Use `useTranslation()` hook — never hardcode text in JSX
- Language detected from `user_profiles.language`, not the browser

### Database

- All PKs are UUIDs (text)
- All timestamps are Unix integers (milliseconds)
- Booleans stored as integer (0/1)
- Complex objects stored as text (JSON serialized)
- Better Auth tables (`user`, `session`, `account`, `verification`) are managed by Better Auth — never modify them directly

### Authentication

- Better Auth with HTTP-only cookie sessions
- Middleware on all `/api/*` routes except `/api/auth/*` and `/api/onboarding/*`
- First user created during onboarding gets `admin` role

### Design system

**Before building any frontend page or component**, read and follow the existing design system (it is already built — follow it, don't reinvent it):

| Reference | What it provides |
|---|---|
| `src/client/pages/design-system/DesignSystemPage.tsx` | Live showcase of every component, variant, animation, and pattern — **this is the source of truth for how UI should look and behave** |
| `src/client/styles/globals.css` | All design tokens (colors, radii, spacing), palette overrides, utility classes (`glass-strong`, `gradient-primary`, `gradient-border`, `btn-shine`, etc.), and keyframe animations |
| `src/client/components/ui/` | shadcn/ui components — always use these instead of creating custom ones. Many have custom `variant` props (e.g. `Progress`, `Slider`, `Button`) |
| `src/client/components/theme-provider.tsx` | Palette system (`usePalette()` → `palette` + `contrastMode` `'normal'`/`'soft'`, set via `setPalette`/`setContrastMode`) and theme mode (`useTheme()`) — **18 palettes**: aurora, ocean, forest, sunset, monochrome, sakura, neon, lavender, midnight, copper, jade, crimson, galaxy, amber, slate, rose, mint, citrus |

**Rules:**

1. **Reuse existing components** — never recreate what already exists in `components/ui/`. Check the showcase page first.
2. **Use design tokens** — never hardcode colors. Use CSS variables (`var(--color-*)`) or Tailwind classes (`text-primary`, `bg-muted`, `border-border`, etc.).
3. **Support all palettes** — UI must look correct across all 18 palettes (and both `normal`/`soft` contrast modes) in both light and dark modes. Use semantic token names, not palette-specific values.
4. **Use existing utility classes** — for glass effects (`glass-strong`, `glass-subtle`), gradients (`gradient-primary`, `gradient-border`, `gradient-border-spin`), surfaces (`surface-card`, `surface-section`), and animations (`btn-shine`, `btn-magnetic`, `pulse-glow`, `animate-levitate`, etc.).
5. **WCAG AA contrast** — all text must meet 4.5:1 contrast ratio. Use `muted-foreground` for secondary text, never raw opacity.
6. **Consistent spacing and radii** — follow the existing token scale. Don't invent custom values.

## Architecture principles

- **Queue per Agent**: each Agent has a FIFO queue. One message processed at a time. User messages have priority over automated ones.
- **SSE is global**: one SSE connection per client, multiplexed by `agentId`. No per-Agent SSE connections. **See `sse.md`** for emit↔handle rules, the recurring sync-bug traps, and the review checklist — read it before touching SSE or shared real-time state.
- **Compacting**: summarizes old messages to stay within token limits. Never deletes original messages. Triggers after each LLM turn if thresholds are exceeded.
- **Memory**: dual-channel (automatic extraction pipeline + explicit Agent tools). Hybrid search (sqlite-vec KNN + FTS5 rank fusion).
- **Vault secrets**: encrypted at rest (AES-256-GCM). Never exposed in prompts — only accessible via `get_secret()` tool. Redaction blocks compacting.
- **Sub-Agents (tasks)**: ephemeral instances for delegated work. `await` mode re-enters parent queue; `async` mode deposits result as informational. Max depth configurable.
- **Inter-Agent communication**: `request`/`reply` pattern with correlation IDs. Replies are always `inform` (no ping-pong). Rate-limited.
- **Crons**: in-process scheduler (croner). Spawn sub-Agents on schedule. Results are informational (no LLM turn on parent). Agent-created crons require user approval.
- **Event bus + hooks**: foundation for observability and future plugin system.
- **Providers are pluggable**: one config per provider, multiple capabilities auto-detected (`llm`, `embedding`, `image`, `search`, `stt`, `tts`).
- **Search**: `web_search` action tool + `list_search_providers` discovery tool. Provider resolved via `resolveSearchProvider(slug?)` (explicit slug → global default in `app_settings.default_search_provider_id` → first valid). Built-ins: Brave, SerpAPI, Tavily, Perplexity Sonar. `SearchProvider.capabilities` (static) drives capability-mismatch warnings emitted by the host before calling the upstream API. `SearchRequest.extra` is a free-form passthrough for provider-specific quirks. Follow-up reads go through the existing `browse_url` tool (no separate `web_fetch`).
- **Tool concurrency**: within a single LLM step, tool calls are partitioned into batches by `tool-executor.ts`. Consecutive tools flagged `concurrencySafe: true` on their `ToolRegistration` fuse into one parallel batch (bounded by `HIVEKEEP_MAX_TOOL_USE_CONCURRENCY`, default 10); every other tool runs alone in its own serial batch. Three optional flags: `readOnly`, `concurrencySafe`, `destructive`. Default is `false` everywhere (conservative: assume write, assume not safe to parallelize). When adding a native tool, only set these flags when the answer is unambiguous — anything stateful, side-effecting, or with ordering dependencies should stay at the default.

### Adding a native LLM provider

Verified end-to-end (the DeepSeek provider followed exactly these steps). `PROVIDER_META` is the single source of truth — never hand-edit the derived `PROVIDER_TYPES` / `PROVIDER_CAPABILITIES` / `PROVIDER_DISPLAY_NAMES` / `PROVIDER_API_KEY_URLS` in `constants.ts`.

1. **`src/shared/provider-metadata.ts`** — add one `PROVIDER_META` entry: `capabilities` (e.g. `['llm']`), `displayName`, optional `lobehubIcon`, `apiKeyUrl` (and `noApiKey` / `optionalApiKey` if relevant). Everything else derives from this.
2. **`src/server/llm/llm/<type>.ts`** — implement the `LLMProvider` interface (`src/server/llm/llm/types.ts`): streaming chat + `listModels` + `testConnection` + model classification. For OpenAI-compatible APIs, clone `xai.ts` / `openrouter.ts`. Rules: **fetch the model list from the provider API — never hardcode model ids**; classify capability / context window / vision from API metadata first, name heuristics only as a fallback; **only advertise `thinking.efforts` if the model actually accepts `reasoning_effort`** — otherwise leave `thinking` undefined and gate the request param on `model.thinking?.efforts?.length` (sending an effort to a model that rejects it is a 400 — this bit gpt-5-chat-latest and grok `non-reasoning`).
3. **`src/server/llm/llm/register.ts`** — import + `registerLLMProvider(<type>Provider)`.
4. **`src/shared/constants.ts`** — add a `CONFIGURATOR_MODEL_PREFERENCES['<type>']` entry (ordered substrings, flagship first) so Queenie seeds on a strong, tool-reliable model when this provider is connected first. `resolveConfiguratorModel` drops lite tiers and prefers the canonical id.
5. **`src/server/llm/llm/<type>.test.ts`** — mirror `xai.test.ts`: classification + `listModels` parsing.
6. **Website** — add a chip in `site/src/components/Providers.astro` (import the matching `@lobehub/icons` mark).
7. **Verify** — `bun run typecheck` + `bun run test`, then onboarding end-to-end: connect the provider, confirm models come from the API and are classified, and that Queenie completes onboarding making real tool calls.

(`src/server/providers/ADDING_PROVIDERS.md` documents the older capability-dispatch `ProviderDefinition` layer — for LLM providers follow the steps above.)

## Git conventions

- **Never** include `Co-Authored-By` lines in commit messages
- Commit messages follow conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## Development workflow

1. Work in small, verified increments; one commit per completed change with a clear message
2. **All frontend work MUST follow the existing design system** (see the Design system section) — it is already built; never ship UI that ignores it
3. Run `bun run dev` frequently, and `bun run typecheck` + `bun run test` before committing (the pre-commit hook runs both)

## Commands

```bash
bun run dev         # Start dev servers (Vite + Hono)
bun run build       # Production build (Vite → dist/client/)
bun run start       # Production server (Hono serves API + static)
bun run typecheck   # tsc --noEmit (also run by the pre-commit hook)
bun run test        # Unit tests (bun test); test:e2e for Playwright
bun run db:generate # Generate a Drizzle migration from schema changes
bun run db:migrate  # Apply pending migrations
bun run db:snapshot # Snapshot the DB (db:snapshot:list / db:snapshot:restore)
```

## Project structure (overview)

```
src/
  server/           # Backend (Bun + Hono)
    routes/         # REST API routes
    services/       # Business logic
    llm/            # AI provider primitives by capability: llm/ embedding/ image/ search/ stt/ tts/ core/
    providers/      # Provider registry glue (image cache/dispatch, index)
    tools/          # Native tools exposed to Agents
    db/             # SQLite connection + Drizzle schema + migrations
    auth/           # Better Auth config + middleware
    hooks/          # Lifecycle hooks
    sse/            # SSE manager
    config.ts       # Centralized configuration
  client/           # Frontend (React + Vite)
    pages/          # Page components
    components/     # Reusable components (ui/, sidebar/, chat/, agent/, common/)
    hooks/          # Custom React hooks
    lib/            # Utilities (api client, i18n, utils)
    locales/        # i18n translation files
    styles/         # CSS (Tailwind + design tokens)
  shared/           # Code shared between client and server
    types.ts
    constants.ts
data/               # Persistent data (SQLite DB, uploads, workspaces)
```

See `structure.md` for the complete file tree.
