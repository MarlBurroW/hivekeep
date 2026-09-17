import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage } from '@/client/lib/api'
import { useProviders } from '@/client/hooks/useProviders'
import { useAgents } from '@/client/hooks/useAgents'
import { isUserAgent } from '@/shared/agent-kind'
import { useSSE } from '@/client/hooks/useSSE'

/**
 * Centralized setup-checklist state.
 *
 * Aggregates three live data sources:
 *  - configured providers (capability availability)
 *  - default-models settings (which provider/model is the default for
 *    each family)
 *  - existing agents count
 *
 * Combined with the persisted `dismissed_setup_items` list from
 * app_settings, this produces a flat array of items the UI can render
 * in any layout (inline empty-state, navbar popover, Settings reactivation
 * panel). Each item carries its own severity + a stable id so the
 * dismiss/restore endpoints can target them without depending on
 * positional indices.
 *
 * Item ids are STABLE STRINGS — once landed, never rename. The
 * dismissed list in production DB references them verbatim.
 */

export type SetupItemId =
  | 'add_llm_provider'
  | 'set_default_llm'
  | 'add_embedding_provider'
  | 'add_image_provider'
  | 'add_search_provider'
  | 'add_voice_provider'
  | 'create_first_agent'

export type SetupItemSeverity = 'required' | 'recommended' | 'optional'

/** What an item points the user toward when they click 'Configure'. */
export interface SetupItemTarget {
  /** Settings section id (e.g. 'providers', 'models'). */
  section?: string
  /** True when the action is 'create an Agent' rather than 'open settings'. */
  createAgent?: boolean
}

export interface SetupItem {
  id: SetupItemId
  severity: SetupItemSeverity
  isDone: boolean
  isDismissed: boolean
  target: SetupItemTarget
}

interface DefaultModelsResponse {
  defaultLlmProviderId: string | null
  defaultImageProviderId: string | null
  defaultSearchProviderId: string | null
  defaultTtsProviderId: string | null
  defaultSttProviderId: string | null
}

/** Static definition of each item — severity + how to compute done +
 *  where to send the user when they want to act. Item order here is
 *  the order shown in the UI. */
const ITEM_DEFINITIONS: Array<{
  id: SetupItemId
  severity: SetupItemSeverity
  target: SetupItemTarget
  isDone: (state: {
    providers: Array<{ capabilities: string[]; isValid: boolean }>
    defaults: DefaultModelsResponse | null
    agentCount: number
  }) => boolean
}> = [
  {
    id: 'add_llm_provider',
    severity: 'required',
    target: { section: 'providers' },
    isDone: ({ providers }) =>
      providers.some((p) => p.isValid && p.capabilities.includes('llm')),
  },
  {
    id: 'set_default_llm',
    severity: 'recommended',
    target: { section: 'models' },
    isDone: ({ defaults }) => !!defaults?.defaultLlmProviderId,
  },
  {
    id: 'add_embedding_provider',
    severity: 'optional',
    target: { section: 'providers' },
    isDone: ({ providers }) =>
      providers.some((p) => p.isValid && p.capabilities.includes('embedding')),
  },
  {
    id: 'add_image_provider',
    severity: 'optional',
    target: { section: 'providers' },
    isDone: ({ providers }) =>
      providers.some((p) => p.isValid && p.capabilities.includes('image')),
  },
  {
    id: 'add_search_provider',
    severity: 'optional',
    target: { section: 'providers' },
    isDone: ({ providers }) =>
      providers.some((p) => p.isValid && p.capabilities.includes('search')),
  },
  {
    id: 'add_voice_provider',
    severity: 'optional',
    target: { section: 'providers' },
    isDone: ({ providers }) =>
      providers.some(
        (p) => p.isValid && (p.capabilities.includes('tts') || p.capabilities.includes('stt')),
      ),
  },
  {
    id: 'create_first_agent',
    severity: 'recommended',
    target: { createAgent: true },
    isDone: ({ agentCount }) => agentCount > 0,
  },
]

interface UseSetupChecklistResult {
  items: SetupItem[]
  /** True until the initial fetch of dismissed list + defaults completes.
   *  UI should hide / show a skeleton during this window so it doesn't
   *  flash 'all done' before real state arrives. */
  isLoading: boolean
  /** Items that are not yet done AND not dismissed — the actionable
   *  set the navbar badge counts. */
  pendingCount: number
  /** True when every item is either done or dismissed. Drives the
   *  'hide the button' decision. */
  isComplete: boolean
  dismissItem: (id: SetupItemId) => Promise<void>
  restoreItem: (id: SetupItemId) => Promise<void>
  refetch: () => Promise<void>
}

export function useSetupChecklist(): UseSetupChecklistResult {
  const { allProviders } = useProviders()
  const { agents } = useAgents()
  const [defaults, setDefaults] = useState<DefaultModelsResponse | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const fetchAll = useCallback(async () => {
    try {
      const [defaultsRes, dismissedRes] = await Promise.all([
        api.get<DefaultModelsResponse>('/settings/default-models'),
        api.get<{ items: string[] }>('/settings/dismissed-setup-items'),
      ])
      setDefaults(defaultsRes)
      setDismissed(dismissedRes.items)
    } catch (err) {
      // Non-blocking — checklist degrades gracefully when these fetches
      // fail (just shows everything as not-done). The console swallow
      // is intentional; we don't want to throw a toast for what's
      // essentially a non-critical UI panel.
      void getErrorMessage(err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // Re-fetch on plugin lifecycle changes — newly-installed plugins can
  // add provider types, which changes which capabilities are reachable.
  // `settings:defaults-updated` covers default-model writes (set_default_llm
  // item flips done without it).
  useSSE({
    'plugin:installed': () => fetchAll(),
    'plugin:uninstalled': () => fetchAll(),
    'plugin:enabled': () => fetchAll(),
    'plugin:disabled': () => fetchAll(),
    'plugin:autoDisabled': () => fetchAll(),
    'provider:created': () => fetchAll(),
    'provider:updated': () => fetchAll(),
    'provider:deleted': () => fetchAll(),
    'settings:defaults-updated': () => fetchAll(),
  })

  const items = useMemo<SetupItem[]>(() => {
    const validProviders = allProviders.map((p) => ({
      capabilities: p.capabilities,
      isValid: p.isValid,
    }))
    const dismissedSet = new Set(dismissed)
    return ITEM_DEFINITIONS.map((def) => ({
      id: def.id,
      severity: def.severity,
      target: def.target,
      isDone: def.isDone({ providers: validProviders, defaults, agentCount: agents.filter(isUserAgent).length }),
      isDismissed: dismissedSet.has(def.id),
    }))
  }, [allProviders, defaults, dismissed, agents])

  const pendingCount = items.filter((i) => i.severity !== 'optional' && !i.isDone && !i.isDismissed).length
  const isComplete = items.every((i) => i.severity === 'optional' || i.isDone || i.isDismissed)

  const dismissItem = useCallback(async (id: SetupItemId) => {
    try {
      const res = await api.post<{ items: string[] }>(
        `/settings/dismissed-setup-items/${encodeURIComponent(id)}`,
        {},
      )
      setDismissed(res.items)
    } catch (err) {
      void getErrorMessage(err)
    }
  }, [])

  const restoreItem = useCallback(async (id: SetupItemId) => {
    try {
      const res = await api.delete<{ items: string[] }>(
        `/settings/dismissed-setup-items/${encodeURIComponent(id)}`,
      )
      setDismissed(res.items)
    } catch (err) {
      void getErrorMessage(err)
    }
  }, [])

  return {
    items,
    isLoading,
    pendingCount,
    isComplete,
    dismissItem,
    restoreItem,
    refetch: fetchAll,
  }
}
