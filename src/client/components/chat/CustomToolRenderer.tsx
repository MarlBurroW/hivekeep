import { Component, Suspense, lazy, type ComponentType, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { JsonViewer } from '@/client/components/common/JsonViewer'
import { UI_KIT, type CustomToolUiKit } from '@/shared/custom-tool-ui-kit'
import { useCustomToolMeta } from '@/client/lib/custom-tool-names'
import i18n from '@/client/lib/i18n'

/**
 * Renders a custom tool's optional, server-bundled React result renderer in the
 * EXPANDED tool-call view.
 *
 * The renderer module is fetched at runtime from
 * `/api/custom-tools/:slug/renderer.js?v=<version>`. It shares the host's single
 * React instance (window.__GEZY_REACT__, set in main.tsx) so hooks work and it
 * inherits the app theme via cascading `--color-*` CSS variables. It receives
 * `{ result, args, ui }` where `ui` is the themed primitives kit.
 *
 * Instant, no spinner flash: the lazy component is cached MODULE-LEVEL keyed by
 * `slug:version` (see `lazyCache` / `getLazyRenderer`). Every tool-call for the
 * same slug+version reuses the SAME lazy component, so React does NOT re-suspend
 * after the first load — no spinner flash on subsequent tool-calls. The version
 * is the renderer file's mtime (from the reactive names store): stable → cached,
 * and an edit changes the mtime → a new key → a fresh load (auto cache-bust).
 * `prefetchCustomToolRenderers()` (custom-tool-names.ts) warms this same cache on
 * load so the genuine cold-load spinner is hidden in practice too.
 *
 * Resilience: a tiny spinner shows while the module loads; an ErrorBoundary
 * catches any load/render error and falls back to the default JsonViewer so a
 * broken renderer NEVER crashes the chat. The boundary remounts on slug/version
 * change.
 *
 * Threat model: host-context renderers run with full host privileges (no
 * isolation) — acceptable because custom tools are trusted (user/Agent-authored,
 * self-hosted) and this is for result DISPLAY only.
 */

interface RemoteRendererProps {
  result: unknown
  args: unknown
  ui: CustomToolUiKit
}

interface CustomToolRendererProps {
  slug: string
  result: unknown
  args: unknown
  /**
   * Optional explicit cache-buster. When set, it is used as the version (folded
   * into the `?v=` URL + lazy/boundary key) INSTEAD of the file-mtime version
   * from the names store. The modal playground passes its own monotonic counter
   * so an in-place renderer edit shows a fresh build immediately. Omitted in chat
   * usage → the file-mtime version is used (stable/cached, edit-bustable).
   */
  bust?: string | number
}

/**
 * Module-level cache of lazy renderer components, keyed by `slug:version`. Shared
 * across ALL instances AND with `prefetchCustomToolRenderers()` — that is what
 * kills the per-instance Suspense spinner: the second (and every later) tool-call
 * for the same slug+version gets the already-resolved lazy, so React renders it
 * synchronously without re-suspending.
 *
 * Bust correctness: the version is the renderer file's mtime, so editing a
 * renderer changes the mtime → a new key → a brand-new lazy (fresh import of the
 * freshly built module). Stale lazies for old versions simply age out unused.
 */
const lazyCache = new Map<string, ComponentType<RemoteRendererProps>>()

/**
 * Per-page-load nonce, mixed into the EXPLICIT-bust (playground) version only.
 * The playground bust is a small monotonic counter that resets to its initial
 * value on a full page reload; since `?v=` URLs are now served `immutable`, a
 * repeated `?v=1` after a reload would otherwise hit a stale browser-cached build.
 * Mixing in this nonce makes every playground build URL unique across reloads → a
 * fresh fetch every edit. The chat's file-mtime version is left untouched so it
 * stays stably cacheable (content-addressed by mtime).
 */
const SESSION_NONCE = Math.random().toString(36).slice(2, 10)

/** Version-addressed module URL for a tool's renderer. Always carries `?v=` so it
 *  is content-addressed (the server serves it `immutable`). The specifier is built
 *  at runtime (not a static literal) so Rollup leaves it as a runtime import. */
function rendererUrl(slug: string, version: string | number): string {
  return (
    ['/api', 'custom-tools', encodeURIComponent(slug), 'renderer.js'].join('/') +
    `?v=${encodeURIComponent(String(version))}`
  )
}

/**
 * Return the cached lazy renderer for `slug:version`, creating + storing one on a
 * miss. `/* @vite-ignore *​/` silences Vite's dev transform of the runtime import.
 */
export function getLazyRenderer(
  slug: string,
  version: string | number,
): ComponentType<RemoteRendererProps> {
  const key = `${slug}:${version}`
  const cached = lazyCache.get(key)
  if (cached) return cached
  const url = rendererUrl(slug, version)
  const Remote = lazy(
    () => import(/* @vite-ignore */ url) as Promise<{ default: ComponentType<RemoteRendererProps> }>,
  )
  lazyCache.set(key, Remote)
  return Remote
}

/**
 * Warm a renderer ahead of any tool-call: ensure the shared lazy exists for this
 * `slug:version` AND trigger the underlying module import so the browser's ESM
 * cache (and the server build) are primed. Because the URL is identical to the one
 * `getLazyRenderer`'s lazy imports, the browser dedupes to a single fetch — when
 * React.lazy later imports it, it resolves from the warm module cache (no network
 * → no visible spinner). Errors are swallowed (a broken renderer still falls back
 * to the JsonViewer at render time via the ErrorBoundary).
 */
export function prefetchRenderer(slug: string, version: string | number): void {
  // Populate the shared cache so chat reuses the SAME lazy instance.
  getLazyRenderer(slug, version)
  // Kick off the actual module load to warm the browser/server caches.
  void (import(/* @vite-ignore */ rendererUrl(slug, version)) as Promise<unknown>).catch(() => {
    /* swallow: render-time ErrorBoundary handles a genuinely broken renderer */
  })
}

/** Error boundary that falls back to a raw JSON dump of the result. Reset on
 *  slug/version change via the `key` prop (changing it remounts the boundary). */
class RendererErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  override render() {
    if (this.state.error) return this.props.fallback
    return this.props.children
  }
}

function RendererFallback({ result, args }: { result: unknown; args: unknown }) {
  const t = i18n.t.bind(i18n)
  return (
    <>
      <JsonViewer data={args} label={t('tools.viewer.input')} maxHeight="max-h-40" />
      {result !== undefined && (
        <JsonViewer data={result} label={t('tools.viewer.output')} maxHeight="max-h-60" />
      )}
    </>
  )
}

export function CustomToolRenderer({ slug, result, args, bust }: CustomToolRendererProps) {
  // Version selection:
  //  - explicit `bust` (modal playground) wins → immediate fresh load on edit;
  //  - otherwise the file-mtime version from the reactive names store. Reading it
  //    here makes the chat reactive: refreshCustomToolNames() after a save updates
  //    rendererVersion → a new key → a fresh lazy, with no change to callers.
  const meta = useCustomToolMeta(`custom_${slug}`)
  // Explicit bust (playground) → unique-per-load value so the immutable browser
  // cache never serves a stale build across reloads; chat → the file-mtime version
  // (content-addressed, stably cacheable, edit-bustable via the names store).
  const version =
    bust !== undefined && bust !== '' ? `pg-${SESSION_NONCE}-${bust}` : (meta.rendererVersion ?? 0)

  // Shared, module-level lazy keyed by slug+version: same key → SAME component →
  // no re-suspend → no spinner flash after the first (cold) load.
  const Remote = getLazyRenderer(slug, version)

  return (
    <RendererErrorBoundary
      key={`${slug}:${version}`}
      fallback={<RendererFallback result={result} args={args} />}
    >
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-4 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        }
      >
        <Remote result={result} args={args} ui={UI_KIT} />
      </Suspense>
    </RendererErrorBoundary>
  )
}
