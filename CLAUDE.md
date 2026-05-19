# KinBot

Self-hosted platform of specialized AI agents (Kins) for individuals and small groups. Each Kin has a persistent identity, expertise, memory, and tools. Kins share a single continuous session (no "new conversation"), collaborate with each other, spawn sub-Kins for tasks, and execute scheduled jobs.

## Documentation map

Read these files **before starting any phase**. They are the source of truth.

| File | Content |
|---|---|
| `idea.md` | Full functional specification (features, UX, architecture) toujours inclure dans le contexte pour etre aligné |
| `schema.md` | Complete SQLite database schema (all tables, indexes, virtual tables) |
| `api.md` | REST API contracts (request/response for every route) + SSE events |
| `config.md` | All configurable values with env vars and defaults |
| `structure.md` | Project file tree, naming conventions, imports, i18n, error format |
| `prompt-system.md` | How the Kin system prompt is assembled (blocks 1-12) |
| `compacting.md` | Compacting algorithm + memory extraction pipeline |
| `DEVELOPMENT_PLAN.md` | Phased development plan with checkboxes — **follow this plan** |

## Tech stack

**Backend**: Bun + Hono + SQLite (bun:sqlite) + Drizzle ORM + Better Auth + croner. LLM/Embedding/Image providers are native primitives in `src/server/llm/{llm,embedding,image}/`; plugins consume `@kinbot-developer/sdk`. (Vercel AI SDK was removed pre-2.0.)
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
import type { Kin } from '@/shared/types'
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
- Key convention: `namespace.element.action` (e.g. `sidebar.kins.title`)
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

### Design system (Phase 0.5)

**Before building any frontend page or component**, read and follow the existing design system:

| Reference | What it provides |
|---|---|
| `src/client/pages/design-system/DesignSystemPage.tsx` | Live showcase of every component, variant, animation, and pattern — **this is the source of truth for how UI should look and behave** |
| `src/client/styles/globals.css` | All design tokens (colors, radii, spacing), palette overrides, utility classes (`glass-strong`, `gradient-primary`, `gradient-border`, `btn-shine`, etc.), and keyframe animations |
| `src/client/components/ui/` | shadcn/ui components — always use these instead of creating custom ones. Many have custom `variant` props (e.g. `Progress`, `Slider`, `Button`) |
| `src/client/components/theme-provider.tsx` | Palette system (`usePalette()`) and theme mode (`useTheme()`) — 8 palettes: aurora, ocean, forest, sunset, monochrome, sakura, neon, lavender |

**Rules:**

1. **Reuse existing components** — never recreate what already exists in `components/ui/`. Check the showcase page first.
2. **Use design tokens** — never hardcode colors. Use CSS variables (`var(--color-*)`) or Tailwind classes (`text-primary`, `bg-muted`, `border-border`, etc.).
3. **Support all palettes** — UI must look correct across all 8 palettes in both light and dark modes. Use semantic token names, not palette-specific values.
4. **Use existing utility classes** — for glass effects (`glass-strong`, `glass-subtle`), gradients (`gradient-primary`, `gradient-border`, `gradient-border-spin`), surfaces (`surface-card`, `surface-section`), and animations (`btn-shine`, `btn-magnetic`, `pulse-glow`, `animate-levitate`, etc.).
5. **WCAG AA contrast** — all text must meet 4.5:1 contrast ratio. Use `muted-foreground` for secondary text, never raw opacity.
6. **Consistent spacing and radii** — follow the existing token scale. Don't invent custom values.

## Architecture principles

- **Queue per Kin**: each Kin has a FIFO queue. One message processed at a time. User messages have priority over automated ones.
- **SSE is global**: one SSE connection per client, multiplexed by `kinId`. No per-Kin SSE connections.
- **Compacting**: summarizes old messages to stay within token limits. Never deletes original messages. Triggers after each LLM turn if thresholds are exceeded.
- **Memory**: dual-channel (automatic extraction pipeline + explicit Kin tools). Hybrid search (sqlite-vec KNN + FTS5 rank fusion).
- **Vault secrets**: encrypted at rest (AES-256-GCM). Never exposed in prompts — only accessible via `get_secret()` tool. Redaction blocks compacting.
- **Sub-Kins (tasks)**: ephemeral instances for delegated work. `await` mode re-enters parent queue; `async` mode deposits result as informational. Max depth configurable.
- **Inter-Kin communication**: `request`/`reply` pattern with correlation IDs. Replies are always `inform` (no ping-pong). Rate-limited.
- **Crons**: in-process scheduler (croner). Spawn sub-Kins on schedule. Results are informational (no LLM turn on parent). Kin-created crons require user approval.
- **Event bus + hooks**: foundation for observability and future plugin system.
- **Providers are pluggable**: one config per provider, multiple capabilities auto-detected (`llm`, `embedding`, `image`).
- **Tool concurrency**: within a single LLM step, tool calls are partitioned into batches by `tool-executor.ts`. Consecutive tools flagged `concurrencySafe: true` on their `ToolRegistration` fuse into one parallel batch (bounded by `KINBOT_MAX_TOOL_USE_CONCURRENCY`, default 10); every other tool runs alone in its own serial batch. Three optional flags: `readOnly`, `concurrencySafe`, `destructive`. Default is `false` everywhere (conservative: assume write, assume not safe to parallelize). When adding a native tool, only set these flags when the answer is unambiguous — anything stateful, side-effecting, or with ordering dependencies should stay at the default.

## Git conventions

- **Never** include `Co-Authored-By` lines in commit messages
- Commit messages follow conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`

## Development workflow

1. Follow `DEVELOPMENT_PLAN.md` phase by phase — **do not skip ahead**
2. Check off tasks as you complete them (`[ ]` → `[x]`)
3. Validate each phase's criterion before moving to the next
4. One commit per completed sub-task with a clear message
5. **Phase 0.5 (design system) is BLOQUANT** for all frontend work — backend phases can proceed in parallel
6. Run `bun run dev` frequently to verify nothing is broken

## Commands

```bash
bun run dev        # Start dev servers (Vite + Hono)
bun run build      # Production build (Vite → dist/client/)
bun run start      # Production server (Hono serves API + static)
bun run db:generate # Generate a Drizzle migration from schema changes
bun run db:migrate  # Apply pending migrations
```

## Project structure (overview)

```
src/
  server/           # Backend (Bun + Hono)
    routes/         # REST API routes
    services/       # Business logic
    providers/      # AI provider implementations
    tools/          # Native tools exposed to Kins
    db/             # SQLite connection + Drizzle schema + migrations
    auth/           # Better Auth config + middleware
    hooks/          # Lifecycle hooks
    sse/            # SSE manager
    config.ts       # Centralized configuration
  client/           # Frontend (React + Vite)
    pages/          # Page components
    components/     # Reusable components (ui/, sidebar/, chat/, kin/, common/)
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
