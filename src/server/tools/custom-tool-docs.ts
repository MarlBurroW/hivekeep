import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import type { ToolRegistration } from '@/server/tools/types'

// Authoring reference for GLOBAL custom tools. This content used to live in
// every main Agent's system prompt (~1.6k tokens per turn); it now loads on
// demand, mirroring the get_mini_app_docs pattern. Keep it in sync with the
// custom-tool runtime (custom-tool-tools.ts, renderer validation).
const sections: Record<string, { title: string; content: string }> = {
  authoring: {
    title: 'Authoring a quality custom tool',
    content: `# Authoring a quality custom tool

Custom tools are GLOBAL: any Agent can be granted one via toolboxes (like MCP), so a good tool becomes a shared, permanent capability instead of a one-off script.

**Good candidates:** anything you'd otherwise rebuild from scratch: an API call, a data transform, a scrape, a calculation, a formatter. Don't create a custom tool for a true one-shot task you'll never repeat.

## Translations (REQUIRED)

Provide human translations via the \`translations\` field: UI display name, description, and a label + description for each parameter, for at least \`en\` and \`fr\` (\`es\`/\`de\` welcome). This is UI-only (it never changes the tool definition the LLM sees), but without it the app shows the raw \`custom_<slug>\` instead of a proper localized name. Use \`update_custom_tool\` to backfill translations on an existing tool.

## Tool domains

Create a fitting **tool domain** (\`create_tool_domain\`) and group related custom tools under it. Pick a clear Lucide icon name (e.g. \`CloudSun\` for weather, \`Wallet\` for finance) and a color token, then set each tool's domain to its slug. A tool left on the default \`custom\` domain shows the generic Puzzle icon and the bland "custom" category everywhere; a dedicated domain gives the whole group a clear visual identity in the toolbox list and the tool picker. Use \`list_tool_domains\` first and reuse an existing domain before creating a near-duplicate.`,
  },

  renderer: {
    title: 'Result renderer (renderer.tsx)',
    content: `# Result renderer (renderer.tsx)

Ship a renderer by default: whenever your tool returns structured data (an object, a list, metrics, anything richer than a short string), write a \`renderer.tsx\` (via \`write_custom_tool_file\`) so its result shows as a clean visual card in the EXPANDED chat tool-call view instead of raw JSON. Treat the renderer as part of finishing a quality tool, alongside its translations and domain. A weather tool should show a weather card; a prices tool, a table; a status tool, badges + stats. Skip it ONLY for trivial single-value results where JSON is already perfectly clear. (With no renderer, the result shows as JSON; nothing breaks, but it looks raw.)

## Contract

\`\`\`tsx
export default function Renderer({ result, args, ui }) { … }
\`\`\`

- \`result\` is the tool's return value, typically \`{ success, output, error, exitCode, executionTime }\`; your data is usually under \`result.output\`.
- \`args\` is the call arguments.
- \`ui\` is a themed component kit.

## Styling

Use ONLY the \`ui\` primitives or inline \`style={{ color: 'var(--color-foreground)', … }}\` design tokens. Tailwind utility classes DO NOT apply (the host CSS doesn't contain arbitrary renderer classes). Rendering auto-themes (dark/light + the active palette) through the \`--color-*\` variables. You may use React hooks (useState, etc.) and import local files from the tool dir; do NOT import from the host app.

**\`ui\` primitives:** Card, Section, Header, Row, Stack, Badge (variant: default | primary | success | warning | destructive | info | muted), Stat (label+value), KeyValues (record or [key,value][]), Table ({ columns, rows }), Code. Plus \`ui.tokens\` (foreground, mutedForeground, card, primary, border, success, warning, destructive, info, …) for inline styling.

**Key \`--color-*\` tokens:** --color-background, --color-foreground, --color-card, --color-card-foreground, --color-muted, --color-muted-foreground, --color-primary, --color-primary-foreground, --color-border, --color-success, --color-warning, --color-destructive, --color-info.

## Validate it

After writing a \`renderer.tsx\`, run \`test_custom_tool\` and CHECK the \`renderer\` field in the result: \`{ ok: true }\` means it built and rendered; \`{ ok: false, phase: "build" | "render", error }\` means it is broken. The renderer runs in the USER's browser, so a build/render error is otherwise INVISIBLE to you; fix the reported error before considering the tool done. (Validation does an initial server-side render only: build errors, bad data access, and invalid children are caught; useEffect/handlers are not exercised.)`,
  },
}

export const getCustomToolDocsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Get the custom-tool authoring reference: translations, tool domains, and the result-renderer contract (renderer.tsx, ui primitives, validation). Call this BEFORE creating or updating a custom tool.',
      inputSchema: z.object({
        section: z.enum(['authoring', 'renderer', 'all']).default('all'),
      }),
      execute: async ({ section }) => {
        if (section === 'all') {
          return {
            title: 'Custom-tool authoring reference',
            content: Object.values(sections).map((s) => s.content).join('\n\n---\n\n'),
            sections: Object.entries(sections).map(([key, s]) => ({ id: key, title: s.title })),
          }
        }
        const s = sections[section]
        if (!s) return { error: `Unknown section: ${section}` }
        return { title: s.title, content: s.content }
      },
    }),
}
