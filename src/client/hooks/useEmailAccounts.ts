import { useCallback, useEffect, useState } from 'react'
import type { ConfigField } from '@gezy/sdk'
import { api } from '@/client/lib/api'
import { registerProviderReactIcon } from '@/client/components/common/ProviderIcon'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'

/** A connected account, surfaced by the unified read model. One account may
 *  carry several capabilities (email + contacts + …). */
export interface EmailAccount {
  id: string
  slug: string
  name: string
  type: string
  /** Display label — email address or account label. */
  label: string
  capabilities: string[]
  /** Email send mode when the account serves email; null otherwise. */
  sendMode: 'direct' | 'approval' | null
  allowedAgentIds: string[] | null
  isValid: boolean
  lastError: string | null
}

export interface EmailProviderInfo {
  type: string
  displayName: string
  usesOAuth: boolean
  /** Whether the operator has configured this provider's OAuth app credentials. */
  oauthConfigured: boolean
  /** react-icons identifier ("si/SiGmail") + brand color for the provider logo. */
  reactIcon: string | null
  brandColor: string | null
  /** Where the operator sets up the OAuth app (Google Cloud / Azure portal). */
  consoleUrl: string | null
  /** Capabilities this provider can serve (email / contacts / calendar). */
  capabilities: string[]
  /** Convenience: capabilities includes 'contacts'. */
  supportsContacts: boolean
  /** Convenience: capabilities includes 'calendar'. */
  supportsCalendar: boolean
  /** For non-OAuth providers (IMAP / CardDAV): the fields to render in the Add
   *  dialog. Empty for OAuth providers. */
  configSchema: ConfigField[]
}

interface RawProvider {
  type: string
  displayName: string
  usesOAuth: boolean
  oauthConfigured: boolean
  reactIcon: string | null
  brandColor: string | null
  consoleUrl: string | null
  capabilities: string[]
  configSchema: ConfigField[]
}

export function useEmailAccounts() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([])
  const [providers, setProviders] = useState<EmailProviderInfo[]>([])
  const [redirectUri, setRedirectUri] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        api.get<{ accounts: EmailAccount[] }>('/connected-accounts'),
        api.get<{ providers: RawProvider[]; redirectUri: string }>('/connected-accounts/providers'),
      ])
      setRedirectUri(p.redirectUri)
      for (const prov of p.providers) {
        if (prov.reactIcon) registerProviderReactIcon(prov.type, prov.reactIcon, prov.brandColor ?? undefined)
      }
      setAccounts(a.accounts)
      setProviders(
        p.providers.map((prov) => ({
          ...prov,
          supportsContacts: prov.capabilities.includes('contacts'),
          supportsCalendar: prov.capabilities.includes('calendar'),
        })),
      )
    } catch {
      // Surfaced by callers via individual actions; list just stays empty.
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch])

  useSSE({
    'email-account:created': () => { void refetch() },
    'email-account:updated': () => { void refetch() },
    'email-account:deleted': () => { void refetch() },
    'connected-account:created': () => { void refetch() },
    'connected-account:updated': () => { void refetch() },
    'connected-account:deleted': () => { void refetch() },
  })

  useSSEResync(refetch)

  return { accounts, providers, redirectUri, isLoading, refetch }
}
