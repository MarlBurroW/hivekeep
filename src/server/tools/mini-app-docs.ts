import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import type { ToolRegistration } from '@/server/tools/types'

const DOCS_BASE_URL = 'https://marlburrow.github.io/hivekeep/docs'

const sections: Record<string, { title: string; url: string; content: string }> = {
  overview: {
    title: 'Mini-Apps Overview',
    url: `${DOCS_BASE_URL}/mini-apps/overview/`,
    content: `# Mini-Apps Overview

Mini-apps are small web applications that live inside Hivekeep's sidebar. They use React with server-side JSX transpilation (no build step needed).

**Architecture:** HTML + React (JSX transpiled server-side) → served via Hivekeep API → rendered in sidebar iframe.

**Key concepts:**
- Use \`<script type="text/jsx">\` for inline JSX
- Dependencies declared in \`app.json\`
- Persistent key-value storage via \`useStorage\` hook
- Optional backend via \`_server.js\` (Hono)
- Real-time events via SSE
- Snapshots for versioning/rollback`,
  },

  'getting-started': {
    title: 'Getting Started',
    url: `${DOCS_BASE_URL}/mini-apps/getting-started/`,
    content: `# Getting Started with Mini-Apps

## ⚠️ Import maps live in app.json — NOT in the HTML

Bare ES imports (\`react\`, \`@hivekeep/react\`, …) only resolve through an import map that
Hivekeep builds from the app's \`app.json\` manifest. An inline \`<script type="importmap">\`
or config tag in your HTML is **ignored**. Without \`app.json\` you get the runtime error
\`Failed to resolve module specifier "react"\`.

## Recommended: create everything in one call

Pass \`dependencies\` (an import-map shorthand) directly to \`create_mini_app\` — Hivekeep
writes \`app.json\` for you:
\`\`\`js
create_mini_app({
  name: "Hello", slug: "hello",
  dependencies: {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "@hivekeep/react": "/api/mini-apps/sdk/hivekeep-react.js",
    "@hivekeep/components": "/api/mini-apps/sdk/hivekeep-components.js"
  },
  html: "<div id=\\"root\\"></div><script type=\\"text/jsx\\"> ... </script>"
})
\`\`\`
Or pass a full \`files\` map: \`{ "index.html": "...", "app.json": "...", "_server.js": "..." }\`.

If you provide HTML with bare imports but omit \`dependencies\`/\`app.json\`, a default
\`app.json\` (react, react-dom/client, @hivekeep/react, @hivekeep/components) is created
automatically and reported back as a \`warning\`.

## Alternative: two steps

1. Call \`create_mini_app\` with name, slug, and html
2. Write \`app.json\` via \`write_mini_app_file\` with the same \`dependencies\` map as above

3. Use React app pattern:
\`\`\`jsx
<div id="root"></div>
<script type="text/jsx">
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useHivekeep } from "@hivekeep/react";

function App() {
  const { ready } = useHivekeep();
  if (!ready) return <div>Loading...</div>;
  return <AppContent />;
}

createRoot(document.getElementById("root")).render(<App />);
</script>
\`\`\`

## Templates
Use \`get_mini_app_templates\` to see built-in templates (dashboard, todo-list, form, data-viewer, kanban, responsive).`,
  },

  hooks: {
    title: 'React Hooks Reference',
    url: `${DOCS_BASE_URL}/mini-apps/hooks/`,
    content: `# @hivekeep/react Hooks

## Core
- \`useHivekeep()\` → \`{ app, ready, theme, locale, isFullPage, api }\` — MUST call at root, wait for \`ready\`
- \`useTheme()\` → \`{ mode, palette }\` — lighter alternative when you only need theme
- \`useAgent()\` → \`{ agent, loading }\` — parent Agent info (id, name, avatarUrl)
- \`useUser()\` → \`{ user, loading }\` — current user info

## Data & Storage
- \`useStorage(key, defaultValue)\` → \`[value, setValue, loading]\` — persistent KV storage (like useState but persisted)
- \`useLocalStorage(key, defaultValue)\` → \`[value, setValue, remove]\` — browser localStorage (UI prefs)
- \`useApi(path, options?)\` → \`{ data, loading, error, refetch }\` — fetch from _server.js backend
- \`useFetch(url, options?)\` → \`{ data, loading, error, refetch, status }\` — fetch external data via proxy
- \`useAsync(asyncFn)\` → \`{ run, data, loading, error, reset }\` — wrap any async function

## Memory & Conversation
- \`useMemory()\` → \`{ search, store, results, loading }\` — search/store Agent memories
- \`useConversation()\` → \`{ history, send, messages, loading }\` — interact with Agent conversation

## UI & Layout
- \`useForm(initialValues, validate?)\` → form state management with validation
- \`useMediaQuery(query)\` → boolean — reactive CSS media query
- \`useBreakpoint()\` → "xs"|"sm"|"md"|"lg"|"xl" — current responsive breakpoint
- \`useHashRouter(defaultPath?)\` → \`{ path, params, navigate, back }\` — hash-based routing
- \`useClickOutside(ref, handler)\` — click outside detection
- \`useShortcut(key, callback)\` — keyboard shortcuts

## Utility
- \`useDebounce(value, delayMs?)\` → debounced value (default 300ms)
- \`useInterval(callback, delayMs)\` — declarative setInterval
- \`usePrevious(value)\` → previous render value
- \`useOnline()\` → boolean — network status
- \`useClipboard()\` → \`{ copy, paste, copied, loading }\`
- \`useNotification()\` → \`{ notify, lastSent }\`
- \`useDownload()\` → \`{ download, downloading }\`

## Pagination
- \`useInfiniteScroll(path, options?)\` → infinite scroll with sentinelRef
- \`usePagination(path, options?)\` → traditional page-based pagination

## Inter-App
- \`useApps()\` → \`{ apps, loading, refresh }\` — list other mini-apps
- \`useSharedData(onData?)\` → \`{ data, clear }\` — receive shared data from other apps

## Events
- \`useEventStream(eventName?, callback?)\` → \`{ messages, connected, clear, send }\` — SSE from backend; \`send(event, data)\` reaches the backend's onClientEvent`,
  },

  components: {
    title: 'Component Library',
    url: `${DOCS_BASE_URL}/mini-apps/components/`,
    content: `# @hivekeep/components

Add to app.json: \`"@hivekeep/components": "/api/mini-apps/sdk/hivekeep-components.js"\`

## Typography
Heading (standalone title, renders h1–h6 via \`as\`), Text (themed p/span). NOTE: there is no \`Title\` export — use Heading, or Card.Title inside a Card.

## Layout
Card (+Header/Title/Description/Content/Footer), Stack, Grid (+Grid.Item), Divider, Panel (collapsible)

## Forms
Button (primary|secondary|destructive|ghost|shine), Input, Textarea, Select, Checkbox, Switch, RadioGroup, Slider, NumberInput, DatePicker, DateRangePicker, ColorPicker, TagInput, Combobox, Form (+Field/Submit/Reset/Actions with validation), FileUpload

## Data Display
Table, DataGrid (sorting/filtering/pagination/selection), List, Badge, Tag, Stat, Avatar, AvatarGroup, Tooltip, ProgressBar, CodeBlock, Timeline, Accordion

## Feedback
Alert, Spinner, Skeleton, EmptyState, Modal, Drawer, Popover, DropdownMenu

## Navigation
Tabs, Pagination, Breadcrumbs, Stepper (+StepperContent), Router, Route, Link, NavLink, Navigate

## Charts
BarChart, LineChart, PieChart, SparkLine

## Advanced
Kanban (drag-and-drop), MarkdownEditor, Calendar, ButtonGroup

All components auto-adapt to light/dark theme. See full docs for props and examples.`,
  },

  sdk: {
    title: 'SDK Reference (Low-Level)',
    url: `${DOCS_BASE_URL}/mini-apps/sdk-reference/`,
    content: `# Hivekeep SDK (Low-Level API)

Direct SDK exports from @hivekeep/react (use hooks when possible):

## UI
- \`toast(message, type)\` — type: info|success|warning|error
- \`confirm(message, options?)\` → Promise<boolean>
- \`prompt(message, options?)\` → Promise<string|null>
- \`navigate(path)\`, \`fullpage(bool)\`, \`setTitle(title)\`, \`setBadge(value)\`, \`openApp(slug)\`

## Storage
- \`storage.get/set/delete/list/clear\` — direct KV storage access

## Network
- \`api.get/post/put/patch/delete(path)\` — backend API calls (your _server.js)
- \`http(url, opts?)\`, \`http.json(url)\`, \`http.post(url, data)\` — external HTTP proxy (60 req/min, 5MB max)

## Platform API (manage Hivekeep resources — build UI extensions)
- \`platform.get/post/put/patch/delete(path)\` — call Hivekeep's OWN REST API, the same one the settings pages use. This is how you build a mini-app that manages a resource (a contacts manager, a crons board, a projects dashboard) instead of making the user dig through settings.
- Gated by \`platform:<resource>:<read|write>\` permissions declared in app.json (e.g. \`"platform:contacts:read"\`, \`"platform:contacts:write"\`). The user approves them in the app's permission banner. A \`:write\` grant implies \`:read\`.
- The resource is the first path segment: \`platform.get("/contacts")\` needs \`platform:contacts:read\`; \`platform.post("/contacts", {...})\` needs \`platform:contacts:write\`.
- Discover the exact routes/shapes for a resource with get_mini_app_docs or by reading api.md. Forbidden through the gateway: auth, vault (secret values), database, users, and mini-apps (an app can't grant itself permissions).
- Example — a contacts manager:
\`\`\`js
// app.json: { "permissions": ["platform:contacts:read", "platform:contacts:write"] }
const { contacts } = await Hivekeep.platform.get("/contacts")
await Hivekeep.platform.post("/contacts", { firstName: "Ada", lastName: "Lovelace" })
await Hivekeep.platform.delete("/contacts/" + id)
\`\`\`

## Events
- \`events.on(event, cb)\`, \`events.subscribe(cb)\`, \`events.close()\` — SSE from backend
- \`events.send(event, data?)\` → Promise<{handled, result}> — send to backend onClientEvent()

## Other
- \`clipboard.write(text)\`, \`clipboard.read()\`
- \`download(filename, content, mimeType?)\`
- \`shortcut(key, callback)\` — keyboard shortcuts
- \`apps.list()\`, \`apps.get(id)\` — inter-app discovery
- \`Hivekeep.sendMessage(text, options?)\` — send message to Agent conversation
- \`Hivekeep.share(targetSlug, data)\` — share data with another app
- \`Hivekeep.resize(width?, height?)\` — request panel resize
- \`Hivekeep.notification(title, body?)\` — browser notification
- \`Hivekeep.memory.search/store\` — Agent memory access
- \`Hivekeep.conversation.history/send\` — conversation access`,
  },

  backend: {
    title: 'Backend (_server.js)',
    url: `${DOCS_BASE_URL}/mini-apps/backend/`,
    content: `# Mini-App Backend

Create \`_server.js\` via \`write_mini_app_file\`. Recognized exports (all optional, at least one required):

\`\`\`js
export default function(ctx) {            // HTTP routes at /api/mini-apps/<appId>/api/*
  const app = new ctx.Hono();
  app.get("/hello", (c) => c.json({ message: "Hello!" }));
  return app;
}
export async function onStart(ctx) {}     // runs when the backend loads
export async function onStop(ctx) {}      // cleanup before unload/reload (5s budget)
export function onClientEvent(ctx, event, data, meta) {  // receives Hivekeep.events.send() from the UI
  // meta = { userId, userName }; the return value is sent back to the caller
}
\`\`\`

## Background mode (live backend)
Set \`"background": true\` in \`app.json\` → the backend loads at server boot and is restarted
automatically after every edit. Use \`onStart\` to launch live work (jobs, watchers).

## Context Object
- \`ctx.Hono\`, \`ctx.appId\`, \`ctx.agentId\`, \`ctx.appName\`, \`ctx.version\`, \`ctx.background\`
- \`ctx.storage\` — KV storage (.get/.set/.delete/.list/.clear), shared with the frontend
- \`ctx.events.emit(event, data, {userId}?)\` — SSE push to the app UI (optionally a single user)
- \`ctx.schedule(name, cronPattern, handler)\` — local cron job (croner pattern, max 10/app, runs spaced >= 15s, auto-stopped on reload). Returns \`{stop()}\`
- \`ctx.on(eventType, handler)\` — REACT to platform events (the same catalogue Hivekeep sends over SSE): "task:done", "channel:message-received", "contact:created", "cron:triggered", "notification:new"… The handler gets \`{ type, agentId?, data }\`. Returns an unsubscribe fn; all subscriptions are torn down on reload. Gated by the \`events:<prefix>\` permission (e.g. \`events:task\` for task:*, \`events:channel\` for channel:*). This is what makes a background app reactive instead of just polling. (High-frequency/internal events like chat:token are not subscribable. Beware feedback loops: an event handler that triggers the same event.)
- \`ctx.timers.setTimeout/setInterval/clearTimeout/clearInterval\` — managed timers, auto-cleared when the instance stops (interval min 1s). NEVER use global setInterval — it would leak across reloads
- \`ctx.signal\` — AbortSignal aborted when the instance stops (pass it to fetch/loops)
- \`ctx.notify(title, body?)\` — platform notification (notification center + user's external channels), max 10/hour
- \`ctx.fetch(url, options?)\` — SSRF-guarded fetch (http/https, public hosts only, 30s timeout)
- \`ctx.files\` — file storage under the app's \`_data/\` dir (.read/.write/.delete/.list/.exists), excluded from snapshots
- \`ctx.log.info/warn/error\` — also lands in the app console (readable via get_mini_app_console)

## Gated capabilities (need user-approved permissions)
Declare what you need in \`app.json\`: \`"permissions": ["llm", "agent:inform", "agent:task", "channels:send", "secrets:MY_KEY"]\`.
The user approves from the banner in the app panel. Until granted, these throw:
- \`ctx.secrets.get(name)\` — vault secret (needs \`secrets:<NAME>\`) — NEVER store API keys in code or storage
- \`ctx.llm.complete(prompt, {model?, maxTokens?})\` — one-shot LLM completion (needs \`llm\`, 30/hour)
- \`ctx.agent.inform(text)\` — drop a message into the maintainer Agent's queue (needs \`agent:inform\`, 10/hour)
- \`ctx.agent.task(description, {title?})\` — spawn an async sub-task on the maintainer Agent (needs \`agent:task\`, 5/hour)
- \`ctx.on(eventType, handler)\` — subscribe to platform events (needs \`events:<prefix>\`, e.g. events:task): see the context list above. Lets an app react ("when a task finishes, SMS me"; "when a contact is created, sync it").
- \`ctx.channels\` — send through the platform's EXISTING messaging channels (needs \`channels:send\`, 20/hour):
  - \`ctx.channels.list()\` — channels with id/name/platform/status
  - \`ctx.channels.send(channelId, chatId, text)\` — send to a known platform chat id
  - \`ctx.channels.sendToContact(contact, platform, text)\` — resolves the contact's platform id + an active channel automatically (e.g. \`sendToContact("Nicolas", "twilio-sms", "...")\`)
  PREFER this over re-implementing a provider API with raw secrets: an SMS through an existing Twilio channel needs ONE permission instead of three secrets, and every send is audited.
- \`ctx.permissions.has("llm")\` / \`.requested\` / \`.granted\` — introspection

## Example: background watcher
\`\`\`js
export async function onStart(ctx) {
  ctx.schedule("poll-feed", "*/15 * * * *", async () => {
    const res = await ctx.fetch("https://api.example.com/feed");
    const items = await res.json();
    const lastSeen = (await ctx.storage.get("lastSeen")) ?? 0;
    const fresh = items.filter((i) => i.ts > lastSeen);
    if (fresh.length > 0) {
      await ctx.storage.set("lastSeen", fresh[0].ts);
      ctx.events.emit("feed:updated", fresh);
      await ctx.notify(\`\${fresh.length} new items\`);
    }
  });
}
export default function(ctx) {
  const app = new ctx.Hono();
  app.get("/items", async (c) => c.json((await ctx.storage.get("items")) ?? []));
  return app;
}
\`\`\`

## Frontend Access
\`const { api } = useHivekeep()\` then \`api.get("/path")\`, \`api.post("/path", data)\`

## Real-time Events
Backend → UI: \`ctx.events.emit("update", {count: 42})\` → \`events.on("update", cb)\` / \`useEventStream("update", cb)\`
UI → backend: \`Hivekeep.events.send("refresh", data)\` (or \`useEventStream().send\`) → \`onClientEvent\`

## Debugging
Use \`get_mini_app_backend_status\` (loaded?, background?, jobs + next runs, timers, SSE subscribers)
and \`get_mini_app_console\` (frontend + backend log entries).`,
  },

  guidelines: {
    title: 'Design Guidelines',
    url: `${DOCS_BASE_URL}/mini-apps/guidelines/`,
    content: `# Mini-App Design Guidelines

## Dark/Light Mode
- Always use CSS variables (--color-primary, --color-background, etc.) — never hardcode colors
- Theme is auto-synced from Hivekeep settings
- Test both modes

## Sidebar-Aware Design
- Default width ~380px — design mobile-first
- Use \`useBreakpoint()\` or responsive CSS utilities for adaptive layouts
- Support fullpage mode via \`fullpage(true)\`

## Use Existing Components
- Import from @hivekeep/components — don't reinvent buttons, cards, forms
- Components auto-adapt to theme and are accessible
- Use DataGrid instead of Table+Pagination for data-heavy views

## Performance
- Keep bundle size small (ESM imports from esm.sh)
- Use \`useDebounce\` for search inputs
- Use \`useInfiniteScroll\` for large lists

## CSS Design System
Utility classes available: .flex, .grid, .p-4, .gap-4, .rounded-lg, etc. (Tailwind-like)
Responsive prefixes: sm:, md:, lg:, xl: (mobile-first breakpoints)
Glass effects: .glass-strong, .surface-card
Animations: .animate-fade-in-up, .animate-scale-in, etc.`,
  },

  all: {
    title: 'Complete Mini-App Reference',
    url: `${DOCS_BASE_URL}/mini-apps/overview/`,
    content: '', // Will be assembled dynamically
  },
}

export const getMiniAppDocsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Get mini-app SDK documentation (hooks, components, backend, guidelines).',
      inputSchema: z.object({
        section: z
          .enum(['overview', 'getting-started', 'hooks', 'components', 'sdk', 'backend', 'guidelines', 'all'])
          .default('all'),
      }),
      execute: async ({ section }) => {
        if (section === 'all') {
          const allContent = Object.entries(sections)
            .filter(([key]) => key !== 'all')
            .map(([, s]) => s.content)
            .join('\n\n---\n\n')

          return {
            title: 'Complete Mini-App SDK Reference',
            docsUrl: `${DOCS_BASE_URL}/mini-apps/overview/`,
            content: allContent,
            sections: Object.entries(sections)
              .filter(([key]) => key !== 'all')
              .map(([key, s]) => ({ id: key, title: s.title, url: s.url })),
          }
        }

        const s = sections[section]
        if (!s) return { error: `Unknown section: ${section}` }

        return {
          title: s.title,
          docsUrl: s.url,
          content: s.content,
        }
      },
    }),
}
