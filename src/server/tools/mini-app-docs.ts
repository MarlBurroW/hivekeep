import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import type { ToolRegistration } from '@/server/tools/types'

const DOCS_BASE_URL = 'https://marlburrow.github.io/kinbot/docs'

const sections: Record<string, { title: string; url: string; content: string }> = {
  overview: {
    title: 'Mini-Apps Overview',
    url: `${DOCS_BASE_URL}/mini-apps/overview/`,
    content: `# Mini-Apps Overview

Mini-apps are small web applications that live inside KinBot's sidebar. They use React with server-side JSX transpilation (no build step needed).

**Architecture:** HTML + React (JSX transpiled server-side) → served via KinBot API → rendered in sidebar iframe.

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

Bare ES imports (\`react\`, \`@kinbot/react\`, …) only resolve through an import map that
KinBot builds from the app's \`app.json\` manifest. An inline \`<script type="importmap">\`
or config tag in your HTML is **ignored**. Without \`app.json\` you get the runtime error
\`Failed to resolve module specifier "react"\`.

## Recommended: create everything in one call

Pass \`dependencies\` (an import-map shorthand) directly to \`create_mini_app\` — KinBot
writes \`app.json\` for you:
\`\`\`js
create_mini_app({
  name: "Hello", slug: "hello",
  dependencies: {
    "react": "https://esm.sh/react@19",
    "react-dom/client": "https://esm.sh/react-dom@19/client",
    "@kinbot/react": "/api/mini-apps/sdk/kinbot-react.js",
    "@kinbot/components": "/api/mini-apps/sdk/kinbot-components.js"
  },
  html: "<div id=\\"root\\"></div><script type=\\"text/jsx\\"> ... </script>"
})
\`\`\`
Or pass a full \`files\` map: \`{ "index.html": "...", "app.json": "...", "_server.js": "..." }\`.

If you provide HTML with bare imports but omit \`dependencies\`/\`app.json\`, a default
\`app.json\` (react, react-dom/client, @kinbot/react, @kinbot/components) is created
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
import { useKinBot } from "@kinbot/react";

function App() {
  const { ready } = useKinBot();
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
    content: `# @kinbot/react Hooks

## Core
- \`useKinBot()\` → \`{ app, ready, theme, locale, isFullPage, api }\` — MUST call at root, wait for \`ready\`
- \`useTheme()\` → \`{ mode, palette }\` — lighter alternative when you only need theme
- \`useKin()\` → \`{ kin, loading }\` — parent Kin info (id, name, avatarUrl)
- \`useUser()\` → \`{ user, loading }\` — current user info

## Data & Storage
- \`useStorage(key, defaultValue)\` → \`[value, setValue, loading]\` — persistent KV storage (like useState but persisted)
- \`useLocalStorage(key, defaultValue)\` → \`[value, setValue, remove]\` — browser localStorage (UI prefs)
- \`useApi(path, options?)\` → \`{ data, loading, error, refetch }\` — fetch from _server.js backend
- \`useFetch(url, options?)\` → \`{ data, loading, error, refetch, status }\` — fetch external data via proxy
- \`useAsync(asyncFn)\` → \`{ run, data, loading, error, reset }\` — wrap any async function

## Memory & Conversation
- \`useMemory()\` → \`{ search, store, results, loading }\` — search/store Kin memories
- \`useConversation()\` → \`{ history, send, messages, loading }\` — interact with Kin conversation

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
- \`useEventStream(eventName?, callback?)\` → \`{ messages, connected, clear }\` — SSE from backend`,
  },

  components: {
    title: 'Component Library',
    url: `${DOCS_BASE_URL}/mini-apps/components/`,
    content: `# @kinbot/components

Add to app.json: \`"@kinbot/components": "/api/mini-apps/sdk/kinbot-components.js"\`

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
    content: `# KinBot SDK (Low-Level API)

Direct SDK exports from @kinbot/react (use hooks when possible):

## UI
- \`toast(message, type)\` — type: info|success|warning|error
- \`confirm(message, options?)\` → Promise<boolean>
- \`prompt(message, options?)\` → Promise<string|null>
- \`navigate(path)\`, \`fullpage(bool)\`, \`setTitle(title)\`, \`setBadge(value)\`, \`openApp(slug)\`

## Storage
- \`storage.get/set/delete/list/clear\` — direct KV storage access

## Network
- \`api.get/post/put/patch/delete(path)\` — backend API calls
- \`http(url, opts?)\`, \`http.json(url)\`, \`http.post(url, data)\` — external HTTP proxy (60 req/min, 5MB max)

## Events
- \`events.on(event, cb)\`, \`events.subscribe(cb)\`, \`events.close()\` — SSE from backend

## Other
- \`clipboard.write(text)\`, \`clipboard.read()\`
- \`download(filename, content, mimeType?)\`
- \`shortcut(key, callback)\` — keyboard shortcuts
- \`apps.list()\`, \`apps.get(id)\` — inter-app discovery
- \`KinBot.sendMessage(text, options?)\` — send message to Kin conversation
- \`KinBot.share(targetSlug, data)\` — share data with another app
- \`KinBot.resize(width?, height?)\` — request panel resize
- \`KinBot.notification(title, body?)\` — browser notification
- \`KinBot.memory.search/store\` — Kin memory access
- \`KinBot.conversation.history/send\` — conversation access`,
  },

  backend: {
    title: 'Backend (_server.js)',
    url: `${DOCS_BASE_URL}/mini-apps/backend/`,
    content: `# Mini-App Backend

Create \`_server.js\` via \`write_mini_app_file\`. Must export a default function that receives ctx and returns a Hono app.

\`\`\`js
export default function(ctx) {
  const app = new ctx.Hono();
  app.get("/hello", (c) => c.json({ message: "Hello!" }));
  return app;
}
\`\`\`

## Context Object
- \`ctx.Hono\` — Hono constructor
- \`ctx.storage\` — KV storage (.get/.set/.delete/.list/.clear)
- \`ctx.events\` — SSE (.emit(event, data))
- \`ctx.appId\`, \`ctx.kinId\`, \`ctx.appName\`, \`ctx.log\`

## Routes
Served at \`/api/mini-apps/<appId>/api/*\`

## Frontend Access
\`const { api } = useKinBot()\` then \`api.get("/path")\`, \`api.post("/path", data)\`

## Real-time Events (SSE)
Backend: \`ctx.events.emit("update", {count: 42})\`
Frontend: \`events.on("update", (data) => ...)\` or \`useEventStream("update", cb)\``,
  },

  guidelines: {
    title: 'Design Guidelines',
    url: `${DOCS_BASE_URL}/mini-apps/guidelines/`,
    content: `# Mini-App Design Guidelines

## Dark/Light Mode
- Always use CSS variables (--color-primary, --color-background, etc.) — never hardcode colors
- Theme is auto-synced from KinBot settings
- Test both modes

## Sidebar-Aware Design
- Default width ~380px — design mobile-first
- Use \`useBreakpoint()\` or responsive CSS utilities for adaptive layouts
- Support fullpage mode via \`fullpage(true)\`

## Use Existing Components
- Import from @kinbot/components — don't reinvent buttons, cards, forms
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
