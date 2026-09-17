import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/client/components/ui/dropdown-menu'
import { User, Settings, LogOut, MessageSquarePlus } from 'lucide-react'
import { UserAvatar } from '@/client/components/common/UserAvatar'
import { useFeedback } from '@/client/contexts/FeedbackContext'

interface UserMenuProps {
  user: {
    firstName: string
    lastName: string
    pseudonym: string
    email: string
    avatarUrl: string | null
  }
  onLogout: () => void
  onOpenSettings: () => void
  onOpenAccount: () => void
}

export function UserMenu({ user, onLogout, onOpenSettings, onOpenAccount }: UserMenuProps) {
  const { t } = useTranslation()
  const { enabled: feedbackEnabled, open: openFeedback } = useFeedback()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={t('sidebar.account')}>
          <UserAvatar user={user} className="size-7" fallbackClassName="text-[10px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">{user.firstName} {user.lastName}</div>
          <div className="text-xs text-muted-foreground">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenAccount}>
          <User className="size-4" />
          {t('sidebar.account')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenSettings}>
          <Settings className="size-4" />
          {t('sidebar.settings')}
        </DropdownMenuItem>
        {feedbackEnabled && (
          <DropdownMenuItem onClick={openFeedback}>
            <MessageSquarePlus className="size-4" />
            {t('activityBar.feedback')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onLogout}>
          <LogOut className="size-4" />
          {t('sidebar.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
