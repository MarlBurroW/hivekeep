import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Card, CardContent } from '@/client/components/ui/card'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { ContactNotes } from './ContactNotes'
import { ContactPlatformIds } from './ContactPlatformIds'
import { Pencil, User } from 'lucide-react'

export interface ContactIdentifierData {
  id: string
  label: string
  value: string
}

export interface ContactNicknameData {
  id: string
  nickname: string
}

export interface ContactNoteData {
  id: string
  kinId: string
  scope: string
  content: string
  createdAt: string | number
  updatedAt: string | number
}

export interface ContactPlatformIdData {
  id: string
  contactId: string
  platform: string
  platformId: string
  createdAt: number
}

export interface ContactData {
  id: string
  firstName: string | null
  lastName: string | null
  displayName: string
  linkedUserId: string | null
  linkedUserName: string | null
  nicknames: ContactNicknameData[]
  identifiers: ContactIdentifierData[]
  notes: ContactNoteData[]
  platformIds?: ContactPlatformIdData[]
  createdAt: number
  updatedAt: number
}

export interface KinInfo {
  name: string
  avatarUrl: string | null
}

interface ContactCardProps {
  contact: ContactData
  kinInfo?: Map<string, KinInfo>
  onEdit?: () => void
  onDelete?: () => void
  onRefresh?: () => void
}

export function ContactCard({ contact, kinInfo, onEdit, onDelete, onRefresh }: ContactCardProps) {
  const { t } = useTranslation()

  const platformCount = contact.platformIds?.length ?? 0
  const platformNames = contact.platformIds?.map((p) => p.platform).join(', ')
  let deleteDescription = t('settings.contacts.deleteConfirm')
  if (platformCount > 0) {
    deleteDescription += ' ' + t('settings.contacts.deleteWarnPlatforms', {
      count: platformCount,
      platforms: platformNames,
    })
  }

  return (
    <Card className="surface-card">
      <CardContent className="py-3 px-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="shrink-0">
              <User className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-sm font-medium truncate">{contact.displayName}</p>
                {contact.linkedUserName && (
                  <Badge variant="outline" size="xs" className="shrink-0 gap-1">
                    <User className="size-2.5" />
                    {contact.linkedUserName}
                  </Badge>
                )}
              </div>
              {contact.nicknames.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {contact.nicknames.map((nick) => (
                    <Badge key={nick.id} variant="secondary" size="xs" className="font-normal">
                      {nick.nickname}
                    </Badge>
                  ))}
                </div>
              )}
              {contact.identifiers.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {contact.identifiers.map((ident) => (
                    <Badge key={ident.id} variant="outline" size="xs" className="font-normal">
                      {ident.label}: {ident.value}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {onEdit && (
              <Button variant="ghost" size="icon-xs" onClick={onEdit}>
                <Pencil className="size-3.5" />
              </Button>
            )}
            {onDelete && (
              <ConfirmDeleteButton
                onConfirm={onDelete}
                description={deleteDescription}
              />
            )}
          </div>
        </div>

        <ContactPlatformIds contactId={contact.id} initialPlatformIds={contact.platformIds} />

        <ContactNotes
          contactId={contact.id}
          notes={contact.notes}
          kinInfo={kinInfo}
          onRefresh={onRefresh}
        />
      </CardContent>
    </Card>
  )
}
