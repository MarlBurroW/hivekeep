import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Card, CardContent } from '@/client/components/ui/card'
import { AlertTriangle, Brain, Globe, Image, List, Loader2, Pencil, RefreshCw, Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/client/components/ui/tooltip'
import { PROVIDER_DISPLAY_NAMES } from '@/shared/constants'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { useNavigate } from 'react-router-dom'
import { useSettingsClose } from '@/client/pages/settings/SettingsPage'

const CAPABILITY_ICONS: Record<string, typeof Brain> = {
  llm: Brain,
  embedding: Search,
  image: Image,
  search: Globe,
}

export interface ProviderData {
  id: string
  slug: string
  name: string
  type: string
  /** Which families this provider row serves: 'llm', 'embedding',
   *  'image'. One row holds every capability of a single account —
   *  the older "one row per family" model was removed pre-2.0. */
  capabilities: string[]
  isValid: boolean
  lastError?: string | null
}

interface ProviderCardProps {
  provider: ProviderData
  isTesting?: boolean
  onTest?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

export function ProviderCard({ provider, isTesting, onTest, onEdit, onDelete }: ProviderCardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const closeSettings = useSettingsClose()

  return (
    <Card className="surface-card">
      <CardContent className="flex items-center justify-between py-3 px-4">
        <div className="flex items-center gap-3">
          <div className="relative shrink-0">
            <ProviderIcon providerType={provider.type} variant="color" className="size-6" />
            <span
              className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-card ${
                provider.isValid ? 'bg-emerald-500' : 'bg-destructive'
              }`}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{provider.name}</p>
            <p className="text-xs text-muted-foreground">
              {PROVIDER_DISPLAY_NAMES[provider.type] ?? provider.type}
              {provider.slug && (
                <>
                  <span className="mx-1.5 opacity-40">·</span>
                  <span className="font-mono text-[11px] opacity-70" title={t('settings.providers.slugTooltip', 'Use this slug as `provider_id` in spawn_self / spawn_agent tool calls')}>
                    {provider.slug}
                  </span>
                </>
              )}
            </p>
            {!provider.isValid && provider.lastError && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="mt-0.5 flex items-center gap-1 text-[11px] text-destructive truncate max-w-[280px]">
                      <AlertTriangle className="size-3 shrink-0" />
                      <span className="truncate">{provider.lastError}</span>
                    </p>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-sm">
                    {provider.lastError}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {provider.capabilities.map((cap) => {
            const Icon = CAPABILITY_ICONS[cap]
            return (
 <Badge key={cap} variant="secondary" size="xs" className="gap-1">
                {Icon && <Icon className="size-3" />}
                {t(`onboarding.providers.cap_${cap}`, cap)}
              </Badge>
            )
          })}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('settings.providers.modelsModal.openTooltip', 'Browse models exposed by this provider')}
                  onClick={() => { closeSettings(); navigate('/models') }}
                >
                  <List className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {provider.isValid
                  ? t('settings.providers.modelsModal.openTooltip', 'Browse models exposed by this provider')
                  : t('settings.providers.modelsModal.invalidTooltip', 'Re-test this provider before browsing its models')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          {onTest && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onTest}
              aria-label={t('common.test')}
              disabled={isTesting}
            >
              {isTesting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
          )}
          {onEdit && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onEdit}
              aria-label={t('common.edit')}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {onDelete && (
            <ConfirmDeleteButton
              onConfirm={onDelete}
              title={t('settings.providers.delete')}
              description={t('settings.providers.deleteConfirm')}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}
