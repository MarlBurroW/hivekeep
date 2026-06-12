import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/client/components/ui/input'
import { PasswordInput } from '@/client/components/ui/password-input'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField } from '@/client/components/common/FormField'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import { InfoTip } from '@/client/components/common/InfoTip'
import { AgentSelector } from '@/client/components/common/AgentSelector'
import { api, getErrorMessage } from '@/client/lib/api'
import type { StoredFileData } from '@/client/components/file-storage/FileStorageCard'

/** Creation-summary shape returned by the share endpoints (url included). */
export interface SavedStoredFile {
  id: string
  name: string
  url: string
}

interface FileStorageFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Carries the created file in workspaceSource mode (URL-copy step). */
  onSaved: (file?: SavedStoredFile) => void
  file?: StoredFileData | null
  agents: { id: string; name: string }[]
  /**
   * Share-from-workspace mode (Files section, files.md § 4.4): hides the file
   * input + agent selector, prefills the name with the basename and submits a
   * SNAPSHOT to POST /api/file-storage/from-workspace.
   */
  workspaceSource?: { agentId: string; path: string } | null
}

export function FileStorageFormDialog({
  open,
  onOpenChange,
  onSaved,
  file,
  agents,
  workspaceSource,
}: FileStorageFormDialogProps) {
  const { t } = useTranslation()
  const isEditing = !!file
  const isWorkspaceShare = !!workspaceSource && !isEditing
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [agentId, setAgentId] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [password, setPassword] = useState('')
  const [expiresIn, setExpiresIn] = useState('')
  const [readAndBurn, setReadAndBurn] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  useEffect(() => {
    if (open && file) {
      setName(file.name)
      setDescription(file.description ?? '')
      setAgentId(file.agentId)
      setIsPublic(file.isPublic)
      setPassword('')
      setExpiresIn('')
      setReadAndBurn(file.readAndBurn)
      setSelectedFile(null)
      setError('')
    } else if (open && workspaceSource) {
      setName(workspaceSource.path.split('/').pop() ?? '')
      setDescription('')
      setAgentId(workspaceSource.agentId)
      setIsPublic(true)
      setPassword('')
      setExpiresIn('')
      setReadAndBurn(false)
      setSelectedFile(null)
      setError('')
    } else if (open) {
      setName('')
      setDescription('')
      setAgentId(agents[0]?.id ?? '')
      setIsPublic(true)
      setPassword('')
      setExpiresIn('')
      setReadAndBurn(false)
      setSelectedFile(null)
      setError('')
    }
  }, [open, file, agents, workspaceSource])

  const handleClose = () => {
    onOpenChange(false)
  }

  const handleSave = async () => {
    setError('')
    setIsSaving(true)
    try {
      if (isEditing) {
        const body: Record<string, unknown> = {}
        if (name !== file.name) body.name = name
        if (description !== (file.description ?? '')) body.description = description || null
        if (isPublic !== file.isPublic) body.isPublic = isPublic
        if (readAndBurn !== file.readAndBurn) body.readAndBurn = readAndBurn
        if (password) body.password = password
        if (expiresIn) body.expiresIn = Number(expiresIn)

        if (Object.keys(body).length > 0) {
          await api.patch(`/file-storage/${file.id}`, body)
        }
      } else if (isWorkspaceShare && workspaceSource) {
        const created = await api.post<{ file: SavedStoredFile }>('/file-storage/from-workspace', {
          agentId: workspaceSource.agentId,
          path: workspaceSource.path,
          name: name || undefined,
          description: description || undefined,
          isPublic,
          password: password || undefined,
          expiresIn: expiresIn ? Number(expiresIn) : undefined,
          readAndBurn,
        })
        onSaved(created.file)
        handleClose()
        setIsSaving(false)
        return
      } else {
        if (!selectedFile) {
          setError(t('settings.files.fileRequired'))
          setIsSaving(false)
          return
        }

        const formData = new FormData()
        formData.append('file', selectedFile)
        formData.append('agentId', agentId)
        formData.append('name', name || selectedFile.name)
        if (description) formData.append('description', description)
        formData.append('isPublic', String(isPublic))
        if (password) formData.append('password', password)
        if (expiresIn) formData.append('expiresIn', expiresIn)
        formData.append('readAndBurn', String(readAndBurn))

        const response = await fetch('/api/file-storage', {
          method: 'POST',
          credentials: 'include',
          body: formData,
        })

        if (!response.ok) {
          const err = await response.json()
          throw new Error(err?.error?.message || t('errors.uploadFailed'))
        }
      }
      onSaved()
      handleClose()
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }

  const canSave = isEditing || isWorkspaceShare ? true : !!selectedFile && !!agentId

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => { if (!v) handleClose() }}
      title={isEditing ? t('settings.files.edit') : isWorkspaceShare ? t('files.share.title') : t('settings.files.add')}
      description={
        isEditing
          ? t('settings.files.editHint')
          : isWorkspaceShare
            ? t('files.share.snapshotNotice')
            : t('settings.files.addHint')
      }
      size="md"
      error={error || null}
      onSubmit={handleSave}
      isSubmitting={isSaving}
      submitDisabled={!canSave}
      submitLabel={isEditing ? t('common.save') : isWorkspaceShare ? t('files.share.submit') : t('settings.files.add')}
    >
      {!isEditing && !isWorkspaceShare && (
        <>
          <FormField label={t('settings.files.file')} htmlFor="file-storage-file">
            <Input
              id="file-storage-file"
              ref={fileInputRef}
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setSelectedFile(f)
                if (f && !name) setName(f.name)
              }}
            />
          </FormField>

          <FormField
            label={t('settings.files.agent')}
            htmlFor="file-storage-agent"
            tip={t('settings.files.agentTip')}
          >
            <AgentSelector
              value={agentId}
              onValueChange={setAgentId}
              agents={agents}
            />
          </FormField>
        </>
      )}

      <FormField label={t('settings.files.name')} htmlFor="file-storage-name">
        <Input
          id="file-storage-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('settings.files.namePlaceholder')}
        />
      </FormField>

      <FormField
        label={
          <>
            {t('settings.files.descriptionLabel')}
            <span className="text-xs text-muted-foreground">({t('common.optional')})</span>
          </>
        }
        htmlFor="file-storage-description"
      >
        <Input
          id="file-storage-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('settings.files.descriptionPlaceholder')}
        />
      </FormField>

      <div className="flex items-center justify-between">
        <Label className="inline-flex items-center gap-1.5">{t('settings.files.public')} <InfoTip content={t('settings.files.publicTip')} /></Label>
        <Switch checked={isPublic} onCheckedChange={setIsPublic} />
      </div>

      <FormField
        label={
          <>
            {t('settings.files.password')}
            <span className="text-xs text-muted-foreground">({t('common.optional')})</span>
          </>
        }
        htmlFor="file-storage-password"
        tip={t('settings.files.passwordTip')}
      >
        <PasswordInput
          id="file-storage-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={isEditing ? '••••••••' : t('settings.files.passwordPlaceholder')}
          autoComplete="off"
        />
      </FormField>

      <FormField
        label={
          <>
            {t('settings.files.expiresIn')}
            <span className="text-xs text-muted-foreground">({t('common.optional')})</span>
          </>
        }
        htmlFor="file-storage-expires-in"
        tip={t('settings.files.expiresInTip')}
      >
        <Input
          id="file-storage-expires-in"
          type="number"
          min="1"
          value={expiresIn}
          onChange={(e) => setExpiresIn(e.target.value)}
          placeholder={t('settings.files.expiresInPlaceholder')}
        />
      </FormField>

      <div className="flex items-center justify-between">
        <Label className="inline-flex items-center gap-1.5">{t('settings.files.readAndBurn')} <InfoTip content={t('settings.files.readAndBurnTip')} /></Label>
        <Switch checked={readAndBurn} onCheckedChange={setReadAndBurn} />
      </div>
    </FormDialog>
  )
}
