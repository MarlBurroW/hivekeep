/**
 * Custom-tool RESULT RENDERER bundler (host-context React).
 *
 * A custom tool MAY ship an optional `renderer.tsx` (fallback `renderer.jsx` /
 * `renderer.js`) that default-exports a React component:
 *
 *     export default function Renderer({ result, args, ui }) { … }
 *
 * The component is bundled SERVER-SIDE and served as an ESM module that the chat
 * client loads at runtime via `React.lazy(() => import(url))`. It shares the
 * HOST's single React instance — exposed on the page as `window.__GEZY_REACT__`
 * (see src/client/main.tsx) — so hooks work (no "Invalid hook call") and it
 * inherits the app theme through the cascading `--color-*` CSS variables.
 *
 * Bundling recipe (proven end-to-end before productionizing):
 *   - Bun's native bundler (Bun.build) — bundles the renderer's LOCAL imports
 *     (anything inside the tool dir) into a single ESM module.
 *   - Classic JSX transform (React.createElement / React.Fragment) so the output
 *     only needs a `React` binding — no react/jsx-runtime import.
 *   - A banner `const React = window.__GEZY_REACT__;` backs that free `React`
 *     binding for renderers that DON'T import React (the documented contract).
 *   - A resolver plugin maps any bare `react` / `react-dom` import to the same
 *     host globals, so a renderer that DOES `import React from 'react'` still
 *     works and the output never contains an unresolved bare import (the browser
 *     would otherwise fail with "Failed to resolve module specifier 'react'").
 *
 * THREAT MODEL: host-context renderers run with full host privileges (no
 * isolation). This is acceptable because custom tools are trusted (user/Agent-
 * authored on a self-hosted instance) and the renderer is for RESULT DISPLAY
 * only.
 *
 * The built output is cached in memory keyed by slug + the renderer file's mtime
 * so we only rebuild when the source changes.
 */

import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import { createLogger } from '@/server/logger'
import { getCustomTool, toolDir } from '@/server/services/custom-tools'
import { UI_KIT } from '@/shared/custom-tool-ui-kit'

const log = createLogger('custom-tool-renderer')

// Bind the host React (+ react-dom) to the custom SSR globals ONCE at module
// scope. These are NOT `window` — they're bespoke keys the SSR build's
// banner/plugin read from — so leaving them set has no browser-detection side
// effect on concurrent server code. Idempotent: always the same instance.
;(globalThis as Record<string, unknown>).__GEZY_SSR_REACT__ = React
;(globalThis as Record<string, unknown>).__GEZY_SSR_REACT_DOM__ = ReactDOM

/** Renderer entry filenames, in resolution order. */
const RENDERER_CANDIDATES = ['renderer.tsx', 'renderer.jsx', 'renderer.js'] as const

/**
 * The React-global accessor expressions for each build target. The CLIENT build
 * reads the host React off `window` (set in src/client/main.tsx). The SSR build
 * (server-side renderer validation) must NOT touch `window` — some code uses
 * `typeof window` for browser-detection, and setting `globalThis.window` could
 * break concurrent server code — so it reads off custom `globalThis` keys
 * (`__GEZY_SSR_REACT__` / `__GEZY_SSR_REACT_DOM__`) that have no such side
 * effect. `validateCustomToolRenderer` sets those once at module scope.
 */
interface RendererGlobals {
  /** Expression that evaluates to the host React instance. */
  react: string
  /** Expression that evaluates to the host react-dom (or `{}` fallback). */
  reactDom: string
}

const CLIENT_GLOBALS: RendererGlobals = {
  react: 'window.__GEZY_REACT__',
  reactDom: '(window.__HIVEKEEP_REACT_DOM__ || {})',
}

const SSR_GLOBALS: RendererGlobals = {
  react: 'globalThis.__GEZY_SSR_REACT__',
  reactDom: '(globalThis.__GEZY_SSR_REACT_DOM__ || {})',
}

/** Binds the host's single React instance to the free `React` global the classic
 *  JSX transform emits. Keeps hooks working (shared React, no duplicate). Read
 *  from the target-specific global accessor (window for client, globalThis key
 *  for SSR). */
function reactBanner(globals: RendererGlobals): string {
  return `const React = ${globals.react};`
}

/**
 * Bun.build plugin factory: resolve any bare react / react-dom import to a
 * virtual module that re-exports from the host globals (read off the supplied
 * `globals` accessors). Two payoffs:
 *   - a renderer that imports React works (resolves to the same host instance);
 *   - the output never contains an unresolved bare specifier the browser can't
 *     load (no import map exists on the chat page).
 *
 * Parametrizing the accessor lets the same recipe target both the CLIENT
 * (`window.__GEZY_REACT__`) and SSR (`globalThis.__GEZY_SSR_REACT__`, no
 * window — no browser-detection side effect).
 */
function makeReactGlobalPlugin(globals: RendererGlobals): import('bun').BunPlugin {
  return {
    name: 'hivekeep-react-global',
    setup(build) {
      build.onResolve({ filter: /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|react-dom|react-dom\/client)$/ }, (args) => ({
        path: args.path,
        namespace: 'hivekeep-react-global',
      }))
      build.onLoad({ filter: /.*/, namespace: 'hivekeep-react-global' }, (args) => {
        if (args.path.startsWith('react-dom')) {
          return {
            loader: 'js',
            contents:
              `const RD = ${globals.reactDom};` +
              'export default RD;' +
              'export const createPortal = RD.createPortal, flushSync = RD.flushSync, createRoot = RD.createRoot;',
          }
        }
        // react/jsx-runtime + react/jsx-dev-runtime — the AUTOMATIC JSX runtime
        // (Bun emits jsx/jsxs/jsxDEV regardless of the classic-jsx option above).
        // CRITICAL: these must NOT be aliased to React.createElement. Their
        // signatures differ — children live in `props.children`, and the 3rd+
        // positional args are `key` / `isStaticChildren` / `source` / `self`.
        // Aliasing to createElement makes those extra args get treated as children
        // and CLOBBER the real `props.children` → components render empty. So we
        // re-implement jsx/jsxs/jsxDEV correctly over the host createElement.
        if (args.path.includes('jsx-runtime') || args.path.includes('jsx-dev-runtime')) {
          return {
            loader: 'js',
            contents: [
              `const R = ${globals.react};`,
              'const Fragment = R.Fragment;',
              'function jsx(type, props, key) {',
              '  const p = props || {};',
              '  const rest = {};',
              "  for (const k in p) { if (k !== 'children') rest[k] = p[k]; }",
              '  if (key !== undefined) rest.key = key;',
              '  return p.children === undefined',
              '    ? R.createElement(type, rest)',
              '    : R.createElement(type, rest, p.children);',
              '}',
              'export { jsx, jsx as jsxs, jsx as jsxDEV, Fragment };',
              'export default { jsx, jsxs: jsx, jsxDEV: jsx, Fragment };',
            ].join('\n'),
          }
        }
        // react — re-export the host React instance + its common named exports so
        // both default and named imports resolve to the host instance.
        return {
          loader: 'js',
          contents:
            `const R = ${globals.react};` +
            'export default R;' +
            'export const useState=R.useState,useEffect=R.useEffect,useLayoutEffect=R.useLayoutEffect,' +
            'useMemo=R.useMemo,useRef=R.useRef,useCallback=R.useCallback,useReducer=R.useReducer,' +
            'useContext=R.useContext,createContext=R.createContext,useId=R.useId,useTransition=R.useTransition,' +
            'useDeferredValue=R.useDeferredValue,useSyncExternalStore=R.useSyncExternalStore,' +
            'Fragment=R.Fragment,createElement=R.createElement,cloneElement=R.cloneElement,' +
            'isValidElement=R.isValidElement,memo=R.memo,forwardRef=R.forwardRef,Children=R.Children;',
        }
      })
    },
  }
}

/** Cache entry: the built ESM string + the mtime it was built from. */
interface CacheEntry {
  mtimeMs: number
  js: string
}

const cache = new Map<string, CacheEntry>()

/** Locate the renderer entry file for a tool. Returns its absolute path + mtime,
 *  or null when the tool ships no renderer. */
function findRendererFile(slug: string): { path: string; mtimeMs: number } | null {
  const dir = toolDir(slug)
  for (const candidate of RENDERER_CANDIDATES) {
    const abs = join(dir, candidate)
    if (existsSync(abs)) {
      try {
        return { path: abs, mtimeMs: statSync(abs).mtimeMs }
      } catch {
        /* race: file vanished between exists + stat — keep looking */
      }
    }
  }
  return null
}

/**
 * Cheap presence check used by the catalog / name-map so the client only attempts
 * to load a renderer when one exists. Pure filesystem (no bundling).
 */
export function customToolHasRenderer(slug: string): boolean {
  return findRendererFile(slug) !== null
}

/**
 * Current renderer VERSION for a tool = the renderer file's mtimeMs, or null when
 * the tool ships no renderer. Used as a content-addressed cache key on both sides:
 *   - the client folds it into the lazy()/import URL (`?v=<version>`) so the same
 *     slug+version reuses ONE lazy component (no re-suspend → no spinner flash)
 *     and the browser can cache the module forever (immutable);
 *   - because it is the file mtime, any renderer.tsx rewrite changes it → a new
 *     URL/key → a fresh import/build, busting every cache automatically.
 * Pure filesystem (no bundling).
 */
export function customToolRendererVersion(slug: string): number | null {
  return findRendererFile(slug)?.mtimeMs ?? null
}

/**
 * Core bundle step shared by the client + SSR builds. Runs Bun.build over the
 * resolved renderer entry with the supplied React-global accessors, and returns
 * the built ESM string. Throws with a clean message on any failure.
 */
async function bundleRenderer(slug: string, entryPath: string, globals: RendererGlobals): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entryPath],
    format: 'esm',
    target: 'browser',
    // Classic JSX → React.createElement / React.Fragment, leaving `React` as a
    // free global (backed by the banner / resolver plugin).
    jsx: { runtime: 'classic', factory: 'React.createElement', fragment: 'React.Fragment' },
    banner: reactBanner(globals),
    plugins: [makeReactGlobalPlugin(globals)],
    // Local imports within the tool dir are bundled; react/react-dom are handled
    // by the resolver plugin above (never left as bare specifiers).
  }).catch((err: unknown) => {
    // Bun.build rejects (rather than returning success:false) for some failures.
    // Syntax errors reject with an AggregateError whose `.errors` carry the
    // detailed per-message diagnostics — surface those so the Agent sees the actual
    // cause (e.g. "Unexpected end of file") instead of the bare "Bundle failed".
    let message = err instanceof Error ? err.message : String(err)
    if (err instanceof AggregateError && Array.isArray(err.errors) && err.errors.length > 0) {
      const detail = err.errors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join('\n')
      if (detail.trim()) message = detail
    }
    throw new Error(`Renderer build failed for "${slug}": ${message}`)
  })

  if (!result.success || result.outputs.length === 0) {
    const message = result.logs.map((l) => l.message).join('\n') || 'unknown bundling error'
    log.warn({ slug, message }, 'Custom tool renderer build failed')
    throw new Error(`Renderer build failed for "${slug}": ${message}`)
  }

  return result.outputs[0]!.text()
}

/**
 * Build (and cache) the custom tool's renderer as a server-bundled ESM string
 * for the CLIENT. The output reads the host React off `window.__GEZY_REACT__`.
 * Returns null when the tool has no renderer file. Throws with a clean message
 * when bundling fails (the route turns that into a 500 with the message).
 *
 * Cache key is slug; we rebuild only when the renderer file's mtime changes.
 */
export async function buildCustomToolRenderer(slug: string): Promise<string | null> {
  if (!getCustomTool(slug)) return null

  const entry = findRendererFile(slug)
  if (!entry) return null

  const cached = cache.get(slug)
  if (cached && cached.mtimeMs === entry.mtimeMs) return cached.js

  const js = await bundleRenderer(slug, entry.path, CLIENT_GLOBALS)
  cache.set(slug, { mtimeMs: entry.mtimeMs, js })
  log.debug({ slug, bytes: js.length }, 'Custom tool renderer built')
  return js
}

/** SSR-build cache, kept separate from the client cache (different global
 *  accessors → different output). Validation is rare, so a small mtime-keyed
 *  cache is plenty and keeps the client perf cache untouched. */
const ssrCache = new Map<string, CacheEntry>()

/**
 * Build the custom tool's renderer as a server-bundled ESM string for SSR
 * VALIDATION. Identical recipe to the client build EXCEPT the React globals are
 * read off `globalThis.__GEZY_SSR_REACT__` / `globalThis.__GEZY_SSR_REACT_DOM__`
 * — custom keys with NO `window` involvement, so building/rendering server-side
 * never sets `globalThis.window` and never trips browser-detection code.
 *
 * Returns null when the tool has no renderer file. Throws on bundling failure.
 */
export async function buildCustomToolRendererForSSR(slug: string): Promise<string | null> {
  if (!getCustomTool(slug)) return null

  const entry = findRendererFile(slug)
  if (!entry) return null

  const cached = ssrCache.get(slug)
  if (cached && cached.mtimeMs === entry.mtimeMs) return cached.js

  const js = await bundleRenderer(slug, entry.path, SSR_GLOBALS)
  ssrCache.set(slug, { mtimeMs: entry.mtimeMs, js })
  return js
}

/** Result of {@link validateCustomToolRenderer}. */
export interface RendererValidation {
  /** True when the renderer built AND initial-rendered without throwing. */
  ok: boolean
  /** Which step failed (only set when `ok` is false). */
  phase?: 'build' | 'render'
  /** Human-readable failure message (only set when `ok` is false). */
  error?: string
}

/**
 * Validate a custom tool's renderer SERVER-SIDE so an Agent can discover a broken
 * renderer without opening a browser. Two steps:
 *   1. BUILD — bundle `renderer.tsx` via {@link buildCustomToolRendererForSSR}.
 *      A syntax error / unresolved import surfaces here as `phase:'build'`.
 *   2. RENDER — dynamic-import the built module and `renderToStaticMarkup` its
 *      default export with `{ result, args, ui: UI_KIT }`. A data-access throw
 *      (e.g. `result.output.x` when output is undefined), an invalid child
 *      (e.g. a raw object), or any other render-time exception surfaces here as
 *      `phase:'render'`.
 *
 * LIMITATION: `renderToStaticMarkup` runs the INITIAL render only — hooks'
 * initial values run, but effects (useEffect/useLayoutEffect) and event handlers
 * do NOT fire. This intentionally scopes validation to the common authoring
 * mistakes (build errors, bad data access at render time, invalid children); it
 * cannot catch bugs that only manifest in an effect, a handler, or after a state
 * update in the browser.
 *
 * The SSR React globals are bound ONCE at module scope (idempotent — same
 * instance; harmless to leave set because they are custom keys, not `window`).
 *
 * Returns `{ ok: true }` when the tool ships no renderer (nothing to validate),
 * though callers should generally only invoke this when `customToolHasRenderer`
 * is true.
 */
export async function validateCustomToolRenderer(
  slug: string,
  result: unknown,
  args: unknown,
): Promise<RendererValidation> {
  // 1) BUILD
  let js: string | null
  try {
    js = await buildCustomToolRendererForSSR(slug)
  } catch (err) {
    return { ok: false, phase: 'build', error: err instanceof Error ? err.message : String(err) }
  }
  if (js === null) return { ok: true } // no renderer → nothing to validate

  // 2) RENDER — write the built ESM to a UNIQUE temp file so Bun's module cache
  // never hands back a stale module for a re-validated slug, dynamic-import it,
  // and statically render its default export with the renderer contract props.
  const tmpPath = join(toolDir(slug), `.ssr-validate-${randomUUID()}.mjs`)
  try {
    await writeFile(tmpPath, js, 'utf8')
    const mod = (await import(tmpPath)) as { default?: unknown }
    const Renderer = mod.default
    if (typeof Renderer !== 'function') {
      return { ok: false, phase: 'render', error: 'renderer.tsx must `export default` a React component (function)' }
    }
    renderToStaticMarkup(React.createElement(Renderer as React.FC<any>, { result, args, ui: UI_KIT }))
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Append a short stack tail to help the Agent locate the failing line.
    const stackTail =
      err instanceof Error && err.stack
        ? '\n' + err.stack.split('\n').slice(1, 4).join('\n')
        : ''
    return { ok: false, phase: 'render', error: `${message}${stackTail}` }
  } finally {
    await unlink(tmpPath).catch(() => {
      /* best-effort cleanup — a leftover temp file is harmless */
    })
  }
}

/** Test-only: clear the in-memory build caches (client + SSR). */
export function _resetRendererCache(): void {
  cache.clear()
  ssrCache.clear()
}
