import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mail, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { api, getErrorMessage } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/components/ui/button'
import { Card, CardContent } from '@/client/components/ui/card'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { Label } from '@/client/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { useEmailAccounts, type EmailAccount, type EmailProviderInfo } from '@/client/hooks/useEmailAccounts'

export function EmailAccountsSettings() {
  const { t } = useTranslation()
  const { accounts, providers, isLoading, refetch } = useEmailAccounts()

  if (isLoading) return <SettingsListSkeleton count={2} />

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('settings.emailAccounts.description')}</p>

      <HelpPanel
        contentKey="settings.emailAccounts.help.content"
        bulletKeys={[
          'settings.emailAccounts.help.bullet1',
          'settings.emailAccounts.help.bullet2',
          'settings.emailAccounts.help.bullet3',
        ]}
        storageKey="help.emailAccounts.open"
      />

      {/* Connect a new account — one card per available provider. */}
      {providers.map((p) => (
        <ProviderConnectCard key={p.type} provider={p} onChange={refetch} />
      ))}

      {/* Connected accounts. */}
      {accounts.length === 0 ? (
        <EmptyState
          icon={Mail}
          title={t('settings.emailAccounts.empty')}
          description={t('settings.emailAccounts.emptyDescription')}
        />
      ) : (
        accounts.map((a) => <EmailAccountCard key={a.id} account={a} onChange={refetch} />)
      )}
    </div>
  )
}

function ProviderConnectCard({ provider, onChange }: { provider: EmailProviderInfo; onChange: () => void }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(!provider.oauthConfigured)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [connecting, setConnecting] = useState(false)

  // Prefill the client id (non-secret) when opening the credentials form.
  useEffect(() => {
    if (!editing || !provider.usesOAuth) return
    api
      .get<{ configured: boolean; clientId: string | null }>(`/email-accounts/oauth-config/${provider.type}`)
      .then((d) => {
        if (d.clientId) setClientId(d.clientId)
      })
      .catch(() => {})
  }, [editing, provider.type, provider.usesOAuth])

  const saveCreds = async () => {
    setSaving(true)
    try {
      await api.put(`/email-accounts/oauth-config/${provider.type}`, { clientId, clientSecret })
      toast.success(t('settings.emailAccounts.credsSaved'))
      setClientSecret('')
      setEditing(false)
      onChange()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const connect = async () => {
    setConnecting(true)
    try {
      const { authUrl } = await api.post<{ authUrl: string }>(`/email-accounts/connect/${provider.type}`)
      window.location.href = authUrl
    } catch (err) {
      toast.error(getErrorMessage(err))
      setConnecting(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Mail className="size-4 text-chart-4" />
            {provider.displayName}
          </div>
          {provider.oauthConfigured && !editing && (
            <Button size="sm" onClick={connect} disabled={connecting}>
              <Plus className="size-4" />
              {t('settings.emailAccounts.connect', { provider: provider.displayName })}
            </Button>
          )}
        </div>

        {editing ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t('settings.emailAccounts.oauthHelp')}</p>
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.emailAccounts.clientId')}</Label>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="…apps.googleusercontent.com" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.emailAccounts.clientSecret')}</Label>
              <PasswordInput value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={saveCreds} disabled={saving || !clientId || !clientSecret}>
                {t('common.save')}
              </Button>
              {provider.oauthConfigured && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            onClick={() => setEditing(true)}
          >
            {t('settings.emailAccounts.editCreds')}
          </button>
        )}
      </CardContent>
    </Card>
  )
}

function EmailAccountCard({ account, onChange }: { account: EmailAccount; onChange: () => void }) {
  const { t } = useTranslation()

  const setMode = async (mode: string) => {
    try {
      await api.patch(`/email-accounts/${account.id}`, { sendMode: mode })
      onChange()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  const disconnect = async () => {
    try {
      await api.delete(`/email-accounts/${account.id}`)
      toast.success(t('settings.emailAccounts.deleted'))
      onChange()
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn('size-2 shrink-0 rounded-full', account.isValid ? 'bg-success' : 'bg-destructive')} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{account.emailAddress}</p>
            <p className="truncate text-xs text-muted-foreground">
              {account.name} · {account.type}
            </p>
            {account.lastError && <p className="truncate text-xs text-destructive">{account.lastError}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={account.sendMode} onValueChange={(v) => void setMode(v)}>
            <SelectTrigger className="h-8 w-36 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="direct">{t('settings.emailAccounts.sendModeDirect')}</SelectItem>
              <SelectItem value="approval">{t('settings.emailAccounts.sendModeApproval')}</SelectItem>
            </SelectContent>
          </Select>
          <ConfirmDeleteButton
            onConfirm={() => void disconnect()}
            title={t('settings.emailAccounts.delete')}
            description={t('settings.emailAccounts.deleteConfirm')}
          />
        </div>
      </CardContent>
    </Card>
  )
}
