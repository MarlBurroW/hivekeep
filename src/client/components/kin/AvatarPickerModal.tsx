import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Cropper from 'react-easy-crop'
import type { Area } from 'react-easy-crop'
import { api } from '@/client/lib/api'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Textarea } from '@/client/components/ui/textarea'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { ToggleGroup, ToggleGroupItem } from '@/client/components/ui/toggle-group'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { Label } from '@/client/components/ui/label'
import { Slider } from '@/client/components/ui/slider'
import { Switch } from '@/client/components/ui/switch'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Camera, Crop, ImageUp, Info, Loader2, SlidersHorizontal, Sparkles, Upload, ZoomIn } from 'lucide-react'
import { cropImage, type CropArea } from '@/client/lib/crop-image'

type AvatarMode = 'upload' | 'auto' | 'manual'

interface ImageModel {
  id: string
  name: string
  providerId: string
  providerName: string
  providerType: string
  capability: string
}

export type AvatarPickerResult =
  | { mode: 'upload'; file: File; preview: string }
  | { mode: 'generated'; url: string }

interface AvatarPickerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentAvatar: string | null
  kinName: string
  /** null = create mode (generation disabled) */
  kinId: string | null
  hasImageCapability: boolean
  imageModels?: ImageModel[]
  onGenerateAvatarPreview?: (
    kinId: string,
    mode: 'auto' | 'manual',
    opts?: { style?: string; subject?: string; character?: string; useBase?: boolean },
    imageModel?: { providerId: string; modelId: string },
  ) => Promise<string>
  onConfirm: (result: AvatarPickerResult) => void
  /** Open the global Settings modal at the providers section. When
   *  provided, the 'no image provider' notice gets a CTA that closes
   *  this picker and jumps the user there. */
  onOpenSettings?: (section?: string) => void
}

export function AvatarPickerModal({
  open,
  onOpenChange,
  currentAvatar,
  kinName,
  kinId,
  hasImageCapability,
  imageModels,
  onGenerateAvatarPreview,
  onConfirm,
  onOpenSettings,
}: AvatarPickerModalProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [mode, setMode] = useState<AvatarMode>('upload')
  const [preview, setPreview] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  // Manual mode (3 axes): A = art style, B = subject/type, C = per-shot specifics.
  // A and B are pre-filled from the global avatar config; C is the user's empty
  // free-form box for this one shot. useBase toggles the img2img reference.
  const [styleA, setStyleA] = useState('')
  const [subjectB, setSubjectB] = useState('')
  const [characterC, setCharacterC] = useState('')
  const [useBase, setUseBase] = useState(true)
  const [hasCustomBase, setHasCustomBase] = useState(false)
  const [selectedModelValue, setSelectedModelValue] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [showFullPreview, setShowFullPreview] = useState(false)

  // Cropper state
  const [cropSrc, setCropSrc] = useState<string | null>(null)
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<CropArea | null>(null)
  const [isCropping, setIsCropping] = useState(false)

  const canGenerate = !!kinId && hasImageCapability
  const initials = kinName.slice(0, 2).toUpperCase()
  const displayAvatar = preview ?? currentAvatar

  // Reset state when modal opens (useEffect because Radix controlled mode
  // does NOT call onOpenChange(true) when the parent sets open={true})
  useEffect(() => {
    if (open) {
      setMode('upload')
      setPreview(null)
      setPendingFile(null)
      setCharacterC('')
      const first = imageModels?.[0]
      setSelectedModelValue(first ? `${first.providerId}:${first.id}` : '')
      setIsGenerating(false)
      setIsDragging(false)
      setShowFullPreview(false)
      setCropSrc(null)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      setCroppedAreaPixels(null)
      setIsCropping(false)

      // Honor the user's saved default image generator when available.
      api.get<{ defaultImageModel: string | null; defaultImageProviderId: string | null }>(
        '/settings/default-models',
      )
        .then((data) => {
          if (!data.defaultImageModel || !data.defaultImageProviderId) return
          const match = imageModels?.find(
            (m) => m.id === data.defaultImageModel && m.providerId === data.defaultImageProviderId,
          )
          if (match) setSelectedModelValue(`${match.providerId}:${match.id}`)
        })
        .catch(() => {})

      // Pre-fill the manual axes (A = style, B = subject) from the global avatar
      // config, and seed the base-reference toggle from whether it's enabled.
      api.get<{ style: string; subject: string; baseEnabled: boolean; hasCustomBase: boolean }>(
        '/kins/avatar-config',
      )
        .then((cfg) => {
          setStyleA(cfg.style)
          setSubjectB(cfg.subject)
          setUseBase(cfg.baseEnabled)
          setHasCustomBase(cfg.hasCustomBase)
        })
        .catch(() => {})
    }
  }, [open])

  const handleFileSelect = useCallback((file: File) => {
    setMode('upload')
    // Show the cropper with the raw image
    const reader = new FileReader()
    reader.onload = () => {
      setCropSrc(reader.result as string)
      setCrop({ x: 0, y: 0 })
      setZoom(1)
    }
    reader.readAsDataURL(file)
  }, [])

  const onCropComplete = useCallback((_: Area, croppedPixels: Area) => {
    setCroppedAreaPixels(croppedPixels)
  }, [])

  const handleCropConfirm = async () => {
    if (!cropSrc || !croppedAreaPixels) return
    setIsCropping(true)
    try {
      const { file, dataUrl } = await cropImage(cropSrc, croppedAreaPixels)
      setPendingFile(file)
      setPreview(dataUrl)
      setCropSrc(null)
    } finally {
      setIsCropping(false)
    }
  }

  const handleCropCancel = () => {
    setCropSrc(null)
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFileSelect(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.type.startsWith('image/')) handleFileSelect(file)
  }

  // Parse selected model value ("providerId:modelId") into structured param
  const selectedImageModel = selectedModelValue
    ? (() => {
        const sep = selectedModelValue.indexOf(':')
        return { providerId: selectedModelValue.slice(0, sep), modelId: selectedModelValue.slice(sep + 1) }
      })()
    : undefined

  const hasImageModels = (imageModels ?? []).length > 0

  const handleGenerate = async () => {
    if (!kinId || !onGenerateAvatarPreview) return
    setIsGenerating(true)
    try {
      const dataUrl = mode === 'auto'
        ? await onGenerateAvatarPreview(kinId, 'auto', undefined, selectedImageModel)
        : await onGenerateAvatarPreview(
            kinId,
            'manual',
            {
              style: styleA.trim(),
              subject: subjectB.trim(),
              character: characterC.trim(),
              useBase,
            },
            selectedImageModel,
          )
      setPreview(dataUrl)
      setPendingFile(null)
    } finally {
      setIsGenerating(false)
    }
  }

  const handleConfirm = () => {
    if (!preview) return
    if (mode === 'upload' && pendingFile) {
      onConfirm({ mode: 'upload', file: pendingFile, preview })
    } else if (preview && preview !== currentAvatar) {
      onConfirm({ mode: 'generated', url: preview })
    }
    onOpenChange(false)
  }

  const hasNewAvatar = preview && preview !== currentAvatar

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('kin.avatar.title')}</DialogTitle>
            <DialogDescription className="sr-only">{t('kin.avatar.title')}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-5">
            {/* Cropper overlay */}
            {cropSrc && (
              <div className="flex w-full flex-col gap-3">
                <div className="relative h-64 w-full overflow-hidden rounded-lg bg-muted">
                  <Cropper
                    image={cropSrc}
                    crop={crop}
                    zoom={zoom}
                    aspect={1}
                    cropShape="round"
                    showGrid={false}
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={onCropComplete}
                  />
                </div>
                <div className="flex items-center gap-3 px-1">
                  <ZoomIn className="size-4 shrink-0 text-muted-foreground" />
                  <Slider
                    min={1}
                    max={3}
                    step={0.05}
                    value={[zoom]}
                    onValueChange={([v]) => v !== undefined && setZoom(v)}
                    className="flex-1"
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" className="flex-1" onClick={handleCropCancel}>
                    {t('common.cancel')}
                  </Button>
                  <Button type="button" className="btn-shine flex-1" onClick={handleCropConfirm} disabled={isCropping}>
                    {isCropping ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Crop className="size-4" />
                    )}
                    {t('kin.avatar.cropConfirm')}
                  </Button>
                </div>
              </div>
            )}

            {/* Avatar preview (hidden during cropping) */}
            {!cropSrc && (<>
            <button
              type="button"
              className="group relative cursor-pointer"
              onClick={() => displayAvatar && !isGenerating && setShowFullPreview(true)}
              disabled={!displayAvatar || isGenerating}
            >
              <Avatar className="size-32 ring-2 ring-border transition-all group-hover:ring-primary">
                {isGenerating ? (
                  <AvatarFallback>
                    <Loader2 className="size-8 animate-spin text-primary" />
                  </AvatarFallback>
                ) : displayAvatar ? (
                  <AvatarImage src={displayAvatar} alt={kinName || 'Avatar'} />
                ) : (
                  <AvatarFallback className="text-2xl">
                    {initials || <Camera className="size-8 text-muted-foreground" />}
                  </AvatarFallback>
                )}
              </Avatar>
              {isGenerating && displayAvatar && (
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50">
                  <Loader2 className="size-8 animate-spin text-white" />
                </div>
              )}
            </button>

            {/* Mode selector */}
            <ToggleGroup
              type="single"
              variant="outline"
              size="default"
              value={mode}
              onValueChange={(v) => v && setMode(v as AvatarMode)}
            >
              <ToggleGroupItem value="upload">
                <Upload className="size-4" />
                {t('kin.avatar.upload')}
              </ToggleGroupItem>
              <ToggleGroupItem value="auto" disabled={!hasImageCapability}>
                <Sparkles className="size-4" />
                {t('kin.avatar.auto')}
              </ToggleGroupItem>
              <ToggleGroupItem value="manual" disabled={!hasImageCapability}>
                <SlidersHorizontal className="size-4" />
                {t('kin.avatar.manual')}
              </ToggleGroupItem>
            </ToggleGroup>

            {/* Mode content */}
            <div className="w-full space-y-3">
              {mode === 'upload' && (
                <>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => fileInputRef.current?.click()}
                    onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors ${
                      isDragging
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    }`}
                  >
                    <ImageUp className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {t('kin.avatar.uploadHint')}
                    </p>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileInput}
                    className="hidden"
                  />
                </>
              )}

              {mode === 'auto' && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3">
                    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {t('kin.avatar.autoDescription')}
                    </p>
                  </div>
                  {canGenerate && hasImageModels && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('kin.avatar.imageModel')}</Label>
                      <ModelPicker
                        models={imageModels ?? []}
                        value={selectedModelValue}
                        onValueChange={(modelId, pid) => setSelectedModelValue(modelPickerValue(modelId, pid))}
                      />
                    </div>
                  )}
                  {!canGenerate && (
                    !hasImageCapability ? (
                      <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-center">
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          {t('kin.avatar.noImageProvider')}
                        </p>
                        {onOpenSettings && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              onOpenChange(false)
                              onOpenSettings('providers')
                            }}
                          >
                            {t('kin.avatar.noImageProviderAction')}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <p className="text-center text-sm text-muted-foreground">
                        {t('kin.avatar.createFirst')}
                      </p>
                    )
                  )}
                  {canGenerate && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={handleGenerate}
                      disabled={isGenerating}
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          {t('kin.avatar.generating')}
                        </>
                      ) : preview && preview !== currentAvatar ? (
                        <>
                          <Sparkles className="size-4" />
                          {t('kin.avatar.regenerate')}
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-4" />
                          {t('kin.avatar.generate')}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}

              {mode === 'manual' && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 p-3">
                    <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {t('kin.avatar.manualDescription')}
                    </p>
                  </div>

                  {/* Base reference image (axis: img2img). Pre-filled from the
                      global base; toggle whether to use it for this shot. */}
                  {hasImageCapability && (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <Avatar className="size-10 rounded-md ring-1 ring-border">
                          <AvatarImage
                            src="/api/kins/avatar-base/image"
                            alt={t('kin.avatar.baseImage')}
                            className="object-cover"
                          />
                          <AvatarFallback className="rounded-md text-xs">
                            <ImageUp className="size-4 text-muted-foreground" />
                          </AvatarFallback>
                        </Avatar>
                        <div className="space-y-0.5">
                          <Label htmlFor="manual-use-base" className="cursor-pointer text-xs">
                            {t('kin.avatar.useBaseImage')}
                          </Label>
                          <p className="text-[11px] text-muted-foreground">
                            {hasCustomBase
                              ? t('kin.avatar.baseImageCustomHint')
                              : t('kin.avatar.baseImageDefaultHint')}
                          </p>
                        </div>
                      </div>
                      <Switch id="manual-use-base" checked={useBase} onCheckedChange={setUseBase} />
                    </div>
                  )}

                  {/* Axis A — art style (pre-filled) */}
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-style" className="text-xs">{t('kin.avatar.styleLabel')}</Label>
                    <Textarea
                      id="manual-style"
                      value={styleA}
                      onChange={(e) => setStyleA(e.target.value)}
                      placeholder={t('kin.avatar.stylePlaceholder')}
                      rows={2}
                      className="resize-y"
                    />
                  </div>

                  {/* Axis B — subject / type (pre-filled) */}
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-subject" className="text-xs">{t('kin.avatar.subjectLabel')}</Label>
                    <Textarea
                      id="manual-subject"
                      value={subjectB}
                      onChange={(e) => setSubjectB(e.target.value)}
                      placeholder={t('kin.avatar.subjectPlaceholder')}
                      rows={2}
                      className="resize-y"
                    />
                  </div>

                  {/* Axis C — per-shot specifics (empty, explanatory placeholder) */}
                  <div className="space-y-1.5">
                    <Label htmlFor="manual-character" className="text-xs">{t('kin.avatar.characterLabel')}</Label>
                    <Textarea
                      id="manual-character"
                      value={characterC}
                      onChange={(e) => setCharacterC(e.target.value)}
                      placeholder={t('kin.avatar.characterPlaceholder')}
                      rows={3}
                      className="resize-y"
                    />
                  </div>

                  {canGenerate && hasImageModels && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('kin.avatar.imageModel')}</Label>
                      <ModelPicker
                        models={imageModels ?? []}
                        value={selectedModelValue}
                        onValueChange={(modelId, pid) => setSelectedModelValue(modelPickerValue(modelId, pid))}
                      />
                    </div>
                  )}
                  {!canGenerate && (
                    !hasImageCapability ? (
                      <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-center">
                        <p className="text-sm text-amber-700 dark:text-amber-300">
                          {t('kin.avatar.noImageProvider')}
                        </p>
                        {onOpenSettings && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              onOpenChange(false)
                              onOpenSettings('providers')
                            }}
                          >
                            {t('kin.avatar.noImageProviderAction')}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <p className="text-center text-sm text-muted-foreground">
                        {t('kin.avatar.createFirst')}
                      </p>
                    )
                  )}
                  {canGenerate && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={handleGenerate}
                      disabled={isGenerating || !styleA.trim() || !subjectB.trim()}
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          {t('kin.avatar.generating')}
                        </>
                      ) : preview && preview !== currentAvatar ? (
                        <>
                          <Sparkles className="size-4" />
                          {t('kin.avatar.regenerate')}
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-4" />
                          {t('kin.avatar.generate')}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}

              {!hasImageCapability && mode !== 'upload' && (
                <p className="text-center text-sm text-muted-foreground">
                  {t('kin.avatar.noImageProvider')}
                </p>
              )}
            </div>

            {/* Confirm button */}
            <Button
              type="button"
              className="btn-shine w-full"
              onClick={handleConfirm}
              disabled={!hasNewAvatar || isGenerating}
            >
              {t('kin.avatar.confirm')}
            </Button>
            </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Fullscreen preview — nested Radix Dialog so stacking/dismiss works */}
      <Dialog open={showFullPreview} onOpenChange={setShowFullPreview}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
          <DialogPrimitive.Content
            className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0"
            aria-label="Avatar preview"
            aria-describedby={undefined}
          >
            <img
              src={displayAvatar ?? ''}
              alt={kinName || 'Avatar'}
              className="max-h-[80vh] max-w-[80vw] rounded-2xl object-contain shadow-2xl"
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </Dialog>
    </>
  )
}
