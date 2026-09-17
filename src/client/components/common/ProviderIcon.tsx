import { type ComponentType, type SVGProps, useState, useEffect, memo } from 'react'
import { Cpu } from 'lucide-react'

type SvgIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
type IconModule = { default: SvgIcon & { Color?: SvgIcon } }
type IconLoader = () => Promise<IconModule>

/** A react-icons component (different prop signature from Lobehub icons). */
type ReactIcon = ComponentType<{ size?: number | string; color?: string; className?: string }>
type ReactIconCollection = Record<string, ReactIcon>

/**
 * Whitelist of `@lobehub/icons` names Hivekeep's frontend ships. Providers
 * (built-in or plugin-contributed) declare `lobehubIcon` in their metadata
 * to opt into one of these. Anything outside the whitelist falls back to
 * the generic chip icon — the whitelist exists to keep the bundle's
 * dynamic-import graph predictable (each entry becomes a Vite chunk).
 *
 * To add a new icon: add an entry here and bump the SDK developer doc.
 * The full Lobehub catalogue is at https://icons.lobehub.com/.
 */
const LOBEHUB_LOADERS: Record<string, IconLoader> = {
  Anthropic: () => import('@lobehub/icons/es/Anthropic') as any,
  Claude: () => import('@lobehub/icons/es/Claude') as any,
  OpenAI: () => import('@lobehub/icons/es/OpenAI') as any,
  Gemini: () => import('@lobehub/icons/es/Gemini') as any,
  Mistral: () => import('@lobehub/icons/es/Mistral') as any,
  DeepSeek: () => import('@lobehub/icons/es/DeepSeek') as any,
  Minimax: () => import('@lobehub/icons/es/Minimax') as any,
  Kimi: () => import('@lobehub/icons/es/Kimi') as any,
  Groq: () => import('@lobehub/icons/es/Groq') as any,
  Together: () => import('@lobehub/icons/es/Together') as any,
  Fireworks: () => import('@lobehub/icons/es/Fireworks') as any,
  Ollama: () => import('@lobehub/icons/es/Ollama') as any,
  OpenRouter: () => import('@lobehub/icons/es/OpenRouter') as any,
  Cohere: () => import('@lobehub/icons/es/Cohere') as any,
  XAI: () => import('@lobehub/icons/es/XAI') as any,
  Voyage: () => import('@lobehub/icons/es/Voyage') as any,
  Jina: () => import('@lobehub/icons/es/Jina') as any,
  Tavily: () => import('@lobehub/icons/es/Tavily') as any,
  Perplexity: () => import('@lobehub/icons/es/Perplexity') as any,
  Replicate: () => import('@lobehub/icons/es/Replicate') as any,
  Stability: () => import('@lobehub/icons/es/Stability') as any,
  Fal: () => import('@lobehub/icons/es/Fal') as any,
  ElevenLabs: () => import('@lobehub/icons/es/ElevenLabs') as any,
}

/** Providers that have a `.Color` variant in their Lobehub module. */
const HAS_COLOR_VARIANT = new Set([
  'Anthropic', 'Claude', 'Gemini', 'Mistral', 'DeepSeek', 'Groq', 'Cohere',
  'OpenRouter', 'XAI', 'Replicate', 'Stability', 'Perplexity', 'Together',
])

/**
 * Provider-type → loader map. Built from useProviderTypes' fetch:
 * each `ProviderTypeInfo.lobehubIcon` is registered here at runtime so
 * `<ProviderIcon providerType={t} />` resolves without each caller
 * threading the Lobehub name through props.
 */
const ICON_LOADERS = new Map<string, { loader: IconLoader; lobehubName: string }>()

/**
 * Register a provider type's Lobehub icon. Called from useProviderTypes
 * for every entry that declares `lobehubIcon`. Idempotent. Silently
 * ignores names outside the whitelist.
 */
export function registerProviderLobehubIcon(providerType: string, lobehubName: string): void {
  const loader = LOBEHUB_LOADERS[lobehubName]
  if (!loader) return
  ICON_LOADERS.set(providerType, { loader, lobehubName })
}

// ─── React-icons fallback (used when no Lobehub icon is available) ──────────

/**
 * Dynamic-import switch for react-icons collections. The set mirrors
 * the `PluginIcon` resolver in chat/plugin-card so plugin authors and
 * built-in providers pick from the same catalogue. Vite needs a static
 * import path per case to pre-bundle the chunks correctly.
 */
function loadReactCollection(collection: string): Promise<ReactIconCollection> | null {
  let raw: Promise<unknown> | null = null
  switch (collection) {
    case 'ai':   raw = import('react-icons/ai'); break
    case 'bi':   raw = import('react-icons/bi'); break
    case 'bs':   raw = import('react-icons/bs'); break
    case 'fa':   raw = import('react-icons/fa'); break
    case 'fa6':  raw = import('react-icons/fa6'); break
    case 'fi':   raw = import('react-icons/fi'); break
    case 'hi':   raw = import('react-icons/hi'); break
    case 'hi2':  raw = import('react-icons/hi2'); break
    case 'io5':  raw = import('react-icons/io5'); break
    case 'lu':   raw = import('react-icons/lu'); break
    case 'md':   raw = import('react-icons/md'); break
    case 'pi':   raw = import('react-icons/pi'); break
    case 'ri':   raw = import('react-icons/ri'); break
    case 'si':   raw = import('react-icons/si'); break
    case 'tb':   raw = import('react-icons/tb'); break
    default:     return null
  }
  return raw as Promise<ReactIconCollection>
}

const REACT_ICON_LOADERS = new Map<string, { collection: string; componentName: string; brandColor?: string }>()
const reactCollectionCache = new Map<string, Promise<ReactIconCollection>>()
const reactComponentCache = new Map<string, ReactIcon>()

/**
 * Register a provider type's react-icons identifier (`"collection/Name"`).
 * Called from useProviderTypes for every entry that declares `reactIcon`.
 * Idempotent; silently ignores malformed ids and unknown collections.
 *
 * `brandColor` (optional, hex) is applied when the host requests the
 * coloured variant — react-icons SimpleIcons (and most other react-icons
 * sets) are monochrome, so without it the icon picks up the surface's
 * currentColor and looks washed out next to Lobehub's coloured set.
 */
export function registerProviderReactIcon(providerType: string, identifier: string, brandColor?: string): void {
  const [collection, componentName] = identifier.split('/')
  if (!collection || !componentName) return
  // Registration must stay pure: calling the loader here downloaded whole
  // icon collections for every known provider, even when none was displayed.
  if (!['ai', 'bi', 'bs', 'fa', 'fa6', 'fi', 'hi', 'hi2', 'io5', 'lu', 'md', 'pi', 'ri', 'si', 'tb'].includes(collection)) return
  REACT_ICON_LOADERS.set(providerType, { collection, componentName, ...(brandColor ? { brandColor } : {}) })
}

/** Cache resolved icon modules so re-renders don't re-import. */
const iconCache = new Map<string, SvgIcon & { Color?: SvgIcon }>()

interface ProviderIconProps {
  providerType: string
  className?: string
  /** 'mono' uses currentColor (default), 'color' uses brand colors / native Color variants */
  variant?: 'mono' | 'color'
}

export const ProviderIcon = memo(function ProviderIcon({ providerType, className, variant = 'mono' }: ProviderIconProps) {
  const entry = ICON_LOADERS.get(providerType)
  if (entry) {
    const cached = iconCache.get(providerType)
    if (cached) {
      return <ResolvedIcon icon={cached} lobehubName={entry.lobehubName} variant={variant} className={className} />
    }
    return <LazyIcon providerType={providerType} loader={entry.loader} lobehubName={entry.lobehubName} variant={variant} className={className} />
  }

  // Secondary fallback: react-icons. Used for brands not in the Lobehub
  // whitelist (Brave, Kagi, niche search/embedding providers, …).
  const reactEntry = REACT_ICON_LOADERS.get(providerType)
  if (reactEntry) {
    return (
      <LazyReactIcon
        providerType={providerType}
        collection={reactEntry.collection}
        componentName={reactEntry.componentName}
        color={variant === 'color' ? reactEntry.brandColor : undefined}
        className={className}
      />
    )
  }

  return <Cpu className={className} />
})

/** Renders an already-resolved icon */
function ResolvedIcon({ icon, lobehubName, variant, className }: {
  icon: SvgIcon & { Color?: SvgIcon }
  lobehubName: string
  variant: 'mono' | 'color'
  className?: string
}) {
  if (variant === 'color' && HAS_COLOR_VARIANT.has(lobehubName) && icon.Color) {
    const Icon = icon.Color
    return <Icon className={className} />
  }
  const Icon = icon
  return <Icon className={className} />
}

/** Lazy-loads an icon on mount, then renders it */
function LazyIcon({ providerType, loader, lobehubName, variant, className }: {
  providerType: string
  loader: IconLoader
  lobehubName: string
  variant: 'mono' | 'color'
  className?: string
}) {
  const [icon, setIcon] = useState<(SvgIcon & { Color?: SvgIcon }) | null>(null)

  useEffect(() => {
    let cancelled = false
    loader().then((mod) => {
      iconCache.set(providerType, mod.default)
      if (!cancelled) setIcon(mod.default)
    })
    return () => { cancelled = true }
  }, [providerType, loader])

  if (!icon) {
    // Placeholder with same dimensions to avoid layout shift
    return <Cpu className={className} style={{ opacity: 0.3 }} />
  }

  return <ResolvedIcon icon={icon} lobehubName={lobehubName} variant={variant} className={className} />
}

/** Lazy-loads a react-icons collection (cached per collection), then
 *  pulls the requested component out of it. Renders a same-size
 *  placeholder while the import resolves to avoid layout shift. */
function LazyReactIcon({ providerType, collection, componentName, color, className }: {
  providerType: string
  collection: string
  componentName: string
  color?: string
  className?: string
}) {
  const cacheKey = `${collection}/${componentName}`
  const [icon, setIcon] = useState<ReactIcon | null>(() => reactComponentCache.get(cacheKey) ?? null)

  useEffect(() => {
    if (icon) return
    let cancelled = false
    let promise = reactCollectionCache.get(collection)
    if (!promise) {
      const next = loadReactCollection(collection)
      if (!next) return
      promise = next
      reactCollectionCache.set(collection, promise)
    }
    promise
      .then((mod) => {
        if (cancelled) return
        const Comp = mod[componentName]
        if (!Comp) return
        reactComponentCache.set(cacheKey, Comp)
        setIcon(() => Comp)
      })
      .catch(() => {
        // Swallow — provider icon failure is purely cosmetic
      })
    return () => { cancelled = true }
  }, [collection, componentName, cacheKey, icon])

  if (!icon) {
    return <Cpu className={className} style={{ opacity: 0.3 }} />
  }

  const Icon = icon
  // react-icons SVGs take size via prop, but for parity with Lobehub
  // icons we let the className drive sizing (the existing Cpu fallback
  // already does this). Don't pass size — let CSS handle it. The
  // optional `color` prop drives the brand-tinted variant; when
  // omitted react-icons falls back to currentColor (matching the
  // mono Lobehub path).
  void providerType
  return <Icon className={className} {...(color ? { color } : {})} />
}
