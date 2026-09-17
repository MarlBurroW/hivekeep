import { useTranslation } from 'react-i18next'
import { timeAgo } from '@/client/lib/time'
import { Button } from '@/client/components/ui/button'
import { Card, CardContent } from '@/client/components/ui/card'
import { AgentBadge } from '@/client/components/common/AgentBadge'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import {
  Pencil,
  KeyRound,
  Globe,
  CreditCard,
  StickyNote,
  UserSquare,
  Star,
  Paperclip,
  ShieldCheck,
  User,
} from 'lucide-react'

export interface VaultSecretData {
  id: string
  key: string
  description: string | null
  entryType?: string
  isFavorite?: boolean
  attachmentCount?: number
  createdByAgentId: string | null
  lastUsedAt?: number | null
  allowedTools?: string[] | null
  allowedHosts?: string[] | null
  createdAt: number
  updatedAt: number
}

const TYPE_CONFIG: Record<string, { icon: typeof KeyRound; color: string }> = {
  text:       { icon: KeyRound,    color: 'text-warning bg-warning/10' },
  credential: { icon: Globe,       color: 'text-info bg-info/10' },
  card:       { icon: CreditCard,  color: 'text-success bg-success/10' },
  note:       { icon: StickyNote,  color: 'text-secondary bg-secondary/10' },
  identity:   { icon: UserSquare,  color: 'text-destructive bg-destructive/10' },
}

interface VaultSecretCardProps {
  secret: VaultSecretData
  agentName?: string
  agentAvatarUrl?: string | null
  onEdit?: () => void
  onDelete?: () => void
  onToggleFavorite?: () => void
}

export function VaultSecretCard({ secret, agentName, agentAvatarUrl, onEdit, onDelete, onToggleFavorite }: VaultSecretCardProps) {
  const { t } = useTranslation()
  const entryType = secret.entryType ?? 'text'
  const config = TYPE_CONFIG[entryType] ?? { icon: ShieldCheck, color: 'text-muted-foreground bg-muted' }
  const Icon = config.icon
  const typeLabel = t(`vault.types.${entryType}`, entryType)

  return (
    <Card className="surface-card group">
      <CardContent className="flex items-center justify-between py-3 px-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`shrink-0 rounded-lg p-2 ${config.color}`}>
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold font-mono truncate leading-tight">{secret.key}</p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[11px] text-muted-foreground">{typeLabel}</span>
              {(secret.attachmentCount ?? 0) > 0 && (
                <>
                  <span className="text-[11px] text-muted-foreground/40">·</span>
                  <span className="flex items-center gap-0.5 text-[11px] text-muted-foreground">
                    <Paperclip className="size-3" />
                    {secret.attachmentCount}
                  </span>
                </>
              )}
              <span className="text-[11px] text-muted-foreground/40">·</span>
              {secret.createdByAgentId && agentName ? (
                <AgentBadge name={agentName} avatarUrl={agentAvatarUrl} />
              ) : (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <User className="size-3" />
                  {t('settings.vault.createdByAdmin')}
                </span>
              )}
            </div>
            {secret.lastUsedAt ? (
              <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">
                {t('settings.vault.lastUsed')} {timeAgo(secret.lastUsedAt)}
              </p>
            ) : null}
            {secret.description && (
              <p className="text-xs text-muted-foreground/70 truncate mt-0.5">{secret.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {onToggleFavorite && (
            <Button variant="ghost" size="icon-xs" onClick={onToggleFavorite} aria-label={t('settings.vault.tabFavorites')} aria-pressed={secret.isFavorite}>
              <Star className={`size-3.5 ${secret.isFavorite ? 'fill-warning text-warning' : ''}`} />
            </Button>
          )}
          {onEdit && (
            <Button variant="ghost" size="icon-xs" onClick={onEdit} aria-label={t('common.edit')}>
              <Pencil className="size-3.5" />
            </Button>
          )}
          {onDelete && (
            <ConfirmDeleteButton
              onConfirm={onDelete}
              description={t('settings.vault.deleteConfirm')}
            />
          )}
        </div>
        {secret.isFavorite && (
          <Star className="size-3 fill-warning text-warning shrink-0 group-hover:hidden ml-1" />
        )}
      </CardContent>
    </Card>
  )
}
