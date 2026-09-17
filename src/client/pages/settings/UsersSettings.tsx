import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Avatar, AvatarImage, AvatarFallback } from '@/client/components/ui/avatar'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import { Input } from '@/client/components/ui/input'
import { UserPlus, Copy, Trash2, Clock, CheckCircle2, XCircle, Users, ShieldCheck, ShieldOff } from 'lucide-react'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { EmptyState } from '@/client/components/common/EmptyState'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { ListToolbar } from '@/client/components/common/ListToolbar'
import { api, toastError, getErrorMessage } from '@/client/lib/api'
import { useListControls } from '@/client/hooks/useListControls'
import { LIST_FILTER_THRESHOLD } from '@/shared/constants'
import { useAuth } from '@/client/hooks/useAuth'
import type { UserSummary, InvitationSummary } from '@/shared/types'

export function UsersSettings() {
  const { t } = useTranslation()
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<UserSummary[]>([])
  const [invitations, setInvitations] = useState<InvitationSummary[]>([])
  const [deletingUser, setDeletingUser] = useState<UserSummary | null>(null)
  const [changingRole, setChangingRole] = useState<{ user: UserSummary; to: 'admin' | 'member' } | null>(null)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteLabel, setInviteLabel] = useState('')
  const [inviteExpiry, setInviteExpiry] = useState(7)
  const [inviteCreating, setInviteCreating] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [revealedLink, setRevealedLink] = useState<string | null>(null)
  const [revokingInvitation, setRevokingInvitation] = useState<InvitationSummary | null>(null)

  const fetchUsers = useCallback(async () => {
    try {
      const data = await api.get<{ users: UserSummary[] }>('/users')
      setUsers(data.users)
    } catch {
      // Ignore
    }
  }, [])

  const fetchInvitations = useCallback(async () => {
    try {
      const data = await api.get<{ invitations: InvitationSummary[] }>('/invitations')
      setInvitations(data.invitations)
    } catch {
      // Ignore
    }
  }, [])

  useEffect(() => {
    fetchUsers()
    fetchInvitations()
  }, [fetchUsers, fetchInvitations])

  const handleDeleteUser = async () => {
    if (!deletingUser) return
    try {
      await api.delete(`/users/${deletingUser.id}`)
      await fetchUsers()
      toast.success(t('settings.users.deleted'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setDeletingUser(null)
    }
  }

  const handleChangeRole = async () => {
    if (!changingRole) return
    try {
      await api.patch(`/users/${changingRole.user.id}/role`, { role: changingRole.to })
      await fetchUsers()
      toast.success(t('settings.users.roleUpdated'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setChangingRole(null)
    }
  }

  const handleCreateInvitation = async () => {
    setInviteCreating(true)
    setInviteError(null)
    try {
      const data = await api.post<{ invitation: { url: string } }>('/invitations', {
        label: inviteLabel || undefined,
        expiresInDays: inviteExpiry,
      })
      await fetchInvitations()
      setInviteOpen(false)
      setInviteLabel('')
      setInviteExpiry(7)
      setRevealedLink(data.invitation.url)
      toast.success(t('settings.users.invitations.created'))
    } catch (err: unknown) {
      setInviteError(getErrorMessage(err))
    } finally {
      setInviteCreating(false)
    }
  }

  const handleRevokeInvitation = async () => {
    if (!revokingInvitation) return
    try {
      await api.delete(`/invitations/${revokingInvitation.id}`)
      await fetchInvitations()
      toast.success(t('settings.users.invitations.revoked'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setRevokingInvitation(null)
    }
  }

  const usersList = useListControls(users, {
    searchText: (u) => [u.firstName, u.lastName, u.pseudonym, u.email],
  })

  const { copy: copyToClipboard } = useCopyToClipboard()

  const getInvitationStatus = (inv: InvitationSummary): 'active' | 'used' | 'expired' => {
    if (inv.usedAt) return 'used'
    if (inv.expiresAt < Date.now()) return 'expired'
    return 'active'
  }

  const formatDate = (ts: number) => {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <div className="space-y-6">
      {/* Description */}
      <p className="text-sm text-muted-foreground">
        {t('settings.users.description')}
      </p>

      <HelpPanel
        contentKey="settings.users.help.content"
        bulletKeys={[
          'settings.users.help.bullet1',
          'settings.users.help.bullet2',
          'settings.users.help.bullet3',
        ]}
        storageKey="help.users.open"
      />

      {/* Users list */}
      <div className="space-y-3">
        {users.length === 0 && (
          <EmptyState
            icon={Users}
            title={t('settings.users.empty')}
            description={t('settings.users.emptyDescription')}
          />
        )}

        {users.length >= LIST_FILTER_THRESHOLD && (
          <ListToolbar
            query={usersList.query}
            onQueryChange={usersList.setQuery}
            placeholder={t('settings.users.search', 'Search users...')}
            onClear={() => usersList.setQuery('')}
            active={usersList.isSearching}
          />
        )}

        {users.length > 0 && usersList.total === 0 && (
          <EmptyState minimal title={t('common.noResults', 'No results found')} />
        )}

        {usersList.filtered.map((u) => {
          const isSelf = u.id === currentUser?.id
          return (
            <div
              key={u.id}
              className="flex items-center gap-3 rounded-xl border bg-card p-3"
            >
              <Avatar className="size-10">
                {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.name} />}
                <AvatarFallback className="text-xs">
                  {u.firstName?.[0]}{u.lastName?.[0]}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm truncate">{u.firstName} {u.lastName}</span>
                  <span className="text-xs text-muted-foreground">@{u.pseudonym}</span>
                  {isSelf && (
 <Badge variant="outline" size="xs">
                      you
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {u.email}
                  {u.createdAt && (
                    <span className="ml-2">&middot; {t('settings.users.joined')} {formatDate(u.createdAt)}</span>
                  )}
                </div>
              </div>
              {u.role === 'admin' && (
                <Badge variant="default" size="xs">
                  <ShieldCheck className="size-3 mr-0.5" />
                  {t('settings.users.roleAdmin')}
                </Badge>
              )}
 <Badge variant="secondary" size="xs" className="uppercase">
                {u.language}
              </Badge>
              {!isSelf && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  title={u.role === 'admin' ? t('settings.users.demote') : t('settings.users.promote')}
                  onClick={() => setChangingRole({ user: u, to: u.role === 'admin' ? 'member' : 'admin' })}
                >
                  {u.role === 'admin' ? <ShieldOff className="size-4" /> : <ShieldCheck className="size-4" />}
                </Button>
              )}
              {!isSelf && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeletingUser(u)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {/* Invitations section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t('settings.users.invitations.title')}</h3>
        </div>

        {invitations.length === 0 && (
          <EmptyState minimal title={t('settings.users.invitations.empty')} />
        )}

        {invitations.map((inv) => {
          const status = getInvitationStatus(inv)
          return (
            <div
              key={inv.id}
              className="flex items-center gap-3 rounded-xl border bg-card p-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {inv.label || inv.token.slice(0, 12) + '...'}
                  </span>
                  {status === 'active' && (
 <Badge variant="default" size="xs">
                      <Clock className="size-3 mr-0.5" />
                      {t('settings.users.invitations.status.active')}
                    </Badge>
                  )}
                  {status === 'used' && (
 <Badge variant="secondary" size="xs">
                      <CheckCircle2 className="size-3 mr-0.5" />
                      {t('settings.users.invitations.status.used')}
                    </Badge>
                  )}
                  {status === 'expired' && (
 <Badge variant="outline" size="xs" className="text-muted-foreground">
                      <XCircle className="size-3 mr-0.5" />
                      {t('settings.users.invitations.status.expired')}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('settings.users.invitations.createdBy', { name: inv.creatorName })}
                  {status === 'used' && inv.usedByName && (
                    <span className="ml-2">&middot; {t('settings.users.invitations.usedBy', { name: inv.usedByName })}</span>
                  )}
                  {status === 'active' && (
                    <span className="ml-2">&middot; {t('settings.users.invitations.expiresAt', { date: formatDate(inv.expiresAt) })}</span>
                  )}
                </div>
              </div>
              {status === 'active' && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => copyToClipboard(inv.url, { successKey: 'settings.users.invitations.linkCopied' })}
                  >
                    <Copy className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setRevokingInvitation(inv)}
                  >
                    <XCircle className="size-4" />
                  </Button>
                </div>
              )}
            </div>
          )
        })}

        <Button
          variant="outline"
          onClick={() => { setInviteError(null); setInviteOpen(true) }}
          className="w-full"
        >
          <UserPlus className="size-4" />
          {t('settings.users.invitations.create')}
        </Button>
      </div>

      {/* Create invitation dialog */}
      <FormDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title={t('settings.users.invitations.create')}
        description={t('settings.users.description')}
        size="md"
        error={inviteError}
        onSubmit={handleCreateInvitation}
        isSubmitting={inviteCreating}
        submitLabel={t('settings.users.invitations.create')}
      >
        <FormField label={t('settings.users.invitations.label')} htmlFor="invite-label">
          <Input
            id="invite-label"
            value={inviteLabel}
            onChange={(e) => setInviteLabel(e.target.value)}
            placeholder={t('settings.users.invitations.labelPlaceholder')}
          />
        </FormField>
        <FormField label={t('settings.users.invitations.expiresIn')} htmlFor="invite-expiry">
          <Input
            id="invite-expiry"
            type="number"
            min={1}
            max={365}
            value={inviteExpiry}
            onChange={(e) => setInviteExpiry(Number(e.target.value))}
          />
        </FormField>
      </FormDialog>

      {/* Revealed link dialog */}
      <FormDialog
        open={!!revealedLink}
        onOpenChange={(v) => { if (!v) setRevealedLink(null) }}
        title={t('settings.users.invitations.created')}
        description={t('settings.users.invitations.copyLink')}
        size="lg"
        cancelLabel={t('common.close')}
      >
        {revealedLink && (
          <div className="flex gap-2">
            <Input value={revealedLink} readOnly className="font-mono text-xs" />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => copyToClipboard(revealedLink!, { successKey: 'settings.users.invitations.linkCopied' })}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        )}
      </FormDialog>

      {/* Role change confirmation */}
      <AlertDialog open={!!changingRole} onOpenChange={(v) => { if (!v) setChangingRole(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {changingRole?.to === 'admin' ? t('settings.users.promote') : t('settings.users.demote')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {changingRole?.to === 'admin'
                ? t('settings.users.promoteConfirm', { name: changingRole?.user.firstName })
                : t('settings.users.demoteConfirm', { name: changingRole?.user.firstName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleChangeRole}>
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete user confirmation */}
      <AlertDialog open={!!deletingUser} onOpenChange={(v) => { if (!v) setDeletingUser(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.users.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.users.deleteConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDeleteUser}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke invitation confirmation */}
      <AlertDialog open={!!revokingInvitation} onOpenChange={(v) => { if (!v) setRevokingInvitation(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.users.invitations.revoke')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.users.invitations.revokeConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleRevokeInvitation}>
              {t('settings.users.invitations.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
