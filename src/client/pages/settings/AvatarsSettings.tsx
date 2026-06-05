import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/client/components/ui/button'
import { Textarea } from '@/client/components/ui/textarea'
import { Label } from '@/client/components/ui/label'
import { Switch } from '@/client/components/ui/switch'
import { Skeleton } from '@/client/components/ui/skeleton'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { InfoTip } from '@/client/components/common/InfoTip'
import { HelpPanel } from '@/client/components/common/HelpPanel'
import { api, getErrorMessage, toastError } from '@/client/lib/api'
import { useModels } from '@/client/hooks/useModels'
import { useSettingsNav } from '@/client/pages/settings/SettingsPage'
import { AVATAR_STYLE_PRESETS, AVATAR_SUBJECT_PRESETS } from '@/shared/constants'
import { ImageUp, Loader2, Sparkles, Upload, RotateCcw } from 'lucide-react'

interface AvatarConfig {
  style: string
  subject: string
  baseEnabled: boolean
  hasCustomBase: boolean
}

export function AvatarsSettings() {
  const { t } = useTranslation()
  const navigate = useSettingsNav()
  const { imageModels } = useModels()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Axes A (style) + B (subject)
  const [style, setStyle] = useState('')
  const [initialStyle, setInitialStyle] = useState('')
  const [subject, setSubject] = useState('')
  const [initialSubject, setInitialSubject] = useState('')
  const [saving, setSaving] = useState(false)

  // Base image
  const [baseEnabled, setBaseEnabled] = useState(true)
  const [hasCustomBase, setHasCustomBase] = useState(false)
  const [baseVersion, setBaseVersion] = useState(() => Date.now())
  const [busyBase, setBusyBase] = useState(false)
  const [selectedModelValue, setSelectedModelValue] = useState('')

  const hasImageModels = imageModels.length > 0

  useEffect(() => {
    setFetchError(null)
    fetchConfig().catch(() => {})
  }, [])

  // Seed the base-generation model picker with the saved default once models load.
  useEffect(() => {
    if (!hasImageModels || selectedModelValue) return
    const first = imageModels[0]
    setSelectedModelValue(first ? `${first.providerId}:${first.id}` : '')
    api.get<{ defaultImageModel: string | null; defaultImageProviderId: string | null }>(
      '/settings/default-models',
    )
      .then((data) => {
        if (!data.defaultImageModel || !data.defaultImageProviderId) return
        const match = imageModels.find(
          (m) => m.id === data.defaultImageModel && m.providerId === data.defaultImageProviderId,
        )
        if (match) setSelectedModelValue(`${match.providerId}:${match.id}`)
      })
      .catch(() => {})
  }, [hasImageModels, imageModels, selectedModelValue])

  const fetchConfig = async () => {
    try {
      const cfg = await api.get<AvatarConfig>('/kins/avatar-config')
      setStyle(cfg.style)
      setInitialStyle(cfg.style)
      setSubject(cfg.subject)
      setInitialSubject(cfg.subject)
      setBaseEnabled(cfg.baseEnabled)
      setHasCustomBase(cfg.hasCustomBase)
    } catch (err: unknown) {
      setFetchError(getErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }

  const selectedImageModel = selectedModelValue
    ? (() => {
        const sep = selectedModelValue.indexOf(':')
        return { providerId: selectedModelValue.slice(0, sep), modelId: selectedModelValue.slice(sep + 1) }
      })()
    : undefined

  const handleSave = async () => {
    setSaving(true)
    try {
      if (style !== initialStyle) {
        const data = await api.put<{ avatarStyle: string }>('/settings/avatar-style', { avatarStyle: style })
        setStyle(data.avatarStyle)
        setInitialStyle(data.avatarStyle)
      }
      if (subject !== initialSubject) {
        const data = await api.put<{ avatarSubject: string }>('/settings/avatar-subject', { avatarSubject: subject })
        setSubject(data.avatarSubject)
        setInitialSubject(data.avatarSubject)
      }
      toast.success(t('settings.avatars.saved'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleBase = async (enabled: boolean) => {
    setBaseEnabled(enabled)
    try {
      await api.put('/settings/avatar-base-enabled', { enabled })
    } catch (err: unknown) {
      setBaseEnabled(!enabled)
      toastError(err)
    }
  }

  const handleUpload = async (file: File) => {
    setBusyBase(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/settings/avatar-base/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(body?.error?.message ?? t('settings.avatars.base.uploadFailed'))
      }
      setHasCustomBase(true)
      setBaseVersion(Date.now())
      toast.success(t('settings.avatars.base.uploaded'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setBusyBase(false)
    }
  }

  const handleGenerateBase = async () => {
    setBusyBase(true)
    try {
      await api.post('/settings/avatar-base/generate', {
        ...(selectedImageModel
          ? { providerId: selectedImageModel.providerId, modelId: selectedImageModel.modelId }
          : {}),
      })
      setHasCustomBase(true)
      setBaseVersion(Date.now())
      toast.success(t('settings.avatars.base.generated'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setBusyBase(false)
    }
  }

  const handleResetBase = async () => {
    setBusyBase(true)
    try {
      await api.delete('/settings/avatar-base')
      setHasCustomBase(false)
      setBaseVersion(Date.now())
      toast.success(t('settings.avatars.base.resetDone'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setBusyBase(false)
    }
  }

  const hasChanges = style !== initialStyle || subject !== initialSubject

  if (isLoading) {
    return (
      <div className="space-y-8">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-9 w-20 rounded-md" />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{fetchError}</p>
        <Button variant="outline" onClick={() => { setIsLoading(true); setFetchError(null); fetchConfig().catch(() => {}) }}>
          {t('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-sm text-muted-foreground">{t('settings.avatars.description')}</p>

      {/* ─── Base image (img2img reference) ─────────────────────────────── */}
      <div className="space-y-3">
        <Label className="inline-flex items-center gap-1.5">
          {t('settings.avatars.base.title')}
          <InfoTip content={t('settings.avatars.base.tip')} />
        </Label>

        <div className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 p-4">
          <Avatar className="size-20 rounded-lg ring-1 ring-border">
            <AvatarImage
              src={`/api/kins/avatar-base/image?v=${baseVersion}`}
              alt={t('settings.avatars.base.title')}
              className="object-cover"
            />
            <AvatarFallback className="rounded-lg">
              <ImageUp className="size-6 text-muted-foreground" />
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={busyBase}
              >
                <Upload className="size-4" />
                {t('settings.avatars.base.upload')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleGenerateBase}
                disabled={busyBase || !hasImageModels}
                title={!hasImageModels ? t('settings.avatars.base.needsProvider') : undefined}
              >
                {busyBase ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {t('settings.avatars.base.generate')}
              </Button>
              {hasCustomBase && (
                <Button type="button" variant="ghost" size="sm" onClick={handleResetBase} disabled={busyBase}>
                  <RotateCcw className="size-4" />
                  {t('settings.avatars.base.reset')}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {hasCustomBase ? t('settings.avatars.base.customHint') : t('settings.avatars.base.defaultHint')}
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleUpload(file)
              e.target.value = ''
            }}
          />
        </div>

        {hasImageModels && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('settings.avatars.base.model')}</Label>
            <ModelPicker
              models={imageModels}
              value={selectedModelValue}
              onValueChange={(modelId, pid) => setSelectedModelValue(modelPickerValue(modelId, pid))}
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <div className="space-y-0.5">
            <Label htmlFor="avatar-base-enabled" className="cursor-pointer">
              {t('settings.avatars.base.enableLabel')}
            </Label>
            <p className="text-xs text-muted-foreground">{t('settings.avatars.base.enableHint')}</p>
          </div>
          <Switch id="avatar-base-enabled" checked={baseEnabled} onCheckedChange={handleToggleBase} />
        </div>
      </div>

      {/* ─── Axis A — art style ─────────────────────────────────────────── */}
      <div className="space-y-2 border-t border-border/60 pt-6">
        <Label htmlFor="avatar-style" className="inline-flex items-center gap-1.5">
          {t('settings.avatars.style.title')}
          <InfoTip content={t('settings.avatars.style.tip')} />
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {AVATAR_STYLE_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant={style.trim() === preset.prompt ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setStyle(preset.prompt)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Textarea
          id="avatar-style"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder={t('settings.avatars.style.placeholder')}
          maxLength={2000}
          rows={2}
          className="resize-y"
        />
        <p className="text-xs text-muted-foreground">{t('settings.avatars.style.hint')}</p>
      </div>

      {/* ─── Axis B — subject / type ────────────────────────────────────── */}
      <div className="space-y-2">
        <Label htmlFor="avatar-subject" className="inline-flex items-center gap-1.5">
          {t('settings.avatars.subject.title')}
          <InfoTip content={t('settings.avatars.subject.tip')} />
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {AVATAR_SUBJECT_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant={subject.trim() === preset.prompt ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={() => setSubject(preset.prompt)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <Textarea
          id="avatar-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t('settings.avatars.subject.placeholder')}
          maxLength={2000}
          rows={2}
          className="resize-y"
        />
        <p className="text-xs text-muted-foreground">{t('settings.avatars.subject.hint')}</p>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={!hasChanges || saving}>
          {saving ? t('common.loading') : t('common.save')}
        </Button>
        {hasChanges && (
          <Button variant="ghost" onClick={() => { setStyle(initialStyle); setSubject(initialSubject) }}>
            {t('common.discard', 'Discard')}
          </Button>
        )}
      </div>

      {!hasImageModels && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-300">
          <p>{t('settings.avatars.noProvider')}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('providers')}>
            {t('settings.avatars.noProviderAction')}
          </Button>
        </div>
      )}

      <HelpPanel
        contentKey="settings.avatars.help.content"
        bulletKeys={[
          'settings.avatars.help.bullet1',
          'settings.avatars.help.bullet2',
          'settings.avatars.help.bullet3',
        ]}
        storageKey="help.avatars.open"
      />
    </div>
  )
}
