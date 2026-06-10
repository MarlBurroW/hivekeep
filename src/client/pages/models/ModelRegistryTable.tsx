import { useState, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { RefreshCw, Pencil, AlertTriangle, Pin, Wand2, Search, ChevronsUpDown, Check } from 'lucide-react'
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
import { ProviderIcon } from '@/client/components/common/ProviderIcon'
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
const cap = (v: boolean | null) => (v == null ? '—' : v ? '✓' : '✕')

export function ModelRegistryTable() {
  const { t } = useTranslation()
  const [models, setModels] = useState<RegistryModel[]>([])
  const [loading, setLoading] = useState(true)
  const [resyncing, setResyncing] = useState(false)
  const [providerFilter, setProviderFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<RegistryModel | null>(null)

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

  useEffect(() => { void load() }, [load])

  const resync = async () => {
    setResyncing(true)
    try {
      await api.post('/models/resync')
      toast.success(t('settings.modelRegistry.resyncStarted', 'Resync started — refresh in a moment'))
      // give the background reconcile a beat, then reload
      setTimeout(() => void load(), 1500)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setResyncing(false)
    }
  }

  const providerOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const m of models) if (m.providerName) seen.set(m.providerId, m.providerName)
    return [...seen.entries()]
  }, [models])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models
      .filter((m) => providerFilter === 'all' || m.providerId === providerFilter)
      .filter((m) => !q || m.modelId.toLowerCase().includes(q) || (m.providerName ?? '').toLowerCase().includes(q))
      .sort((a, b) => (a.providerName ?? '').localeCompare(b.providerName ?? '') || a.modelId.localeCompare(b.modelId))
  }, [models, providerFilter, query])

  const reviewCount = models.filter((m) => m.needsReview && !m.stale).length

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
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{t('settings.modelRegistry.title', 'Models')}</h2>
          <p className="text-sm text-muted-foreground max-w-2xl">
            {t('settings.modelRegistry.subtitle',
              'Every model exposed by your providers. Metadata (context, capabilities, pricing) is auto-filled from the community models.dev database — edit any value to pin it, or remap a wrong match.')}
          </p>
        </div>
        <Button variant="outline" onClick={resync} disabled={resyncing}>
          <RefreshCw className={`size-4 ${resyncing ? 'animate-spin' : ''}`} />
          {t('settings.modelRegistry.resync', 'Resync')}
        </Button>
      </div>

      {reviewCount > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <AlertTriangle className="size-4 text-amber-500" />
          {t('settings.modelRegistry.reviewBanner', { count: reviewCount, defaultValue: '{{count}} model(s) need review — the auto-match was low-confidence. Open and remap or confirm.' })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('settings.modelRegistry.allProviders', 'All providers')}</SelectItem>
            {providerOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('common.search', 'Search')} className="pl-8" />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
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
            {filtered.map((m) => (
              <tr key={m.id} className="border-t border-border [&>td]:px-3 [&>td]:py-2 hover:bg-muted/30">
                <td className="font-medium">
                  <span className={m.stale ? 'line-through opacity-60' : ''}>{m.modelId}</span>
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {m.mappingMode === 'manual' && <Badge variant="secondary" className="text-[10px]">manual</Badge>}
                    {m.needsReview && !m.stale && <Badge className="bg-amber-500/20 text-amber-600 text-[10px]">review</Badge>}
                    {m.stale && <Badge variant="outline" className="text-[10px]">stale</Badge>}
                    {m.overriddenFields.length > 0 && <Pin className="size-3 text-primary inline" />}
                  </span>
                </td>
                <td className="text-muted-foreground">
                  <span className="flex items-center gap-2">
                    {m.providerType && <ProviderIcon providerType={m.providerType} variant="color" className="size-4 shrink-0" />}
                    <span className="truncate">{m.providerName}</span>
                  </span>
                </td>
                <td className="text-right tabular-nums">{fmtCtx(m.contextWindow)}</td>
                <td className="text-center">{cap(m.supportsImageInput)}</td>
                <td className="text-center">{cap(m.supportsPdfInput)}</td>
                <td className="text-center">{cap(m.supportsToolCall)}</td>
                <td className="text-center">{m.reasoning?.enabled ? '✓' : m.reasoning ? '✕' : '—'}</td>
                <td className="text-right tabular-nums text-muted-foreground">
                  {m.pricing ? `${m.pricing.input}·${m.pricing.output}` : '—'}
                </td>
                <td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(m)}><Pencil className="size-4" /></Button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                {t('settings.modelRegistry.empty', 'No models. Connect a provider, then Resync.')}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

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
      const patch: Record<string, unknown> = {
        contextWindow: ctx ? Number(ctx) : null,
        maxOutput: maxOut ? Number(maxOut) : null,
        supportsImageInput: image,
        supportsPdfInput: pdf,
        supportsToolCall: tools,
        thinking: reasoning
          ? { efforts: efforts.split(',').map((e) => e.trim()).filter(Boolean) }
          : null,
        pricing: priceIn || priceOut ? { input: Number(priceIn) || 0, output: Number(priceOut) || 0 } : null,
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
