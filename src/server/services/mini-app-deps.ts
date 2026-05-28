/**
 * Shared helpers for mini-app dependency / import-map handling.
 *
 * Mini-apps resolve ES module imports (e.g. `import React from "react"`) through an
 * import map that the serve route builds from the app's `app.json` manifest — never from
 * inline HTML tags. These helpers are the single source of truth for the default stack and
 * for detecting when an app uses bare module specifiers without a resolvable import map.
 *
 * Used by:
 * - the `create_mini_app` tool / REST route (auto-create a default `app.json`)
 * - the `/serve` route (emit a clear console error when no import map is found)
 */

/**
 * The standard dependency stack used by 99% of mini-apps — kept in sync with the templates
 * (`mini-app-templates.ts`). Bare specifiers in app code resolve against this map.
 */
export const DEFAULT_DEPENDENCIES: Record<string, string> = {
  'react': 'https://esm.sh/react@19',
  'react-dom/client': 'https://esm.sh/react-dom@19/client',
  '@kinbot/react': '/api/mini-apps/sdk/kinbot-react.js',
  '@kinbot/components': '/api/mini-apps/sdk/kinbot-components.js',
}

/** Serialized default `app.json` manifest (shorthand `dependencies` form). */
export function buildDefaultManifest(): string {
  return JSON.stringify({ dependencies: DEFAULT_DEPENDENCIES }, null, 2)
}

/**
 * Merge a `dependencies` shorthand map into an existing serialized `app.json` (or create a
 * fresh one). Merges into the manifest's `importmap.imports` if it uses that form, otherwise
 * into the shorthand `dependencies` key. New keys win over existing ones.
 */
export function mergeDependenciesIntoManifest(
  existing: string | undefined,
  dependencies: Record<string, string>,
): string {
  let manifest: Record<string, unknown> = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing)
      if (parsed && typeof parsed === 'object') manifest = parsed as Record<string, unknown>
    } catch {
      // Malformed existing app.json — fall back to a fresh manifest.
      manifest = {}
    }
  }

  const importmap = manifest.importmap as { imports?: Record<string, string> } | undefined
  if (importmap && typeof importmap === 'object') {
    importmap.imports = { ...(importmap.imports ?? {}), ...dependencies }
  } else {
    const current = (manifest.dependencies as Record<string, string> | undefined) ?? {}
    manifest.dependencies = { ...current, ...dependencies }
  }

  return JSON.stringify(manifest, null, 2)
}

/** True if the HTML already declares an inline `<script type="importmap">`. */
export function htmlHasInlineImportMap(html: string): boolean {
  return /<script\s+type=["']importmap["']/i.test(html)
}

/** A module specifier is "bare" when it is neither relative/absolute path nor a URL. */
export function isBareSpecifier(spec: string): boolean {
  if (!spec) return false
  if (/^[./]/.test(spec)) return false // ./x, ../x, /x
  if (/^[a-z]+:/i.test(spec)) return false // http:, https:, data:, blob:, etc.
  return true
}

/**
 * Scan `<script type="text/jsx">` and `<script type="module">` blocks for bare module
 * specifiers (static `import`/`export ... from`, side-effect `import "x"`, and dynamic
 * `import("x")`). Returns the unique bare specifiers found.
 */
export function findBareModuleImports(html: string): string[] {
  const scriptBlocks = html.matchAll(
    /<script\s+type=["'](?:text\/jsx|module)["'][^>]*>([\s\S]*?)<\/script>/gi,
  )

  const specifiers = new Set<string>()
  const patterns = [
    /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from 'spec' / export … from 'spec'
    /\bimport\s*['"]([^'"]+)['"]/g, // import 'spec'
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // import('spec')
  ]

  for (const block of scriptBlocks) {
    const code = block[1] ?? ''
    for (const pattern of patterns) {
      for (const match of code.matchAll(pattern)) {
        const spec = match[1]
        if (spec && isBareSpecifier(spec)) specifiers.add(spec)
      }
    }
  }

  return [...specifiers]
}
