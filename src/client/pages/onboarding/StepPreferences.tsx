import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import { LanguageSelector } from '@/client/components/common/LanguageSelector'
import { Sun, Moon, Monitor, Contrast, CircleDot, Loader2 } from 'lucide-react'
import { usePalette, useTheme, PALETTES } from '@/client/components/theme-provider'
import { api } from '@/client/lib/api'

interface StepPreferencesProps {
  onComplete: () => void
  onBack: () => void
}

export function StepPreferences({ onComplete, onBack }: StepPreferencesProps) {
  const { t, i18n } = useTranslation()
  const { palette, setPalette, contrastMode, setContrastMode } = usePalette()
  const { theme, setTheme } = useTheme()
  const [language, setLanguage] = useState(i18n.language || 'en')
  const [isSaving, setIsSaving] = useState(false)

  const handleComplete = async () => {
    setIsSaving(true)
    try {
      // Persist appearance prefs alongside language so they're DB-backed from the
      // very first session (ThemeDbSync also keeps them in sync afterwards).
      await api.patch('/me', { language, theme: theme ?? 'system', palette, contrastMode })
    } catch {
      // Non-blocking: defaults apply but onboarding can continue
    } finally {
      setIsSaving(false)
    }
    onComplete()
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold text-foreground">
          {t('onboarding.preferences.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('onboarding.preferences.subtitle')}
        </p>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <Label>{t('onboarding.preferences.language')}</Label>
        <LanguageSelector value={language} onValueChange={(v) => { setLanguage(v); i18n.changeLanguage(v) }} />
      </div>

      {/* Color theme */}
      <div className="space-y-2">
        <Label>{t('onboarding.preferences.theme')}</Label>
        <div className="grid grid-cols-4 gap-2">
          {PALETTES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPalette(p.id)}
              className={`group relative flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-all hover:border-primary ${
                palette === p.id
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border'
              }`}
            >
              <div className="flex gap-0.5">
                {p.colors.map((color, i) => (
                  <div
                    key={i}
                    className="size-3 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <span className="text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
                {p.name}
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('onboarding.preferences.themeHint')}
        </p>
      </div>

      {/* Theme mode */}
      <div className="space-y-2">
        <Label>{t('onboarding.preferences.themeMode')}</Label>
        <div className="grid grid-cols-3 gap-2">
          {([
            { value: 'light', label: t('onboarding.preferences.themeModeLight'), icon: Sun },
            { value: 'dark', label: t('onboarding.preferences.themeModeDark'), icon: Moon },
            { value: 'system', label: t('onboarding.preferences.themeModeSystem'), icon: Monitor },
          ] as const).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTheme(value)}
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all hover:border-primary ${
                theme === value
                  ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary'
                  : 'border-border text-muted-foreground'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Contrast */}
      <div className="space-y-2">
        <Label>{t('onboarding.preferences.contrast')}</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'normal', label: t('onboarding.preferences.contrastNormal'), icon: Contrast },
            { value: 'soft', label: t('onboarding.preferences.contrastSoft'), icon: CircleDot },
          ] as const).map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setContrastMode(value)}
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-all hover:border-primary ${
                contrastMode === value
                  ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary'
                  : 'border-border text-muted-foreground'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('onboarding.preferences.contrastHint')}
        </p>
      </div>

      {/* Navigation */}
      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onBack} size="lg">
          {t('common.back')}
        </Button>
        <Button onClick={handleComplete} disabled={isSaving} className="btn-shine flex-1" size="lg">
          {isSaving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('common.loading')}
            </>
          ) : (
            t('common.next')
          )}
        </Button>
      </div>
    </div>
  )
}
