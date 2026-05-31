import { useCallback, useEffect, useState } from 'react'
import { api } from '@/client/lib/api'

export interface EmailAccount {
  id: string
  slug: string
  name: string
  type: string
  emailAddress: string
  sendMode: 'direct' | 'approval'
  allowedKinIds: string[] | null
  isValid: boolean
  lastError: string | null
}

export interface EmailProviderInfo {
  type: string
  displayName: string
  usesOAuth: boolean
  /** Whether the operator has configured this provider's OAuth app credentials. */
  oauthConfigured: boolean
}

export function useEmailAccounts() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([])
  const [providers, setProviders] = useState<EmailProviderInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        api.get<{ accounts: EmailAccount[] }>('/email-accounts'),
        api.get<{ providers: EmailProviderInfo[] }>('/email-accounts/providers'),
      ])
      setAccounts(a.accounts)
      setProviders(p.providers)
    } catch {
      // Surfaced by callers via individual actions; list just stays empty.
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch])

  return { accounts, providers, isLoading, refetch }
}
