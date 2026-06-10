import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Pencil, AlertTriangle, Pin, Wand2, Search, ChevronsUpDown, Check, RotateCcw, X, Minus, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Badge } from '@/client/components/ui/badge'
import { Switch } from '@/client/components/ui/switch'
import { Skeleton } from '@/client/components/ui/skeleton'
import { FormDialog } from '@/client/components/common/FormDialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/client/components/ui/popover'
import {
  Command, CommandInput, CommandList, CommandEmpty, CommandItem,
} from '@/client/components/ui/command'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/components/ui/tooltip'
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
import { useProviderTypes } from '@/client/hooks/useProviderTypes'
import { api, getErrorMessage } from '@/client/lib/api'

interface RegistryModel {
  id: string
  providerId: string
  providerName: string | null
  providerType: string | null
  modelId: string
  displayName: string | null
  mappingMode: 'auto' | 'manual'
  modelsDevKey: string | null
  matchConfidence: string | null
  contextWindow: number | null
  maxOutput: number | null
  supportsToolCall: boolean | null
  supportsImageInput: boolean | null
  supportsPdfInput: boolean | null
  reasoning: { enabled: boolean; efforts: string[] } | null
  pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null
  overriddenFields: string[]
  enabled: boolean
  needsReview: boolean
  stale: boolean
}

const fmtCtx = (n: number | null) => (n == null ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** A tri-state capability cell: ✓ supported (green), ✗ not supported (red),
 *  — unknown/not reported (muted). The tooltip spells out the distinction
 *  (the ✗ vs — difference isn't obvious at a glance). */
function CapCell({ value }: { value: boolean | null }) {
  const { t } = useTranslation()
  let Icon = Minus
  let cls = 'text-muted-foreground/40'
  let tip = t('settings.modelRegistry.capUnknown', 'Unknown — neither the provider nor models.dev reported this')
  if (value === true) {
    Icon = Check
    cls = 'text-success'
    tip = t('settings.modelRegistry.capYes', 'Supported')
  } else if (value === false) {
    Icon = X
    cls = 'text-destructive'
    tip = t('settings.modelRegistry.capNo', 'Not supported')
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex justify-center"><Icon className={`size-4 ${cls}`} /></span>
      </TooltipTrigger>
      <TooltipContent className="text-xs">{tip}</TooltipContent>
    </Tooltip>
  )
}

export function ModelRegistryTable({ reloadKey = 0 }: { reloadKey?: number } = {}) {
  const { t } = useTranslation()
  // Side-effect: registers each provider type's brand icon with <ProviderIcon>.
  // Without it the icons fall back to the generic chip (this page is reached
  // directly, so nothing else triggers the registration).
  useProviderTypes()
  const [models, setModels] = useState<RegistryModel[]>([])
  const [loading, setLoading] = useState(true)
  const [providerFilter, setProviderFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<RegistryModel | null>(null)
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(25)
  const [bulkBusy, setBulkBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ models: RegistryModel[] }>('/models')
      setModels(data.models)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  // `reloadKey` lets the host page (whose header owns the resync/snapshot
  // actions) trigger a refetch after one of them completes.
  useEffect(() => { void load() }, [load, reloadKey])

  // One-click "this auto-match is correct" — an empty patch clears needsReview
  // server-side without pinning any field (and enables it if it was in review).
  const confirmReview = async (m: RegistryModel) => {
    try {
      const res = await api.patch<{ model: RegistryModel }>(`/models/${m.id}`, {})
      setModels((ms) => ms.map((x) => (x.id === res.model.id ? res.model : x)))
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  // Enable/disable a model straight from the table. Disabled models are hidden
  // from every model picker; the row updates optimistically off the response.
  const toggleEnabled = async (m: RegistryModel, value: boolean) => {
    try {
      const res = await api.patch<{ model: RegistryModel }>(`/models/${m.id}`, { enabled: value })
      setModels((ms) => ms.map((x) => (x.id === res.model.id ? res.model : x)))
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  // Bulk action over the CURRENT filtered set (across pages), so it composes with
  // the provider/status filters: e.g. filter "review" then confirm them all.
  const bulkAction = async (action: 'enable' | 'disable' | 'confirm', ids: string[]) => {
    if (ids.length === 0) return
    setBulkBusy(true)
    try {
      await api.post('/models/bulk', { action, ids })
      await load()
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const providerOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of models) if (m.providerName) seen.set(m.providerId, m.providerName)
    return [...seen.entries()]
  }, [models])

  const matchesStatus = (m: RegistryModel): boolean => {
    switch (statusFilter) {
      case 'enabled': return m.enabled
      case 'disabled': return !m.enabled
      case 'review': return m.needsReview && !m.stale
      case 'unmapped': return !m.modelsDevKey
      default: return true
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .filter((m) => providerFilter === 'all' || m.providerId === providerFilter)
      .filter(matchesStatus)
      .filter((m) => !q || m.modelId.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q) || (m.providerName ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.providerName ?? '').localeCompare(b.providerName ?? '') || a.modelId.localeCompare(b.modelId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, providerFilter, statusFilter, query])

  const reviewCount = models.filter((m) => m.needsReview && !m.stale).length

  // Pagination. `safePage` clamps when the filtered set shrinks below the
  // current page so we never render an empty page.
  useEffect(() => { setPage(1) }, [providerFilter, statusFilter, query, perPage])
  const pageCount = Math.max(1, Math.ceil(filtered.length / perPage))
  const safePage = Math.min(page, pageCount)
  const paged = filtered.slice((safePage - 1) * perPage, safePage * perPage)
  const rangeFrom = filtered.length === 0 ? 0 : (safePage - 1) * perPage + 1
  const rangeTo = Math.min(safePage * perPage, filtered.length)

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-64" />
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* The page title + sync actions live in the canonical PageHeader
          (ModelRegistryPage); here only the explainer. */}
      <p className="text-sm text-muted-foreground max-w-2xl">
        {t('settings.modelRegistry.subtitle',
          'Every model exposed by your providers. Metadata (context, capabilities, pricing) is auto-filled from the community models.dev database — edit any value to pin it, or remap a wrong match.')}
      </p>

      {reviewCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <AlertTriangle className="size-4 text-amber-500" />
          {t('settings.modelRegistry.reviewBanner', { count: reviewCount, defaultValue: '{{count}} model(s) to review — their models.dev match was uncertain. Click ✓ to confirm a match is right, or open a row to remap it.' })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-full sm:w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.modelRegistry.allProviders', 'All providers')}</SelectItem>
            {providerOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.modelRegistry.statusAll', 'All statuses')}</SelectItem>
            <SelectItem value="enabled">{t('settings.modelRegistry.statusEnabled', 'Enabled')}</SelectItem>
            <SelectItem value="disabled">{t('settings.modelRegistry.statusDisabled', 'Disabled')}</SelectItem>
            <SelectItem value="review">{t('settings.modelRegistry.statusReview', 'To review')}</SelectItem>
            <SelectItem value="unmapped">{t('settings.modelRegistry.statusUnmapped', 'Unmapped')}</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('common.search', 'Search')} className="pl-8" />
        </div>
      </div>

      {/* Bulk actions over the current filtered set (across pages). */}
      {filtered.length > 0 && (() => {
        const ids = filtered.map((m) => m.id)
        const reviewIds = filtered.filter((m) => m.needsReview && !m.stale).map((m) => m.id)
        const enabledN = filtered.filter((m) => m.enabled).length
        return (
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="text-muted-foreground">
              {t('settings.modelRegistry.bulkScope', { count: filtered.length, defaultValue: '{{count}} shown' })}
            </span>
            <span className="text-muted-foreground/40">·</span>
            <Button variant="ghost" size="sm" disabled={bulkBusy || enabledN === filtered.length} onClick={() => bulkAction('enable', ids)}>
              <Check className="size-3.5 text-success" />{t('settings.modelRegistry.bulkEnable', 'Enable all')}
            </Button>
            <Button variant="ghost" size="sm" disabled={bulkBusy || enabledN === 0} onClick={() => bulkAction('disable', ids)}>
              <X className="size-3.5 text-destructive" />{t('settings.modelRegistry.bulkDisable', 'Disable all')}
            </Button>
            {reviewIds.length > 0 && (
              <Button variant="ghost" size="sm" disabled={bulkBusy} onClick={() => bulkAction('confirm', reviewIds)}>
                <Check className="size-3.5 text-amber-600" />
                {t('settings.modelRegistry.bulkConfirm', { count: reviewIds.length, defaultValue: 'Confirm {{count}} review(s)' })}
              </Button>
            )}
          </div>
        )
      })()}

      {/* Desktop: the dense table. Mobile gets the card list below. */}
      <div className="hidden sm:block overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th className="w-10"><span className="sr-only">{t('settings.modelRegistry.colEnabled', 'Enabled')}</span></th>
              <th>{t('settings.modelRegistry.colModel', 'Model')}</th>
              <th>{t('settings.modelRegistry.colProvider', 'Provider')}</th>
              <th className="text-right">{t('settings.modelRegistry.colContext', 'Context')}</th>
              <th className="text-center">{t('settings.modelRegistry.colImage', 'Image')}</th>
              <th className="text-center">{t('settings.modelRegistry.colPdf', 'PDF')}</th>
              <th className="text-center">{t('settings.modelRegistry.colTools', 'Tools')}</th>
              <th className="text-center">{t('settings.modelRegistry.colReason', 'Reason')}</th>
              <th className="text-right">{t('settings.modelRegistry.colPrice', '$/M in·out')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {paged.map((m) => (
              <tr key={m.id} className={`border-t border-border [&>td]:px-3 [&>td]:py-2 hover:bg-muted/30 ${m.enabled ? '' : 'opacity-45'}`}>
                <td>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Switch checked={m.enabled} onCheckedChange={(v) => toggleEnabled(m, v)} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="text-xs">
                      {m.enabled
                        ? t('settings.modelRegistry.enabledTip', 'Enabled — shown in model pickers. Click to hide it.')
                        : t('settings.modelRegistry.disabledTip', 'Disabled — hidden from model pickers. Click to enable.')}
                    </TooltipContent>
                  </Tooltip>
                </td>
                <td className="font-medium">
                  <span className={m.stale ? 'line-through opacity-60' : ''}>{m.displayName || m.modelId}</span>
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {m.mappingMode === 'manual' && <Badge variant="secondary" className="text-[10px]">manual</Badge>}
                    {m.needsReview && !m.stale && <Badge className="bg-amber-500/20 text-amber-600 text-[10px]">review</Badge>}
                    {m.stale && <Badge variant="outline" className="text-[10px]">stale</Badge>}
                    {m.overriddenFields.length > 0 && <Pin className="size-3 text-primary inline" />}
                  </span>
                  {m.displayName && m.displayName !== m.modelId && (
                    <span className="block font-mono text-[11px] font-normal text-muted-foreground">{m.modelId}</span>
                  )}
                </td>
                <td className="text-muted-foreground">
                  <span className="flex items-center gap-2">
                    {m.providerType && <ProviderIcon providerType={m.providerType} variant="color" className="size-4 shrink-0" />}
                    <span className="truncate">{m.providerName}</span>
                  </span>
                </td>
                <td className="text-right tabular-nums">{fmtCtx(m.contextWindow)}</td>
                <td className="text-center"><CapCell value={m.supportsImageInput} /></td>
                <td className="text-center"><CapCell value={m.supportsPdfInput} /></td>
                <td className="text-center"><CapCell value={m.supportsToolCall} /></td>
                <td className="text-center"><CapCell value={m.reasoning?.enabled ? true : m.reasoning ? false : null} /></td>
                <td className="text-right tabular-nums text-muted-foreground">
                  {m.pricing ? `${m.pricing.input}·${m.pricing.output}` : '—'}
                </td>
                <td className="text-right">
                  {m.needsReview && !m.stale && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => confirmReview(m)}
                      title={t('settings.modelRegistry.confirmTooltip', 'Confirm this match is correct (clears review)')}
                    >
                      <Check className="size-4 text-amber-600" />
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setEditing(m)}><Pencil className="size-4" /></Button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                {t('settings.modelRegistry.empty', 'No models. Connect a provider, then Resync.')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards — the wide table doesn't fit a phone. */}
      <div className="sm:hidden space-y-2">
        {paged.map((m) => (
          <div key={m.id} className={`surface-card rounded-lg border border-border p-3 space-y-2 ${m.enabled ? '' : 'opacity-45'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={`text-sm font-medium truncate ${m.stale ? 'line-through opacity-60' : ''}`}>{m.displayName || m.modelId}</p>
                {m.displayName && m.displayName !== m.modelId && (
                  <p className="font-mono text-[11px] text-muted-foreground truncate">{m.modelId}</p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {m.needsReview && !m.stale && (
                  <Button variant="ghost" size="icon-xs" onClick={() => confirmReview(m)} aria-label={t('settings.modelRegistry.confirmTooltip', 'Confirm this match is correct (clears review)')}>
                    <Check className="size-4 text-amber-600" />
                  </Button>
                )}
                <Button variant="ghost" size="icon-xs" onClick={() => setEditing(m)} aria-label={t('common.edit', 'Edit')}>
                  <Pencil className="size-3.5" />
                </Button>
                <Switch checked={m.enabled} onCheckedChange={(v) => toggleEnabled(m, v)} />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 min-w-0">
                {m.providerType && <ProviderIcon providerType={m.providerType} variant="color" className="size-3.5 shrink-0" />}
                <span className="truncate">{m.providerName}</span>
              </span>
              <span className="opacity-40">·</span>
              <span className="tabular-nums">{fmtCtx(m.contextWindow)} ctx</span>
              {m.pricing && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="tabular-nums">${m.pricing.input}·${m.pricing.output}/M</span>
                </>
              )}
              {m.mappingMode === 'manual' && <Badge variant="secondary" className="text-[10px]">manual</Badge>}
              {m.needsReview && !m.stale && <Badge className="bg-amber-500/20 text-amber-600 text-[10px]">review</Badge>}
              {m.stale && <Badge variant="outline" className="text-[10px]">stale</Badge>}
              {m.overriddenFields.length > 0 && <Pin className="size-3 text-primary" />}
            </div>

            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">{t('settings.modelRegistry.colImage', 'Image')} <CapCell value={m.supportsImageInput} /></span>
              <span className="inline-flex items-center gap-1">{t('settings.modelRegistry.colPdf', 'PDF')} <CapCell value={m.supportsPdfInput} /></span>
              <span className="inline-flex items-center gap-1">{t('settings.modelRegistry.colTools', 'Tools')} <CapCell value={m.supportsToolCall} /></span>
              <span className="inline-flex items-center gap-1">{t('settings.modelRegistry.colReason', 'Reason')} <CapCell value={m.reasoning?.enabled ? true : m.reasoning ? false : null} /></span>
            </div>
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('settings.modelRegistry.empty', 'No models. Connect a provider, then Resync.')}
          </p>
        )}
      </div>

      {filtered.length > 0 && (
        <div className="flex flex-col-reverse items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row">
          <span className="tabular-nums">
            {t('settings.modelRegistry.range', { from: rangeFrom, to: rangeTo, total: filtered.length, defaultValue: '{{from}}–{{to}} of {{total}}' })}
          </span>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">{t('settings.modelRegistry.perPage', 'Per page')}</span>
            <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v))}>
              <SelectTrigger className="h-8 w-[4.5rem]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label={t('common.previous', 'Previous')}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="tabular-nums">{safePage} / {pageCount}</span>
            <Button variant="outline" size="icon-sm" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)} aria-label={t('common.next', 'Next')}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {editing && (
        <EditModelDialog
          model={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => { setModels((ms) => ms.map((x) => (x.id === updated.id ? updated : x))); setEditing(null) }}
        />
      )}
    </div>
  )
}

function EditModelDialog({ model, onClose, onSaved }: {
  model: RegistryModel
  onClose: () => void
  onSaved: (m: RegistryModel) => void
}) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(model.enabled)
  const [displayName, setDisplayName] = useState(model.displayName ?? '')
  const [ctx, setCtx] = useState(model.contextWindow?.toString() ?? '')
  const [maxOut, setMaxOut] = useState(model.maxOutput?.toString() ?? '')
  const [image, setImage] = useState(model.supportsImageInput ?? false)
  const [pdf, setPdf] = useState(model.supportsPdfInput ?? false)
  const [tools, setTools] = useState(model.supportsToolCall ?? true)
  const [reasoning, setReasoning] = useState(model.reasoning?.enabled ?? false)
  const [efforts, setEfforts] = useState((model.reasoning?.efforts ?? []).join(', '))
  const [priceIn, setPriceIn] = useState(model.pricing?.input?.toString() ?? '')
  const [priceOut, setPriceOut] = useState(model.pricing?.output?.toString() ?? '')
  const [manual, setManual] = useState(model.mappingMode === 'manual')
  const [candidates, setCandidates] = useState<string[]>([])
  const [remapOpen, setRemapOpen] = useState(false)
  const [remapQuery, setRemapQuery] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get<{ candidates: string[] }>(`/models/${model.id}/candidates`)
      .then((d) => setCandidates(d.candidates)).catch(() => {})
  }, [model.id])

  const save = async () => {
    setSaving(true)
    try {
      if (manual !== (model.mappingMode === 'manual')) {
        await api.post(`/models/${model.id}/mode`, { mode: manual ? 'manual' : 'auto' })
      }
      // Only send fields the admin actually changed — every field present in the
      // patch gets PINNED server-side, so sending unchanged values would pin the
      // whole row on a no-op save. An empty patch still clears the review flag.
      const patch: Record<string, unknown> = {}
      const ctxNum = ctx ? Number(ctx) : null
      const maxNum = maxOut ? Number(maxOut) : null
      const initEfforts = (model.reasoning?.efforts ?? []).join(', ')
      const initReasoning = model.reasoning?.enabled ?? false
      const initPriceIn = model.pricing?.input?.toString() ?? ''
      const initPriceOut = model.pricing?.output?.toString() ?? ''
      if (enabled !== model.enabled) patch.enabled = enabled
      if (displayName !== (model.displayName ?? '')) patch.displayName = displayName
      if (ctxNum !== (model.contextWindow ?? null)) patch.contextWindow = ctxNum
      if (maxNum !== (model.maxOutput ?? null)) patch.maxOutput = maxNum
      if (image !== (model.supportsImageInput ?? false)) patch.supportsImageInput = image
      if (pdf !== (model.supportsPdfInput ?? false)) patch.supportsPdfInput = pdf
      if (tools !== (model.supportsToolCall ?? true)) patch.supportsToolCall = tools
      if (reasoning !== initReasoning || (reasoning && efforts !== initEfforts)) {
        patch.thinking = reasoning ? { efforts: efforts.split(',').map((e) => e.trim()).filter(Boolean) } : null
      }
      if (priceIn !== initPriceIn || priceOut !== initPriceOut) {
        patch.pricing = priceIn || priceOut ? { input: Number(priceIn) || 0, output: Number(priceOut) || 0 } : null
      }
      const res = await api.patch<{ model: RegistryModel }>(`/models/${model.id}`, patch)
      toast.success(t('settings.modelRegistry.saved', 'Saved'))
      onSaved(res.model)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const resetToAuto = async () => {
    setSaving(true)
    try {
      const res = await api.post<{ model: RegistryModel }>(`/models/${model.id}/reset`, {})
      toast.success(t('settings.modelRegistry.resetDone', 'Reset to automatic'))
      onSaved(res.model)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remap = async (key: string) => {
    try {
      const res = await api.post<{ model: RegistryModel }>(`/models/${model.id}/remap`, { modelsDevKey: key })
      toast.success(t('settings.modelRegistry.remapped', 'Remapped'))
      onSaved(res.model)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={<span className="font-mono text-base">{model.modelId}</span>}
      size="lg"
      onSubmit={save}
      isSubmitting={saving}
      submitLabel={t('common.save', 'Save')}
      cancelLabel={t('common.cancel', 'Cancel')}
    >
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium">{t('settings.modelRegistry.enabledLabel', 'Enabled')}</p>
          <p className="text-[11px] text-muted-foreground">{t('settings.modelRegistry.enabledDialogHint', 'Off = hidden from model pickers (the chat path still works if an Agent already uses it).')}</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {model.needsReview && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <AlertTriangle className="size-4 shrink-0 text-amber-500" />
          <span>{t('settings.modelRegistry.reviewHint', 'The models.dev match below was uncertain. Check the values look right (remap if not), then Save to confirm — that clears the review flag and enables the model.')}</span>
        </div>
      )}

      <Field label={t('settings.modelRegistry.displayName', 'Display name')}>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={model.modelId} />
        <p className="text-[11px] text-muted-foreground">
          {t('settings.modelRegistry.displayNameHint', 'Shown everywhere a model name appears. Leave blank to use the models.dev label (falls back to the id).')}
        </p>
      </Field>

      <p className="text-xs text-muted-foreground">
        {t('settings.modelRegistry.matchInfo', 'models.dev match')}:{' '}
        <span className="font-mono">{model.modelsDevKey ?? '—'}</span> ({model.matchConfidence ?? 'none'})
      </p>

      {/* remap — searchable across the whole models.dev catalogue */}
      <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5"><Wand2 className="size-3.5" /> {t('settings.modelRegistry.remap', 'Remap to models.dev entry')}</Label>
            <Popover open={remapOpen} onOpenChange={setRemapOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" className="w-full justify-between font-mono text-xs font-normal">
                  <span className="truncate">{model.modelsDevKey ?? t('settings.modelRegistry.remapPick', 'Pick the correct model…')}</span>
                  <ChevronsUpDown className="size-3.5 opacity-50 shrink-0" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-96 p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder={t('settings.modelRegistry.searchModelsDev', 'Search models.dev…')}
                    value={remapQuery}
                    onValueChange={setRemapQuery}
                  />
                  <CommandList>
                    <CommandEmpty>{t('common.noResults', 'No results')}</CommandEmpty>
                    {candidates
                      .filter((k) => k.toLowerCase().includes(remapQuery.toLowerCase()))
                      .slice(0, 60)
                      .map((k) => (
                        <CommandItem
                          key={k}
                          value={k}
                          onSelect={() => { remap(k); setRemapOpen(false) }}
                          className="font-mono text-xs"
                        >
                          <Check className={`size-3.5 ${model.modelsDevKey === k ? 'opacity-100' : 'opacity-0'}`} />
                          {k}
                        </CommandItem>
                      ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('settings.modelRegistry.context', 'Context window')}><Input value={ctx} onChange={(e) => setCtx(e.target.value)} inputMode="numeric" /></Field>
            <Field label={t('settings.modelRegistry.maxOutput', 'Max output')}><Input value={maxOut} onChange={(e) => setMaxOut(e.target.value)} inputMode="numeric" /></Field>
            <Field label={t('settings.modelRegistry.priceIn', '$/M input')}><Input value={priceIn} onChange={(e) => setPriceIn(e.target.value)} inputMode="decimal" /></Field>
            <Field label={t('settings.modelRegistry.priceOut', '$/M output')}><Input value={priceOut} onChange={(e) => setPriceOut(e.target.value)} inputMode="decimal" /></Field>
          </div>

          <div className="space-y-2">
            <Toggle label={t('settings.modelRegistry.image', 'Accepts images')} checked={image} onChange={setImage} />
            <Toggle label={t('settings.modelRegistry.pdf', 'Accepts PDFs')} checked={pdf} onChange={setPdf} />
            <Toggle label={t('settings.modelRegistry.tools', 'Supports tool calls')} checked={tools} onChange={setTools} />
            <Toggle label={t('settings.modelRegistry.reasoning', 'Reasoning model')} checked={reasoning} onChange={setReasoning} />
            {reasoning && (
              <Field label={t('settings.modelRegistry.efforts', 'Reasoning efforts (comma-separated)')}>
                <Input value={efforts} onChange={(e) => setEfforts(e.target.value)} placeholder="low, medium, high, max" />
              </Field>
            )}
            <Toggle label={t('settings.modelRegistry.manual', 'Manual (freeze — never auto-synced)')} checked={manual} onChange={setManual} />
          </div>

          {(model.overriddenFields.length > 0 || model.mappingMode === 'manual') && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {t('settings.modelRegistry.resetHint', 'This model has manual overrides. Reset to drop them and follow models.dev automatically.')}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={resetToAuto} disabled={saving} className="shrink-0">
                <RotateCcw className="size-3.5" />
                {t('settings.modelRegistry.reset', 'Reset to auto')}
              </Button>
            </div>
          )}
    </FormDialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label className="text-xs">{label}</Label>{children}</div>
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <Label className="text-sm font-normal">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
