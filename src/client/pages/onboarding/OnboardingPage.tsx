import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/client/components/ui/progress'
import { GezyLogo } from '@/client/components/common/GezyLogo'
import { StepIdentity } from '@/client/pages/onboarding/StepIdentity'
import { StepPreferences } from '@/client/pages/onboarding/StepPreferences'
import { StepBootstrapProvider } from '@/client/pages/onboarding/StepBootstrapProvider'

/**
 * First-run onboarding — minimal by design.
 *
 * The flow used to be 4 steps (Identity → Preferences → Providers →
 * Default Models). Providers + default models were moved to the
 * in-app setup checklist on the dashboard (Phase 1 of the onboarding
 * redesign) so users land on a working app immediately. What stays
 * here is the bare minimum that has to happen before there's even an
 * authenticated session:
 *   1. Identity   — creates the user profile (admin role for the
 *                   first user) so subsequent API calls have a
 *                   profile row to attach to.
 *   2. Preferences — language + theme + palette. Lightweight; takes
 *                    ~5 seconds. Sets the cosmetic frame before the
 *                    user sees the dashboard.
 */
const TOTAL_STEPS = 3

interface OnboardingPageProps {
  onComplete: () => void
}

export function OnboardingPage({ onComplete }: OnboardingPageProps) {
  const { t } = useTranslation()
  const [currentStep, setCurrentStep] = useState(1)

  const progressValue = ((currentStep - 1) / (TOTAL_STEPS - 1)) * 100
  const stepTitleKeys = [
    'onboarding.steps.identity',
    'onboarding.steps.preferences',
    'onboarding.steps.provider',
  ] as const
  const currentStepTitle = t(stepTitleKeys[currentStep - 1] ?? stepTitleKeys[0])

  return (
    <div className="surface-base h-screen overflow-y-auto">
      {/* Decorative orbs */}
      <div className="theme-orb theme-orb-1 fixed left-1/4 top-1/4 h-64 w-64 aurora-drift" />
      <div className="theme-orb theme-orb-2 fixed right-1/4 bottom-1/4 h-48 w-48 aurora-drift delay-3" />
      <div className="theme-orb theme-orb-3 fixed left-1/2 top-2/3 h-56 w-56 aurora-drift delay-5" />

      {/* min-h-full centers short steps; taller steps (palette grid) push the
          height past the viewport and the outer h-screen container scrolls. */}
      <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <div className="relative z-10 w-full max-w-lg animate-fade-in-up">
        {/* Header */}
        <div className="mb-8 text-center">
          <GezyLogo size={64} title={null} className="mx-auto mb-3" />
          <h1 className="text-3xl font-extrabold text-foreground">Gezy</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('onboarding.subtitle')}
          </p>
        </div>

        {/* Progress */}
        <div className="mb-6 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('onboarding.step', { current: currentStep, total: TOTAL_STEPS })}</span>
            <span className="font-medium text-foreground">{currentStepTitle}</span>
          </div>
          <Progress value={progressValue} variant="gradient" active />
        </div>

        {/* Step card */}
        <div className="glass-strong rounded-2xl p-8 shadow-lg">
          {currentStep === 1 && (
            <StepIdentity onComplete={() => setCurrentStep(2)} />
          )}
          {currentStep === 2 && (
            <StepPreferences onComplete={() => setCurrentStep(3)} onBack={() => setCurrentStep(1)} />
          )}
          {currentStep === 3 && (
            <StepBootstrapProvider onComplete={onComplete} />
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
