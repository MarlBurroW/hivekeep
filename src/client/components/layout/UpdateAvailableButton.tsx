import { useTranslation } from 'react-i18next'
import { ArrowUpCircle } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/client/components/ui/tooltip'
import { useUpdate } from '@/client/contexts/UpdateContext'

/**
 * Persistent, glanceable "update available" entry in the top bar. Only shows
 * when the active channel has a newer version, so users don't have to dig into
 * Settings to discover it. Clicking opens the shared changelog/update dialog.
 *
 * Shows a labelled pill from `sm` up (clearly visible) and collapses to a
 * pulsing icon button below `sm` so the top bar never overflows on phones.
 */
export function UpdateAvailableButton() {
  const { t } = useTranslation()
  const { isUpdateAvailable, openUpdateDialog } = useUpdate()

  if (!isUpdateAvailable) return null

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Labelled pill on >= sm */}
          <Button
            variant="default"
            size="sm"
            onClick={openUpdateDialog}
            className="hidden sm:inline-flex gap-1.5 pulse-glow"
            aria-label={t('updateAvailable.title')}
          >
            <ArrowUpCircle className="size-4" />
            {t('topbar.updateAvailable')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('updateAvailable.title')}</TooltipContent>
      </Tooltip>

      {/* Icon-only on phones */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={openUpdateDialog}
            className="relative sm:hidden"
            aria-label={t('updateAvailable.title')}
          >
            <ArrowUpCircle className="size-4 text-primary" />
            <span className="absolute -right-0.5 -top-0.5 flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('updateAvailable.title')}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
