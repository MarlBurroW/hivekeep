import { useEffect, useMemo, useState } from 'react'
import { api } from '@/client/lib/api'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import {
  PROVIDER_API_KEY_URLS,
  PROVIDER_CAPABILITIES,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_TYPES,
  PROVIDERS_WITHOUT_API_KEY,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from '@/shared/constants'
import type { ConfigField } from '@gezy/sdk'
import {
  registerProviderLobehubIcon,
  registerProviderReactIcon,
} from '@/client/components/common/ProviderIcon'

/** One entry returned by `GET /api/providers/types`. */
export interface ProviderTypeInfo {
  type: string
  displayName: string
  capabilities: string[]
  noApiKey: boolean
  optionalApiKey: boolean
  apiKeyUrl?: string
  /** Name of the icon to use from `@lobehub/icons` (e.g. "Mistral", "Claude"). */
  lobehubIcon?: string
  /** Fallback icon from react-icons, format "<collection>/<ComponentName>"
   *  (e.g. "si/SiBrave"). Used when lobehubIcon isn't set or isn't in
   *  the Lobehub whitelist. */
  reactIcon?: string
  /** Brand color (hex) applied when `reactIcon` is rendered with the
   *  coloured variant. Optional. */
  brandColor?: string
  source: 'builtin' | 'plugin'
  configSchema?: ConfigField[]
}

/**
 * Aggregated derived lookups the UI components consume. Matches the
 * build-time constants in `@/shared/constants` so call sites can drop
 * the imports and use the hook in place.
 *
 * Defaults to the build-time constants while the fetch is in flight,
 * so first paint never shows an empty picker.
 */
export interface ProviderTypesView {
  types: readonly string[]
  displayNames: Record<string, string>
  capabilities: Record<string, readonly string[]>
  apiKeyUrls: Record<string, string>
  withoutApiKey: readonly string[]
  withOptionalApiKey: readonly string[]
  configSchemas: Record<string, ConfigField[] | undefined>
  /** Raw list of every provider type entry, in API order (built-in first
   *  then plugin). Useful when the consumer wants to render with extra
   *  metadata like `source: 'plugin'`. */
  entries: ProviderTypeInfo[]
  /** True after the first successful fetch; false while we're still on
   *  the build-time fallback. Most consumers don't need to gate on it. */
  loaded: boolean
}

const FALLBACK: ProviderTypesView = {
  types: PROVIDER_TYPES,
  displayNames: PROVIDER_DISPLAY_NAMES,
  capabilities: PROVIDER_CAPABILITIES,
  apiKeyUrls: PROVIDER_API_KEY_URLS,
  withoutApiKey: PROVIDERS_WITHOUT_API_KEY,
  withOptionalApiKey: PROVIDERS_WITH_OPTIONAL_API_KEY,
  configSchemas: {},
  entries: [],
  loaded: false,
}

/**
 * Fetches the live provider type catalogue (built-ins + plugin-
 * contributed). Refreshes on `provider:metaChanged` SSE events so
 * activating / deactivating a plugin updates the picker immediately
 * without a page reload.
 *
 * Drop-in replacement for the build-time constants:
 *
 *   const { types, displayNames, withoutApiKey, ... } = useProviderTypes()
 *   const name = displayNames[type] ?? type
 */
export function useProviderTypes(): ProviderTypesView {
  const [entries, setEntries] = useState<ProviderTypeInfo[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = async () => {
    try {
      const data = await api.get<{ types: ProviderTypeInfo[] }>('/providers/types')
      setEntries(data.types)
      setLoaded(true)
      // Side-effect: register Lobehub icon names and react-icons ids
      // so <ProviderIcon> can resolve plugin-contributed provider types
      // without each caller having to thread the meta through props.
      for (const t of data.types) {
        if (t.lobehubIcon) registerProviderLobehubIcon(t.type, t.lobehubIcon)
        if (t.reactIcon) registerProviderReactIcon(t.type, t.reactIcon, t.brandColor)
      }
    } catch {
      // keep fallback
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  // Pick up plugin lifecycle changes live. We listen to both the
  // install/uninstall pair AND the enable/disable pair — `installed`
  // / `uninstalled` fire on the npm install path (when a freshly
  // fetched plugin gets activated for the first time), `enabled` /
  // `disabled` fire when the user toggles an already-installed
  // plugin. Subscribing only to enable/disable would miss
  // freshly-installed plugins, which is the bug the platforms picker
  // hit when twilio / teamspeak first landed.
  useSSE({
    'plugin:installed': () => { refresh() },
    'plugin:uninstalled': () => { refresh() },
    'plugin:enabled': () => { refresh() },
    'plugin:disabled': () => { refresh() },
    'plugin:autoDisabled': () => { refresh() },
  })

  useSSEResync(() => { refresh() })

  return useMemo<ProviderTypesView>(() => {
    if (!loaded || entries.length === 0) return FALLBACK

    const displayNames: Record<string, string> = {}
    const capabilities: Record<string, readonly string[]> = {}
    const apiKeyUrls: Record<string, string> = {}
    const withoutApiKey: string[] = []
    const withOptionalApiKey: string[] = []
    const configSchemas: Record<string, ConfigField[] | undefined> = {}

    for (const e of entries) {
      displayNames[e.type] = e.displayName
      capabilities[e.type] = e.capabilities
      if (e.apiKeyUrl) apiKeyUrls[e.type] = e.apiKeyUrl
      if (e.noApiKey) withoutApiKey.push(e.type)
      if (e.optionalApiKey) withOptionalApiKey.push(e.type)
      configSchemas[e.type] = e.configSchema
    }

    return {
      types: entries.map((e) => e.type),
      displayNames,
      capabilities,
      apiKeyUrls,
      withoutApiKey,
      withOptionalApiKey,
      configSchemas,
      entries,
      loaded: true,
    }
  }, [entries, loaded])
}
