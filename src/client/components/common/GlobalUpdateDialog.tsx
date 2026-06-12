import { UpdateAvailableDialog } from '@/client/components/common/UpdateAvailableDialog'
import { useUpdate } from '@/client/contexts/UpdateContext'

/**
 * Mounts the "update available" dialog once at app root so it can be opened
 * from anywhere (sidebar footer badge, top-bar indicator) via the
 * UpdateContext, instead of each entry point owning its own copy.
 */
export function GlobalUpdateDialog() {
  const { versionInfo, dialogOpen, setDialogOpen } = useUpdate()
  if (!versionInfo) return null
  return (
    <UpdateAvailableDialog open={dialogOpen} onOpenChange={setDialogOpen} versionInfo={versionInfo} />
  )
}
