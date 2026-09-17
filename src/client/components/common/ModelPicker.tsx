import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronsUpDown, Ban, Loader2, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/components/ui/button'
import { Badge } from '@/client/components/ui/badge'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/client/components/ui/command'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'

interface ModelPickerModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
  /** Maximum input/context tokens. Rendered as a `{n}k ctx` badge. */
  contextWindow?: number
  /** Maximum output tokens. Rendered as a `{n}k out` badge. */
  maxOutput?: number
  /** LLM-family only — chat accepts image attachments (vision-capable). */
  supportsImageInput?: boolean
  /** Image-family only — how many source images this model accepts. */
  maxImageInputs?: number
}

/** Compact tokens display: 1_500_000 -> "1.5M", 128_000 -> "128k". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}

interface ModelPickerProps {
  models: ModelPickerModel[]
  value: string
  onValueChange: (modelId: string, providerId: string) => void
  placeholder?: string
  disabled?: boolean
  className?: string
  /** Visible label for standalone controls, such as the conversation composer. */
  triggerLabel?: string
  /** Trigger button variant. Defaults to 'outline' (bordered). Pass 'ghost'
   *  for a borderless inline trigger that blends into its surroundings
   *  (e.g. the composer toolbar). */
  variant?: 'outline' | 'ghost'
  /** Show a "None" option at the top to clear the selection */
  allowClear?: boolean
  /** Label for the clear option. Defaults to `placeholder` if provided,
   *  else to a generic translated fallback. */
  clearLabel?: string
  /** When true, replace the placeholder with a "loading…" indicator so the
   *  user knows the model catalogue is still being fetched (the global
   *  `/providers/models` call can take a few seconds on first mount). */
  isLoading?: boolean
}

/** Build the composite value used for matching: `providerId:modelId` */
export function modelPickerValue(modelId: string, providerId: string): string {
  if (!modelId) return ''
  return `${providerId}:${modelId}`
}

export function ModelPicker({
  models,
  value,
  onValueChange,
  placeholder,
  disabled = false,
  className,
  triggerLabel,
  variant = 'outline',
  allowClear = false,
  clearLabel,
  isLoading = false,
}: ModelPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  const resolvedClearLabel = clearLabel ?? placeholder ?? t('modelPicker.clear')

  const getItemValue = (m: ModelPickerModel) => `${m.providerId}:${m.id}`

  const selectedModel = models.find((m) => getItemValue(m) === value)

  /** Unique providers by providerId, preserving insertion order */
  const providers = useMemo(() => {
    const seen = new Map<string, { providerName: string; providerType: string }>()
    for (const m of models) {
      if (!seen.has(m.providerId)) {
        seen.set(m.providerId, { providerName: m.providerName, providerType: m.providerType })
      }
    }
    return seen
  }, [models])

  const filteredModels = useMemo(
    () => (providerFilter ? models.filter((m) => m.providerId === providerFilter) : models),
    [models, providerFilter],
  )

  const modelsByProvider = useMemo(
    () =>
      filteredModels.reduce<Record<string, ModelPickerModel[]>>((acc, m) => {
        if (!acc[m.providerId]) acc[m.providerId] = []
        acc[m.providerId]!.push(m)
        return acc
      }, {}),
    [filteredModels],
  )

  const showFilters = providers.size > 1

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setProviderFilter(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={variant}
          role="combobox"
          aria-label={triggerLabel ? t('modelPicker.change', { model: selectedModel?.name ?? placeholder ?? t('modelPicker.placeholder') }) : undefined}
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between font-normal',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          {triggerLabel && <span className="shrink-0 font-medium">{triggerLabel}</span>}
          {selectedModel ? (
            <span className="flex min-w-0 items-center gap-2 truncate">
              {!triggerLabel && <ProviderIcon
                providerType={selectedModel.providerType}
                className="size-4 shrink-0"
              />}
              <span className="truncate">{selectedModel.name}</span>
            </span>
          ) : isLoading && models.length === 0 ? (
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 shrink-0 animate-spin opacity-60" />
              <span>{t('modelPicker.loading')}</span>
            </span>
          ) : (
            <span>{placeholder ?? t('modelPicker.placeholder')}</span>
          )}
          <ChevronsUpDown className="ml-auto size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="max-w-[calc(100vw-1rem)] p-0"
        style={{ width: 'max(18rem, var(--radix-popover-trigger-width))' }}
        align="start"
        collisionPadding={8}
      >
        <Command>
          <CommandInput placeholder={t('modelPicker.search')} />

          {/* Provider filter tabs */}
          {showFilters && (
            <div className="flex flex-wrap gap-1 border-b px-2 py-1.5">
              <button
                type="button"
                onClick={() => setProviderFilter(null)}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
                  providerFilter === null
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {t('modelPicker.all')}
              </button>
              {[...providers.entries()].map(([pid, { providerName, providerType }]) => (
                <button
                  key={pid}
                  type="button"
                  onClick={() => setProviderFilter(providerFilter === pid ? null : pid)}
                  className={cn(
                    'flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors',
                    providerFilter === pid
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <ProviderIcon providerType={providerType} className="size-3" />
                  {providerName}
                </button>
              ))}
            </div>
          )}

          {/* onWheel stopPropagation prevents parent Dialog from stealing scroll */}
          <CommandList
            className="max-h-[300px] overflow-y-auto overscroll-contain"
            onWheel={(e) => e.stopPropagation()}
          >
            <CommandEmpty>{t('modelPicker.noResults')}</CommandEmpty>
            {allowClear && (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onValueChange('', '')
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'size-4 shrink-0',
                      !value ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  <Ban className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground italic">
                    {resolvedClearLabel}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {Object.entries(modelsByProvider).map(([providerId, providerModels]) => {
              const providerInfo = providers.get(providerId)
              return (
                <CommandGroup
                  key={providerId}
                  heading={
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon providerType={providerInfo?.providerType ?? ''} className="size-3.5" />
                      {providerInfo?.providerName ?? providerId}
                    </span>
                  }
                >
                  {providerModels.map((m) => {
                    const itemValue = getItemValue(m)
                    const hasMeta =
                      m.contextWindow != null ||
                      m.maxOutput != null ||
                      m.supportsImageInput ||
                      (m.maxImageInputs != null && m.maxImageInputs > 0)
                    return (
                      <CommandItem
                        key={itemValue}
                        value={`${m.name} ${m.id} ${m.providerName}`}
                        onSelect={() => {
                          onValueChange(m.id, m.providerId)
                          setOpen(false)
                        }}
                        className="items-start py-2"
                      >
                        <Check
                          className={cn(
                            'mt-0.5 size-4 shrink-0',
                            value === itemValue ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-sm">{m.name}</span>
                          {m.name !== m.id && (
                            <span className="truncate font-mono text-[10px] text-muted-foreground">
                              {m.id}
                            </span>
                          )}
                          {hasMeta && (
                            <div className="mt-0.5 flex flex-wrap items-center gap-1">
                              {m.contextWindow != null && (
                                <Badge variant="outline" size="xs">
                                  {formatTokens(m.contextWindow)} ctx
                                </Badge>
                              )}
                              {m.maxOutput != null && (
                                <Badge variant="outline" size="xs">
                                  {formatTokens(m.maxOutput)} out
                                </Badge>
                              )}
                              {m.supportsImageInput && (
                                <Badge variant="outline" size="xs">
                                  <ImageIcon className="mr-0.5 size-3" />
                                  {t('modelPicker.vision')}
                                </Badge>
                              )}
                              {m.maxImageInputs != null && m.maxImageInputs > 0 && (
                                <Badge variant="outline" size="xs">
                                  <ImageIcon className="mr-0.5 size-3" />
                                  {m.maxImageInputs === 1
                                    ? t('modelPicker.img2img')
                                    : t('modelPicker.multiImage', { count: m.maxImageInputs })}
                                </Badge>
                              )}
                            </div>
                          )}
                        </div>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
