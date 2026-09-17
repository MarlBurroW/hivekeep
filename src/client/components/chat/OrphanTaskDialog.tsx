import { useEffect, useRef, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getErrorMessage } from '@/client/lib/api'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Input } from '@/client/components/ui/input'
import { MarkdownEditor } from '@/client/components/ui/markdown-editor'
import { ToolboxMultiSelect } from '@/client/components/toolbox/ToolboxMultiSelect'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { ThinkingEffortSelect } from '@/client/components/common/ThinkingEffortSelect'
import { modelReasoningInfo, clampEffort } from '@/client/lib/model-efforts'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import { useToolboxes } from '@/client/hooks/useToolboxes'
import { useModels } from '@/client/hooks/useModels'
import { useAgentList } from '@/client/hooks/useAgentList'
import { choiceToConfig, type ThinkingChoice } from '@/client/lib/thinking-choice'
import { toast } from 'sonner'
import type { AgentThinkingConfig } from '@/shared/types'

interface OrphanTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fixed target Agent. Omit to let the user pick one inside the dialog (e.g.
   *  when launched from the Tasks page rather than an Agent's conversation). */
  agentId?: string
  agentName?: string
}

const TITLE_MAX = 120

/**
 * Launch a standalone (orphan) task on an Agent.
 * The user picks a prompt and, optionally, overrides for model, reasoning
 * effort, and toolboxes. Posts to `POST /api/agents/:id/tasks`; the result is
 * deposited back into the Agent's main session (async mode).
 *
 * Two modes:
 *   - Fixed Agent (`agentId` + `agentName` provided) — launched from an Agent's
 *     conversation header, no Agent selector shown.
 *   - Picker (`agentId` omitted) — launched from the Tasks page; the user first
 *     chooses which Agent should run the task via a AgentSelector.
 *
 * All overrides default to "inherit" (empty model / 'inherit' effort / no
 * toolbox selection) so leaving them untouched falls back to the Agent's own
 * model + config and the built-in default toolbox.
 */
export function OrphanTaskDialog({ open, onOpenChange, agentId, agentName }: OrphanTaskDialogProps) {
  const { t } = useTranslation()
  const { toolboxes } = useToolboxes()
  const { llmModels, isLoading: modelsLoading } = useModels()
  // Picker mode = no fixed Agent handed in. Only fetch the Agent list in that case.
  const pickerMode = !agentId
  const { agents } = useAgentList()
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [title, setTitle] = useState('')
  const [selectedToolboxIds, setSelectedToolboxIds] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [providerId, setProviderId] = useState('')
  const [thinkingChoice, setThinkingChoice] = useState<ThinkingChoice>('inherit')
  const [submitting, setSubmitting] = useState(false)

  // Effort options follow the model override's registry metadata; no override →
  // generic ladder (the executing model is resolved server-side at spawn).
  const modelReasoning = useMemo(
    () => (model
      ? modelReasoningInfo(llmModels.find((m) => m.id === model && (!providerId || m.providerId === providerId)))
      : undefined),
    [model, providerId, llmModels],
  )
  // Clamp a stale choice when the model override changes under it.
  useEffect(() => {
    if (!modelReasoning || thinkingChoice === 'inherit' || thinkingChoice === 'off') return
    if (modelReasoning.kind === 'unsupported') { setThinkingChoice('off'); return }
    if (modelReasoning.kind === 'toggle') { setThinkingChoice('on'); return }
    if (modelReasoning.kind === 'levels') {
      if (thinkingChoice === 'on') { setThinkingChoice('medium'); return }
      if (!modelReasoning.efforts.includes(thinkingChoice)) {
        const clamped = clampEffort(thinkingChoice, modelReasoning)
        if (clamped) setThinkingChoice(clamped)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelReasoning])

  // Resolve the effective target. In fixed mode it's the prop; in picker mode
  // it's whatever the user selected (name looked up from the Agent list for the
  // success toast).
  const effectiveAgentId = agentId ?? selectedAgentId
  const effectiveAgentName = agentName ?? agents.find((k) => k.id === selectedAgentId)?.name ?? ''

  // Reset every field when the dialog closes so a previous draft never leaks
  // into the next launch.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPrompt('')
      setTitle('')
      setSelectedToolboxIds([])
      setModel('')
      setProviderId('')
      setThinkingChoice('inherit')
      setSelectedAgentId('')
    }
    wasOpen.current = open
  }, [open])

  // Picker mode: default the selection to the first Agent once the list loads, so
  // the dialog opens ready-to-submit instead of with an empty selector.
  useEffect(() => {
    if (open && pickerMode && !selectedAgentId && agents.length > 0) {
      setSelectedAgentId(agents[0]!.id)
    }
  }, [open, pickerMode, selectedAgentId, agents])

  const promptLength = prompt.length
  const canSubmit = prompt.trim().length > 0 && !submitting && !!effectiveAgentId

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const body: {
        prompt: string
        title?: string
        toolboxIds?: string[]
        model?: string
        providerId?: string
        thinkingConfig?: AgentThinkingConfig
      } = { prompt: prompt.trim() }
      const trimmedTitle = title.trim()
      if (trimmedTitle) body.title = trimmedTitle
      if (selectedToolboxIds.length > 0) body.toolboxIds = selectedToolboxIds
      // model + providerId are coupled — send only when both are set.
      if (model && providerId) {
        body.model = model
        body.providerId = providerId
      }
      if (thinkingChoice !== 'inherit') {
        const cfg = choiceToConfig(thinkingChoice)
        if (cfg) body.thinkingConfig = cfg
      }
      await api.post(`/agents/${effectiveAgentId}/tasks`, body)
      toast.success(t('orphanTask.started', { name: effectiveAgentName }))
      onOpenChange(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('orphanTask.title')}
      description={
        pickerMode
          ? t('orphanTask.descriptionGeneric')
          : t('orphanTask.description', { name: agentName })
      }
      size="3xl"
      onSubmit={handleSubmit}
      isSubmitting={submitting}
      submitDisabled={!canSubmit}
      submitLabel={t('orphanTask.start')}
    >
      {pickerMode && (
        <FormField label={t('orphanTask.agentField')}>
          <AgentSelector
            value={selectedAgentId}
            onValueChange={setSelectedAgentId}
            agents={agents.map((k) => ({ id: k.id, name: k.name, role: k.role, avatarUrl: k.avatarUrl }))}
            placeholder={t('orphanTask.agentPlaceholder')}
          />
        </FormField>
      )}

      <FormField
        label={t('orphanTask.promptField')}
        hint={
          <span className="flex items-start justify-between gap-2">
            <span>{t('orphanTask.promptHelp')}</span>
            <span className="tabular-nums">
              {t('orphanTask.promptCounter', { count: promptLength })}
            </span>
          </span>
        }
      >
        <MarkdownEditor
          value={prompt}
          onChange={setPrompt}
          height="220px"
        />
      </FormField>

      <FormField label={t('orphanTask.titleField')} htmlFor="orphan-task-title">
        <Input
          id="orphan-task-title"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
          placeholder={t('orphanTask.titlePlaceholder')}
          maxLength={TITLE_MAX}
        />
      </FormField>

      {toolboxes.length > 0 && (
        <FormField label={t('orphanTask.toolboxesField')} hint={t('orphanTask.toolboxesHelp')}>
          <ToolboxMultiSelect
            toolboxes={toolboxes}
            selected={selectedToolboxIds}
            onChange={setSelectedToolboxIds}
            disabled={submitting}
          />
        </FormField>
      )}

      <FormField label={t('orphanTask.modelField')} hint={t('orphanTask.modelHelp')}>
        <ModelPicker
          models={llmModels}
          value={modelPickerValue(model, providerId)}
          onValueChange={(modelId, pid) => {
            setModel(modelId)
            setProviderId(pid)
          }}
          placeholder={t('orphanTask.modelInherit')}
          clearLabel={t('orphanTask.modelInherit')}
          allowClear
          isLoading={modelsLoading}
          disabled={submitting}
        />
      </FormField>

      <FormField label={t('orphanTask.thinkingField')} hint={t('orphanTask.thinkingHelp')}>
        <ThinkingEffortSelect
          value={thinkingChoice}
          reasoning={modelReasoning}
          onChange={setThinkingChoice}
          inheritLabel={t('orphanTask.thinkingInherit')}
          disabled={submitting}
        />
      </FormField>
    </FormDialog>
  )
}
