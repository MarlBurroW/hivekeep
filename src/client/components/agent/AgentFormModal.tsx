import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { FormField } from '@/client/components/common/FormField'
import { AvatarPickerModal, type AvatarPickerResult } from '@/client/components/agent/AvatarPickerModal'
import { AgentToolsTab } from '@/client/components/agent/AgentToolsTab'
import { CompactingAnimation } from '@/client/components/agent/CompactingAnimation'
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
import { UnsavedChangesDialog } from '@/client/components/common/UnsavedChangesDialog'
import { useUnsavedChanges } from '@/client/hooks/useUnsavedChanges'
import { useSSE } from '@/client/hooks/useSSE'
import { useAuth } from '@/client/hooks/useAuth'
import { useHasCapability } from '@/client/hooks/useHasCapability'
import { cn } from '@/client/lib/utils'
import { api, getErrorMessage, toastError } from '@/client/lib/api'
import type { AgentCompactingConfig, AgentThinkingConfig } from '@/shared/types'
import type { GeneratedAgentConfig } from '@/client/hooks/useAgents'
import type { ProviderModel } from '@/client/hooks/useModels'
import { modelReasoningInfo, clampEffort } from '@/client/lib/model-efforts'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { configToChoice, choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'

type Model = ProviderModel

interface AgentDetail {
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
  scoutThinkingConfig?: AgentThinkingConfig | null
  toolboxIds?: string[] | null
  /** Individual tool grants on top of toolboxes (incl. approved
   *  request_tool_access requests). Null/[] → none. */
  extraToolNames?: string[] | null
  compactingConfig?: AgentCompactingConfig | null
  thinkingConfig?: AgentThinkingConfig | null
}

interface AgentFormModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tab to land on when the modal opens (e.g. 'tools' from the composer's
   *  tools badge). Defaults to 'general'. */
  initialTab?: 'general' | 'tools' | 'memory' | 'compaction' | 'thinking'
  llmModels: Model[]
  imageModels?: Model[]
  onUploadAvatar: (agentId: string, file: File) => Promise<string>
  onGenerateAvatarPreview?: (
    agentId: string,
    mode: 'auto' | 'manual',
    opts?: { style?: string; subject?: string; character?: string; useBase?: boolean },
    imageModel?: { providerId: string; modelId: string },
  ) => Promise<string>
  hasImageCapability?: boolean
  // Mode create
  onCreateAgent?: (data: {
    name: string
    slug?: string
    role: string
    character: string
    expertise: string
    model: string
    providerId?: string | null
    scoutModel?: string | null
    scoutProviderId?: string | null
    scoutThinkingConfig?: AgentThinkingConfig | null
    toolboxIds?: string[] | null
  }) => Promise<{ id: string }>
  // Mode edit
  agent?: AgentDetail | null
  onUpdateAgent?: (id: string, data: Record<string, unknown>) => Promise<unknown>
  onDeleteAgent?: (id: string) => Promise<void>
  // Wizard helpers
  onGenerateAgentConfig?: (data: {
    description?: string
    refinement?: string
    currentConfig?: Record<string, unknown>
    language?: string
    model?: string
    providerId?: string | null
  }) => Promise<GeneratedAgentConfig>
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
  { id: 'general', icon: Settings, labelKey: 'agent.tabs.general' },
  { id: 'tools', icon: Wrench, labelKey: 'agent.tabs.tools' },
  { id: 'memory', icon: Brain, labelKey: 'agent.tabs.memory' },
  { id: 'compaction', icon: Archive, labelKey: 'agent.tabs.compaction' },
  { id: 'thinking', icon: Sparkles, labelKey: 'agent.tabs.thinking' },
]

/** Normalize a compacting config: if every field is empty, collapse to null so
 *  the override is cleared. Mirrors the server's coupled-pair handling. */
function normalizeCompactingConfig(config: AgentCompactingConfig | null): AgentCompactingConfig | null {
  if (!config) return null
  const hasAny =
    config.compactingModel != null ||
    config.compactingProviderId != null ||
    config.thresholdPercent != null ||
    config.keepPercent != null ||
    config.summaryBudgetPercent != null ||
    config.maxSummaries != null ||
    config.keepMaxTokens != null ||
    config.triggerMaxTokens != null ||
    config.summaryMaxTokens != null
  return hasAny ? config : null
}

/** Scout model/provider are coupled — a partial pair collapses to "inherit"
 *  (null/null), mirroring the server's coupled-pair validation. */
function normalizeScoutPair(scoutModel: string | null, scoutProviderId: string | null) {
  const bothSet = !!scoutModel && !!scoutProviderId
  return {
    scoutModel: bothSet ? scoutModel : null,
    scoutProviderId: bothSet ? scoutProviderId : null,
  }
}

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

/** Shell around the body+footer. CREATE mode wraps everything in a single
 *  layout-transparent form (so the footer's submit button POSTs all fields).
 *  EDIT mode renders the children directly — each tab supplies its own form. */
function FormShell({
  isEdit,
  onCreateSubmit,
  children,
}: {
  isEdit: boolean
  onCreateSubmit: (e: React.FormEvent) => void
  children: React.ReactNode
}) {
  if (isEdit) return <>{children}</>
  return (
    <form onSubmit={onCreateSubmit} className="contents">
      {children}
    </form>
  )
}

/** A single tab's content wrapper. In EDIT mode it is a form whose submit does
 *  a partial PATCH; in CREATE mode it's a plain div (the outer create form owns
 *  submission). Tab-switch nav buttons stay type="button" and live outside. */
function TabForm({
  isEdit,
  onSubmit,
  className,
  children,
}: {
  isEdit: boolean
  onSubmit: (e: React.FormEvent) => void
  className?: string
  children: React.ReactNode
}) {
  if (isEdit) {
    return (
      <form onSubmit={onSubmit} className={className}>
        {children}
      </form>
    )
  }
  return <div className={className}>{children}</div>
}

export function AgentFormModal({
  open,
  onOpenChange,
  initialTab,
  llmModels,
  imageModels,
  onUploadAvatar,
  onGenerateAvatarPreview,
  hasImageCapability = false,
  onCreateAgent,
  agent,
  onUpdateAgent,
  onDeleteAgent,
  onGenerateAgentConfig,
  onGenerateAvatarPreviewFromConfig,
  onOpenSettings,
}: AgentFormModalProps) {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()

  const isEdit = !!agent
  const defaultCharacter = t('agent.defaults.character')
  const defaultExpertise = t('agent.defaults.expertise')

  // Unsaved changes guard
  const { markDirty, resetDirty, guardedClose, confirmDialogProps } = useUnsavedChanges({
    onClose: () => onOpenChange(false),
  })

  // Wizard state
  const [wizardStep, setWizardStep] = useState<WizardStep>(isEdit ? 'form' : 'describe')
  const [wizardDescription, setWizardDescription] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [wasAiGenerated, setWasAiGenerated] = useState(false)
  const [isAvatarGenerating, setIsAvatarGenerating] = useState(false)
  // Model used to GENERATE the config (separate from the Agent's runtime model
  // chosen in the General tab). Defaults to the platform default LLM model;
  // shown in the wizard so the user can see and change it before generating.
  const [genModel, setGenModel] = useState('')
  const [genProviderId, setGenProviderId] = useState<string | null>(null)

  // Refine state
  const [refineText, setRefineText] = useState('')
  const [isRefining, setIsRefining] = useState(false)

  // Form state
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? 'general')

  // Land on the requested tab each time the modal opens.
  useEffect(() => {
    if (open) setActiveTab(initialTab ?? 'general')
  }, [open, initialTab])
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [role, setRole] = useState('')
  const [character, setCharacter] = useState(defaultCharacter)
  const [expertise, setExpertise] = useState(defaultExpertise)
  const [model, setModel] = useState('')
  const [providerId, setProviderId] = useState<string | null>(null)
  const [scoutModel, setScoutModel] = useState<string | null>(null)
  const [scoutProviderId, setScoutProviderId] = useState<string | null>(null)
  // 'inherit' = unset tier (scouts fall back to project/global/Agent config)
  const [scoutThinking, setScoutThinking] = useState<ThinkingChoice>('inherit')
  const [toolboxIds, setToolboxIds] = useState<string[] | null>(null)
  const [extraToolNames, setExtraToolNames] = useState<string[] | null>(null)
  const [compactingConfig, setCompactingConfig] = useState<AgentCompactingConfig | null>(null)
  const [thinkingConfig, setThinkingConfig] = useState<AgentThinkingConfig | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Per-tab dirty tracking (edit mode). Each tab compares its current field
  // values to a snapshot captured on load / after its own save, so a partial
  // save only marks THAT tab clean and the close-guard combines all tabs.
  const [initialGeneral, setInitialGeneral] = useState('')
  const [initialToolboxIds, setInitialToolboxIds] = useState('')
  const [initialExtraTools, setInitialExtraTools] = useState('')
  const [initialCompacting, setInitialCompacting] = useState('')
  const [initialThinking, setInitialThinking] = useState('')

  // Per-tab saving state (edit mode partial saves)
  const [savingGeneral, setSavingGeneral] = useState(false)
  const [savingTools, setSavingTools] = useState(false)
  const [savingCompaction, setSavingCompaction] = useState(false)
  const [savingThinking, setSavingThinking] = useState(false)

  // Serialized "current" values per tab — compared to the snapshots above to
  // derive dirtiness. The avatar is part of the General tab (a changed file
  // counts as a General edit even though the text fields match).
  const currentGeneral = useMemo(
    () => {
      const { scoutModel: sm, scoutProviderId: sp } = normalizeScoutPair(scoutModel, scoutProviderId)
      return JSON.stringify({ name, slug, role, model, providerId, scoutModel: sm, scoutProviderId: sp, scoutThinking, character, expertise })
    },
    [name, slug, role, model, providerId, scoutModel, scoutProviderId, scoutThinking, character, expertise],
  )
  const currentToolboxIds = useMemo(() => JSON.stringify(toolboxIds ?? null), [toolboxIds])
  const currentExtraTools = useMemo(() => JSON.stringify(extraToolNames ?? null), [extraToolNames])
  const currentCompacting = useMemo(() => JSON.stringify(normalizeCompactingConfig(compactingConfig)), [compactingConfig])
  const currentThinking = useMemo(() => JSON.stringify(thinkingConfig ?? null), [thinkingConfig])

  // Reasoning support of the Agent's CURRENT model (form state, so switching
  // the model in the General tab immediately re-scopes the effort options).
  // Model not in the catalogue -> 'unknown' -> generic ladder (fail-open).
  const agentModelReasoning = useMemo(
    () => modelReasoningInfo(llmModels.find((m) => m.id === model && (!providerId || m.providerId === providerId))),
    [model, providerId, llmModels],
  )
  // Clamp a stored effort the newly selected model can't reach.
  useEffect(() => {
    if (!thinkingConfig?.enabled || !thinkingConfig.effort) return
    if (agentModelReasoning.kind !== 'levels') return
    if (agentModelReasoning.efforts.includes(thinkingConfig.effort)) return
    const clamped = clampEffort(thinkingConfig.effort, agentModelReasoning)
    if (clamped) {
      setThinkingConfig({ enabled: true, effort: clamped })
      markDirty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentModelReasoning])

  const generalDirty = currentGeneral !== initialGeneral || avatarFile != null
  const toolsDirty = currentToolboxIds !== initialToolboxIds || currentExtraTools !== initialExtraTools
  const compactionDirty = currentCompacting !== initialCompacting
  const thinkingDirty = currentThinking !== initialThinking
  const anyDirty = generalDirty || toolsDirty || compactionDirty || thinkingDirty

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
        setError(t('agent.invalidJsonFile'))
      }
    }
    reader.readAsText(file)
    // Reset the input so the same file can be re-imported
    e.target.value = ''
  }

  // Sync form when agent changes (edit mode) or reset for create mode
  useEffect(() => {
    if (agent) {
      setName(agent.name)
      setSlug(agent.slug)
      setRole(agent.role)
      setCharacter(agent.character)
      setExpertise(agent.expertise)
      setModel(agent.model)
      setProviderId(agent.providerId ?? null)
      setScoutModel(agent.scoutModel ?? null)
      setScoutProviderId(agent.scoutProviderId ?? null)
      setScoutThinking(configToChoice(agent.scoutThinkingConfig ?? null))
      setToolboxIds(agent.toolboxIds ?? null)
      // Normalize []/null → null so dirty-tracking compares stably.
      const loadedExtras = agent.extraToolNames && agent.extraToolNames.length > 0 ? agent.extraToolNames : null
      setExtraToolNames(loadedExtras)
      setCompactingConfig(agent.compactingConfig ?? null)
      setThinkingConfig(agent.thinkingConfig ?? null)
      setAvatarPreview(agent.avatarUrl)
      setWizardStep('form')
      setWasAiGenerated(false)

      // Capture per-tab snapshots so each tab can derive its own dirtiness.
      const loadedScout = normalizeScoutPair(agent.scoutModel ?? null, agent.scoutProviderId ?? null)
      const loadedScoutThinking = configToChoice(agent.scoutThinkingConfig ?? null)
      setInitialGeneral(JSON.stringify({
        name: agent.name,
        slug: agent.slug,
        role: agent.role,
        model: agent.model,
        providerId: agent.providerId ?? null,
        scoutModel: loadedScout.scoutModel,
        scoutProviderId: loadedScout.scoutProviderId,
        scoutThinking: loadedScoutThinking,
        character: agent.character,
        expertise: agent.expertise,
      }))
      setInitialToolboxIds(JSON.stringify(agent.toolboxIds ?? null))
      setInitialExtraTools(JSON.stringify(loadedExtras))
      setInitialCompacting(JSON.stringify(normalizeCompactingConfig(agent.compactingConfig ?? null)))
      setInitialThinking(JSON.stringify(agent.thinkingConfig ?? null))
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
      setExtraToolNames(null)
      setCompactingConfig(null)
      setThinkingConfig(null)
      setAvatarPreview(null)
      setWizardStep('describe')
      setWasAiGenerated(false)
      setWizardDescription('')

      // Reset per-tab snapshots (unused in create mode, which relies on the
      // single-submit flow + markDirty, but kept consistent for cleanliness).
      setInitialGeneral('')
      setInitialToolboxIds('')
      setInitialExtraTools('')
      setInitialCompacting('')
      setInitialThinking('')

      // Pre-populate with default LLM model — both the Agent's runtime model
      // and the wizard's generation model.
      api.get<{ defaultLlmModel: string | null; defaultLlmProviderId: string | null }>('/settings/default-models')
        .then((data) => {
          if (data.defaultLlmModel) {
            setModel(data.defaultLlmModel)
            setProviderId(data.defaultLlmProviderId ?? null)
            setGenModel(data.defaultLlmModel)
            setGenProviderId(data.defaultLlmProviderId ?? null)
          }
        })
        .catch(() => {})
    }
    setAvatarFile(null)
    setError('')
    // Honour the caller-requested landing tab — this effect fires when `agent`
    // lands (after the open-effect) and used to clobber it back to 'general'.
    setActiveTab(initialTab ?? 'general')
    setRefineText('')
    setIsGenerating(false)
    setIsRefining(false)
    setIsAvatarGenerating(false)
    resetDirty()
  }, [agent, defaultCharacter, defaultExpertise, resetDirty, initialTab])

  // No default LLM model configured: fall back to the first available model so
  // the wizard always shows a concrete, account-valid generation model (never
  // a blind newest-first pick that might 404).
  useEffect(() => {
    if (genModel || llmModels.length === 0) return
    const first = llmModels[0]
    if (!first) return
    setGenModel(first.id)
    setGenProviderId(first.providerId)
  }, [genModel, llmModels])

  // In edit mode the close-guard is driven by the combined per-tab dirtiness
  // (derived from snapshots), so a per-tab save clears it for that tab without
  // any explicit resetDirty call. Create mode keeps using markDirty directly.
  useEffect(() => {
    if (!isEdit) return
    if (anyDirty) markDirty()
    else resetDirty()
  }, [isEdit, anyDirty, markDirty, resetDirty])

  // A request_tool_access grant approved while this modal is open lands in
  // agents.extra_tool_names server-side — reflect it live in the Tools tab.
  // Skipped when the user has unsaved local edits to the grants (their pending
  // edit wins; saving PATCHes their full array). When the modal is closed this
  // component is unmounted, and the fetch-on-open covers the catch-up.
  useSSE({
    'agent:tools-granted': (data) => {
      if (!isEdit || !agent || data.agentId !== agent.id) return
      if (currentExtraTools !== initialExtraTools) return
      const next = Array.isArray(data.extraToolNames)
        ? (data.extraToolNames as string[]).filter((n): n is string => typeof n === 'string')
        : []
      const normalized = next.length > 0 ? next : null
      setExtraToolNames(normalized)
      setInitialExtraTools(JSON.stringify(normalized))
    },
  })

  /** Apply a generated config to the form fields */
  const applyGeneratedConfig = (config: GeneratedAgentConfig) => {
    setName(config.name)
    setRole(config.role)
    setCharacter(config.character)
    setExpertise(config.expertise)

    // Apply suggested model if it exists in available models
    if (config.suggestedModel && llmModels.some((m) => m.id === config.suggestedModel)) {
      setModel(config.suggestedModel)
    }

    // Tool grants are managed exclusively through toolboxes. An Agent with no
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
    if (!onGenerateAgentConfig || !wizardDescription.trim()) return
    setIsGenerating(true)
    setError('')

    try {
      const config = await onGenerateAgentConfig({
        description: wizardDescription.trim(),
        language: user?.agentLanguage ?? i18n.language,
        ...(genModel ? { model: genModel, providerId: genProviderId } : {}),
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
      setError(t('agent.wizard.generateError'))
    } finally {
      setIsGenerating(false)
    }
  }

  /** Handle refine */
  const handleRefine = async () => {
    if (!onGenerateAgentConfig || !refineText.trim()) return
    setIsRefining(true)
    setError('')

    try {
      const config = await onGenerateAgentConfig({
        refinement: refineText.trim(),
        currentConfig: { name, role, character, expertise, model },
        language: user?.agentLanguage ?? i18n.language,
        ...(genModel ? { model: genModel, providerId: genProviderId } : {}),
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
      setError(t('agent.wizard.generateError'))
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

  /** Create-mode submit — POSTs every field at once, then uploads the avatar.
   *  Edit mode uses the per-tab partial-save handlers below instead. */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!onCreateAgent) return
    setError('')
    setIsLoading(true)

    try {
      const { scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId } = normalizeScoutPair(scoutModel, scoutProviderId)
      const created = await onCreateAgent({ name, slug: slug || undefined, role, character, expertise, model, providerId, scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId, scoutThinkingConfig: choiceToConfig(scoutThinking), toolboxIds })
      if (avatarFile) await onUploadAvatar(created.id, avatarFile)
      resetDirty()
      onOpenChange(false)
    } catch (err: unknown) {
      setError(getErrorMessage(err) || t('common.error'))
    } finally {
      setIsLoading(false)
    }
  }

  // ─── Per-tab partial-save handlers (edit mode) ───
  // Each PATCHes only its own fields, marks its tab clean (by re-snapshotting),
  // and toasts on success. None of them close the modal.

  const handleSaveGeneral = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isEdit || !agent || !onUpdateAgent) return
    setError('')
    setSavingGeneral(true)
    try {
      const { scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId } = normalizeScoutPair(scoutModel, scoutProviderId)
      await onUpdateAgent(agent.id, { name, slug, role, model, providerId, scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId, scoutThinkingConfig: choiceToConfig(scoutThinking), character, expertise })
      if (avatarFile) {
        await onUploadAvatar(agent.id, avatarFile)
        setAvatarFile(null)
      }
      // Re-snapshot so this tab is clean (using the normalized scout pair).
      setInitialGeneral(JSON.stringify({ name, slug, role, model, providerId, scoutModel: effectiveScoutModel, scoutProviderId: effectiveScoutProviderId, scoutThinking, character, expertise }))
      setScoutModel(effectiveScoutModel)
      setScoutProviderId(effectiveScoutProviderId)
      toast.success(t('agent.settings.tabSaved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingGeneral(false)
    }
  }

  const handleSaveTools = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isEdit || !agent || !onUpdateAgent) return
    setError('')
    setSavingTools(true)
    try {
      await onUpdateAgent(agent.id, { toolboxIds, extraToolNames })
      setInitialToolboxIds(JSON.stringify(toolboxIds ?? null))
      setInitialExtraTools(JSON.stringify(extraToolNames ?? null))
      toast.success(t('agent.settings.tabSaved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingTools(false)
    }
  }

  const handleSaveCompaction = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isEdit || !agent || !onUpdateAgent) return
    setError('')
    setSavingCompaction(true)
    try {
      const effectiveCompactingConfig = normalizeCompactingConfig(compactingConfig)
      await onUpdateAgent(agent.id, { compactingConfig: effectiveCompactingConfig })
      setInitialCompacting(JSON.stringify(effectiveCompactingConfig))
      toast.success(t('agent.settings.tabSaved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingCompaction(false)
    }
  }

  const handleSaveThinking = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isEdit || !agent || !onUpdateAgent) return
    setError('')
    setSavingThinking(true)
    try {
      await onUpdateAgent(agent.id, { thinkingConfig })
      setInitialThinking(JSON.stringify(thinkingConfig ?? null))
      toast.success(t('agent.settings.tabSaved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSavingThinking(false)
    }
  }

  const handleDelete = async () => {
    if (!agent || !onDeleteAgent) return
    setIsDeleting(true)
    try {
      await onDeleteAgent(agent.id)
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
  const hasWizard = !!onGenerateAgentConfig && !isEdit

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) guardedClose(); else onOpenChange(true) }}>
        <DialogContent
          variant="panel"
          size="5xl"
          className="h-[min(85vh,720px)] max-h-[85vh]"
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
              <DialogHeader>
                <DialogTitle className="gradient-primary-text">
                  {t('agent.wizard.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {t('agent.wizard.title')}
                </DialogDescription>
              </DialogHeader>

              <DialogBody className="flex flex-col items-center">
                <div className="m-auto w-full max-w-xl animate-fade-in-up space-y-6">
                  <p className="text-center text-muted-foreground">
                    {t('agent.wizard.subtitle')}
                  </p>

                  <Textarea
                    value={wizardDescription}
                    onChange={(e) => setWizardDescription(e.target.value)}
                    placeholder={t('agent.wizard.placeholder')}
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

                  {hasLlm && (
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('agent.wizard.genModelLabel')}
                      </label>
                      <ModelPicker
                        models={llmModels}
                        value={modelPickerValue(genModel, genProviderId ?? '')}
                        onValueChange={(modelId, pid) => { setGenModel(modelId); setGenProviderId(pid || null) }}
                        placeholder={t('agent.wizard.genModelPlaceholder')}
                        disabled={isGenerating}
                        isLoading={llmModels.length === 0}
                      />
                    </div>
                  )}

                  <FormErrorAlert error={error} animate />

                  {!hasLlm && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                      <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                          {t('agent.wizard.noLlm')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t('agent.wizard.noLlmHint')}
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
                          {t('agent.wizard.noLlmAction')}
                        </Button>
                      )}
                    </div>
                  )}

                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".json,.gezy.json"
                    className="hidden"
                    onChange={handleImportFile}
                  />
                </div>
              </DialogBody>

              <DialogFooter className="flex-row items-center justify-between sm:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setWizardStep('form')}
                    disabled={isGenerating}
                  >
                    {t('agent.wizard.skipManual')}
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
                    {t('agent.wizard.importFile', { defaultValue: 'Import' })}
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
                      {t('agent.wizard.generating')}
                    </>
                  ) : (
                    <>
                      <Sparkles className="size-4" />
                      {t('agent.wizard.generate')}
                    </>
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              {/* ─── FORM: Standard create/edit ─── */}
              <DialogHeader>
                <DialogTitle>
                  {isEdit ? t('agent.edit.title') : t('agent.create.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  {isEdit ? t('agent.edit.title') : t('agent.create.title')}
                </DialogDescription>
              </DialogHeader>

              {/* In EDIT mode each tab is its own form with its own Save
                  button (no shared footer). In CREATE mode the whole body is a
                  single form that POSTs everything at once via the footer. */}
              <FormShell isEdit={isEdit} onCreateSubmit={handleSubmit}>
                {/* Body: left nav + scrollable content. Stacks vertically on
                    mobile (nav becomes a horizontal scrollable tab bar). */}
                <DialogBody className="flex min-h-0 flex-1 flex-col overflow-hidden p-0 sm:flex-row">
                  {/* Left sidebar navigation */}
                  <nav className="shrink-0 border-b surface-sidebar overflow-x-auto px-3 py-2 sm:w-40 sm:border-b-0 sm:border-r sm:overflow-y-auto sm:py-4 md:w-48">
                    <ul className="flex w-full min-w-0 flex-row gap-1 sm:flex-col">
                      {TABS.map(({ id, icon: Icon, labelKey }) => (
                        <li key={id} className="shrink-0 sm:shrink">
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
                        <TabForm isEdit={isEdit} onSubmit={handleSaveGeneral} className="space-y-4">
                          {/* No-LLM banner — surfaces the constraint up-front
                              so the empty Model picker below is explained,
                              and points the user at Settings → Providers. */}
                          {!isEdit && !hasLlm && (
                            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                              <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400 mt-0.5" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                                  {t('agent.create.noLlm')}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {t('agent.create.noLlmHint')}
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
                                  {t('agent.wizard.noLlmAction')}
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
                                placeholder={t('agent.wizard.refinePlaceholder')}
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
                                    {t('agent.wizard.refining')}
                                  </>
                                ) : (
                                  t('agent.wizard.refineSubmit')
                                )}
                              </Button>
                            </div>
                          )}

                          {/* Avatar + Identity row */}
                          <div className="flex flex-col items-start gap-6 sm:flex-row">
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
                            <div className="w-full flex-1 space-y-4">
                              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                <FormField
                                  label={t('agent.create.name')}
                                  htmlFor="agentFormName"
                                  tip={t('agent.create.nameTip')}
                                  required
                                >
                                  <Input
                                    id="agentFormName"
                                    value={name}
                                    onChange={(e) => { setName(e.target.value); markDirty() }}
                                    placeholder={t('agent.create.namePlaceholder')}
                                    required
                                  />
                                </FormField>
                                <FormField
                                  label={t('agent.create.role')}
                                  htmlFor="agentFormRole"
                                  tip={t('agent.create.roleTip')}
                                  required
                                >
                                  <Input
                                    id="agentFormRole"
                                    value={role}
                                    onChange={(e) => { setRole(e.target.value); markDirty() }}
                                    placeholder={t('agent.create.rolePlaceholder')}
                                    required
                                  />
                                </FormField>
                                <FormField
                                  label={t('agent.create.model')}
                                  tip={t('agent.create.modelTip')}
                                  required={!isEdit}
                                >
                                  <ModelPicker
                                    models={llmModels}
                                    value={modelPickerValue(model, providerId ?? '')}
                                    onValueChange={(modelId, pid) => { setModel(modelId); setProviderId(pid || null); markDirty() }}
                                    placeholder={t('agent.create.modelPlaceholder')}
                                  />
                                </FormField>
                              </div>
                              <FormField
                                label={t('agent.edit.slug')}
                                htmlFor="agentFormSlug"
                                hint={isEdit ? t('agent.edit.slugHelp') : t('agent.create.slugHelpCreate', { defaultValue: 'Optional. Auto-generated from the name if left empty.' })}
                              >
                                <Input
                                  id="agentFormSlug"
                                  value={slug}
                                  onChange={(e) => { setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); markDirty() }}
                                  placeholder={t('agent.create.slugPlaceholder')}
                                />
                              </FormField>
                            </div>
                          </div>

                          {/* Character */}
                          <FormField label={t('agent.create.character')} tip={t('agent.create.characterTip')}>
                            <MarkdownEditor
                              value={character}
                              onChange={(v) => { setCharacter(v); markDirty() }}
                              height="180px"
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground">{t('agent.create.characterHint')}</p>
                              <p className="text-xs text-muted-foreground tabular-nums">~{Math.ceil(character.length / 4)} tokens</p>
                            </div>
                          </FormField>

                          {/* Expertise */}
                          <FormField label={t('agent.create.expertise')} tip={t('agent.create.expertiseTip')}>
                            <MarkdownEditor
                              value={expertise}
                              onChange={(v) => { setExpertise(v); markDirty() }}
                              height="180px"
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs text-muted-foreground">{t('agent.create.expertiseHint')}</p>
                              <p className="text-xs text-muted-foreground tabular-nums">~{Math.ceil(expertise.length / 4)} tokens</p>
                            </div>
                          </FormField>

                          {/* Total system prompt token estimate */}
                          {(character.length > 0 || expertise.length > 0) && (
                            <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground/70 pt-1 border-t border-border/40">
                              <span>{t('agent.create.totalPromptTokens', { tokens: Math.ceil((character.length + expertise.length) / 4) })}</span>
                            </div>
                          )}

                          {/* Scout model — cheap, fast model the `scout` tool
                              delegates heavy read-only exploration to. Clearing
                              it (the "inherit" option) falls back to the
                              project → global → main-model chain. */}
                          <FormField
                            className="border-t border-border/40 pt-4"
                            label={t('agent.create.scoutModel')}
                            tip={t('agent.create.scoutModelTip')}
                            hint={t('agent.create.scoutModelHint')}
                          >
                            <ModelPicker
                              models={llmModels}
                              value={modelPickerValue(scoutModel ?? '', scoutProviderId ?? '')}
                              onValueChange={(modelId, pid) => {
                                setScoutModel(modelId || null)
                                setScoutProviderId(pid || null)
                                markDirty()
                              }}
                              placeholder={t('agent.create.scoutModelInherit')}
                              allowClear
                              clearLabel={t('agent.create.scoutModelInherit')}
                            />
                          </FormField>

                          {/* Scout reasoning — per-Agent tier of the scout
                              thinking chain (project beats this; per-call
                              override beats everything). 'inherit' = unset. */}
                          <FormField
                            label={t('agent.create.scoutThinking')}
                            tip={t('agent.create.scoutThinkingTip')}
                          >
                            <ThinkingEffortSelect
                              value={scoutThinking}
                              onChange={(v) => { setScoutThinking(v); markDirty() }}
                              inheritLabel={t('agent.create.scoutThinkingInherit')}
                              reasoning={scoutModel
                                ? modelReasoningInfo(llmModels.find((m) => m.id === scoutModel && (!scoutProviderId || m.providerId === scoutProviderId)))
                                : undefined}
                            />
                          </FormField>

                          {/* Per-tab Save (edit mode only) */}
                          {isEdit && (
                            <div className="flex items-center gap-2 pt-2">
                              <Button
                                type="submit"
                                disabled={!generalDirty || savingGeneral || !name || !role}
                                className="btn-shine"
                              >
                                {savingGeneral ? (
                                  <>
                                    <Loader2 className="size-4 animate-spin" />
                                    {t('common.loading')}
                                  </>
                                ) : (
                                  t('common.save')
                                )}
                              </Button>
                            </div>
                          )}

                          {/* Danger Zone (edit mode only) — delete lives here now
                              that the shared footer is gone. */}
                          {isEdit && (
                            <div className="border-t border-destructive/30 pt-6 mt-6 space-y-3">
                              <h3 className="text-sm font-medium text-destructive">
                                {t('agent.settings.dangerZone')}
                              </h3>
                              <p className="text-xs text-muted-foreground">
                                {t('agent.settings.dangerZoneDesc')}
                              </p>
                              <ConfirmDeleteButton
                                onConfirm={handleDelete}
                                title={t('agent.settings.delete')}
                                description={t('agent.settings.deleteConfirm')}
                                confirmLabel={t('agent.settings.deleteAction')}
                                trigger={
                                  <Button type="button" variant="destructive" size="sm" disabled={isDeleting}>
                                    <Trash2 className="size-4" />
                                    {t('agent.settings.delete')}
                                  </Button>
                                }
                              />
                            </div>
                          )}
                        </TabForm>
                      )}

                      {activeTab === 'tools' && (
                        <TabForm isEdit={isEdit} onSubmit={handleSaveTools} className="space-y-4">
                          <AgentToolsTab
                            agentId={isEdit ? agent.id : null}
                            toolboxIds={toolboxIds}
                            onToolboxIdsChange={(next) => { setToolboxIds(next); markDirty() }}
                            extraToolNames={extraToolNames}
                            // Individual grants only exist on saved Agents (edit mode).
                            onExtraToolNamesChange={isEdit ? (next) => { setExtraToolNames(next); markDirty() } : undefined}
                            onManageToolboxes={onOpenSettings ? () => onOpenSettings('toolboxes') : undefined}
                          />
                          {isEdit && (
                            <div className="flex items-center gap-2 pt-2">
                              <Button
                                type="submit"
                                disabled={!toolsDirty || savingTools}
                                className="btn-shine"
                              >
                                {savingTools ? (
                                  <>
                                    <Loader2 className="size-4 animate-spin" />
                                    {t('common.loading')}
                                  </>
                                ) : (
                                  t('common.save')
                                )}
                              </Button>
                            </div>
                          )}
                        </TabForm>
                      )}

                      {activeTab === 'memory' && isEdit && (
                        <div className="space-y-6">
                          <MemoryList agentId={agent.id} compact />
                        </div>
                      )}

                      {activeTab === 'compaction' && isEdit && (
                        <TabForm isEdit={isEdit} onSubmit={handleSaveCompaction} className="space-y-3">
                          <Label className="inline-flex items-center gap-1.5 text-sm font-medium">
                            <Archive className="size-4" />
                            {t('agent.compacting.title')}
                          </Label>

                          {/* Animated visualization */}
                          <CompactingAnimation />

                          <p className="text-xs text-muted-foreground">{t('agent.compacting.overrideHint')}</p>

                          {/* Compacting model — 3-way selector */}
                          <FormField label={t('agent.compacting.modelLabel')} hint={t('agent.compacting.modelHint')}>
                            <Select
                              value={
                                compactingConfig?.compactingModel == null ? 'default'
                                : compactingConfig.compactingModel === '__agent_own__' ? 'agent_own'
                                : 'custom'
                              }
                              onValueChange={(mode) => {
                                if (mode === 'default') {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: null, compactingProviderId: null })
                                } else if (mode === 'agent_own') {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: '__agent_own__', compactingProviderId: null })
                                } else {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: '', compactingProviderId: null })
                                }
                                markDirty()
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="default">{t('agent.compacting.modeDefault')}</SelectItem>
                                <SelectItem value="agent_own">{t('agent.compacting.modeAgentOwn')}</SelectItem>
                                <SelectItem value="custom">{t('agent.compacting.modeCustom')}</SelectItem>
                              </SelectContent>
                            </Select>
                            {compactingConfig?.compactingModel != null && compactingConfig.compactingModel !== '__agent_own__' && (
                              <ModelPicker
                                models={llmModels}
                                value={modelPickerValue(compactingConfig.compactingModel, compactingConfig.compactingProviderId ?? '')}
                                onValueChange={(modelId, pid) => {
                                  setCompactingConfig({ ...compactingConfig, compactingModel: modelId || null, compactingProviderId: pid || null })
                                  markDirty()
                                }}
                                placeholder={t('agent.compacting.selectCustomModel')}
                              />
                            )}
                          </FormField>

                          {/* Threshold percent */}
                          <FormField label={t('agent.compacting.thresholdPercentLabel')} hint={t('agent.compacting.thresholdPercentHint')}>
                            <Input
                              type="number"
                              min={50}
                              max={95}
                              step={5}
                              placeholder={t('agent.compacting.thresholdPercentPlaceholder', { default: 75 })}
                              value={compactingConfig?.thresholdPercent ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, thresholdPercent: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          {/* Keep percent */}
                          <FormField label={t('agent.compacting.keepPercentLabel')} hint={t('agent.compacting.keepPercentHint')}>
                            <Input
                              type="number"
                              min={20}
                              max={80}
                              step={5}
                              placeholder={t('agent.compacting.keepPercentPlaceholder', { default: 25 })}
                              value={compactingConfig?.keepPercent ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, keepPercent: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          {/* Summary budget percent */}
                          <FormField label={t('agent.compacting.summaryBudgetLabel')} hint={t('agent.compacting.summaryBudgetHint')}>
                            <Input
                              type="number"
                              min={5}
                              max={50}
                              step={5}
                              placeholder={t('agent.compacting.summaryBudgetPlaceholder', { default: 20 })}
                              value={compactingConfig?.summaryBudgetPercent ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, summaryBudgetPercent: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          {/* Max summaries */}
                          <FormField label={t('agent.compacting.maxSummariesLabel')} hint={t('agent.compacting.maxSummariesHint')}>
                            <Input
                              type="number"
                              min={3}
                              max={50}
                              step={1}
                              placeholder={t('agent.compacting.maxSummariesPlaceholder', { default: 10 })}
                              value={compactingConfig?.maxSummaries ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, maxSummaries: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          {/* Absolute token ceilings — bound the real footprint on large-window
                              models (e.g. 1M), where the percentages above would otherwise be huge. */}
                          <div className="pt-1">
                            <p className="text-xs font-medium">{t('agent.compacting.absoluteCapsTitle')}</p>
                            <p className="text-[10px] text-muted-foreground">{t('agent.compacting.absoluteCapsHint')}</p>
                          </div>

                          {/* Keep max tokens */}
                          <FormField label={t('agent.compacting.keepMaxTokensLabel')} hint={t('agent.compacting.keepMaxTokensHint')}>
                            <Input
                              type="number"
                              min={20000}
                              max={500000}
                              step={10000}
                              placeholder={t('agent.compacting.keepMaxTokensPlaceholder', { default: 100000 })}
                              value={compactingConfig?.keepMaxTokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, keepMaxTokens: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          {/* Trigger max tokens */}
                          <FormField label={t('agent.compacting.triggerMaxTokensLabel')} hint={t('agent.compacting.triggerMaxTokensHint')}>
                            <Input
                              type="number"
                              min={50000}
                              max={1000000}
                              step={25000}
                              placeholder={t('agent.compacting.triggerMaxTokensPlaceholder', { default: 300000 })}
                              value={compactingConfig?.triggerMaxTokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, triggerMaxTokens: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          {/* Summary max tokens */}
                          <FormField label={t('agent.compacting.summaryMaxTokensLabel')} hint={t('agent.compacting.summaryMaxTokensHint')}>
                            <Input
                              type="number"
                              min={8000}
                              max={200000}
                              step={8000}
                              placeholder={t('agent.compacting.summaryMaxTokensPlaceholder', { default: 48000 })}
                              value={compactingConfig?.summaryMaxTokens ?? ''}
                              onChange={(e) => {
                                const val = e.target.value ? Number(e.target.value) : null
                                setCompactingConfig({ ...compactingConfig, summaryMaxTokens: val })
                                markDirty()
                              }}
                            />
                          </FormField>

                          <div className="flex items-center gap-2 pt-2">
                            <Button
                              type="submit"
                              disabled={!compactionDirty || savingCompaction}
                              className="btn-shine"
                            >
                              {savingCompaction ? (
                                <>
                                  <Loader2 className="size-4 animate-spin" />
                                  {t('common.loading')}
                                </>
                              ) : (
                                t('common.save')
                              )}
                            </Button>
                          </div>
                        </TabForm>
                      )}

                      {activeTab === 'compaction' && !isEdit && (
                        <EmptyState
                          minimal
                          icon={Archive}
                          title={t('agent.create.compactionEmptyTitle')}
                          description={t('agent.create.compactionEmptyDescription')}
                        />
                      )}

                      {activeTab === 'memory' && !isEdit && (
                        <EmptyState
                          minimal
                          icon={Brain}
                          title={t('agent.create.memoryEmptyTitle')}
                          description={t('agent.create.memoryEmptyDescription')}
                        />
                      )}

                      {/* ── Thinking tab ────────────────────────── */}
                      {activeTab === 'thinking' && isEdit && (
                        <TabForm isEdit={isEdit} onSubmit={handleSaveThinking} className="space-y-4">
                          <div className="flex items-center gap-2">
                            <Sparkles className="size-4 text-chart-4" />
                            <h3 className="text-sm font-medium">{t('agent.thinking.title')}</h3>
                          </div>

                          <p className="text-xs text-muted-foreground">{t('agent.thinking.description')}</p>

                          <div className="flex items-center justify-between">
                            <Label htmlFor="thinking-enabled">{t('agent.thinking.enableLabel')}</Label>
                            <Switch
                              id="thinking-enabled"
                              checked={thinkingConfig?.enabled ?? false}
                              onCheckedChange={(checked) => {
                                setThinkingConfig({ ...thinkingConfig, enabled: checked })
                                markDirty()
                              }}
                            />
                          </div>

                          {agentModelReasoning.kind === 'unsupported' && (
                            <p className="text-xs text-muted-foreground">{t('chat.thinkingPicker.unsupported')}</p>
                          )}

                          {thinkingConfig?.enabled && agentModelReasoning.kind !== 'toggle' && agentModelReasoning.kind !== 'unsupported' && (
                            <FormField
                              label={t('agent.thinking.effortLabel')}
                              hint={t('agent.thinking.effortHint')}
                            >
                              <ThinkingEffortSelect
                                value={(thinkingConfig.effort ?? 'medium') as ThinkingChoice}
                                onChange={(v) => {
                                  if (v === 'inherit' || v === 'off' || v === 'on') return
                                  setThinkingConfig({ enabled: true, effort: v })
                                  markDirty()
                                }}
                                reasoning={agentModelReasoning}
                              />
                            </FormField>
                          )}
                          {agentModelReasoning.note && (
                            <p className="text-xs text-muted-foreground">{agentModelReasoning.note}</p>
                          )}

                          <div className="flex items-center gap-2 pt-2">
                            <Button
                              type="submit"
                              disabled={!thinkingDirty || savingThinking}
                              className="btn-shine"
                            >
                              {savingThinking ? (
                                <>
                                  <Loader2 className="size-4 animate-spin" />
                                  {t('common.loading')}
                                </>
                              ) : (
                                t('common.save')
                              )}
                            </Button>
                          </div>
                        </TabForm>
                      )}

                      {activeTab === 'thinking' && !isEdit && (
                        <EmptyState
                          minimal
                          icon={Sparkles}
                          title={t('agent.create.thinkingEmptyTitle')}
                          description={t('agent.create.thinkingEmptyDescription')}
                        />
                      )}
                      </div>
                    </div>
                  </div>
                </DialogBody>

                {/* Footer — CREATE only. In edit mode each tab carries its own
                    Save button and the delete affordance lives in the General
                    tab's Danger Zone, so no shared footer is rendered. */}
                {!isEdit && (
                  <DialogFooter className="flex-row items-center justify-between sm:justify-between">
                    {hasWizard ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setWizardStep('describe')}
                      >
                        <ArrowLeft className="size-4" />
                        {t('agent.wizard.back')}
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
                        t('agent.create.submit')
                      )}
                    </Button>
                  </DialogFooter>
                )}
              </FormShell>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Avatar picker modal */}
      <AvatarPickerModal
        open={showAvatarPicker}
        onOpenChange={setShowAvatarPicker}
        currentAvatar={avatarPreview}
        agentName={name}
        agentId={isEdit ? agent?.id ?? null : null}
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
