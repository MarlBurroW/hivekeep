import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { ArrowUpCircle, Copy, Download, ExternalLink } from 'lucide-react'
import { useCopyToClipboard } from '@/client/hooks/useCopyToClipboard'
import { useAuth } from '@/client/hooks/useAuth'
import { UpdateChangelog } from '@/client/components/common/UpdateChangelog'
import { DOCKER_UPDATE_COMMAND } from '@/client/components/common/UpdateResultBanner'
import { useUpdate } from '@/client/contexts/UpdateContext'
import type { VersionInfo } from '@/shared/types'

interface UpdateAvailableDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  versionInfo: VersionInfo
}

export function UpdateAvailableDialog({
  open,
  onOpenChange,
  versionInfo,
}: UpdateAvailableDialogProps) {
  const { t } = useTranslation()
  const { copy, copied } = useCopyToClipboard()
  const { user } = useAuth()
  const { startUpdate } = useUpdate()
  const isAdmin = user?.role === 'admin'

  const isDocker = versionInfo.installationType === 'docker'
  const current =
    versionInfo.channel === 'edge'
      ? `${versionInfo.currentVersion} (${versionInfo.currentSha ?? '?'})`
      : versionInfo.currentVersion
  const latest = versionInfo.latestVersion ?? ''

  // Hand off to the global full-screen overlay, then get out of the way.
  const handleUpdate = () => {
    onOpenChange(false)
    startUpdate({ channel: versionInfo.channel, toVersion: latest })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="panel" size="2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-primary/10 p-2">
              <ArrowUpCircle className="size-5 text-primary" />
            </div>
            <div>
              <DialogTitle>{t('updateAvailable.title')}</DialogTitle>
              <DialogDescription>
                {t('updateAvailable.description', { current, latest })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {/* Version + channel badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {t('updateAvailable.current')}: {versionInfo.channel === 'edge' ? current : `v${current}`}
            </Badge>
            <span className="text-muted-foreground">→</span>
            <Badge variant="default" className="text-xs">
              {t('updateAvailable.latest')}: {versionInfo.channel === 'edge' ? latest : `v${latest}`}
            </Badge>
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
              {t(`updateChannel.${versionInfo.channel}`)}
            </Badge>
          </div>

          {versionInfo.changelog.length > 0 && (
            <div className="flex flex-col">
              <h4 className="mb-2 text-sm font-semibold">
                {versionInfo.channel === 'edge'
                  ? t('updateAvailable.newCommits', { count: versionInfo.changelog.length })
                  : t('updateAvailable.releaseNotes')}
              </h4>
              <UpdateChangelog changelog={versionInfo.changelog} channel={versionInfo.channel} />
            </div>
          )}
        </DialogBody>

        <DialogFooter className="flex-col items-stretch gap-3 sm:flex-col sm:items-stretch">
          <h4 className="text-sm font-semibold">{t('updateAvailable.howToUpdate')}</h4>

          {isDocker ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('updateAvailable.dockerInstructions')}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 rounded-md bg-muted px-3 py-2 text-xs font-mono truncate">
                  {DOCKER_UPDATE_COMMAND}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => copy(DOCKER_UPDATE_COMMAND)}
                >
                  <Copy className="size-3.5 mr-1" />
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('updateAvailable.dockerTagNote', { version: latest })}
              </p>
            </div>
          ) : versionInfo.canSelfUpdate ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {t('updateAvailable.selfUpdateInstructions')}
              </p>
              <Button onClick={handleUpdate} disabled={!isAdmin} className="w-full">
                <Download className="size-4 mr-2" />
                {t('updateAvailable.updateButton')}
              </Button>
              {!isAdmin && (
                <p className="text-center text-xs text-muted-foreground">
                  {t('updateAvailable.adminOnly')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {versionInfo.selfUpdateBlockedReason === 'dev-mode'
                ? t('updateAvailable.devModeNote')
                : t('updateAvailable.manualInstallNote')}
            </p>
          )}

          {versionInfo.releaseUrl && (
            <a
              href={versionInfo.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ExternalLink className="size-3" />
              {t('updateAvailable.viewOnGitHub')}
            </a>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
