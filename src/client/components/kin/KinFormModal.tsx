import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Input } from '@/client/components/ui/input'
import { Textarea } from '@/client/components/ui/textarea'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ConfirmDeleteButton } from '@/client/components/common/ConfirmDeleteButton'
import { EmptyState } from '@/client/components/common/EmptyState'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { FormErrorAlert } from '@/client/components/common/FormErrorAlert'
import { AvatarPickerModal, type AvatarPickerResult } from '@/client/components/kin/AvatarPickerModal'
import { KinToolsTab } from '@/client/components/kin/KinToolsTab'
import { CompactingAnimation } from '@/client/components/kin/CompactingAnimation'
import { MemoryList } from '@/client/components/memory/MemoryList'
import { Switch } from '@/client/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { AlertTriangle, Archive, ArrowLeft, Bot, Brain, Camera, Loader2, Network, Settings, ShieldCheck, Sparkles, Trash2, Upload, User, Wrench } from 'lucide-react'
import { InfoTip } from '@/client/components/common/InfoTip'
import { UnsavedChangesDialog } from '@/client/components/common/UnsavedChangesDialog'
import { useUnsavedChanges } from '@/client/hooks/useUnsavedChanges'
import { useHasCapability } from '@/client/hooks/useHasCapability'
import { cn } from '@/client/lib/utils'
import { api, getErrorMessage } from '@/client/lib/api'
import type { KinCompactingConfig, KinThinkingConfig } from '@/shared/types'
import type { GeneratedKinConfig } from '@/client/hooks/useKins'

interface Model {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

interface KinDetail {
  id: string
  slug: string
  name: string
  role: string
  avatarUrl: string | null
  character: string
  expertise: string
  model: string
  providerId?: string | null
  scoutModel?: string | null
  scoutProviderId?: string | null
  toolboxIds?: string[] | null
  compactingConfig?: KinCompactingConfig | null
  thinkingConfig?: KinThinkingConfig | null
}

interface KinFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  llmModels: Model[]
  imageModels?: Model[]
  onUploadAvatar: (kinId: string, file: File) => Promise<string>
  onGenerateAvatarPreview?: (
    kinId: string,
    mode: 'auto' | 'manual',
    opts?: { style?: string; subject?: string; character?: string; useBase?: boolean },
    imageModel?: { providerId: string; modelId: string },
  ) => Promise<string>
  hasImageCapability?: boolean
  // Mode create
  onCreateKin?: (data: {
    name: string
    slug?: string
    role: string
    character: string
    expertise: string
    model: string
    providerId?: string | null
    scoutModel?: string | null
    scoutProviderId?: string | null
    toolboxIds?: string[] | null
  }) => Promise<{ id: string }>
  // Mode edit
  kin?: KinDetail | null
  onUpdateKin?: (id: string, data: Record<string, unknown>) => Promise<unknown>
  onDeleteKin?: (id: string) => Promise<void>
  // Wizard helpers
  onGenerateKinConfig?: (data: {
    description?: string
    refinement?: string
    currentConfig?: Record<string, unknown>
    language?: string
  }) => Promise<GeneratedKinConfig>
  onGenerateAvatarPreviewFromConfig?: (data: {
    name: string
    role: string
    character: string
    expertise: string
  }) => Promise<string>
  /** Open the global settings modal at the given section. Passed through
   *  to AvatarPickerModal so the 'no image provider' notice can offer a
   *  jump-to-providers CTA. */
  onOpenSettings?: (section?: string) => void
}

type TabId = 'general' | 'tools' | 'memory' | 'compaction' | 'thinking'
type WizardStep = 'describe' | 'form'

const TABS: Array<{ id: TabId; icon: typeof Settings; labelKey: string }> = [
  { id: 'general', icon: Settings, labelKey: 'kin.tabs.general' },
  { id: 'tools', icon: Wrench, labelKey: 'kin.tabs.tools' },
  { id: 'memory', icon: Brain, labelKey: 'kin.tabs.memory' },
  { id: 'compaction', icon: Archive, labelKey: 'kin.tabs.compaction' },
  { id: 'thinking', icon: Sparkles, labelKey: 'kin.tabs.thinking' },
]

/** Convert data URL to File */
function dataUrlToFile(dataUrl: string): File {
  const [header = '', base64 = ''] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png'
  return new File([bytes], `avatar.${ext}`, { type: mime })
}

export function KinFormModal({
  open,
  onOpenChange,
  llmModels,
  imageModels,
  onUploadAvatar,
  onGenerateAvatarPreview,
  hasImageCapability = false,
  onCreateKin,
  kin,
  onUpdateKin,
  onDeleteKin,
  onGenerateKinConfig,
  onGenerateAvatarPreviewFromConfig,
  onOpenSettings,
}: KinFormModalProps) {
  const { t, i18n } = useTranslation()

  const isEdit = !!kin
  const defaultCharacter = t('kin.defaults.character')
  const defaultExpertise = t('kin.defaults.expertise')

  // Unsaved changes guard
  const { isDirty, markDirty, resetDirty, guardedClose, confirmDialogProps } = useUnsavedChanges({
    onClose: () => onOpenChange(false),
  })

  // Wizard state
  const [wizardStep, setWizardStep] = useState<WizardStep>(isEdit ? 'form' : 'describe')
  const [wizardDescription, setWizardDescription] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [wasAiGenerated, setWasAiGenerated] = useState(false)
  const [isAvatarGenerating, setIsAvatarGenerating] = useState(false)

  // Refine state
  const [refineText, setRefineText] = useState('')
  const [isRefining, setIsRefining] = useState(false)

  // Form state
  const [activeTab, setActiveTab] = useState<TabId>('general')
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [role, setRole] = useState('')
  const [character, setCharacter] = useState(defaultCharacter)
  const [expertise, setExpertise] = useState(defaultExpertise)
  const [model, setModel] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [scoutModel, setScoutModel] = useState<string | null>(null)
  const [scoutProviderId, setScoutProviderId] = useState<string | null>(null)
  const [toolboxIds, setToolboxIds] = useState<string[] | null>(null)
  const [compactingConfig, setCompactingConfig] = useState<KinCompactingConfig | null>(null)
  const [thinkingConfig, setThinkingConfig] = useState<KinThinkingConfig | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Track if avatar generation was aborted (component unmount / new generation)
  const avatarAbortRef = useRef<AbortController | null>(null)
  const importFileRef = useRef<HTMLInputElement | null>(null)

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        if (data.name) setName(data.name)
        if (data.role) setRole(data.role)
        if (data.character) setCharacter(data.character)
        if (data.expertise) setExpertise(data.expertise)
        if (data.model) setModel(data.model)
        if (Array.isArray(data.toolboxIds)) setToolboxIds(data.toolboxIds)
        setWizardStep('form')
        markDirty()
      } catch {
        setError(t('kin.invalidJsonFile'))
      }
    }
    reader.readAsText(file)
    // Reset the input so the same file can be re-imported
    e.target.value = ''
  }

  // Sync form when kin changes (edit mode) or reset for create mode
  useEffect(() => {
    if (kin) {
      setName(kin.name)
      setSlug(kin.slug)
      setRole(kin.role)
      setCharacter(kin.character)
      setExpertise(kin.expertise)
      setModel(kin.model)
      setProviderId(kin.providerId ?? null)
      setScoutModel(kin.scoutModel ?? null)
      setScoutProviderId(kin.scoutProviderId ?? null)
      setToolboxIds(kin.toolboxIds ?? null)
      setCompactingConfig(kin.compactingConfig ?? null)
      setThinkingConfig(kin.thinkingConfig ?? null)
      setAvatarPreview(kin.avatarUrl)
      setWizardStep('form')
      setWasAiGenerated(false)
    } else {
      setName('')
      setSlug('')
      setRole('')
      setCharacter(defaultCharacter)
      setExpertise(defaultExpertise)
      setModel('')
      setProviderId(null)
      setScoutModel(null)
      setScoutProviderId(null)
      setToolboxIds(null)
      setCompactingConfig(null)
      setThinkingConfig(null)
      setAvatarPreview(null)
      setWizardStep('describe')
      setWasAiGenerated(false)
      setWizardDescription('')

      // Pre-populate with default LLM model
      api.get<{ defaultLlmModel: string | null; defaultLlmProviderId: string | null }>('/settings/default-models')
        .then((data) => {
          if (data.defaultLlmModel) {
            setModel(data.defaultLlmModel)
            setProviderId(data.defaultLlmProviderId ?? null)
          }
        })
        .catch(() => {})
    }
    setAvatarFile(null)
    setError('')
    setActiveTab('general')
    setRefineText('')
    setIsGenerating(false)
    setIsRefining(false)
    setIsAvatarGenerating(false)
    resetDirty()
  }, [kin, defaultCharacter, defaultExpertise, resetDirty])

  /** Apply a generated config to the form fields */
  const applyGeneratedConfig = (config: GeneratedKinConfig) => {
    setName(config.name)
    setRole(config.role)
    setCharacter(config.character)
    setExpertise(config.expertise)

    // Apply suggested model if it exists in available models
    if (config.suggestedModel && llmModels.some((m) => m.id === config.suggestedModel)) {
      setModel(config.suggestedModel)
    }

    // Tool grants are managed exclusively through toolboxes. A Kin with no
    // toolbox selected has only the core floor — pick toolboxes in the Tools
    // tab to grant web/memory/projects/etc. (the resolver no longer treats an
    // empty selection as "all").

    markDirty()
  }

  /** Trigger background avatar generation from config fields */
  const triggerAvatarGeneration = (config: { name: string; role: string; character: string; expertise: string }) => {
    if (!hasImageCapability || !onGenerateAvatarPreviewFromConfig) return

    // Abort any previous avatar generation
    avatarAbortRef.current?.abort()
    const controller = new AbortController()
    avatarAbortRef.current = controller

    setIsAvatarGenerating(true)

    onGenerateAvatarPreviewFromConfig(config)
      .then((dataUrl) => {
        if (controller.signal.aborted) return
        setAvatarPreview(dataUrl)
        setAvatarFile(dataUrlToFile(dataUrl))
      })
      .catch(() => {
        // Silently ignore — user can generate manually
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsAvatarGenerating(false)
        }
      })
  }

  /** Handle wizard "Generate" button */
  const handleGenerate = async () => {
    if (!onGenerateKinConfig || !wizardDescription.trim()) return
    setIsGenerating(true)
    setError('')

    try {
      const config = await onGenerateKinConfig({
        description: wizardDescription.trim(),
        language: i18n.language,
      })

      applyGeneratedConfig(config)
      setWasAiGenerated(true)
      setWizardStep('form')

      // Trigger avatar generation in background
      triggerAvatarGeneration({
        name: config.name,
        role: config.role,
        character: config.character,
        expertise: config.expertise,
      })
    } catch {
      setError(t('kin.wizard.generateError'))
    } finally {
      setIsGenerating(false)
    }
  }

  /** Handle refine */
  const handleRefine = async () => {
    if (!onGenerateKinConfig || !refineText.trim()) return
    setIsRefining(true)
    setError('')

    try {
      const config = await onGenerateKinConfig({
        refinement: refineText.trim(),
        currentConfig: { name, role, character, expertise, model },
        language: i18n.language,
      })

      applyGeneratedConfig(config)
      setRefineText('')

      // Re-trigger avatar generation with updated config
      triggerAvatarGeneration({
        name: config.name,
        role: config.role,
        character: config.character,
        expertise: config.expertise,
      })
    } catch {
      setError(t('kin.wizard.generateError'))
    } finally {
      setIsRefining(false)
    }
  }

  const handleAvatarConfirm = (result: AvatarPickerResult) => {
    if (result.mode === 'upload') {
      setAvatarFile(result.file)
      setAvatarPreview(result.preview)
    } else {
      setAvatarFile(dataUrlToFile(result.url))
      setAvatarPreview(result.url)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      // Scout model/provider are coupled — a partial pair collapses to "inherit"
      // (null/null), mirroring the server's coupled-pair validation.
      const scoutBothSet = !!scoutModel && !!scoutProviderId
      const effectiveScoutModel = scoutBothSet ? scoutModel : null
      const effectiveScoutProviderId = scoutBothSet ? scoutProviderId : null
      if (isEdit && onUpdateKin) {
        // Normalize compactingConfig: if all fields are empty, send null to clear the override
        const effectiveCompactingConfig = (
          compactingConfig?.compactingModel != null ||
          compactingConfig?.compactingProviderId != null ||
          compactingConfig?.thresholdPercent != null ||
          compactingConfig?.keepPercent != null ||
          compactingConfig?.summaryBudgetPercent != null ||
          compactingConfig?.maxSummaries != null ||
          compactingConfig?.keepMaxTokens != null ||
          compactingConfig?.triggerMaxTokens != null ||
          compactingConfig?.summaryMaxTokens != null
        ) ? compactingConfig : null
        await onUpdateKin(kin.id, { name, slug, role, character, expertise, model, providerId, scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId, toolboxIds, compactingConfig: effectiveCompactingConfig, thinkingConfig })
        if (avatarFile) await onUploadAvatar(kin.id, avatarFile)
      } else if (onCreateKin) {
        const created = await onCreateKin({ name, slug: slug || undefined, role, character, expertise, model, providerId, scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId, toolboxIds })
        if (avatarFile) await onUploadAvatar(created.id, avatarFile)
      }
      resetDirty()
      onOpenChange(false)
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('common.error'))
    } finally {
      setIsLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!kin || !onDeleteKin) return
    setIsDeleting(true)
    try {
      await onDeleteKin(kin.id)
      onOpenChange(false)
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('common.error'))
    } finally {
      setIsDeleting(false)
    }
  }

  const initials = name.slice(0, 2).toUpperCase()

  // Wizard requires an LLM provider to generate the config server-side.
  // When none is configured we keep the wizard visible (so the user
  // sees what they're missing) but disable the Generate button and
  // surface an inline CTA pointing at Settings → Providers; the form
  // step is always reachable via 'Skip manual'.
  const hasLlm = useHasCapability('llm')
  const hasWizard = !!onGenerateKinConfig && !isEdit

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) guardedClose(); else onOpenChange(true) }}>
        <DialogContent
          className="flex h-[min(85vh,720px)] max-h-[85vh] flex-col overflow-hidden p-0 sm:max-w-5xl"
          onPointerDownOutside={(e) => {
            // Prevent parent dialog close when a nested dialog (e.g. MemoryFormDialog) is open
            if (document.querySelectorAll('[role="dialog"][data-state="open"]').length > 1) e.preventDefault()
          }}
          onInteractOutside={(e) => {
            if (document.querySelectorAll('[role="dialog"][data-state="open"]').length > 1) e.preventDefault()
          }}
          onFocusOutside={(e) => {
            if (document.querySelectorAll('[role="dialog"][data-state="open"]').length > 1) e.preventDefault()
          }}
        >
          {/* ─── WIZARD: Describe step ─── */}
          {hasWizard && wizardStep === 'describe' ? (
            <>
              <DialogHeader className="shrink-0 border-b px-6 py-4">
                <DialogTitle className="gradient-primary-text">
                  {t('kin.wizard.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {t('kin.wizard.title')}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-1 flex-col items-center overflow-y-auto px-8 py-10">
                <div className="m-auto w-full max-w-xl animate-fade-in-up space-y-6">
                  <p className="text-center text-muted-foreground">
                    {t('kin.wizard.subtitle')}
                  </p>

                  <Textarea
                    value={wizardDescription}
                    onChange={(e) => setWizardDescription(e.target.value)}
                    placeholder={t('kin.wizard.placeholder')}
                    className="gradient-border min-h-[120px] resize-none rounded-xl text-base"
                    style={{
                      backgroundImage:
                        'linear-gradient(color-mix(in oklch, var(--color-card) 80%, black), color-mix(in oklch, var(--color-card) 80%, black)), linear-gradient(135deg, var(--color-gradient-start), var(--color-gradient-mid), var(--color-gradient-end))',
                    }}
                    disabled={isGenerating}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && wizardDescription.trim()) {
                        handleGenerate()
                      }
                    }}
                  />

                  <FormErrorAlert error={error} animate />

                  {!hasLlm && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                      <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                          {t('kin.wizard.noLlm')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('kin.wizard.noLlmHint')}
                        </p>
                      </div>
                      {onOpenSettings && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => onOpenSettings('providers')}
                        >
                          {t('kin.wizard.noLlmAction')}
                        </Button>
                      )}
                    </div>
                  )}

                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".json,.kinbot.json"
                    className="hidden"
                    onChange={handleImportFile}
                  />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setWizardStep('form')}
                        disabled={isGenerating}
                      >
                        {t('kin.wizard.skipManual')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => importFileRef.current?.click()}
                        disabled={isGenerating}
                        className="text-xs"
                      >
                        <Upload className="size-3.5" />
                        {t('kin.wizard.importFile', { defaultValue: 'Import' })}
                      </Button>
                    </div>

                    <Button
                      type="button"
                      onClick={handleGenerate}
                      disabled={isGenerating || !wizardDescription.trim() || !hasLlm}
                      className="btn-shine gradient-primary text-white"
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          {t('kin.wizard.generating')}
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-4" />
                          {t('kin.wizard.generate')}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* ─── FORM: Standard create/edit ─── */}
              <DialogHeader className="shrink-0 border-b px-6 py-4">
                <DialogTitle>
                  {isEdit ? t('kin.edit.title') : t('kin.create.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {isEdit ? t('kin.edit.title') : t('kin.create.title')}
                </DialogDescription>
              </DialogHeader>

              <form onSubmit={handleSubmit} className="flex min-h-0 flex-1">
                {/* Left sidebar navigation */}
                <nav className="w-48 shrink-0 border-r surface-sidebar overflow-y-auto py-4 px-3">
                  <ul className="flex w-full min-w-0 flex-col gap-1">
                    {TABS.map(({ id, icon: Icon, labelKey }) => (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => setActiveTab(id)}
                          data-active={activeTab === id}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors',
                            'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                            activeTab === id
                              ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                              : 'text-sidebar-foreground',
                          )}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="truncate">{t(labelKey)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>

                {/* Right content area */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {error && (
                    <div className="shrink-0 px-6 pt-4">
                      <FormErrorAlert error={error} animate />
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto">
                    <div className="p-6">
                      {activeTab === 'general' && (
                        <div className="space-y-4">
                          {/* No-LLM banner — surfaces the constraint up-front
                              so the empty Model picker below is explained,
                              and points the user at Settings → Providers. */}
                          {!isEdit && !hasLlm && (
                            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                                  {t('kin.create.noLlm')}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {t('kin.create.noLlmHint')}
                                </p>
                              </div>
                              {onOpenSettings && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="shrink-0"
                                  onClick={() => onOpenSettings('providers')}
                                >
                                  {t('kin.wizard.noLlmAction')}
                                </Button>
                              )}
                            </div>
                          )}

                          {/* Refine bar — only for AI-generated configs in create
                              mode, and only while an LLM provider remains
                              configured (otherwise the refine call would 422). */}
                          {wasAiGenerated && !isEdit && hasLlm && (
                            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                              <Sparkles className="size-4 shrink-0 text-primary" />
                              <Input
                                value={refineText}
                                onChange={(e) => setRefineText(e.target.value)}
                                placeholder={t('kin.wizard.refinePlaceholder')}
                                className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                                disabled={isRefining}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && refineText.trim()) {
                                    e.preventDefault()
                                    handleRefine()
                                  }
                                }}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={handleRefine}
                                disabled={isRefining || !refineText.trim()}
                              >
                                {isRefining ? (
                                  <>
                                    <Loader2 className="size-3 animate-spin" />
                                    {t('kin.wizard.refining')}
                                  </>
                                ) : (
                                  t('kin.wizard.refineSubmit')
                                )}
                              </Button>
                            </div>
                          )}

                          {/* Avatar + Identity row */}
                          <div className="flex items-start gap-6">
                            {/* Avatar — click to open picker */}
                            <button
                              type="button"
                              onClick={() => setShowAvatarPicker(true)}
                              className="group relative shrink-0"
                            >
                              <Avatar className="size-20 ring-2 ring-border transition-all group-hover:ring-primary">
                                {isAvatarGenerating ? (
                                  <AvatarFallback className="text-base">
                                    <Loader2 className="size-6 animate-spin text-muted-foreground" />
                                  </AvatarFallback>
                                ) : avatarPreview ? (
                                  <AvatarImage src={avatarPreview} alt={name || 'Avatar'} />
                                ) : (
                                  <AvatarFallback className="text-base">
                                    {initials || <Camera className="size-6 text-muted-foreground" />}
                                  </AvatarFallback>
                                )}
                              </Avatar>
                              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                                <Camera className="size-5 text-white" />
                              </div>
                            </button>

                            {/* Name, Role & Model */}
                            <div className="flex-1 space-y-4">
                              <div className="grid grid-cols-3 gap-4">
                                <div className="space-y-2">
                                  <Label htmlFor="kinFormName" className="inline-flex items-center gap-1.5">{t('kin.create.name')} <span className="text-destructive">*</span> <InfoTip content={t('kin.create.nameTip')} /></Label>
                                  <Input
                                    id="kinFormName"
                                    value={name}
                                    onChange={(e) => { setName(e.target.value); markDirty() }}
                                    placeholder={t('kin.create.namePlaceholder')}
                                    required
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label htmlFor="kinFormRole" className="inline-flex items-center gap-1.5">{t('kin.create.role')} <span className="text-destructive">*</span> <InfoTip content={t('kin.create.roleTip')} /></Label>
                                  <Input
                                    id="kinFormRole"
                                    value={role}
                                    onChange={(e) => { setRole(e.target.value); markDirty() }}
                                    placeholder={t('kin.create.rolePlaceholder')}
                                    required
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label className="inline-flex items-center gap-1.5">{t('kin.create.model')} {!isEdit && <span className="text-destructive">*</span>} <InfoTip content={t('kin.create.modelTip')} /></Label>
                                  <ModelPicker
                                    models={llmModels}
                                    value={modelPickerValue(model, providerId ?? '')}
                                    onValueChange={(modelId, pid) => { setModel(modelId); setProviderId(pid || null); markDirty() }}
                                    placeholder={t('kin.create.modelPlaceholder')}
                                  />
                                </div>
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor="kinFormSlug">{t('kin.edit.slug')}</Label>
                                <Input
                                  id="kinFormSlug"
                                  value={slug}
                                  onChange={(e) => { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); markDirty() }}
                                  placeholder={t('kin.create.slugPlaceholder')}
                                />
                                <p className="text-xs text-muted-foreground">
                                  {isEdit ? t('kin.edit.slugHelp') : t('kin.create.slugHelpCreate', { defaultValue: 'Optional. Auto-generated from the name if left empty.' })}
                                </p>
                              </div>
                            </div>
                          </div>

                          {/* Character */}
                          <div className="space-y-2">
                            <Label className="inline-flex items-center gap-1.5">{t('kin.create.character')} <InfoTip content={t('kin.create.characterTip')} /></Label>
                            <MarkdownEditor
                              value={character}
                              onChange={(v) => { setCharacter(v); markDirty() }}
                              height="180px"
                            />
                            <div className="flex items-center justify-between">
                              <p className="text-xs text-muted-foreground">{t('kin.create.characterHint')}</p>
                              <p className="text-xs text-muted-foreground tabular-nums">~{Math.ceil(character.length / 4)} tokens</p>
                            </div>
                          </div>

                          {/* Expertise */}
                          <div className="space-y-2">
                            <Label className="inline-flex items-center gap-1.5">{t('kin.create.expertise')} <InfoTip content={t('kin.create.expertiseTip')} /></Label>
                            <MarkdownEditor
                              value={expertise}
                              onChange={(v) => { setExpertise(v); markDirty() }}
                              height="180px"
                            />
                            <div className="flex items-center justify-between">
                              <p className="text-xs text-muted-foreground">{t('kin.create.expertiseHint')}</p>
                              <p className="text-xs text-muted-foreground tabular-nums">~{Math.ceil(expertise.length / 4)} tokens</p>
                            </div>
                          </div>

                          {/* Total system prompt token estimate */}
                          {(character.length > 0 || expertise.length > 0) && (
                            <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground/70 pt-1 border-t border-border/40">
                              <span>{t('kin.create.totalPromptTokens', { tokens: Math.ceil((character.length + expertise.length) / 4) })}</span>
                            </div>
                          )}

                          {/* Scout model — cheap, fast model the `scout` tool
                              delegates heavy read-only exploration to. Clearing
                              it (the "inherit" option) falls back to the
                              project → global → main-model chain. */}
                          <div className="space-y-2 border-t border-border/40 pt-4">
                            <Label className="inline-flex items-center gap-1.5">
                              {t('kin.create.scoutModel')}
                              <InfoTip content={t('kin.create.scoutModelTip')} />
                            </Label>
                            <ModelPicker
                              models={llmModels}
                              value={modelPickerValue(scoutModel ?? '', scoutProviderId ?? '')}
                              onValueChange={(modelId, pid) => {
                                setScoutModel(modelId || null)
                                setScoutProviderId(pid || null)
                                markDirty()
                              }}
                              placeholder={t('kin.create.scoutModelInherit')}
                              allowClear
                              clearLabel={t('kin.create.scoutModelInherit')}
                            />
                            <p className="text-xs text-muted-foreground">{t('kin.create.scoutModelHint')}</p>
                          </div>

                        </div>
                      )}

                      {activeTab === 'tools' && (
                        <KinToolsTab
                          kinId={isEdit ? kin.id : null}
                          toolboxIds={toolboxIds}
                          onToolboxIdsChange={(next) => { setToolboxIds(next); markDirty() }}
                        />
                      )}

                      {activeTab === 'memory' && isEdit && (
                        <div className="space-y-6">
                          <MemoryList kinId={kin.id} compact />
                        </div>
                      )}

                      {activeTab === 'compaction' && isEdit && (
                        <div className="space-y-3">
                          <Label className="inline-flex items-center gap-1.5 text-sm font-medium">
                            <Archive className="size-4" />
                            {t('kin.compacting.title')}
                          </Label>

                          {/* Animated visualization */}
                          <CompactingAnimation />

                          <p className="text-xs text-muted-foreground">{t('kin.compacting.overrideHint')}</p>

                          {/* Compacting model — 3-way selector */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.modelLabel')}</Label>
                            <Select
                              value={
                                compactingConfig?.compactingModel == null ? 'default'
                                : compactingConfig.compactingModel === '__kin_own__' ? 'kin_own'
                                : 'custom'
                              }
                              onValueChange={(mode) => {
                                if (mode === 'default') {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: null, compactingProviderId: null })
                                } else if (mode === 'kin_own') {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: '__kin_own__', compactingProviderId: null })
                                } else {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: '', compactingProviderId: null })
                                }
                                markDirty()
                              }}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">{t('kin.compacting.modeDefault')}</SelectItem>
                                <SelectItem value="kin_own">{t('kin.compacting.modeKinOwn')}</SelectItem>
                                <SelectItem value="custom">{t('kin.compacting.modeCustom')}</SelectItem>
                              </SelectContent>
                            </Select>
                            {compactingConfig?.compactingModel != null && compactingConfig.compactingModel !== '__kin_own__' && (
                              <ModelPicker
                                models={llmModels}
                                value={modelPickerValue(compactingConfig.compactingModel, compactingConfig.compactingProviderId ?? '')}
                                onValueChange={(modelId, pid) => {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: modelId || null, compactingProviderId: pid || null })
                                  markDirty()
                                }}
                                placeholder={t('kin.compacting.selectCustomModel')}
                              />
                            )}
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.modelHint')}</p>
                          </div>

                          {/* Threshold percent */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.thresholdPercentLabel')}</Label>
                            <Input
                              type="number"
                              min={50}
                              max={95}
                              step={5}
                              placeholder={t('kin.compacting.thresholdPercentPlaceholder', { default: 75 })}
                              value={compactingConfig?.thresholdPercent ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, thresholdPercent: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.thresholdPercentHint')}</p>
                          </div>

                          {/* Keep percent */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.keepPercentLabel')}</Label>
                            <Input
                              type="number"
                              min={20}
                              max={80}
                              step={5}
                              placeholder={t('kin.compacting.keepPercentPlaceholder', { default: 25 })}
                              value={compactingConfig?.keepPercent ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, keepPercent: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.keepPercentHint')}</p>
                          </div>

                          {/* Summary budget percent */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.summaryBudgetLabel')}</Label>
                            <Input
                              type="number"
                              min={5}
                              max={50}
                              step={5}
                              placeholder={t('kin.compacting.summaryBudgetPlaceholder', { default: 20 })}
                              value={compactingConfig?.summaryBudgetPercent ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, summaryBudgetPercent: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.summaryBudgetHint')}</p>
                          </div>

                          {/* Max summaries */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.maxSummariesLabel')}</Label>
                            <Input
                              type="number"
                              min={3}
                              max={50}
                              step={1}
                              placeholder={t('kin.compacting.maxSummariesPlaceholder', { default: 10 })}
                              value={compactingConfig?.maxSummaries ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, maxSummaries: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.maxSummariesHint')}</p>
                          </div>

                          {/* Absolute token ceilings — bound the real footprint on large-window
                              models (e.g. 1M), where the percentages above would otherwise be huge. */}
                          <div className="pt-1">
                            <p className="text-xs font-medium">{t('kin.compacting.absoluteCapsTitle')}</p>
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.absoluteCapsHint')}</p>
                          </div>

                          {/* Keep max tokens */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.keepMaxTokensLabel')}</Label>
                            <Input
                              type="number"
                              min={20000}
                              max={500000}
                              step={10000}
                              placeholder={t('kin.compacting.keepMaxTokensPlaceholder', { default: 100000 })}
                              value={compactingConfig?.keepMaxTokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, keepMaxTokens: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.keepMaxTokensHint')}</p>
                          </div>

                          {/* Trigger max tokens */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.triggerMaxTokensLabel')}</Label>
                            <Input
                              type="number"
                              min={50000}
                              max={1000000}
                              step={25000}
                              placeholder={t('kin.compacting.triggerMaxTokensPlaceholder', { default: 300000 })}
                              value={compactingConfig?.triggerMaxTokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, triggerMaxTokens: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.triggerMaxTokensHint')}</p>
                          </div>

                          {/* Summary max tokens */}
                          <div className="space-y-1.5">
                            <Label className="text-xs">{t('kin.compacting.summaryMaxTokensLabel')}</Label>
                            <Input
                              type="number"
                              min={8000}
                              max={200000}
                              step={8000}
                              placeholder={t('kin.compacting.summaryMaxTokensPlaceholder', { default: 48000 })}
                              value={compactingConfig?.summaryMaxTokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, summaryMaxTokens: val })
                                markDirty()
                              }}
                            />
                            <p className="text-[10px] text-muted-foreground">{t('kin.compacting.summaryMaxTokensHint')}</p>
                          </div>
                        </div>
                      )}

                      {activeTab === 'compaction' && !isEdit && (
                        <EmptyState
                          minimal
                          icon={Archive}
                          title={t('kin.create.compactionEmptyTitle')}
                          description={t('kin.create.compactionEmptyDescription')}
                        />
                      )}

                      {activeTab === 'memory' && !isEdit && (
                        <EmptyState
                          minimal
                          icon={Brain}
                          title={t('kin.create.memoryEmptyTitle')}
                          description={t('kin.create.memoryEmptyDescription')}
                        />
                      )}

                      {/* ── Thinking tab ────────────────────────── */}
                      {activeTab === 'thinking' && isEdit && (
                        <div className="space-y-4">
                          <div className="flex items-center gap-2">
                            <Sparkles className="size-4 text-chart-4" />
                            <h3 className="text-sm font-medium">{t('kin.thinking.title')}</h3>
                          </div>

                          <p className="text-xs text-muted-foreground">{t('kin.thinking.description')}</p>

                          <div className="flex items-center justify-between">
                            <Label htmlFor="thinking-enabled">{t('kin.thinking.enableLabel')}</Label>
                            <Switch
                              id="thinking-enabled"
                              checked={thinkingConfig?.enabled ?? false}
                              onCheckedChange={(checked) => {
                                setThinkingConfig({ ...thinkingConfig, enabled: checked })
                                markDirty()
                              }}
                            />
                          </div>

                          {thinkingConfig?.enabled && (
                            <div className="space-y-1.5">
                              <Label htmlFor="thinking-budget">{t('kin.thinking.budgetLabel')}</Label>
                              <Input
                                id="thinking-budget"
                                type="number"
                                min={1024}
                                step={1024}
                                placeholder={t('kin.thinking.budgetPlaceholder')}
                                value={thinkingConfig?.budgetTokens ?? ''}
                                onChange={(e) => {
                                  const val = e.target.value ? Number(e.target.value) : null
                                  setThinkingConfig({ ...thinkingConfig, enabled: true, budgetTokens: val })
                                  markDirty()
                                }}
                              />
                              <p className="text-[10px] text-muted-foreground">{t('kin.thinking.budgetHint')}</p>
                            </div>
                          )}
                        </div>
                      )}

                      {activeTab === 'thinking' && !isEdit && (
                        <EmptyState
                          minimal
                          icon={Sparkles}
                          title={t('kin.create.thinkingEmptyTitle')}
                          description={t('kin.create.thinkingEmptyDescription')}
                        />
                      )}
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="shrink-0 border-t px-6 py-3">
                    {isEdit ? (
                      <div className="flex items-center justify-between">
                        <ConfirmDeleteButton
                          onConfirm={handleDelete}
                          title={t('kin.settings.delete')}
                          description={t('kin.settings.deleteConfirm')}
                          confirmLabel={t('kin.settings.deleteAction')}
                          trigger={
                            <Button type="button" variant="destructive" size="sm" disabled={isDeleting}>
                              <Trash2 className="size-4" />
                              {t('kin.settings.delete')}
                            </Button>
                          }
                        />

                        <Button type="submit" disabled={isLoading || !name || !role} className="btn-shine">
                          {isLoading ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              {t('common.loading')}
                            </>
                          ) : (
                            t('kin.settings.save')
                          )}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        {hasWizard ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setWizardStep('describe')}
                          >
                            <ArrowLeft className="size-4" />
                            {t('kin.wizard.back')}
                          </Button>
                        ) : (
                          <div />
                        )}
                        <Button
                          type="submit"
                          disabled={isLoading || !name || !role || !model}
                          className="btn-shine"
                          size="lg"
                        >
                          {isLoading ? (
                            <>
                              <Loader2 className="size-4 animate-spin" />
                              {t('common.loading')}
                            </>
                          ) : (
                            t('kin.create.submit')
                          )}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Avatar picker modal */}
      <AvatarPickerModal
        open={showAvatarPicker}
        onOpenChange={setShowAvatarPicker}
        currentAvatar={avatarPreview}
        kinName={name}
        kinId={isEdit ? kin?.id ?? null : null}
        hasImageCapability={hasImageCapability}
        imageModels={imageModels}
        onGenerateAvatarPreview={onGenerateAvatarPreview}
        onConfirm={handleAvatarConfirm}
        onOpenSettings={onOpenSettings}
      />

      {/* Unsaved changes confirmation */}
      <UnsavedChangesDialog {...confirmDialogProps} />
    </>
  )
}
