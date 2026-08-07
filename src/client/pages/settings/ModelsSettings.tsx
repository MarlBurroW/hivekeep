import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/components/ui/select'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { InfoTip } from '@/client/components/common/InfoTip'
import { Skeleton } from '@/client/components/ui/skeleton'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { api, toastError } from '@/client/lib/api'
import { useModels, type ProviderModel } from '@/client/hooks/useModels'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { configToChoice, choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { modelReasoningInfo } from '@/client/lib/model-efforts'
import type { AgentThinkingConfig } from '@/shared/types'
import { useProviders } from '@/client/hooks/useProviders'

interface DefaultModelsData {
  defaultLlmModel: string | null
  defaultLlmProviderId: string | null
  defaultImageModel: string | null
  defaultImageProviderId: string | null
  defaultCompactingModel: string | null
  defaultCompactingProviderId: string | null
  defaultScoutModel: string | null
  defaultScoutProviderId: string | null
  defaultScoutThinking: AgentThinkingConfig | null
  extractionModel: string | null
  extractionProviderId: string | null
  embeddingModel: string | null
  embeddingProviderId: string | null
  defaultSearchProviderId: string | null
  defaultTtsProviderId: string | null
  defaultSttProviderId: string | null
}

export function ModelsSettings() {
  const { t } = useTranslation()
  const { models: allModels, isLoading: modelsLoading } = useModels()
  const { providers: allProviders } = useProviders()

  const llmModels = useMemo(() => allModels.filter((m: ProviderModel) => m.capability === 'llm'), [allModels])
  const imageModels = useMemo(() => allModels.filter((m: ProviderModel) => m.capability === 'image'), [allModels])
  const embeddingModels = useMemo(() => allModels.filter((m: ProviderModel) => m.capability === 'embedding'), [allModels])
  const searchProviders = useMemo(
    () => allProviders.filter((p) => p.isValid && p.capabilities.includes('search')),
    [allProviders],
  )
  const ttsProviders = useMemo(
    () => allProviders.filter((p) => p.isValid && p.capabilities.includes('tts')),
    [allProviders],
  )
  const sttProviders = useMemo(
    () => allProviders.filter((p) => p.isValid && p.capabilities.includes('stt')),
    [allProviders],
  )

  // State for all fields
  const [isLoading, setIsLoading] = useState(true)

  const [llmModel, setLlmModel] = useState('')
  const [llmProviderId, setLlmProviderId] = useState('')
  const [initLlmModel, setInitLlmModel] = useState('')
  const [initLlmProviderId, setInitLlmProviderId] = useState('')

  const [compactingModel, setCompactingModel] = useState('')
  const [compactingProviderId, setCompactingProviderId] = useState('')
  const [initCompactingModel, setInitCompactingModel] = useState('')
  const [initCompactingProviderId, setInitCompactingProviderId] = useState('')

  const [scoutModel, setScoutModel] = useState('')
  const [scoutProviderId, setScoutProviderId] = useState('')
  const [initScoutModel, setInitScoutModel] = useState('')
  const [initScoutProviderId, setInitScoutProviderId] = useState('')
  // Scout reasoning ('inherit' = unset → scouts follow the calling Agent's config)
  const [scoutThinking, setScoutThinking] = useState<ThinkingChoice>('inherit')
  const [initScoutThinking, setInitScoutThinking] = useState<ThinkingChoice>('inherit')

  const [imageModel, setImageModel] = useState('')
  const [imageProviderId, setImageProviderId] = useState('')
  const [initImageModel, setInitImageModel] = useState('')
  const [initImageProviderId, setInitImageProviderId] = useState('')

  const [extractionModel, setExtractionModel] = useState('')
  const [extractionProviderId, setExtractionProviderId] = useState('')
  const [initExtractionModel, setInitExtractionModel] = useState('')
  const [initExtractionProviderId, setInitExtractionProviderId] = useState('')

  const [embeddingModel, setEmbeddingModel] = useState('')
  const [embeddingProviderId, setEmbeddingProviderId] = useState('')
  const [initEmbeddingModel, setInitEmbeddingModel] = useState('')
  const [initEmbeddingProviderId, setInitEmbeddingProviderId] = useState('')

  const [searchProviderId, setSearchProviderId] = useState('')
  const [initSearchProviderId, setInitSearchProviderId] = useState('')

  const [ttsProviderId, setTtsProviderId] = useState('')
  const [initTtsProviderId, setInitTtsProviderId] = useState('')

  const [sttProviderId, setSttProviderId] = useState('')
  const [initSttProviderId, setInitSttProviderId] = useState('')

  const [reembedding, setReembedding] = useState(false)

  // Saving state per field
  const [savingField, setSavingField] = useState<string | null>(null)

  useEffect(() => {
    api.get<DefaultModelsData>('/settings/default-models')
      .then((data) => {
        setLlmModel(data.defaultLlmModel ?? '')
        setLlmProviderId(data.defaultLlmProviderId ?? '')
        setInitLlmModel(data.defaultLlmModel ?? '')
        setInitLlmProviderId(data.defaultLlmProviderId ?? '')

        setCompactingModel(data.defaultCompactingModel ?? '')
        setCompactingProviderId(data.defaultCompactingProviderId ?? '')
        setInitCompactingModel(data.defaultCompactingModel ?? '')
        setInitCompactingProviderId(data.defaultCompactingProviderId ?? '')

        setScoutModel(data.defaultScoutModel ?? '')
        setScoutProviderId(data.defaultScoutProviderId ?? '')
        setInitScoutModel(data.defaultScoutModel ?? '')
        setInitScoutProviderId(data.defaultScoutProviderId ?? '')
        setScoutThinking(configToChoice(data.defaultScoutThinking))
        setInitScoutThinking(configToChoice(data.defaultScoutThinking))

        setImageModel(data.defaultImageModel ?? '')
        setImageProviderId(data.defaultImageProviderId ?? '')
        setInitImageModel(data.defaultImageModel ?? '')
        setInitImageProviderId(data.defaultImageProviderId ?? '')

        setExtractionModel(data.extractionModel ?? '')
        setExtractionProviderId(data.extractionProviderId ?? '')
        setInitExtractionModel(data.extractionModel ?? '')
        setInitExtractionProviderId(data.extractionProviderId ?? '')

        setEmbeddingModel(data.embeddingModel ?? '')
        setEmbeddingProviderId(data.embeddingProviderId ?? '')
        setInitEmbeddingModel(data.embeddingModel ?? '')
        setInitEmbeddingProviderId(data.embeddingProviderId ?? '')

        setSearchProviderId(data.defaultSearchProviderId ?? '')
        setInitSearchProviderId(data.defaultSearchProviderId ?? '')

        setTtsProviderId(data.defaultTtsProviderId ?? '')
        setInitTtsProviderId(data.defaultTtsProviderId ?? '')

        setSttProviderId(data.defaultSttProviderId ?? '')
        setInitSttProviderId(data.defaultSttProviderId ?? '')
      })
      .catch(() => {})
      .finally(() => setIsLoading(false))
  }, [])

  // Change detection helpers
  const hasLlmChanges = llmModel !== initLlmModel || llmProviderId !== initLlmProviderId
  const hasCompactingChanges = compactingModel !== initCompactingModel || compactingProviderId !== initCompactingProviderId
  const hasScoutChanges = scoutModel !== initScoutModel || scoutProviderId !== initScoutProviderId || scoutThinking !== initScoutThinking
  const hasImageChanges = imageModel !== initImageModel || imageProviderId !== initImageProviderId
  const hasExtractionChanges = extractionModel !== initExtractionModel || extractionProviderId !== initExtractionProviderId
  const hasEmbeddingChanges = embeddingModel !== initEmbeddingModel || embeddingProviderId !== initEmbeddingProviderId
  const hasSearchChanges = searchProviderId !== initSearchProviderId
  const hasTtsChanges = ttsProviderId !== initTtsProviderId
  const hasSttChanges = sttProviderId !== initSttProviderId

  // Save handlers
  const saveField = async (
    field: string,
    endpoint: string,
    body: Record<string, unknown>,
    onSuccess: () => void,
  ) => {
    setSavingField(field)
    try {
      await api.put(endpoint, body)
      onSuccess()
      toast.success(t('settings.models.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingField(null)
    }
  }

  const handleSaveLlm = () =>
    saveField('llm', '/settings/default-llm', { model: llmModel || null, providerId: llmProviderId || null }, () => {
      setInitLlmModel(llmModel)
      setInitLlmProviderId(llmProviderId)
    })

  const handleSaveCompacting = () =>
    saveField('compacting', '/settings/default-compacting', { model: compactingModel || null, providerId: compactingProviderId || null }, () => {
      setInitCompactingModel(compactingModel)
      setInitCompactingProviderId(compactingProviderId)
    })

  const handleSaveScout = async () => {
    // Two endpoints, one Save: the model pair + the reasoning default.
    setSavingField('scout')
    try {
      await api.put('/settings/default-scout', { model: scoutModel || null, providerId: scoutProviderId || null })
      await api.put('/settings/default-scout-thinking', { thinking: choiceToConfig(scoutThinking) })
      setInitScoutModel(scoutModel)
      setInitScoutProviderId(scoutProviderId)
      setInitScoutThinking(scoutThinking)
      toast.success(t('settings.models.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingField(null)
    }
  }

  const handleSaveImage = () =>
    saveField('image', '/settings/default-image', { model: imageModel || null, providerId: imageProviderId || null }, () => {
      setInitImageModel(imageModel)
      setInitImageProviderId(imageProviderId)
    })

  const handleSaveExtraction = () =>
    saveField('extraction', '/settings/extraction-model', { model: extractionModel || null, providerId: extractionProviderId || null }, () => {
      setInitExtractionModel(extractionModel)
      setInitExtractionProviderId(extractionProviderId)
    })

  const handleSaveEmbedding = () =>
    saveField('embedding', '/settings/embedding-model', { model: embeddingModel, providerId: embeddingProviderId || null }, () => {
      setInitEmbeddingModel(embeddingModel)
      setInitEmbeddingProviderId(embeddingProviderId)
    })

  const handleSaveSearch = () =>
    saveField('search', '/settings/default-search', { providerId: searchProviderId || null }, () => {
      setInitSearchProviderId(searchProviderId)
    })

  const handleSaveTts = () =>
    saveField('tts', '/settings/default-tts', { providerId: ttsProviderId || null }, () => {
      setInitTtsProviderId(ttsProviderId)
    })

  const handleSaveStt = () =>
    saveField('stt', '/settings/default-stt', { providerId: sttProviderId || null }, () => {
      setInitSttProviderId(sttProviderId)
    })

  const handleReembed = async () => {
    if (!confirm(t('settings.memories.reembedConfirm'))) return
    setReembedding(true)
    try {
      const result = await api.post<{ total: number; success: number; failed: number }>('/memories/reembed', {})
      if (result.failed > 0) {
        toast.warning(t('settings.memories.reembedFailed', result))
      } else {
        toast.success(t('settings.memories.reembedSuccess', result))
      }
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setReembedding(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">
        {t('settings.models.description')}
      </p>

      {/* Default LLM */}
      <div className="space-y-2">
        <Label className="inline-flex items-center gap-1.5">
          {t('settings.models.defaultLlm')}
          <InfoTip content={t('settings.models.defaultLlmTip')} />
        </Label>
        <ModelPicker
          models={llmModels}
          value={modelPickerValue(llmModel, llmProviderId)}
          onValueChange={(modelId, pid) => { setLlmModel(modelId); setLlmProviderId(pid) }}
          placeholder={t('settings.models.defaultLlmPlaceholder')}
          allowClear
          isLoading={modelsLoading}
        />
        <p className="text-xs text-muted-foreground">{t('settings.models.defaultLlmHint')}</p>
        <Button size="sm" onClick={handleSaveLlm} disabled={!hasLlmChanges || savingField === 'llm'}>
          {savingField === 'llm' ? t('common.loading') : t('common.save')}
        </Button>
      </div>

      {/* Default Compacting Model */}
      <div className="space-y-2">
        <Label className="inline-flex items-center gap-1.5">
          {t('settings.models.defaultCompacting')}
          <InfoTip content={t('settings.models.defaultCompactingTip')} />
        </Label>
        <ModelPicker
          models={llmModels}
          value={modelPickerValue(compactingModel, compactingProviderId)}
          onValueChange={(modelId, pid) => { setCompactingModel(modelId); setCompactingProviderId(pid) }}
          placeholder={t('settings.models.defaultCompactingPlaceholder')}
          allowClear
          isLoading={modelsLoading}
        />
        <p className="text-xs text-muted-foreground">{t('settings.models.defaultCompactingHint')}</p>
        <Button size="sm" onClick={handleSaveCompacting} disabled={!hasCompactingChanges || savingField === 'compacting'}>
          {savingField === 'compacting' ? t('common.loading') : t('common.save')}
        </Button>
      </div>

      {/* Default Scout Model — cheap, fast model the `scout` tool delegates
          heavy read-only exploration to. An Agent can override it. */}
      <div className="space-y-2">
        <Label className="inline-flex items-center gap-1.5">
          {t('settings.models.defaultScout')}
          <InfoTip content={t('settings.models.defaultScoutTip')} />
        </Label>
        <ModelPicker
          models={llmModels}
          value={modelPickerValue(scoutModel, scoutProviderId)}
          onValueChange={(modelId, pid) => { setScoutModel(modelId); setScoutProviderId(pid) }}
          placeholder={t('settings.models.defaultScoutPlaceholder')}
          allowClear
          isLoading={modelsLoading}
        />
        <p className="text-xs text-muted-foreground">{t('settings.models.defaultScoutHint')}</p>
        <Label className="inline-flex items-center gap-1.5 pt-1">
          {t('settings.models.defaultScoutThinking')}
          <InfoTip content={t('settings.models.defaultScoutThinkingTip')} />
        </Label>
        <ThinkingEffortSelect
          value={scoutThinking}
          onChange={setScoutThinking}
          inheritLabel={t('settings.models.defaultScoutThinkingInherit')}
          reasoning={scoutModel
            ? modelReasoningInfo(llmModels.find((m) => m.id === scoutModel && (!scoutProviderId || m.providerId === scoutProviderId)))
            : undefined}
        />
        <Button size="sm" onClick={handleSaveScout} disabled={!hasScoutChanges || savingField === 'scout'}>
          {savingField === 'scout' ? t('common.loading') : t('common.save')}
        </Button>
      </div>

      {/* Default Image Model */}
      {imageModels.length > 0 && (
        <div className="space-y-2">
          <Label className="inline-flex items-center gap-1.5">
            {t('settings.models.defaultImage')}
            <InfoTip content={t('settings.models.defaultImageTip')} />
          </Label>
          <ModelPicker
            models={imageModels}
            value={modelPickerValue(imageModel, imageProviderId)}
            onValueChange={(modelId, pid) => { setImageModel(modelId); setImageProviderId(pid) }}
            placeholder={t('settings.models.defaultImagePlaceholder')}
            allowClear
          />
          <p className="text-xs text-muted-foreground">{t('settings.models.defaultImageHint')}</p>
          <Button size="sm" onClick={handleSaveImage} disabled={!hasImageChanges || savingField === 'image'}>
            {savingField === 'image' ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      )}

      {/* Default Search Provider */}
      {searchProviders.length > 0 && (
        <div className="space-y-2">
          <Label className="inline-flex items-center gap-1.5">
            {t('settings.models.defaultSearch')}
            <InfoTip content={t('settings.models.defaultSearchTip')} />
          </Label>
          <Select
            value={searchProviderId || '__none__'}
            onValueChange={(v) => setSearchProviderId(v === '__none__' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('settings.models.defaultSearchPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('settings.models.defaultSearchPlaceholder')}</SelectItem>
              {searchProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}{' '}
                  <span className="text-muted-foreground text-xs">({p.slug})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('settings.models.defaultSearchHint')}</p>
          <Button size="sm" onClick={handleSaveSearch} disabled={!hasSearchChanges || savingField === 'search'}>
            {savingField === 'search' ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      )}

      {/* Default TTS Provider */}
      {ttsProviders.length > 0 && (
        <div className="space-y-2">
          <Label className="inline-flex items-center gap-1.5">
            {t('settings.models.defaultTts')}
            <InfoTip content={t('settings.models.defaultTtsTip')} />
          </Label>
          <Select
            value={ttsProviderId || '__none__'}
            onValueChange={(v) => setTtsProviderId(v === '__none__' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('settings.models.defaultTtsPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('settings.models.defaultTtsPlaceholder')}</SelectItem>
              {ttsProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}{' '}
                  <span className="text-muted-foreground text-xs">({p.slug})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('settings.models.defaultTtsHint')}</p>
          <Button size="sm" onClick={handleSaveTts} disabled={!hasTtsChanges || savingField === 'tts'}>
            {savingField === 'tts' ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      )}

      {/* Default STT Provider */}
      {sttProviders.length > 0 && (
        <div className="space-y-2">
          <Label className="inline-flex items-center gap-1.5">
            {t('settings.models.defaultStt')}
            <InfoTip content={t('settings.models.defaultSttTip')} />
          </Label>
          <Select
            value={sttProviderId || '__none__'}
            onValueChange={(v) => setSttProviderId(v === '__none__' ? '' : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('settings.models.defaultSttPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('settings.models.defaultSttPlaceholder')}</SelectItem>
              {sttProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}{' '}
                  <span className="text-muted-foreground text-xs">({p.slug})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('settings.models.defaultSttHint')}</p>
          <Button size="sm" onClick={handleSaveStt} disabled={!hasSttChanges || savingField === 'stt'}>
            {savingField === 'stt' ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      )}

      {/* Extraction Model */}
      <div className="space-y-2">
        <Label className="inline-flex items-center gap-1.5">
          {t('settings.models.extractionModel')}
          <InfoTip content={t('settings.models.extractionModelTip')} />
        </Label>
        <ModelPicker
          models={llmModels}
          value={modelPickerValue(extractionModel, extractionProviderId)}
          onValueChange={(modelId, pid) => { setExtractionModel(modelId); setExtractionProviderId(pid) }}
          placeholder={t('settings.models.extractionModelPlaceholder')}
          allowClear
          isLoading={modelsLoading}
        />
        <p className="text-xs text-muted-foreground">{t('settings.models.extractionModelHint')}</p>
        <Button size="sm" onClick={handleSaveExtraction} disabled={!hasExtractionChanges || savingField === 'extraction'}>
          {savingField === 'extraction' ? t('common.loading') : t('common.save')}
        </Button>
      </div>

      {/* Embedding Model */}
      <div className="space-y-2">
        <Label className="inline-flex items-center gap-1.5">
          {t('settings.models.embeddingModel')}
          <InfoTip content={t('settings.models.embeddingModelTip')} />
        </Label>
        <ModelPicker
          models={embeddingModels}
          value={modelPickerValue(embeddingModel, embeddingProviderId)}
          onValueChange={(modelId, pid) => { setEmbeddingModel(modelId); setEmbeddingProviderId(pid) }}
          placeholder={t('settings.models.embeddingModelPlaceholder')}
          isLoading={modelsLoading}
        />
        <p className="text-xs text-muted-foreground">{t('settings.models.embeddingModelHint')}</p>

        {hasEmbeddingChanges && embeddingModel && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{t('settings.memories.embeddingModelWarning')}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSaveEmbedding} disabled={!hasEmbeddingChanges || savingField === 'embedding' || !embeddingModel}>
            {savingField === 'embedding' ? t('common.loading') : t('common.save')}
          </Button>
          <Button size="sm" variant="outline" onClick={handleReembed} disabled={reembedding}>
            <RefreshCw className={`mr-1.5 size-3.5 ${reembedding ? 'animate-spin' : ''}`} />
            {reembedding ? t('settings.memories.reembedInProgress') : t('settings.memories.reembed')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.memories.reembedDescription')}</p>
      </div>

      <HelpPanel
        contentKey="settings.models.help.content"
        bulletKeys={[
          'settings.models.help.bullet1',
          'settings.models.help.bullet2',
          'settings.models.help.bullet3',
        ]}
        storageKey="help.models.open"
      />
    </div>
  )
}
