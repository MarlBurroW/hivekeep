import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Progress } from '@/client/components/ui/progress'
import { HivekeepLogo } from '@/client/components/common/HivekeepLogo'
import { StepIdentity } from '@/client/pages/onboarding/StepIdentity'
import { StepBootstrapProvider } from '@/client/pages/onboarding/StepBootstrapProvider'

/** Account and provider are the only required first-run decisions. */
const TOTAL_STEPS = 2

interface OnboardingPageProps {
  onComplete: () => void
  initialStep?: 1 | 2
}

export function OnboardingPage({ onComplete, initialStep = 1 }: OnboardingPageProps) {
  const { t } = useTranslation()
  const [currentStep, setCurrentStep] = useState(initialStep)

  const progressValue = ((currentStep - 1) / (TOTAL_STEPS - 1)) * 100
  const stepTitleKeys = [
    'onboarding.steps.identity',
    'onboarding.steps.provider',
  ] as const
  const currentStepTitle = t(stepTitleKeys[currentStep - 1] ?? stepTitleKeys[0])

  return (
    <div className="surface-base h-dvh overflow-x-hidden overflow-y-auto">
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
          <HivekeepLogo size={64} title={null} className="mx-auto mb-3" />
          <h1 className="text-3xl font-extrabold text-foreground">Hivekeep</h1>
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
        <div className="glass-strong min-w-0 rounded-2xl p-4 shadow-lg sm:p-8">
          {currentStep === 1 && (
            <StepIdentity onComplete={() => setCurrentStep(2)} />
          )}
          {currentStep === 2 && (
            <StepBootstrapProvider onComplete={onComplete} />
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
