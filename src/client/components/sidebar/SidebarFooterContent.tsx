import { useState, useEffect, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings2, Keyboard, Command, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { WhatsNewDialog } from '@/client/components/common/WhatsNewDialog'
import { useUpdate } from '@/client/contexts/UpdateContext'
import { api } from '@/client/lib/api'
import { toast } from 'sonner'

interface SidebarFooterContentProps {
  onOpenSettings?: (section?: string) => void
}

export const SidebarFooterContent = memo(function SidebarFooterContent({ onOpenSettings }: SidebarFooterContentProps) {
  const { t } = useTranslation()
  const [version, setVersion] = useState<string | null>(null)
  const [whatsNewOpen, setWhatsNewOpen] = useState(false)
  const { isUpdateAvailable: hasUpdate, isChecking, forceCheck, openUpdateDialog } = useUpdate()

  useEffect(() => {
    api
      .get<{ version: string }>('/info')
      .then((data) => setVersion(data.version))
      .catch(() => {})
  }, [])

  const handleCheckForUpdates = async () => {
    try {
      const result = await forceCheck()
      if (result?.isUpdateAvailable) {
        openUpdateDialog()
      } else {
        toast.success(t('sidebar.footer.upToDate'))
      }
    } catch {
      toast.error(t('sidebar.footer.checkFailed'))
    }
  }

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)

  return (
    <div className="flex items-center justify-between px-2 py-1">
      {/* Left: version badge + check for updates */}
      <div className="inline-flex items-center gap-1">
        {/* Version badge — opens changelog or update dialog */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                if (hasUpdate) {
                  openUpdateDialog()
                } else {
                  setWhatsNewOpen(true)
                }
              }}
              className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground/50 font-medium select-none transition-colors hover:text-muted-foreground cursor-pointer"
            >
              {version ? `v${version}` : ''}
              {hasUpdate && (
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {hasUpdate
              ? t('updateAvailable.title')
              : t('sidebar.footer.whatsNew')}
          </TooltipContent>
        </Tooltip>

        {/* Check for updates button */}
        {!hasUpdate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCheckForUpdates}
                disabled={isChecking}
                className="inline-flex items-center rounded-md p-0.5 text-muted-foreground/30 transition-colors hover:text-muted-foreground disabled:opacity-50 disabled:pointer-events-none"
              >
                {isChecking ? (
                  <Loader2 className="size-2.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-2.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {t('sidebar.footer.checkForUpdates')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <WhatsNewDialog
        open={whatsNewOpen}
        onOpenChange={setWhatsNewOpen}
        currentVersion={version}
      />

      {/* Right: shortcut hints + settings */}
      <div className="flex items-center gap-0.5">
        {/* Command palette hint */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground hover:bg-muted/50"
              onClick={() => {
                // Programmatically trigger Cmd+K
                const event = new KeyboardEvent('keydown', {
                  key: 'k',
                  code: 'KeyK',
                  metaKey: isMac,
                  ctrlKey: !isMac,
                  bubbles: true,
                })
                document.dispatchEvent(event)
              }}
            >
              <Command className="size-2.5" />
              <span className="font-mono">K</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {t('sidebar.footer.commandPalette')}
          </TooltipContent>
        </Tooltip>

        {/* Keyboard shortcuts hint */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center rounded-md px-1.5 py-1 text-[10px] text-muted-foreground/50 transition-colors hover:text-muted-foreground hover:bg-muted/50"
              onClick={() => {
                // Programmatically trigger ? key
                const event = new KeyboardEvent('keydown', {
                  key: '?',
                  code: 'Slash',
                  bubbles: true,
                })
                document.dispatchEvent(event)
              }}
            >
              <Keyboard className="size-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {t('sidebar.footer.shortcuts')}
          </TooltipContent>
        </Tooltip>

        {/* Settings button */}
        {onOpenSettings && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground/50 hover:text-muted-foreground"
                onClick={() => onOpenSettings()}
                aria-label={t('sidebar.footer.settings')}
              >
                <Settings2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {t('sidebar.footer.settings')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
})
