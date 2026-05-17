import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import { Card, CardContent } from '@/client/components/ui/card'
import { AlertTriangle, Brain, Globe, Image, Loader2, Pencil, RefreshCw, Search } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/client/components/ui/tooltip'
import { PROVIDER_DISPLAY_NAMES } from '@/shared/constants'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'

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
  /** Provider family — 'llm' | 'embedding' | 'image'. Each row serves
   *  exactly one family; multi-capability provider types (OpenAI) are
   *  stored as N sibling rows. May be absent on legacy GET responses
   *  served from a stale client cache. */
  family?: string
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
            <p className="text-xs text-muted-foreground">{PROVIDER_DISPLAY_NAMES[provider.type] ?? provider.type}</p>
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
          {onTest && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onTest}
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
