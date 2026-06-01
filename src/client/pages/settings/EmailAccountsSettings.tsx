import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Mail, Plus, Check, X, Pencil, Copy, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api, getErrorMessage } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { SettingsListSkeleton } from '@/client/components/common/SettingsListSkeleton'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { useEmailAccounts, type EmailAccount, type EmailProviderInfo } from '@/client/hooks/useEmailAccounts'
import { usePendingEmailSends } from '@/client/hooks/usePendingEmailSends'
import type { PendingEmailSend } from '@/shared/types'

export function EmailAccountsSettings() {
  const { t } = useTranslation()
  const { accounts, providers, redirectUri, isLoading, refetch } = useEmailAccounts()
  const [addOpen, setAddOpen] = useState(false)

  if (isLoading) return <SettingsListSkeleton count={2} />

  const oauthProviders = providers.filter((p) => p.usesOAuth)

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('settings.emailAccounts.description')}</p>

      <PendingApprovals />

      <HelpPanel
        contentKey="settings.emailAccounts.help.content"
        bulletKeys={[
          'settings.emailAccounts.help.bullet1',
          'settings.emailAccounts.help.bullet2',
          'settings.emailAccounts.help.bullet3',
        ]}
        storageKey="help.emailAccounts.open"
      />

      {/* Global OAuth app configuration — one card per OAuth provider. */}
      {oauthProviders.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('settings.emailAccounts.appsTitle')}</p>
          {oauthProviders.map((p) => (
            <OAuthAppCard key={p.type} provider={p} redirectUri={redirectUri} onChange={refetch} />
          ))}
        </div>
      )}

      {/* Connected accounts. */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('settings.emailAccounts.accountsTitle')}</p>
        {accounts.length === 0 ? (
          <EmptyState
            icon={Mail}
            title={t('settings.emailAccounts.empty')}
            description={t('settings.emailAccounts.emptyDescription')}
            actionLabel={t('settings.emailAccounts.add')}
            onAction={() => setAddOpen(true)}
          />
        ) : (
          <>
            {accounts.map((a) => (
              <EmailAccountCard key={a.id} account={a} onChange={refetch} />
            ))}
            <Button variant="outline" className="w-full" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              {t('settings.emailAccounts.add')}
            </Button>
          </>
        )}
      </div>

      <AddEmailAccountDialog open={addOpen} onOpenChange={setAddOpen} providers={providers} onChange={refetch} />
    </div>
  )
}

/** Global OAuth app config for a provider (client id/secret + redirect URI).
 *  Lives on the main page — it's a one-time, account-independent setup. */
function OAuthAppCard({
  provider,
  redirectUri,
  onChange,
}: {
  provider: EmailProviderInfo
  redirectUri: string
  onChange: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)

  // Load the saved client id only when the modal opens.
  useEffect(() => {
    if (!open) return
    api
      .get<{ configured: boolean; clientId: string | null }>(`/email-accounts/oauth-config/${provider.type}`)
      .then((d) => {
        if (d.clientId) setClientId(d.clientId)
      })
      .catch(() => {})
  }, [open, provider.type])

  const saveCreds = async () => {
    setSaving(true)
    try {
      await api.put(`/email-accounts/oauth-config/${provider.type}`, { clientId, clientSecret })
      toast.success(t('settings.emailAccounts.credsSaved'))
      setClientSecret('')
      setOpen(false)
      onChange()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const copyRedirect = () => {
    navigator.clipboard
      .writeText(redirectUri)
      .then(() => toast.success(t('settings.emailAccounts.copied')))
      .catch(() => {})
  }

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderIcon providerType={provider.type} variant="color" className="size-4 shrink-0" />
          <span className="truncate text-sm font-medium">{provider.displayName}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {provider.oauthConfigured ? (
            <>
              <Badge variant="secondary" className="gap-1 text-[10px]">
                <Check className="size-3" />
                {t('settings.emailAccounts.appConfigured')}
              </Badge>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={t('settings.emailAccounts.editApp')}
                onClick={() => setOpen(true)}
              >
                <Pencil className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="border-warning/40 text-warning hover:text-warning"
              onClick={() => setOpen(true)}
            >
              <Pencil className="size-3.5" />
              {t('settings.emailAccounts.configureApp')}
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ProviderIcon providerType={provider.type} variant="color" className="size-4" />
              {t('settings.emailAccounts.oauthAppTitle', { provider: provider.displayName })}
            </DialogTitle>
            <DialogDescription>{t('settings.emailAccounts.oauthSetup')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {provider.consoleUrl && (
              <a
                href={provider.consoleUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {t('settings.emailAccounts.oauthConsoleLink', { provider: provider.displayName })}
                <ExternalLink className="size-3" />
              </a>
            )}

            <div className="space-y-1">
              <Label className="text-xs">{t('settings.emailAccounts.redirectUri')}</Label>
              <p className="text-[10px] text-muted-foreground">{t('settings.emailAccounts.redirectUriHelp')}</p>
              <div className="flex gap-1">
                <Input
                  readOnly
                  value={redirectUri}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  size="icon"
                  variant="outline"
                  className="shrink-0"
                  aria-label={t('settings.emailAccounts.copy')}
                  onClick={copyRedirect}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t('settings.emailAccounts.clientId')}</Label>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('settings.emailAccounts.clientSecret')}</Label>
              <PasswordInput
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={
                  provider.oauthConfigured ? t('settings.emailAccounts.secretKeep') : undefined
                }
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={saveCreds}
                disabled={saving || !clientId || (!provider.oauthConfigured && !clientSecret)}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function AddEmailAccountDialog({
  open,
  onOpenChange,
  providers,
  onChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  providers: EmailProviderInfo[]
  onChange: () => void
}) {
  const { t } = useTranslation()
  const [type, setType] = useState<string>('')

  useEffect(() => {
    if (open && providers[0]) setType((prev) => prev || providers[0]!.type)
  }, [open, providers])

  const provider = providers.find((p) => p.type === type) ?? providers[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.emailAccounts.addTitle')}</DialogTitle>
          <DialogDescription>{t('settings.emailAccounts.addDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('settings.emailAccounts.provider')}</Label>
            <Select value={provider?.type ?? ''} onValueChange={setType}>
              <SelectTrigger className="w-full">
                {/* SelectValue renders the selected item's content (logo + name);
                    no explicit icon here or it'd show twice. */}
                <SelectValue placeholder={t('settings.emailAccounts.provider')} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.type} value={p.type}>
                    <span className="flex items-center gap-2">
                      <ProviderIcon providerType={p.type} variant="color" className="size-4" />
                      {p.displayName}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {provider && (
            <ConnectStep provider={provider} onChange={onChange} onClose={() => onOpenChange(false)} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The connect action in the Add dialog. OAuth providers connect via redirect
 *  once their app is configured (on the main page); non-OAuth providers (IMAP)
 *  render a credentials form validated server-side before the account is saved. */
function ConnectStep({
  provider,
  onChange,
  onClose,
}: {
  provider: EmailProviderInfo
  onChange: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [connecting, setConnecting] = useState(false)
  const [fields, setFields] = useState<Record<string, string>>({})

  // Reset the form when switching providers.
  useEffect(() => {
    setFields({})
  }, [provider.type])

  // The OAuth connect navigates away via window.location; if the user comes
  // back (browser Back / bfcache restore), the frozen `connecting=true` would
  // leave the button stuck disabled. Reset it whenever the page is shown.
  useEffect(() => {
    const reset = () => setConnecting(false)
    window.addEventListener('pageshow', reset)
    return () => window.removeEventListener('pageshow', reset)
  }, [])

  const connectOAuth = async () => {
    setConnecting(true)
    try {
      const { authUrl } = await api.post<{ authUrl: string }>(`/email-accounts/connect/${provider.type}`)
      window.location.href = authUrl
    } catch (err) {
      toast.error(getErrorMessage(err))
      setConnecting(false)
    }
  }

  const connectConfig = async () => {
    setConnecting(true)
    try {
      await api.post(`/email-accounts/connect-config/${provider.type}`, { fields })
      toast.success(t('settings.emailAccounts.connected', { provider: provider.displayName }))
      onChange()
      onClose()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setConnecting(false)
    }
  }

  if (provider.usesOAuth) {
    if (!provider.oauthConfigured) {
      return (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
          {t('settings.emailAccounts.configureAppFirst', { provider: provider.displayName })}
        </p>
      )
    }
    return (
      <Button className="w-full" onClick={connectOAuth} disabled={connecting}>
        <Plus className="size-4" />
        {t('settings.emailAccounts.connect', { provider: provider.displayName })}
      </Button>
    )
  }

  // Non-OAuth (IMAP/SMTP): a form built from the provider's configSchema.
  const missingRequired = provider.configSchema.some((f) => f.required && !fields[f.key]?.trim())

  return (
    <div className="space-y-3">
      {provider.configSchema.map((field) => {
        const isSecret = field.type === 'secret'
        const Tag = isSecret ? PasswordInput : Input
        return (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={`imap-${field.key}`} className="text-xs">
              {field.label}
              {field.required && <span className="ml-1 text-destructive">*</span>}
            </Label>
            <Tag
              id={`imap-${field.key}`}
              value={fields[field.key] ?? ''}
              placeholder={'placeholder' in field ? field.placeholder : undefined}
              onChange={(e) => setFields((v) => ({ ...v, [field.key]: e.target.value }))}
            />
            {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
          </div>
        )
      })}
      <Button className="w-full" onClick={connectConfig} disabled={connecting || missingRequired}>
        <Plus className="size-4" />
        {t('settings.emailAccounts.connect', { provider: provider.displayName })}
      </Button>
    </div>
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
          <div className="relative shrink-0">
            <ProviderIcon providerType={account.type} variant="color" className="size-5" />
            <span
              className={cn(
                'absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-card',
                account.isValid ? 'bg-success' : 'bg-destructive',
              )}
            />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{account.emailAddress}</p>
            <p className="truncate text-xs text-muted-foreground">{account.name}</p>
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

function PendingApprovals() {
  const { t } = useTranslation()
  const { pending, approve, reject } = usePendingEmailSends()
  if (pending.length === 0) return null
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-warning">
        {t('settings.emailAccounts.pendingTitle', { count: pending.length })}
      </p>
      {pending.map((p) => (
        <PendingCard key={p.id} item={p} onApprove={approve} onReject={reject} />
      ))}
    </div>
  )
}

function PendingCard({
  item,
  onApprove,
  onReject,
}: {
  item: PendingEmailSend
  onApprove: (id: string) => Promise<void>
  onReject: (id: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  const run = async (fn: (id: string) => Promise<void>) => {
    setBusy(true)
    try {
      await fn(item.id)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-warning/40">
      <CardContent className="space-y-1.5 p-3">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">
            {item.kinName} · {item.accountEmail}
          </span>
        </div>
        <p className="text-sm font-medium">{item.subject || '(no subject)'}</p>
        <p className="truncate text-xs text-muted-foreground">
          {t('settings.emailAccounts.pendingTo')}: {item.to.join(', ')}
        </p>
        <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{item.body}</p>
        <div className="flex gap-2 pt-1">
          <Button size="sm" onClick={() => void run(onApprove)} disabled={busy}>
            <Check className="size-4" />
            {t('settings.emailAccounts.approve')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void run(onReject)} disabled={busy}>
            <X className="size-4" />
            {t('settings.emailAccounts.reject')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
